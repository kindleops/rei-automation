/**
 * seller-communication-store.js
 *
 * The durable side of the canonical dispatch seam: the only module that reads
 * or writes the §11 tables.
 *
 * Every method here is deliberately thin. The interesting decisions -- may this
 * allocate, is this ambiguous, does acceptance forbid a retry -- live in SQL
 * (seller_communication_attempt_allocate) and in the transition authority, not
 * here. A store that also decided policy would be a second place for the rules
 * to drift.
 *
 * THE ONE RULE THIS FILE MUST NEVER BREAK.
 *   markProviderRequestStarted() returns ok ONLY when the write is confirmed
 *   durable. The dispatcher calls the provider on the strength of that answer,
 *   so an optimistic `ok: true` here would silently convert a crash into a
 *   message the system believes was never sent. Every failure path returns a
 *   refusal, including exceptions.
 */

import { child } from '@/lib/logging/logger.js';
import { supabase as defaultSupabase } from '@/lib/supabase/client.js';

const logger = child({ module: 'domain.communications.store' });

function clean(value) {
  return String(value ?? '').trim();
}

/** Only lineage the RPC understands; unknown keys would be silently dropped. */
const LINEAGE_FIELDS = Object.freeze([
  'channel', 'thread_key', 'to_phone_number', 'to_email', 'property_id', 'opportunity_id', 'master_owner_id',
  'decision_id', 'message_event_id', 'campaign_id', 'campaign_target_id', 'touch_number',
  'follow_up_id', 'referral_id', 'source_event_id', 'seller_offer_id', 'seller_offer_version',
  'operator_action_id', 'canary_run_id', 'canary_leg', 'supersedes_communication_id',
]);

function pickLineage(lineage = {}) {
  const out = {};
  for (const field of LINEAGE_FIELDS) {
    const value = lineage[field];
    if (value === null || value === undefined || clean(value) === '') continue;
    out[field] = String(value);
  }
  return out;
}

export function createSellerCommunicationStore(deps = {}) {
  const supabase = deps.supabase || defaultSupabase;

  return {
    /**
     * Atomic get-or-create. Returns the canonical row, or a refusal when the
     * stored lineage disagrees with what this caller believes it owns.
     */
    async getOrCreateLogicalCommunication({ logical_key, logical_key_version, communication_type, lineage = {} }) {
      const { data, error } = await supabase.rpc('seller_logical_communication_get_or_create', {
        p_logical_key: logical_key,
        p_logical_key_version: logical_key_version,
        p_communication_type: communication_type,
        p_lineage: pickLineage(lineage),
        p_policy: {
          logical_key_policy_version: deps.logical_key_policy_version || null,
          retry_policy_version: deps.retry_policy_version || null,
          outcome_policy_version: deps.outcome_policy_version || null,
        },
      });

      if (error) {
        // A store that cannot answer is not permission to send.
        logger.error('logical_communication.rpc_failed', { error: clean(error.message) });
        return { ok: false, reason: 'logical_communication_store_error' };
      }
      if (!data?.ok) {
        return {
          ok: false,
          reason: data?.reason || 'logical_communication_unavailable',
          conflicting_fields: data?.conflicting_fields || null,
        };
      }

      return {
        ok: true,
        reused: data.reused === true,
        communication: {
          id: data.logical_communication_id,
          logical_key: data.logical_key,
          state: data.state,
          delivery_possibility: data.delivery_possibility,
          retry_authority: data.retry_authority,
          retry_after_at: data.retry_after_at ?? null,
        },
      };
    },

    /**
     * Loads an already-identified communication. Used when a queue row is
     * already bound, so its identity is a fact to read, not to re-derive.
     */
    async getLogicalCommunicationById(logical_communication_id) {
      const { data, error } = await supabase
        .from('seller_logical_communications')
        .select('id,logical_key,state,delivery_possibility,retry_authority,retry_after_at,seller_offer_id,seller_offer_version,communication_type')
        .eq('id', logical_communication_id)
        .maybeSingle();

      if (error) {
        logger.error('logical_communication.load_failed', {
          logical_communication_id, error: clean(error.message),
        });
        return { ok: false, reason: 'logical_communication_store_error' };
      }
      if (!data) return { ok: false, reason: 'logical_communication_not_found' };
      return { ok: true, reused: true, communication: data };
    },

    /**
     * The CONVERSATION a communication belongs to.
     *
     * Separate from getLogicalCommunicationById on purpose: that method answers
     * "what is the state of this send" and its select is read by the dispatch
     * seam, so widening it would change what every caller receives. This answers
     * "whose relationship is this", which is a different question with a
     * different set of columns.
     *
     * Channel is deliberately NOT among them. The conversation is the seller
     * relationship -- owner and property -- and a channel climbing into it is
     * how one seller becomes two leads.
     */
    async getConversationForLogicalCommunication(logical_communication_id) {
      const id = clean(logical_communication_id);
      if (!id) return null;

      const { data, error } = await supabase
        .from('seller_logical_communications')
        .select('id,opportunity_id,master_owner_id,property_id,thread_key')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        // A ledger we cannot read is not an absent conversation. Returning a
        // half-populated one would let a reply be attributed on partial anchors.
        logger.error('logical_communication.conversation_load_failed', {
          logical_communication_id: id, error: clean(error.message),
        });
        return null;
      }
      return data || null;
    },

    /**
     * Allocation is serialised in SQL (FOR UPDATE on the parent) and refuses
     * ambiguity, forbidden states, denied retry authority and -- critically --
     * any unresolved sibling attempt. Do not re-implement those checks here.
     */
    async allocateAttempt({ logical_communication_id, queue_row_id = null, claim_token = null }) {
      const { data, error } = await supabase.rpc('seller_communication_attempt_allocate', {
        p_logical_communication_id: logical_communication_id,
        p_provider: 'textgrid',
        p_queue_row_id: queue_row_id ? String(queue_row_id) : null,
        p_claim_token: claim_token ? String(claim_token) : null,
        p_policy: {
          retry_policy_version: deps.retry_policy_version || null,
          outcome_policy_version: deps.outcome_policy_version || null,
        },
      });

      if (error) {
        logger.error('attempt.allocate_rpc_failed', { logical_communication_id, error: clean(error.message) });
        return { ok: false, reason: 'attempt_allocation_store_error' };
      }
      if (!data?.ok) return { ok: false, reason: data?.reason || 'attempt_allocation_denied' };

      return { ok: true, attempt_id: data.attempt_id, attempt_number: data.attempt_number };
    },

    /**
     * THE PRE-NETWORK COMMIT.
     *
     * Confirmed durable or refused. `.select()` forces the write to be read
     * back, so a silently-zero-row update cannot masquerade as success -- for
     * example if the attempt row were already resolved, or the id were wrong.
     */
    async markProviderRequestStarted({ attempt_id, at, request_fingerprint = null }) {
      try {
        const { data, error } = await supabase
          .from('seller_communication_attempts')
          .update({
            provider_request_started_at: at,
            transport_phase: 'request_started',
            ...(request_fingerprint ? { request_fingerprint } : {}),
          })
          .eq('id', attempt_id)
          .is('provider_request_started_at', null)
          .select('id');

        if (error) {
          logger.error('attempt.provider_request_start_failed', { attempt_id, error: clean(error.message) });
          return { ok: false, reason: 'provider_request_start_write_failed' };
        }
        if (!Array.isArray(data) || data.length !== 1) {
          // Zero rows means the marker was already set (another worker owns this
          // attempt) or the row is gone. Either way this caller has NOT earned
          // the right to call the provider.
          return { ok: false, reason: 'provider_request_start_not_durable' };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: clean(error?.message) || 'provider_request_start_threw' };
      }
    },

    /** Evidence first: the attempt records what the provider actually did. */
    async recordAttemptOutcome({
      attempt_id, provider_message_id, attempt_state, delivery_possibility,
      retry_authority, failure_class, at, http_status = null, provider_status = null,
    }) {
      const { error } = await supabase
        .from('seller_communication_attempts')
        .update({
          provider_response_received_at: at,
          completed_at: at,
          outcome_class: attempt_state,
          delivery_possibility,
          retry_authority,
          failure_class: failure_class || null,
          http_status,
          provider_status,
          ...(provider_message_id ? { provider_message_id } : {}),
        })
        .eq('id', attempt_id);

      if (error) {
        // The send already happened. Losing the outcome write is a
        // reconciliation problem, never a reason to try again.
        logger.error('attempt.outcome_write_failed', { attempt_id, error: clean(error.message) });
        return { ok: false, reason: 'attempt_outcome_write_failed' };
      }
      return { ok: true };
    },

    async applyLogicalTransition({ logical_communication_id, next, cause, at }) {
      const { error } = await supabase
        .from('seller_logical_communications')
        .update({
          state: next.state,
          delivery_possibility: next.delivery_possibility,
          retry_authority: next.retry_authority,
          retry_after_at: next.retry_after_at ?? null,
          last_failure_class: next.last_failure_class ?? null,
          updated_at: at,
        })
        .eq('id', logical_communication_id);

      if (error) {
        logger.error('logical_communication.transition_write_failed', {
          logical_communication_id, cause, error: clean(error.message),
        });
        return { ok: false, reason: 'logical_transition_write_failed' };
      }
      return { ok: true };
    },

    /**
     * Apply a callback-derived outcome, CONDITIONAL on the value the caller's
     * lattice decision was based on.
     *
     * The `.eq('outcome_class', expected)` predicate is the whole point: two
     * concurrent callbacks that both read the same prior value would otherwise
     * both pass the lattice gate and the later write would win, silently
     * overwriting a terminal verdict with a contradictory one.
     */
    async applyCallbackOutcome({
      attempt_id, expected_outcome_class, outcome_class, delivery_possibility,
      provider_status, at,
    }) {
      let query = supabase
        .from('seller_communication_attempts')
        .update({
          outcome_class,
          delivery_possibility,
          provider_status: provider_status || null,
          provider_response_received_at: at,
        })
        .eq('id', attempt_id);

      query = expected_outcome_class === null || expected_outcome_class === undefined
        ? query.is('outcome_class', null)
        : query.eq('outcome_class', expected_outcome_class);

      const { data, error } = await query.select('id');

      if (error) {
        logger.error('callback.outcome_write_failed', { attempt_id, error: clean(error.message) });
        return { ok: false, reason: 'callback_outcome_write_failed' };
      }
      if (!Array.isArray(data) || data.length !== 1) {
        // Zero rows means the outcome moved between our read and our write.
        return { ok: false, reason: 'outcome_changed_under_us' };
      }
      return { ok: true };
    },

    /**
     * Which attempt produced this provider message id?
     *
     * Lives HERE rather than in the channel that needs it, because this module
     * is "the only module that reads or writes the §11 tables" and a read that
     * bypassed it would be the first crack in that claim. The email event store
     * asked this question directly at first; the contract test in
     * direct-callback-state-contract.test.mjs caught it, and moving the query
     * here is the right repair rather than widening the guard.
     *
     * Reads the append-only ATTEMPT LEDGER, never a queue projection. A queue row
     * can be repaired; the ledger is the record of what actually happened.
     *
     * Returns the current provider outcome from the ATTEMPT, because the
     * monotonic lattice compares an incoming event against what that attempt
     * already established -- not against whatever the communication happens to
     * say after other attempts.
     */
    async findAttemptByProviderMessageId(provider_message_id) {
      const id = clean(provider_message_id);
      if (!id) return { ok: false, reason: 'missing_provider_message_id' };

      const { data, error } = await supabase
        .from('seller_communication_attempts')
        .select('id, logical_communication_id, provider_message_id, outcome_class, delivery_possibility')
        .eq('provider_message_id', id)
        .order('attempt_number', { ascending: false })
        .limit(1);

      if (error) {
        // A ledger we cannot read is not an absent attempt. Saying "no match"
        // here would let a provider event be filed as unresolved and quietly
        // lose a delivery outcome.
        logger.error('attempt.lookup_failed', { error: clean(error.message) });
        return { ok: false, reason: 'attempt_lookup_failed' };
      }

      const attempt = Array.isArray(data) ? data[0] : null;
      if (!attempt) return { ok: false, reason: 'no_attempt_for_provider_message_id' };

      return {
        ok: true,
        attempt_id: attempt.id,
        logical_communication_id: attempt.logical_communication_id,
        provider_outcome: clean(attempt.outcome_class) || null,
        delivery_possibility: attempt.delivery_possibility || null,
      };
    },

    /** Binds a queue row to the action it schedules. */
    async bindQueueRow({ queue_row_id, logical_communication_id }) {
      if (!queue_row_id) return { ok: true, skipped: true };
      const { error } = await supabase
        .from('send_queue')
        .update({ logical_communication_id })
        .eq('id', queue_row_id);
      if (error) {
        logger.warn('queue.logical_binding_failed', { queue_row_id, error: clean(error.message) });
        return { ok: false, reason: 'queue_binding_failed' };
      }
      return { ok: true };
    },
  };
}

export default createSellerCommunicationStore;
