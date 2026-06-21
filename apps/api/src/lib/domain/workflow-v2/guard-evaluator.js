// Workflow Studio V2 — guard node evaluator.
// Dispatches all guard.* node types against enrollment context.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { evaluateContactWindow } from '@/lib/supabase/sms-engine.js';
import { buildActionDedupeKey } from '@/lib/domain/workflow-v2/idempotency.js';
import { isGuardNode } from '@/lib/domain/workflow-v2/node-registry.js';

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function contextBool(ctx, ...keys) {
  for (const key of keys) {
    if (ctx[key] === true) return true;
    if (lower(ctx[key]) === 'true') return true;
    if (lower(ctx[key]) === 'yes') return true;
  }
  return false;
}

function guardResult(passed, reason) {
  return { passed, reason };
}

async function hasDuplicateRunStep(client, enrollmentId, nodeId, nodeType) {
  const { data, error } = await client
    .from('workflow_run_steps')
    .select('id, execution_result, workflow_run_id')
    .eq('node_id', nodeId || null)
    .eq('node_type', nodeType)
    .in('status', ['completed', 'blocked', 'triggered'])
    .limit(50);
  if (error) throw error;

  const rows = data ?? [];
  const matches = rows.filter((row) => {
    const ctx = row.execution_result?._context ?? row.execution_result?._context_used ?? {};
    const rowEnrollmentId = clean(ctx.enrollment_id ?? row.execution_result?.enrollment_id ?? '');
    if (enrollmentId && rowEnrollmentId) {
      return rowEnrollmentId === clean(enrollmentId);
    }
    return true;
  });
  return matches.length > 0;
}

async function evaluateSuppression(enrollment, deps) {
  const ctx = enrollment?.context ?? {};
  if (
    contextBool(ctx, 'is_suppressed', 'suppressed', 'opt_out', 'is_opt_out') ||
    lower(ctx.suppression_state) === 'suppressed'
  ) {
    return guardResult(false, 'contact_suppressed');
  }

  const masterOwnerId = clean(ctx.master_owner_id ?? '');
  if (!masterOwnerId) return guardResult(true, 'no_master_owner_to_check');

  try {
    const client = db(deps);
    const { count } = await client
      .from('message_events')
      .select('id', { count: 'exact', head: true })
      .eq('master_owner_id', masterOwnerId)
      .eq('is_opt_out', true)
      .limit(1);
    return (count ?? 0) === 0
      ? guardResult(true, 'not_suppressed')
      : guardResult(false, 'message_events_opt_out');
  } catch {
    return guardResult(true, 'suppression_check_degraded_pass');
  }
}

async function evaluateOptOut(enrollment) {
  const ctx = enrollment?.context ?? {};
  if (contextBool(ctx, 'is_opt_out', 'opt_out') || lower(ctx.contact_status) === 'opted_out') {
    return guardResult(false, 'opted_out');
  }
  return guardResult(true, 'not_opted_out');
}

async function evaluateWrongNumber(enrollment) {
  const ctx = enrollment?.context ?? {};
  if (contextBool(ctx, 'is_wrong_number', 'wrong_number') || lower(ctx.contact_status) === 'wrong_number') {
    return guardResult(false, 'wrong_number');
  }
  return guardResult(true, 'not_wrong_number');
}

async function evaluateDnc(enrollment) {
  const ctx = enrollment?.context ?? {};
  if (contextBool(ctx, 'is_dnc', 'dnc') || lower(ctx.suppression_state) === 'dnc') {
    return guardResult(false, 'dnc_blocked');
  }
  return guardResult(true, 'not_dnc');
}

async function evaluateDuplicateAction(node, enrollment, deps) {
  const client = db(deps);
  const actionType = clean(node.config?.action_type ?? node.node_type);
  const dedupeKey = buildActionDedupeKey(enrollment.id, node.id, actionType);
  const duplicate = await hasDuplicateRunStep(client, enrollment.id, node.id, node.node_type);
  if (duplicate) return guardResult(false, `duplicate_action:${dedupeKey}`);
  return guardResult(true, 'no_duplicate_action');
}

async function evaluateDuplicateMessage(node, enrollment, deps) {
  const client = db(deps);
  const messageKey = clean(
    node.config?.message_key ?? node.config?.template_id ?? node.config?.body_hash ?? node.node_key,
  );
  const dedupeKey = buildActionDedupeKey(enrollment.id, node.id, `message:${messageKey}`);
  const duplicate = await hasDuplicateRunStep(client, enrollment.id, node.id, node.node_type);
  if (duplicate) return guardResult(false, `duplicate_message:${dedupeKey}`);
  return guardResult(true, 'no_duplicate_message');
}

function evaluateContactWindowGuard(enrollment) {
  const ctx = enrollment?.context ?? {};
  const windowCheck = evaluateContactWindow({
    timezone: ctx.timezone ?? ctx.market_timezone ?? 'America/Chicago',
    contact_window: ctx.contact_window ?? null,
  });
  return windowCheck.allowed
    ? guardResult(true, 'inside_contact_window')
    : guardResult(false, windowCheck.reason ?? 'outside_contact_window');
}

function evaluateSenderAvailable(enrollment) {
  const ctx = enrollment?.context ?? {};
  const hasSender = Boolean(
    clean(ctx.from_phone_number ?? ctx.sender_phone ?? ctx.sender_id ?? ctx.from_email ?? ''),
  );
  return hasSender ? guardResult(true, 'sender_available') : guardResult(false, 'sender_unavailable');
}

function evaluateTemplateAvailable(node, enrollment) {
  const ctx = enrollment?.context ?? {};
  const templateId = clean(
    node.config?.template_id ?? ctx.template_id ?? ctx.selected_template_id ?? ctx.template_key ?? '',
  );
  const body = clean(node.config?.body ?? node.config?.template ?? ctx.message_body ?? '');
  return templateId || body
    ? guardResult(true, 'template_available')
    : guardResult(false, 'template_unavailable');
}

function evaluateLanguageCompatible(node, enrollment) {
  const ctx = enrollment?.context ?? {};
  const required = lower(node.config?.language ?? node.config?.required_language ?? '');
  const contactLanguage = lower(ctx.language ?? ctx.contact_language ?? 'en');
  if (!required || required === contactLanguage) {
    return guardResult(true, 'language_compatible');
  }
  return guardResult(false, `language_mismatch:${contactLanguage}_vs_${required}`);
}

function evaluateApprovalRequired(enrollment) {
  const ctx = enrollment?.context ?? {};
  const status = lower(ctx.human_approval_status ?? '');
  return status === 'approved'
    ? guardResult(true, 'human_approval_granted')
    : guardResult(false, 'human_approval_required');
}

function evaluateWorkflowKillSwitch() {
  const killSwitch = lower(process.env.WORKFLOW_KILL_SWITCH ?? '');
  return killSwitch === 'true'
    ? guardResult(false, 'workflow_kill_switch_enabled')
    : guardResult(true, 'workflow_kill_switch_off');
}

function evaluateMaxTouches(node, enrollment) {
  const ctx = enrollment?.context ?? {};
  const maxTouches = Number(node.config?.max_touches ?? node.config?.limit ?? 8);
  const priorTouches = Number(ctx.prior_touch_count ?? ctx.touch_count ?? 0);
  return priorTouches < maxTouches
    ? guardResult(true, 'under_max_touches')
    : guardResult(false, 'max_touches_exceeded');
}

export async function evaluateGuardNode(node, enrollment, definition, deps = {}) {
  const nodeType = clean(node?.node_type ?? '');
  if (!isGuardNode(nodeType) && !nodeType.startsWith('guard.')) {
    return guardResult(true, 'not_a_guard_node');
  }

  switch (nodeType) {
    case 'guard.suppression':
    case 'guard.stop_suppression':
      return evaluateSuppression(enrollment, deps);
    case 'guard.opt_out':
      return evaluateOptOut(enrollment);
    case 'guard.wrong_number':
      return evaluateWrongNumber(enrollment);
    case 'guard.dnc':
      return evaluateDnc(enrollment);
    case 'guard.duplicate_action':
      return evaluateDuplicateAction(node, enrollment, deps);
    case 'guard.duplicate_message':
      return evaluateDuplicateMessage(node, enrollment, deps);
    case 'guard.contact_window':
    case 'guard.quiet_hours':
      return evaluateContactWindowGuard(enrollment);
    case 'guard.sender_available':
      return evaluateSenderAvailable(enrollment);
    case 'guard.template_available':
      return evaluateTemplateAvailable(node, enrollment);
    case 'guard.language_compatible':
      return evaluateLanguageCompatible(node, enrollment);
    case 'guard.approval_required':
      return evaluateApprovalRequired(enrollment);
    case 'guard.workflow_kill_switch':
      return evaluateWorkflowKillSwitch();
    case 'guard.max_touches':
      return evaluateMaxTouches(node, enrollment);
    default:
      return guardResult(true, `unsupported_guard_pass_through:${nodeType}`);
  }
}