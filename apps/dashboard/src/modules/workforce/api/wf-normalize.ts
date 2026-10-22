/**
 * WORKFORCE — wire normalizers. Every §7 body passes through here, so a
 * missing or mistyped field becomes `null` (rendered "Unknown") and never a
 * fabricated 0, empty string or default status.
 */
import type {
  WfAssignment, WfAuthority, WfCfoVerdict, WfCharter, WfCommandResult, WfCostLine, WfCosts, WfDepartmentSummary, WfEmployee,
  WfEmployeeProfile, WfEvent, WfEventsPage, WfExecMessage, WfKpi, WfMemoryFact, WfMission, WfMissionDetail,
  WfOverview, WfPlan, WfPlanStep, WfPolicy, WfProposedGrant, WfRankedItem, WfRef, WfRefType, WfReport, WfReportEntry,
  WfReportItem, WfReports, WfRestriction, WfScoreComponents, WfSettings, WfResolveResult, WfDecisionEffects,
} from './wf-types'

type Obj = Record<string, unknown>
export const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
export const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
export const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const strs = (v: unknown): string[] => arr(v).map(str).filter((s): s is string => Boolean(s))
const objOrNull = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)

/** A list may arrive bare or under its plural key ({ employees: [...] }). */
export const listOf = (body: unknown, key: string): unknown[] => (Array.isArray(body) ? body : arr(obj(body)[key]))

/* ── property ids: the mission codec (pid_<letters g–p>) decoded defensively ── */

const PID = /^pid_[g-p]{1,20}$/
const PID_LETTERS = 'ghijklmnop'
/** pid_<letters> → digits; anything else passes through (the API decodes on read; this is a second guard). */
export const decodePid = (v: string): string => (PID.test(v) ? v.slice(4).split('').map((c) => String(PID_LETTERS.indexOf(c))).join('') : v)
const pid = (v: unknown): string | null => { const s = str(v); return s ? decodePid(s) : null }

/* ── refs ─────────────────────────────────────────────────────────────── */

const REF_TYPES: ReadonlySet<string> = new Set<WfRefType>(['property', 'thread', 'opportunity', 'job', 'assignment', 'mission', 'employee', 'market'])
const REF_ALIASES: Record<string, WfRefType> = { property_id: 'property', thread_key: 'thread', seller: 'thread', opportunity_id: 'opportunity', deal: 'opportunity', runtime_job_id: 'job', job_id: 'job', assignment_id: 'assignment', mission_id: 'mission', employee_id: 'employee' }

export function normalizeRef(v: unknown): WfRef | null {
  const o = obj(v)
  const rawType = str(o.type) ?? str(o.kind)
  const type = rawType ? (REF_TYPES.has(rawType) ? (rawType as WfRefType) : REF_ALIASES[rawType] ?? null) : null
  if (!type) {
    // a flat { property_id } / { thread_key } object
    for (const [k, t] of Object.entries(REF_ALIASES)) {
      const id = t === 'property' ? pid(o[k]) : str(o[k])
      if (id) return { type: t, id, label: str(o.label), property_id: pid(o.property_id), thread_key: str(o.thread_key), opportunity_id: str(o.opportunity_id) }
    }
    return null
  }
  const id = type === 'property' ? pid(o.id) ?? pid(o.property_id) : str(o.id) ?? str(o[`${type}_id`]) ?? (type === 'thread' ? str(o.thread_key) : null)
  if (!id) return null
  return { type, id, label: str(o.label), property_id: pid(o.property_id), thread_key: str(o.thread_key), opportunity_id: str(o.opportunity_id) }
}
export const normalizeRefs = (v: unknown): WfRef[] => arr(v).map(normalizeRef).filter((r): r is WfRef => Boolean(r))

// Workforce × Agntei: the identity / activity / link fields (api/wf-agntei.ts)
import { agnteiAssignmentFields, agnteiEmployeeFields, normalizeActivity, normalizeHistory, normalizeLink, normalizeLinkSteps } from './wf-agntei'

/* ── org ──────────────────────────────────────────────────────────────── */

export function normalizeEmployee(v: unknown): WfEmployee | null {
  const o = obj(v)
  const id = str(o.employee_id)
  if (!id) return null
  return {
    employee_id: id,
    kind: o.kind === 'human' ? 'human' : 'ai',
    role_key: str(o.role_key) ?? 'unknown',
    department_key: str(o.department_key) ?? 'unknown',
    display_name: str(o.display_name) ?? id,
    employee_code: str(o.employee_code),
    manager_employee_id: str(o.manager_employee_id),
    user_id: str(o.user_id),
    action_principal_id: str(o.action_principal_id),
    status: str(o.status) ?? 'unknown',
    markets: strs(o.markets),
    segments: objOrNull(o.segments),
    tier_ceiling: str(o.tier_ceiling),
    spend_day_cap_usd: num(o.spend_day_cap_usd),
    heartbeat_at: str(o.heartbeat_at),
    last_activity_at: str(o.last_activity_at),
    open_assignments: num(o.open_assignments ?? o.open_assignment_count),
    ...agnteiEmployeeFields(o),
  }
}
export const normalizeEmployees = (v: unknown): WfEmployee[] => listOf(v, 'employees').map(normalizeEmployee).filter((e): e is WfEmployee => Boolean(e))

function normalizeDepartment(v: unknown): WfDepartmentSummary | null {
  const o = obj(v)
  const key = str(o.department_key) ?? str(o.key)
  if (!key) return null
  return { department_key: key, head_employee_id: str(o.head_employee_id), employee_count: num(o.employee_count), open_assignments: num(o.open_assignments) }
}

/* ── missions / plan / report ────────────────────────────────────────── */

function normalizePlanStep(v: unknown): WfPlanStep | null {
  const o = obj(v)
  const key = str(o.step_key) ?? str(o.key)
  if (!key) return null
  return {
    step_key: key,
    capability_key: str(o.capability_key) ?? str(o.capability) ?? 'unknown',
    label: str(o.label) ?? str(o.title),
    assignee_role: str(o.assignee_role) ?? str(o.role_key),
    assignee_employee_id: str(o.assignee_employee_id),
    depends_on: strs(o.depends_on),
    fan_out: o.fan_out === true || o.per_candidate === true,
    unavailable_reason: str(o.unavailable_reason),
  }
}
export function normalizePlan(v: unknown): WfPlan | null {
  if (v === null || v === undefined) return null
  const steps = (Array.isArray(v) ? v : arr(obj(v).steps)).map(normalizePlanStep).filter((s): s is WfPlanStep => Boolean(s))
  return { steps }
}

function normalizeReportItem(v: unknown): WfReportItem | null {
  if (typeof v === 'string') return { label: v, assignment_id: null, step_key: null, status: null, refs: [], reasons: [], detail: null }
  const o = obj(v)
  const label = str(o.label) ?? str(o.title) ?? str(o.summary) ?? str(o.step_key)
  if (!label) return null
  const reasons = strs(o.reasons)
  const reason = str(o.reason)
  return {
    label,
    assignment_id: str(o.assignment_id),
    step_key: str(o.step_key),
    status: str(o.status),
    refs: normalizeRefs(o.refs),
    reasons: reason && !reasons.includes(reason) ? [reason, ...reasons] : reasons,
    detail: str(o.detail),
  }
}
const items = (v: unknown): WfReportItem[] => arr(v).map(normalizeReportItem).filter((i): i is WfReportItem => Boolean(i))

function normalizeComponents(v: unknown): WfScoreComponents {
  const o = obj(v)
  const out: WfScoreComponents = { contact: num(o.contact), pressure: num(o.pressure), deal_quality: num(o.deal_quality), ev_usd: num(o.ev_usd ?? o.ev), ev_reason: str(o.ev_reason) }
  for (const [k, val] of Object.entries(o)) if (!(k in out)) out[k] = typeof val === 'number' || typeof val === 'string' ? val : null
  return out
}

const VERDICTS = new Set(['supported', 'challenge', 'insufficient_evidence'])
function normalizeRanked(v: unknown, i: number): WfRankedItem {
  const o = obj(v)
  const cfo = o.cfo_verdict
  const cfoObj = typeof cfo === 'string' ? { verdict: cfo } : objOrNull(cfo)
  const verdict = cfoObj ? str(cfoObj.verdict) : null
  const next = o.next_action
  const nextObj = typeof next === 'string' ? { action: next } : obj(next)
  return {
    rank: num(o.rank) ?? i + 1,
    label: str(o.label) ?? str(o.address),
    market: str(o.market),
    refs: normalizeRefs(o.refs),
    components: normalizeComponents(o.components ?? o.score_components),
    cfo_verdict: cfoObj ? { verdict: verdict && VERDICTS.has(verdict) ? (verdict as WfCfoVerdict) : null, reasons: strs(cfoObj.reasons) } : null,
    next_action: str(nextObj.action) ?? str(nextObj.next_action),
    next_action_reason: str(nextObj.reason) ?? str(o.next_action_reason),
    assignment_id: str(o.assignment_id),
  }
}

function normalizeCosts(v: unknown): WfCosts | null {
  if (v === null || v === undefined) return null
  const o = obj(v)
  const total = num(o.total_usd)
  const lines: WfCostLine[] = arr(o.by_job ?? o.jobs).map((l) => { const x = obj(l); return { runtime_job_id: str(x.runtime_job_id) ?? str(x.job_id), kind: str(x.kind), assignment_id: str(x.assignment_id), usd: num(x.usd ?? x.cost_usd) } })
  const status = o.status === 'known' || o.status === 'unknown' ? o.status : total === null ? 'unknown' : 'known'
  return { total_usd: status === 'unknown' ? null : total, status, reason: str(o.reason), by_job: lines }
}

export function normalizeReport(v: unknown): WfReport | null {
  if (v === null || v === undefined) return null
  const o = obj(v)
  return {
    summary: str(o.summary),
    generated_at: str(o.generated_at),
    completed: items(o.completed),
    pending: items(o.pending),
    escalations: items(o.escalations),
    refused: items(o.refused),
    unknowns: items(o.unknowns),
    ranked: arr(o.ranked).map(normalizeRanked).sort((a, b) => a.rank - b.rank),
    costs: normalizeCosts(o.costs),
  }
}

export function normalizeMission(v: unknown): WfMission | null {
  const o = obj(v)
  const id = str(o.mission_id)
  if (!id) return null
  const obv = objOrNull(o.objective)
  const counts = objOrNull(o.assignment_counts)
  return {
    mission_id: id,
    title: str(o.title) ?? 'Untitled mission',
    directive: str(o.directive) ?? '',
    objective: obv ? { intent: str(obv.intent) ?? 'unknown', markets: strs(obv.markets), count: num(obv.count), horizon: str(obv.horizon), focus: str(obv.focus) } : null,
    playbook_key: str(o.playbook_key),
    owner_employee_id: str(o.owner_employee_id),
    requested_by: str(o.requested_by),
    status: str(o.status) ?? 'unknown',
    priority: num(o.priority),
    due_at: str(o.due_at),
    plan: normalizePlan(o.plan),
    plan_version: num(o.plan_version),
    report: normalizeReport(o.report),
    created_at: str(o.created_at),
    updated_at: str(o.updated_at),
    completed_at: str(o.completed_at),
    assignment_counts: counts ? Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, num(n) ?? 0])) : null,
  }
}
export const normalizeMissions = (v: unknown): WfMission[] => listOf(v, 'missions').map(normalizeMission).filter((m): m is WfMission => Boolean(m))

export function normalizeAssignment(v: unknown): WfAssignment | null {
  const o = obj(v)
  const id = str(o.assignment_id)
  if (!id) return null
  const err = objOrNull(o.last_error)
  const oc = str(o.outcome_class)
  return {
    assignment_id: id,
    mission_id: str(o.mission_id) ?? '',
    parent_assignment_id: str(o.parent_assignment_id),
    step_key: str(o.step_key) ?? id,
    capability_key: str(o.capability_key) ?? 'unknown',
    assignee_employee_id: str(o.assignee_employee_id),
    delegated_by_employee_id: str(o.delegated_by_employee_id),
    status: str(o.status) ?? 'unknown',
    depends_on: strs(o.depends_on),
    input: objOrNull(o.input),
    output: objOrNull(o.output),
    outcome_class: oc === 'verified' || oc === 'partial' || oc === 'unknown' || oc === 'refused' ? oc : null,
    evidence: normalizeRefs(o.evidence),
    runtime_job_id: str(o.runtime_job_id),
    resource_type: str(o.resource_type),
    resource_key: o.resource_type === 'property' ? pid(o.resource_key) : str(o.resource_key),
    resource_label: str(o.resource_label),
    attempt: num(o.attempt),
    max_attempts: num(o.max_attempts),
    next_attempt_at: str(o.next_attempt_at),
    lease_until: str(o.lease_until),
    last_error: err ? { code: str(err.code), message: str(err.message) } : null,
    created_at: str(o.created_at),
    updated_at: str(o.updated_at),
    blocked_reason: str(o.blocked_reason) ?? str(o.waiting_reason),
    ...agnteiAssignmentFields(o),
  }
}
export const normalizeAssignments = (v: unknown): WfAssignment[] => listOf(v, 'assignments').map(normalizeAssignment).filter((a): a is WfAssignment => Boolean(a))

export function normalizeEvent(v: unknown): WfEvent | null {
  const o = obj(v)
  const id = num(o.event_id)
  const type = str(o.type)
  const at = str(o.at) ?? str(o.created_at)
  if (id === null || !type || !at) return null
  return { event_id: id, at, mission_id: str(o.mission_id), assignment_id: str(o.assignment_id), employee_id: str(o.employee_id), type, payload: obj(o.payload) }
}
export const normalizeEvents = (v: unknown): WfEvent[] => listOf(v, 'events').map(normalizeEvent).filter((e): e is WfEvent => Boolean(e))

export function normalizeEventsPage(v: unknown): WfEventsPage {
  const events = normalizeEvents(v)
  const next = num(obj(v).next_after)
  return { events, next_after: next ?? (events.length ? Math.max(...events.map((e) => e.event_id)) : null) }
}

export function normalizeMessage(v: unknown): WfExecMessage | null {
  const o = obj(v)
  const id = str(o.message_id)
  const content = typeof o.content === 'string' ? o.content : null
  if (!id || content === null) return null
  return {
    message_id: id,
    mission_id: str(o.mission_id),
    author: o.author === 'coo' ? 'coo' : 'ceo',
    author_user_id: str(o.author_user_id),
    author_employee_id: str(o.author_employee_id),
    content,
    refs: normalizeRefs(o.refs),
    created_at: str(o.created_at) ?? '',
  }
}
export const normalizeMessages = (v: unknown): WfExecMessage[] => listOf(v, 'messages').map(normalizeMessage).filter((m): m is WfExecMessage => Boolean(m))

export function normalizeCommand(v: unknown): WfCommandResult {
  const o = obj(v)
  return { messages: normalizeMessages(v), mission: o.mission ? normalizeMission(o.mission) : null }
}

const EFFECT_KEYS = ['recorded_in_workforce', 'seller_contacted', 'offer_made', 'stage_changed', 'runtime_job_started', 'work_created'] as const
export function normalizeResolve(v: unknown): WfResolveResult {
  const o = obj(v)
  const out = obj(o.outcome)
  const fx = obj(out.effects)
  // an effect the server did not state is not assumed false: the whole block becomes unknown (null)
  const effects = EFFECT_KEYS.every((k) => typeof fx[k] === 'boolean') ? Object.fromEntries(EFFECT_KEYS.map((k) => [k, fx[k] as boolean])) as unknown as WfDecisionEffects : null
  const d = str(o.decision)
  return {
    assignment: o.assignment ? normalizeAssignment(o.assignment) : null,
    decision: d === 'approve' || d === 'decline' || d === 'done' ? d : null,
    outcome: { headline: str(out.headline), next_step: str(out.next_step), message: str(out.message), effects },
    messages: normalizeMessages(v),
    replayed: o.replayed === true,
  }
}

export function normalizeMissionDetail(v: unknown): WfMissionDetail | null {
  const o = obj(v)
  // { mission, assignments, events } or a mission row that carries them
  const mission = normalizeMission(o.mission ?? o)
  if (!mission) return null
  const host = o.mission ? o : obj(o)
  // the contract says "mission + plan + assignments + events + report": plan / report may ride beside the mission
  if (!mission.plan && host.plan !== undefined) mission.plan = normalizePlan(host.plan)
  if (!mission.report && host.report !== undefined) mission.report = normalizeReport(host.report)
  return { mission, assignments: normalizeAssignments(host.assignments), events: normalizeEvents(host.events).sort((a, b) => a.event_id - b.event_id) }
}

/* ── memory / authority / KPIs ───────────────────────────────────────── */

export function normalizeFact(v: unknown): WfMemoryFact | null {
  const o = obj(v)
  const id = str(o.fact_id)
  const key = str(o.fact_key)
  if (!id || !key) return null
  return {
    fact_id: id, scope: str(o.scope) ?? 'unknown', scope_key: str(o.scope_key), fact_key: key, value: o.value,
    epistemic: str(o.epistemic) ?? 'interpretation', confidence: num(o.confidence), source_refs: normalizeRefs(o.source_refs),
    author_employee_id: str(o.author_employee_id), author_user_id: str(o.author_user_id), valid_from: str(o.valid_from), superseded_at: str(o.superseded_at),
  }
}

export function normalizePolicy(v: unknown): WfPolicy | null {
  const o = obj(v)
  const id = str(o.policy_id)
  const action = str(o.action_key)
  if (!id || !action) return null
  return {
    policy_id: id, role_key: str(o.role_key), employee_id: str(o.employee_id), action_key: action,
    scope: objOrNull(o.scope) as WfPolicy['scope'], limits: objOrNull(o.limits) as WfPolicy['limits'],
    risk: str(o.risk), min_confidence: num(o.min_confidence), review: str(o.review),
    valid_from: str(o.valid_from), valid_until: str(o.valid_until), status: str(o.status) ?? 'unknown', version: num(o.version),
  }
}
const policies = (v: unknown): WfPolicy[] => arr(v).map(normalizePolicy).filter((p): p is WfPolicy => Boolean(p))

export function normalizeKpi(v: unknown): WfKpi | null {
  const o = obj(v)
  const key = str(o.kpi_key)
  if (!key) return null
  const value = num(o.value)
  // unknown is a first-class value: a known status with no number is still unknown
  const status = o.status === 'known' && value !== null ? 'known' : 'unknown'
  return { subject_type: str(o.subject_type) ?? 'org', subject_key: str(o.subject_key) ?? '', kpi_key: key, window: str(o.window), value: status === 'known' ? value : null, status, reason: str(obj(o.source).reason) ?? str(o.reason), computed_at: str(o.computed_at) }
}
export const normalizeKpis = (v: unknown): WfKpi[] => listOf(v, 'kpis').map(normalizeKpi).filter((k): k is WfKpi => Boolean(k))

const flagsOf = (v: unknown): Record<string, boolean | string | null> => Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, typeof x === 'boolean' || typeof x === 'string' ? x : x === null ? null : String(x)]))

export function normalizeOverview(v: unknown): WfOverview {
  const o = obj(v)
  const rt = obj(o.runtime)
  const mbs = obj(o.missions_by_status)
  return {
    departments: arr(o.departments).map(normalizeDepartment).filter((d): d is WfDepartmentSummary => Boolean(d)),
    employees: normalizeEmployees(o.employees),
    missions_by_status: Object.fromEntries(Object.entries(mbs).map(([k, n]) => [k, num(n) ?? 0])),
    last_events: normalizeEvents(o.last_events),
    runtime: { emergency_stop: bool(rt.emergency_stop), last_tick_at: str(rt.last_tick_at), kinds_armed: Array.isArray(rt.kinds_armed) ? strs(rt.kinds_armed) : null, dispatch_enabled: bool(rt.dispatch_enabled), detail: str(rt.detail) },
    flags: flagsOf(o.flags),
  }
}

function normalizeCharter(v: unknown): WfCharter | null {
  if (!v || typeof v !== 'object') return null
  const o = obj(v)
  return { mandate: str(o.mandate), responsibilities: strs(o.responsibilities), kpi_keys: strs(o.kpi_keys), capabilities: strs(o.capabilities), max_tier: str(o.max_tier) }
}

export function normalizeProfile(v: unknown): WfEmployeeProfile | null {
  const o = obj(v)
  const employee = normalizeEmployee(o.employee ?? o)
  if (!employee) return null
  const auth = obj(o.authority)
  const cost = objOrNull(o.cost)
  const today = cost ? num(cost.today_usd) : null
  return {
    employee,
    charter: normalizeCharter(o.charter),
    policies: policies(auth.policies ?? o.policies),
    memory: arr(o.memory).map(normalizeFact).filter((f): f is WfMemoryFact => Boolean(f)),
    assignments: normalizeAssignments(o.assignments),
    kpis: normalizeKpis(o.kpis),
    cost: cost ? { today_usd: today, window_usd: num(cost.window_usd), window: str(cost.window), cap_usd: num(cost.cap_usd) ?? employee.spend_day_cap_usd, status: cost.status === 'known' && today !== null ? 'known' : 'unknown', reason: str(cost.reason) } : null,
    activity: normalizeActivity(o.activity) ?? employee.activity,
    link: normalizeLink(o.link),
    link_steps: normalizeLinkSteps(o.link_steps),
    history: normalizeHistory(o.history, normalizeEvent),
  }
}

function normalizeGrant(v: unknown): WfProposedGrant | null {
  const o = obj(v)
  const action = str(o.action) ?? str(o.action_name) ?? str(o.capability)
  if (!action) return null
  return { agent_id: str(o.agent_id), employee_id: str(o.employee_id), action, scope: objOrNull(o.scope), limits: objOrNull(o.limits), from_policy_id: str(o.from_policy_id) ?? str(o.policy_id), note: str(o.note) ?? str(o.reason) }
}

function normalizeRestriction(v: unknown): WfRestriction | null {
  const o = obj(v)
  const label = str(o.label) ?? str(o.subject)
  if (!label) return null
  return { kind: str(o.kind) ?? 'hold', label, reason: str(o.reason), refs: normalizeRefs(o.refs), since: str(o.since) }
}

export function normalizeSettings(v: unknown): WfSettings | null {
  if (!v || typeof v !== 'object') return null
  const o = obj(v)
  return { exec_review_price_usd: num(o.exec_review_price_usd), escalation: objOrNull(o.escalation) }
}

export function normalizeAuthority(v: unknown): WfAuthority {
  const o = obj(v)
  const em = objOrNull(o.emergency)
  return {
    policies: policies(o.policies),
    settings: normalizeSettings(o.settings),
    proposed_grants: arr(o.proposed_grants).map(normalizeGrant).filter((g): g is WfProposedGrant => Boolean(g)),
    restrictions: arr(o.restrictions).map(normalizeRestriction).filter((r): r is WfRestriction => Boolean(r)),
    emergency: em ? { stop: bool(em.stop), reason: str(em.reason), since: str(em.since) } : null,
    flags: flagsOf(o.flags),
  }
}

export function normalizeReports(v: unknown): WfReports {
  const o = obj(v)
  const brief = objOrNull(o.daily_brief)
  return {
    reports: arr(o.reports).map((r): WfReportEntry | null => {
      const x = obj(r)
      const id = str(x.mission_id)
      return id ? { mission_id: id, title: str(x.title) ?? 'Mission report', status: str(x.status), completed_at: str(x.completed_at), report: normalizeReport(x.report) } : null
    }).filter((r): r is WfReportEntry => Boolean(r)),
    daily_brief: brief ? { available: brief.available !== false, generated_at: str(brief.generated_at), summary: str(brief.summary), items: strs(brief.items), code: str(brief.code) } : null,
  }
}
