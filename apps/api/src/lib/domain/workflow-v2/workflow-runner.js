// Workflow Studio V2 — Stateful Runner.
//
// runEnrollment(enrollmentId, deps):
//   Loads enrollment + graph. Walks nodes one-by-one, persisting state at each step.
//   Stops when:
//     - timing node reached (enrollment paused, next_execution_at set)
//     - terminal node reached (enrollment completed)
//     - no outgoing edges (enrollment completed)
//     - guard blocks execution (enrollment terminated)
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
import { isGuardNode, isTriggerNode } from '@/lib/domain/workflow-v2/node-registry.js';

const MAX_STEPS_PER_TICK = 50;

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
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

async function createRunRecord(client, definition, enrollment) {
  const { data, error } = await client
    .from('workflow_runs')
    .insert({
      workflow_definition_id: definition.id,
      enrollment_id: enrollment.id,
      prospect_id: clean(enrollment.subject_id ?? '') || null,
      status: 'running',
      dry_run: false,
      live_send_enabled: false,
      context: enrollment.context ?? {},
      started_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
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
    // _context snapshot lets you audit exactly what context was visible at this step.
    execution_result: { ...stepResult, _context: enrollment?.context ?? {} },
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };
  const { error } = await client.from('workflow_run_steps').insert(row);
  if (error) throw error;
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

  // Trigger: just mark as entered
  if (isTriggerNode(node.node_type)) {
    return { ...base, status: 'triggered' };
  }

  // Timing: calculate wait and signal pause (caller must handle pausing)
  if (node.node_kind === 'timing') {
    const nextAt = calculateNextExecutionAt(node.config ?? {});
    const waitDesc = describeWait(node.config ?? {});
    return {
      ...base,
      status: 'waiting',
      wait: { until: nextAt.toISOString(), description: waitDesc },
      _pause_until: nextAt,
    };
  }

  // Guard: evaluate guard condition
  if (isGuardNode(node.node_type)) {
    const passed = await evaluateGuard(node, enrollment, client);
    return {
      ...base,
      status: passed ? 'completed' : 'blocked',
      guard: { node_type: node.node_type, passed, reason: passed ? 'guard_passed' : 'guard_blocked' },
      live_send_blocked: false,
      block_reason: passed ? null : `guard_blocked:${node.node_type}`,
    };
  }

  // Condition: evaluate and record branch result (caller reads _condition_result)
  if (node.node_kind === 'condition') {
    const evaluation = await evaluateConditionNode(node, enrollment, { supabase: client });
    return {
      ...base,
      status: 'completed',
      condition: { node_type: node.node_type, ...evaluation },
      _condition_result: evaluation.result,
    };
  }

  // Action
  if (node.node_kind === 'action') {
    return executeActionNode(node, enrollment, definition, { supabase: client });
  }

  return { ...base, status: 'scaffolded', note: `node_kind ${node.node_kind} not handled` };
}

async function evaluateGuard(node, enrollment, client) {
  // guard.stop_suppression: check if contact is suppressed in message_events
  if (node.node_type === 'guard.stop_suppression') {
    const masterOwnerId = clean(enrollment.context?.master_owner_id ?? '');
    if (!masterOwnerId) return true; // No ID to check → pass through
    try {
      const { count } = await client
        .from('message_events')
        .select('id', { count: 'exact', head: true })
        .eq('master_owner_id', masterOwnerId)
        .eq('is_opt_out', true)
        .limit(1);
      return (count ?? 0) === 0; // pass if no opt-out rows
    } catch {
      return true; // graceful degradation: pass on error
    }
  }

  // guard.quiet_hours: scaffolded — always pass in Phase 2
  if (node.node_type === 'guard.quiet_hours') {
    return true;
  }

  // guard.max_touches: scaffolded — always pass in Phase 2
  if (node.node_type === 'guard.max_touches') {
    return true;
  }

  return true;
}

// ─────────────────────────────────────────────
// runEnrollment — single enrollment tick
// ─────────────────────────────────────────────

export async function runEnrollment(enrollmentId, deps = {}) {
  const client = db(deps);
  const now = new Date();

  // 1. Load enrollment
  const enrollment = await loadEnrollmentFull(enrollmentId, client);
  if (!enrollment) return { ok: false, error: 'enrollment_not_found', enrollment_id: enrollmentId };

  // 2. Gate: skip if not runnable
  if (!['active', 'waiting'].includes(enrollment.status)) {
    return { ok: false, skipped: true, reason: 'enrollment_not_runnable', status: enrollment.status };
  }
  if (enrollment.status === 'waiting' && enrollment.next_execution_at) {
    if (new Date(enrollment.next_execution_at) > now) {
      return { ok: false, skipped: true, reason: 'wait_not_yet_due', next_execution_at: enrollment.next_execution_at };
    }
  }

  // 3. Load definition
  const definition = await loadDefinition(enrollment.workflow_definition_id, client);
  if (!definition) return { ok: false, error: 'workflow_definition_not_found', enrollment_id: enrollmentId };

  // 4. Load graph
  const { nodes, edges } = await loadGraph(enrollment.workflow_definition_id, client);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  // 5. Resolve entry node
  let currentNode = enrollment.current_node_id
    ? nodesById.get(enrollment.current_node_id)
    : nodes.find((n) => isTriggerNode(n.node_type));

  if (!currentNode) {
    return { ok: false, error: 'no_entry_node', enrollment_id: enrollmentId };
  }

  // 6. Create run record
  const run = await createRunRecord(client, definition, enrollment);

  const stepResults = [];
  let steps = 0;
  let runStatus = 'completed';

  try {
    while (currentNode && steps < MAX_STEPS_PER_TICK) {
      steps++;

      // Execute the node
      const stepResult = await executeNode(currentNode, enrollment, definition, client, deps);
      stepResults.push(stepResult);
      await persistRunStep(client, run, definition, currentNode, stepResult, enrollment);

      // ── Guard blocked → terminate ──
      if (stepResult.status === 'blocked' && currentNode.node_kind === 'guard') {
        await terminateEnrollment(enrollmentId, stepResult.block_reason ?? 'guard_blocked', { supabase: client });
        runStatus = 'completed';
        break;
      }

      // ── Timing node → pause ──
      if (currentNode.node_kind === 'timing' && stepResult._pause_until) {
        const nextNode = resolveNextNodeByEdge(currentNode.id, null, edges, nodesById);
        // Advance current_node_id to AFTER the timing node so resume continues from next
        await advanceEnrollment(enrollmentId, nextNode?.id ?? null, { supabase: client });
        await pauseEnrollmentForWait(enrollmentId, stepResult._pause_until, currentNode.node_type, { supabase: client });
        runStatus = 'waiting';
        break;
      }

      // ── Condition node → route by branch ──
      let conditionResult = null;
      if (currentNode.node_kind === 'condition') {
        conditionResult = stepResult._condition_result ?? false;
      }

      // ── Resolve next node ──
      const nextNode = resolveNextNodeByEdge(currentNode.id, conditionResult, edges, nodesById);

      if (!nextNode) {
        // No outgoing edges → workflow complete
        await completeEnrollment(enrollmentId, { supabase: client });
        runStatus = 'completed';
        break;
      }

      // ── Advance enrollment ──
      await advanceEnrollment(enrollmentId, nextNode.id, { supabase: client });
      currentNode = nextNode;
    }

    if (steps >= MAX_STEPS_PER_TICK) {
      // Hit safety limit — leave enrollment active, scheduler will continue
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
