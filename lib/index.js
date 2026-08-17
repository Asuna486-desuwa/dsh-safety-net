// dsh-safety-net: self-protection guardrails for the DeepSeek Harness.
//
// Mounts fs/write-intent and fs/edit-intent waterfall listeners that HARD-BLOCK
// mutations targeting DSH critical assets (DSH home, plugin data, profile
// manifests/patches). Non-critical paths pass through untouched. The pattern
// mirrors @deepseek-ai/dsh-fs-observation-policy: listeners receive
// (target, actor, next) and either throw a policy denial or continue the
// waterfall with next(target, actor).

import { FsError } from '@deepseek-ai/dsh-fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGuard } from './guard.js'

const name = 'safety-net'
const inject = ['fs', 'commands', 'jobs']

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function apply(ctx) {
  const config = ctx.config?.safetyNet ?? {}
  const guard = createGuard({
    dshHome: dshHome(),
    extraProtectedPaths: Array.isArray(config.extraProtectedPaths) ? config.extraProtectedPaths : [],
  })

  ctx.on('fs/write-intent', (target, actor, next) => {
    if (guard.isProtected(target.targetKey ?? target.displayPath ?? '')) {
      throw new FsError(
        `[safety-net: blocked] write to ${target.displayPath ?? target.targetKey} — this is a DSH critical asset. 需要主人显式批准才能继续。`,
        'FS_POLICY_DENIED',
      )
    }
    return next(target, actor)
  })

  ctx.on('fs/edit-intent', (target, actor, next) => {
    if (guard.isProtected(target.targetKey ?? target.displayPath ?? '')) {
      throw new FsError(
        `[safety-net: blocked] edit of ${target.displayPath ?? target.targetKey} — this is a DSH critical asset. 需要主人显式批准才能继续。`,
        'FS_POLICY_DENIED',
      )
    }
    return next(target, actor)
  })

  ctx.effect(() => {}, 'safety-net: fs interception')
}

export { name, inject }
export default { name, inject, apply }
