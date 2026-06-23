// Logical outbound-action retry contract — classes A/B/C/D, max 3 attempts.

import crypto from 'node:crypto';
import { resolveTemplateFromPool } from '@/lib/domain/templates/template-runtime-resolver.js';
import { resolveCanonicalLanguage } from '@/lib/domain/templates/canonical-language-adapter.js';

export const RETRY_CONTRACT_VERSION = '1.0.0';
export const MAX_RETRY_ATTEMPTS = 3;

export const FAILURE_CLASS = Object.freeze({
  TRANSIENT: 'transient_transport', // A
  RATE_LIMIT: 'rate_limit', // B
  CONTENT: 'template_render_content', // C
  TERMINAL: 'terminal_compliance_destination', // D
});

const TERMINAL_ERROR_CODES = new Set([
  '21610',
  'opt_out',
  'suppression',
  'dnc',
  'blacklist',
  'invalid_destination',
  'unreachable_destination',
  'forbidden_destination',
  'permanent_provider_rejection',
]);

const TRANSIENT_PATTERNS = [
  /timeout/i,
  /connection.?reset/i,
  /econnreset/i,
  /5\d{2}/,
  /temporary/i,
  /service.?unavailable/i,
];

const CONTENT_PATTERNS = [
  /missing.?merge/i,
  /render/i,
  /content.?reject/i,
  /template/i,
  /variable/i,
];

function clean(value) {
  return String(value ?? '').trim();
}

function stableHash(parts = []) {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('|'), 'utf8')
    .digest('hex');
}

/**
 * Build stable logical action identity — attempt number does NOT change identity.
 */
export function buildLogicalActionId(input = {}) {
  const parts = [
    clean(input.workflow_execution_id ?? input.enrollment_id),
    clean(input.thread_key ?? input.contact_id ?? input.phone),
    clean(input.stage ?? input.current_stage),
    resolveCanonicalLanguage(input.language).canonical,
    clean(input.use_case ?? input.classification_use_case),
    clean(input.touch_number),
    clean(input.logical_action_sequence ?? input.action_sequence ?? '1'),
  ];
  return `logical:${stableHash(parts)}`;
}

export function buildIdempotencyKey(logicalActionId, attemptNumber = 1) {
  return `${logicalActionId}:attempt:${Math.min(MAX_RETRY_ATTEMPTS, Math.max(1, attemptNumber))}`;
}

export function classifyOutboundFailure(error = {}) {
  const code = clean(error.code ?? error.provider_code ?? error.error_code);
  const message = clean(error.message ?? error.reason ?? error.failed_reason);
  const combined = `${code} ${message}`.toLowerCase();

  if (TERMINAL_ERROR_CODES.has(code.toLowerCase()) || TERMINAL_ERROR_CODES.has(combined)) {
    return { class: FAILURE_CLASS.TERMINAL, reason: code || message || 'terminal_failure' };
  }
  if (code === '21610' || /21610/.test(message)) {
    return { class: FAILURE_CLASS.TERMINAL, reason: '21610_opt_out' };
  }
  if (/rate.?limit/i.test(combined) || code === 'rate_limit') {
    return { class: FAILURE_CLASS.RATE_LIMIT, reason: 'rate_limit' };
  }
  if (CONTENT_PATTERNS.some((p) => p.test(combined))) {
    return { class: FAILURE_CLASS.CONTENT, reason: code || message || 'content_failure' };
  }
  if (TRANSIENT_PATTERNS.some((p) => p.test(combined))) {
    return { class: FAILURE_CLASS.TRANSIENT, reason: code || message || 'transient_failure' };
  }
  return { class: FAILURE_CLASS.TRANSIENT, reason: code || message || 'unknown_transient' };
}

function backoffMs(attemptNumber, failureClass) {
  const base = failureClass === FAILURE_CLASS.RATE_LIMIT ? 60_000 : 15_000;
  return base * Math.pow(2, Math.max(0, attemptNumber - 1));
}

/**
 * Determine next retry action for a logical outbound action.
 */
export function planOutboundRetry(input = {}) {
  const attemptNumber = Math.max(1, Number(input.attempt_number) || 1);
  const logicalActionId = input.logical_action_id || buildLogicalActionId(input);
  const failure = classifyOutboundFailure(input.failure ?? input.error ?? {});

  if (failure.class === FAILURE_CLASS.TERMINAL) {
    return {
      ok: false,
      terminal: true,
      retry: false,
      rotate_template: false,
      logical_action_id: logicalActionId,
      failure_class: failure.class,
      reason: failure.reason,
      attempt_number: attemptNumber,
      contract_version: RETRY_CONTRACT_VERSION,
    };
  }

  if (attemptNumber >= MAX_RETRY_ATTEMPTS) {
    return {
      ok: false,
      terminal: true,
      exhausted: true,
      retry: false,
      logical_action_id: logicalActionId,
      failure_class: failure.class,
      reason: 'max_attempts_exhausted',
      attempt_number: attemptNumber,
      contract_version: RETRY_CONTRACT_VERSION,
    };
  }

  const nextAttempt = attemptNumber + 1;
  const rotateTemplate = failure.class === FAILURE_CLASS.CONTENT;
  const preserveTemplate =
    failure.class === FAILURE_CLASS.TRANSIENT || failure.class === FAILURE_CLASS.RATE_LIMIT;

  return {
    ok: true,
    retry: true,
    terminal: false,
    logical_action_id: logicalActionId,
    idempotency_key: buildIdempotencyKey(logicalActionId, nextAttempt),
    failure_class: failure.class,
    reason: failure.reason,
    attempt_number: attemptNumber,
    next_attempt_number: nextAttempt,
    rotate_template: rotateTemplate,
    preserve_template: preserveTemplate,
    preserve_stage: true,
    preserve_language: true,
    backoff_ms: backoffMs(nextAttempt, failure.class),
    rate_limit_consumes_attempt: failure.class !== FAILURE_CLASS.RATE_LIMIT,
    contract_version: RETRY_CONTRACT_VERSION,
  };
}

/**
 * Select template for content-failure rotation within same stage/language/use-case pool.
 */
export function selectRetryTemplate(input = {}, candidates = []) {
  const plan = planOutboundRetry(input);
  if (!plan.ok || plan.terminal) {
    return { ok: false, reason: plan.reason, plan };
  }

  const failedIds = [
    ...(input.failed_template_ids || []),
    input.template_id,
  ].filter(Boolean);

  if (plan.preserve_template && input.template_id) {
    const existing = candidates.find(
      (t) => clean(t.id ?? t.template_id) === clean(input.template_id),
    );
    if (existing) {
      return {
        ok: true,
        template: existing,
        template_id: clean(existing.id ?? existing.template_id),
        rotated: false,
        plan,
      };
    }
  }

  const resolved = resolveTemplateFromPool(
    {
      ...input,
      exclude_template_ids: failedIds,
      language: resolveCanonicalLanguage(input.language).canonical,
    },
    candidates,
  );

  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, plan, resolver: resolved };
  }

  return {
    ok: true,
    template: resolved.template,
    template_id: resolved.template_id,
    rotated: plan.rotate_template,
    candidate_pool_size: resolved.candidate_pool_size,
    excluded_candidates: resolved.excluded_candidates,
    plan,
  };
}

export default {
  RETRY_CONTRACT_VERSION,
  MAX_RETRY_ATTEMPTS,
  FAILURE_CLASS,
  buildLogicalActionId,
  buildIdempotencyKey,
  classifyOutboundFailure,
  planOutboundRetry,
  selectRetryTemplate,
};