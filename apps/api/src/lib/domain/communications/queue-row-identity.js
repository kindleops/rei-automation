/**
 * queue-row-identity.js
 *
 * Answers one question about a send_queue row: WHICH seller communication does
 * this row schedule?
 *
 * THE ANSWER MAY BE "I DO NOT KNOW", AND THAT IS A REFUSAL.
 *
 *   A queue row that cannot name its domain action must not reach the provider.
 *   The tempting alternative -- fall back to sending it anyway, because it is
 *   sitting in the queue and the queue used to be the authority -- is exactly
 *   the behaviour §11 removes. `queue_status = 'queued'` is a scheduling fact,
 *   not evidence that a seller should receive a message.
 *
 * MEASURED BLAST RADIUS (production, 2026-09-04). Of 17,331 queue rows only 2
 * are still actionable, and neither carries a derivable anchor, so refusal
 * strands nothing live. One of the two is the protected proof row
 * ff46dd32-fa46-465c-b653-20b70f669d0b, which this refusal keeps un-sendable by
 * construction rather than by a named special case.
 *
 * Historical rows are NOT backfilled. 0 of 17,331 carry decision_id,
 * message_event_id, follow_up_id, operator_action_id or seller_offer_id, and
 * inventing lineage for them would manufacture exactly the false identity the
 * logical key exists to prevent.
 *
 * Rows written after §11 carry logical_communication_id directly, so the
 * derivation paths below are a bridge for the two legacy shapes that genuinely
 * do encode their action, not a general-purpose guesser.
 */

import { COMMUNICATION_TYPES } from '@/lib/domain/communications/logical-communication-key.js';

function clean(value) {
  return String(value ?? '').trim();
}

function readMetadata(queue_row = {}) {
  const md = queue_row.metadata;
  if (!md || typeof md !== 'object') return {};
  return md;
}

/**
 * @returns {{ok:true, bound:true, logical_communication_id:string}
 *          |{ok:true, bound:false, communication_type:string, anchors:object, lineage:object}
 *          |{ok:false, reason:string}}
 */
export function resolveQueueRowIdentity(queue_row = {}) {
  // ── already bound: the row names its action outright ─────────────────────
  const bound = clean(queue_row.logical_communication_id);
  if (bound) {
    return { ok: true, bound: true, logical_communication_id: bound };
  }

  const md = readMetadata(queue_row);
  const lineage = {
    thread_key: clean(queue_row.thread_key) || null,
    to_phone_number: clean(queue_row.to_phone_number) || null,
    campaign_id: clean(queue_row.campaign_id) || null,
    property_id: clean(md.property_id) || null,
    master_owner_id: clean(md.master_owner_id) || null,
    source_event_id: clean(queue_row.source_event_id) || null,
  };

  // ── campaign touch: target + touch number ARE the action ─────────────────
  // Deliberately not template_id or scheduled_for: re-rendering or
  // rescheduling the same touch is the same communication.
  const campaign_target_id = clean(queue_row.campaign_target_id);
  const touch_number = queue_row.touch_number;
  if (campaign_target_id && Number.isInteger(Number(touch_number)) && Number(touch_number) >= 1) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.CAMPAIGN_TOUCH,
      anchors: { campaign_target_id, touch_number: String(touch_number) },
      lineage: { ...lineage, campaign_target_id, touch_number: String(touch_number) },
    };
  }

  // ── internal canary: run + leg ───────────────────────────────────────────
  const canary_run_id = clean(md.canary_run_id);
  const canary_leg = clean(md.canary_leg) || clean(md.canary_stage);
  if (canary_run_id && canary_leg) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.INTERNAL_CANARY,
      anchors: { canary_run_id, canary_leg },
      lineage: { ...lineage, canary_run_id, canary_leg },
    };
  }

  // ── autonomous reply / follow-up / manual, when the enqueuer recorded it ──
  const decision_id = clean(md.decision_id);
  if (decision_id) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.AUTONOMOUS_REPLY,
      anchors: { decision_id },
      lineage: { ...lineage, decision_id },
    };
  }

  const follow_up_id = clean(md.follow_up_id);
  if (follow_up_id) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.FOLLOW_UP,
      anchors: { follow_up_id },
      lineage: { ...lineage, follow_up_id },
    };
  }

  const operator_action_id = clean(md.operator_action_id);
  if (operator_action_id) {
    return {
      ok: true,
      bound: false,
      communication_type: COMMUNICATION_TYPES.MANUAL_OPERATOR_SEND,
      anchors: { operator_action_id },
      lineage: { ...lineage, operator_action_id },
    };
  }

  // ── no derivable action: REFUSE ──────────────────────────────────────────
  // Not "send it anyway because it is queued".
  return {
    ok: false,
    reason: 'queue_row_identity_underivable',
    queue_row_id: clean(queue_row.id) || null,
  };
}

export default resolveQueueRowIdentity;
