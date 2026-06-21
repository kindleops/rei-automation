// Action executor for Workflow Studio V2.
//
// Dispatches action.* nodes to their handlers.
// Communication actions enqueue via queue-adapter (never TextGrid) and always
// return live_send_blocked:true.
//
// All results include _context_used: the 12 canonical context fields visible at execution time.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { enqueueWorkflowSms, enqueueWorkflowEmail } from '@/lib/domain/workflow-v2/queue-adapter.js';
import {
  updateEnrollmentContext,
  enrollSubject,
} from '@/lib/domain/workflow-v2/enrollment-service.js';
import {
  extractConversationFacts,
  persistExtractedFacts,
} from '@/lib/domain/workflow-v2/conversation-intelligence.js';
import {
  getMissingFacts,
  buildUnderwritingQuestions,
} from '@/lib/domain/workflow-v2/underwriting-playbooks.js';
import { calculateOfferAskGap } from '@/lib/domain/workflow-v2/offer-gap-analysis.js';
import {
  scheduleFollowUp,
  cancelFollowUpsOnReply,
} from '@/lib/domain/workflow-v2/follow-up-service.js';
import { cancelPendingTasks } from '@/lib/domain/workflow-v2/scheduled-tasks.js';
import { runAcquisitionEngineForEnrollment } from '@/lib/domain/workflow-v2/acquisition-engine-bridge.js';

const CONTEXT_KEYS = [
  'master_owner_id',
  'thread_id',
  'conversation_id',
  'property_id',
  'campaign_id',
  'stage',
  'status',
  'phone',
  'email',
  'market',
  'state',
  'city',
];

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function hasSupabase(deps = {}) {
  return Boolean(deps.supabase ?? deps.supabaseClient);
}

function buildContextUsed(enrollment) {
  const ctx =
    enrollment?.context && typeof enrollment.context === 'object' ? enrollment.context : {};
  const out = {};
  for (const key of CONTEXT_KEYS) {
    out[key] = ctx[key] ?? null;
  }
  out.stage = ctx.stage ?? ctx.workflow_stage ?? null;
  out.status = ctx.status ?? ctx.workflow_status ?? null;
  return out;
}

function baseResult(node, status, enrollment) {
  return {
    node_id: node.id,
    node_key: node.node_key,
    node_kind: node.node_kind,
    node_type: node.node_type,
    status,
    dry_run: false,
    live_send_blocked: false,
    _context_used: buildContextUsed(enrollment),
  };
}

function commResult(node, enrollment, status, extra = {}) {
  return {
    ...baseResult(node, status, enrollment),
    live_send_blocked: true,
    ...extra,
  };
}

// ─────────────────────────────────────────────
// Communication actions (queue only, never TextGrid)
// ─────────────────────────────────────────────

async function executeEnqueueSms(node, enrollment, definition, deps) {
  const ctx = enrollment.context ?? {};
  const queueResult = hasSupabase(deps)
    ? await enqueueWorkflowSms(
        {
          enrollment_id: enrollment.id,
          node_id: node.id,
          workflow_definition_id: definition.id,
          master_owner_id: ctx.master_owner_id ?? null,
          property_id: ctx.property_id ?? null,
          to_phone_number: ctx.phone ?? ctx.to_phone ?? null,
          from_phone_number: ctx.from_phone_number ?? ctx.sender_phone ?? null,
          message_body: node.config?.body ?? node.config?.template ?? node.config?.message_body ?? null,
          template_use_case: node.config?.use_case ?? node.config?.template_use_case ?? null,
          touch_number: node.config?.touch_number ?? ctx.prior_touch_count ?? 0,
        },
        deps,
      )
    : { ok: false, skipped: true, reason: 'no_supabase_client' };

  return commResult(node, enrollment, 'completed', {
    action: { node_type: node.node_type, queue: queueResult },
  });
}

async function executeEnqueueEmail(node, enrollment, definition, deps) {
  const ctx = enrollment.context ?? {};
  const queueResult = hasSupabase(deps)
    ? await enqueueWorkflowEmail(
        {
          enrollment_id: enrollment.id,
          node_id: node.id,
          workflow_definition_id: definition.id,
          master_owner_id: ctx.master_owner_id ?? null,
          property_id: ctx.property_id ?? null,
          to_email: ctx.email ?? ctx.to_email ?? null,
          from_email: ctx.from_email ?? null,
          subject: node.config?.subject ?? null,
          message_body: node.config?.body ?? node.config?.template ?? null,
          template_use_case: node.config?.use_case ?? node.config?.template_use_case ?? null,
          touch_number: node.config?.touch_number ?? ctx.prior_touch_count ?? 0,
        },
        deps,
      )
    : { ok: false, skipped: true, reason: 'no_supabase_client' };

  return commResult(node, enrollment, 'completed', {
    action: { node_type: node.node_type, queue: queueResult },
  });
}

async function executeSendSms(node, enrollment, definition, deps) {
  let queueResult = null;
  if (hasSupabase(deps)) {
    try {
      queueResult = await executeEnqueueSms(node, enrollment, definition, deps);
    } catch {
      queueResult = null;
    }
  }

  return commResult(node, enrollment, 'blocked', {
    block_reason: 'workflow_v2_live_send_disabled',
    queue_result: queueResult?.action?.queue ?? queueResult ?? null,
  });
}

async function executeSendEmail(node, enrollment, definition, deps) {
  let queueResult = null;
  if (hasSupabase(deps)) {
    try {
      queueResult = await executeEnqueueEmail(node, enrollment, definition, deps);
    } catch {
      queueResult = null;
    }
  }

  return commResult(node, enrollment, 'blocked', {
    block_reason: 'workflow_v2_live_send_disabled',
    queue_result: queueResult?.action?.queue ?? queueResult ?? null,
  });
}

// ─────────────────────────────────────────────
// CRM / stage actions
// ─────────────────────────────────────────────

async function executeUpdateStage(node, enrollment, deps) {
  const client = db(deps);
  const targetStage = clean(node.config?.stage ?? node.config?.target_stage ?? node.config?.value ?? '');
  if (!targetStage) {
    return { ...baseResult(node, 'failed', enrollment), error: 'update_stage_missing_target' };
  }

  await updateEnrollmentContext(enrollment.id, { workflow_stage: targetStage, stage: targetStage }, deps);

  let crmUpdate = { attempted: false };
  const masterOwnerId = clean(enrollment.context?.master_owner_id ?? '');
  if (masterOwnerId && client?.from) {
    try {
      const { error } = await client
        .from('master_owners')
        .update({ seller_status: targetStage })
        .eq('id', masterOwnerId);
      crmUpdate = {
        attempted: true,
        table: 'master_owners',
        column: 'seller_status',
        error: error?.message ?? null,
      };
    } catch (err) {
      crmUpdate = { attempted: true, error: err?.message ?? 'crm_update_failed' };
    }
  }

  return {
    ...baseResult(node, 'completed', enrollment),
    action: {
      node_type: node.node_type,
      target_stage: targetStage,
      context_updated: true,
      crm_update: crmUpdate,
    },
  };
}

async function executeUpdateStatus(node, enrollment, deps) {
  const client = db(deps);
  const targetStatus = clean(
    node.config?.status ?? node.config?.target_status ?? node.config?.value ?? '',
  );
  if (!targetStatus) {
    return { ...baseResult(node, 'failed', enrollment), error: 'update_status_missing_target' };
  }

  await updateEnrollmentContext(
    enrollment.id,
    { workflow_status: targetStatus, status: targetStatus },
    deps,
  );

  let crmUpdate = { attempted: false };
  const masterOwnerId = clean(enrollment.context?.master_owner_id ?? '');
  if (masterOwnerId && client?.from) {
    try {
      const { error } = await client
        .from('master_owners')
        .update({ contact_status: targetStatus })
        .eq('id', masterOwnerId);
      crmUpdate = {
        attempted: true,
        table: 'master_owners',
        column: 'contact_status',
        error: error?.message ?? null,
      };
    } catch (err) {
      crmUpdate = { attempted: true, error: err?.message ?? 'crm_update_failed' };
    }
  }

  return {
    ...baseResult(node, 'completed', enrollment),
    action: {
      node_type: node.node_type,
      target_status: targetStatus,
      context_updated: true,
      crm_update: crmUpdate,
    },
  };
}

async function executeUpdateStructuredFact(node, enrollment, deps) {
  const factKey = clean(node.config?.fact_key ?? node.config?.key ?? '');
  const factValue = node.config?.value ?? node.config?.fact_value ?? null;
  const confidence = Number(node.config?.confidence ?? 0.8);

  if (!factKey) {
    return { ...baseResult(node, 'failed', enrollment), error: 'structured_fact_key_required' };
  }

  const patch = {
    extracted_facts: {
      ...(enrollment.context?.extracted_facts ?? {}),
      [factKey]: { value: factValue, confidence, provenance: 'workflow_action' },
    },
    [factKey]: factValue,
  };

  await updateEnrollmentContext(enrollment.id, patch, deps);

  if (hasSupabase(deps)) {
    await persistExtractedFacts(
      enrollment,
      [
        {
          fact_key: factKey,
          fact_value: { value: factValue },
          confidence,
          provenance: 'workflow_action',
        },
      ],
      deps,
    );
  }

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, fact_key: factKey, fact_value: factValue, confidence },
  };
}

// ─────────────────────────────────────────────
// Intelligence actions
// ─────────────────────────────────────────────

async function executeRunConversationExtraction(node, enrollment, deps) {
  const message = node.config?.message ?? enrollment.context?.last_inbound_message ?? {};
  const extraction = extractConversationFacts({ message, enrollment, deps });
  let persistence = { ok: true, saved: [], skipped: [] };

  if (hasSupabase(deps) && extraction.facts?.length) {
    persistence = await persistExtractedFacts(enrollment, extraction.facts, deps);
    const factPatch = {};
    for (const fact of extraction.facts) {
      factPatch[fact.fact_key] = fact.fact_value?.value ?? fact.value ?? null;
    }
    factPatch.extracted_facts = {
      ...(enrollment.context?.extracted_facts ?? {}),
      ...Object.fromEntries(
        extraction.facts.map((f) => [f.fact_key, { value: f.fact_value?.value, confidence: f.confidence }]),
      ),
    };
    await updateEnrollmentContext(enrollment.id, factPatch, deps);
  }

  return {
    ...baseResult(node, 'completed', enrollment),
    action: {
      node_type: node.node_type,
      facts_extracted: extraction.facts?.length ?? 0,
      extraction,
      persistence,
    },
  };
}

async function executeRunClassification(node, enrollment, deps) {
  const classifier = deps.classifier ?? deps.classify;
  const text =
    clean(node.config?.text ?? '') ||
    clean(enrollment.context?.last_inbound_message?.body ?? '') ||
    clean(enrollment.context?.last_message_body ?? '');

  let classification = enrollment.context?.classification ?? null;
  if (typeof classifier === 'function' && text) {
    try {
      classification = await classifier({ text, enrollment, message: { body: text } });
    } catch {
      classification = classification ?? { primary_intent: 'unknown', confidence: 0 };
    }
  } else {
    classification = classification ?? {
      primary_intent: lower(enrollment.context?.classification_intent ?? 'unknown'),
      confidence: Number(enrollment.context?.classification_confidence ?? 0),
      source: 'enrollment_context_stub',
    };
  }

  await updateEnrollmentContext(enrollment.id, { classification }, deps);

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, classification },
  };
}

async function executeRunAcquisitionEngine(node, enrollment, deps) {
  const mode = clean(node.config?.mode ?? enrollment.context?.acquisition_engine_mode ?? 'full');
  if (mode) {
    await updateEnrollmentContext(enrollment.id, { acquisition_engine_mode: mode }, deps);
  }

  const engineResult = await runAcquisitionEngineForEnrollment(enrollment, deps);
  const refreshed = await db(deps)
    .from('workflow_enrollments')
    .select('context')
    .eq('id', enrollment.id)
    .maybeSingle();
  const acquisitionOutput =
    refreshed.data?.context?.acquisition_engine_output ??
    refreshed.data?.context?.acquisition_output ??
    engineResult.acquisition_output ??
    null;

  return {
    ...baseResult(node, engineResult.ok ? 'completed' : 'failed', enrollment),
    action: {
      node_type: node.node_type,
      run_id: engineResult.run_id ?? null,
      input_hash: engineResult.input_hash ?? null,
      reused: engineResult.reused === true,
      mode,
      acquisition_output: acquisitionOutput,
      engine_error: engineResult.engine_error ?? null,
    },
  };
}

async function executeRunUnderwriting(node, enrollment, deps) {
  const ctx = enrollment.context ?? {};
  const assetClass = clean(node.config?.asset_class ?? ctx.asset_class ?? 'single_family');
  const missingFacts = getMissingFacts(assetClass, ctx);
  const questions = buildUnderwritingQuestions(assetClass, ctx);

  await updateEnrollmentContext(
    enrollment.id,
    {
      underwriting_questions: questions,
      missing_underwriting_facts: missingFacts,
      asset_class: assetClass,
    },
    deps,
  );

  return {
    ...baseResult(node, 'completed', enrollment),
    action: {
      node_type: node.node_type,
      asset_class: assetClass,
      missing_facts: missingFacts,
      questions,
    },
  };
}

async function executeCalculateOfferAskGap(node, enrollment, deps) {
  const ctx = enrollment.context ?? {};
  const gap = calculateOfferAskGap(ctx, ctx.acquisition_output ?? ctx.acquisition_engine_output ?? null);

  await updateEnrollmentContext(
    enrollment.id,
    {
      offer_ask_gap: gap,
      offer_to_ask_ratio: gap.cash_ratio ?? gap.novation_ratio ?? null,
    },
    deps,
  );

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, offer_ask_gap: gap },
  };
}

// ─────────────────────────────────────────────
// Timing / follow-up actions
// ─────────────────────────────────────────────

async function executeScheduleFollowUp(node, enrollment, definition, deps) {
  const ctx = enrollment.context ?? {};
  const result = await scheduleFollowUp(
    {
      enrollment_id: enrollment.id,
      workflow_definition_id: definition.id,
      node_id: node.id,
      context: ctx,
      category: node.config?.category,
      stage: node.config?.stage,
      touch_index: node.config?.touch_index ?? 0,
      reason: node.config?.reason,
    },
    deps,
  );

  return {
    ...baseResult(node, 'completed', enrollment),
    live_send_blocked: true,
    action: { node_type: node.node_type, follow_up: result },
  };
}

async function executeCancelPendingFollowUps(node, enrollment, deps) {
  const cancelledTasks = await cancelPendingTasks(
    enrollment.id,
    node.config?.task_types ?? ['follow_up', 'no_reply_follow_up'],
    deps,
  );
  const cancelledFollowUps = await cancelFollowUpsOnReply(enrollment.id, deps);

  return {
    ...baseResult(node, 'completed', enrollment),
    action: {
      node_type: node.node_type,
      cancelled_tasks: cancelledTasks,
      cancelled_follow_ups: cancelledFollowUps,
    },
  };
}

// ─────────────────────────────────────────────
// Approval / notification scaffolds
// ─────────────────────────────────────────────

async function executeRequestHumanApproval(node, enrollment, deps) {
  await updateEnrollmentContext(
    enrollment.id,
    {
      human_approval_status: 'pending',
      human_approval_requested_at: new Date().toISOString(),
      human_approval_reason: clean(node.config?.reason ?? node.config?.message ?? '') || null,
    },
    deps,
  );

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, human_approval_status: 'pending' },
  };
}

async function executeNotifyOperator(node, enrollment) {
  const payload = {
    type: 'operator_notification',
    enrollment_id: enrollment.id,
    subject_id: enrollment.subject_id,
    message: clean(node.config?.message ?? node.config?.body ?? 'Workflow requires operator attention'),
    severity: clean(node.config?.severity ?? 'info'),
    context_snapshot: buildContextUsed(enrollment),
  };

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, notification: payload, delivered: false, scaffolded: true },
  };
}

async function executeNotifyAgent(node, enrollment) {
  const payload = {
    type: 'agent_notification',
    enrollment_id: enrollment.id,
    subject_id: enrollment.subject_id,
    message: clean(node.config?.message ?? node.config?.body ?? 'Workflow task for assigned agent'),
    assignee: clean(node.config?.assignee ?? enrollment.context?.assigned_agent ?? '') || null,
    context_snapshot: buildContextUsed(enrollment),
  };

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, notification: payload, delivered: false, scaffolded: true },
  };
}

// ─────────────────────────────────────────────
// Contact flags / subworkflow / scaffolds
// ─────────────────────────────────────────────

async function executeMarkWrongNumber(node, enrollment, deps) {
  await updateEnrollmentContext(
    enrollment.id,
    {
      is_wrong_number: true,
      wrong_number: true,
      contact_status: 'wrong_number',
      workflow_status: 'wrong_number',
    },
    deps,
  );

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, is_wrong_number: true },
  };
}

async function executeSuppressContact(node, enrollment, deps) {
  await updateEnrollmentContext(
    enrollment.id,
    {
      is_suppressed: true,
      suppressed: true,
      suppression_state: 'suppressed',
      workflow_status: 'suppressed',
    },
    deps,
  );

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, suppression_state: 'suppressed' },
  };
}

async function resolveSubworkflowDefinitionId(node, deps) {
  const directId = clean(
    node.config?.definition_id ?? node.config?.workflow_definition_id ?? node.config?.subworkflow_id ?? '',
  );
  if (directId) return directId;

  const definitionKey = clean(
    node.config?.subworkflow_definition_key ?? node.config?.definition_key ?? node.config?.subworkflow_key ?? '',
  );
  if (!definitionKey) return '';

  const client = db(deps);
  if (!client?.from) return '';

  const lookup = await client
    .from('workflow_definitions')
    .select('id')
    .eq('definition_key', definitionKey)
    .maybeSingle();
  if (lookup.error) throw lookup.error;
  return clean(lookup.data?.id ?? '');
}

async function executeEnrollSubworkflow(node, enrollment, deps) {
  if (node.config?.blocked === true) {
    return {
      ...baseResult(node, 'blocked', enrollment),
      block_reason: clean(node.config?.blocked_reason ?? 'subworkflow_blocked'),
      action: {
        node_type: node.node_type,
        blocked: true,
        subworkflow_definition_key: clean(node.config?.subworkflow_definition_key ?? '') || null,
      },
    };
  }

  const definitionId = await resolveSubworkflowDefinitionId(node, deps);
  if (!definitionId) {
    return { ...baseResult(node, 'failed', enrollment), error: 'subworkflow_definition_id_required' };
  }

  const result = await enrollSubject(
    definitionId,
    {
      subject_type: enrollment.subject_type,
      subject_id: enrollment.subject_id,
      context: enrollment.context ?? {},
    },
    deps,
  );

  return {
    ...baseResult(node, result.ok ? 'completed' : 'failed', enrollment),
    action: {
      node_type: node.node_type,
      subworkflow_definition_id: definitionId,
      subworkflow_definition_key: clean(node.config?.subworkflow_definition_key ?? '') || null,
      subworkflow_enrollment: result,
    },
  };
}

function executeExitWorkflow(node, enrollment) {
  return {
    ...baseResult(node, 'exit', enrollment),
    action: { node_type: node.node_type, signal: 'exit_workflow' },
  };
}

async function executeSelectTemplate(node, enrollment, deps) {
  const templateId = clean(
    node.config?.template_id ?? node.config?.selected_template_id ?? node.config?.template_key ?? '',
  );
  const patch = {
    template_id: templateId || null,
    selected_template_id: templateId || null,
    template_key: clean(node.config?.template_key ?? '') || null,
  };
  await updateEnrollmentContext(enrollment.id, patch, deps);

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, ...patch, scaffolded: true },
  };
}

async function executeSelectSender(node, enrollment, deps) {
  const patch = {
    sender_id: clean(node.config?.sender_id ?? '') || null,
    from_phone_number: clean(node.config?.from_phone_number ?? node.config?.from ?? '') || null,
    from_email: clean(node.config?.from_email ?? '') || null,
  };
  await updateEnrollmentContext(enrollment.id, patch, deps);

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, ...patch, scaffolded: true },
  };
}

async function executeSelectNextContactMethod(node, enrollment, deps) {
  const ctx = enrollment.context ?? {};
  const method = lower(node.config?.method ?? node.config?.contact_method ?? 'sms');
  const attempted = new Set((Array.isArray(ctx.attempted_phones) ? ctx.attempted_phones : []).map(clean));
  if (ctx.phone) attempted.add(clean(ctx.phone));

  const alternates = Array.isArray(ctx.alternate_phones) ? ctx.alternate_phones : [];
  const nextPhone = alternates.map(clean).find((phone) => phone && !attempted.has(phone)) ?? null;

  const patch = {
    preferred_contact_method: method,
    next_contact_method: method,
    attempted_phones: [...attempted],
    selected_alternate_phone: nextPhone,
  };
  if (nextPhone) {
    patch.phone = nextPhone;
    patch.to_phone = nextPhone;
  }

  await updateEnrollmentContext(enrollment.id, patch, deps);

  return {
    ...baseResult(node, 'completed', enrollment),
    action: {
      node_type: node.node_type,
      next_contact_method: method,
      selected_alternate_phone: nextPhone,
      has_alternate_contact: Boolean(nextPhone),
    },
  };
}

async function executeCreateOrUpdateOpportunity(node, enrollment, deps) {
  const ctx = enrollment.context ?? {};
  const opportunity = {
    id: clean(node.config?.opportunity_id ?? ctx.opportunity_id ?? '') || null,
    stage: clean(node.config?.stage ?? ctx.stage ?? ctx.workflow_stage ?? '') || null,
    property_id: ctx.property_id ?? null,
    master_owner_id: ctx.master_owner_id ?? null,
    updated_at: new Date().toISOString(),
    source: 'workflow_v2_scaffold',
  };

  await updateEnrollmentContext(enrollment.id, { opportunity, opportunity_id: opportunity.id }, deps);

  return {
    ...baseResult(node, 'completed', enrollment),
    action: { node_type: node.node_type, opportunity, scaffolded: true },
  };
}

// ─────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────

export async function executeActionNode(node, enrollment, definition, deps = {}) {
  switch (node.node_type) {
    case 'action.enqueue_sms':
      return executeEnqueueSms(node, enrollment, definition, deps);
    case 'action.send_sms':
      return executeSendSms(node, enrollment, definition, deps);
    case 'action.enqueue_email':
      return executeEnqueueEmail(node, enrollment, definition, deps);
    case 'action.send_email':
      return executeSendEmail(node, enrollment, definition, deps);
    case 'action.update_stage':
      return executeUpdateStage(node, enrollment, deps);
    case 'action.update_status':
      return executeUpdateStatus(node, enrollment, deps);
    case 'action.update_structured_fact':
      return executeUpdateStructuredFact(node, enrollment, deps);
    case 'action.run_conversation_extraction':
      return executeRunConversationExtraction(node, enrollment, deps);
    case 'action.run_classification':
      return executeRunClassification(node, enrollment, deps);
    case 'action.run_acquisition_engine':
      return executeRunAcquisitionEngine(node, enrollment, deps);
    case 'action.run_underwriting':
      return executeRunUnderwriting(node, enrollment, deps);
    case 'action.calculate_offer_ask_gap':
      return executeCalculateOfferAskGap(node, enrollment, deps);
    case 'action.schedule_follow_up':
      return executeScheduleFollowUp(node, enrollment, definition, deps);
    case 'action.cancel_pending_follow_ups':
      return executeCancelPendingFollowUps(node, enrollment, deps);
    case 'action.request_human_approval':
      return executeRequestHumanApproval(node, enrollment, deps);
    case 'action.notify_operator':
      return executeNotifyOperator(node, enrollment);
    case 'action.notify_agent':
      return executeNotifyAgent(node, enrollment);
    case 'action.mark_wrong_number':
      return executeMarkWrongNumber(node, enrollment, deps);
    case 'action.suppress_contact':
      return executeSuppressContact(node, enrollment, deps);
    case 'action.enroll_subworkflow':
      return executeEnrollSubworkflow(node, enrollment, deps);
    case 'action.exit_workflow':
      return executeExitWorkflow(node, enrollment);
    case 'action.select_template':
      return executeSelectTemplate(node, enrollment, deps);
    case 'action.select_sender':
      return executeSelectSender(node, enrollment, deps);
    case 'action.select_next_contact_method':
      return executeSelectNextContactMethod(node, enrollment, deps);
    case 'action.create_or_update_opportunity':
      return executeCreateOrUpdateOpportunity(node, enrollment, deps);
    default:
      return {
        ...baseResult(node, 'scaffolded', enrollment),
        note: `action ${node.node_type} not yet implemented`,
      };
  }
}