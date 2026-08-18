// tests/helpers.mjs — fake ctx / fake fs for safety-net tests.
// All tests run against in-memory fakes; real ~/.dsh and DSH checkout
// paths are NEVER touched.

export function makeFakeFs() {
  const files = new Map() // path -> content string
  const deleted = []
  return {
    files,
    deleted,
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async read(target) {
      return { text: files.get(target.targetKey) ?? null }
    },
    async write(target, intent) {
      if (intent.kind === 'createIfAbsent' && files.has(target.targetKey)) {
        const err = new Error('exists')
        err.code = 'FS_ALREADY_EXISTS'
        throw err
      }
      files.set(target.targetKey, intent.text)
      return { version: 'v' + files.size }
    },
    async remove(target) {
      deleted.push(target.targetKey)
      files.delete(target.targetKey)
    },
  }
}

// Real-Cordis-shaped fake ctx: models the API surface the plugin actually
// consumes, so tests catch Cordis misusage instead of passing against a
// wrong-shaped stub.
//
//  - Cordis calls apply(ctx, pluginConfig) — the plugin's own config arrives
//    as the SECOND argument, NOT as ctx.config (reading ctx.config throws
//    "cannot get property config without inject"). We keep a `config` field
//    for compatibility but the real contract is the apply() second argument.
//  - Services must be registered via ctx.provide(name, value) — direct
//    assignment (ctx.safetyNet = {...}) throws "cannot set property without
//    provide" in Cordis. `provided` records what apply() provides.
//  - `fs` is in the plugin's inject list, so the fake exposes ctx.fs with a
//    `sandboxMode` getter (undefined by default, overridable).
export function makeCtx({ config, fs } = {}) {
  const listeners = new Map()
  const commands = []
  const killedJobs = []
  const effects = []
  const provided = new Map()
  // commands doubles as a registry: an array that also exposes register()
  commands.register = function register(definition) {
    commands.push(definition)
    return () => {}
  }
  const ctx = {
    // config kept for legacy test call sites; the canonical way is the
    // apply(ctx, pluginConfig) second argument (see plugin.apply below)
    config,
    listeners,
    commands,
    killedJobs,
    effects,
    provided,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
    jobs: {
      async kill(id) {
        killedJobs.push(id)
        return 'cancellation-requested'
      },
    },
    effect(fn, label) {
      effects.push(label)
      return fn()
    },
    provide(name, value) {
      provided.set(name, value)
    },
  }
  // Cordis ctx is a proxy (cordis/lib/index.js:699-706): assigning to a name
  // that was NEVER provided throws "cannot set property without provide" —
  // exactly the bug that crashed DSH startup. The fake replicates that trap:
  // direct assignment to `safetyNet` is only allowed AFTER
  // ctx.provide('safetyNet', ...) has registered it. This keeps the
  // provide-side regression (someone reverting ctx.provide() back to
  // ctx.safetyNet = ...) from silently passing tests (Claude Code review).
  Object.defineProperty(ctx, 'safetyNet', {
    configurable: true,
    get: () => provided.get('safetyNet'),
    set: (value) => {
      if (!provided.has('safetyNet')) {
        throw new TypeError('cannot set property "safetyNet" without provide')
      }
      provided.set('safetyNet', value)
    },
  })
  // inject['fs'] is consumed via ctx.fs?.sandboxMode
  Object.defineProperty(ctx, 'fs', {
    configurable: true,
    get: () => fs,
  })
  return ctx
}

/**
 * Apply the plugin the way Cordis does: config as the SECOND argument.
 * Tests should call this instead of plugin.apply(ctx) so the real contract
 * (and the regression that broke DSH startup) is exercised.
 */
export function applyPlugin(plugin, ctx, pluginConfig) {
  plugin.apply(ctx, pluginConfig)
  return ctx
}
