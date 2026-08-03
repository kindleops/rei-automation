// Builds the `conversation_context_v1` object that classify.js already knows how
// to consume.
//
// Production incident 2026-08-03: the outbound "Do you still own 4157 Pillsbury
// Ave S Unit B?" was delivered and persisted, the seller replied "Yeah", and
// conversation-context.js already contained a complete resolver
// (applyContextualShortReply → ownership_confirmed @ 0.88). But NO caller ever
// constructed the context object, so validateConversationContext always returned
// `unavailable`, classify.js capped confidence at 0.72
// (short_reply_without_validated_context), and the 0.82 automation gate routed a
// perfectly unambiguous answer to human review. The context was available in the
// database the whole time — `context_status: unavailable` was simply wrong.
//
// This module never fabricates context from message text. If the last outbound
// cannot be resolved, or its use case is not an approved one, it returns null and
// the classifier keeps its existing `unavailable` behaviour.

import {
  APPROVED_OUTBOUND_USE_CASES,
  CONTEXT_VERSION,
  isCanonicalE164,
} from "./conversation-context.js";

/**
 * Maps a persisted send_queue.message_type onto an approved outbound use case.
 * Unknown types return null — an unmapped question must not be guessed at.
 */
export function mapMessageTypeToUseCase(message_type) {
  const raw = String(message_type ?? "").trim().toLowerCase();
  if (!raw) return null;

  const direct = raw.replace(/[\s-]+/g, "_");
  if (APPROVED_OUTBOUND_USE_CASES.includes(direct)) return direct;

  const aliases = {
    ownership: "ownership_check",
    ownership_verification: "ownership_check",
    owner_check: "ownership_check",
    follow_up: "general_followup",
    followup: "general_followup",
    proposal: "proposal_interest",
    offer_interest: "proposal_interest",
    price_check: "asking_price",
    price: "asking_price",
    condition: "condition_check",
    motivation: "motivation_check",
    timeline: "timeline_check",
  };
  const mapped = aliases[direct] || null;
  return mapped && APPROVED_OUTBOUND_USE_CASES.includes(mapped) ? mapped : null;
}

const USE_CASE_QUESTION_TYPE = {
  ownership_check: "ownership",
  proposal_interest: "proposal_interest",
  proposal_request: "proposal_request",
  asking_price: "asking_price",
  condition_check: "condition",
  motivation_check: "motivation",
  timeline_check: "timeline",
  general_followup: "other",
};

/**
 * Loads the latest delivered/sent outbound on the thread and returns a
 * conversation_context_v1 object, or null when it cannot be resolved.
 *
 * @param {object} args
 * @param {string} args.thread_key            canonical E.164 thread
 * @param {string} args.inbound_received_at   ISO timestamp of the inbound
 * @param {object} args.supabase              supabase client
 * @param {string} [args.canonical_stage]     lifecycle stage, when known
 * @param {string} [args.language]
 */
export async function buildConversationContext({
  thread_key,
  inbound_received_at,
  supabase,
  canonical_stage = null,
  language = null,
} = {}) {
  if (!supabase || !isCanonicalE164(thread_key) || !inbound_received_at) return null;

  let rows;
  try {
    const { data, error } = await supabase
      .from("send_queue")
      .select("id,message_type,provider_message_id,sent_at,delivered_at,queue_status")
      .eq("to_phone_number", thread_key)
      .in("queue_status", ["sent", "delivered"])
      .not("sent_at", "is", null)
      .lte("sent_at", inbound_received_at)
      .order("sent_at", { ascending: false })
      .limit(2);
    if (error) return null;
    rows = data;
  } catch {
    return null;
  }

  const last_outbound = Array.isArray(rows) ? rows[0] : null;
  if (!last_outbound) return null;

  const use_case = mapMessageTypeToUseCase(last_outbound.message_type);
  if (!use_case) return null;

  const delivered_at = last_outbound.delivered_at || last_outbound.sent_at;
  if (!delivered_at) return null;

  return {
    context_version: CONTEXT_VERSION,
    canonical_thread: thread_key,
    inbound_thread: thread_key,
    canonical_stage: canonical_stage || null,
    last_outbound_message_id: String(
      last_outbound.provider_message_id || last_outbound.id
    ),
    last_outbound_use_case: use_case,
    last_outbound_question_type: USE_CASE_QUESTION_TYPE[use_case] || "other",
    last_outbound_delivered_at: new Date(delivered_at).toISOString(),
    current_inbound_received_at: new Date(inbound_received_at).toISOString(),
    // The query is bounded to outbounds at-or-before this inbound and ordered
    // newest-first, so the head IS the question being answered: nothing newer
    // can have superseded it.
    intervening_outbound_count: 0,
    unanswered_question: true,
    language: language || null,
  };
}

export default buildConversationContext;
