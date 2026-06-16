import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

// ─────────────────────────────────────────────
// State machine helpers
// ─────────────────────────────────────────────

export async function advanceEnrollment(enrollmentId, nextNodeId, deps = {}) {
  const patch = {
    current_node_id: nextNodeId ?? null,
    status: 'active',
    waiting_reason: null,
    next_execution_at: null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update(patch)
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function pauseEnrollmentForWait(enrollmentId, nextExecutionAt, waitingReason, deps = {}) {
  const patch = {
    status: 'waiting',
    next_execution_at: nextExecutionAt instanceof Date ? nextExecutionAt.toISOString() : nextExecutionAt,
    waiting_reason: clean(waitingReason ?? 'timing_wait'),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update(patch)
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function completeEnrollment(enrollmentId, deps = {}) {
  const now = new Date().toISOString();
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update({ status: 'completed', completed_at: now, updated_at: now })
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function terminateEnrollment(enrollmentId, reason, deps = {}) {
  const now = new Date().toISOString();
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update({
      status: 'cancelled',
      terminated_at: now,
      waiting_reason: clean(reason ?? 'guard_blocked'),
      updated_at: now,
    })
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function updateEnrollmentContext(enrollmentId, contextPatch, deps = {}) {
  const current = await db(deps).from('workflow_enrollments').select('context').eq('id', enrollmentId).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) return { ok: false, status: 404, error: 'enrollment_not_found' };
  const mergedContext = { ...(current.data.context ?? {}), ...contextPatch };
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update({ context: mergedContext, updated_at: new Date().toISOString() })
    .eq('id', enrollmentId)
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function resetWaitingEnrollment(enrollmentId, deps = {}) {
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .update({
      status: 'active',
      next_execution_at: null,
      waiting_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', enrollmentId)
    .eq('status', 'waiting')
    .select('*')
    .single();
  if (error) throw error;
  return { ok: true, enrollment: data };
}

export async function findReadyEnrollments(limit = 50, deps = {}) {
  const now = new Date().toISOString();
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .select('*')
    .or(`status.eq.active,and(status.eq.waiting,next_execution_at.lte.${now})`)
    .limit(limit)
    .order('enrolled_at', { ascending: true });
  if (error) throw error;
  return { ok: true, enrollments: data ?? [] };
}

export async function enrollSubject(definitionId, payload = {}, deps = {}) {
  const subjectType = clean(payload.subject_type ?? payload.subjectType ?? 'lead');
  const subjectId = clean(payload.subject_id ?? payload.subjectId ?? '');
  if (!subjectId) return { ok: false, status: 400, error: 'enrollment_subject_id_required' };

  const defCheck = await db(deps).from('workflow_definitions').select('id, status').eq('id', definitionId).maybeSingle();
  if (defCheck.error) throw defCheck.error;
  if (!defCheck.data) return { ok: false, status: 404, error: 'workflow_definition_not_found' };

  const incomingContext = payload.context && typeof payload.context === 'object' ? payload.context : {};

  // Find any existing enrollment for this (workflow, subject_type, subject_id) triple.
  const existing = await db(deps)
    .from('workflow_enrollments')
    .select('*')
    .eq('workflow_definition_id', definitionId)
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .maybeSingle();
  if (existing.error) throw existing.error;

  let enrollment;

  if (existing.data) {
    // Merge incoming context into the stored context — never discard accumulated fields.
    const mergedContext = { ...(existing.data.context ?? {}), ...incomingContext };
    const { data, error } = await db(deps)
      .from('workflow_enrollments')
      .update({ context: mergedContext, updated_at: new Date().toISOString() })
      .eq('id', existing.data.id)
      .select('*')
      .single();
    if (error) throw error;
    enrollment = data;
  } else {
    const row = {
      workflow_definition_id: definitionId,
      subject_type: subjectType,
      subject_id: subjectId,
      status: 'active',
      context: incomingContext,
      enrolled_at: new Date().toISOString(),
    };
    const { data, error } = await db(deps)
      .from('workflow_enrollments')
      .insert(row)
      .select('*')
      .single();
    if (error) throw error;
    enrollment = data;
  }

  return { ok: true, enrollment, enrollment_id: enrollment.id };
}

export async function getEnrollment(enrollmentId, deps = {}) {
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .select('*')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, status: 404, error: 'enrollment_not_found' };
  return { ok: true, enrollment: data };
}

export async function findActiveEnrollment(definitionId, subjectType, subjectId, deps = {}) {
  const { data, error } = await db(deps)
    .from('workflow_enrollments')
    .select('*')
    .eq('workflow_definition_id', definitionId)
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return { ok: true, enrollment: data ?? null };
}
