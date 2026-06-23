// Workflow Studio V2 — persisted scheduled task helpers.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { isDuplicateError } from '@/lib/domain/workflow-v2/idempotency.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

export async function scheduleTask(input = {}, deps = {}) {
  const client = db(deps);
  const scheduledFor = input.scheduled_for ?? input.scheduledFor ?? new Date().toISOString();
  const dedupeKey = clean(input.dedupe_key ?? input.dedupeKey ?? '') || null;

  const row = {
    workflow_definition_id: clean(input.workflow_definition_id ?? input.definition_id ?? '') || null,
    enrollment_id: clean(input.enrollment_id ?? input.enrollmentId ?? '') || null,
    run_id: clean(input.run_id ?? input.runId ?? '') || null,
    node_id: clean(input.node_id ?? input.nodeId ?? '') || null,
    task_type: clean(input.task_type ?? input.taskType ?? 'workflow.task'),
    status: 'pending',
    scheduled_for: scheduledFor,
    reason: clean(input.reason ?? '') || null,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    dedupe_key: dedupeKey,
    updated_at: new Date().toISOString(),
  };

  const insert = await client.from('workflow_scheduled_tasks').insert(row).select('*').single();
  if (isDuplicateError(insert.error) && dedupeKey) {
    const existing = await client
      .from('workflow_scheduled_tasks')
      .select('*')
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    return { ok: true, duplicate: true, task: existing.data ?? null };
  }
  if (insert.error) throw insert.error;
  return { ok: true, duplicate: false, task: insert.data };
}

export async function cancelPendingTasks(enrollmentId, taskTypes = [], deps = {}) {
  const client = db(deps);
  const now = new Date().toISOString();
  let query = client
    .from('workflow_scheduled_tasks')
    .update({
      status: 'cancelled',
      updated_at: now,
      completed_at: now,
    })
    .eq('enrollment_id', enrollmentId)
    .eq('status', 'pending');

  const normalizedTypes = (Array.isArray(taskTypes) ? taskTypes : [taskTypes])
    .map(clean)
    .filter(Boolean);
  if (normalizedTypes.length === 1) {
    query = query.eq('task_type', normalizedTypes[0]);
  } else if (normalizedTypes.length > 1) {
    query = query.in('task_type', normalizedTypes);
  }

  const { data, error } = await query.select('*');
  if (error) throw error;
  return { ok: true, cancelled_count: (data ?? []).length, tasks: data ?? [] };
}

export async function findDueTasks(opts = {}, deps = {}) {
  const client = db(deps);
  const now = opts.now ?? new Date().toISOString();
  const limit = Number(opts.limit ?? 100);

  const { data, error } = await client
    .from('workflow_scheduled_tasks')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', now)
    .order('scheduled_for', { ascending: true })
    .limit(limit);
  if (error) throw error;

  return { ok: true, tasks: data ?? [] };
}

export async function completeTask(taskId, result = {}, deps = {}) {
  const client = db(deps);
  const now = new Date().toISOString();
  const status = clean(result.status ?? 'completed');

  const patch = {
    status: ['completed', 'failed', 'cancelled'].includes(status) ? status : 'completed',
    reason: clean(result.reason ?? '') || null,
    completed_at: now,
    updated_at: now,
  };
  if (result.payload && typeof result.payload === 'object') {
    patch.payload = result.payload;
  }

  const { data, error } = await client
    .from('workflow_scheduled_tasks')
    .update(patch)
    .eq('id', taskId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, task: data };
}