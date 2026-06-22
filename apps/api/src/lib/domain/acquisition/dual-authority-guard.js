// Prevents the same inbound reply from producing two authoritative actions.

const processed = new Map();
const MAX_ENTRIES = 5000;

function clean(value) {
  return String(value ?? '').trim();
}

function prune() {
  if (processed.size <= MAX_ENTRIES) return;
  const keys = [...processed.keys()].slice(0, processed.size - MAX_ENTRIES);
  for (const key of keys) processed.delete(key);
}

export function buildDualAuthorityKey({ source_event_id, thread_key } = {}) {
  return `dual:${clean(source_event_id)}:${clean(thread_key)}`;
}

/**
 * Claim exclusive processing for a source event + thread.
 * Returns ok:false if another engine already claimed it in-process.
 */
export function claimDualAuthorityProcessing(input = {}) {
  const key = buildDualAuthorityKey(input);
  const engine = clean(input.engine) || 'workflow_v2';

  if (!clean(input.source_event_id) || !clean(input.thread_key)) {
    return { ok: false, reason: 'missing_dual_authority_key_parts' };
  }

  const existing = processed.get(key);
  if (existing && existing.engine !== engine) {
    return {
      ok: false,
      reason: 'dual_authority_conflict',
      existing_engine: existing.engine,
      attempted_engine: engine,
    };
  }

  processed.set(key, { engine, claimed_at: Date.now() });
  prune();
  return { ok: true, key, engine };
}

export function releaseDualAuthorityClaim(input = {}) {
  const key = buildDualAuthorityKey(input);
  processed.delete(key);
  return { ok: true, key };
}

export function __resetDualAuthorityGuardForTests() {
  processed.clear();
}

export default {
  buildDualAuthorityKey,
  claimDualAuthorityProcessing,
  releaseDualAuthorityClaim,
  __resetDualAuthorityGuardForTests,
};