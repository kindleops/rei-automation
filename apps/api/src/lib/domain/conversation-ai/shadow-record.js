// Conversation Engine 2.0 — the SHADOW RECORD (one per inbound message id).
//
// The only thing R1/R2 produce. send_status is always 'not_sent_shadow'.
// The record carries masked text only (phones/emails masked, names reduced to
// "[name]" except the seller's first name) and a hashed thread reference.
//
// Idempotency: the key is derived from the inbound message id ALONE, so a repeat
// webhook / parallel duplicate inbound for the same message resolves to the same
// key, and the store (PROPOSED unique index) or the in-process single-flight
// returns the first decision instead of making a second one.
import { SHADOW_SEND_STATUS } from './policy.js'

export const SHADOW_RECORD_VERSION = 'conv-ai.shadow.v1'

export function idempotencyKeyFor(inboundMessageId) {
  const id = String(inboundMessageId ?? '').trim()
  if (!id) throw new Error('INBOUND_MESSAGE_ID_REQUIRED')
  return `conv-ai:v1:${id}`
}

export function buildShadowRecord({
  inboundMessageId, threadRef, propertyIds = [], createdAt, sellerMessageMasked, decision, path, models = [],
  calls = [], draft = null, validation = null, deterministic = null, latencyMs = null, policyCode = null, contextSummary = null,
  inboundVersion = null,
}) {
  const cost = { haiku_usd: 0, sonnet_usd: 0, other_usd: 0, total_usd: 0 }
  for (const c of calls) {
    const usd = Number(c.usd) || 0
    if (/haiku/i.test(c.model)) cost.haiku_usd += usd
    else if (/sonnet/i.test(c.model)) cost.sonnet_usd += usd
    else cost.other_usd += usd
    cost.total_usd += usd
  }
  for (const k of Object.keys(cost)) cost[k] = Math.round(cost[k] * 1e6) / 1e6
  return {
    record_version: SHADOW_RECORD_VERSION,
    idempotency_key: idempotencyKeyFor(inboundMessageId),
    inbound_message_id: String(inboundMessageId),
    // 8.5.15: the inbound message VERSION the decision was made on (conversation-ai-shadow-hook.js inboundVersionOf)
    inbound_version: inboundVersion && /^[a-p]{16}$/.test(inboundVersion) ? inboundVersion : null,
    thread_ref: threadRef,
    property_ids: propertyIds.map(String),
    created_at: createdAt,
    seller_message_masked: sellerMessageMasked,
    understood: { intent: decision.intent, seller_interest: decision.seller_interest, confidence: decision.confidence },
    facts: { extracted: decision.facts_extracted, already_known: decision.facts_already_known },
    stage_evidence: decision.stage_evidence,
    decision: {
      contract_version: decision.contract_version,
      outcome: decision.outcome,
      next_objective: decision.next_objective,
      response_needed: decision.response_needed,
      escalation_required: decision.escalation_required,
      escalation_reason: decision.escalation_reason,
      send_permission_requested: decision.send_permission_requested,
      send_permission_granted: false,
      source_message_ids: decision.source_message_ids,
      fail_closed: decision._fail_closed || null,
    },
    model: { path, models: [...new Set(models)], calls: calls.map((c) => ({ model: c.model, route: c.route, usd: c.usd, latency_ms: c.latency_ms, input_tokens: c.usage?.input_tokens ?? null, output_tokens: c.usage?.output_tokens ?? null, stop_reason: c.stop_reason ?? null, valid: c.valid ?? null, errors: (c.errors || []).slice(0, 6) })) },
    draft: draft ? { text: draft.text, chars: draft.text.length, monetary_amounts: draft.monetary_amounts || [], needs_approval: Boolean(draft.needs_approval) } : null,
    validation: validation || { status: 'not_applicable', reasons: [] },
    deterministic_engine: deterministic,
    context_summary: contextSummary,
    policy_code: policyCode,
    send_status: SHADOW_SEND_STATUS,
    cost,
    latency_ms: latencyMs,
  }
}
