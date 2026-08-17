// tests/backup.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackupStore } from '../lib/backup.js'

// Brief-correction (see task-4 brief line 93 precedent): the fake fs must
// model node:fs/promises semantics faithfully, otherwise the store's real
// behavior (list = direct children, rm = recursive subtree, stat = real
// entry kind) cannot be exercised:
//   - listDir returns DIRECT children only (deduped by first segment)
//   - rm removes the whole subtree under p (like fs.rm recursive:true)
//   - stat reports isDirectory() from the stored entry kind
function fakeDir() {
  const store = new Map()
  // Normalize a path to the store's key form: no leading slash, no trailing
  // slash, forward slashes — `C:/Users/x` and `/C:/Users/x` both become
  // `C:/Users/x` so drive-letter paths match the keys mkdir builds.
  const key = (p) => String(p).replace(/^[/\\]+/, '').replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    store,
    async mkdir(p, opts) {
      // mimic fs.promises.mkdir(..., { recursive: true }): create every missing
      // parent so stat() of intermediate dirs reports isDirectory() (the real
      // store relies on this when snapshotting multi-level source paths)
      const parts = key(p).split('/')
      let cur = ''
      for (const part of parts) {
        cur += (cur ? '/' : '') + part
        if (!store.has(key(cur))) store.set(key(cur), { kind: 'dir' })
      }
    },
    async readFile(p) {
      const v = store.get(key(p))
      if (!v) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return v.text
    },
    async writeFile(p, text) { store.set(key(p), { kind: 'file', text }) },
    async rm(p) {
      const prefix = key(p) ? key(p) + '/' : key(p)
      for (const k of [...store.keys()]) {
        if (k === key(p) || k.startsWith(prefix)) store.delete(k)
      }
    },
    async listDir(p) {
      const prefix = key(p) ? key(p) + '/' : key(p)
      const out = new Set()
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) {
          const first = k.slice(prefix.length).split('/')[0]
          if (first) out.add(first)
        }
      }
      return [...out]
    },
    async exists(p) { return store.has(key(p)) },
    async stat(p) {
      const v = store.get(key(p))
      return {
        mtimeMs: v?.mtimeMs ?? 0,
        size: typeof v?.text === 'string' ? v.text.length : 0,
        isDirectory: () => v?.kind === 'dir',
      }
    },
  }
}

test('snapshot stores a copy under the backup root', async () => {
  const dir = fakeDir()
  const store = createBackupStore({ root: '/bk', dir })
  const id = await store.snapshot('/src/config.json', '{"a":1}')
  const list = await store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, id)
  assert.ok(list[0].id)
  // Brief-correction: the snapshot preserves the source's full relative path
  // ("the original relative path is preserved beneath it"), so the copy lives
  // at root/<id>/src/config.json — restore() needs that path to write the
  // content back to /src/config.json.
  const restored = await dir.readFile(`/bk/${id}/src/config.json`)
  assert.equal(restored, '{"a":1}')
})

test('restore writes the snapshot back to source', async () => {
  const dir = fakeDir()
  const store = createBackupStore({ root: '/bk', dir })
  const id = await store.snapshot('/src/config.json', 'original')
  await dir.writeFile('/src/config.json', 'corrupted')
  await store.restore(id)
  const text = await dir.readFile('/src/config.json')
  assert.equal(text, 'original')
})

test('prune keeps the newest retention snapshots', async () => {
  const dir = fakeDir()
  const store = createBackupStore({ root: '/bk', dir })
  // Snapshot ids are ms-timestamp based and unique; force distinct mtimes so
  // the sort order is observable, then assert WHICH ids survive — not just the
  // count (review fix: the old test would pass even if sort kept the oldest).
  const id1 = await store.snapshot('/src/a.txt', '1')
  const id2 = await store.snapshot('/src/a.txt', '2')
  const id3 = await store.snapshot('/src/a.txt', '3')
  // give each snapshot dir a distinct mtime: newest = id3 (written last)
  await dir.store.set(`bk/${id1}`, { kind: 'dir', mtimeMs: 100 })
  await dir.store.set(`bk/${id2}`, { kind: 'dir', mtimeMs: 200 })
  await dir.store.set(`bk/${id3}`, { kind: 'dir', mtimeMs: 300 })
  await store.prune(2)
  const list = await store.list()
  assert.equal(list.length, 2)
  // newest two survive (sorted desc: id3, id2); id1 (oldest) is pruned
  assert.deepEqual(list.map((e) => e.id), [id3, id2])
})

// Carry-over (Task 4 review) + Fix 1 (post-release review): Windows drive
// paths must be normalized into the snapshot tree — drive letter + leading
// separators stripped, backslashes unified to '/' — so posix.relative() never
// mangles them. Restore fidelity is lossless: snapshot records the FULL
// original path in `_meta.json`, and restore writes back to the exact
// original (drive letter included), not to the normalized form.
test('snapshot normalizes Windows drive paths and restore writes back to the original drive path', async () => {
  const dir = fakeDir()
  const store = createBackupStore({ root: '/bk', dir })
  const id = await store.snapshot('C:/Users/test/.dsh/settings.json', '{"token":"x"}')
  const rel = 'Users/test/.dsh/settings.json'
  const list = await store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, id)
  // snapshot stored under root/<id>/Users/test/.dsh/settings.json (drive stripped)
  assert.equal(await dir.readFile(`/bk/${id}/${rel}`), '{"token":"x"}')
  // sidecar records the full original path (lossless restore)
  const meta = JSON.parse(await dir.readFile(`/bk/${id}/_meta.json`))
  assert.equal(meta.sources[rel], 'C:/Users/test/.dsh/settings.json')
  // corrupt the ORIGINAL path, then restore must write back to it exactly
  await dir.mkdir('C:/Users/test/.dsh', { recursive: true })
  await dir.writeFile('C:/Users/test/.dsh/settings.json', 'corrupted')
  await store.restore(id)
  assert.equal(await dir.readFile('C:/Users/test/.dsh/settings.json'), '{"token":"x"}')
})

// Fix 1 regression: a snapshot WITHOUT a meta sidecar (pre-0.2 backup) must
// still restore — falling back to the lossy normalized path.
test('restore falls back to normalized path when no meta sidecar exists', async () => {
  const dir = fakeDir()
  const store = createBackupStore({ root: '/bk', dir })
  const id = await store.snapshot('C:/Users/test/.dsh/settings.json', '{"a":1}')
  // remove the sidecar to simulate a legacy snapshot
  dir.store.delete(`bk/${id}/_meta.json`)
  await dir.mkdir('/Users/test/.dsh', { recursive: true })
  await dir.writeFile('/Users/test/.dsh/settings.json', 'corrupted')
  await store.restore(id)
  assert.equal(await dir.readFile('/Users/test/.dsh/settings.json'), '{"a":1}')
})

// Review round 2, #3: _meta.json may record a NATIVE Windows path with
// backslashes (C:\Users\x\.dsh\settings.json, as produced by expandSources'
// node:path.join). Restore must create the target directory correctly for
// such paths — posix.dirname would return '.' and mkdir('.') would no-op,
// failing when the directory does not exist (e.g. cross-machine restore).
test('restore handles native backslash windows paths with missing target dirs', async () => {
  const dir = fakeDir()
  const store = createBackupStore({ root: '/bk', dir })
  const id = await store.snapshot('C:/Users/test/.dsh/settings.json', '{"x":1}')
  const rel = 'Users/test/.dsh/settings.json'
  // rewrite the sidecar with a NATIVE backslash path (like expandSources gives)
  const native = 'C:\\Users\\test\\.dsh\\settings.json'
  dir.store.set(`bk/${id}/_meta.json`, { kind: 'file', text: JSON.stringify({ sources: { [rel]: native } }) })
  // target directory does NOT exist yet — restore must create it
  await store.restore(id)
  assert.equal(await dir.readFile('C:/Users/test/.dsh/settings.json'), '{"x":1}')
})
