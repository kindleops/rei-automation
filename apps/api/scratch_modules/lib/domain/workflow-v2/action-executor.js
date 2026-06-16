// Action executor for Workflow Studio V2.
//
// Dispatches action.* nodes to their handlers.
//
// action.send_sms      → placeholder adapter only (never sends)
// action.update_stage  → updates enrollment context + attempts master_owners.seller_status
// action.update_status → updates enrollment context + attempts master_owners.contact_status
//
// All results include _context_used: the 12 canonical context fields visible at execution
// time. This provides a per-step audit trail from the DB without needing a separate lookup.
//
// live_send_enabled is always false in Phase 2; communication actions are blocked.

import { getDefaultSupabaseClient } from '../lib/supabase/default-client.js';
import { sendSmsPlaceholder } from '../lib/domain/workflow-v2/sms-adapter.js';
import { updateEnrollmentContext } from '../lib/domain/workflow-v2/enrollment-service.js';

// Canonical set of context keys that must survive every hop.
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

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

// Build a snapshot of all canonical context fields as they existed when the action ran.
// stage/status have fallback keys written by prior action nodes.
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

// ─────────────────────────────────────────────
// action.send_sms
// ─────────────────────────────────────────────

async function executeSendSms(node, enrollment, definition) {
  if (definition.live_send_enabled !== true) {
    const adapterResult = await sendSmsPlaceholder({
      to: enrollment.context?.phone ?? enrollment.context?.to_phone ?? null,
      body: node.config?.body ?? node.config?.template ?? null,
      workflow_definition_id: definition.id,
      node_id: node.id,
      enrollment_id: enrollment.id,
    });
    return {
      ...baseResult(node, 'blocked', enrollment),
      live_send_blocked: true,
      block_reason: 'workflow_v2_live_send_disabled',
      adapter_result: adapterResult,
    };
  }

  return {
    ...baseResult(node, 'blocked', enrollment),
    live_send_blocked: true,
    block_reason: 'live_execution_not_yet_implemented',
  };
}

// ─────────────────────────────────────────────
// action.update_stage
// ─────────────────────────────────────────────

async function executeUpdateStage(node, enrollment, deps) {
  const client = db(deps);
  const targetStage = clean(node.config?.stage ?? node.config?.target_stage ?? node.config?.value ?? '');
  if (!targetStage) {
    return { ...baseResult(node, 'failed', enrollment), error: 'update_stage_missing_target' };
  }

  await updateEnrollmentContext(enrollment.id, { workflow_stage: targetStage }, deps);

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

// ─────────────────────────────────────────────
// action.update_status
// ─────────────────────────────────────────────

async function executeUpdateStatus(node, enrollment, deps) {
  const client = db(deps);
  const targetStatus = clean(
    node.config?.status ?? node.config?.target_status ?? node.config?.value ?? '',
  );
  if (!targetStatus) {
    return { ...baseResult(node, 'failed', enrollment), error: 'update_status_missing_target' };
  }

  await updateEnrollmentContext(enrollment.id, { workflow_status: targetStatus }, deps);

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

// ─────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────

export async function executeActionNode(node, enrollment, definition, deps = {}) {
  switch (node.node_type) {
    case 'action.send_sms':
      return executeSendSms(node, enrollment, definition, deps);
    case 'action.update_stage':
      return executeUpdateStage(node, enrollment, deps);
    case 'action.update_status':
      return executeUpdateStatus(node, enrollment, deps);
    default:
      return {
        ...baseResult(node, 'scaffolded', enrollment),
        note: `action ${node.node_type} not yet implemented`,
      };
  }
}
