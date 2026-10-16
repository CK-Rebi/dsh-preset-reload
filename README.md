# dsh-preset-reload

让 **DeepSeek Harness 的 agent preset 改动对正在运行的会话生效**，不用重启 `dsh`。

改了预设里的插件代码或人格卡之后，正在聊天的会话不会被中断，也不会"失忆"——
它们会被重绑到新版本上，`sessionId` 和上下文全程保留。

> English: [README.en.md](README.en.md)

---

## 解决的问题

DSH 的 `agent-preset-registry` 会为每份预设定义构建一个 **revision（generation）**，
并且在定义重新注册时构建新的 revision。但**已经绑定的 Agent 仍持有旧 revision**：

- 注册表内部的 `bindings` 是 `WeakMap`，**无法遍历**，没有任何东西会去重绑它们；
- `mount()` 会复用已有 revision，`bind()` 遇到同一 revision 直接 `return`。

于是实际表现是：**新会话拿到新代码，老会话永远停在旧代码上。**

对长期运行的机器人来说，这意味着「改一行文案 = 重启 = 所有人掉上下文」。

这个插件补的就是最后一步。

---

## 它怎么工作

```
定义文件变化（你生成的那份 cordis.patch.yml）
      ↓  可配置的防抖窗口
① disable → enable 目标预设行    → Service.init 重跑 → 新 revision
      ↓
② recompose(agent.ctx, presetId) → 所有活着的同预设 Agent 搬到新 revision
```

### 为什么必须有 ①

只改配置**不保证**预设重新注册。DSH 的 `AgentPreset` 只在 `Service.init` 里调一次
`agentPresets.register()`，而 Loader 对「仅 config 变化」走的是更新 config 的路径，
并不承诺重新实例化。没有重新注册就没有新 revision，`recompose` 也就无从搬起——
会话被**粘死**在旧版本上。

`disabled` 是唯一确定的触发点：被禁用的行一定会 `fiber.dispose()`，重新启用时一定走
`init()`，于是 `register()` 必然重跑。

**完整的机制分析、源码引用和实测证据见 [docs/why-force.md](docs/why-force.md)。**

---

## 安装

### 方式一：作为 bundle 安装

```sh
dsh plugin --profile web add github:CK-Rebi/dsh-preset-reload
```

装好后在你的 profile patch 里配置（见下一节的配置项）：

```yaml
- id: preset-reload
  config:
    presets:
      - your-preset-id
    roots:
      - '/path/to/your/bundle/cordis.patch.yml'
```

### 方式二：手动加一行

不装包，直接在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一行，用绝对
`file://` URL 指向本仓库的 `index.mjs`：

```yaml
- insert:
    - id: preset-reload
      name: 'file:///path/to/dsh-preset-reload/index.mjs'
      config:
        presets:
          - your-preset-id
        roots:
          - '/path/to/your/bundle/cordis.patch.yml'
        force: true
```

`insert` 这一行必须落在**宿主层**（profile 的 patch 层），**不要放进预设里面** ——
放进去的话，每次重挂都会把它自己换掉。

---

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `presets` | `string[]` | `[]` | 需要重载的预设 id 列表 |
| `roots` | `string[]` | `[]` | 监听路径，**文件或目录都可以** |
| `debounceMs` | `number` | `800` | 合并连续文件事件的静默窗口（毫秒） |
| `auto` | `boolean` | `true` | 关掉后只有 `preset_reload` 工具能触发 |
| `force` | `boolean` | `true` | 是否用 disable→enable 强制产生新 revision |
| `logFile` | `string` | `''` | 审计日志路径；空串表示不写文件 |

> **`roots` 建议只写定义文件，不要写整个目录。**
> 写目录的话，每次保存一个插件模块都会触发一次整树重挂——而只要没重新生成 patch，
> 定义其实没变，那次重挂纯属白折腾（会无谓地切换所有在线会话的工具表）。

---

## 用法

### 自动

让构建脚本重新生成定义文件即可：

```sh
node scripts/build-preset.mjs
```

文件一变，插件在防抖窗口后自动完成重挂与重绑。

> ⚠️ 如果你的构建脚本会重算模块 URL 的内容哈希（`?v=`），**请直接运行它，不要接管道**。
> 实测某些情况下 `node build.mjs 2>&1 | Select-String ...` 会让脚本静默不写文件。

### 手动

任何会话都可以调用 `preset_reload` 工具：

```
preset_reload                        # 用配置里的 presets 列表
preset_reload presetId=your-preset
preset_reload force=false            # 轻量 reconcile（可能推不动，仅用于快速试探）
```

返回示例：

```
your-preset：强制重挂，revision 已更新，重绑 12 个会话
```

三个字段都可信：`forced`（是否走了强制路径）、`changed`（revision 是否真的换了）、
`moved`（实际重绑了哪些会话）。**重绑不会被 `changed` 门控**——它无条件执行。

---

## 安全语义

预设挂载失败会被注册表 **catch** 掉，只记进 `record.broken`：

- 损坏的定义**不会**让 profile 启动失败；
- `recompose` 会**拒绝**损坏的定义，活会话继续跑旧 revision；
- 旧 revision 因为活会话持有引用（`users > 0`）**不会被回收**，随时可以退回。

**所以：改坏了插件，线上永远不受影响，回滚是设计自带的。** 插件本身没有实现回滚，
因为注册表本身就是回滚。

---

## 已知限制

- 强制重挂会重建预设的整棵 Cordis 子树，**正在进行的 turn** 会看到工具表切换。
  建议在空闲时改，或接受这一瞬时的切换。
- `force` 的 disable→enable 之间有个**毫秒级窗口**，此时该预设未被注册；
  恰好在这个窗口内新建会话会找不到它。
- 模块按 **URL** 缓存（含查询串）。改了模块但不重新生成定义文件时 URL 不变，
  加载的仍是旧代码。这也是定义里带内容哈希的意义。
- 只处理**预设层**的插件。宿主层插件包的装卸/升级不在范围内
  （那是 [`dsh-hot-installer`](https://www.npmjs.com/package/dsh-hot-installer) 的领域，
  两者可以共存）。

---

## 验证

机制在 DSH `0.2.0-rc.2` 上用两组探针验证过。

**重绑确实生效**（`agent-preset-registry` 的官方测试骨架）：

```
[1] 初次挂载         tools = ["standard"]
[2] 重新注册定义后   tools = ["standard"]     <- 陈旧绑定，就是本插件要解决的问题
[3] recompose 之后   tools = ["replacement"]
```

**`?v=` 变化会加载新代码**（fixture 用自身 `?v=` 命名工具）：

```
[1] ?v=1 挂载        tools = ["qv-1"]
[2] 重新注册 ?v=2 后 tools = ["qv-1"]
[3] recompose 之后   tools = ["qv-2"]
```

**线上自动重载**（真实 `dsh web`，未重启）：改动定义文件后不调用任何工具，
预设即被重新挂载，审计日志记录了触发的来源、revision 是否更新、以及重绑了哪些会话。

---

## 许可

[MIT](LICENSE)
