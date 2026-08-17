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

test('safety-net-status handler returns success with text', async () => {
  const ctx = makeCtx()
  registerAll(ctx)
  const cmd = ctx.commands.find((c) => c.name === 'safety-net-status')
  const result = await cmd.handler('')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /safety-net/i)
})
