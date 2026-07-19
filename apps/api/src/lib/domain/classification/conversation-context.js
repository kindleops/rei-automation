/**
 * Validated deterministic conversation context for classify.js.
 * Never fabricates context from message text alone.
 * Invalid / missing / stale / conflicting context → status only; no override.
 */

/** Strict E.164 for conversation-context binding (matches Brain identity rules). */
export function isCanonicalE164(thread) {
  if (thread == null) return false;
  const s = String(thread).trim();
  return /^\+[1-9]\d{7,14}$/.test(s);
}

export const CONTEXT_VERSION = 'conversation_context_v1';

/** Max age of last outbound question for short-reply binding (ms). */
export const CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const APPROVED_OUTBOUND_USE_CASES = Object.freeze([
  'ownership_check',
  'proposal_interest',
  'proposal_request',
  'asking_price',
  'condition_check',
  'motivation_check',
  'timeline_check',
  'general_followup',
]);

export const APPROVED_QUESTION_TYPES = Object.freeze([
  'ownership',
  'proposal_interest',
  'proposal_request',
  'asking_price',
  'condition',
  'motivation',
  'timeline',
  'other',
]);

const STAGE_USE_CASE_AGREEMENT = {
  ownership_check: ['cold', 'ownership', 'new', 'initial', null, undefined, ''],
  proposal_interest: ['engaged', 'proposal', 'interest', 'qualified', null, undefined, ''],
  proposal_request: ['engaged', 'proposal', 'interest', 'qualified', null, undefined, ''],
  asking_price: ['engaged', 'pricing', 'qualified', null, undefined, ''],
  condition_check: ['engaged', 'condition', 'qualified', null, undefined, ''],
};

/**
 * @typedef {object} ConversationContextInput
 * @property {string} [context_version]
 * @property {string} [canonical_thread]
 * @property {string} [canonical_stage]
 * @property {string} [last_outbound_message_id]
 * @property {string} [last_outbound_use_case]
 * @property {string} [last_outbound_question_type]
 * @property {string} [last_outbound_delivered_at]
 * @property {string} [current_inbound_received_at]
 * @property {number} [intervening_outbound_count]
 * @property {number} [intervening_inbound_count]
 * @property {boolean} [unanswered_question]
 * @property {object} [existing_active_facts]
 * @property {string} [language]
 * @property {boolean} [archived_alias]
 * @property {string} [inbound_thread] - must match canonical_thread when provided
 */

/**
 * @returns {{
 *   context_status: 'valid'|'unavailable'|'stale'|'conflicting'|'invalid',
 *   context: object|null,
 *   reasons: string[],
 * }}
 */
export function validateConversationContext(raw) {
  if (raw == null || typeof raw !== 'object') {
    return { context_status: 'unavailable', context: null, reasons: ['missing_context'] };
  }

  const reasons = [];

  if (raw.archived_alias === true) {
    return { context_status: 'invalid', context: null, reasons: ['archived_alias_rejected'] };
  }

  const version = raw.context_version != null ? String(raw.context_version) : '';
  if (version && version !== CONTEXT_VERSION) {
    return { context_status: 'invalid', context: null, reasons: ['unrecognized_context_version'] };
  }
  if (!version) {
    reasons.push('missing_context_version');
  }

  const thread = raw.canonical_thread != null ? String(raw.canonical_thread).trim() : '';
  if (!thread || !isCanonicalE164(thread)) {
    return { context_status: 'invalid', context: null, reasons: ['canonical_thread_not_e164'] };
  }

  if (raw.inbound_thread != null) {
    const inboundThread = String(raw.inbound_thread).trim();
    if (inboundThread !== thread) {
      return { context_status: 'conflicting', context: null, reasons: ['inbound_thread_mismatch'] };
    }
  }

  const useCase = raw.last_outbound_use_case != null ? String(raw.last_outbound_use_case).trim() : '';
  if (!useCase || !APPROVED_OUTBOUND_USE_CASES.includes(useCase)) {
    return { context_status: 'invalid', context: null, reasons: ['unapproved_or_missing_use_case'] };
  }

  const outboundId = raw.last_outbound_message_id != null ? String(raw.last_outbound_message_id).trim() : '';
  if (!outboundId) {
    return { context_status: 'invalid', context: null, reasons: ['missing_last_outbound_message_id'] };
  }

  const outboundAt = parseTs(raw.last_outbound_delivered_at);
  const inboundAt = parseTs(raw.current_inbound_received_at);
  if (!outboundAt || !inboundAt) {
    return { context_status: 'invalid', context: null, reasons: ['invalid_timestamps'] };
  }
  if (inboundAt.getTime() < outboundAt.getTime()) {
    return { context_status: 'invalid', context: null, reasons: ['inbound_before_outbound'] };
  }

  const ageMs = inboundAt.getTime() - outboundAt.getTime();
  if (ageMs > CONTEXT_MAX_AGE_MS) {
    return { context_status: 'stale', context: null, reasons: ['context_age_exceeded'] };
  }

  const interveningOut = Number(raw.intervening_outbound_count ?? 0);
  if (!Number.isFinite(interveningOut) || interveningOut < 0) {
    return { context_status: 'invalid', context: null, reasons: ['invalid_intervening_outbound_count'] };
  }
  if (interveningOut > 0) {
    return {
      context_status: 'stale',
      context: null,
      reasons: ['newer_outbound_superseded_question'],
    };
  }

  if (raw.unanswered_question === false && interveningOut === 0) {
    // Allowed if still binding short reply to last question; flag only
    reasons.push('unanswered_question_false');
  }

  const stage = raw.canonical_stage != null ? String(raw.canonical_stage).toLowerCase() : '';
  const agreed = STAGE_USE_CASE_AGREEMENT[useCase];
  if (agreed && stage && !agreed.includes(stage) && !agreed.includes(null)) {
    // Soft: unknown stages allowed; only hard-fail known conflicts
    if (['closed', 'dead', 'dnc', 'opted_out'].includes(stage)) {
      return { context_status: 'conflicting', context: null, reasons: ['stage_use_case_conflict'] };
    }
  }

  if (raw.conflicting_unresolved_question === true) {
    return { context_status: 'conflicting', context: null, reasons: ['conflicting_unresolved_question'] };
  }

  const questionType =
    raw.last_outbound_question_type != null
      ? String(raw.last_outbound_question_type).trim()
      : inferQuestionType(useCase);

  const context = {
    context_version: CONTEXT_VERSION,
    canonical_thread: thread,
    canonical_stage: stage || null,
    last_outbound_message_id: outboundId,
    last_outbound_use_case: useCase,
    last_outbound_question_type: questionType,
    last_outbound_delivered_at: outboundAt.toISOString(),
    current_inbound_received_at: inboundAt.toISOString(),
    context_age_ms: ageMs,
    intervening_outbound_count: interveningOut,
    intervening_inbound_count: Number(raw.intervening_inbound_count ?? 0) || 0,
    unanswered_question: raw.unanswered_question !== false,
    existing_active_facts:
      raw.existing_active_facts && typeof raw.existing_active_facts === 'object'
        ? raw.existing_active_facts
        : {},
    language: raw.language != null ? String(raw.language) : null,
  };

  return {
    context_status: 'valid',
    context,
    reasons: reasons.length ? reasons : ['ok'],
  };
}

function parseTs(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inferQuestionType(useCase) {
  const map = {
    ownership_check: 'ownership',
    proposal_interest: 'proposal_interest',
    proposal_request: 'proposal_request',
    asking_price: 'asking_price',
    condition_check: 'condition',
    motivation_check: 'motivation',
    timeline_check: 'timeline',
    general_followup: 'other',
  };
  return map[useCase] || 'other';
}

/**
 * True if message is a short affirmative/negative token suitable for context binding.
 */
export function isShortContextualReply(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 48) return false;
  return /^(yes|yep|yeah|yup|yea|si|sí|correct|correcto|affirmative|no|nope|nah|nel)\.?!?$/.test(t)
    || /^(yes|yep|yeah|no|nope)\s*[.!]?$/.test(t);
}

/**
 * Apply validated context to short yes/no (and similar) replies.
 * @returns {{ applied: boolean, primary_intent?: string, labels?: string[], rule_id?: string, force_unclear?: boolean, confidence?: number, rationale?: string }}
 */
export function applyContextualShortReply(messageText, validated) {
  if (!validated || validated.context_status !== 'valid' || !validated.context) {
    return { applied: false };
  }
  if (!isShortContextualReply(messageText)) {
    return { applied: false };
  }

  const t = String(messageText || '').trim().toLowerCase().replace(/[.!]+$/, '');
  const isYes = /^(yes|yep|yeah|yup|yea|si|sí|correct|correcto|affirmative)$/.test(t);
  const isNo = /^(no|nope|nah|nel)$/.test(t);
  if (!isYes && !isNo) return { applied: false };

  const useCase = validated.context.last_outbound_use_case;
  const qType = validated.context.last_outbound_question_type;
  const base = {
    context_message_id: validated.context.last_outbound_message_id,
    context_use_case: useCase,
    context_age_ms: validated.context.context_age_ms,
  };

  if (isYes) {
    if (useCase === 'ownership_check' || qType === 'ownership') {
      return {
        applied: true,
        primary_intent: 'ownership_confirmed',
        labels: ['owner_confirmed'],
        rule_id: 'ctx_yes_after_ownership_check',
        confidence: 0.88,
        rationale: 'short_yes_bound_to_validated_ownership_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'proposal_interest' || useCase === 'proposal_request' || qType === 'proposal_interest') {
      return {
        applied: true,
        primary_intent: 'interested',
        labels: ['interested', 'proposal_interest_confirmed'],
        rule_id: 'ctx_yes_after_proposal_interest',
        confidence: 0.86,
        rationale: 'short_yes_bound_to_validated_proposal_interest_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'asking_price' || qType === 'asking_price') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: [],
        rule_id: 'ctx_yes_after_asking_price',
        force_unclear: true,
        confidence: 0.55,
        rationale: 'short_yes_after_asking_price_is_not_ownership_or_price; needs_clarification',
        evidence_span: String(messageText).trim(),
        human_review: true,
        ...base,
      };
    }
    if (useCase === 'condition_check' || qType === 'condition') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['unclear_condition_acknowledgement'],
        rule_id: 'ctx_yes_after_condition',
        force_unclear: true,
        confidence: 0.55,
        rationale: 'short_yes_after_condition_question',
        evidence_span: String(messageText).trim(),
        human_review: true,
        ...base,
      };
    }
  }

  if (isNo) {
    if (useCase === 'ownership_check' || qType === 'ownership') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['ownership_denial_needs_clarification'],
        rule_id: 'ctx_no_after_ownership_check',
        force_unclear: true,
        confidence: 0.6,
        rationale: 'short_no_after_ownership_requires_relation_evidence_unless_explicit',
        evidence_span: String(messageText).trim(),
        human_review: true,
        ...base,
      };
    }
    if (useCase === 'proposal_interest' || useCase === 'proposal_request') {
      return {
        applied: true,
        primary_intent: 'not_interested',
        labels: ['not_interested'],
        rule_id: 'ctx_no_after_proposal_interest',
        confidence: 0.88,
        rationale: 'short_no_bound_to_proposal_interest_question',
        evidence_span: String(messageText).trim(),
        ...base,
      };
    }
    if (useCase === 'asking_price' || qType === 'asking_price') {
      return {
        applied: true,
        primary_intent: 'unclear',
        labels: ['asking_price_refused'],
        rule_id: 'ctx_no_after_asking_price',
        force_unclear: true,
        confidence: 0.7,
        rationale: 'short_no_after_asking_price_treated_as_price_refusal_or_unclear',
        evidence_span: String(messageText).trim(),
        human_review: true,
        ...base,
      };
    }
  }

  return { applied: false };
}
