/**
 * promote-first-contact-on-send.js
 *
 * FIRST-CONTACT PROMOTION AT PROVIDER ACCEPTANCE.
 *
 * Defect (2026-09-08): 150 campaign first touches were provider-accepted and
 * delivered while every inbox_thread_state row stayed conversation_status
 * 'not_contacted' with an empty next_action. The seller received a real text
 * and replied while the state machine believed contact had never occurred.
 *
 * WHERE THIS RUNS
 *   After finalizeSendQueueSuccess AND after writeOutboundSuccessMessageEvent
 *   at BOTH successful-send sites (queue runner and manual send-now). It must
 *   follow the message-event write because that callee's
 *   syncClassifiedInboxThreadState -> upsertInboxThreadState writes
 *   stage:'' / status:'active' / next_action:'' on a new row and would clobber
 *   what we write here. Queued, scheduled and claimed rows never reach either
 *   site; a refusal before the wire returns earlier. Provider acceptance is
 *   proven by the SID finalizeSendQueueSuccess already refuses to run without.
 *
 * WHAT IT MEANS
 *   "We have now successfully contacted this seller." Nothing more: no
 *   ownership, interest or price is implied. The canonical literal is
 *   OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER. It is deliberately NOT the word
 *   'contacted': normalizeOperationalStatus has no such code and its fallback
 *   is 'not_contacted', so writing 'contacted' would silently invert the fix.
 *
 * MONOTONIC + IDEMPOTENT
 *   Promotion happens only when the row is genuinely un-contacted:
 *   operational_status in (NULL, not_contacted, scheduled). A later-stage
 *   conversation (new_reply, active_communication, needs_review, snoozed,
 *   paused, follow_up_due, waiting_on_seller) is never touched, so an S2-S6
 *   outbound, a follow-up or an auto-reply can never push a thread backward.
 *   lifecycle_stage is set to S1 only when absent. Because the write is
 *   state-conditional, a re-finalized outbound (transport retry, delivery
 *   callback, duplicate bookkeeping) finds waiting_on_seller and is a no-op:
 *   exactly one durable promotion per thread, no second stage event.
 *
 * NEVER THROWS. This is bookkeeping after a terminal, correct send; a failure
 * here must not fail the send or the runner. The caller records the result.
 */
import {
  LIFECYCLE_STAGE_CODES,
  OPERATIONAL_STATUS_CODES,
  normalizeLifecycleStage,
  normalizeOperationalStatus,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import {
  fetchCurrentLeadState,
  patchUniversalLeadState,
} from "@/lib/domain/lead-state/patch-universal-lead-state.js";

export const FIRST_CONTACT_REASON = "first_outbound_provider_accepted";

/** Statuses that mean "this seller has not yet been reached". */
const UNCONTACTED_STATUSES = new Set([
  OPERATIONAL_STATUS_CODES.NOT_CONTACTED,
  OPERATIONAL_STATUS_CODES.SCHEDULED,
]);

function clean(value) {
  return String(value ?? "").trim();
}

const CANONICAL_THREAD_KEY = /^\+1\d{10}$/;

/**
 * Decide, from a thread's current row, whether a provider-accepted outbound
 * should promote it. Pure; exported so the contract is testable without I/O.
 *
 * @returns {{ promote: boolean, reason: string, patch?: object }}
 */
export function decideFirstContactPromotion(previousRow) {
  const previous = previousRow || null;
  const rawStatus = clean(previous?.operational_status) || clean(previous?.conversation_status);
  // An absent / empty status is "no opinion", which for a brand-new thread is
  // exactly not-contacted. Anything else is normalized through the registry.
  const status = rawStatus ? normalizeOperationalStatus(rawStatus) : OPERATIONAL_STATUS_CODES.NOT_CONTACTED;
  if (!UNCONTACTED_STATUSES.has(status)) {
    return { promote: false, reason: `already_engaged:${status}` };
  }

  const rawStage = clean(previous?.lifecycle_stage) || clean(previous?.seller_stage) || clean(previous?.stage);
  const patch = { operational_status: OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER };
  if (!rawStage) {
    patch.lifecycle_stage = LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION;
  } else {
    // A stage already exists (e.g. inbound classification advanced it before
    // this bookkeeping ran). Leave it alone -- a send never moves stage.
    normalizeLifecycleStage(rawStage); // validates only; result intentionally unused
  }
  return { promote: true, reason: FIRST_CONTACT_REASON, patch };
}

/**
 * @param {object} input
 * @param {object} input.queue_row       finalized send_queue row (post finalizeSendQueueSuccess)
 * @param {object} [input.outbound_event] result of writeOutboundSuccessMessageEvent
 * @param {object} input.supabase
 * @param {string} [input.now]
 * @param {object} [input.deps]          test seams: fetchCurrentLeadState, patchUniversalLeadState
 * @returns {Promise<{ok:boolean, promoted:boolean, reason:string, thread_key:string|null}>}
 */
export async function promoteFirstContactOnProviderAcceptance({
  queue_row,
  outbound_event = null,
  supabase,
  now = null,
  deps = {},
} = {}) {
  const thread_key = clean(queue_row?.thread_key) || clean(queue_row?.to_phone_number);
  try {
    if (!CANONICAL_THREAD_KEY.test(thread_key)) {
      return { ok: true, promoted: false, reason: "non_canonical_thread_key", thread_key: thread_key || null };
    }
    if (!clean(queue_row?.provider_message_id)) {
      // Not provider-accepted. Never promote on a queued/claimed/failed row.
      return { ok: true, promoted: false, reason: "no_provider_sid", thread_key };
    }
    const metadata = queue_row?.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
    if (metadata.no_send === true || metadata.proof_hydration === true) {
      return { ok: true, promoted: false, reason: "proof_row", thread_key };
    }

    const fetchState = deps.fetchCurrentLeadState || fetchCurrentLeadState;
    const patchState = deps.patchUniversalLeadState || patchUniversalLeadState;

    const previous = await fetchState(supabase, thread_key);
    const decision = decideFirstContactPromotion(previous);
    if (!decision.promote) {
      return { ok: true, promoted: false, reason: decision.reason, thread_key };
    }

    const result = await patchState({
      threadKey: thread_key,
      patch: decision.patch,
      meta: {
        change_source: "system",
        reason: FIRST_CONTACT_REASON,
        source_view: "send_success_seam",
        message_event_id: outbound_event?.item_id ?? outbound_event?.id ?? null,
        transition_reason: FIRST_CONTACT_REASON,
        metadata: {
          queue_row_id: queue_row?.id ?? null,
          queue_key: queue_row?.queue_key ?? null,
          provider_message_id: queue_row.provider_message_id,
          touch_number: queue_row?.touch_number ?? null,
          promoted_at: now || new Date().toISOString(),
        },
      },
      supabase,
    });

    if (!result?.ok) {
      return { ok: false, promoted: false, reason: result?.reason || "patch_blocked", thread_key };
    }
    return { ok: true, promoted: true, reason: FIRST_CONTACT_REASON, thread_key };
  } catch (error) {
    return { ok: false, promoted: false, reason: `first_contact_promotion_failed:${error?.message || "unknown"}`, thread_key: thread_key || null };
  }
}
