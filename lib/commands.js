// lib/commands.js — CLI self-recovery channel for dsh-safety-net.
//
// Four slash commands, registered via ctx.commands. They work even when the
// GUI is down because the command registry is part of the dsh CLI surface:
//   /safety-net-status    — guard + backup health report
//   /safety-net-backup    — manual full backup of protected assets
//   /safety-net-restore   — list backups, or restore one by id
//   /safety-net-repair    — detect missing critical files and print recovery
//                           instructions (never auto-modifies)

/** Build the human-readable status text. */
export function buildStatusText({ protectedRuleCount, backupCount, strict, dshHome }) {
  return [
    `safety-net: guardrails active`,
    `- protected rules: ${protectedRuleCount}`,
    `- backups stored: ${backupCount}`,
    `- strict mode: ${strict ? 'on (sandbox defaults to read-only)' : 'off'}`,
    `- DSH home: ${dshHome}`,
  ].join('\n')
}

/**
 * Register all four commands.
 * @param {object} ctx - cordis ctx with commands, and plugin state set by
 *   index.js: ctx.safetyNet = { guard, backups, dshHome, strict }
 */
export function registerAll(ctx) {
  const state = () => ctx.safetyNet ?? { guard: null, backups: null, dshHome: '', strict: true }

  ctx.commands.register({
    name: 'safety-net-status',
    description: 'safety-net: report guardrail health (protected rules, backups, strict mode)',
    handler: async () => {
      const s = state()
      let backups = []
      try {
        backups = s.backups ? await s.backups.list() : []
      } catch (err) {
        // a broken backup store must not crash the status command
        return {
          kind: 'error',
          text: `safety-net: failed to list backups — ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      return {
        kind: 'success',
        text: buildStatusText({
          protectedRuleCount: s.guard?.rules?.length ?? 0,
          backupCount: backups.length,
          strict: s.strict,
          dshHome: s.dshHome,
        }),
      }
    },
  })

  ctx.commands.register({
    name: 'safety-net-backup',
    description: 'safety-net: snapshot all protected assets into the backup store',
    handler: async () => {
      const s = state()
      if (!s.backups) return { kind: 'error', text: 'safety-net: backup store not available' }
      const sources = s.protectedSources ?? []
      let count = 0
      for (const src of sources) {
        try {
          const text = await s.readSource(src)
          await s.backups.snapshot(src, text)
          count += 1
        } catch {
          // missing file: skip silently
        }
      }
      return { kind: 'success', text: `safety-net: backed up ${count} protected file(s)` }
    },
  })

  ctx.commands.register({
    name: 'safety-net-restore',
    description: 'safety-net: list backups, or restore one: /safety-net-restore <id>',
    handler: async (rawInput) => {
      const s = state()
      if (!s.backups) return { kind: 'error', text: 'safety-net: backup store not available' }
      const id = rawInput.trim()
      if (id === '') {
        const list = await s.backups.list()
        const lines = list.length === 0
          ? ['no backups yet']
          : list.map((b) => `- ${b.id}`)
        return { kind: 'success', text: ['safety-net: backups (newest first):', ...lines].join('\n') }
      }
      try {
        await s.backups.restore(id)
        return { kind: 'success', text: `safety-net: restored backup "${id}"` }
      } catch (err) {
        return { kind: 'error', text: `safety-net: restore failed — ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  })

  ctx.commands.register({
    name: 'safety-net-repair',
    description: 'safety-net: detect missing critical files and print recovery instructions',
    handler: async () => {
      const s = state()
      const missing = []
      for (const src of s.protectedSources ?? []) {
        try {
          await s.readSource(src)
        } catch {
          missing.push(src)
        }
      }
      if (missing.length === 0) {
        return { kind: 'success', text: 'safety-net: all critical files present' }
      }
      return {
        kind: 'success',
        text: [
          'safety-net: MISSING critical files:',
          ...missing.map((m) => `- ${m}`),
          '',
          'recovery: run /safety-net-restore <id> (list ids with /safety-net-restore),',
          'or reinstall the affected plugin via dsh plugin add.',
        ].join('\n'),
      }
    },
  })
}
