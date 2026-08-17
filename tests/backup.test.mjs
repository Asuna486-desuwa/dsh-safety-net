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
  return {
    store,
    async mkdir(p, opts) {
      // mimic fs.promises.mkdir(..., { recursive: true }): create every missing
      // parent so stat() of intermediate dirs reports isDirectory() (the real
      // store relies on this when snapshotting multi-level source paths)
      const parts = String(p).replace(/^[/\\]+/, '').split('/')
      let cur = ''
      for (const part of parts) {
        cur += '/' + part
        if (!store.has(cur)) store.set(cur, { kind: 'dir' })
      }
    },
    async readFile(p) {
      const v = store.get(p)
      if (!v) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return v.text
    },
    async writeFile(p, text) { store.set(p, { kind: 'file', text }) },
    async rm(p) {
      const prefix = p.endsWith('/') ? p : p + '/'
      for (const k of [...store.keys()]) {
        if (k === p || k.startsWith(prefix)) store.delete(k)
      }
    },
    async listDir(p) {
      const prefix = p.endsWith('/') ? p : p + '/'
      const out = new Set()
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) {
          const first = k.slice(prefix.length).split('/')[0]
          if (first) out.add(first)
        }
      }
      return [...out]
    },
    async exists(p) { return store.has(p) },
    async stat(p) {
      const v = store.get(p)
      return {
        mtimeMs: 0,
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
  await store.snapshot('/src/a.txt', '1')
  await store.snapshot('/src/a.txt', '2')
  await store.snapshot('/src/a.txt', '3')
  await store.prune(2)
  const list = await store.list()
  assert.equal(list.length, 2)
})

// Carry-over (Task 4 review): Windows drive paths must be normalized into the
// snapshot tree — drive letter + leading separators stripped, backslashes
// unified to '/'. Otherwise posix.relative() mangles drive paths into a
// CWD-relative garbage path containing ':' (an illegal filename segment).
test('snapshot normalizes Windows drive paths', async () => {
  const dir = fakeDir()
  const store = createBackupStore({ root: '/bk', dir })
  const id = await store.snapshot('C:/Users/test/.dsh/settings.json', '{"token":"x"}')
  const rel = 'Users/test/.dsh/settings.json'
  const list = await store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, id)
  // snapshot stored under root/<id>/Users/test/.dsh/settings.json (drive stripped)
  assert.equal(await dir.readFile(`/bk/${id}/${rel}`), '{"token":"x"}')
  // restore rebuilds the normalized root-relative path and writes the content
  // back to it (the drive letter is not recoverable once stripped)
  await dir.writeFile(`/${rel}`, 'corrupted')
  await store.restore(id)
  assert.equal(await dir.readFile(`/${rel}`), '{"token":"x"}')
})
