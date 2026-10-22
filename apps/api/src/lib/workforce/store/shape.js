// Row shapes shared by the PG store and the memory twin: ISO strings out, numbers as numbers,
// jsonb as plain objects, and nothing else. Both stores return exactly these objects.

export const iso = (v) => (v == null ? null : new Date(v).toISOString())
const num = (v) => (v == null ? null : Number(v))
const arr = (v) => (Array.isArray(v) ? [...v] : [])
const obj = (v, d = {}) => (v && typeof v === 'object' && !Array.isArray(v) ? v : d)
const str = (v) => (v == null ? null : String(v))

export function shapeEmployee(r) {
  if (!r) return null
  return {
    employee_id: r.employee_id, org_id: str(r.org_id), kind: r.kind, role_key: r.role_key, department_key: r.department_key,
    display_name: r.display_name, employee_code: r.employee_code ?? null, manager_employee_id: r.manager_employee_id ?? null,
    user_id: str(r.user_id), action_principal_id: r.action_principal_id ?? null, status: r.status, markets: arr(r.markets),
    segments: obj(r.segments), tier_ceiling: r.tier_ceiling, spend_day_cap_usd: num(r.spend_day_cap_usd) ?? 0,
    heartbeat_at: iso(r.heartbeat_at), last_activity_at: iso(r.last_activity_at), created_by: str(r.created_by),
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  }
}

export function shapeMission(r) {
  if (!r) return null
  return {
    mission_id: r.mission_id, org_id: str(r.org_id), title: r.title, directive: r.directive, objective: obj(r.objective),
    playbook_key: r.playbook_key ?? null, owner_employee_id: r.owner_employee_id, requested_by: str(r.requested_by), status: r.status,
    priority: num(r.priority), due_at: iso(r.due_at), plan: obj(r.plan), plan_version: num(r.plan_version), report: r.report ?? null,
    idempotency_key: r.idempotency_key, created_at: iso(r.created_at), updated_at: iso(r.updated_at), completed_at: iso(r.completed_at),
  }
}

export function shapeAssignment(r) {
  if (!r) return null
  return {
    assignment_id: r.assignment_id, org_id: str(r.org_id), mission_id: r.mission_id, parent_assignment_id: r.parent_assignment_id ?? null,
    step_key: r.step_key, capability_key: r.capability_key, assignee_employee_id: r.assignee_employee_id,
    delegated_by_employee_id: r.delegated_by_employee_id ?? null, status: r.status, depends_on: arr(r.depends_on), input: obj(r.input),
    output: r.output ?? null, outcome_class: r.outcome_class ?? null, evidence: arr(r.evidence), runtime_job_id: r.runtime_job_id ?? null,
    resource_type: r.resource_type ?? null, resource_key: r.resource_key ?? null, attempt: num(r.attempt), max_attempts: num(r.max_attempts),
    next_attempt_at: iso(r.next_attempt_at), lease_token: str(r.lease_token), lease_owner: r.lease_owner ?? null, lease_until: iso(r.lease_until),
    lease_seconds: num(r.lease_seconds), claimed_at: iso(r.claimed_at), last_error: r.last_error ?? null,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at), finished_at: iso(r.finished_at),
  }
}

export function shapeClaim(r) {
  if (!r) return null
  return {
    claim_id: str(r.claim_id), org_id: str(r.org_id), resource_type: r.resource_type, resource_key: r.resource_key, employee_id: r.employee_id,
    assignment_id: r.assignment_id ?? null, claimed_at: iso(r.claimed_at), expires_at: iso(r.expires_at), released_at: iso(r.released_at),
    release_reason: r.release_reason ?? null,
  }
}

export function shapeEvent(r) {
  if (!r) return null
  return {
    event_id: num(r.event_id), org_id: str(r.org_id), at: iso(r.at), mission_id: r.mission_id ?? null, assignment_id: r.assignment_id ?? null,
    employee_id: r.employee_id ?? null, type: r.type, payload: obj(r.payload),
  }
}

export function shapeExecMessage(r) {
  if (!r) return null
  return {
    message_id: str(r.message_id), org_id: str(r.org_id), mission_id: r.mission_id ?? null, author: r.author, author_user_id: str(r.author_user_id),
    author_employee_id: r.author_employee_id ?? null, content: r.content, refs: arr(r.refs), created_at: iso(r.created_at),
  }
}

export function shapeFact(r) {
  if (!r) return null
  return {
    fact_id: str(r.fact_id), org_id: str(r.org_id), scope: r.scope, scope_key: r.scope_key, fact_key: r.fact_key, value: r.value ?? null,
    epistemic: r.epistemic, confidence: num(r.confidence), source_refs: arr(r.source_refs), author_employee_id: r.author_employee_id ?? null,
    author_user_id: str(r.author_user_id), valid_from: iso(r.valid_from), superseded_by: str(r.superseded_by), superseded_at: iso(r.superseded_at),
  }
}

export function shapePolicy(r) {
  if (!r) return null
  return {
    policy_id: str(r.policy_id), org_id: str(r.org_id), role_key: r.role_key ?? null, employee_id: r.employee_id ?? null, action_key: r.action_key,
    scope: obj(r.scope), limits: obj(r.limits), risk: r.risk, min_confidence: num(r.min_confidence), review: r.review,
    valid_from: iso(r.valid_from), valid_until: iso(r.valid_until), status: r.status, created_by: str(r.created_by), created_at: iso(r.created_at),
    revoked_at: iso(r.revoked_at), revoked_by: str(r.revoked_by), version: num(r.version), supersedes: str(r.supersedes),
  }
}

export function shapeSettings(r) {
  if (!r) return null
  return { org_id: str(r.org_id), exec_review_price_usd: num(r.exec_review_price_usd), escalation: obj(r.escalation), updated_at: iso(r.updated_at), updated_by: r.updated_by }
}

export function shapeKpi(r) {
  if (!r) return null
  return {
    org_id: str(r.org_id), subject_type: r.subject_type, subject_key: r.subject_key, kpi_key: r.kpi_key, window: r.window,
    value: num(r.value), status: r.status, source: obj(r.source), computed_at: iso(r.computed_at),
  }
}
