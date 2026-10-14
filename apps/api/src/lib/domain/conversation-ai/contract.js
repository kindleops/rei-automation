// Conversation Engine 2.0 — R1 structured decision contract (SHADOW ONLY).
//
// One versioned shape for every R1 decision, whoever produced it (deterministic
// pre-check, Haiku, Sonnet). validateDecision() is STRICT: unknown keys, wrong
// enums, out-of-range numbers, message ids that are not in the context, a reply
// outcome without a message (or a message on a no-reply outcome) all fail.
// An invalid decision NEVER flows on: failClosedDecision() turns it into
// NEEDS_REVIEW with the validation errors attached.
//
// send_permission_requested is a REQUEST field only. Nothing in R1/R2 grants a
// send: send_permission_granted is always false (stamped by the engine, never
// read from the model).

export const DECISION_CONTRACT_VERSION = 'conv-ai.decision.v1'

export const OUTCOMES = Object.freeze(['NO_RESPONSE', 'UPDATE_ONLY', 'REPLY_CANDIDATE', 'ESCALATE_TO_SONNET', 'NEEDS_REVIEW', 'SUPPRESS'])

export const INTENTS = Object.freeze([
  'ownership_confirmed', 'ownership_denied', 'wrong_number', 'who_is_this', 'interested', 'conditional_interest',
  'not_interested', 'asking_price_provided', 'asks_offer', 'condition_disclosed', 'price_and_condition',
  'counter_or_negotiation', 'need_time', 'callback_requested', 'info_request', 'non_owner_referral',
  'tenant_or_occupant', 'listed_or_sold', 'multi_property', 'correction', 'acknowledgement', 'language_switch',
  'opt_out', 'hostile_or_legal', 'unclear',
])

export const SELLER_INTEREST = Object.freeze(['interested', 'conditional', 'undecided', 'not_interested', 'unknown'])

export const FACT_KEYS = Object.freeze([
  'ownership', 'asking_price', 'condition', 'occupancy', 'timeline', 'motivation', 'property_reference',
  'identity_role', 'contact_preference', 'language', 'offer_request', 'listing_status', 'seller_interest', 'repairs', 'rent',
])

export const STAGES = Object.freeze(['S1_ownership', 'S2_interest', 'S3_asking_price', 'S4_condition', 'S5_offer', 'nurture', 'closed', 'unknown'])

export const NEXT_OBJECTIVES = Object.freeze([
  'confirm_ownership', 'gauge_interest', 'get_asking_price', 'get_condition', 'offer_needs_human',
  'answer_question', 'clarify_identity', 'acknowledge', 'nurture_later', 'none',
])

export const ESCALATION_REASONS = Object.freeze([
  'contradiction', 'multiple_properties', 'multiple_owners', 'complex_negotiation', 'financing',
  'nonstandard_deal', 'validation_failure', 'low_confidence', 'legal', 'other',
])

export const MAX_PROPOSED_MESSAGE_CHARS = 320

const DECISION_KEYS = Object.freeze([
  'contract_version', 'intent', 'seller_interest', 'facts_extracted', 'facts_already_known', 'stage_evidence',
  'next_objective', 'response_needed', 'outcome', 'proposed_message', 'confidence', 'escalation_required',
  'escalation_reason', 'send_permission_requested', 'source_message_ids',
])
const FACT_ITEM_KEYS = Object.freeze(['fact', 'value', 'source_message_id', 'confidence'])
const STAGE_EVIDENCE_KEYS = Object.freeze(['stage', 'evidence_message_ids', 'rationale'])

/** JSON schema handed to the model as the forced tool's input_schema (same rules as validateDecision). */
export const DECISION_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [...DECISION_KEYS],
  properties: {
    contract_version: { type: 'string', enum: [DECISION_CONTRACT_VERSION] },
    intent: { type: 'string', enum: [...INTENTS] },
    seller_interest: { type: 'string', enum: [...SELLER_INTEREST] },
    facts_extracted: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false, required: [...FACT_ITEM_KEYS],
        properties: {
          fact: { type: 'string', enum: [...FACT_KEYS] },
          value: { type: ['string', 'number', 'boolean'], maxLength: 300 },
          source_message_id: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    facts_already_known: { type: 'array', maxItems: 12, items: { type: 'string', enum: [...FACT_KEYS] } },
    stage_evidence: {
      type: 'object', additionalProperties: false, required: [...STAGE_EVIDENCE_KEYS],
      properties: {
        stage: { type: 'string', enum: [...STAGES] },
        evidence_message_ids: { type: 'array', maxItems: 12, items: { type: 'string' } },
        rationale: { type: 'string', maxLength: 600 },
      },
    },
    next_objective: { type: 'string', enum: [...NEXT_OBJECTIVES] },
    response_needed: { type: 'boolean' },
    outcome: { type: 'string', enum: [...OUTCOMES] },
    proposed_message: { type: ['string', 'null'], maxLength: MAX_PROPOSED_MESSAGE_CHARS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    escalation_required: { type: 'boolean' },
    escalation_reason: { type: ['string', 'null'], enum: [...ESCALATION_REASONS, null] },
    send_permission_requested: { type: 'boolean' },
    source_message_ids: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
  },
})

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1

function extraKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.includes(k))
}

/**
 * Strict validation.
 * @param {unknown} raw
 * @param {{ messageIds?: Iterable<string>, inboundMessageIds?: Iterable<string> }} [ctx]
 *   messageIds: every message id present in the bounded context (inbound + outbound).
 *   inboundMessageIds: the seller's (inbound) ids — a seller-stated fact must cite one.
 * @returns {{ ok: true, decision: object } | { ok: false, errors: string[] }}
 */
export function validateDecision(raw, { messageIds = null, inboundMessageIds = null } = {}) {
  const errors = []
  if (!isObj(raw)) return { ok: false, errors: ['decision:not_object'] }
  const d = raw
  const known = messageIds ? new Set([...messageIds].map(String)) : null
  const inbound = inboundMessageIds ? new Set([...inboundMessageIds].map(String)) : null
  for (const k of extraKeys(d, DECISION_KEYS)) errors.push(`decision:unknown_key:${k}`)
  for (const k of DECISION_KEYS) if (!(k in d)) errors.push(`decision:missing:${k}`)
  if (d.contract_version !== DECISION_CONTRACT_VERSION) errors.push('contract_version:mismatch')
  if (!INTENTS.includes(d.intent)) errors.push('intent:enum')
  if (!SELLER_INTEREST.includes(d.seller_interest)) errors.push('seller_interest:enum')
  if (!Array.isArray(d.facts_extracted) || d.facts_extracted.length > 12) errors.push('facts_extracted:array')
  else d.facts_extracted.forEach((f, i) => {
    if (!isObj(f)) { errors.push(`facts_extracted[${i}]:not_object`); return }
    for (const k of extraKeys(f, FACT_ITEM_KEYS)) errors.push(`facts_extracted[${i}]:unknown_key:${k}`)
    if (!FACT_KEYS.includes(f.fact)) errors.push(`facts_extracted[${i}].fact:enum`)
    if (!['string', 'number', 'boolean'].includes(typeof f.value) || (typeof f.value === 'string' && (!f.value.trim() || f.value.length > 300))) errors.push(`facts_extracted[${i}].value:type`)
    if (typeof f.source_message_id !== 'string' || !f.source_message_id) errors.push(`facts_extracted[${i}].source_message_id:missing`)
    else if (inbound && !inbound.has(f.source_message_id)) errors.push(`facts_extracted[${i}].source_message_id:not_a_seller_message`)
    if (!isUnit(f.confidence)) errors.push(`facts_extracted[${i}].confidence:range`)
  })
  if (!Array.isArray(d.facts_already_known) || d.facts_already_known.length > 12 || d.facts_already_known.some((f) => !FACT_KEYS.includes(f))) errors.push('facts_already_known:enum_array')
  if (!isObj(d.stage_evidence)) errors.push('stage_evidence:not_object')
  else {
    for (const k of extraKeys(d.stage_evidence, STAGE_EVIDENCE_KEYS)) errors.push(`stage_evidence:unknown_key:${k}`)
    if (!STAGES.includes(d.stage_evidence.stage)) errors.push('stage_evidence.stage:enum')
    const ev = d.stage_evidence.evidence_message_ids
    if (!Array.isArray(ev) || ev.length > 12 || ev.some((x) => typeof x !== 'string')) errors.push('stage_evidence.evidence_message_ids:array')
    else if (known) for (const x of ev) if (!known.has(x)) errors.push('stage_evidence.evidence_message_ids:unknown_id')
    if (typeof d.stage_evidence.rationale !== 'string' || d.stage_evidence.rationale.length > 600) errors.push('stage_evidence.rationale:type')
  }
  if (!NEXT_OBJECTIVES.includes(d.next_objective)) errors.push('next_objective:enum')
  if (typeof d.response_needed !== 'boolean') errors.push('response_needed:type')
  if (!OUTCOMES.includes(d.outcome)) errors.push('outcome:enum')
  const pm = d.proposed_message
  if (!(pm === null || typeof pm === 'string')) errors.push('proposed_message:type')
  if (typeof pm === 'string' && pm.length > MAX_PROPOSED_MESSAGE_CHARS) errors.push('proposed_message:too_long')
  if (d.outcome === 'REPLY_CANDIDATE' && !(typeof pm === 'string' && pm.trim())) errors.push('proposed_message:required_for_reply')
  if (['NO_RESPONSE', 'SUPPRESS', 'UPDATE_ONLY'].includes(d.outcome) && typeof pm === 'string' && pm.trim()) errors.push('proposed_message:forbidden_for_outcome')
  if (d.outcome === 'REPLY_CANDIDATE' && d.response_needed === false) errors.push('outcome:reply_without_response_needed')
  if (!isUnit(d.confidence)) errors.push('confidence:range')
  if (typeof d.escalation_required !== 'boolean') errors.push('escalation_required:type')
  if (!(d.escalation_reason === null || ESCALATION_REASONS.includes(d.escalation_reason))) errors.push('escalation_reason:enum')
  if (d.escalation_required === true && d.escalation_reason === null) errors.push('escalation_reason:required')
  if (typeof d.send_permission_requested !== 'boolean') errors.push('send_permission_requested:type')
  const src = d.source_message_ids
  if (!Array.isArray(src) || src.length < 1 || src.length > 20 || src.some((x) => typeof x !== 'string' || !x)) errors.push('source_message_ids:array')
  else if (known) for (const x of src) if (!known.has(x)) errors.push('source_message_ids:unknown_id')
  if (errors.length) return { ok: false, errors: [...new Set(errors)] }
  return { ok: true, decision: d }
}

/** Fail closed: an invalid / missing decision becomes NEEDS_REVIEW, never a reply. */
export function failClosedDecision({ errors = [], sourceMessageIds = [], producedBy = 'validator', raw = null } = {}) {
  return {
    contract_version: DECISION_CONTRACT_VERSION,
    intent: 'unclear',
    seller_interest: 'unknown',
    facts_extracted: [],
    facts_already_known: [],
    stage_evidence: { stage: 'unknown', evidence_message_ids: [], rationale: 'fail-closed: decision invalid or unavailable' },
    next_objective: 'none',
    response_needed: false,
    outcome: 'NEEDS_REVIEW',
    proposed_message: null,
    confidence: 0,
    escalation_required: false,
    escalation_reason: null,
    send_permission_requested: false,
    source_message_ids: sourceMessageIds.length ? [...sourceMessageIds] : ['unknown'],
    _fail_closed: { produced_by: producedBy, errors: [...errors].slice(0, 30), had_raw: raw != null },
  }
}

/** Build a contract-shaped decision (deterministic producers use this so they share the validator). */
export function makeDecision(fields) {
  return {
    contract_version: DECISION_CONTRACT_VERSION,
    intent: 'unclear',
    seller_interest: 'unknown',
    facts_extracted: [],
    facts_already_known: [],
    stage_evidence: { stage: 'unknown', evidence_message_ids: [], rationale: '' },
    next_objective: 'none',
    response_needed: false,
    outcome: 'NEEDS_REVIEW',
    proposed_message: null,
    confidence: 1,
    escalation_required: false,
    escalation_reason: null,
    send_permission_requested: false,
    source_message_ids: [],
    ...fields,
  }
}
