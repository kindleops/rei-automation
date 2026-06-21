// Workflow Studio V2 — Stateful Runner.
//
// runEnrollment(enrollmentId, deps):
//   Loads enrollment + graph. Walks nodes one-by-one, persisting state at each step.
//   Stops when:
//     - timing node reached (enrollment paused, next_execution_at set)
//     - terminal node reached (enrollment completed)
//     - no outgoing edges (enrollment completed)
//     - guard blocks execution (enrollment terminated)
//     - action.exit_workflow signal received
//     - MAX_STEPS_PER_TICK safety limit hit
//
// processReadyEnrollments(opts, deps):
//   Finds all active/due-waiting enrollments and runs each one.
//   Used by POST /api/workflows/process.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import {
  advanceEnrollment,
  pauseEnrollmentForWait,
  completeEnrollment,
  terminateEnrollment,
  findReadyEnrollments,
} from '@/lib/domain/workflow-v2/enrollment-service.js';
import { resolveNextNodeByEdge } from '@/lib/domain/workflow-v2/graph-service.js';
import { calculateNextExecutionAt, describeWait } from '@/lib/domain/workflow-v2/timing-service.js';
import { evaluateConditionNode } from '@/lib/domain/workflow-v2/condition-evaluator.js';
import { executeActionNode } from '@/lib/domain/workflow-v2/action-executor.js';
import { evaluateGuardNode } from '@/lib/domain/workflow-v2/guard-evaluator.js';
import { persistRunEvent } from '@/lib/domain/workflow-v2/run-events.js';
import { buildRunDedupeKey, isDuplicateError } from '@/lib/domain/workflow-v2/idempotency.js';
import { cancelFollowUpsOnReply } from '@/lib/domain/workflow-v2/follow-up-service.js';
import { isGuardNode, isTriggerNode } from '@/lib/domain/workflow-v2/node-registry.js';

const MAX_STEPS_PER_TICK = 50;

const SELLER_REPLY_EVENT_TYPES = new Set([
  'seller_replied',
  'inbound_message_received',
  'inbound_sms',
  'inbound_sms_received',
]);

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function isSellerReplyContext(context = {}) {
  if (!context || typeof context !== 'object') return false;
  if (context.seller_replied === true) return true;
  const eventType = clean(context.event_type ?? context.trigger_event ?? context.last_event_type ?? '');
  return SELLER_REPLY_EVENT_TYPES.has(eventType);
}

// ─────────────────────────────────────────────
// Graph loading helpers
// ─────────────────────────────────────────────

async function loadEnrollmentFull(enrollmentId, client) {
  const { data, error } = await client
    .from('workflow_enrollments')
    .select('*')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function loadDefinition(definitionId, client) {
  const { data, error } = await client
    .from('workflow_definitions')
    .select('*')
    .eq('id', definitionId)
    .maybeSingle();
  if (error) throw error;
  return data ? { ...data, live_send_enabled: false } : null;
}

async function loadGraph(definitionId, client) {
  const [nodesRes, edgesRes] = await Promise.all([
    client.from('workflow_nodes').select('*').eq('workflow_definition_id', definitionId).eq('is_active', true),
    client.from('workflow_edges').select('*').eq('workflow_definition_id', definitionId),
  ]);
  if (nodesRes.error) throw nodesRes.error;
  if (edgesRes.error) throw edgesRes.error;
  return {
    nodes: nodesRes.data ?? [],
    edges: edgesRes.data ?? [],
  };
}

// ─────────────────────────────────────────────
// Run record helpers
// ─────────────────────────────────────────────

async function createRunRecord(client, definition, enrollment, currentNode = null) {
  const tick = clean(currentNode?.id ?? enrollment.current_node_id ?? 'entry');
  const dedupeKey = buildRunDedupeKey(enrollment.id, tick, enrollment.updated_at ?? enrollment.enrolled_at ?? '0');

  const row = {
    workflow_definition_id: definition.id,
    enrollment_id: enrollment.id,
    prospect_id: clean(enrollment.subject_id ?? '') || null,
    status: 'running',
    dry_run: false,
    live_send_enabled: false,
    context: enrollment.context ?? {},
    dedupe_key: dedupeKey,
    started_at: new Date().toISOString(),
  };

  const insert = await client.from('workflow_runs').insert(row).select('*').single();
  if (isDuplicateError(insert.error)) {
    const existing = await client.from('workflow_runs').select('*').eq('dedupe_key', dedupeKey).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return existing.data;
  }
  if (insert.error) throw insert.error;
  return insert.data;
}

async function finalizeRunRecord(client, runId, status) {
  await client
    .from('workflow_runs')
    .update({ status, completed_at: new Date().toISOString() })
    .eq('id', runId);
}

async function persistRunStep(client, run, definition, node, stepResult, enrollment) {
  const row = {
    workflow_run_id: run.id,
    workflow_definition_id: definition.id,
    node_id: node.id ?? null,
    node_key: node.node_key,
    node_kind: node.node_kind,
    node_type: node.node_type,
    status: stepResult.status ?? 'completed',
    dry_run: false,
    live_send_blocked: stepResult.live_send_blocked === true,
    block_reason: stepResult.block_reason ?? null,
    execution_result: { ...stepResult, _context: enrollment?.context ?? {} },
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };
  const { error } = await client.from('workflow_run_steps').insert(row);
  if (error) throw error;
}

async function recordStepEvent(client, run, definition, enrollment, node, stepResult) {
  try {
    await persistRunEvent(client, {
      run_id: run.id,
      enrollment_id: enrollment.id,
      definition_id: definition.id,
      workflow_id: definition.id,
      node,
      stepResult,
      event_type: `workflow_v2.step.${stepResult.status ?? 'completed'}`,
    });
  } catch {
    // Run ledger is best-effort; step persistence remains authoritative.
  }
}

// ─────────────────────────────────────────────
// Node execution (single step)
// ─────────────────────────────────────────────

async function executeNode(node, enrollment, definition, client, deps) {
  const base = {
    node_id: node.id,
    node_key: node.node_key,
    node_kind: node.node_kind,
    node_type: node.node_type,
    live_send_blocked: false,
  };

  if (isTriggerNode(node.node_type)) {
    return { ...base, status: 'triggered' };
  }

  if (node.node_kind === 'timing') {
    const nextAt = calculateNextExecutionAt(node.config ?? {}, new Date(), node.node_type, enrollment);
    const waitDesc = describeWait(node.config ?? {}, node.node_type, enrollment);
    return {
      ...base,
      status: 'waiting',
      wait: { until: nextAt.toISOString(), description: waitDesc },
      _pause_until: nextAt,
    };
  }

  if (isGuardNode(node.node_type)) {
    const guardEval = await evaluateGuardNode(node, enrollment, definition, { supabase: client, ...deps });
    const passed = guardEval.passed === true;
    return {
      ...base,
      status: passed ? 'completed' : 'blocked',
      guard: { node_type: node.node_type, passed, reason: guardEval.reason },
      live_send_blocked: false,
      block_reason: passed ? null : `guard_blocked:${node.node_type}`,
    };
  }

  if (node.node_kind === 'condition') {
    const evaluation = await evaluateConditionNode(node, enrollment, { supabase: client, ...deps });
    return {
      ...base,
      status: 'completed',
      condition: { node_type: node.node_type, ...evaluation },
      _condition_result: evaluation.result,
    };
  }

  if (node.node_kind === 'action') {
    const actionResult = await executeActionNode(node, enrollment, definition, { supabase: client, ...deps });
    if (actionResult.live_send_blocked !== true && node.node_type?.startsWith('action.send_')) {
      return { ...actionResult, live_send_blocked: true };
    }
    if (
      actionResult.live_send_blocked !== true &&
      (node.node_type?.startsWith('action.enqueue_') || node.node_type === 'action.schedule_follow_up')
    ) {
      return { ...actionResult, live_send_blocked: true };
    }
    return actionResult;
  }

  return { ...base, status: 'scaffolded', note: `node_kind ${node.node_kind} not handled` };
}

// ─────────────────────────────────────────────
// runEnrollment — single enrollment tick
// ─────────────────────────────────────────────

export async function runEnrollment(enrollmentId, deps = {}) {
  const client = db(deps);
  const now = new Date();

  let enrollment = await loadEnrollmentFull(enrollmentId, client);
  if (!enrollment) return { ok: false, error: 'enrollment_not_found', enrollment_id: enrollmentId };

  if (enrollment.status === 'paused') {
    return { ok: false, skipped: true, reason: 'enrollment_paused', status: enrollment.status };
  }

  if (!['active', 'waiting'].includes(enrollment.status)) {
    return { ok: false, skipped: true, reason: 'enrollment_not_runnable', status: enrollment.status };
  }
  if (enrollment.status === 'waiting' && enrollment.next_execution_at) {
    if (new Date(enrollment.next_execution_at) > now) {
      return {
        ok: false,
        skipped: true,
        reason: 'wait_not_yet_due',
        next_execution_at: enrollment.next_execution_at,
      };
    }
  }

  if (isSellerReplyContext(enrollment.context ?? {})) {
    try {
      await cancelFollowUpsOnReply(enrollmentId, { supabase: client, ...deps });
    } catch {
      // Non-fatal — runner continues even if follow-up cancellation fails.
    }
  }

  const definition = await loadDefinition(enrollment.workflow_definition_id, client);
  if (!definition) return { ok: false, error: 'workflow_definition_not_found', enrollment_id: enrollmentId };

  const { nodes, edges } = await loadGraph(enrollment.workflow_definition_id, client);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  let currentNode = enrollment.current_node_id
    ? nodesById.get(enrollment.current_node_id)
    : nodes.find((n) => isTriggerNode(n.node_type));

  if (!currentNode) {
    return { ok: false, error: 'no_entry_node', enrollment_id: enrollmentId };
  }

  const run = await createRunRecord(client, definition, enrollment, currentNode);

  const stepResults = [];
  let steps = 0;
  let runStatus = 'completed';

  try {
    while (currentNode && steps < MAX_STEPS_PER_TICK) {
      steps++;

      const stepResult = await executeNode(currentNode, enrollment, definition, client, deps);
      stepResults.push(stepResult);
      await persistRunStep(client, run, definition, currentNode, stepResult, enrollment);
      await recordStepEvent(client, run, definition, enrollment, currentNode, stepResult);

      if (stepResult.status === 'blocked' && currentNode.node_kind === 'guard') {
        await terminateEnrollment(enrollmentId, stepResult.block_reason ?? 'guard_blocked', { supabase: client });
        runStatus = 'completed';
        break;
      }

      if (stepResult.status === 'exit' && currentNode.node_kind === 'action') {
        await completeEnrollment(enrollmentId, { supabase: client });
        runStatus = 'completed';
        break;
      }

      if (currentNode.node_kind === 'timing' && stepResult._pause_until) {
        const nextNode = resolveNextNodeByEdge(currentNode.id, null, edges, nodesById);
        await advanceEnrollment(enrollmentId, nextNode?.id ?? null, { supabase: client });
        await pauseEnrollmentForWait(enrollmentId, stepResult._pause_until, currentNode.node_type, {
          supabase: client,
        });
        runStatus = 'waiting';
        break;
      }

      let conditionResult = null;
      if (currentNode.node_kind === 'condition') {
        conditionResult = stepResult._condition_result ?? false;
      }

      const nextNode = resolveNextNodeByEdge(currentNode.id, conditionResult, edges, nodesById);

      if (!nextNode) {
        await completeEnrollment(enrollmentId, { supabase: client });
        runStatus = 'completed';
        break;
      }

      await advanceEnrollment(enrollmentId, nextNode.id, { supabase: client });
      const reloaded = await loadEnrollmentFull(enrollmentId, client);
      if (reloaded) enrollment = reloaded;
      currentNode = nextNode;
    }

    if (steps >= MAX_STEPS_PER_TICK) {
      runStatus = 'running';
    }
  } catch (err) {
    await finalizeRunRecord(client, run.id, 'failed');
    throw err;
  }

  await finalizeRunRecord(client, run.id, runStatus);

  return {
    ok: true,
    enrollment_id: enrollmentId,
    run_id: run.id,
    steps_executed: steps,
    run_status: runStatus,
    step_results: stepResults,
    live_send_blocked: true,
    no_outbound_messages_sent: true,
  };
}

// ─────────────────────────────────────────────
// processReadyEnrollments — scheduler fan-out
// ─────────────────────────────────────────────

export async function processReadyEnrollments(opts = {}, deps = {}) {
  const limit = Number(opts.limit ?? 50);
  const ready = await findReadyEnrollments(limit, deps);
  if (!ready.ok) return ready;

  const results = [];
  for (const enrollment of ready.enrollments) {
    try {
      const result = await runEnrollment(enrollment.id, deps);
      results.push({ enrollment_id: enrollment.id, ...result });
    } catch (err) {
      results.push({
        enrollment_id: enrollment.id,
        ok: false,
        error: err?.message ?? 'runner_error',
      });
    }
  }

  const processed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;

  return {
    ok: true,
    processed,
    skipped,
    failed,
    total: results.length,
    results,
  };
}