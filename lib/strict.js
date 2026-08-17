// lib/strict.js — privilege-tiering for dsh-safety-net.
//
// When strict mode is on, safety-net DECLARES a read-only default sandbox
// mode. The declaration is advisory: safety-net cannot force the host backend,
// so index.js warns when the host sandbox default is wider than read-only
// (workspace-write / danger-full-access). Escalation beyond the declared
// posture stays with the host's own sandbox machinery.

/**
 * Compute the default sandbox mode from config.
 * @param {object} config - the safetyNet config object
 * @returns {'read-only' | 'workspace-write'}
 */
export function computeDefaultMode(config) {
  return (config?.strict ?? true) ? 'read-only' : 'workspace-write'
}
