// tests/guard.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGuard, defaultRules } from '../lib/guard.js'

const DSH_HOME = 'C:/Users/test/.dsh'

test('defaultRules keeps exactly the two independent dimensions', () => {
  const rules = defaultRules({ dshHome: DSH_HOME })
  const ids = rules.map((r) => r.id)
  assert.deepEqual(ids, ['dsh-home', 'plugin-data'])
  // dsh-home alone must cover the whole tree (profiles/state/settings are
  // subdirectories — no redundant per-subdir rules)
  assert.equal(rules[0].matcher, DSH_HOME)
})

test('isProtected matches ~/.dsh tree', () => {
  const g = createGuard({ dshHome: DSH_HOME, extraProtectedPaths: [] })
  assert.equal(g.isProtected(`${DSH_HOME}/profiles/web/cordis.patch.yml`), true)
  assert.equal(g.isProtected(`${DSH_HOME}/github-auth.json`), true)
})

test('isProtected matches plugin data dir', () => {
  const g = createGuard({
    dshHome: DSH_HOME,
    pluginDataRoot: 'C:/Users/test/.claude/plugins/data',
    extraProtectedPaths: [],
  })
  const pluginData = 'C:/Users/test/.claude/plugins/data/dsh-deepseek-dsh'
  assert.equal(g.isProtected(`${pluginData}/config.json`), true)
  assert.equal(g.isProtected(`${pluginData}/npm/package.json`), true)
})

test('isProtected does not match workspace files', () => {
  const g = createGuard({ dshHome: DSH_HOME, extraProtectedPaths: [] })
  assert.equal(g.isProtected('C:/Users/test/Desktop/project/src/main.js'), false)
})

test('extraProtectedPaths extends the guard', () => {
  const g = createGuard({ dshHome: DSH_HOME, extraProtectedPaths: ['C:/secret'] })
  assert.equal(g.isProtected('C:/secret/notes.txt'), true)
})

test('approveOnce grants one-time bypass', () => {
  const g = createGuard({ dshHome: DSH_HOME, extraProtectedPaths: [] })
  const path = `${DSH_HOME}/settings.json`
  assert.equal(g.isProtected(path), true)
  g.approveOnce(path)
  assert.equal(g.isProtected(path), false)
  assert.equal(g.isProtected(path), true) // one-time only
})

// Review round 2, bug 1: isRuleProtected is a PURE rule check — it must NOT
// consume a pending approval (isProtected() does, and returns false, which
// made /safety-net-approve eat the approval and misreport "not protected").
test('isRuleProtected does not consume a pending approval', () => {
  const g = createGuard({ dshHome: DSH_HOME, extraProtectedPaths: [] })
  const path = `${DSH_HOME}/settings.json`
  assert.equal(g.isRuleProtected(path), true)   // rule says protected
  g.approveOnce(path)                            // grant one-time approval
  // calling isRuleProtected must leave the approval intact
  assert.equal(g.isRuleProtected(path), true)
  // and the approval is still usable exactly once via isProtected()
  assert.equal(g.isProtected(path), false)       // consumed now
  assert.equal(g.isProtected(path), true)        // re-armed
})

test('isRuleProtected ignores extra protected paths matching pure rules', () => {
  const g = createGuard({ dshHome: DSH_HOME, extraProtectedPaths: ['C:/secret'] })
  assert.equal(g.isRuleProtected('C:/secret/notes.txt'), true)
  assert.equal(g.isRuleProtected('C:/Users/test/Desktop/project/src/main.js'), false)
})
