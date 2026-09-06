/**
 * s12-memory-callback-store.mjs
 *
 * In-memory callback store mirroring the SQL SEMANTICS, not merely the
 * interface. A permissive fake would let a test pass while the real database
 * refused the identical call, which is the failure mode this file exists to
 * avoid.
 */

export function createMemoryCallbackStore() {
  const state = { events: new Map(), attempts: new Map(), logicals: new Map(), orphanCount: null };

  const store = {
    _state: state,

    seedAttempt(attempt) {
      state.attempts.set(attempt.id, { outcome_class: null, provider_message_id: null, ...attempt });
      return attempt.id;
    },
    /** Force a candidate cardinality for the orphan tests. */
    setOrphanCandidates(count, attempt = null) {
      state.orphanCount = { count, attempt };
    },

    async getOrCreateCallbackEvent({ fingerprint, evidence, trust }) {
      const existing = state.events.get(fingerprint);
      if (existing) {
        // Mirrors the RPC, which returns the canonical row's processing_status so
        // the caller can tell "already ruled on" from "recorded but never ruled on".
        return {
          ok: true,
          duplicate: true,
          created: false,
          callback_event_id: existing.id,
          processing_status: existing.processing_status,
          adoption_status: existing.adoption_status,
          bound_attempt_id: existing.bound_attempt_id ?? null,
        };
      }
      const row = {
        id: `cbe-${state.events.size + 1}`,
        fingerprint,
        ...evidence,
        ...trust,
        adoption_status: 'unprocessed',
        processing_status: 'pending',
        bound_attempt_id: null,
      };
      state.events.set(fingerprint, row);
      return { ok: true, duplicate: false, created: true, callback_event_id: row.id };
    },

    async markCallbackEvent(patch) {
      const row = [...state.events.values()].find((e) => e.id === patch.callback_event_id);
      if (!row) return { ok: false, reason: 'callback_event_not_found' };
      // Evidence immutability mirrors the trigger: only interpretation moves.
      row.adoption_status = patch.adoption_status ?? row.adoption_status;
      row.adoption_reason = patch.adoption_reason ?? row.adoption_reason;
      row.processing_status = patch.processing_status ?? row.processing_status;
      if (patch.bound_attempt_id && !row.bound_attempt_id) row.bound_attempt_id = patch.bound_attempt_id;
      return { ok: true };
    },

    async findAttemptByProviderSid(sid) {
      const attempt = [...state.attempts.values()].find((a) => a.provider_message_id === sid);
      return { ok: true, attempt: attempt || null };
    },

    async findOrphanCandidates() {
      if (!state.orphanCount) return { ok: true, candidate_count: 0 };
      const { count, attempt } = state.orphanCount;
      return {
        ok: true,
        candidate_count: count,
        attempt_id: count === 1 ? attempt?.id : null,
        logical_communication_id: count === 1 ? attempt?.logical_communication_id : null,
        outcome_class: count === 1 ? attempt?.outcome_class : null,
      };
    },

    async bindProviderSid({ attempt_id, provider_message_sid }) {
      const a = state.attempts.get(attempt_id);
      if (!a) return { ok: false, reason: 'attempt_not_found' };
      // Set-once, mirroring the immutability trigger.
      if (a.provider_message_id && a.provider_message_id !== provider_message_sid) {
        return { ok: false, reason: 'provider_sid_conflict' };
      }
      // Partial-unique index: one SID binds to at most one attempt.
      const other = [...state.attempts.values()].find(
        (x) => x.id !== attempt_id && x.provider_message_id === provider_message_sid);
      if (other) return { ok: false, reason: 'provider_sid_multi_bind' };
      a.provider_message_id = provider_message_sid;
      return { ok: true };
    },

    async applyCallbackOutcome({
      attempt_id, expected_outcome_class, outcome_class, delivery_possibility, provider_status,
    }) {
      const a = state.attempts.get(attempt_id);
      if (!a) return { ok: false, reason: 'attempt_not_found' };
      // Mirrors the SQL `.eq('outcome_class', expected)` predicate. Without this
      // the fake would accept a blind write and hide the exact race the real
      // database refuses.
      const current = a.outcome_class ?? null;
      const expected = expected_outcome_class ?? null;
      if (current !== expected) return { ok: false, reason: 'outcome_changed_under_us' };
      a.outcome_class = outcome_class;
      a.delivery_possibility = delivery_possibility;
      a.provider_status = provider_status;
      return { ok: true };
    },
  };
  return store;
}

export default createMemoryCallbackStore;
