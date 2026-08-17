// tests/strict.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDefaultMode } from '../lib/strict.js'
import plugin from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

test('strict on defaults to read-only', () => {
  assert.equal(computeDefaultMode({ strict: true }), 'read-only')
})

test('strict off defaults to workspace-write', () => {
  assert.equal(computeDefaultMode({ strict: false }), 'workspace-write')
})

test('strict defaults to on when unset', () => {
  assert.equal(computeDefaultMode({}), 'read-only')
})

// I-2 regression: strict DECLARES a read-only default; it must warn when the
// host sandbox default is wider (workspace-write / danger-full-access) and
// must never silently claim enforcement.
test('strict on warns when the host sandbox default is wider', () => {
  for (const mode of ['workspace-write', 'danger-full-access']) {
    const ctx = makeCtx()
    ctx.fs = { sandboxMode: mode }
    const warns = captureWarns(() => plugin.apply(ctx))
    assert.ok(
      warns.some((w) => /strict mode is on/.test(w) && w.includes(mode) && /consider tightening it/.test(w)),
      `expected a tightening warning for ${mode}, got ${JSON.stringify(warns)}`,
    )
  }
})

test('strict on stays silent when the host sandbox is absent or already read-only', () => {
  const warns1 = captureWarns(() => plugin.apply(makeCtx())) // ctx.fs undefined
  assert.equal(warns1.length, 0, 'no sandboxMode → no warning')

  const ctx = makeCtx()
  ctx.fs = { sandboxMode: 'read-only' }
  const warns2 = captureWarns(() => plugin.apply(ctx))
  assert.equal(warns2.length, 0, 'read-only host default → no warning')
})

test('strict off never warns about the host sandbox default', () => {
  const ctx = makeCtx({ config: { safetyNet: { strict: false } } })
  ctx.fs = { sandboxMode: 'danger-full-access' }
  const warns = captureWarns(() => plugin.apply(ctx))
  assert.equal(warns.length, 0, 'strict off → no warning')
})

/** Run fn while capturing console.warn output. */
function captureWarns(fn) {
  const out = []
  const original = console.warn
  console.warn = (msg) => out.push(String(msg))
  try {
    fn()
  } finally {
    console.warn = original
  }
  return out
}
