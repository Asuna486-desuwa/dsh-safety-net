// lib/backup.js — backup-before-destroy engine for dsh-safety-net.
//
// Every snapshot is one directory under the backup root named by a timestamp
// id; the original relative path is preserved beneath it so restore can put
// the file back exactly where it was. Prune keeps the newest N snapshots.
//
// Restore fidelity: snapshot also writes a `_meta.json` next to the file copy
// holding the FULL original source path (drive letter included). Restore
// prefers that recorded path over the lossy normalized one, so a Windows
// `C:\Users\x\.dsh\settings.json` is written back to exactly `C:\...`, never
// to the current-drive root that the normalized form would imply. Snapshots
// without a meta file (pre-0.2 backups) fall back to the normalized path.

// Use posix path semantics so snapshot paths stay forward-slash on every
// platform — the injected fs adapter (and its fakes) key paths with '/'.
import { posix } from 'node:path'
const { join, dirname } = posix
// Native path utilities for REAL filesystem targets: `_meta.json` records
// the exact original source path, which on Windows carries backslashes
// (C:\Users\x\.dsh\settings.json). posix.dirname() only splits on '/', so
// it would return '.' for such a path and mkdir('.') would no-op — breaking
// restore when the target directory does not exist yet (review round 2, #3).
// node:path's native dirname understands both separators on each platform.
import { dirname as nativeDirname } from 'node:path'

/** Name of the sidecar recording the original source path inside a snapshot dir. */
const META_FILE = '_meta.json'

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
 * NOTE: this is the LOSSY form used only as the on-disk layout and as the
 * restore fallback; the exact original path lives in `_meta.json`.
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
    // Sidecar with the FULL original path so restore writes back exactly
    // where the file came from — drive letter and all (lossless). Stored at
    // the snapshot dir ROOT (root/<id>/_meta.json); `sources` maps each
    // snapshot-relative file path back to its exact original path.
    await dir.writeFile(join(root, id, META_FILE), JSON.stringify({ sources: { [toRel(source)]: source } }), 'utf8')
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
        const st = await dir.stat?.(join(root, id))
        // Only real snapshot DIRECTORIES count (review round 3, #2): a stray
        // file in the backup root (e.g. manually created) must not be treated
        // as a snapshot — restore would "succeed" while restoring nothing.
        if (st === undefined || st?.isDirectory?.() === true) {
          out.push({ id, time: st?.mtimeMs ?? 0, size: st?.size ?? 0, source: null })
        }
      } catch {
        // unreadable snapshot dirs are skipped
      }
    }
    return out.sort((a, b) => b.time - a.time)
  }

  /**
   * Resolve the exact destination for one snapshot file: the recorded
   * original path from `_meta.json` (`sources[rel]`) when present, else the
   * lossy normalized form (pre-0.2 snapshots without a sidecar).
   */
  async function recordedSource(root, id, rel) {
    const metaPath = join(root, id, META_FILE)
    try {
      const raw = await dir.readFile(metaPath, 'utf8')
      const meta = JSON.parse(raw)
      if (meta?.sources && typeof meta.sources[rel] === 'string' && meta.sources[rel].length > 0) {
        return meta.sources[rel]
      }
      if (typeof meta?.source === 'string' && meta.source.length > 0) return meta.source
    } catch {
      // no meta / unreadable / malformed — fall through to normalized path
    }
    return join('/', toRel(rel))
  }

  async function restore(id) {
    const entries = await list()
    const found = entries.find((e) => e.id === id)
    if (!found) throw new Error(`safety-net: no backup "${id}"`)
    // walk the snapshot dir and write every file back to its source path
    const files = await listSnapshotFiles(id)
    for (const rel of files) {
      if (rel === META_FILE) continue // sidecar is not a file to restore
      const dest = await recordedSource(root, id, rel)
      const text = await dir.readFile(join(root, id, rel), 'utf8')
      // nativeDirname: dest is a REAL filesystem path (may contain Windows
      // backslashes from _meta.json); posix.dirname would return '.' for it
      await dir.mkdir(nativeDirname(dest), { recursive: true })
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
