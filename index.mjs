/**
 * 预设热重载器 —— 让「插件代码 / 人格卡」的改动对**正在运行的会话**生效，无需重启 DSH。
 *
 * 为什么需要它：DSH 的 `agent-preset-registry` 在预设定义被重新注册时会构建一个新的
 * revision（generation），但**已经绑定的 agent 仍持有旧 revision**——注册表内部的
 * `bindings` 是 WeakMap（不可遍历），没有任何东西会去重绑它们。结果是：新会话拿到新
 * 代码，老会话停在旧代码上。
 *
 * 为什么需要 force（disable → enable）：
 * `@deepseek-ai/dsh-agent-preset` 只在 `Service.init` 里调一次 `agentPresets.register()`。
 * Loader 的 `Entry.update` 对「仅 config 变化」走 `_patchContext` → `fiber.update(config)`，
 * **不保证重新实例化**，于是 `register()` 不再被调用 → 注册表里仍是旧定义 → **没有新
 * revision**，把会话活活粘在旧版本上。而 `disabled` 分支（vendor/loader/src/config/entry.ts:134）
 * 一定 `fiber.dispose()`，重新启用时一定走 `init()`，`register()` 必然重跑。
 * 所以 force 直接关掉再打开目标预设行，用确定的生命周期换确定的新 revision。
 *
 * 失败是安全的：预设挂载失败会被注册表 catch 进 `record.broken`，profile 不受影响；
 * 旧 revision 因活会话持有（users > 0）不被回收，会话继续跑旧版本，随时可退。
 */
import { appendFileSync, mkdirSync, statSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { composeEntries, readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'

export const name = 'dsh-preset-reload'

/** `profileContext` 是 profile 事实，非 profile 启动下不存在，故用 `ctx.get` 读取。 */
export const inject = ['agentPresets', 'agents', 'tools']

export const Config = Schema.object({
  /** 需要重绑的预设 id；留空则只在显式传入时工作。 */
  presets: Schema.array(Schema.string()).default([]),
  /** 监听这些目录，文件变化即触发重载。 */
  roots: Schema.array(Schema.string()).default([]),
  /** 合并连续文件事件的静默窗口（毫秒）。 */
  debounceMs: Schema.number().default(800),
  /** 关闭后只有工具调用会触发重载。 */
  auto: Schema.boolean().default(true),
  /** 默认是否用 disable→enable 强制产生新 revision；false 时只做轻量 reconcile。 */
  force: Schema.boolean().default(true),
  /** 审计日志路径；留空则不写文件。 */
  logFile: Schema.string().default(''),
})

/** 追加一行审计日志。写不进去不能影响重载本身。 */
function audit(config, line) {
  if (config.logFile === '') return
  try {
    mkdirSync(dirname(config.logFile), { recursive: true })
    appendFileSync(config.logFile, `[${new Date().toISOString()}] ${line}\n`)
  } catch (error) {
    // 日志是不可用诊断：磁盘只读或路径非法时放弃写盘，重载结果仍由返回值和 ctx.logger 承担。
    void error
  }
}

/** 读一次预设当前 revision 的身份；新 revision 必然是新对象。 */
async function revisionOf(ctx, presetId) {
  const lease = await ctx.agentPresets.acquireScope(presetId)
  try {
    return lease.key
  } finally {
    await lease[Symbol.asyncDispose]()
  }
}

/** 在 patch 结构里递归找出声明该预设的行 id。 */
function findRowId(patches, presetId) {
  const rows = composeEntries(patches)
  const row = rows.find(entry => entry.name === '@deepseek-ai/dsh-agent-preset' && entry.config?.id === presetId)
  return row?.id
}

/** 递归给匹配 id 的行打上 `disabled`，返回改动后的副本。 */
function withDisabled(node, rowId, disabled) {
  if (Array.isArray(node)) return node.map(item => withDisabled(item, rowId, disabled))
  if (node === null || typeof node !== 'object') return node
  const copy = {}
  for (const [key, value] of Object.entries(node)) copy[key] = withDisabled(value, rowId, disabled)
  if (copy.id === rowId && typeof copy.name === 'string') copy.disabled = disabled
  return copy
}

/**
 * 用 disable → enable 强制预设行重新实例化，从而必然产生新 revision。
 * @param ctx - 宿主上下文。
 * @param profile - profile 事实。
 * @param rowId - 目标预设行的 Loader id。
 * @returns 两次 reconcile 的诊断。
 */
async function forceReregister(ctx, profile, rowId) {
  const patches = readProfilePatches('dsh', profile)
  const off = await reconcileProfilePatches(ctx.root, withDisabled(patches, rowId, true), 'dsh')
  const on = await reconcileProfilePatches(ctx.root, withDisabled(patches, rowId, false), 'dsh')
  return [...off, ...on]
}

/** 重绑所有绑定在 presetId 上的活 agent。 */
async function rebind(ctx, presetId) {
  const moved = []
  const failed = []
  for (const agent of ctx.agents.list()) {
    if (ctx.agentPresets.composedPreset(agent.ctx) !== presetId) continue
    try {
      await ctx.agentPresets.recompose(agent.ctx, presetId)
      moved.push(agent.id)
    } catch (error) {
      failed.push({ agentId: agent.id, reason: String(error?.message ?? error) })
    }
  }
  return { moved, failed }
}

/**
 * 重载一组预设：产生新 revision，再把活会话搬过去。
 * @param ctx - 宿主上下文。
 * @param config - 插件配置。
 * @param presetIds - 目标预设 id 列表。
 * @param force - 是否用 disable→enable 强制新 revision。
 * @returns 每个预设的处置结果。
 */
async function reload(ctx, config, presetIds, force) {
  const profile = ctx.get('profileContext')
  if (profile === undefined) throw new Error('preset-reload: 需要 profile 上下文（dsh web / profile 启动）')
  const targets = presetIds.length > 0 ? presetIds : config.presets
  if (targets.length === 0) throw new Error('preset-reload: 没有指定预设（配置 presets 或传入 presetId）')

  const diagnostics = []
  const results = []
  for (const presetId of targets) {
    const before = await revisionOf(ctx, presetId).catch(() => undefined)
    let forced = false
    let missingRow
    if (force) {
      const rowId = findRowId(readProfilePatches('dsh', profile), presetId)
      if (rowId === undefined) missingRow = `找不到声明 ${presetId} 的 Loader 行，已退化为轻量 reconcile`
      else {
        diagnostics.push(...await forceReregister(ctx, profile, rowId))
        forced = true
      }
    } else {
      diagnostics.push(...await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', profile), 'dsh'))
    }

    const after = await revisionOf(ctx, presetId).catch(() => undefined)
    const row = (await ctx.agentPresets.list().catch(() => [])).find(item => item.id === presetId)
    const outcome = await rebind(ctx, presetId)
    results.push({
      presetId, forced, changed: after !== undefined && after !== before,
      broken: row?.broken, ...outcome,
      ...(missingRow === undefined ? {} : { note: missingRow }),
    })
  }
  return { diagnostics, results }
}

export function apply(ctx, config) {
  let queue = Promise.resolve()
  let timer

  const run = async (presetIds, trigger, force) => {
    const targets = presetIds.length > 0 ? presetIds : config.presets
    ctx.logger.info(`[preset-reload] ${trigger} → ${targets.join(', ') || '(未指定预设)'}${force ? ' (force)' : ''}`)
    audit(config, `触发（${trigger}${force ? ', force' : ''}）目标 ${targets.join(', ') || '(未指定)'}`)
    try {
      const outcome = await reload(ctx, config, targets, force)
      for (const row of outcome.results) {
        const head = `${row.presetId}: ${row.forced ? '强制重挂' : '轻量 reconcile'}，revision ${row.changed ? '已更新' : '未更新'}，重绑 ${row.moved.length} 个会话`
        if (row.broken !== undefined) ctx.logger.warn(`[preset-reload] ${head}；定义损坏，活会话保持旧版本：${row.broken}`)
        else ctx.logger.info(`[preset-reload] ${head}`)
        audit(config, `${head}${row.broken === undefined ? '' : `；定义损坏：${row.broken}`}${row.note === undefined ? '' : `；${row.note}`}`)
        if (row.moved.length > 0) audit(config, `${row.presetId} 已重绑：${row.moved.join(', ')}`)
        for (const failure of row.failed) {
          ctx.logger.warn(`[preset-reload] ${row.presetId}/${failure.agentId}：${failure.reason}`)
          audit(config, `${row.presetId}/${failure.agentId} 重绑失败：${failure.reason}`)
        }
      }
      for (const line of outcome.diagnostics) {
        ctx.logger.warn(`[preset-reload] profile 诊断：${line}`)
        audit(config, `profile 诊断：${line}`)
      }
      return outcome
    } catch (error) {
      ctx.logger.error(`[preset-reload] 重载失败：${String(error?.message ?? error)}`)
      audit(config, `重载失败：${String(error?.message ?? error)}`)
      throw error
    }
  }

  /** 串行化触发，避免 reconcile 重入。 */
  const schedule = (presetIds, trigger, force = config.force) => {
    queue = queue.then(() => run(presetIds, trigger, force)).catch(() => undefined)
    return queue
  }

  ctx.effect(() => ctx.tools.register({
    name: 'preset_reload',
    description: '重新读取磁盘上的 agent preset 定义，并强制把正在运行的会话重绑到新版本。用于让插件代码或人格卡改动免重启生效。',
    parameters: {
      type: 'object',
      properties: {
        presetId: { type: 'string', description: '要重载的预设 id；省略则使用插件配置里的 presets 列表。' },
        force: { type: 'boolean', description: '是否用 disable→enable 强制产生新 revision；省略则用配置里的 force（默认 true）。轻量模式可能推不动已粘住的会话。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                presetId: { type: 'string' },
                forced: { type: 'boolean' },
                changed: { type: 'boolean' },
                moved: { type: 'array', items: { type: 'string' } },
                failed: { type: 'array', items: { type: 'string' } },
                note: { type: 'string' },
                broken: { type: 'string' },
              },
              required: ['presetId', 'forced', 'changed'],
              additionalProperties: false,
            },
          },
        },
        required: ['results'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = value.results.map(row => {
          const head = `${row.presetId}：${row.forced ? '强制重挂' : '轻量 reconcile'}，revision ${row.changed ? '已更新' : '未更新'}，重绑 ${row.moved.length} 个会话`
          if (row.broken !== undefined) return `${head}\n  定义损坏，活会话保持旧版本：${row.broken}`
          return row.note === undefined ? head : `${head}\n  ${row.note}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const force = args.force ?? config.force
      const outcome = await schedule(args.presetId === undefined ? [] : [args.presetId], '工具调用', force)
      return {
        results: outcome.results.map(row => ({
          presetId: row.presetId,
          forced: row.forced,
          changed: row.changed,
          moved: row.moved,
          failed: row.failed.map(item => `${item.agentId}: ${item.reason}`),
          ...(row.note === undefined ? {} : { note: row.note }),
          ...(row.broken === undefined ? {} : { broken: row.broken }),
        })),
      }
    },
  }))

  if (!config.auto || config.roots.length === 0) return
  ctx.effect(() => {
    const onChange = (_event, filename) => {
      // 编辑器与构建脚本会连续写多次，用静默窗口合并。
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { void schedule([], `文件变化 ${filename ?? ''}`.trim()) }, config.debounceMs)
    }
    const watchers = []
    for (const root of config.roots) {
      let isDirectory
      try {
        isDirectory = statSync(root).isDirectory()
      } catch (error) {
        // 路径不存在或不可读：跳过这一个监听并告警，其余目标与工具调用仍然可用。
        ctx.logger.warn(`[preset-reload] 跳过不可监听的路径 ${root}：${String(error?.message ?? error)}`)
        continue
      }
      // 直接指向定义文件的监听比整目录更精确：改 .mjs 而不重新生成 patch 时不会白白重挂一次。
      watchers.push(isDirectory ? watch(root, { recursive: true }, onChange) : watch(root, onChange))
    }
    ctx.logger.info(`[preset-reload] 监听 ${watchers.length}/${config.roots.length} 个路径，目标预设 ${config.presets.join(', ') || '(未配置)'}`)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    }
  })
}
