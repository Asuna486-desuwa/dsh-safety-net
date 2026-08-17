// tests/expand-sources.test.mjs — I-1 regression: expandSources must collect
// only regular files, recursing into directories, so that:
//   - repair never misreports a directory as a MISSING critical file (the old
//     one-level readdir pushed directories into protectedSources and repair's
//     readFile on them threw EISDIR → false "MISSING critical files");
//   - manual backup reaches deep files (e.g. profiles/web/cordis.patch.yml),
//     not just the shallow children of the matcher directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../lib/index.js'
import { makeCtx } from './helpers.mjs'

/** Wait until apply()'s async expandSources has populated protectedSources. */
async function waitForSources(ctx, min, timeout = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (ctx.safetyNet.protectedSources.length >= min) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for protectedSources (got ${ctx.safetyNet.protectedSources.length})`)
}

test('protectedSources contains only regular files, recursing into directories', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'safetynet-src-'))
  try {
    const home = join(tmp, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(join(home, 'settings.json'), '{"a":1}', 'utf8')
    await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'patch: true', 'utf8')
    await writeFile(join(home, 'state', 'session.json'), '{}', 'utf8')

    // pluginDataRoot is injected into the same tmp so expandSources never
    // touches the real ~/.claude/plugins/data, even read-only.
    const ctx = makeCtx({ config: { safetyNet: { dshHome: home, pluginDataRoot: tmp } } })
    plugin.apply(ctx)
    await waitForSources(ctx, 1)

    const sources = ctx.safetyNet.protectedSources
    assert.ok(sources.length >= 3, `expected the deep files collected, got ${JSON.stringify(sources)}`)
    for (const src of sources) {
      const st = await stat(src)
      assert.equal(st.isFile(), true, `${src} must be a regular file, not a directory`)
    }
    // directories themselves must never appear in protectedSources
    for (const d of [home, join(home, 'profiles'), join(home, 'profiles', 'web'), join(home, 'state')]) {
      assert.ok(!sources.includes(d), `directory ${d} must not be in protectedSources`)
    }
    // the deep file the old one-level readdir used to miss must now be there
    assert.ok(
      sources.includes(join(home, 'profiles', 'web', 'cordis.patch.yml')),
      'deep file under a nested directory must be collected',
    )
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

// I-1 repair angle: every collected source must be readable as a file, so
// /safety-net-repair (which readSource()es each source) can never misreport a
// directory as MISSING just because it exists on disk.
test('every protected source is readable (repair will not misreport)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'safetynet-src-'))
  try {
    const home = join(tmp, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'settings.json'), 'x', 'utf8')
    await writeFile(join(home, 'profiles', 'web', 'a.yml'), 'y', 'utf8')

    const ctx = makeCtx({ config: { safetyNet: { dshHome: home, pluginDataRoot: tmp } } })
    plugin.apply(ctx)
    await waitForSources(ctx, 1)

    for (const src of ctx.safetyNet.protectedSources) {
      const text = await ctx.safetyNet.readSource(src) // throws EISDIR on directories
      assert.equal(typeof text, 'string')
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
