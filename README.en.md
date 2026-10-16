# dsh-preset-reload

Make **agent preset changes in DeepSeek Harness take effect on running sessions**,
without restarting `dsh`.

Edit a preset's plugin code or its persona card, and the conversations already in
flight are not interrupted and do not "lose their memory" — they are rebound to
the new revision, with the `sessionId` and the whole context preserved.

> 中文文档：[README.md](README.md)

---

## The problem

`agent-preset-registry` builds a **revision (generation)** per preset definition,
and builds a new one whenever the definition is registered again. But an Agent
that is already bound keeps its old revision:

- `bindings` is a `WeakMap`, so the registry **cannot enumerate live bindings** —
  nothing exists that would rebind them;
- `mount()` reuses the current revision, and `bind()` returns immediately when
  the binding already points at it.

The observable result: **new sessions get the new code, existing sessions stay on
the old code forever.** For a long-running bot that means "change one line of copy
= restart = everyone loses their context".

This plugin supplies the missing step.

---

## How it works

```
definition file changes (the cordis.patch.yml you generate)
      ↓  configurable debounce
① disable -> enable the target preset row   → Service.init reruns → new revision
      ↓
② recompose(agent.ctx, presetId)            → every live Agent moves to it
```

### Why ① is mandatory

A config-only change **does not guarantee** that the preset re-registers. DSH's
`AgentPreset` calls `agentPresets.register()` exactly once, from `Service.init`,
while the Loader handles a config-only change by updating the config — without
promising a fresh instantiation. No re-registration means no new revision, and
`recompose` then has nothing to move a session onto. Sessions end up **stuck** on
the old revision.

`disabled` is the one guaranteed trigger: a disabled row is always disposed, and
re-enabling it always goes through `init()`, so `register()` always runs.

**The full mechanism, with source references and measured evidence, is in
[docs/why-force.md](docs/why-force.md).**

---

## Install

### Option 1 — install as a bundle

```sh
dsh plugin --profile web add github:CK-Rebi/dsh-preset-reload
```

Then configure it in your profile patch:

```yaml
- id: preset-reload
  config:
    presets:
      - your-preset-id
    roots:
      - '/path/to/your/bundle/cordis.patch.yml'
```

### Option 2 — add a row by hand

Skip packaging entirely and add one row to
`~/.dsh/profiles/<profile>/cordis.patch.yml`, pointing at this repository's
`index.mjs` with an absolute `file://` URL:

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

That `insert` row belongs in the **host layer** (the profile's patch layer) —
**never inside a preset**, because a preset-level row would be replaced by the
very remount this plugin performs.

---

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `presets` | `string[]` | `[]` | Preset ids to reload |
| `roots` | `string[]` | `[]` | Paths to watch; **files and directories both work** |
| `debounceMs` | `number` | `800` | Quiet window that merges consecutive file events |
| `auto` | `boolean` | `true` | `false` leaves only the `preset_reload` tool as a trigger |
| `force` | `boolean` | `true` | Force a fresh revision through the disable→enable cycle |
| `logFile` | `string` | `''` | Audit log path; an empty string writes no file |

> **Point `roots` at the definition file, not at its directory.**
> With a directory, every save of a plugin module triggers a full remount — yet
> as long as the patch was not regenerated the definition did not actually
> change, so that remount is pure churn: it swaps the tool table of every online
> session for nothing.

---

## Usage

### Automatic

Have your build script regenerate the definition file:

```sh
node scripts/build-preset.mjs
```

The plugin remounts and rebinds once the debounce window closes.

> ⚠️ If your build script recomputes content hashes for module URLs (`?v=`),
> **run it directly rather than through a pipe**. A pipe such as
> `node build.mjs 2>&1 | Select-String ...` was measured to make the script
> silently skip writing the file.

### Manual

Any session can call the `preset_reload` tool:

```
preset_reload                        # uses the configured presets
preset_reload presetId=your-preset
preset_reload force=false            # lightweight reconcile; may not move stuck sessions
```

Example result:

```
your-preset：强制重挂，revision 已更新，重绑 12 个会话
```

All three fields are trustworthy: `forced` (whether the forced path ran),
`changed` (whether the revision actually changed) and `moved` (which sessions
were rebound). **Rebinding is never gated on `changed`** — it runs
unconditionally.

---

## Safety

A failed preset mount is caught by the registry and recorded on `record.broken`:

- a broken definition does **not** fail profile startup;
- `recompose` **refuses** a broken definition, so live sessions keep the old revision;
- the old revision is never collected while live sessions hold it (`users > 0`),
  so it stays available to fall back to.

**A bad plugin edit cannot reach a running session, and rollback is free.** The
plugin implements no rollback of its own because the registry already is the
rollback.

---

## Known limitations

- A forced remount rebuilds the preset's whole Cordis subtree, so an
  **in-flight turn** will observe the tool table change. Change things while
  quiet, or accept that momentary switch.
- `force` has a **millisecond-scale window** between disable and enable during
  which the preset is not registered; a session created exactly inside that
  window will not find it.
- Modules are cached **by URL, including the query string**. Editing a module
  without regenerating the definition leaves the URL unchanged and the old code
  loaded — which is what content hashes in the definition are for.
- Only **preset-level** plugins are covered. Installing, removing or upgrading
  host-level plugin packages is out of scope (that is
  [`dsh-hot-installer`](https://www.npmjs.com/package/dsh-hot-installer)'s
  territory; the two coexist).

---

## Verification

The mechanism was verified on DSH `0.2.0-rc.2` with two probes.

**Rebinding works** (using the official `agent-preset-registry` test harness):

```
[1] initial mount        tools = ["standard"]
[2] after re-declaring   tools = ["standard"]     <- the stale binding this plugin fixes
[3] after recompose      tools = ["replacement"]
```

**A changed `?v=` loads new code** (fixture names its tool from its own `?v=`):

```
[1] mounted ?v=1         tools = ["qv-1"]
[2] after re-declaring   tools = ["qv-1"]
[3] after recompose      tools = ["qv-2"]
```

**Automatic reload in production** (a real `dsh web`, no restart): after editing
the definition file, without calling any tool, the preset was remounted; the
audit log recorded the trigger, whether the revision changed, and which sessions
were rebound.

---

## License

[MIT](LICENSE)
