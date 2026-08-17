// tests/wiring.test.mjs — verify index.js wires the backup store into the
// guard so a blocked mutation leaves a recoverable snapshot behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

test('apply wires backups + readSource + protectedSources into ctx.safetyNet', () => {
  const ctx = makeCtx()
  plugin.apply(ctx)
  assert.ok(ctx.safetyNet, 'ctx.safetyNet must exist')
  assert.equal(typeof ctx.safetyNet.readSource, 'function')
  assert.ok(Array.isArray(ctx.safetyNet.protectedSources))
})

// The integration heart of Task 7: a blocked mutation must FIRST snapshot the
// original file into <dshHome>/safety-net/backups/, so nothing is ever
// destroyed without a recovery copy. Uses a throwaway temp dir as dshHome —
// the real ~/.dsh is never touched.
test('blocked write snapshots the original before refusing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'safety-net-wiring-'))
  try {
    const dshHome = join(tmp, 'home')
    const ctx = makeCtx({ config: { safetyNet: { dshHome } } })
    plugin.apply(ctx)
    const settings = join(dshHome, 'settings.json')
    await mkdir(dshHome, { recursive: true })
    await writeFile(settings, '{"token":"secret"}', 'utf8')

    const target = { targetKey: settings, displayPath: settings }
    let caught = null
    for (const fn of ctx.listeners.get('fs/write-intent') ?? []) {
      try {
        await fn(target, { agent: {} }, () => 'passed')
      } catch (err) {
        caught = err
      }
    }
    assert.ok(caught, 'expected the write to be denied')
    assert.equal(caught.code, 'FS_POLICY_DENIED')

    // a snapshot of the original must exist under <dshHome>/safety-net/backups
    const bkRoot = join(dshHome, 'safety-net', 'backups')
    const ids = await readdir(bkRoot)
    assert.equal(ids.length, 1, 'expected exactly one snapshot')
    const files = await walk(join(bkRoot, ids[0]))
    const snap = files.find((f) => f.endsWith('settings.json'))
    assert.ok(snap, `expected settings.json in snapshot, got ${JSON.stringify(files)}`)
    assert.equal(await readFile(snap, 'utf8'), '{"token":"secret"}')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

/** Recursively collect every file under dir (used on the snapshot tree). */
async function walk(dir, acc = []) {
  for (const n of await readdir(dir)) {
    const full = join(dir, n)
    const st = await stat(full)
    if (st.isDirectory()) await walk(full, acc)
    else acc.push(full)
  }
  return acc
}
