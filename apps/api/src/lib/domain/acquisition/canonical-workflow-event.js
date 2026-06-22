// Canonical normalized workflow event contract — Workflow Studio V2 authority.

export const CANONICAL_ACQUISITION_STAGES = Object.freeze({
  S1: 'ownership_confirmation',
  S2: 'selling_interest',
  S3: 'asking_price',
  S4: 'property_condition_underwriting',
  S5: 'offer_negotiation',
  S6: 'contract_to_close',
});

export const CANONICAL_SELLER_INTENTS = Object.freeze({
  INTERESTED: 'interested',
  CONDITIONALLY_INTERESTED: 'conditionally_interested',
  FUTURE_INTEREST: 'future_interest',
  NOT_INTERESTED: 'not_interested',
  REPRESENTED: 'represented',
  LISTED: 'listed',
  UNCLEAR: 'unclear',
  NEEDS_REVIEW: 'needs_review',
  OPTED_OUT: 'opted_out',
});

/**
 * @typedef {object} CanonicalWorkflowEvent
 * @property {string} event_id
 * @property {string} idempotency_key
 * @property {string} source_event_id
 * @property {string} occurred_at
 * @property {string|null} thread_key
 * @property {string|null} master_owner_id
 * @property {string|null} property_id
 * @property {string|null} campaign_id
 * @property {string|null} campaign_run_id
 * @property {string|null} enrollment_id
 * @property {string|null} workflow_definition_id
 * @property {string|null} current_stage
 * @property {object|null} classification
 * @property {number|null} classification_confidence
 * @property {object} extracted_fields
 * @property {string|null} language
 * @property {number|null} language_confidence
 * @property {number|null} motivation_score
 * @property {string|null} urgency_band
 * @property {string|null} seller_intent
 * @property {string|null} next_action
 * @property {string|null} template_use_case
 * @property {boolean} requires_human_review — deprecated; use requires_operator_exception
 * @property {string|null} review_reason
 * @property {boolean} requires_operator_exception
 * @property {string|null} exception_reason
 * @property {string|null} automation_action — queue_auto_reply | queue_clarification | automated_fallback | operator_exception | terminal_suppression
 * @property {number|null} clarification_attempt_count
 */

function clean(value) {
  return String(value ?? '').trim();
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildCanonicalWorkflowEvent(input = {}) {
  const classification =
    input.classification && typeof input.classification === 'object' ? input.classification : {};
  const extracted =
    input.extracted_fields && typeof input.extracted_fields === 'object'
      ? input.extracted_fields
      : {};

  const eventId = clean(input.event_id) || clean(input.source_event_id) || null;
  const sourceEventId = clean(input.source_event_id) || eventId || null;
  const threadKey = clean(input.thread_key) || null;
  const stage = clean(input.current_stage ?? input.stage) || null;

  const idempotencyKey =
    clean(input.idempotency_key) ||
    `wfv2:${clean(input.enrollment_id) || 'no_enrollment'}:${sourceEventId || 'no_source'}:${stage || 'no_stage'}`;

  return {
    event_id: eventId,
    idempotency_key: idempotencyKey,
    source_event_id: sourceEventId,
    occurred_at: clean(input.occurred_at) || new Date().toISOString(),
    thread_key: threadKey,
    master_owner_id: clean(input.master_owner_id) || null,
    property_id: clean(input.property_id) || null,
    campaign_id: clean(input.campaign_id) || null,
    campaign_run_id: clean(input.campaign_run_id) || null,
    enrollment_id: clean(input.enrollment_id) || null,
    workflow_definition_id: clean(input.workflow_definition_id) || null,
    current_stage: stage,
    classification,
    classification_confidence: asNumber(
      input.classification_confidence ?? classification.confidence,
      null,
    ),
    extracted_fields: extracted,
    language: clean(input.language ?? classification.language) || null,
    language_confidence: asNumber(input.language_confidence ?? classification.language_confidence, null),
    motivation_score: asNumber(input.motivation_score ?? classification.motivation_score, null),
    urgency_band: clean(input.urgency_band) || null,
    seller_intent: clean(input.seller_intent ?? classification.seller_intent) || null,
    next_action: clean(input.next_action) || null,
    template_use_case: clean(input.template_use_case) || null,
    requires_human_review: Boolean(
      input.requires_operator_exception ?? input.requires_human_review,
    ),
    review_reason: clean(input.exception_reason ?? input.review_reason) || null,
    requires_operator_exception: Boolean(
      input.requires_operator_exception ?? input.requires_human_review,
    ),
    exception_reason: clean(input.exception_reason ?? input.review_reason) || null,
    automation_action: clean(input.automation_action) || null,
    clarification_attempt_count: asNumber(input.clarification_attempt_count, null),
  };
}

export function mapClassificationToSellerIntent(classification = {}) {
  const primary = clean(classification.primary_intent).toLowerCase();
  const objection = clean(classification.objection).toLowerCase();
  const confidence = asNumber(classification.confidence, 0);

  if (primary === 'opt_out' || objection === 'stop_texting') {
    return CANONICAL_SELLER_INTENTS.OPTED_OUT;
  }
  if (primary === 'not_interested') return CANONICAL_SELLER_INTENTS.NOT_INTERESTED;
  if (objection === 'already_listed') return CANONICAL_SELLER_INTENTS.LISTED;
  if (objection === 'needs_call' || primary === 'hostile_or_legal') {
    return CANONICAL_SELLER_INTENTS.NEEDS_REVIEW;
  }
  if (primary === 'unclear' || confidence < 0.7) return CANONICAL_SELLER_INTENTS.UNCLEAR;
  if (primary === 'latent_interest' || primary === 'need_time') {
    return CANONICAL_SELLER_INTENTS.FUTURE_INTEREST;
  }
  if (primary === 'seller_interested' || primary === 'ownership_confirmed') {
    return confidence >= 0.85
      ? CANONICAL_SELLER_INTENTS.INTERESTED
      : CANONICAL_SELLER_INTENTS.CONDITIONALLY_INTERESTED;
  }
  if (primary === 'asks_offer' || primary === 'asking_price_provided') {
    return CANONICAL_SELLER_INTENTS.INTERESTED;
  }
  return CANONICAL_SELLER_INTENTS.UNCLEAR;
}

export default {
  CANONICAL_ACQUISITION_STAGES,
  CANONICAL_SELLER_INTENTS,
  buildCanonicalWorkflowEvent,
  mapClassificationToSellerIntent,
};