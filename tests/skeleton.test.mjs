// tests/skeleton.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

test('plugin exports name, inject, apply', () => {
  assert.equal(plugin.name, 'safety-net')
  // 'jobs' was removed from inject — it was declared but never used
  assert.deepEqual(plugin.inject, ['fs', 'commands'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply(ctx) runs without throwing', () => {
  const ctx = makeCtx()
  assert.doesNotThrow(() => plugin.apply(ctx))
})
