// The API response layer (docs/WORKFORCE.md §7 + the dashboard's §8 implementation notes). Pure.
//
// Stored jsonb never carries a *_key key (agent.payload_is_clean), so plans and reports are stored as
// { step, capability, … }; the RESPONSE maps them to the dashboard's shapes ({ step_key, capability_key,
// label, … }). Record refs become { type, id, label, property_id?, opportunity_id? } with property ids
// decoded for linking. A thread ref's id is the inbox thread id (inbox_thread_state.id): Workforce never
// returns a thread key, a phone, an email or a message body. Unknown stays unknown (null + a reason).
import { decodePropertyRef, decodeKey } from '../agent/missions/mission-codec.js'
import { label as intentLabel } from './coo/interpret.js'
import { reportMessage } from './coo/respond.js'
import { OPEN_ASSIGNMENT_STATES } from './coo/staffing.js'
import { DEPARTMENTS, ROLE_CHARTERS, charterFor } from './org/charters.js'
import { assignmentActivity } from './agntei/activity.js'

const REF_TYPES = new Set(['property', 'thread', 'opportunity', 'job', 'assignment', 'mission', 'employee', 'market'])
const pid = (v) => (v == null ? null : String(decodePropertyRef(String(v))))
const humanize = (s) => String(s || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()

export const CAPABILITY_LABELS = Object.freeze({
  'intel.active_opportunities': 'Find live opportunities',
  'intel.conversation_state': 'Read the conversation',
  'intel.acquisition_decision': 'Read the Decision Engine row',
  'finance.review_opportunity': 'CFO review',
  'research.property': 'Property research',
  'acq.rank_opportunities': 'Rank opportunities',
  'acq.next_action': 'Next action',
  'work.assign': 'Delegate follow-up',
  'ops.raise_work_item': 'Raise an operator work item',
  'memory.assert': 'Record to memory',
})
export const capabilityLabel = (k) => CAPABILITY_LABELS[k] || humanize(k)
/** Stored text carries pid_ refs (a raw id can look like a phone run to the payload check); a response decodes them. */
export const decodeText = (t) => (typeof t === 'string' ? decodeKey(t) : t)
const propertyLabel = (ref) => (ref ? `Property ${pid(ref)}` : null)

/** One ref in the dashboard shape, from any stored form ({type,id} / {source,job_id} / a pid string). */
export function presentRef(r) {
  if (!r) return null
  if (typeof r === 'string') return /^pid_/.test(r) ? { type: 'property', id: pid(r), label: propertyLabel(r), property_id: pid(r) } : null
  const type = r.type === 'memory_fact' ? null : r.type === 'service' || r.type === 'rule' ? null : r.type
  if (r.job_id && !type) return { type: 'job', id: String(r.job_id), label: 'Runtime job' }
  if (!type || !REF_TYPES.has(type) || r.id == null) return null
  if (type === 'property') return { type, id: pid(r.id), label: r.label ?? propertyLabel(r.id), property_id: pid(r.id) }
  return { type, id: String(r.id), label: r.label ?? null }
}
export const presentRefs = (xs) => (Array.isArray(xs) ? xs.map(presentRef).filter(Boolean) : [])

/** A report item's stored refs object { property_ref, opportunity_id, conversation_id, job_id, assignment_id } → refs[]. */
export function refsFromIds(o = {}) {
  const p = o.property_ref ? pid(o.property_ref) : null
  const out = []
  if (p) out.push({ type: 'property', id: p, label: `Property ${p}`, property_id: p, ...(o.opportunity_id ? { opportunity_id: o.opportunity_id } : {}) })
  if (o.conversation_id) out.push({ type: 'thread', id: o.conversation_id, label: 'Conversation', ...(p ? { property_id: p } : {}) })
  if (o.opportunity_id) out.push({ type: 'opportunity', id: o.opportunity_id, label: 'Opportunity', ...(p ? { property_id: p } : {}) })
  if (o.job_id) out.push({ type: 'job', id: o.job_id, label: 'Research job' })
  if (o.assignment_id) out.push({ type: 'assignment', id: o.assignment_id, label: 'Assignment' })
  if (o.rank_assignment_id) out.push({ type: 'assignment', id: o.rank_assignment_id, label: 'Ranking' })
  return out
}

const FAN_OUT = /^(conv|dec|res|fin)\.c\d+$|^(next|assign)\.\d+$/
export function presentPlan(plan) {
  if (!plan || !Array.isArray(plan.steps)) return null
  const steps = plan.steps.map((s) => ({
    step_key: s.step,
    capability_key: s.capability,
    label: capabilityLabel(s.capability),
    assignee_role: s.role ?? null,
    assignee_employee_id: s.assignee_employee_id ?? null,
    depends_on: s.depends_on || [],
    fan_out: FAN_OUT.test(String(s.step)),
    unavailable_reason: s.unstaffed ? 'no active employee holds this role' : null,
  }))
  for (const u of plan.unavailable || []) steps.push({ step_key: `unavailable:${u.capability}`, capability_key: u.capability, label: humanize(u.capability), assignee_role: null, assignee_employee_id: null, depends_on: [], fan_out: false, unavailable_reason: u.reason })
  return { steps, intent: plan.intent ?? null, params: plan.params ?? null, expansions: plan.expansions ?? null, version: plan.version ?? null }
}

/** Why an assignment is not moving, in words. */
export function blockedReason(a, inactive = new Map()) {
  if (a.status === 'waiting_approval') return a.input?.task ? `In the CEO queue: ${humanize(a.input.task)}` : 'Awaiting a person'
  if (a.status === 'blocked') return a.last_error?.code ? humanize(String(a.last_error.code).toLowerCase()) : 'Blocked'
  if (['pending', 'ready'].includes(a.status) && inactive.has(a.assignee_employee_id)) return `Assignee ${inactive.get(a.assignee_employee_id)}`
  if (a.status === 'waiting_job') return 'Waiting on a runtime job'
  if (['pending', 'ready'].includes(a.status) && a.execution_mode === 'external') return 'Waiting for its Agntei agent to claim it'
  return null
}

export function presentAssignment(a, { inactive = new Map(), employees = null, now = Date.now() } = {}) {
  if (!a) return null
  const out = { ...a }
  out.execution_mode = a.execution_mode ?? 'internal'
  // the truthful activity (agntei/activity.js): "Waiting for Scout (Agntei), last seen 3 min ago"
  out.activity = employees ? assignmentActivity(a, { employee: employees.get(a.assignee_employee_id) || null, now }) : null
  out.resource_key = a.resource_type === 'property' ? pid(a.resource_key) : a.resource_key
  out.resource_label = a.input?.property_ref ? propertyLabel(a.input.property_ref) : null
  out.blocked_reason = blockedReason(a, inactive)
  out.evidence = presentRefs(a.evidence)
  out.label = capabilityLabel(a.capability_key)
  delete out.lease_token
  return out
}

function itemLabel(i) {
  const what = capabilityLabel(i.capability || i.what)
  const p = i.refs?.property_ref ? ` · Property ${pid(i.refs.property_ref)}` : ''
  return `${what}${p}`
}
function presentItem(i, status) {
  return {
    label: itemLabel(i),
    assignment_id: i.assignment_id ?? null,
    step_key: i.step ?? null,
    status: i.status ?? status,
    refs: refsFromIds({ ...(i.refs || {}), assignment_id: i.refs?.assignment_id ?? i.assignment_id ?? null }),
    reasons: i.reasons || (i.reason ? [i.reason] : []),
    detail: i.summary ? JSON.stringify(i.summary).slice(0, 400) : i.review ? `review: ${i.review}` : null,
    ...(i.ceo_assignment_id ? { ceo_assignment_id: i.ceo_assignment_id } : {}),
    ...(i.queue ? { queue: i.queue } : {}),
  }
}

const scaled = (c, max) => (c?.status === 'known' && c.value != null ? Math.round(Math.min(Math.max(c.value / max, 0), 1) * 1000) / 1000 : null)
export function presentRanked(r, { assignments = [] } = {}) {
  const fin = assignments.find((a) => a.capability_key === 'finance.review_opportunity' && a.input?.property_ref === r.refs?.property_ref && a.status === 'completed')
  const next = assignments.find((a) => a.assignment_id === r.next_assignment_id)
  const ev = r.ev || { status: 'unknown', value: null }
  return {
    rank: r.rank,
    label: propertyLabel(r.refs?.property_ref),
    market: assignments.find((a) => a.input?.property_ref === r.refs?.property_ref && a.input?.market)?.input?.market ?? null,
    refs: refsFromIds(r.refs || {}),
    components: {
      contact: scaled(r.components?.contact_identity, 3),
      pressure: scaled(r.components?.pressure, 6),
      deal_quality: scaled(r.components?.deal_quality, 21),
      ev_usd: ev.status === 'known' ? ev.value : null,
      ev_reason: ev.status === 'known' ? `p_close ${ev.basis?.p_close} × ${ev.basis?.net_source}` : `unknown: missing ${(ev.missing || ['calibrated inputs']).join(', ')}`,
      contact_raw: r.components?.contact_identity?.value ?? null,
      pressure_raw: r.components?.pressure?.value ?? null,
      deal_quality_raw: r.components?.deal_quality?.value ?? null,
    },
    cfo_verdict: r.cfo_verdict ? { verdict: r.cfo_verdict, reasons: fin?.output?.reasons || [] } : (r.escalated ? { verdict: null, reasons: ['escalated to the CEO'] } : null),
    next_action: { action: r.next_action ?? null, reason: r.next_action ? (next?.output?.reasons || []).join(', ') || null : humanize(r.next_action_status) },
    next_action_reason: r.next_action ? (next?.output?.reasons || []).join(', ') || null : humanize(r.next_action_status),
    assignment_id: r.next_assignment_id ?? null,
    follow_on_assignment_id: r.follow_on_assignment_id ?? null,
  }
}

export function presentCosts(c, assignments = []) {
  if (!c) return { total_usd: null, status: 'unknown', reason: 'no cost record', by_job: [] }
  const byJob = (c.by_job || []).map((j) => ({ runtime_job_id: j.job_id, kind: 'property.research', assignment_id: assignments.find((a) => a.runtime_job_id === j.job_id)?.assignment_id ?? null, usd: j.committed_usd }))
  if (c.status === 'known') return { total_usd: c.total_usd, status: 'known', reason: byJob.length ? null : 'no paid step ran (inline reads cost nothing)', by_job: byJob }
  return { total_usd: null, status: 'unknown', reason: c.status === 'partial' ? 'some job costs could not be read' : 'job costs could not be read', by_job: byJob, ...(c.total_usd != null ? { known_floor_usd: c.total_usd } : {}) }
}

export function presentReport(report, { mission = null, assignments = [] } = {}) {
  if (!report) return null
  if (!Array.isArray(report.completed)) return { ...report, summary: report.state ? humanize(report.state) : null, generated_at: report.generated_at ?? null, completed: [], pending: [], escalations: [], refused: [], unknowns: [], ranked: [], costs: { total_usd: null, status: 'unknown', reason: 'no steps ran', by_job: [] } }
  return {
    summary: mission ? decodeText(reportMessage({ mission, report }).content) : null,
    generated_at: report.generated_at ?? null,
    state: report.state ?? null,
    counts: report.counts ?? null,
    completed: report.completed.map((i) => presentItem(i, 'completed')),
    pending: report.pending.map((i) => presentItem(i, i.status)),
    escalations: report.escalations.map((i) => presentItem(i, 'escalated')),
    refused: report.refused.map((i) => presentItem(i, 'refused')),
    unknowns: report.unknowns.map((i) => presentItem(i, 'unknown')),
    ranked: (report.ranked || []).map((r) => presentRanked(r, { assignments })),
    costs: presentCosts(report.costs, assignments),
    unavailable: report.unavailable || [],
  }
}

export function assignmentCounts(assignments = []) {
  const c = {}
  for (const a of assignments) c[a.status] = (c[a.status] || 0) + 1
  return c
}

export function presentMission(m, { assignments = null } = {}) {
  if (!m) return null
  return {
    ...m,
    plan: presentPlan(m.plan),
    report: presentReport(m.report, { mission: m, assignments: assignments || [] }),
    intent_label: m.plan?.intent ? intentLabel(m.plan.intent) : null,
    ...(assignments ? { assignment_counts: assignmentCounts(assignments) } : {}),
  }
}

export function presentDepartments(employees = [], assignments = []) {
  const open = new Map()
  for (const a of assignments) if (OPEN_ASSIGNMENT_STATES.includes(a.status)) open.set(a.assignee_employee_id, (open.get(a.assignee_employee_id) || 0) + 1)
  return DEPARTMENTS.map((d) => {
    const staff = employees.filter((e) => e.department_key === d)
    const head = staff.find((e) => /^(head_|ceo$|cfo$|ops_supervisor$)/.test(e.role_key)) || null
    return { department_key: d, head_employee_id: head?.employee_id ?? null, employee_count: staff.length, open_assignments: staff.reduce((n, e) => n + (open.get(e.employee_id) || 0), 0) }
  })
}

export function presentCharter(role_key) {
  const c = charterFor(role_key)
  return c ? { role_key: c.role_key, title: c.title, department_key: c.department_key, mandate: c.mandate, responsibilities: [...c.responsibilities], kpi_keys: [...c.kpis], capabilities: [...c.capabilities], max_tier: c.tier_ceiling, market_scoped: c.market_scoped } : null
}
export const presentCharters = () => Object.fromEntries(Object.keys(ROLE_CHARTERS).map((k) => [k, presentCharter(k)]))

export function presentGrant(g) {
  return { agent_id: g.agent_id, employee_id: g.employee_id, action: g.capability, scope: g.scope, limits: { per_day: g.max_uses_per_day, max_usd: g.max_spend_usd_per_day, envelope: g.envelope }, from_policy_id: g.source_policy_id, note: g.grant_needed ? g.reason : 'internal capability: no Action Gateway grant needed', display_only: true }
}

/** Runtime health from the R2 runtime status (limits + heartbeats + schedules); unknown when unreadable. */
export function presentRuntime(status, kinds = []) {
  if (!status) return { emergency_stop: null, last_tick_at: null, kinds_armed: null, dispatch_enabled: null, detail: 'runtime status unavailable' }
  const lim = status.limits || {}
  const kl = lim.kind_limits || {}
  const ticks = (status.heartbeats || []).map((h) => h.last_tick_at).filter(Boolean).sort()
  const sched = (status.schedules || []).find((s) => s.name === 'workforce-dispatch')
  return {
    emergency_stop: lim.emergency_stop === true,
    last_tick_at: ticks.length ? ticks[ticks.length - 1] : null,
    kinds_armed: kinds.filter((k) => kl[k]?.armed_by && kl[k]?.enabled === true),
    dispatch_enabled: sched ? sched.enabled === true : false,
    detail: lim.runtime_enabled === false ? 'runtime disabled' : null,
    runtime_enabled: lim.runtime_enabled === true,
  }
}
