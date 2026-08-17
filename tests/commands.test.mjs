// tests/commands.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerAll, buildStatusText } from '../lib/commands.js'
import { makeCtx } from './helpers.mjs'

test('registers the four self-recovery commands', () => {
  const ctx = makeCtx()
  registerAll(ctx)
  const names = ctx.commands.map((c) => c.name)
  assert.ok(names.includes('safety-net-status'))
  assert.ok(names.includes('safety-net-backup'))
  assert.ok(names.includes('safety-net-restore'))
  assert.ok(names.includes('safety-net-repair'))
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
