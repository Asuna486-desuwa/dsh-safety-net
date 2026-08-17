// dsh-safety-net: self-protection guardrails for the DeepSeek Harness.
// Task 1 skeleton — guard/backup/commands/strict modules are wired in later
// tasks. This file must stay loadable at every step.

const name = 'safety-net'
const inject = ['fs', 'commands', 'jobs']

export function apply(ctx) {
  ctx.effect(() => {}, 'safety-net: skeleton')
}

export { name, inject }
export default { name, inject, apply }
