// dsh-safety-net: self-protection guardrails for the DeepSeek Harness.
//
// Guardrail 1 (protected paths): fs/write-intent + fs/edit-intent waterfall
// listeners hard-block mutations on DSH critical assets.
// Guardrail 2 (backup before destroy): a blocked mutation first snapshots the
// original file into <DSH_HOME>/safety-net/backups/ so any damage is
// one-command reversible.
// Guardrail 3 (self-recovery channel): four slash commands usable from the
// dsh CLI even when the GUI is down.
// Guardrail 4 (privilege tiering): strict mode declares a read-only default
// and warns when the host sandbox default is wider (it cannot force the host).

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

/**
 * Expand guard rule matchers into existing regular files (recursive).
 * Directories are walked (any depth); only regular files are collected, so
 * repair never misreports a directory as a MISSING critical file and manual
 * backups reach deep files (e.g. profiles/web/cordis.patch.yml).
 */
async function expandSources(rules) {
  const out = []
  async function walk(dir) {
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const n of names) {
      const full = join(dir, n)
      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (st.isDirectory()) await walk(full)
      else if (st.isFile()) out.push(full)
    }
  }
  for (const rule of rules) {
    try {
      const st = await stat(rule.matcher)
      if (st.isDirectory()) await walk(rule.matcher)
      else if (st.isFile()) out.push(rule.matcher)
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

  // Strict mode DECLARES a read-only default; safety-net cannot force the host
  // backend, so surface a warning when the host sandbox default is wider than
  // declared (I-2: honest messaging — no silent enforcement claims).
  if (config.strict !== false) {
    const mode = ctx.fs?.sandboxMode
    if (mode === 'workspace-write' || mode === 'danger-full-access') {
      console.warn(`[safety-net] strict mode is on, but the host sandbox default is ${mode} — consider tightening it`)
    }
  }

  expandSources(guard.rules).then((sources) => {
    ctx.safetyNet.protectedSources = sources
  })

  const deny = (target, guardrail) => {
    throw new FsError(
      `[safety-net: blocked] ${guardrail} on ${target.displayPath ?? target.targetKey} — this is a DSH critical asset. 如需修改，请调整 safetyNet.extraProtectedPaths 配置或卸载本插件后操作。`,
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
