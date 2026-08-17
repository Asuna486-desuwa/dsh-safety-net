// tests/strict.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDefaultMode } from '../lib/strict.js'

test('strict on defaults to read-only', () => {
  assert.equal(computeDefaultMode({ strict: true }), 'read-only')
})

test('strict off defaults to workspace-write', () => {
  assert.equal(computeDefaultMode({ strict: false }), 'workspace-write')
})

test('strict defaults to on when unset', () => {
  assert.equal(computeDefaultMode({}), 'read-only')
})
