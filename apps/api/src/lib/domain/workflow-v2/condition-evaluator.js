// Condition evaluator for Workflow Studio V2.
// Evaluates condition nodes against actual inbox / message_events data.
//
// Supports:
//   condition.seller_replied   → true if inbound message exists after enrolled_at
//   condition.no_reply_after   → true if duration has elapsed with no inbound reply
//
// Data sources (tried in order, first non-empty wins):
//   1. workflow_events table (V2 internal event queue)
//   2. message_events table (existing SMS engine events)
//
// Falls back to false with a warning if no data source can be queried.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

// ─────────────────────────────────────────────
// Data source: workflow_events (V2-native)
// ─────────────────────────────────────────────

async function hasWorkflowEventReply(subjectId, afterIso, client) {
  const { count, error } = await client
    .from('workflow_events')
    .select('id', { count: 'exact', head: true })
    .eq('subject_id', subjectId)
    .in('event_type', ['seller_replied', 'inbound_message', 'inbound_sms'])
    .gte('created_at', afterIso);
  if (error) return null;
  return (count ?? 0) > 0;
}

// ─────────────────────────────────────────────
// Data source: message_events (existing SMS engine)
// ─────────────────────────────────────────────

async function hasMessageEventReply(masterOwnerId, afterIso, client) {
  if (!masterOwnerId) return null;
  const { count, error } = await client
    .from('message_events')
    .select('id', { count: 'exact', head: true })
    .eq('master_owner_id', masterOwnerId)
    .eq('direction', 'inbound')
    .gte('created_at', afterIso);
  if (error) return null;
  return (count ?? 0) > 0;
}

// ─────────────────────────────────────────────
// Main evaluator
// ─────────────────────────────────────────────

/**
 * Evaluate a condition node. Returns { result: boolean, reason: string, data: {} }.
 *
 * enrollment must have: id, enrolled_at, context (which may contain master_owner_id, subject_id)
 */
export async function evaluateConditionNode(node, enrollment, deps = {}) {
  const client = db(deps);
  const nodeType = clean(node.node_type);
  const config = node.config && typeof node.config === 'object' ? node.config : {};
  const context = enrollment.context && typeof enrollment.context === 'object' ? enrollment.context : {};

  const masterOwnerId = clean(context.master_owner_id ?? '') || null;
  const subjectId = clean(context.subject_id ?? enrollment.subject_id ?? '') || null;
  const enrolledAt = enrollment.enrolled_at ? new Date(enrollment.enrolled_at).toISOString() : new Date(0).toISOString();

  if (nodeType === 'condition.seller_replied') {
    return evaluateSellerReplied({ masterOwnerId, subjectId, enrolledAt, client });
  }

  if (nodeType === 'condition.no_reply_after') {
    return evaluateNoReplyAfter({ masterOwnerId, subjectId, enrolledAt, config, client });
  }

  return {
    result: false,
    reason: `unsupported_condition_type:${nodeType}`,
    data: { node_type: nodeType, evaluated: false },
  };
}

async function evaluateSellerReplied({ masterOwnerId, subjectId, enrolledAt, client }) {
  let replied = null;

  // Try V2 workflow_events first
  if (subjectId) {
    replied = await hasWorkflowEventReply(subjectId, enrolledAt, client);
  }

  // Fall back to message_events
  if (replied === null && masterOwnerId) {
    replied = await hasMessageEventReply(masterOwnerId, enrolledAt, client);
  }

  if (replied === null) {
    return {
      result: false,
      reason: 'no_reply_data_source',
      data: { master_owner_id: masterOwnerId, subject_id: subjectId, fallback: true },
    };
  }

  return {
    result: replied,
    reason: replied ? 'inbound_message_found' : 'no_inbound_message',
    data: { master_owner_id: masterOwnerId, subject_id: subjectId },
  };
}

async function evaluateNoReplyAfter({ masterOwnerId, subjectId, enrolledAt, config, client }) {
  const amount = Number(config.amount ?? config.hours ?? config.days ?? config.minutes ?? 24);
  const unit = clean(config.unit ?? (config.hours ? 'hours' : config.days ? 'days' : 'hours'));

  const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  const ms = (UNIT_MS[unit] ?? 3_600_000) * Math.max(1, amount);
  const deadlineMs = new Date(enrolledAt).getTime() + ms;
  const durationElapsed = Date.now() >= deadlineMs;

  if (!durationElapsed) {
    return {
      result: false,
      reason: 'duration_not_yet_elapsed',
      data: { deadline: new Date(deadlineMs).toISOString() },
    };
  }

  // Duration elapsed — now check if there IS a reply (if so, condition is false)
  const repliedResult = await evaluateSellerReplied({ masterOwnerId, subjectId, enrolledAt, client });

  // no_reply_after is true when: duration elapsed AND seller did NOT reply
  const noReply = !repliedResult.result;
  return {
    result: noReply,
    reason: noReply ? 'duration_elapsed_no_reply' : 'duration_elapsed_reply_found',
    data: { deadline: new Date(deadlineMs).toISOString(), replied: repliedResult.result },
  };
}
