/**
 * WORKFORCE — the wire types of the §7 cockpit routes (docs/WORKFORCE.md).
 *
 * Column names follow the §2 tables verbatim. Fields the contract does not
 * name are marked ASSUMED; the client normalizes every one of them as
 * optional, so a server that omits them renders "Unknown", never 0.
 */

export const WF_DEPARTMENTS = ['executive', 'finance', 'acquisitions', 'marketing', 'dispositions', 'data_intelligence', 'operations'] as const
export type WfDepartmentKey = (typeof WF_DEPARTMENTS)[number]

export const WF_ROLES = [
  'ceo', 'coo', 'cfo', 'head_acquisitions', 'acquisition_agent', 'head_marketing', 'campaign_manager',
  'head_dispositions', 'dispositions_agent', 'head_data_intelligence', 'research_analyst', 'ops_supervisor', 'human_staff',
] as const
export type WfRoleKey = (typeof WF_ROLES)[number]

export type WfEmployeeStatus = 'active' | 'paused' | 'retired' | 'pending_link'
export type WfTier = 'T1' | 'T2'

export interface WfEmployee {
  employee_id: string
  kind: 'ai' | 'human'
  role_key: WfRoleKey | string
  department_key: WfDepartmentKey | string
  display_name: string
  employee_code: string | null
  manager_employee_id: string | null
  user_id: string | null
  action_principal_id: string | null
  status: WfEmployeeStatus | string
  markets: string[]
  segments: Record<string, unknown> | null
  tier_ceiling: WfTier | string | null
  spend_day_cap_usd: number | null
  heartbeat_at: string | null
  last_activity_at: string | null
  /** ASSUMED (overview / list): non-terminal assignments held by this employee */
  open_assignments: number | null
  // ── Workforce × Agntei (docs/WORKFORCE-AGNTEI.md §1, §4) ──
  /** autonomous_ai (the Workforce engine) | operator_ai (an Agntei agent) | human; null = not reported */
  employment_type: WfEmploymentType | null
  /** workforce | agntei; null = not reported */
  origin: WfOrigin | null
  /** the linked Agntei agent (agent_…), once workforce_link_self succeeded */
  external_agent_id: string | null
  external_linked_at: string | null
  binding_valid_until: string | null
  binding_revoked_at: string | null
  skills: string[]
  property_specializations: string[]
  availability: string | null
  /** the truthful activity the server derived (working / waiting <reason> / idle / pending_link / binding ended) */
  activity: WfActivity | null
}

export const WF_MISSION_STATUSES = ['planning', 'active', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'] as const
export type WfMissionStatus = (typeof WF_MISSION_STATUSES)[number]

export const WF_ASSIGNMENT_STATUSES = ['pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked', 'completed', 'failed', 'cancelled'] as const
export type WfAssignmentStatus = (typeof WF_ASSIGNMENT_STATUSES)[number]

export type WfOutcomeClass = 'verified' | 'partial' | 'unknown' | 'refused'

/** A record link carried by messages, report items and evidence (§6). */
export type WfRefType = 'property' | 'thread' | 'opportunity' | 'job' | 'assignment' | 'mission' | 'employee' | 'market'
export interface WfRef {
  type: WfRefType
  id: string
  label: string | null
  /** ASSUMED: sibling ids a ref may carry so a property chip can open its thread / deal */
  property_id?: string | null
  thread_key?: string | null
  opportunity_id?: string | null
}

export interface WfObjective {
  intent: string
  markets?: string[] | null
  count?: number | null
  horizon?: string | null
  focus?: string | null
}

/** ASSUMED shape of mission.plan (§3 "a DAG of steps from the playbook"). */
export interface WfPlanStep {
  step_key: string
  capability_key: string
  label: string | null
  assignee_role: string | null
  assignee_employee_id: string | null
  depends_on: string[]
  /** a step that fans out per candidate (e.g. conversation_state per opportunity) */
  fan_out: boolean
  /** the playbook knows this step but Phase A has no implementation (§5 "honest about the steps that don't") */
  unavailable_reason: string | null
}
export interface WfPlan { steps: WfPlanStep[] }

export type WfCfoVerdict = 'supported' | 'challenge' | 'insufficient_evidence'
export type WfNextAction = 'research' | 'underwrite' | 'await_seller' | 'prepare_offer_recommendation' | 'operator_review' | 'hold' | 'none'

export interface WfReportItem {
  label: string
  assignment_id: string | null
  step_key: string | null
  status: string | null
  refs: WfRef[]
  reasons: string[]
  detail: string | null
}

export interface WfScoreComponents {
  contact: number | null
  pressure: number | null
  deal_quality: number | null
  /** expected value; null = unknown (EV only exists when calibrated inputs exist) */
  ev_usd: number | null
  ev_reason: string | null
  [extra: string]: number | string | null
}

export interface WfRankedItem {
  rank: number
  label: string | null
  market: string | null
  refs: WfRef[]
  components: WfScoreComponents
  cfo_verdict: { verdict: WfCfoVerdict | null; reasons: string[] } | null
  next_action: WfNextAction | string | null
  next_action_reason: string | null
  assignment_id: string | null
}

export interface WfCostLine { runtime_job_id: string | null; kind: string | null; assignment_id: string | null; usd: number | null }
export interface WfCosts {
  total_usd: number | null
  status: 'known' | 'unknown'
  reason: string | null
  by_job: WfCostLine[]
}

export interface WfReport {
  summary: string | null
  generated_at: string | null
  completed: WfReportItem[]
  pending: WfReportItem[]
  escalations: WfReportItem[]
  refused: WfReportItem[]
  unknowns: WfReportItem[]
  ranked: WfRankedItem[]
  costs: WfCosts | null
}

export interface WfMission {
  mission_id: string
  title: string
  directive: string
  objective: WfObjective | null
  playbook_key: string | null
  owner_employee_id: string | null
  requested_by: string | null
  status: WfMissionStatus | string
  priority: number | null
  due_at: string | null
  plan: WfPlan | null
  plan_version: number | null
  report: WfReport | null
  created_at: string | null
  updated_at: string | null
  completed_at: string | null
  /** ASSUMED (list rows): assignment counts by status, so the list can show progress without the detail */
  assignment_counts: Partial<Record<WfAssignmentStatus, number>> | null
}

export interface WfAssignment {
  assignment_id: string
  mission_id: string
  parent_assignment_id: string | null
  step_key: string
  capability_key: string
  assignee_employee_id: string | null
  delegated_by_employee_id: string | null
  status: WfAssignmentStatus | string
  depends_on: string[]
  input: Record<string, unknown> | null
  output: Record<string, unknown> | null
  outcome_class: WfOutcomeClass | null
  evidence: WfRef[]
  runtime_job_id: string | null
  resource_type: string | null
  resource_key: string | null
  /** ASSUMED: a display label for the resource (the property address), so a chip never shows a bare id */
  resource_label: string | null
  attempt: number | null
  max_attempts: number | null
  next_attempt_at: string | null
  lease_until: string | null
  last_error: { code: string | null; message: string | null } | null
  created_at: string | null
  updated_at: string | null
  /** ASSUMED: a human-readable reason when blocked / waiting_approval (else derived from last_error) */
  blocked_reason: string | null
  /** internal (the Workforce engine claims it) | external (its Agntei agent claims it) */
  execution_mode: 'internal' | 'external' | null
  activity: WfActivity | null
}

export interface WfEvent {
  event_id: number
  at: string
  mission_id: string | null
  assignment_id: string | null
  employee_id: string | null
  type: string
  payload: Record<string, unknown>
}

export interface WfExecMessage {
  message_id: string
  mission_id: string | null
  author: 'ceo' | 'coo'
  author_user_id: string | null
  author_employee_id: string | null
  content: string
  refs: WfRef[]
  created_at: string
}

export type WfEpistemic = 'verified' | 'interpretation' | 'ceo_policy'
export interface WfMemoryFact {
  fact_id: string
  scope: string
  scope_key: string | null
  fact_key: string
  value: unknown
  epistemic: WfEpistemic | string
  confidence: number | null
  source_refs: WfRef[]
  author_employee_id: string | null
  author_user_id: string | null
  valid_from: string | null
  superseded_at: string | null
}

export interface WfPolicy {
  policy_id: string
  role_key: string | null
  employee_id: string | null
  action_key: string
  scope: { markets?: string[]; property_types?: string[]; resource_types?: string[] } | null
  limits: { per_day?: number; max_usd?: number; max_price?: number } | null
  risk: string | null
  min_confidence: number | null
  review: 'ceo' | 'coo' | 'none' | string | null
  valid_from: string | null
  valid_until: string | null
  status: 'active' | 'revoked' | string
  version: number | null
}

export interface WfSettings {
  exec_review_price_usd: number | null
  escalation: Record<string, unknown> | null
}

/** ASSUMED shape of proposeGrants(policy) output (display only, §4.2). */
export interface WfProposedGrant {
  agent_id: string | null
  employee_id: string | null
  action: string
  scope: Record<string, unknown> | null
  limits: Record<string, unknown> | null
  from_policy_id: string | null
  note: string | null
}

/** ASSUMED: a protective restriction the engine honours (holds, static exclusions, suppression). */
export interface WfRestriction {
  kind: 'hold' | 'exclusion' | 'suppression' | string
  label: string
  reason: string | null
  refs: WfRef[]
  since: string | null
}

export interface WfKpi {
  subject_type: 'employee' | 'department' | 'org' | string
  subject_key: string
  kpi_key: string
  window: string | null
  value: number | null
  status: 'known' | 'unknown'
  /** ASSUMED: source.reason explains an unknown */
  reason: string | null
  computed_at: string | null
}

export interface WfRuntimeHealth {
  /** ASSUMED keys of overview.runtime */
  emergency_stop: boolean | null
  last_tick_at: string | null
  kinds_armed: string[] | null
  dispatch_enabled: boolean | null
  detail: string | null
}

export interface WfDepartmentSummary {
  department_key: string
  head_employee_id: string | null
  employee_count: number | null
  open_assignments: number | null
}

export interface WfOverview {
  departments: WfDepartmentSummary[]
  employees: WfEmployee[]
  missions_by_status: Partial<Record<WfMissionStatus, number>>
  last_events: WfEvent[]
  runtime: WfRuntimeHealth
  flags: Record<string, boolean | string | null>
}

export interface WfCharter {
  mandate: string | null
  responsibilities: string[]
  kpi_keys: string[]
  capabilities: string[]
  max_tier: string | null
}

export interface WfEmployeeProfile {
  employee: WfEmployee
  charter: WfCharter | null
  policies: WfPolicy[]
  memory: WfMemoryFact[]
  assignments: WfAssignment[]
  kpis: WfKpi[]
  cost: { today_usd: number | null; window_usd: number | null; window: string | null; cap_usd: number | null; status: 'known' | 'unknown'; reason: string | null } | null
  activity: WfActivity | null
  /** an Agntei employee's binding + link (null for a Workforce employee) */
  link: WfEmployeeLink | null
  /** the owner's exact link steps (CEO only, while not linked through a live binding) */
  link_steps: WfLinkSteps | null
  history: WfHistory | null
}

export interface WfMissionDetail {
  mission: WfMission
  assignments: WfAssignment[]
  events: WfEvent[]
}

export interface WfEventsPage { events: WfEvent[]; next_after: number | null }

export interface WfCommandResult { messages: WfExecMessage[]; mission: WfMission | null }

export interface WfAuthority {
  policies: WfPolicy[]
  settings: WfSettings | null
  proposed_grants: WfProposedGrant[]
  restrictions: WfRestriction[]
  emergency: { stop: boolean | null; reason: string | null; since: string | null } | null
  flags: Record<string, boolean | string | null>
}

export interface WfReportEntry {
  mission_id: string
  title: string
  status: string | null
  completed_at: string | null
  report: WfReport | null
}

export interface WfReports {
  reports: WfReportEntry[]
  daily_brief: { available: boolean; generated_at: string | null; summary: string | null; items: string[]; code: string | null } | null
}

/* ── Workforce × Agntei (docs/WORKFORCE-AGNTEI.md) ────────────────────── */

export type WfEmploymentType = 'autonomous_ai' | 'operator_ai' | 'human'
export type WfOrigin = 'workforce' | 'agntei'
export type WfActivityState = 'working' | 'waiting' | 'idle' | 'pending_link' | 'binding_expired' | 'binding_revoked' | 'paused' | 'retired' | 'done'
/** Truthful activity: working only with a live lease and a heartbeat < 2 min; waiting always says why. */
export interface WfActivity { state: WfActivityState | string; reason: string | null; label: string | null; last_seen_at: string | null; open: number | null }
export interface WfEmployeeLink {
  system: 'agntei'
  principal_id: string | null
  bound_at: string | null
  link_expires_at: string | null
  binding_valid_until: string | null
  binding_revoked_at: string | null
  linked: boolean
  external_agent_id: string | null
  external_install_id: string | null
  linked_at: string | null
}
export interface WfLinkStep { id: string; title: string; who: 'owner' | 'operator' | 'agent' | string; kind: 'shell' | 'sql' | 'agntei' | 'mcp' | string; command: string; note: string | null }
export interface WfLinkSteps { agent_id: string; employee_id: string | null; tools: string[]; steps: WfLinkStep[] }
/** One Action Gateway audit row of the employee's principal (codes and ids only). */
export interface WfGatewayAuditEvent { event_id: number; at: string | null; event_type: string; action: string | null; code: string | null; intent_id: string | null }
export interface WfHistory { events: WfEvent[]; events_available: boolean; gateway: WfGatewayAuditEvent[]; gateway_available: boolean; gateway_reason: string | null }
export interface WfRegisterResult { employee: WfEmployee | null; link: WfLinkSteps | null; executed: boolean }
