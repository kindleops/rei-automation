// Workflow Studio V2 — enrollment run control and history.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { isTriggerNode } from '@/lib/domain/workflow-v2/node-registry.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

export async function pauseEnrollment(enrollmentId, reason = 'manual_pause', deps = {}) {
  const now = new Date().toISOString();
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update({
      status: 'waiting',
      paused_at: now,
      pause_reason: clean(reason) || 'manual_pause',
      waiting_reason: clean(reason) || 'manual_pause',
      updated_at: now,
    })
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function resumeEnrollment(enrollmentId, deps = {}) {
  const now = new Date().toISOString();
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update({
      status: 'active',
      paused_at: null,
      pause_reason: null,
      waiting_reason: null,
      next_execution_at: null,
      updated_at: now,
    })
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function cancelEnrollment(enrollmentId, reason = 'cancelled', deps = {}) {
  const now = new Date().toISOString();
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update({
      status: 'cancelled',
      terminated_at: now,
      waiting_reason: clean(reason) || 'cancelled',
      updated_at: now,
    })
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function replayEnrollment(enrollmentId, deps = {}) {
  const client = db(deps);
  const enrollmentRes = await client
    .from('workflow_enrollments')
    .select('*')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (enrollmentRes.error) throw enrollmentRes.error;
  const enrollment = enrollmentRes.data;
  if (!enrollment) return { ok: false, error: 'enrollment_not_found' };

  const nodesRes = await client
    .from('workflow_nodes')
    .select('id, node_type, node_key')
    .eq('workflow_definition_id', enrollment.workflow_definition_id)
    .eq('is_active', true);
  if (nodesRes.error) throw nodesRes.error;

  const triggerNode = (nodesRes.data ?? []).find((node) => isTriggerNode(node.node_type));
  if (!triggerNode) return { ok: false, error: 'trigger_node_not_found' };

  const now = new Date().toISOString();
  const { data, error } = await client
    .from('workflow_enrollments')
    .update({
      status: 'active',
      current_node_id: triggerNode.id,
      paused_at: null,
      pause_reason: null,
      waiting_reason: null,
      next_execution_at: null,
      completed_at: null,
      terminated_at: null,
      updated_at: now,
    })
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;

  return {
    ok: true,
    enrollment: data,
    trigger_node_id: triggerNode.id,
    trigger_node_key: triggerNode.node_key,
  };
}

export async function getRunHistory(definitionId, deps = {}) {
  const client = db(deps);
  const definition_id = clean(definitionId);
  if (!definition_id) return { ok: false, error: 'definition_id_required' };

  const runsRes = await client
    .from('workflow_runs')
    .select('*')
    .eq('workflow_definition_id', definition_id)
    .order('started_at', { ascending: false });
  if (runsRes.error) throw runsRes.error;

  const runs = runsRes.data ?? [];
  const runIds = runs.map((run) => run.id).filter(Boolean);
  let steps = [];

  if (runIds.length) {
    const stepsRes = await client
      .from('workflow_run_steps')
      .select('*')
      .in('workflow_run_id', runIds)
      .order('created_at', { ascending: true });
    if (stepsRes.error) throw stepsRes.error;
    steps = stepsRes.data ?? [];
  }

  const stepsByRunId = new Map();
  for (const step of steps) {
    const key = step.workflow_run_id;
    if (!stepsByRunId.has(key)) stepsByRunId.set(key, []);
    stepsByRunId.get(key).push(step);
  }

  return {
    ok: true,
    definition_id,
    runs: runs.map((run) => ({
      ...run,
      steps: stepsByRunId.get(run.id) ?? [],
    })),
  };
}