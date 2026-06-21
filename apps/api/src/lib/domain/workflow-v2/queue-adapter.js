// Workflow Studio V2 — queue adapter.
// Creates canonical send_queue rows only. Never calls TextGrid directly.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import {
  buildSendQueueDedupeKey,
  insertSupabaseSendQueueRow,
} from '@/lib/supabase/sms-engine.js';
import { buildQueueDedupeKey } from '@/lib/domain/workflow-v2/idempotency.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function workflowMetadata({
  workflowDefinitionId,
  enrollmentId,
  nodeId,
  extra = {},
} = {}) {
  return {
    no_send: true,
    proof_no_send: true,
    confirm_live: false,
    sms_eligible: false,
    source: 'workflow_v2',
    workflow_definition_id: clean(workflowDefinitionId) || null,
    enrollment_id: clean(enrollmentId) || null,
    node_id: clean(nodeId) || null,
    ...extra,
  };
}

function resolveDedupeKey(input = {}) {
  const explicit = clean(input.dedupe_key ?? input.dedupeKey ?? '');
  if (explicit) return explicit;

  const workflowKey = buildQueueDedupeKey({
    enrollmentId: input.enrollment_id ?? input.enrollmentId,
    nodeId: input.node_id ?? input.nodeId,
    channel: input.channel ?? 'sms',
    templateUseCase: input.template_use_case ?? input.use_case_template ?? input.templateUseCase,
    touchNumber: input.touch_number ?? input.touchNumber ?? 0,
    masterOwnerId: input.master_owner_id ?? input.masterOwnerId,
    propertyId: input.property_id ?? input.propertyId,
    toAddress: input.to_phone_number ?? input.to_email ?? input.toAddress,
  });

  const canonicalKey = buildSendQueueDedupeKey({
    master_owner_id: input.master_owner_id ?? input.masterOwnerId,
    property_id: input.property_id ?? input.propertyId,
    to_phone_number: input.to_phone_number ?? input.toAddress,
    template_use_case: input.template_use_case ?? input.use_case_template ?? input.templateUseCase,
    touch_number: input.touch_number ?? input.touchNumber ?? 0,
    campaign_session_id: workflowKey,
  });

  return canonicalKey || workflowKey;
}

async function enqueueWorkflowMessage(input = {}, deps = {}) {
  const client = db(deps);
  const now = new Date().toISOString();
  const channel = clean(input.channel ?? 'sms').toLowerCase();
  const workflowDefinitionId = clean(
    input.workflow_definition_id ?? input.workflowDefinitionId ?? input.definition_id ?? '',
  );
  const enrollmentId = clean(input.enrollment_id ?? input.enrollmentId ?? '');
  const nodeId = clean(input.node_id ?? input.nodeId ?? '');
  const dedupeKey = resolveDedupeKey({ ...input, channel });

  const queueKey =
    clean(input.queue_key ?? input.queueKey ?? '') ||
    `wfv2:${channel}:${enrollmentId || 'no_enrollment'}:${nodeId || 'no_node'}:${Date.now()}`;

  const payload = {
    queue_key: queueKey,
    queue_id: queueKey,
    dedupe_key: dedupeKey,
    queue_status: clean(input.queue_status ?? 'queued'),
    scheduled_for: input.scheduled_for ?? now,
    scheduled_for_utc: input.scheduled_for_utc ?? input.scheduled_for ?? now,
    scheduled_for_local: input.scheduled_for_local ?? input.scheduled_for ?? now,
    master_owner_id: input.master_owner_id ?? input.masterOwnerId ?? null,
    property_id: input.property_id ?? input.propertyId ?? null,
    to_phone_number: channel === 'sms' ? input.to_phone_number ?? input.to ?? null : null,
    from_phone_number: channel === 'sms' ? input.from_phone_number ?? input.from ?? null : null,
    message_body: input.message_body ?? input.body ?? input.message_text ?? null,
    message_text: input.message_text ?? input.body ?? input.message_body ?? null,
    template_id: input.template_id ?? null,
    selected_template_id: input.selected_template_id ?? input.template_id ?? null,
    use_case_template: input.use_case_template ?? input.template_use_case ?? null,
    touch_number: input.touch_number ?? 0,
    type: channel === 'email' ? 'email' : 'outbound',
    message_type: channel === 'email' ? 'email' : input.message_type ?? 'workflow_v2',
    metadata: workflowMetadata({
      workflowDefinitionId,
      enrollmentId,
      nodeId,
      extra: {
        channel,
        to_email: channel === 'email' ? input.to_email ?? input.to ?? null : null,
        from_email: channel === 'email' ? input.from_email ?? input.from ?? null : null,
        subject: channel === 'email' ? input.subject ?? null : null,
        ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
      },
    }),
  };

  const result = await insertSupabaseSendQueueRow(payload, { supabase: client, ...deps });

  if (result?.reason === 'duplicate_blocked' || result?.duplicate === true) {
    return {
      ok: true,
      duplicate: true,
      queue_row_id: result.queue_row_id ?? result.item_id ?? null,
      live_send_blocked: true,
    };
  }

  if (!result?.ok) {
    return {
      ok: false,
      duplicate: false,
      queue_row_id: result?.queue_row_id ?? result?.item_id ?? null,
      live_send_blocked: true,
      error: result?.reason ?? result?.error ?? 'queue_insert_failed',
    };
  }

  return {
    ok: true,
    duplicate: false,
    queue_row_id: result.queue_row_id ?? result.item_id ?? null,
    live_send_blocked: true,
  };
}

export async function enqueueWorkflowSms(input = {}, deps = {}) {
  return enqueueWorkflowMessage({ ...input, channel: 'sms' }, deps);
}

export async function enqueueWorkflowEmail(input = {}, deps = {}) {
  return enqueueWorkflowMessage({ ...input, channel: 'email' }, deps);
}