// tests/commands.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerAll, buildStatusText } from '../lib/commands.js'
import { makeCtx } from './helpers.mjs'

test('registers the five self-recovery commands', () => {
  const ctx = makeCtx()
  registerAll(ctx)
  const names = ctx.commands.map((c) => c.name)
  assert.ok(names.includes('safety-net-status'))
  assert.ok(names.includes('safety-net-backup'))
  assert.ok(names.includes('safety-net-restore'))
  assert.ok(names.includes('safety-net-repair'))
  assert.ok(names.includes('safety-net-approve'))
})

test('buildStatusText reports guard and backup state', () => {
  const text = buildStatusText({
    protectedRuleCount: 5,
    backupCount: 3,
    strict: true,
    dshHome: 'C:/Users/test/.dsh',
  })
  assert.match(text, /safety-net/i)
  assert.match(text, /5/)
  assert.match(text, /3/)
  assert.match(text, /strict/i)
})

// I-2 regression: status text must describe strict honestly — it declares a
// read-only default, it does not enforce one; host enforcement depends on the
// sandbox backend.
test('buildStatusText describes strict honestly', () => {
  const on = buildStatusText({ protectedRuleCount: 1, backupCount: 0, strict: true, dshHome: '/x' })
  const off = buildStatusText({ protectedRuleCount: 1, backupCount: 0, strict: false, dshHome: '/x' })
  assert.match(on, /declared read-only default/i)
  assert.match(on, /host enforcement depends on sandbox backend/i)
  assert.match(off, /workspace-write default/i)
  assert.doesNotMatch(on, /sandbox defaults to read-only/i)
})

test('safety-net-status handler returns success with text', async () => {
  const ctx = makeCtx()
  registerAll(ctx)
  const cmd = ctx.commands.find((c) => c.name === 'safety-net-status')
  const result = await cmd.handler('')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /safety-net/i)
})

// Carry-over (Task 5 review): backup/restore must degrade to an error result
// when the backup store is not wired (backups === null), never throw.
test('backup/restore degrade to error when backups is null', async () => {
  const ctx = makeCtx()
  registerAll(ctx)
  const backupCmd = ctx.commands.find((c) => c.name === 'safety-net-backup')
  const restoreCmd = ctx.commands.find((c) => c.name === 'safety-net-restore')
  const b = await backupCmd.handler('')
  const r = await restoreCmd.handler('')
  assert.equal(b.kind, 'error')
  assert.match(b.text, /backup store not available/i)
  assert.equal(r.kind, 'error')
  assert.match(r.text, /backup store not available/i)
})

// Carry-over (Task 5 review): the restore handler must support the id branch —
// calling backups.restore(id) and reporting success.
test('restore with an id restores that backup', async () => {
  const ctx = makeCtx()
  let restoredId = null
  ctx.safetyNet = {
    guard: { rules: [] },
    backups: {
      list: async () => [{ id: 'bk-1' }],
      restore: async (id) => { restoredId = id },
    },
    dshHome: 'C:/Users/test/.dsh',
    strict: true,
    protectedSources: [],
    readSource: async () => 'x',
  }
  registerAll(ctx)
  const cmd = ctx.commands.find((c) => c.name === 'safety-net-restore')
  const result = await cmd.handler('bk-1')
  assert.equal(result.kind, 'success')
  assert.equal(restoredId, 'bk-1')
  assert.match(result.text, /bk-1/)
})

// Carry-over (Task 5 review): a broken backup listing must not crash the
// status command — it returns an error result instead.
test('status handler degrades to error when backup listing fails', async () => {
  const ctx = makeCtx()
  ctx.safetyNet = {
    guard: { rules: [] },
    backups: { list: async () => { throw new Error('disk on fire') } },
    dshHome: 'C:/Users/test/.dsh',
    strict: true,
    protectedSources: [],
    readSource: async () => 'x',
  }
  registerAll(ctx)
  const cmd = ctx.commands.find((c) => c.name === 'safety-net-status')
  const result = await cmd.handler('')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /safety-net/i)
  assert.match(result.text, /disk on fire/)
})

// Review fix 2: backup/repair must await the ready promise so a command right
// after plugin load never sees an empty protectedSources (race).
test('backup awaits ready before reading protectedSources', async () => {
  const ctx = makeCtx()
  let awaitedReady = false
  ctx.safetyNet = {
    guard: { rules: [] },
    backups: {
      snapshot: async () => {},
      list: async () => [],
    },
    dshHome: 'C:/Users/test/.dsh',
    strict: true,
    protectedSources: [],
    ready: new Promise((resolve) => setTimeout(() => { awaitedReady = true; resolve(['/x/a.txt']) }, 5)),
    readSource: async () => 'content',
  }
  registerAll(ctx)
  const cmd = ctx.commands.find((c) => c.name === 'safety-net-backup')
  const result = await cmd.handler('')
  assert.equal(result.kind, 'success')
  assert.equal(awaitedReady, true)
  assert.match(result.text, /backed up 1 protected file/)
})

// Review fix 5: approve wires guard.approveOnce into the CLI — one-time
// approval for a protected path, with usage/not-protected branches.
test('safety-net-approve grants a one-time bypass for protected paths', async () => {
  const ctx = makeCtx()
  const approved = []
  ctx.safetyNet = {
    guard: {
      rules: [],
      isRuleProtected: (p) => p === 'C:/Users/test/.dsh/settings.json',
      approveOnce: (p) => approved.push(p),
    },
  }
  registerAll(ctx)
  const cmd = ctx.commands.find((c) => c.name === 'safety-net-approve')

  const ok = await cmd.handler('C:/Users/test/.dsh/settings.json')
  assert.equal(ok.kind, 'success')
  assert.deepEqual(approved, ['C:/Users/test/.dsh/settings.json'])
  assert.match(ok.text, /approved one-time write/i)

  const notProtected = await cmd.handler('C:/Users/test/Desktop/project/src/main.js')
  assert.equal(notProtected.kind, 'success')
  assert.match(notProtected.text, /not protected/i)

  const usage = await cmd.handler('')
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /usage/i)
})

// Review round 2, bug 1 regression: calling /safety-net-approve TWICE on the
// same protected path must grant TWO pending approvals (each usable once) —
// the second call must not consume the first's approval nor misreport
// "not protected". The guard uses isRuleProtected (pure), not isProtected.
test('approve twice grants two independent one-time approvals', async () => {
  const ctx = makeCtx()
  const approved = []
  ctx.safetyNet = {
    guard: {
      rules: [],
      isRuleProtected: (p) => p === 'C:/Users/test/.dsh/settings.json',
      approveOnce: (p) => approved.push(p),
    },
  }
  registerAll(ctx)
  const cmd = ctx.commands.find((c) => c.name === 'safety-net-approve')
  const first = await cmd.handler('C:/Users/test/.dsh/settings.json')
  assert.equal(first.kind, 'success')
  assert.match(first.text, /approved one-time write/i)
  const second = await cmd.handler('C:/Users/test/.dsh/settings.json')
  assert.equal(second.kind, 'success')
  assert.match(second.text, /approved one-time write/i)
  assert.deepEqual(approved, ['C:/Users/test/.dsh/settings.json', 'C:/Users/test/.dsh/settings.json'])
})

// Review round 2, #2: backup must surface real failures (permission, disk
// full) instead of silently swallowing them; only ENOENT (vanished file) is
// skipped quietly.
test('backup reports per-file failures instead of swallowing them', async () => {
  const ctx = makeCtx()
  ctx.safetyNet = {
    guard: { rules: [] },
    backups: { snapshot: async () => {}, list: async () => [] },
    dshHome: 'C:/Users/test/.dsh',
    strict: true,
    protectedSources: ['/x/ok.txt', '/x/bad.txt', '/x/gone.txt'],
    ready: Promise.resolve(['/x/ok.txt', '/x/bad.txt', '/x/gone.txt']),
    readSource: async (p) => {
      if (p === '/x/bad.txt') { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e }
      if (p === '/x/gone.txt') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      return 'content'
    },
  }
  registerAll(ctx)
  const cmd = ctx.commands.find((c) => c.name === 'safety-net-backup')
  const result = await cmd.handler('')
  assert.equal(result.kind, 'error') // failures present -> error result
  assert.match(result.text, /backed up 1 file\(s\), 1 FAILED/)
  assert.match(result.text, /\/x\/bad\.txt/)
  assert.match(result.text, /EACCES/)
  assert.doesNotMatch(result.text, /gone\.txt/) // ENOENT silently skipped
})
