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

export function makeCtx({ config } = {}) {
  const listeners = new Map()
  const commands = []
  const killedJobs = []
  const effects = []
  // commands doubles as a registry: an array that also exposes register()
  commands.register = function register(definition) {
    commands.push(definition)
    return () => {}
  }
  return {
    config,
    listeners,
    commands,
    killedJobs,
    effects,
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
  }
}
