// Workflow Studio V2 — delivery failure classification and retry scheduling.

import { scheduleTask } from '@/lib/domain/workflow-v2/scheduled-tasks.js';

export const MAX_RETRIES = 3;

const PERMANENT_FAILURE_PATTERNS = [
  'opt-out',
  'opt_out',
  'opted_out',
  'dnc',
  'wrong_number',
  'invalid',
  '21610',
  'blacklist',
  'suppression',
  'seller_replied',
];

const CONFIGURATION_FAILURE_PATTERNS = [
  'missing_to_phone',
  'missing_from_phone',
  'missing_message_body',
  'missing_thread_key',
  'paused_invalid_queue_row',
  'configuration',
  'template_unavailable',
  'sender_unavailable',
];

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function combinedFailureText(input = {}) {
  return lower(
    [
      input.failure_reason,
      input.error_message,
      input.failed_reason,
      input.error_status,
      input.error_code,
      input.reason,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function classifyDeliveryFailure(input = {}) {
  const text = combinedFailureText(input);
  const code = lower(input.error_code ?? input.code ?? '');

  if (code === '21610' || text.includes('21610')) {
    return { classification: 'permanent', reason: 'blacklist_rule_21610' };
  }

  for (const pattern of PERMANENT_FAILURE_PATTERNS) {
    if (text.includes(pattern)) {
      return { classification: 'permanent', reason: pattern };
    }
  }

  for (const pattern of CONFIGURATION_FAILURE_PATTERNS) {
    if (text.includes(pattern)) {
      return { classification: 'configuration', reason: pattern };
    }
  }

  return { classification: 'transient', reason: 'transient_delivery_failure' };
}

function retryDelayMinutes(retryCount) {
  if (retryCount <= 1) return 15;
  if (retryCount === 2) return 60;
  return 240;
}

export async function handleDeliveryFailure({ queueRow, enrollment, context, deps } = {}) {
  const failureReason = clean(
    context?.failure_reason ??
      queueRow?.failed_reason ??
      queueRow?.metadata?.failure_reason ??
      'delivery_failed',
  );
  const classification = classifyDeliveryFailure({
    failure_reason: failureReason,
    error_message: context?.error_message ?? queueRow?.metadata?.error_message,
    failed_reason: queueRow?.failed_reason,
    error_status: context?.error_status,
    error_code: context?.error_code ?? queueRow?.metadata?.error_code,
  });

  const currentRetryCount = asNumber(
    queueRow?.retry_count ?? queueRow?.metadata?.retry_count ?? context?.retry_count,
    0,
  );

  if (classification.classification === 'permanent') {
    return {
      ok: false,
      retry_scheduled: false,
      permanent: true,
      classification,
      retry_count: currentRetryCount,
      live_send_blocked: true,
    };
  }

  if (classification.classification === 'configuration') {
    return {
      ok: false,
      retry_scheduled: false,
      permanent: false,
      configuration_failure: true,
      classification,
      retry_count: currentRetryCount,
      retries_consumed: false,
      live_send_blocked: true,
    };
  }

  const nextRetryCount = currentRetryCount + 1;
  if (nextRetryCount > MAX_RETRIES) {
    return {
      ok: false,
      retry_scheduled: false,
      exhausted: true,
      classification,
      retry_count: currentRetryCount,
      live_send_blocked: true,
    };
  }

  const delayMinutes = retryDelayMinutes(nextRetryCount);
  const scheduledFor = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  const enrollmentId = clean(enrollment?.id ?? context?.enrollment_id ?? '');
  const definitionId = clean(
    context?.workflow_definition_id ?? enrollment?.workflow_definition_id ?? '',
  );

  const task = await scheduleTask(
    {
      workflow_definition_id: definitionId || null,
      enrollment_id: enrollmentId || null,
      task_type: 'delivery_retry',
      scheduled_for: scheduledFor,
      reason: classification.reason,
      dedupe_key: `wfv2-delivery-retry:${queueRow?.id ?? 'no_queue'}:${nextRetryCount}`,
      payload: {
        queue_row_id: queueRow?.id ?? null,
        retry_count: nextRetryCount,
        failure_reason: failureReason,
        classification,
      },
    },
    deps,
  );

  return {
    ok: true,
    retry_scheduled: true,
    classification,
    retry_count: nextRetryCount,
    scheduled_for: scheduledFor,
    task,
    live_send_blocked: true,
  };
}