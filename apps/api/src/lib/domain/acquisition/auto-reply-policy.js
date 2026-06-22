// Safe auto-reply eligibility — only explicitly approved templates.

import { TEMPLATE_LIFECYCLE, isTemplateEligibleForSend } from '@/lib/domain/templates/template-lifecycle.js';
import { normalizeCanonicalLanguage, normalizeCanonicalUseCase } from '@/lib/domain/templates/template-metadata-normalization.js';
import { CANONICAL_SELLER_INTENTS } from '@/lib/domain/acquisition/canonical-workflow-event.js';

const CONFIDENCE_THRESHOLDS = Object.freeze({
  default: 0.85,
  ownership_confirmed: 0.9,
  seller_interested: 0.85,
  who_is_this: 0.8,
});

const MANDATORY_REVIEW_INTENTS = new Set([
  'unclear',
  'hostile_or_legal',
  'needs_review',
  CANONICAL_SELLER_INTENTS.NEEDS_REVIEW,
  CANONICAL_SELLER_INTENTS.UNCLEAR,
  CANONICAL_SELLER_INTENTS.REPRESENTED,
  CANONICAL_SELLER_INTENTS.OPTED_OUT,
]);

const SUPPORTED_AUTO_REPLY_LANGUAGES = new Set(['English', 'Spanish', 'Russian']);

function clean(value) {
  return String(value ?? '').trim();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function requiresHumanReview(classification = {}, context = {}) {
  const primary = clean(classification.primary_intent).toLowerCase();
  const sellerIntent = clean(classification.seller_intent ?? context.seller_intent).toLowerCase();
  const confidence = asNumber(classification.confidence ?? context.classification_confidence, 0);
  const language = normalizeCanonicalLanguage(classification.language ?? context.language);

  if (MANDATORY_REVIEW_INTENTS.has(primary) || MANDATORY_REVIEW_INTENTS.has(sellerIntent)) {
    return { required: true, reason: 'mandatory_review_intent' };
  }
  if (primary === 'hostile_or_legal') return { required: true, reason: 'legal_threat' };
  if (classification.compliance_flag === 'opt_out') return { required: true, reason: 'opt_out' };
  if (classification.objection === 'probate') return { required: true, reason: 'probate_complexity' };
  if (classification.objection === 'already_listed' && confidence < 0.85) {
    return { required: true, reason: 'agent_representation_ambiguity' };
  }
  if (language && !SUPPORTED_AUTO_REPLY_LANGUAGES.has(language)) {
    return { required: true, reason: 'unsupported_language' };
  }
  if (confidence < 0.7) return { required: true, reason: 'low_confidence' };
  if (context.suppressed === true) return { required: true, reason: 'suppressed' };
  if (context.missing_template === true) return { required: true, reason: 'missing_compatible_template' };
  if (context.title_or_lien_issue === true) return { required: true, reason: 'title_or_lien_issue' };
  if (context.counteroffer_high_value === true) {
    return { required: true, reason: 'high_value_counteroffer' };
  }
  return { required: false, reason: null };
}

export function evaluateAutoReplyEligibility(input = {}) {
  const classification = input.classification ?? {};
  const template = input.template ?? {};
  const context = input.context ?? {};

  const review = requiresHumanReview(classification, context);
  if (review.required) {
    return { ok: false, action: 'human_review', reason: review.reason };
  }

  const primary = clean(classification.primary_intent).toLowerCase();
  const threshold = CONFIDENCE_THRESHOLDS[primary] ?? CONFIDENCE_THRESHOLDS.default;
  const confidence = asNumber(classification.confidence, 0);
  if (confidence < threshold) {
    return { ok: false, action: 'human_review', reason: 'confidence_below_threshold', threshold, confidence };
  }

  const language = normalizeCanonicalLanguage(classification.language ?? context.language);
  if (!language || !SUPPORTED_AUTO_REPLY_LANGUAGES.has(language)) {
    return { ok: false, action: 'human_review', reason: 'unsupported_or_missing_language' };
  }

  const useCase = normalizeCanonicalUseCase(input.use_case ?? template.use_case ?? context.template_use_case);
  if (!useCase) {
    return { ok: false, action: 'human_review', reason: 'missing_use_case' };
  }

  if (!template || !template.template_body) {
    return { ok: false, action: 'human_review', reason: 'missing_compatible_template' };
  }

  const lifecycle = isTemplateEligibleForSend(template, { autonomous: true });
  if (!lifecycle.ok) {
    return { ok: false, action: 'human_review', reason: lifecycle.reason };
  }

  const requiredVars = Array.isArray(template.variables) ? template.variables : [];
  const available = context.merge_variables ?? input.merge_variables ?? {};
  const missing = requiredVars.filter((key) => !clean(available[key]));
  if (missing.length) {
    return { ok: false, action: 'human_review', reason: 'missing_merge_variables', missing };
  }

  return {
    ok: true,
    action: 'queue_auto_reply',
    lifecycle_status: TEMPLATE_LIFECYCLE.APPROVED_AUTO_REPLY,
    use_case: useCase,
    language,
    confidence,
  };
}

export default {
  CONFIDENCE_THRESHOLDS,
  requiresHumanReview,
  evaluateAutoReplyEligibility,
};