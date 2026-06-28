import crypto from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import {
  SELLER_AUTOMATION_WORKFLOW_ID,
  getSellerAutomationAction,
  listSellerAutomationRegistryResponse,
} from '@/lib/domain/seller-automation/seller-automation-action-registry.js';

const REDACT_KEYS = new Set([
  'password',
  'secret',
  'token',
  'api_key',
  'authorization',
  'credential',
  'provider_token',
]);

function clean(value) {
  return String(value ?? '').trim();
}

function db(client) {
  return client || getDefaultSupabaseClient();
}

function redactValue(key, value) {
  if (REDACT_KEYS.has(clean(key).toLowerCase())) return '[REDACTED]';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v);
    return out;
  }
  return value;
}

function redactPayload(payload = {}) {
  return redactValue('payload', payload);
}

function previewText(value, max = 280) {
  const text = clean(value);
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildExecutionStepPayload({
  executionId,
  actionKey,
  propertyId = null,
  participantId = null,
  threadId = null,
  sourceMessageId = null,
  lifecycleStage = null,
  executionStatus = 'running',
  startedAt = null,
  completedAt = null,
  durationMs = null,
  inputSummary = {},
  outputSummary = {},
  selectedTemplate = null,
  renderedResponsePreview = null,
  queueId = null,
  providerStatus = null,
  blockReason = null,
  retryCount = 0,
  errorDetails = null,
  nextAction = null,
  manual = false,
  operatorId = null,
} = {}) {
  const action = getSellerAutomationAction(actionKey);
  if (!action) return null;
  return {
    execution_id: executionId,
    workflow_id: SELLER_AUTOMATION_WORKFLOW_ID,
    action_key: actionKey,
    node_id: action.node_type,
    property_id: propertyId,
    participant_id: participantId,
    thread_id: threadId,
    source_message_id: sourceMessageId,
    lifecycle_stage: lifecycleStage || action.lifecycle_stage || null,
    execution_status: executionStatus,
    started_at: startedAt || new Date().toISOString(),
    completed_at: completedAt,
    duration_ms: durationMs,
    input_summary: redactPayload(inputSummary),
    output_summary: redactPayload(outputSummary),
    selected_template: selectedTemplate || action.template_key || null,
    rendered_response_preview: previewText(renderedResponsePreview),
    queue_id: queueId,
    provider_status: providerStatus,
    block_reason: blockReason,
    retry_count: retryCount,
    error_details: errorDetails ? redactPayload(errorDetails) : null,
    next_action: nextAction,
    manual: Boolean(manual),
    operator_id: operatorId,
  };
}

export async function startSellerAutomationExecution({
  supabaseClient = null,
  threadId,
  propertyId = null,
  participantId = null,
  sourceMessageId = null,
  lifecycleStage = null,
  metadata = {},
} = {}) {
  const supabase = db(supabaseClient);
  const row = {
    id: crypto.randomUUID(),
    workflow_id: SELLER_AUTOMATION_WORKFLOW_ID,
    thread_id: clean(threadId),
    property_id: clean(propertyId) || null,
    participant_id: clean(participantId) || null,
    source_message_id: clean(sourceMessageId) || null,
    lifecycle_stage: clean(lifecycleStage) || null,
    status: 'running',
    metadata: redactPayload(metadata),
  };
  const { data, error } = await supabase
    .from('seller_automation_executions')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function completeSellerAutomationExecution({
  supabaseClient = null,
  executionId,
  status = 'succeeded',
  durationMs = null,
} = {}) {
  const supabase = db(supabaseClient);
  const completedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('seller_automation_executions')
    .update({
      status,
      completed_at: completedAt,
      duration_ms: durationMs,
      updated_at: completedAt,
    })
    .eq('id', executionId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function recordSellerAutomationStep({
  supabaseClient = null,
  executionId,
  actionKey,
  executionStatus = 'succeeded',
  startedAt = null,
  completedAt = null,
  durationMs = null,
  propertyId = null,
  participantId = null,
  threadId = null,
  sourceMessageId = null,
  lifecycleStage = null,
  inputSummary = {},
  outputSummary = {},
  selectedTemplate = null,
  renderedResponsePreview = null,
  queueId = null,
  providerStatus = null,
  blockReason = null,
  retryCount = 0,
  errorDetails = null,
  nextAction = null,
  manual = false,
  operatorId = null,
} = {}) {
  const payload = buildExecutionStepPayload({
    executionId,
    actionKey,
    propertyId,
    participantId,
    threadId,
    sourceMessageId,
    lifecycleStage,
    executionStatus,
    startedAt,
    completedAt,
    durationMs,
    inputSummary,
    outputSummary,
    selectedTemplate,
    renderedResponsePreview,
    queueId,
    providerStatus,
    blockReason,
    retryCount,
    errorDetails,
    nextAction,
    manual,
    operatorId,
  });
  if (!payload) return null;
  const supabase = db(supabaseClient);
  const { data, error } = await supabase
    .from('seller_automation_execution_steps')
    .insert(payload)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function listSellerAutomationExecutions({
  supabaseClient = null,
  propertyId = null,
  participantId = null,
  threadId = null,
  stage = null,
  actionKey = null,
  status = null,
  executionId = null,
  automaticOnly = null,
  successOnly = null,
  from = null,
  to = null,
  limit = 50,
  offset = 0,
} = {}) {
  const supabase = db(supabaseClient);
  let query = supabase
    .from('seller_automation_executions')
    .select('*', { count: 'exact' })
    .order('started_at', { ascending: false })
    .range(offset, offset + Math.max(1, limit) - 1);

  if (executionId) query = query.eq('id', executionId);
  if (propertyId) query = query.eq('property_id', propertyId);
  if (participantId) query = query.eq('participant_id', participantId);
  if (threadId) query = query.eq('thread_id', threadId);
  if (stage) query = query.eq('lifecycle_stage', stage);
  if (status) query = query.eq('status', status);
  if (from) query = query.gte('started_at', from);
  if (to) query = query.lte('started_at', to);

  const { data, error, count } = await query;
  if (error) throw error;

  let executions = data || [];
  if (actionKey || automaticOnly != null || successOnly != null) {
    const stepQuery = supabase
      .from('seller_automation_execution_steps')
      .select('execution_id, action_key, execution_status, manual')
      .in('execution_id', executions.map((row) => row.id));
    if (actionKey) stepQuery.eq('action_key', actionKey);
    const { data: steps, error: stepError } = await stepQuery;
    if (stepError) throw stepError;
    const allowed = new Set();
    const grouped = new Map();
    for (const step of steps || []) {
      const list = grouped.get(step.execution_id) || [];
      list.push(step);
      grouped.set(step.execution_id, list);
    }
    for (const [id, list] of grouped.entries()) {
      if (actionKey && !list.some((s) => s.action_key === actionKey)) continue;
      if (automaticOnly === true && list.every((s) => s.manual)) continue;
      if (automaticOnly === false && list.every((s) => !s.manual)) continue;
      if (successOnly === true && list.some((s) => s.execution_status === 'failed')) continue;
      if (successOnly === false && !list.some((s) => s.execution_status === 'failed')) continue;
      allowed.add(id);
    }
    executions = executions.filter((row) => allowed.has(row.id));
  }

  return { executions, total: count ?? executions.length };
}

export async function getSellerAutomationExecutionDetail({
  supabaseClient = null,
  executionId,
} = {}) {
  const supabase = db(supabaseClient);
  const { data: execution, error } = await supabase
    .from('seller_automation_executions')
    .select('*')
    .eq('id', executionId)
    .maybeSingle();
  if (error) throw error;
  if (!execution) return null;

  const { data: steps, error: stepsError } = await supabase
    .from('seller_automation_execution_steps')
    .select('*')
    .eq('execution_id', executionId)
    .order('started_at', { ascending: true });
  if (stepsError) throw stepsError;

  const registry = listSellerAutomationRegistryResponse();
  return {
    execution,
    steps: steps || [],
    registry_nodes: registry.nodes,
    registry_edges: registry.edges,
  };
}

export async function getSellerAutomationLiveState({
  supabaseClient = null,
  propertyId = null,
  participantId = null,
  threadId = null,
  executionId = null,
  since = null,
} = {}) {
  const filters = {
    supabaseClient,
    propertyId,
    participantId,
    threadId,
    executionId,
    limit: 1,
  };
  const { executions } = await listSellerAutomationExecutions(filters);
  const active = executions[0] || null;
  if (!active) {
    return {
      workflow_id: SELLER_AUTOMATION_WORKFLOW_ID,
      execution: null,
      steps: [],
      node_states: {},
      updated_at: new Date().toISOString(),
    };
  }

  const supabase = db(supabaseClient);
  let stepQuery = supabase
    .from('seller_automation_execution_steps')
    .select('*')
    .eq('execution_id', active.id)
    .order('started_at', { ascending: true });
  if (since) stepQuery = stepQuery.gt('created_at', since);

  const { data: steps, error } = await stepQuery;
  if (error) throw error;

  const nodeStates = {};
  for (const step of steps || []) {
    nodeStates[step.node_id] = {
      action_key: step.action_key,
      node_id: step.node_id,
      status: step.execution_status,
      started_at: step.started_at,
      completed_at: step.completed_at,
      duration_ms: step.duration_ms,
      block_reason: step.block_reason,
      next_action: step.next_action,
    };
  }

  return {
    workflow_id: SELLER_AUTOMATION_WORKFLOW_ID,
    execution: active,
    steps: steps || [],
    node_states: nodeStates,
    updated_at: new Date().toISOString(),
  };
}

export async function applySellerAutomationManualControl({
  supabaseClient = null,
  executionId,
  control,
  operatorId = 'operator',
  payload = {},
} = {}) {
  const detail = await getSellerAutomationExecutionDetail({ supabaseClient, executionId });
  if (!detail?.execution) {
    return { ok: false, error: 'EXECUTION_NOT_FOUND' };
  }

  const execution = detail.execution;
  const controlKey = clean(control);
  const supported = new Set([
    'pause_automation',
    'resume_automation',
    'approve_needs_review',
    'retry_failed',
    'skip_optional',
    'run_next_eligible',
    'inspect_rendered_message',
  ]);
  if (!supported.has(controlKey)) {
    return { ok: false, error: 'UNSUPPORTED_CONTROL', supported: [...supported] };
  }

  let actionKey = 'lead_paused';
  let executionStatus = 'succeeded';
  let blockReason = null;
  let nextAction = null;
  let outputSummary = { control: controlKey, ...payload };

  switch (controlKey) {
    case 'pause_automation':
      actionKey = 'lead_paused';
      break;
    case 'resume_automation':
      actionKey = 'lead_resumed';
      break;
    case 'approve_needs_review':
      actionKey = 'needs_review_created';
      executionStatus = 'succeeded';
      nextAction = 'message_queued';
      break;
    case 'retry_failed':
      actionKey = 'retry_executed';
      executionStatus = 'retrying';
      break;
    case 'skip_optional':
      actionKey = 'automation_blocked';
      executionStatus = 'skipped';
      blockReason = 'operator_skipped';
      break;
    case 'run_next_eligible':
      actionKey = 'automatic_reply_selected';
      nextAction = 'template_rendered';
      break;
    case 'inspect_rendered_message':
      actionKey = 'template_rendered';
      executionStatus = 'waiting';
      break;
    default:
      break;
  }

  const step = await recordSellerAutomationStep({
    supabaseClient,
    executionId,
    actionKey,
    executionStatus,
    propertyId: execution.property_id,
    participantId: execution.participant_id,
    threadId: execution.thread_id,
    sourceMessageId: execution.source_message_id,
    lifecycleStage: execution.lifecycle_stage,
    inputSummary: { control: controlKey, operator_id: operatorId, ...payload },
    outputSummary,
    blockReason,
    nextAction,
    manual: true,
    operatorId,
  });

  await recordSellerAutomationAudit({
    supabaseClient,
    executionId,
    actionKey,
    controlKey,
    operatorId,
    payload,
    stepId: step?.id,
  });

  if (controlKey === 'retry_failed') {
    try {
      const { recoverUnprocessedInboundMessages } = await import(
        '@/lib/domain/seller-flow/recover-unprocessed-inbound-messages.js'
      );
      await recoverUnprocessedInboundMessages({
        supabaseClient,
        threadKey: execution.thread_id,
        limit: 1,
        dryRun: false,
      });
    } catch {
      // recovery is best-effort; audit step already recorded
    }
  }

  return { ok: true, step, control: controlKey };
}

async function recordSellerAutomationAudit({
  supabaseClient = null,
  executionId,
  actionKey,
  controlKey,
  operatorId,
  payload,
  stepId,
} = {}) {
  const supabase = db(supabaseClient);
  try {
    await supabase.from('automation_audit_log').insert({
      event_type: 'seller_automation_manual_control',
      action_type: actionKey,
      status: 'recorded',
      log_type: 'audit',
      message: `Manual control ${controlKey} by ${operatorId}`,
      conversation_thread_id: null,
      payload: redactPayload({
        execution_id: executionId,
        control: controlKey,
        operator_id: operatorId,
        step_id: stepId,
        ...payload,
      }),
    });
  } catch {
    // audit table optional in local dev
  }
}

export async function recordSellerInboundExecutionTimeline({
  supabaseClient = null,
  threadKey,
  propertyId = null,
  participantId = null,
  inboundEventId = null,
  decision = null,
  contract = null,
  execution = null,
  followUp = null,
  phases = [],
} = {}) {
  const executionRow = await startSellerAutomationExecution({
    supabaseClient,
    threadId: threadKey,
    propertyId,
    participantId,
    sourceMessageId: inboundEventId,
    lifecycleStage: decision?.stage_after || null,
    metadata: {
      execution_mode: decision?.execution_mode || null,
      block_reason: decision?.block_reason || null,
    },
  });

  const steps = [];
  const record = async (actionKey, extra = {}) => {
    const started = Date.now();
    const step = await recordSellerAutomationStep({
      supabaseClient,
      executionId: executionRow.id,
      actionKey,
      threadId: threadKey,
      propertyId,
      participantId,
      sourceMessageId: inboundEventId,
      lifecycleStage: decision?.stage_after || null,
      durationMs: extra.durationMs ?? Math.max(1, Date.now() - started),
      ...extra,
    });
    if (step) steps.push(step);
    return step;
  };

  await record('inbound_message_received', {
    executionStatus: 'succeeded',
    inputSummary: { thread_key: threadKey, inbound_event_id: inboundEventId },
  });
  if (propertyId) {
    await record('property_resolved', {
      executionStatus: 'succeeded',
      outputSummary: { property_id: propertyId },
    });
  }
  if (participantId) {
    await record('participant_resolved', {
      executionStatus: 'succeeded',
      outputSummary: { participant_id: participantId },
    });
  }
  await record('phone_thread_resolved', {
    executionStatus: 'succeeded',
    outputSummary: { conversation_thread_id: threadKey },
  });
  await record('message_classified', {
    executionStatus: 'succeeded',
    outputSummary: {
      normalized_intent: contract?.normalized_intent || null,
      ownership_signal: contract?.ownership_signal || null,
    },
    inputSummary: { message_preview: previewText(contract?.message_body) },
  });
  await record('facts_extracted', {
    executionStatus: 'succeeded',
    outputSummary: { extracted_facts: contract?.extracted_facts || {} },
  });

  if (contract?.ownership_signal === 'confirmed') {
    await record('ownership_confirmed', { executionStatus: 'succeeded' });
  } else if (contract?.ownership_signal === 'inferred') {
    await record('ownership_inferred', { executionStatus: 'succeeded' });
  } else if (contract?.ownership_signal === 'denied') {
    await record('ownership_denied', { executionStatus: 'blocked' });
  }

  if (contract?.interest_signal === 'interested') {
    await record('seller_interest_detected', { executionStatus: 'succeeded' });
  }
  if (contract?.normalized_intent === 'asking_price_provided') {
    await record('asking_price_extracted', { executionStatus: 'succeeded' });
  }
  if (contract?.normalized_intent === 'condition_disclosed') {
    await record('property_condition_extracted', { executionStatus: 'succeeded' });
  }

  await record('decision_intelligence_evaluated', {
    executionStatus: 'succeeded',
    outputSummary: {
      stage_before: decision?.stage_before,
      stage_after: decision?.stage_after,
      operational_status: decision?.operational_status,
    },
  });

  if (execution?.selected_template || decision?.template_key) {
    await record('automatic_reply_selected', {
      executionStatus: 'succeeded',
      selectedTemplate: decision?.template_key || execution?.selected_template?.use_case,
    });
    await record('template_rendered', {
      executionStatus: 'succeeded',
      renderedResponsePreview: decision?.rendered_message || execution?.rendered_message_text,
      selectedTemplate: decision?.template_key || execution?.selected_template?.use_case,
    });
  }

  const blocked = Boolean(execution?.automation_decision?.should_suppress_contact || decision?.block_reason);
  if (blocked) {
    await record('contactability_checked', {
      executionStatus: 'blocked',
      blockReason: execution?.automation_decision?.suppression_reason || decision?.block_reason,
    });
    await record('automation_blocked', {
      executionStatus: 'blocked',
      blockReason: execution?.automation_decision?.suppression_reason || decision?.block_reason,
    });
  } else {
    await record('contactability_checked', { executionStatus: 'succeeded' });
  }

  if (execution?.queued || execution?.queue_row_id || decision?.queue_row_id) {
    await record('duplicate_send_check', { executionStatus: 'succeeded' });
    await record('message_queued', {
      executionStatus: 'succeeded',
      queueId: execution?.queue_row_id || decision?.queue_row_id || null,
      outputSummary: { queued: true },
    });
  }

  if (execution?.queue_result?.ok === false) {
    await record('message_failed', {
      executionStatus: 'failed',
      errorDetails: execution?.queue_result || null,
      providerStatus: 'failed',
    });
  } else if (execution?.queued) {
    await record('message_sent', {
      executionStatus: 'succeeded',
      providerStatus: 'sent',
    });
  }

  if (followUp?.followup_created || followUp?.scheduled_for || decision?.follow_up_at) {
    await record('follow_up_scheduled', {
      executionStatus: 'succeeded',
      outputSummary: {
        follow_up_at: followUp?.scheduled_for || decision?.follow_up_at || null,
      },
    });
  }

  if (decision?.stage_before && decision?.stage_after && decision.stage_before !== decision.stage_after) {
    await record('stage_advanced', {
      executionStatus: 'succeeded',
      outputSummary: {
        stage_before: decision.stage_before,
        stage_after: decision.stage_after,
      },
    });
  }

  if (decision?.operational_status) {
    await record('operational_status_changed', {
      executionStatus: 'succeeded',
      outputSummary: { operational_status: decision.operational_status },
    });
  }
  if (decision?.temperature) {
    await record('temperature_changed', {
      executionStatus: 'succeeded',
      outputSummary: { temperature: decision.temperature },
    });
  }
  if (decision?.disposition) {
    await record('disposition_changed', {
      executionStatus: 'succeeded',
      outputSummary: { disposition: decision.disposition },
    });
  }
  if (decision?.contactability) {
    await record('contactability_changed', {
      executionStatus: 'succeeded',
      outputSummary: { contactability: decision.contactability },
    });
  }

  if (execution?.automation_decision?.should_mark_human_review || decision?.review_reason) {
    await record('needs_review_created', {
      executionStatus: 'needs_review',
      blockReason: decision?.review_reason || execution?.automation_decision?.human_review_reason,
    });
  }

  for (const phase of phases || []) {
    if (!phase?.action_key) continue;
    await record(phase.action_key, {
      executionStatus: phase.execution_status || 'succeeded',
      inputSummary: phase.input_summary || {},
      outputSummary: phase.output_summary || {},
    });
  }

  await record('notification_emitted', {
    executionStatus: 'succeeded',
    outputSummary: { events: (decision?.notification_events || []).map((e) => e.type) },
  });

  const completed = await completeSellerAutomationExecution({
    supabaseClient,
    executionId: executionRow.id,
    status: blocked ? 'blocked' : execution?.queue_result?.ok === false ? 'failed' : 'succeeded',
  });

  return { execution: completed, steps };
}

export default {
  startSellerAutomationExecution,
  completeSellerAutomationExecution,
  recordSellerAutomationStep,
  listSellerAutomationExecutions,
  getSellerAutomationExecutionDetail,
  getSellerAutomationLiveState,
  applySellerAutomationManualControl,
  recordSellerInboundExecutionTimeline,
};