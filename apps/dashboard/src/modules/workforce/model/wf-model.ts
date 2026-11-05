/**
 * WORKFORCE — view model. Pure functions over the normalized §7 bodies.
 *
 * Honesty rules (§6) live here so they are testable: an unknown stays
 * unknown (never 0), progress counts only terminal-success as done, a
 * "completed" mission never claims a step that did not complete, and a cost
 * total exists only when every line is known.
 */
import type { LCStateKey, LCTone } from '../../../shared/lc'
import type { IconName } from '../../../shared/icons'
import type {
  WfAssignment, WfAssignmentStatus, WfCfoVerdict, WfEmployee, WfEvent, WfKpi, WfMemoryFact, WfMission, WfNextAction,
  WfPlan, WfPlanStep, WfRankedItem, WfRef, WfReport, WfReportEntry, WfReportItem, WfDepartmentSummary,
} from '../api/wf-types'

/* ── org ──────────────────────────────────────────────────────────────── */

export const DEPARTMENT_META: Record<string, { label: string; order: number; head: string[] }> = {
  executive: { label: 'Executive', order: 0, head: ['ceo'] },
  finance: { label: 'Finance', order: 1, head: ['cfo'] },
  acquisitions: { label: 'Acquisitions', order: 2, head: ['head_acquisitions'] },
  marketing: { label: 'Marketing', order: 3, head: ['head_marketing'] },
  dispositions: { label: 'Dispositions', order: 4, head: ['head_dispositions'] },
  data_intelligence: { label: 'Data Intelligence', order: 5, head: ['head_data_intelligence'] },
  operations: { label: 'Operations and Quality', order: 6, head: ['ops_supervisor'] },
}
export const departmentLabel = (k: string) => DEPARTMENT_META[k]?.label ?? humanize(k)

export const ROLE_LABEL: Record<string, string> = {
  ceo: 'Chief Executive', coo: 'Chief Operating Officer', cfo: 'Chief Financial Officer',
  head_acquisitions: 'Head of Acquisitions', acquisition_agent: 'Acquisition Agent',
  head_marketing: 'Head of Marketing', campaign_manager: 'Campaign Manager',
  head_dispositions: 'Head of Dispositions', dispositions_agent: 'Dispositions Agent',
  head_data_intelligence: 'Head of Data Intelligence', research_analyst: 'Research Analyst',
  ops_supervisor: 'Operations and Quality Supervisor', human_staff: 'Staff',
}
export const roleLabel = (k: string) => ROLE_LABEL[k] ?? humanize(k)

export function humanize(k: string): string {
  const s = String(k || '').replace(/^wf\./, '').replace(/[._]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : 'Unknown'
}

export interface OrgDepartment {
  key: string
  label: string
  head: WfEmployee | null
  members: WfEmployee[]
  headcount: number
  ai: number
  human: number
  /** null when no member reports a count */
  open: number | null
}

/**
 * Departments → heads → agents. The head is the summary's head_employee_id,
 * else the department's head role, else nobody (shown as a vacancy). Every
 * known department is listed even when empty; an unknown department key the
 * server sends is kept (sorted last), never dropped.
 */
export function buildOrgTree(employees: ReadonlyArray<WfEmployee>, summaries: ReadonlyArray<WfDepartmentSummary> = []): OrgDepartment[] {
  const live = employees.filter((e) => e.status !== 'retired')
  const keys = new Set<string>([...Object.keys(DEPARTMENT_META), ...live.map((e) => e.department_key)])
  const out: OrgDepartment[] = []
  for (const key of keys) {
    const inDept = live.filter((e) => e.department_key === key)
    const sum = summaries.find((s) => s.department_key === key)
    const headRoles = DEPARTMENT_META[key]?.head ?? []
    const head = (sum?.head_employee_id ? inDept.find((e) => e.employee_id === sum.head_employee_id) : null)
      ?? inDept.find((e) => headRoles.includes(e.role_key))
      ?? null
    const members = inDept.filter((e) => e !== head).sort((a, b) => rankRole(a.role_key) - rankRole(b.role_key) || (a.employee_code ?? a.display_name).localeCompare(b.employee_code ?? b.display_name))
    const counts = inDept.map((e) => e.open_assignments).filter((n): n is number => n !== null)
    out.push({
      key,
      label: departmentLabel(key),
      head,
      members,
      headcount: inDept.length,
      ai: inDept.filter((e) => e.kind === 'ai').length,
      human: inDept.filter((e) => e.kind === 'human').length,
      open: sum?.open_assignments ?? (counts.length ? counts.reduce((a, b) => a + b, 0) : null),
    })
  }
  return out.sort((a, b) => (DEPARTMENT_META[a.key]?.order ?? 99) - (DEPARTMENT_META[b.key]?.order ?? 99) || a.label.localeCompare(b.label))
}
const ROLE_ORDER = ['ceo', 'coo', 'cfo', 'head_acquisitions', 'head_marketing', 'head_dispositions', 'head_data_intelligence', 'ops_supervisor', 'acquisition_agent', 'campaign_manager', 'dispositions_agent', 'research_analyst', 'human_staff']
const rankRole = (r: string) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? 99 : i }

export type Heartbeat = 'live' | 'stale' | 'silent' | 'never'
/** live ≤ 3 min · stale ≤ 30 min · silent beyond · never = no heartbeat recorded (humans have none). */
export function heartbeatOf(e: Pick<WfEmployee, 'heartbeat_at'>, now: number): Heartbeat {
  const t = e.heartbeat_at ? Date.parse(e.heartbeat_at) : NaN
  if (!Number.isFinite(t)) return 'never'
  const age = now - t
  if (age <= 3 * 60_000) return 'live'
  if (age <= 30 * 60_000) return 'stale'
  return 'silent'
}
export const HEARTBEAT_META: Record<Heartbeat, { label: string; tone: LCTone }> = {
  live: { label: 'Live', tone: 'ok' },
  stale: { label: 'Delayed', tone: 'attn' },
  silent: { label: 'Silent', tone: 'crit' },
  never: { label: 'No heartbeat', tone: 'neutral' },
}

export const EMPLOYEE_STATUS_STATE: Record<string, { label: string; tone: LCTone }> = {
  active: { label: 'Active', tone: 'ok' },
  paused: { label: 'Paused', tone: 'attn' },
  retired: { label: 'Retired', tone: 'neutral' },
}

export const employeeName = (id: string | null | undefined, byId: ReadonlyMap<string, WfEmployee>): string =>
  (id ? byId.get(id)?.display_name ?? id : 'Unassigned')

/* ── assignments ─────────────────────────────────────────────────────── */

export const ASSIGNMENT_META: Record<WfAssignmentStatus, { label: string; state: LCStateKey | null; tone: LCTone; group: AssignmentGroup }> = {
  pending: { label: 'Pending', state: null, tone: 'neutral', group: 'queued' },
  ready: { label: 'Ready', state: 'ready', tone: 'ok', group: 'queued' },
  leased: { label: 'Claimed', state: 'system_handling', tone: 'exec', group: 'active' },
  running: { label: 'Running', state: 'running', tone: 'exec', group: 'active' },
  waiting_job: { label: 'Waiting on job', state: 'waiting_provider', tone: 'neutral', group: 'waiting' },
  waiting_approval: { label: 'Needs approval', state: 'needs_you', tone: 'attn', group: 'waiting' },
  blocked: { label: 'Blocked', state: 'blocked', tone: 'crit', group: 'blocked' },
  completed: { label: 'Completed', state: 'done', tone: 'ok', group: 'done' },
  failed: { label: 'Failed', state: 'failed', tone: 'crit', group: 'failed' },
  cancelled: { label: 'Cancelled', state: 'inactive', tone: 'neutral', group: 'done' },
}
export type AssignmentGroup = 'active' | 'queued' | 'waiting' | 'blocked' | 'failed' | 'done'
export const ASSIGNMENT_GROUPS: ReadonlyArray<{ id: AssignmentGroup; label: string }> = [
  { id: 'active', label: 'Working' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'queued', label: 'Queued' },
  { id: 'failed', label: 'Failed' },
  { id: 'done', label: 'Finished' },
]
export const assignmentMeta = (s: string) => ASSIGNMENT_META[s as WfAssignmentStatus] ?? { label: humanize(s), state: null, tone: 'neutral' as LCTone, group: 'queued' as AssignmentGroup }
export const isTerminalAssignment = (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled'

const time = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null }

/** Why an assignment is not moving, in words. Null when it is moving or finished cleanly. */
export function waitingReason(a: WfAssignment): string | null {
  switch (a.status) {
    case 'waiting_job': return a.blocked_reason ?? (a.runtime_job_id ? `Waiting on runtime job ${a.runtime_job_id}` : 'Waiting on a runtime job')
    case 'waiting_approval': return a.blocked_reason ?? 'Waiting on an approval'
    case 'blocked': return a.blocked_reason ?? a.last_error?.message ?? 'Blocked, no reason recorded'
    case 'pending': return a.depends_on.length ? `Waiting on ${a.depends_on.join(', ')}` : null
    case 'failed': return a.last_error?.message ?? a.last_error?.code ?? 'Failed, no error recorded'
    case 'ready': {
      if ((a.attempt ?? 1) > 1) {
        const at = time(a.next_attempt_at)
        return `Retry ${a.attempt}${a.max_attempts ? ` of ${a.max_attempts}` : ''}${at ? ` at ${at}` : ''}`
      }
      return null
    }
    default: return null
  }
}

/** The record an assignment works on, as a ref (property / thread / opportunity), or null. */
export function resourceRef(a: Pick<WfAssignment, 'resource_type' | 'resource_key' | 'resource_label'>): WfRef | null {
  if (!a.resource_key) return null
  const t = a.resource_type === 'property' ? 'property' : a.resource_type === 'thread' ? 'thread' : a.resource_type === 'opportunity' ? 'opportunity' : null
  return t ? { type: t, id: a.resource_key, label: a.resource_label } : null
}

/** A recovery: an assignment that failed at least once and was re-queued (reap or retry), or is retrying now. */
export const isRecovery = (a: WfAssignment) => (a.attempt ?? 1) > 1 && !(a.status === 'failed' && (a.attempt ?? 0) >= (a.max_attempts ?? Infinity))

export interface Progress { total: number; done: number; active: number; waiting: number; blocked: number; failed: number; queued: number; cancelled: number; pct: number | null }
const EMPTY_PROGRESS: Progress = { total: 0, done: 0, active: 0, waiting: 0, blocked: 0, failed: 0, queued: 0, cancelled: 0, pct: null }

/** Done counts only `completed`. pct is null when there are no assignments yet (planning), never 0%. */
export function progressOf(source: ReadonlyArray<Pick<WfAssignment, 'status'>> | Partial<Record<string, number>> | null | undefined): Progress {
  if (!source) return { ...EMPTY_PROGRESS }
  const counts: Record<string, number> = {}
  if (Array.isArray(source)) for (const a of source) counts[a.status] = (counts[a.status] ?? 0) + 1
  else for (const [k, n] of Object.entries(source as Record<string, number>)) counts[k] = n ?? 0
  const p: Progress = { ...EMPTY_PROGRESS }
  for (const [s, n] of Object.entries(counts)) {
    p.total += n
    if (s === 'cancelled') { p.cancelled += n; continue }
    const g = assignmentMeta(s).group
    if (g === 'done') p.done += n
    else if (g === 'active') p.active += n
    else if (g === 'waiting') p.waiting += n
    else if (g === 'blocked') p.blocked += n
    else if (g === 'failed') p.failed += n
    else p.queued += n
  }
  const denom = p.total - p.cancelled
  p.pct = denom > 0 ? Math.round((p.done / denom) * 100) : null
  return p
}

/* ── missions ────────────────────────────────────────────────────────── */

export const MISSION_META: Record<string, { label: string; tone: LCTone; state: LCStateKey | null }> = {
  planning: { label: 'Planning', tone: 'exec', state: 'system_handling' },
  active: { label: 'Active', tone: 'exec', state: 'running' },
  waiting: { label: 'Waiting', tone: 'neutral', state: null },
  blocked: { label: 'Blocked', tone: 'crit', state: 'blocked' },
  completed: { label: 'Completed', tone: 'ok', state: 'done' },
  failed: { label: 'Failed', tone: 'crit', state: 'failed' },
  cancelled: { label: 'Cancelled', tone: 'neutral', state: 'inactive' },
}
export const missionMeta = (s: string) => MISSION_META[s] ?? { label: humanize(s), tone: 'neutral' as LCTone, state: null }
export const isTerminalMission = (s: string) => s === 'completed' || s === 'failed' || s === 'cancelled'

export const INTENT_LABEL: Record<string, string> = {
  opportunity_triage: 'Opportunity triage',
  market_diagnosis: 'Market diagnosis',
  conversation_revival: 'Conversation revival',
  offer_activity: 'Offer activity',
  status_review: 'Status review',
  unknown: 'Needs clarification',
}
export const intentLabel = (k: string | null | undefined) => (k ? INTENT_LABEL[k] ?? humanize(k) : 'Not interpreted yet')

/* ── the plan DAG ────────────────────────────────────────────────────── */

export interface DagNode {
  step: WfPlanStep
  depth: number
  assignments: WfAssignment[]
  progress: Progress
  /** the node's one state, from its assignments (or the plan's own honesty) */
  state: 'idle' | 'queued' | 'active' | 'waiting' | 'blocked' | 'failed' | 'done' | 'unavailable'
}

/** Assignments belong to a step by step_key, or by a fan-out suffix (step.1, step:pid). */
export const belongsToStep = (a: Pick<WfAssignment, 'step_key'>, stepKey: string) => a.step_key === stepKey || a.step_key.startsWith(`${stepKey}.`) || a.step_key.startsWith(`${stepKey}:`)

/** Layered by longest dependency path; a cycle or a dangling dependency never loops (depth capped). */
export function planDag(plan: WfPlan | null, assignments: ReadonlyArray<WfAssignment>): DagNode[][] {
  const steps = plan?.steps ?? []
  const byKey = new Map(steps.map((s) => [s.step_key, s]))
  const depth = new Map<string, number>()
  const visit = (k: string, guard: number): number => {
    if (depth.has(k)) return depth.get(k)!
    const s = byKey.get(k)
    if (!s || guard > steps.length) return 0
    const d = s.depends_on.filter((x) => byKey.has(x)).reduce((m, x) => Math.max(m, visit(x, guard + 1) + 1), 0)
    depth.set(k, d)
    return d
  }
  steps.forEach((s) => visit(s.step_key, 0))
  const layers: DagNode[][] = []
  for (const s of steps) {
    const mine = assignments.filter((a) => belongsToStep(a, s.step_key))
    const progress = progressOf(mine)
    const d = depth.get(s.step_key) ?? 0
    ;(layers[d] ??= []).push({ step: s, depth: d, assignments: mine, progress, state: nodeState(s, progress) })
  }
  return layers.filter(Boolean)
}
function nodeState(s: WfPlanStep, p: Progress): DagNode['state'] {
  if (s.unavailable_reason) return 'unavailable'
  if (!p.total) return 'idle'
  if (p.failed && !p.active && !p.queued && !p.waiting) return 'failed'
  if (p.blocked) return 'blocked'
  if (p.active) return 'active'
  if (p.waiting) return 'waiting'
  if (p.queued) return 'queued'
  if (p.done) return 'done'
  return 'idle'
}

export const CAPABILITY_LABEL: Record<string, string> = {
  'intel.active_opportunities': 'Active opportunities',
  'intel.conversation_state': 'Conversation state',
  'intel.acquisition_decision': 'Acquisition decision',
  'finance.review_opportunity': 'CFO review',
  'research.property': 'Property research',
  'acq.rank_opportunities': 'Rank opportunities',
  'acq.next_action': 'Next action',
  'work.assign': 'Assign work',
  'ops.raise_work_item': 'Raise work item',
  'memory.assert': 'Record to memory',
}
export const capabilityLabel = (k: string) => CAPABILITY_LABEL[k] ?? humanize(k)

/* ── report, ranking, finance ────────────────────────────────────────── */

export const VERDICT_META: Record<WfCfoVerdict, { label: string; tone: LCTone }> = {
  supported: { label: 'Supported', tone: 'ok' },
  challenge: { label: 'Challenged', tone: 'attn' },
  insufficient_evidence: { label: 'Insufficient evidence', tone: 'neutral' },
}
export const verdictMeta = (v: string | null | undefined) => (v && v in VERDICT_META ? VERDICT_META[v as WfCfoVerdict] : { label: 'No CFO review', tone: 'neutral' as LCTone })

export const NEXT_ACTION_META: Record<WfNextAction, { label: string; icon: IconName }> = {
  research: { label: 'Research', icon: 'search' },
  underwrite: { label: 'Underwrite', icon: 'stats' },
  await_seller: { label: 'Await seller', icon: 'clock' },
  prepare_offer_recommendation: { label: 'Prepare offer recommendation', icon: 'file-text' },
  operator_review: { label: 'Operator review', icon: 'user' },
  hold: { label: 'Hold', icon: 'pause' },
  none: { label: 'No action', icon: 'slash' },
}
export const nextActionMeta = (k: string | null | undefined) => (k && k in NEXT_ACTION_META ? NEXT_ACTION_META[k as WfNextAction] : { label: k ? humanize(k) : 'Not decided', icon: 'more' as IconName })

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
export function usd(n: number | null | undefined, cents = false): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  if (!cents && Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`
  if (!cents && Math.abs(n) >= 10_000) return `$${Math.round(n / 1000)}K`
  return (cents ? USD2 : USD0).format(n)
}

/** A score component 0..1 or 0..100 → 0..100, or null. */
export function score100(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  return Math.round(v <= 1 && v >= 0 ? v * 100 : v)
}

export interface ReportTotals { completed: number; pending: number; escalations: number; refused: number; unknowns: number; ranked: number }
export const reportTotals = (r: WfReport | null): ReportTotals | null =>
  r ? { completed: r.completed.length, pending: r.pending.length, escalations: r.escalations.length, refused: r.refused.length, unknowns: r.unknowns.length, ranked: r.ranked.length } : null

/**
 * The §6 honesty check, applied on the client too: a report item that claims
 * "completed" for an assignment the detail shows as non-terminal-success is
 * moved to pending (and flagged), so the UI never shows a claim the data
 * contradicts.
 */
export function reconcileReport(r: WfReport, assignments: ReadonlyArray<WfAssignment>): { report: WfReport; contradictions: string[] } {
  if (!assignments.length) return { report: r, contradictions: [] }
  const byId = new Map(assignments.map((a) => [a.assignment_id, a]))
  const contradictions: string[] = []
  const completed: WfReportItem[] = []
  const pending = [...r.pending]
  for (const it of r.completed) {
    const a = it.assignment_id ? byId.get(it.assignment_id) : null
    if (a && a.status !== 'completed') {
      contradictions.push(`${it.label}: reported completed, assignment is ${assignmentMeta(a.status).label.toLowerCase()}`)
      pending.push({ ...it, status: a.status })
    } else completed.push(it)
  }
  return { report: { ...r, completed, pending }, contradictions }
}

export interface VerdictCounts { supported: number; challenge: number; insufficient_evidence: number; none: number }
export function verdictCounts(ranked: ReadonlyArray<WfRankedItem>): VerdictCounts {
  const c: VerdictCounts = { supported: 0, challenge: 0, insufficient_evidence: 0, none: 0 }
  for (const r of ranked) {
    const v = r.cfo_verdict?.verdict
    if (v) c[v] += 1
    else c.none += 1
  }
  return c
}

/** EV known for k of n; a sum only over known values, labelled as such. */
export function evSummary(ranked: ReadonlyArray<WfRankedItem>): { known: number; total: number; sum: number | null } {
  const vals = ranked.map((r) => r.components.ev_usd).filter((v): v is number => v !== null)
  return { known: vals.length, total: ranked.length, sum: vals.length ? vals.reduce((a, b) => a + b, 0) : null }
}

export interface CostRollup { known: number; unknown: number; total_usd: number | null; missions: Array<{ mission_id: string; title: string; usd: number | null; reason: string | null; at: string | null }> }
/** Costs from report.costs only. The total exists only when EVERY mission's cost is known. */
export function costRollup(reports: ReadonlyArray<WfReportEntry>): CostRollup {
  const missions = reports.map((r) => ({
    mission_id: r.mission_id,
    title: r.title,
    usd: r.report?.costs?.status === 'known' ? r.report.costs.total_usd : null,
    reason: !r.report ? 'No report yet' : !r.report.costs ? 'The report carries no cost section' : r.report.costs.status === 'unknown' ? r.report.costs.reason ?? 'Spend ledger not linked' : null,
    at: r.completed_at,
  }))
  const known = missions.filter((m) => m.usd !== null).length
  return { known, unknown: missions.length - known, total_usd: missions.length && known === missions.length ? missions.reduce((a, m) => a + (m.usd ?? 0), 0) : null, missions }
}

/** The latest report of the triage playbook (the Intelligence section's source). */
export function latestTriage(reports: ReadonlyArray<WfReportEntry>, missions: ReadonlyArray<WfMission> = []): WfReportEntry | null {
  const triageIds = new Set(missions.filter((m) => m.playbook_key === 'opportunity_triage' || m.objective?.intent === 'opportunity_triage').map((m) => m.mission_id))
  const withRanked = reports.filter((r) => r.report && r.report.ranked.length && (triageIds.size === 0 || triageIds.has(r.mission_id)))
  return withRanked.sort((a, b) => Date.parse(b.completed_at ?? b.report?.generated_at ?? '') - Date.parse(a.completed_at ?? a.report?.generated_at ?? ''))[0] ?? null
}

/** Research findings = completed report items produced by research steps. */
export const researchFindings = (r: WfReport | null): WfReportItem[] =>
  (r?.completed ?? []).filter((i) => /research/.test(i.step_key ?? '') || /research/i.test(i.label))

/* ── memory, KPIs ─────────────────────────────────────────────────────── */

export function splitMemory(facts: ReadonlyArray<WfMemoryFact>): { verified: WfMemoryFact[]; interpretation: WfMemoryFact[]; policy: WfMemoryFact[] } {
  const live = facts.filter((f) => !f.superseded_at)
  return {
    // a "verified" fact without a source ref is not verified (§2): it reads as an interpretation
    verified: live.filter((f) => f.epistemic === 'verified' && f.source_refs.length > 0),
    interpretation: live.filter((f) => f.epistemic === 'interpretation' || (f.epistemic === 'verified' && f.source_refs.length === 0)),
    policy: live.filter((f) => f.epistemic === 'ceo_policy'),
  }
}

export const factValue = (v: unknown): string => {
  if (v === null || v === undefined) return 'Unknown'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return 'Unreadable value' }
}

export const KPI_LABEL: Record<string, string> = {
  missions_completed: 'Missions completed', assignments_completed: 'Assignments completed', assignment_success_rate: 'Assignment success',
  escalations_open: 'Open escalations', median_assignment_minutes: 'Median assignment time', spend_usd: 'Spend',
  offers_prepared: 'Offer recommendations prepared', conversations_moved: 'Conversations moved', research_completed: 'Research completed',
}
export const kpiLabel = (k: string) => KPI_LABEL[k] ?? humanize(k)

export function kpiDisplay(k: WfKpi): { value: string; unknown: boolean; reason: string | null } {
  if (k.status !== 'known' || k.value === null) return { value: 'Unknown', unknown: true, reason: k.reason ?? 'Not computed yet' }
  const key = k.kpi_key
  if (/_usd$|^spend/.test(key)) return { value: usd(k.value, k.value < 100) ?? 'Unknown', unknown: false, reason: null }
  if (/rate$|_pct$/.test(key)) return { value: `${Math.round(k.value <= 1 ? k.value * 100 : k.value)}%`, unknown: false, reason: null }
  if (/minutes$/.test(key)) return { value: `${Math.round(k.value)} min`, unknown: false, reason: null }
  return { value: k.value.toLocaleString('en-US'), unknown: false, reason: null }
}

/* ── events ───────────────────────────────────────────────────────────── */

export function eventMeta(type: string): { title: string; icon: IconName; tone: LCTone } {
  const t = type.replace(/^wf\./, '')
  if (/mission\.planned/.test(t)) return { title: 'Mission planned', icon: 'layers', tone: 'exec' }
  if (/mission\.opened|mission\.created/.test(t)) return { title: 'Mission opened', icon: 'target', tone: 'exec' }
  if (/mission\.completed/.test(t)) return { title: 'Mission completed', icon: 'check-double', tone: 'ok' }
  if (/mission\.(failed)/.test(t)) return { title: 'Mission failed', icon: 'alert-circle', tone: 'crit' }
  if (/mission\.cancelled/.test(t)) return { title: 'Mission cancelled', icon: 'x', tone: 'neutral' }
  if (/escalat/.test(t)) return { title: 'Escalated to the CEO', icon: 'flag', tone: 'attn' }
  if (/refus|denied|deny/.test(t)) return { title: 'Refused', icon: 'shield', tone: 'attn' }
  if (/assignment\.completed/.test(t)) return { title: 'Assignment completed', icon: 'check', tone: 'ok' }
  if (/assignment\.failed/.test(t)) return { title: 'Assignment failed', icon: 'alert-circle', tone: 'crit' }
  if (/assignment\.(requeued|reaped|retry)/.test(t)) return { title: 'Assignment recovered', icon: 'refresh-cw', tone: 'attn' }
  if (/waiting_job|job\.enqueued/.test(t)) return { title: 'Runtime job enqueued', icon: 'cpu', tone: 'neutral' }
  if (/assignment\.(claimed|leased|started|running)/.test(t)) return { title: 'Assignment started', icon: 'play', tone: 'exec' }
  if (/assignment\.created/.test(t)) return { title: 'Assignment created', icon: 'plus', tone: 'neutral' }
  if (/transfer/.test(t)) return { title: 'Assignment transferred', icon: 'users', tone: 'neutral' }
  if (/memory/.test(t)) return { title: 'Memory recorded', icon: 'brain', tone: 'neutral' }
  if (/claim/.test(t)) return { title: 'Resource claimed', icon: 'key', tone: 'neutral' }
  if (/heartbeat/.test(t)) return { title: 'Heartbeat', icon: 'activity', tone: 'neutral' }
  return { title: humanize(t), icon: 'activity', tone: 'neutral' }
}

/** The outcome an event reports, in words (outcome_class / status / reason in its payload). */
export function eventOutcome(e: WfEvent): string | null {
  const p = e.payload
  const oc = typeof p.outcome_class === 'string' ? p.outcome_class : null
  const reason = typeof p.reason === 'string' ? p.reason : Array.isArray(p.reasons) ? (p.reasons as unknown[]).filter((x) => typeof x === 'string').join(' · ') : null
  const summary = typeof p.summary === 'string' ? p.summary : null
  return [summary, oc ? humanize(oc) : null, reason].filter(Boolean).join(' · ') || null
}

/* ── linked context ───────────────────────────────────────────────────── */

export interface LinkedSubject { propertyId: string | null; threadKey: string | null; opportunityId: string | null; address: string | null }

/** "Ask the COO about <address>": a directive the COO can interpret (status_review over one subject). */
export function linkedDirective(s: LinkedSubject): string | null {
  const name = s.address?.trim()
  if (!name && !s.propertyId && !s.opportunityId) return null
  const subject = name || (s.opportunityId ? 'the linked opportunity' : 'the linked property')
  return `Review ${subject}: conversation state, the acquisition decision and the CFO check. Tell me the next action and who owns it.`
}

/* ── time ─────────────────────────────────────────────────────────────── */

const RTF = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto', style: 'short' })
/** "4 min ago", "in 18 min"; null for no time. */
export function relTime(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  const d = (t - now) / 1000
  const a = Math.abs(d)
  // a few seconds of clock skew reads as now, never as the future
  if (a < 45 || (d > 0 && d < 120)) return 'just now'
  if (a < 3600) return RTF.format(Math.round(d / 60), 'minute')
  if (a < 86400) return RTF.format(Math.round(d / 3600), 'hour')
  return RTF.format(Math.round(d / 86400), 'day')
}


/* ── composer ─────────────────────────────────────────────────────────── */

/** Phone numbers and email addresses are refused by the server (§2); say so before sending. */
export function composerRefusal(text: string): string | null {
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) return 'Email addresses cannot be stored in Workforce. Refer to the seller by property address.'
  if (/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(text)) return 'Phone numbers cannot be stored in Workforce. Refer to the seller by property address.'
  return null
}

