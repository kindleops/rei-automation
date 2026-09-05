/**
 * dispatch-seller-queue-row.js
 *
 * The bridge from the queue runner to the canonical dispatch seam.
 *
 * WHAT THE QUEUE RUNNER GIVES UP BY CALLING THIS.
 *   Before §11 the runner read a row, decided for itself that `queued` plus a
 *   remaining retry budget meant "send", and called TextGrid. Every one of
 *   those decisions is now made elsewhere:
 *
 *     which action is this?        queue-row-identity (refuses if unknown)
 *     may another attempt happen?  seller_communication_attempt_allocate (SQL)
 *     are we allowed to send now?  evaluateCanonicalSendAuthority
 *     what did the provider do?    transport classifier + transition authority
 *
 *   The runner keeps exactly one job: deciding WHICH row to work on next.
 *
 * RUNTIME AUTHORITY IS RE-EVALUATED HERE, not inherited from the caller's
 * earlier compliance check. Attempt 2 of a communication can be perfectly
 * retry-safe and still forbidden because the seller sent STOP since attempt 1,
 * or because an operator hit the brake. Transport safety is not compliance.
 */

import { child } from '@/lib/logging/logger.js';
import { executeSellerCommunicationAttempt } from '@/lib/domain/communications/canonical-communication-dispatch.js';
import { createSellerCommunicationStore } from '@/lib/domain/communications/seller-communication-store.js';
import { resolveQueueRowIdentity } from '@/lib/domain/communications/queue-row-identity.js';
import { buildLogicalCommunicationKey, LOGICAL_COMMUNICATION_KEY_VERSION } from '@/lib/domain/communications/logical-communication-key.js';
import { evaluateCanonicalSendAuthority } from '@/lib/domain/queue/canonical-send-authority.js';
import { classifyTextGridProviderError } from '@/lib/domain/messaging/textgrid-provider-error-classifier.js';
import { assertNoEmDash } from '@/lib/domain/messaging/outbound-content-guard.js';

const logger = child({ module: 'domain.communications.queue_dispatch' });

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Execute one seller-visible queue row through the canonical seam.
 *
 * @returns {{ok, sent, provider_invoked, reason, provider_message_id,
 *            logical_communication_id, attempt_id, delivery_possibility,
 *            retry_authority}}
 */
export async function dispatchSellerQueueRow(queue_row = {}, message_fields = {}, deps = {}) {
  const store = deps.store || createSellerCommunicationStore({ supabase: deps.supabase });
  const queue_row_id = clean(queue_row.id) || null;

  // A store that cannot answer is not permission to send, and it must REFUSE
  // rather than throw: a TypeError escaping the dispatch path is something a
  // caller may catch and mistake for a transport failure, which is the one
  // reading that could justify a retry.
  if (typeof store?.getOrCreateLogicalCommunication !== 'function'
    || typeof store?.allocateAttempt !== 'function') {
    logger.error('queue_dispatch.store_unavailable', { queue_row_id });
    return {
      ok: false, sent: false, provider_invoked: false,
      stage: 'store', reason: 'logical_communication_store_unavailable',
    };
  }

  // ── 1. which action does this row schedule? ──────────────────────────────
  const identity = resolveQueueRowIdentity(queue_row);
  if (!identity.ok) {
    logger.warn('queue_dispatch.identity_refused', { queue_row_id, reason: identity.reason });
    return {
      ok: false, sent: false, provider_invoked: false,
      stage: 'identity', reason: identity.reason,
    };
  }

  // ── 2. resolve the logical communication ─────────────────────────────────
  let logical_communication_id = identity.bound ? identity.logical_communication_id : null;

  if (!identity.bound) {
    const key = buildLogicalCommunicationKey({
      communication_type: identity.communication_type,
      ...identity.anchors,
    });
    if (!key.ok) {
      return {
        ok: false, sent: false, provider_invoked: false,
        stage: 'identity', reason: key.reason,
      };
    }

    const resolved = await store.getOrCreateLogicalCommunication({
      logical_key: key.key,
      logical_key_version: LOGICAL_COMMUNICATION_KEY_VERSION,
      communication_type: identity.communication_type,
      lineage: identity.lineage,
    });
    if (!resolved.ok) {
      logger.warn('queue_dispatch.logical_unavailable', {
        queue_row_id, reason: resolved.reason, conflicting_fields: resolved.conflicting_fields,
      });
      return {
        ok: false, sent: false, provider_invoked: false,
        stage: 'identity', reason: resolved.reason,
      };
    }
    logical_communication_id = resolved.communication.id;

    // Bind the row so the next worker resolves the same action without
    // re-deriving it, and so the queue/logical relation is auditable.
    await store.bindQueueRow({ queue_row_id, logical_communication_id });
  }

  // ── 2b. MONETARY TERMS MAY NOT DRIFT UNDER A RETRY ───────────────────────
  //
  // A transport retry re-sends an ALREADY AUTHORISED message. If the row now
  // points at a different offer version than the communication it is bound to,
  // something upstream re-underwrote between attempts, and delivering it would
  // put terms in front of a seller that were never authorised under this
  // communication. Changed terms require a NEW offer version and therefore a
  // NEW domain action, which is a decision with a name -- not a side effect of
  // a delivery failure.
  //
  // Refuse loudly rather than silently repairing: a silent repair is how the
  // wrong number reaches a seller with a straight face.
  if (identity.bound && identity.monetary) {
    const bound_comm = await store.getLogicalCommunicationById(logical_communication_id);
    if (bound_comm?.ok) {
      const stored_version = clean(bound_comm.communication.seller_offer_version);
      const stored_offer = clean(bound_comm.communication.seller_offer_id);
      const row_version = clean(identity.monetary.seller_offer_version);
      const row_offer = clean(identity.monetary.seller_offer_id);
      if ((stored_version && stored_version !== row_version)
        || (stored_offer && stored_offer !== row_offer)) {
        logger.error('queue_dispatch.monetary_offer_mismatch', {
          queue_row_id,
          logical_communication_id,
          stored_offer_id: stored_offer, stored_offer_version: stored_version,
          row_offer_id: row_offer, row_offer_version: row_version,
        });
        return {
          ok: false, sent: false, provider_invoked: false,
          stage: 'monetary_authority',
          reason: 'monetary_communication_offer_mismatch',
          logical_communication_id,
        };
      }
    }
  }

  // ── 3. canonical seam ────────────────────────────────────────────────────
  // The raw provider payload is captured on the way past so the queue runner's
  // existing finalisation keeps working unchanged. It is telemetry for the
  // caller, never an input to any authority decision here.
  let raw_provider_result = null;
  const sendProviderImpl = deps.sendProvider;
  const sendProvider = async (args) => {
    const result = await sendProviderImpl(args);
    raw_provider_result = result;
    return result;
  };

  const outcome = await executeSellerCommunicationAttempt(
    {
      communication_type: identity.bound ? null : identity.communication_type,
      anchors: identity.bound ? null : identity.anchors,
      lineage: identity.bound ? {} : identity.lineage,
      preresolved_logical_communication_id: logical_communication_id,
      queue_row_id,
      message: {
        to: message_fields.to,
        from: message_fields.from,
        body: message_fields.body,
      },
    },
    {
      store,
      sendProvider,
      // Defaulted, not required. Without a classifier the seam treats EVERY
      // failure as unknown and therefore ambiguous, which is the correct
      // fail-closed posture for a genuinely unrecognised outcome but would
      // permanently wedge a communication whose caller merely forgot to pass
      // one. Fail closed on unknown outcomes, not on unknown wiring.
      classifyProviderError: deps.classifyProviderError || classifyTextGridProviderError,
      now: deps.now || new Date().toISOString(),
      logger,
      // Re-evaluated per attempt: see the header note on STOP between retries.
      evaluateRuntimeAuthority: async () => {
        const authority = await evaluateCanonicalSendAuthority({
          getSystemValue: deps.getSystemValue,
          action: 'queue_send',
          scopedCanary: deps.scoped_canary === true,
        });
        return authority.ok ? { ok: true } : { ok: false, reason: authority.reason };
      },
      assertOutboundContent: async (message) => {
        const verdict = assertNoEmDash(message?.body);
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
    }
  );

  return { ...outcome, raw_provider_result };
}

export default dispatchSellerQueueRow;
