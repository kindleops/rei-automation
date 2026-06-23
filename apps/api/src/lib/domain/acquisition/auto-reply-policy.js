// Automated reply eligibility — enabled templates + clarification path for low confidence.

import { TEMPLATE_LIFECYCLE, isTemplateEligibleForSend } from '@/lib/domain/templates/template-lifecycle.js';
import {
  normalizeCanonicalUseCase,
  CANONICAL_USE_CASES,
} from '@/lib/domain/templates/template-metadata-normalization.js';
import { resolveCanonicalLanguage } from '@/lib/domain/templates/canonical-language-adapter.js';
import { CANONICAL_SELLER_INTENTS } from '@/lib/domain/acquisition/canonical-workflow-event.js';

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  default: 0.85,
  ownership_confirmed: 0.9,
  seller_interested: 0.85,
  who_is_this: 0.8,
});

/** Intents that require deterministic exception handling — not ordinary automation */
const EXCEPTION_INTENTS = new Set([
  'hostile_or_legal',
  CANONICAL_SELLER_INTENTS.OPTED_OUT,
]);

/** Clarification use cases by stage */
const CLARIFICATION_USE_CASE_BY_STAGE = Object.freeze({
  S1: CANONICAL_USE_CASES.WHO_IS_THIS,
  S2: CANONICAL_USE_CASES.CONSIDER_SELLING,
  S3: CANONICAL_USE_CASES.SELLER_ASKING_PRICE,
  S4: 'property_condition_clarification',
  S5: 'offer_clarification',
  S6: 'closing_clarification',
});

export const DEFAULT_MAX_CLARIFICATION_ATTEMPTS = 2;

function clean(value) {
  return String(value ?? '').trim();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function upperStage(value) {
  const raw = clean(value).toUpperCase();
  return /^S[1-6]$/.test(raw) ? raw : null;
}

/**
 * Deterministic exception state — only for non-automatable system failures
 * or specially configured exceptional cases. Not the normal operating path.
 */
export function requiresOperatorException(classification = {}, context = {}) {
  const primary = clean(classification.primary_intent).toLowerCase();
  const sellerIntent = clean(classification.seller_intent ?? context.seller_intent).toLowerCase();

  if (EXCEPTION_INTENTS.has(primary) || EXCEPTION_INTENTS.has(sellerIntent)) {
    return { required: true, reason: 'exception_intent', action: 'operator_exception' };
  }
  if (primary === 'hostile_or_legal') return { required: true, reason: 'legal_threat', action: 'operator_exception' };
  if (classification.compliance_flag === 'opt_out') {
    return { required: true, reason: 'opt_out', action: 'terminal_suppression' };
  }
  if (context.suppressed === true) return { required: true, reason: 'suppressed', action: 'terminal_suppression' };
  if (context.system_failure === true) {
    return { required: true, reason: 'system_failure', action: 'operator_exception' };
  }
  if (context.operator_exception === true) {
    return { required: true, reason: context.operator_exception_reason || 'configured_exception', action: 'operator_exception' };
  }
  return { required: false, reason: null, action: null };
}

/** @deprecated Use requiresOperatorException */
export function requiresHumanReview(classification = {}, context = {}) {
  const ex = requiresOperatorException(classification, context);
  return { required: ex.required, reason: ex.reason };
}

export function resolveClarificationUseCase(stage, language) {
  void language;
  const stageCode = upperStage(stage) || 'S1';
  return CLARIFICATION_USE_CASE_BY_STAGE[stageCode] || CANONICAL_USE_CASES.WHO_IS_THIS;
}

export function evaluateClarificationPath(classification = {}, context = {}) {
  const exception = requiresOperatorException(classification, context);
  if (exception.required) {
    return {
      ok: false,
      action: exception.action,
      reason: exception.reason,
    };
  }

  const primary = clean(classification.primary_intent).toLowerCase();
  const threshold = CONFIDENCE_THRESHOLDS[primary] ?? CONFIDENCE_THRESHOLDS.default;
  const confidence = asNumber(classification.confidence ?? context.classification_confidence, 0);
  const stage = upperStage(context.current_stage ?? context.stage) || 'S1';
  const language = resolveCanonicalLanguage(classification.language ?? context.language);
  const priorAttempts = asNumber(context.clarification_attempt_count, 0);
  const maxAttempts = asNumber(context.max_clarification_attempts, DEFAULT_MAX_CLARIFICATION_ATTEMPTS);

  const isLowConfidence =
    primary === 'unclear' ||
    classification.seller_intent === CANONICAL_SELLER_INTENTS.UNCLEAR ||
    confidence < threshold ||
    confidence < 0.7;

  if (!isLowConfidence) {
    return { ok: false, action: 'continue_normal', reason: 'confidence_sufficient' };
  }

  if (priorAttempts >= maxAttempts) {
    return {
      ok: false,
      action: 'clarification_exhausted',
      reason: 'clarification_attempts_exhausted',
      stage,
      language: language.canonical,
      attempts: priorAttempts,
    };
  }

  const use_case = resolveClarificationUseCase(stage, language.canonical);
  return {
    ok: true,
    action: 'queue_clarification',
    reason: 'low_confidence_clarification',
    use_case,
    stage,
    language: language.canonical,
    clarification_attempt: priorAttempts + 1,
    max_clarification_attempts: maxAttempts,
    confidence,
    threshold,
  };
}

export function evaluateAutoReplyEligibility(input = {}) {
  const classification = input.classification ?? {};
  const template = input.template ?? {};
  const context = input.context ?? {};

  const exception = requiresOperatorException(classification, context);
  if (exception.required) {
    return { ok: false, action: exception.action, reason: exception.reason };
  }

  const clarification = evaluateClarificationPath(classification, context);
  if (clarification.ok && clarification.action === 'queue_clarification') {
    return {
      ok: true,
      action: 'queue_clarification',
      reason: clarification.reason,
      use_case: clarification.use_case,
      language: clarification.language,
      stage: clarification.stage,
      clarification_attempt: clarification.clarification_attempt,
    };
  }
  if (clarification.action === 'clarification_exhausted') {
    return {
      ok: false,
      action: 'automated_fallback',
      reason: clarification.reason,
      stage: clarification.stage,
      language: clarification.language,
    };
  }

  const primary = clean(classification.primary_intent).toLowerCase();
  const threshold = CONFIDENCE_THRESHOLDS[primary] ?? CONFIDENCE_THRESHOLDS.default;
  const confidence = asNumber(classification.confidence, 0);
  if (confidence < threshold) {
    return evaluateClarificationPath(classification, context).ok
      ? {
          ok: true,
          action: 'queue_clarification',
          reason: 'confidence_below_threshold',
          confidence,
          threshold,
        }
      : { ok: false, action: 'automated_fallback', reason: 'confidence_below_threshold', confidence, threshold };
  }

  const language = resolveCanonicalLanguage(classification.language ?? context.language);
  if (!language.canonical || language.malformed) {
    return { ok: false, action: 'automated_fallback', reason: 'missing_or_malformed_language' };
  }

  const useCase = normalizeCanonicalUseCase(input.use_case ?? template.use_case ?? context.template_use_case);
  if (!useCase) {
    return { ok: false, action: 'automated_fallback', reason: 'missing_use_case' };
  }

  if (!template || !template.template_body) {
    return { ok: false, action: 'automated_fallback', reason: 'missing_compatible_template' };
  }

  const lifecycle = isTemplateEligibleForSend(template);
  if (!lifecycle.ok) {
    return { ok: false, action: 'automated_fallback', reason: lifecycle.reason };
  }

  const requiredVars = Array.isArray(template.variables) ? template.variables : [];
  const available = context.merge_variables ?? input.merge_variables ?? {};
  const missing = requiredVars.filter((key) => !clean(available[key]));
  if (missing.length) {
    return { ok: false, action: 'automated_fallback', reason: 'missing_merge_variables', missing };
  }

  return {
    ok: true,
    action: 'queue_auto_reply',
    lifecycle_status: TEMPLATE_LIFECYCLE.ENABLED,
    use_case: useCase,
    language: language.canonical,
    confidence,
  };
}

export default {
  CONFIDENCE_THRESHOLDS,
  DEFAULT_MAX_CLARIFICATION_ATTEMPTS,
  requiresOperatorException,
  requiresHumanReview,
  resolveClarificationUseCase,
  evaluateClarificationPath,
  evaluateAutoReplyEligibility,
};