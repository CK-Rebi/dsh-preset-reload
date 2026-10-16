# Why `force` is required

This note records the mechanism behind the plugin's `force` option. It is the
answer to "why can't a plain config change reload a preset?" and it is the
reason an early revision of this plugin could get **stuck**.

All findings below are from reading DSH `0.2.0-rc.2` (`639ed01539`) and from
probes run against a live `dsh web`.

## 1. The registry already supports remounting

`@deepseek-ai/dsh-agent-preset-registry` builds a **generation** per preset
definition. `mountPreset` owns a complete teardown path:

```ts
// packages/preset/agent-preset-registry/src/mount.ts
ctx.effect(() => () => { tree.root.stop() }, 'agent-preset.tree')
```

and `recompose()` is a public method that rebinds a scope onto a generation and
announces the change:

```ts
async recompose(ctx: Context, id: string): Promise<AgentPreset> {
  const preset = await this.mount(ctx, id)
  try { this.owner.emit('tools/change') }
  catch (error) { this.owner.logger.warn(`Preset tools observer: ${String(error)}`) }
  return preset
}
```

So the capability exists. What is missing is anything that *calls* it for an
Agent that is already running.

## 2. A live Agent keeps its old generation

`mount()` resolves through `retain()`, which returns the definition's **current**
generation, and `bind()` is a no-op when the binding already points at it:

```ts
private async bind(ctx: Context, generation: Generation): Promise<void> {
  const key = scopeOf(ctx)
  const binding = this.bindings.get(key)
  if (binding?.generation === generation) return          // same revision -> nothing happens
  if (binding !== undefined) {
    binding.parent.rebind(generation.key)                  // different revision -> rebind
    const old = binding.generation
    generation.users++
    binding.generation = generation
    old.users--
    await this.collect(old)
  } else this.join(ctx, key, generation)
}
```

The rebind path is complete. Two consequences follow:

- **Calling `recompose` without a new generation does nothing.** It re-binds to
  the same generation and `bind()` returns immediately.
- `bindings` is a `WeakMap`, so the registry cannot enumerate live bindings
  itself. Whoever wants to rebind must find the Agents from outside —
  `ctx.agents.list()` — and call `recompose` per Agent.

## 3. A config-only change does not re-register the preset

`@deepseek-ai/dsh-agent-preset` registers exactly once, from `Service.init`:

```ts
// packages/preset/agent-preset/src/index.ts
export default class AgentPreset {
  static inject = ['agentPresets']
  static readonly [EntryGroup.key] = true
  constructor(private readonly ctx: Context, private readonly config: Config) {}
  async* [Service.init]() {
    yield await this.ctx.agentPresets.register(this.config)
  }
}
```

The Loader decides whether that init runs again when the row's options change:

```ts
// vendor/loader/src/config/entry.ts
const changes = Object.keys({ ...this.options, ...legacy })
  .filter(key => !deepEqual(this.options[key], legacy[key], key === 'config'))
// Only an active fiber in an unchanged context takes volatile-only config changes without a remount.
const volatileOnly = changes.length === 1 && changes[0] === 'config'
  && this.fiber.state === FiberState.ACTIVE && Object.getPrototypeOf(this.ctx) === this.parent.ctx
  && equalExceptVolatile(legacy.config, this.options.config, this.fiber.runtime?.Config)
if (volatileOnly) this.fiber._config = this.options.config
const pending = volatileOnly && this._commitVolatile() ? [] : changes
if (!pending.length && !force) return
this.context.emit('loader/partial-dispose', this, legacy, true)
this._patchContext(pending)      // -> fiber.update(config, true)
```

A preset row's `plugins` list is never volatile, so `volatileOnly` is false and
the change lands in `_patchContext` — which updates the **config**, and does not
promise a fresh `Service.init`. When init does not run, `register()` is not
called, `record.generation` is not replaced, and the definition on disk never
becomes a new revision.

That is the deadlock: the file changed, but the registry never heard about it,
so `recompose` has nothing new to bind to.

### Empirical evidence

A probe against the live system: edit a file the preset declares, then call the
plugin. The revision reported as unchanged; the running session kept the old
tool. Reverting the definition to a value that had been used before never
recovered — the session stayed on the newer revision it had already picked up.

## 4. `disabled` is the one guaranteed trigger

Two lines above the config branch:

```ts
// step 2: execute
if (this.disabled) {
  this.fiber?.dispose()
  return
}
```

A disabled row is disposed. Re-enabling it finds `this.fiber` empty and calls
`init()`:

```ts
async refresh() {
  if (this.fiber) return
  if (this.disabled) return
  await this.init()
}
```

`init()` runs `Service.init`, so `register()` runs, so the registry activates a
**new generation** — regardless of whether the new definition happens to equal
one used earlier.

So `force` disables the target preset row, reconciles, re-enables it, and
reconciles again. Then it rebinds live Agents onto the generation that now
exists.

## 5. Failure is safe by construction

The registry catches mount failures instead of propagating them:

```ts
private async activate(record: Definition): Promise<void> {
  try { /* ... mountPreset ... */ }
  catch (error) {
    record.broken = (error as Error).message
    this.owner.logger.warn(`agent preset ${record.config.id}: ${record.broken}`)
    await scope.dispose()
  }
}
```

Therefore:

- A broken preset definition does **not** fail the profile — the row loads and
  the failure is visible on the record.
- `retain()` re-reads that diagnostic, so `recompose` **refuses** on a broken
  definition. Live Agents keep running the old revision.
- The old generation stays alive because live Agents hold user counts
  (`users > 0`), so `collect()` never disposes it.

The practical result: **a bad plugin edit cannot reach a running session, and
rolling back is free.** The plugin does not implement rollback because the
registry already is the rollback.

## 6. Module freshness is URL-keyed

`prepareProfileEntries` adds no hash. The module URL is exactly what the patch
declares, and Node's ESM cache is keyed by the full URL including the query. A
remount therefore loads new code only when the `?v=` in the definition changed.

Verified with a probe fixture that names its tool from its own `?v=`:

```
[1] ?v=1 mounted        tools = ["qv-1"]
[2] re-declared ?v=2    tools = ["qv-1"]     <- stale binding, not a stale module
[3] after recompose     tools = ["qv-2"]     <- new code loaded
```

## 7. Rebinding is not gated on a diff

An early revision compared the revision identity before and after the reconcile
and skipped the rebind when it was unchanged. That is wrong twice over: identity
can already be current because an automatic trigger did the work, and skipping
the rebind is how sessions ended up permanently stuck.

The current plugin rebinds unconditionally. If no new generation exists,
`recompose` is a harmless no-op; if one does, the sessions move.
