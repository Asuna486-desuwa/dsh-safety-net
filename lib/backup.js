// lib/backup.js — backup-before-destroy engine for dsh-safety-net.
//
// Every snapshot is one directory under the backup root named by a timestamp
// id; the original relative path is preserved beneath it so restore can put
// the file back exactly where it was. Prune keeps the newest N snapshots.

// Use posix path semantics so snapshot paths stay forward-slash on every
// platform — the injected fs adapter (and its fakes) key paths with '/'.
import { posix } from 'node:path'
const { join, dirname } = posix

/** Time-based id, unique per call (ms + random suffix for collisions). */
function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Normalize a source path into a root-relative snapshot path segment:
 * drive letter and leading separators stripped, backslashes unified to '/'.
 *   'C:\Users\x\.dsh\settings.json' -> 'Users/x/.dsh/settings.json'
 *   '/Users/x/.dsh/settings.json'    -> 'Users/x/.dsh/settings.json'
 * This keeps Windows drive paths out of posix.relative(), which would mangle
 * them into a CWD-relative garbage path containing ':' (illegal on Windows).
 */
function toRel(source) {
  return String(source)
    .replace(/^[A-Za-z]:[\\/]/, '')   // strip drive letter
    .replace(/^[\\/]+/, '')           // strip leading separators
    .replace(/\\/g, '/')              // unify forward slashes
}

/** Map a source path to its snapshot path under root. */
function snapshotPath(root, id, source) {
  return join(root, id, toRel(source))
}

/**
 * Create a backup store.
 * @param {object} opts
 * @param {string} opts.root - backup root directory
 * @param {object} opts.dir - injected fs adapter:
 *   { mkdir, readFile, writeFile, rm, listDir, exists } — production passes
 *   node:fs/promises-compatible object; tests pass a fake.
 * @returns {{ snapshot(source, text): Promise<string>, list(): Promise<Array>, restore(id): Promise<void>, prune(retention): Promise<number> }}
 */
export function createBackupStore({ root, dir }) {
  async function snapshot(source, text) {
    const id = newId()
    const dest = snapshotPath(root, id, source)
    await dir.mkdir(dirname(dest), { recursive: true })
    await dir.writeFile(dest, text, 'utf8')
    return id
  }

  async function list() {
    let ids = []
    try {
      ids = await dir.listDir(root)
    } catch {
      return []
    }
    const out = []
    for (const id of ids) {
      try {
        const stat = await dir.stat?.(join(root, id)) ?? { mtimeMs: 0, size: 0 }
        out.push({ id, time: stat.mtimeMs, size: stat.size, source: null })
      } catch {
        // unreadable snapshot dirs are skipped
      }
    }
    return out.sort((a, b) => b.time - a.time)
  }

  async function restore(id) {
    const entries = await list()
    const found = entries.find((e) => e.id === id)
    if (!found) throw new Error(`safety-net: no backup "${id}"`)
    // walk the snapshot dir and write every file back to its source path
    const files = await listSnapshotFiles(id)
    for (const rel of files) {
      const dest = join('/', toRel(rel))
      const text = await dir.readFile(join(root, id, rel), 'utf8')
      await dir.mkdir(dirname(dest), { recursive: true })
      await dir.writeFile(dest, text, 'utf8')
    }
  }

  async function listSnapshotFiles(id) {
    const base = join(root, id)
    const out = []
    // Note: the walk parameter is named `current`, NOT `dir` — the injected
    // fs adapter `dir` would otherwise be shadowed and dir.listDir() would
    // throw on a string, silently emptying every snapshot walk.
    async function walk(current, prefix) {
      let names = []
      try {
        names = await dir.listDir(current)
      } catch {
        return
      }
      for (const n of names) {
        const full = join(current, n)
        const rel = prefix ? `${prefix}/${n}` : n
        const st = await dir.stat?.(full)
        if (st?.isDirectory?.()) await walk(full, rel)
        else out.push(rel)
      }
    }
    await walk(base, '')
    return out
  }

  async function prune(retention) {
    const entries = await list()
    if (entries.length <= retention) return 0
    const doomed = entries.slice(retention)
    for (const entry of doomed) {
      await dir.rm(join(root, entry.id), { recursive: true, force: true })
    }
    return doomed.length
  }

  return { snapshot, list, restore, prune }
}
