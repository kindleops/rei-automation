// Workforce state graphs and closed sets (docs/WORKFORCE.md §1, §2, §11).
//
// ASSIGNMENT_TRANSITIONS and MISSION_TRANSITIONS are the JS mirror of
// workforce.assignment_transition_ok / workforce.mission_transition_ok in
// supabase/migrations/PROPOSED_20261022100000_workforce_foundation.sql. They must be
// IDENTICAL: tests/critical/workforce-store-conformance.test.mjs parses the SQL and (with
// PG) asks the database about every (from, to) pair.

export const ASSIGNMENT_STATES = Object.freeze(['pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled'])
export const ASSIGNMENT_TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled'])

export const ASSIGNMENT_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['ready', 'cancelled']),
  ready: Object.freeze(['leased', 'cancelled']),
  leased: Object.freeze(['running', 'ready', 'completed', 'failed', 'waiting_job', 'waiting_approval', 'blocked', 'cancelled']),
  running: Object.freeze(['completed', 'failed', 'ready', 'waiting_job', 'waiting_approval', 'blocked', 'cancelled']),
  waiting_job: Object.freeze(['ready', 'completed', 'failed', 'cancelled']),
  // → completed only through a PERSON's decision (workforce.assignment_decide / decideHeldAssignment)
  waiting_approval: Object.freeze(['ready', 'completed', 'cancelled', 'failed']),
  blocked: Object.freeze(['ready', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
})

export const MISSION_STATES = Object.freeze(['planning', 'active', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'])
export const MISSION_TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled'])

export const MISSION_TRANSITIONS = Object.freeze({
  planning: Object.freeze(['active', 'failed', 'cancelled']),
  active: Object.freeze(['waiting', 'blocked', 'completed', 'failed', 'cancelled']),
  waiting: Object.freeze(['active', 'completed', 'failed', 'cancelled']),
  blocked: Object.freeze(['active', 'cancelled', 'failed']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
})

export const canAssignmentTransition = (from, to) => Array.isArray(ASSIGNMENT_TRANSITIONS[from]) && ASSIGNMENT_TRANSITIONS[from].includes(to)
export const canMissionTransition = (from, to) => Array.isArray(MISSION_TRANSITIONS[from]) && MISSION_TRANSITIONS[from].includes(to)

export const DEPARTMENT_KEYS = Object.freeze(['executive', 'finance', 'acquisitions', 'marketing', 'dispositions', 'data_intelligence', 'operations'])

/** role_key → the departments it may sit in (mirror of workforce.role_department_ok). */
export const ROLE_DEPARTMENTS = Object.freeze({
  ceo: Object.freeze(['executive']),
  coo: Object.freeze(['executive']),
  cfo: Object.freeze(['finance']),
  head_acquisitions: Object.freeze(['acquisitions']),
  acquisition_agent: Object.freeze(['acquisitions']),
  head_marketing: Object.freeze(['marketing']),
  campaign_manager: Object.freeze(['marketing']),
  head_dispositions: Object.freeze(['dispositions']),
  dispositions_agent: Object.freeze(['dispositions']),
  head_data_intelligence: Object.freeze(['data_intelligence']),
  research_analyst: Object.freeze(['data_intelligence']),
  ops_supervisor: Object.freeze(['operations']),
  human_staff: DEPARTMENT_KEYS,
})
export const ROLE_KEYS = Object.freeze(Object.keys(ROLE_DEPARTMENTS))

export const EMPLOYEE_STATUSES = Object.freeze(['active', 'paused', 'retired', 'pending_link'])
/** docs/WORKFORCE-AGNTEI.md §1 (PROPOSED_20261022110000_workforce_agntei.sql): human ⇔ kind human; operator_ai ⇔ origin agntei. */
export const EMPLOYMENT_TYPES = Object.freeze(['autonomous_ai', 'operator_ai', 'human'])
export const EMPLOYEE_ORIGINS = Object.freeze(['workforce', 'agntei'])
export const AVAILABILITY = Object.freeze(['available', 'busy', 'off', 'unknown'])
/** §3: an operator_ai assignee's assignments are external (its Agntei agent claims them); everything else is internal. */
export const EXECUTION_MODES = Object.freeze(['internal', 'external'])
export const executionModeFor = (employee) => (employee?.employment_type === 'operator_ai' ? 'external' : 'internal')
export const BUDGET_SCOPES = Object.freeze(['org', 'department', 'mission', 'employee'])
export const BUDGET_PERIODS = Object.freeze(['day', 'month'])
export const OUTCOME_CLASSES = Object.freeze(['verified', 'partial', 'unknown', 'refused'])
export const RESOURCE_TYPES = Object.freeze(['thread', 'property', 'opportunity', 'campaign'])
export const MEMORY_SCOPES = Object.freeze(['company', 'department', 'employee', 'mission', 'property', 'market'])
export const EPISTEMIC_CLASSES = Object.freeze(['verified', 'interpretation', 'ceo_policy'])
/** finishAssignment statuses ('retry' is an alias of 'ready') */
export const FINISH_STATUSES = Object.freeze(['completed', 'failed', 'ready', 'retry', 'waiting_approval', 'blocked', 'cancelled'])

/** retry backoff (mirror of workforce.backoff): 30 s · 2^(attempt-1), capped at 1 h */
export const backoffSeconds = (attempt) => Math.min(3600, 30 * 2 ** (Math.max(Number(attempt) || 1, 1) - 1))
