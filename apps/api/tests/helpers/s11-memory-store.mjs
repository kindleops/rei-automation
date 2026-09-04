/**
 * s11-memory-store.mjs
 *
 * An in-memory §11 store for tests that exercise a converged send path.
 *
 * It deliberately mirrors the SQL SEMANTICS rather than merely satisfying the
 * interface, because a permissive fake would let a test pass while the real
 * database refused the same call:
 *
 *   - get-or-create is keyed on logical_key and refuses on lineage mismatch
 *   - allocation refuses ambiguity, forbidden states, denied retry authority
 *   - allocation refuses while ANY sibling attempt is unresolved
 *   - completed_at and provider evidence are set-once
 *
 * If you are tempted to loosen one of these to make a test pass, the test is
 * telling you the production call would have been refused too.
 */

export function createMemoryS11Store() {
  const state = {
    communications: new Map(), // logical_key -> row
    byId: new Map(),
    attempts: [],
    bindings: [],
  };

  const store = {
    _state: state,

    async getOrCreateLogicalCommunication({ logical_key, communication_type, lineage = {} }) {
      const existing = state.communications.get(logical_key);
      if (existing) {
        const mismatched = ['decision_id', 'campaign_target_id', 'touch_number', 'operator_action_id',
          'message_event_id', 'follow_up_id', 'canary_run_id', 'canary_leg']
          .filter((f) => (existing[f] ?? null) !== (lineage[f] ?? null));
        if (existing.communication_type !== communication_type || mismatched.length) {
          return {
            ok: false,
            reason: 'logical_communication_identity_conflict',
            conflicting_fields: mismatched,
          };
        }
        existing.observation_count += 1;
        return { ok: true, reused: true, communication: existing };
      }

      const row = {
        id: `lc-${state.communications.size + 1}`,
        logical_key,
        communication_type,
        state: 'created',
        delivery_possibility: 'definitely_not_sent',
        retry_authority: 'retry_allowed',
        retry_after_at: null,
        observation_count: 1,
        ...Object.fromEntries(Object.entries(lineage).filter(([, v]) => v !== undefined)),
      };
      state.communications.set(logical_key, row);
      state.byId.set(row.id, row);
      return { ok: true, reused: false, communication: row };
    },

    async getLogicalCommunicationById(id) {
      const row = state.byId.get(id);
      if (!row) return { ok: false, reason: 'logical_communication_not_found' };
      return { ok: true, reused: true, communication: row };
    },

    async allocateAttempt({ logical_communication_id, queue_row_id = null }) {
      const comm = state.byId.get(logical_communication_id);
      if (!comm) return { ok: false, reason: 'logical_communication_not_found' };

      if (comm.delivery_possibility === 'may_have_been_sent'
        || comm.state === 'ambiguous_provider_outcome') {
        return { ok: false, reason: 'ambiguous_outcome_absorbing' };
      }
      if (['delivered', 'provider_accepted', 'no_send', 'suppressed', 'cancelled', 'failed_terminal']
        .includes(comm.state)) {
        return { ok: false, reason: 'state_forbids_attempt' };
      }
      if (['retry_denied', 'operator_hold', 'terminal'].includes(comm.retry_authority)) {
        return { ok: false, reason: 'retry_authority_denies' };
      }

      const siblings = state.attempts.filter((a) => a.logical_communication_id === logical_communication_id);
      if (siblings.some((a) => !a.completed_at)) {
        return { ok: false, reason: 'attempt_already_in_flight' };
      }

      const attempt = {
        id: `att-${state.attempts.length + 1}`,
        logical_communication_id,
        attempt_number: siblings.length + 1,
        queue_row_id,
        provider_request_started_at: null,
        provider_message_id: null,
        completed_at: null,
      };
      state.attempts.push(attempt);
      comm.state = 'claimed';
      return { ok: true, attempt_id: attempt.id, attempt_number: attempt.attempt_number };
    },

    async markProviderRequestStarted({ attempt_id, at }) {
      const a = state.attempts.find((x) => x.id === attempt_id);
      if (!a) return { ok: false, reason: 'provider_request_start_not_durable' };
      if (a.provider_request_started_at) {
        return { ok: false, reason: 'provider_request_start_not_durable' };
      }
      a.provider_request_started_at = at;
      return { ok: true };
    },

    async recordAttemptOutcome(patch) {
      const a = state.attempts.find((x) => x.id === patch.attempt_id);
      if (!a) return { ok: false, reason: 'attempt_not_found' };
      if (a.completed_at) return { ok: false, reason: 'completed_at_is_set_once' };
      Object.assign(a, patch, { completed_at: patch.at });
      return { ok: true };
    },

    async applyLogicalTransition({ logical_communication_id, next }) {
      const row = state.byId.get(logical_communication_id);
      if (row) Object.assign(row, next);
      return { ok: true };
    },

    async bindQueueRow({ queue_row_id, logical_communication_id }) {
      state.bindings.push({ queue_row_id, logical_communication_id });
      return { ok: true };
    },

    async updateQueueProjection() { return { ok: true }; },
    async writeMessageEventProjection() { return { ok: true }; },
  };

  return store;
}

/**
 * Minimal lineage that makes a queue row identifiable, for fixtures whose
 * subject is something else (phone normalisation, template rendering, ...) and
 * which simply need the row to HAVE an action.
 */
export function withDerivableIdentity(queue_row = {}, overrides = {}) {
  return {
    ...queue_row,
    campaign_target_id: queue_row.campaign_target_id
      || overrides.campaign_target_id
      || '11111111-1111-4111-8111-111111111111',
    touch_number: queue_row.touch_number ?? overrides.touch_number ?? 1,
  };
}

export default createMemoryS11Store;

// §11: a manual send now needs a durable operator action and a communication
// store. Both are stubbed here because this fixture's subject is the compliance
// / race behaviour around the send, not §11 identity persistence. The stub
// returns a STABLE id so a replay in these tests resolves to ONE action, which
// is what the production table guarantees via request_idempotency_key.
export function s11ManualSendDeps(actionId = "op-action-fixture-1") {
  return {
    store: createMemoryS11Store(),
    resolveOperatorAction: async () => ({ ok: true, operator_action_id: actionId, reused: false }),
  };
}
