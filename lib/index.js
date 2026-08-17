// dsh-safety-net: self-protection guardrails for the DeepSeek Harness.
//
// Guardrail 1 (protected paths): fs/write-intent + fs/edit-intent waterfall
// listeners hard-block mutations on DSH critical assets.
// Guardrail 2 (backup before destroy): a blocked mutation first snapshots the
// original file into <DSH_HOME>/safety-net/backups/ so any damage is
// one-command reversible.
// Guardrail 3 (self-recovery channel): four slash commands usable from the
// dsh CLI even when the GUI is down.
// Guardrail 4 (privilege tiering): strict mode declares read-only default.

import { FsError } from '@deepseek-ai/dsh-fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, readdir, stat, writeFile, mkdir, rm } from 'node:fs/promises'
import { createGuard } from './guard.js'
import { createBackupStore } from './backup.js'
import { registerAll } from './commands.js'
import { computeDefaultMode } from './strict.js'

const name = 'safety-net'
const inject = ['fs', 'commands', 'jobs']

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** Expand guard rule matchers into existing candidate source files. */
async function expandSources(rules) {
  const out = []
  for (const rule of rules) {
    try {
      const st = await stat(rule.matcher)
      if (st.isDirectory()) {
        const names = await readdir(rule.matcher)
        for (const n of names) out.push(join(rule.matcher, n))
      } else {
        out.push(rule.matcher)
      }
    } catch {
      // missing matcher: skip
    }
  }
  return out
}

export function apply(ctx) {
  const config = ctx.config?.safetyNet ?? {}
  // dshHome must come from one source everywhere — config override first,
  // env / `~/.dsh` default second — so the guard, the backup root and the
  // reported home never disagree (carry-over from the Task 5 review).
  const home = config.dshHome ?? dshHome()
  const guard = createGuard({
    dshHome: home,
    pluginDataRoot: config.pluginDataRoot,
    extraProtectedPaths: Array.isArray(config.extraProtectedPaths) ? config.extraProtectedPaths : [],
  })
  const backups = createBackupStore({
    root: join(home, 'safety-net', 'backups'),
    dir: { readFile, readdir, stat, writeFile, mkdir, rm, listDir: readdir },
  })

  ctx.safetyNet = {
    guard,
    dshHome: home,
    strict: config.strict !== false,
    defaultMode: computeDefaultMode(config),
    backups,
    protectedSources: [],
    readSource: (p) => readFile(p, 'utf8'),
  }

  expandSources(guard.rules).then((sources) => {
    ctx.safetyNet.protectedSources = sources
  })

  const deny = (target, guardrail) => {
    throw new FsError(
      `[safety-net: blocked] ${guardrail} on ${target.displayPath ?? target.targetKey} — this is a DSH critical asset. 需要主人显式批准才能继续。`,
      'FS_POLICY_DENIED',
    )
  }

  ctx.on('fs/write-intent', async (target, actor, next) => {
    const path = target.targetKey ?? target.displayPath ?? ''
    if (guard.isProtected(path)) {
      // backup the original before refusing, so nothing is ever destroyed
      let backupNote = ''
      try {
        const text = await readFile(path, 'utf8')
        await backups.snapshot(path, text)
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          backupNote = ` (backup failed: ${err instanceof Error ? err.message : String(err)})`
        }
        // ENOENT: file missing — nothing to back up, still deny
      }
      return deny(target, `write${backupNote}`)
    }
    return next(target, actor)
  })

  ctx.on('fs/edit-intent', async (target, actor, next) => {
    const path = target.targetKey ?? target.displayPath ?? ''
    if (guard.isProtected(path)) {
      // backup the original before refusing, so nothing is ever destroyed
      let backupNote = ''
      try {
        const text = await readFile(path, 'utf8')
        await backups.snapshot(path, text)
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          backupNote = ` (backup failed: ${err instanceof Error ? err.message : String(err)})`
        }
        // ENOENT: file missing — nothing to back up, still deny
      }
      return deny(target, `edit${backupNote}`)
    }
    return next(target, actor)
  })

  registerAll(ctx)
  ctx.effect(() => {}, 'safety-net: guardrails mounted')
}

export { name, inject }
export default { name, inject, apply }
