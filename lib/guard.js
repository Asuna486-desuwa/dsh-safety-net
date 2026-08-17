// lib/guard.js — protected-path guard for dsh-safety-net.
//
// Rules match canonical (case-normalized) path prefixes. The protected set
// covers everything whose loss would strand the user: the DSH data home,
// the plugin data checkout, and profile manifests/patches. Everything else
// passes through untouched — the guard is deliberately narrow.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Normalize a path for matching: forward slashes, lowercase on win32. */
function norm(p) {
  let out = String(p).replace(/\\/g, '/')
  if (process.platform === 'win32') out = out.toLowerCase()
  return out
}

function isUnder(path, root) {
  const p = norm(path)
  const r = norm(root)
  if (p === r) return true
  const prefix = r.endsWith('/') ? r : r + '/'
  return p.startsWith(prefix)
}

/**
 * Build the default protected-path rules from a DSH home.
 * @param {object} opts
 * @param {string} opts.dshHome - DSH data root (default: $DSH_HOME or ~/.dsh)
 * @param {string} [opts.pluginDataRoot] - plugin data root (default: ~/.claude/plugins/data)
 * @returns {Array<{id: string, matcher: string}>}
 */
export function defaultRules({ dshHome, pluginDataRoot = join(homedir(), '.claude', 'plugins', 'data') }) {
  const pluginData = join(pluginDataRoot, 'dsh-deepseek-dsh')
  return [
    { id: 'dsh-home', matcher: dshHome },
    { id: 'plugin-data', matcher: pluginData },
    { id: 'profile-manifest', matcher: join(dshHome, 'profiles') },
    { id: 'profile-patch', matcher: join(dshHome, 'profiles') },
    { id: 'session-state', matcher: join(dshHome, 'state') },
  ]
}

/**
 * Create a guard instance.
 * @param {object} opts
 * @param {string} opts.dshHome
 * @param {string} [opts.pluginDataRoot] - override plugin data root (tests)
 * @param {string[]} opts.extraProtectedPaths
 * @returns {{ isProtected(path): boolean, approveOnce(path): void, rules: Array }}
 */
export function createGuard({ dshHome, pluginDataRoot, extraProtectedPaths = [] }) {
  const rules = defaultRules({ dshHome, pluginDataRoot })
  const approved = new Set()

  function isProtected(path) {
    if (approved.has(norm(path))) {
      approved.delete(norm(path)) // one-time bypass
      return false
    }
    for (const rule of rules) {
      if (isUnder(path, rule.matcher)) return true
    }
    for (const extra of extraProtectedPaths) {
      if (isUnder(path, extra)) return true
    }
    return false
  }

  return {
    rules,
    isProtected,
    approveOnce(path) {
      approved.add(norm(path))
    },
  }
}

export { norm, isUnder }
