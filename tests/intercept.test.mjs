// tests/intercept.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

const DSH_HOME = 'C:/Users/test/.dsh'

function setup() {
  const ctx = makeCtx()
  // Cordis calls apply(ctx, pluginConfig) — config is the SECOND argument.
  plugin.apply(ctx, { dshHome: DSH_HOME })
  return ctx
}

async function runIntents(ctx, target, actor = { agent: { session: {} } }) {
  const results = []
  for (const event of ['fs/write-intent', 'fs/edit-intent']) {
    const listeners = ctx.listeners.get(event) ?? []
    for (const fn of listeners) {
      try {
        results.push(await fn(target, actor, () => 'passed'))
      } catch (err) {
        results.push({ error: err })
      }
    }
  }
  return results
}

test('registers fs/write-intent and fs/edit-intent listeners', () => {
  const ctx = setup()
  assert.ok(ctx.listeners.has('fs/write-intent'))
  assert.ok(ctx.listeners.has('fs/edit-intent'))
})

test('blocks write to protected path', async () => {
  const ctx = setup()
  const target = { targetKey: `${DSH_HOME}/profiles/web/cordis.patch.yml`, displayPath: `${DSH_HOME}/profiles/web/cordis.patch.yml` }
  const results = await runIntents(ctx, target)
  const blocked = results.find((r) => r && r.error && r.error.code === 'FS_POLICY_DENIED')
  assert.ok(blocked, `expected FS_POLICY_DENIED, got ${JSON.stringify(results)}`)
  assert.match(blocked.error.message, /safety-net/i)
})

test('passes through workspace writes', async () => {
  const ctx = setup()
  const target = { targetKey: 'C:/Users/test/Desktop/project/src/main.js', displayPath: 'C:/Users/test/Desktop/project/src/main.js' }
  const results = await runIntents(ctx, target)
  assert.ok(results.some((r) => r === 'passed'), `expected pass-through, got ${JSON.stringify(results)}`)
})

test('settings.json under dshHome is blocked', async () => {
  const ctx = setup()
  const path = `${DSH_HOME}/settings.json`
  // The approval (approveOnce) bypass lives on the guard and is not exposed
  // through the plugin's fs-intent listeners, so the approval chain is out of
  // scope here; the one-time bypass unit behavior is covered in guard.test.mjs.
  // This test asserts settings.json under the injected dshHome is hard-blocked
  // like any other protected path.
  const target = { targetKey: path, displayPath: path }
  const results = await runIntents(ctx, target)
  assert.ok(results.some((r) => r && r.error && r.error.code === 'FS_POLICY_DENIED'))
})
