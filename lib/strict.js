// lib/strict.js — privilege-tiering for dsh-safety-net.
//
// When strict mode is on, the effective default sandbox mode is read-only:
// mutations require explicit user approval to escalate (the DSH sandbox
// ladder: read-only -> workspace-write -> danger-full-access). This is the
// "default low privilege, explicit approval to upgrade" guardrail.

/**
 * Compute the default sandbox mode from config.
 * @param {object} config - the safetyNet config object
 * @returns {'read-only' | 'workspace-write'}
 */
export function computeDefaultMode(config) {
  return (config?.strict ?? true) ? 'read-only' : 'workspace-write'
}
