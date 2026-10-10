/**
 * RESEARCH MODEL — events → view model. Pure; no clock, no invented progress.
 *
 * Everything the research canvas shows is reduced here from received events:
 * phase from job.phase, the status line from the latest task.started without
 * a terminal event, progress from terminal / planned tasks (planned can grow —
 * the bar re-bases and says so), cost from usage.settled (never from the
 * estimate), conflicts from finding.conflict, the brief from brief.section.
 * A gap in `seq` is reported (the real client refetches; S2 just flags it).
 */
import {
  BRIEF_SECTIONS, RESEARCH_JOB_TERMINAL_STATES, findingTypeMeta,
  type AgentEvent, type BriefClaim, type BriefSectionKey, type ContactReadinessClass, type CostEstimate, type Finding, type FindingType,
  type JobPropertyState, type OpportunityClass, type ResearchDepth, type ResearchJobState, type ResearchPhase, type ResearchTaskState, type SourceOperationStatus,
} from '../contracts/contracts'

export type TimelineState = 'planned' | 'running' | 'completed' | 'failed' | 'blocked' | 'needs_input' | 'unavailable' | 'cancelled' | 'skipped'

export interface SourceStep { type: string; at: string; status: SourceOperationStatus; detail: string | null; event_id: number }

export interface TaskRow {
  task_id: string
  property_id: string | null
  label: string
  operation: string
  source_id: string | null
  finding_type: FindingType | null
  state: ResearchTaskState
  phase: ResearchPhase
  planned_seq: number
  planned_at: string
  started_at: string | null
  ended_at: string | null
  duration_ms: number | null
  cost_usd: number
  attempt: number
  billable: boolean
  depends_on: string[]
  steps: SourceStep[]
  observations: Array<{ display_value: string; citation: string | null; at: string }>
  finding_ids: string[]
  reason: string | null
  message: string | null
  alternatives: string[]
  question: string | null
  options: string[]
  retry_at: string | null
  after_cancel: boolean
  /** tool.* rows (read tools): rows returned and the tool name */
  tool: string | null
  rows: number | null
  result_summary: string | null
  /** the reason the previous attempt ended (shown on a retried row) */
  prior_failure: string | null
  /** first event id that touched the row — reveal animations key off arrivals */
  first_event_id: number
  last_event_id: number
}

export interface SourceOpRow {
  key: string
  task_id: string
  source_id: string
  property_id: string | null
  purpose: string
  status: SourceOperationStatus
  retrieved_at: string | null
  observation_count: number
  reason: string | null
  message: string | null
  alternatives: string[]
  bytes: number | null
  last_event_id: number
}

export interface FindingView extends Finding { arrived_event_id: number; updated_event_id: number; history: Array<{ event_id: number; evidence_status: Finding['evidence_status']; contradicted_by: string | null; confidence: number }> }

export interface ConflictClaimRef { finding_id: string; claim: string | null; source_id: string | null; source_name: string | null; source_class: string | null; evidence_status: string | null; as_of: string | null }
export interface ConflictView {
  conflict_group_id: string; finding_type: string; members: string[]; rule: string; resolution_state: string; event_id: number; opened_event_id: number
  property_id: string | null
  /** S3 live: the server's own claim text per member, and its conclusion (decisive only when the evidence supports it) */
  claims: Record<string, ConflictClaimRef>
  best_supported: ConflictClaimRef | null
  reason: string | null
  remaining_uncertainty: string | null
  follow_up: string | null
}

export interface DecisionView { event_id: number; at: string; summary: string; basis: string[]; criterion: string | null; property_id: string | null }

export interface BriefSectionView { key: BriefSectionKey; label: string; claims: BriefClaim[]; event_id: number; at: string }

export interface PropertyView {
  property_id: string
  display_address: string
  state: JobPropertyState
  phase: ResearchPhase | null
  opportunity_class: OpportunityClass | null
  contact_readiness_class: ContactReadinessClass | null
  started_at: string | null
  ended_at: string | null
  last_event_id: number
  sections: Partial<Record<BriefSectionKey, BriefSectionView>>
  brief_completed: { opportunity_class: OpportunityClass; contact_readiness_class: ContactReadinessClass; sections_missing: string[]; event_id: number } | null
}

export interface ResearchView {
  run_id: string
  fixture: boolean
  depth: ResearchDepth | null
  property_count: number
  state: ResearchJobState
  phase: ResearchPhase | null
  phase_history: Array<{ phase: ResearchPhase; at: string; event_id: number }>
  scope_sentence: string | null
  estimate: CostEstimate | null
  cap_usd: number | null
  accrued_usd: number
  remaining_usd: number | null
  reserved_usd: number
  created_at: string | null
  confirmed_at: string | null
  ended_at: string | null
  last_at: string | null
  cancel_requested: boolean
  paused: boolean
  summary: string | null
  tasks: TaskRow[]
  taskIndex: Record<string, number>
  sources: SourceOpRow[]
  findings: Record<string, FindingView>
  findingOrder: string[]
  conflicts: Record<string, ConflictView>
  decisions: DecisionView[]
  properties: Record<string, PropertyView>
  propertyOrder: string[]
  skipped_fresh: Array<{ finding_type: string; label: string; fresh_until: string | null; property_id: string | null; event_id: number }>
  /** the operation in progress for the status line: latest task.started without a terminal event */
  current: { task_id: string; label: string; property_id: string | null; event_id: number } | null
  running_count: number
  planned_growth: number
  last_event_id: number
  last_seq: number
  gap: boolean
  event_count: number
  /** context.attached: what the run was launched from (app + object refs) */
  context: { app: string | null; refs: Array<{ id: string | null; label: string | null; kind: string | null }>; selection_count: number | null; filter_summary: string | null } | null
  /** retries the server recorded (attempt > 1 on a task / tool start) */
  retries: number
  /** run.failed error code (live runs) */
  error_code: string | null
}

export function emptyResearch(run_id: string): ResearchView {
  return {
    run_id, fixture: false, depth: null, property_count: 0, state: 'draft', phase: null, phase_history: [], scope_sentence: null, estimate: null, cap_usd: null,
    accrued_usd: 0, remaining_usd: null, reserved_usd: 0, created_at: null, confirmed_at: null, ended_at: null, last_at: null, cancel_requested: false, paused: false, summary: null,
    tasks: [], taskIndex: {}, sources: [], findings: {}, findingOrder: [], conflicts: {}, decisions: [], properties: {}, propertyOrder: [], skipped_fresh: [],
    current: null, running_count: 0, planned_growth: 0, last_event_id: 0, last_seq: 0, gap: false, event_count: 0, context: null, retries: 0, error_code: null,
  }
}

const TERMINAL_TASK: Record<string, ResearchTaskState> = {
  'task.completed': 'succeeded', 'task.blocked': 'blocked', 'task.failed': 'failed', 'task.unavailable': 'unavailable', 'task.needs_input': 'needs_input', 'task.cancelled': 'cancelled',
}
const SOURCE_STATUS: Record<string, SourceOperationStatus> = {
  'source.searched': 'searched', 'source.opened': 'opened', 'source.retrieved': 'retrieved', 'source.blocked': 'blocked', 'source.failed': 'failed',
}
const SOURCE_RANK: Record<SourceOperationStatus, number> = { planned: 0, skipped_fresh: 1, searched: 2, opened: 3, retrieved: 4, failed: 5, blocked: 6 }

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Timeline vocabulary (directive §2): Planned / Running / Completed / Failed / Blocked / Needs input (+ unavailable / cancelled / skipped). */
export function timelineState(s: ResearchTaskState): TimelineState {
  switch (s) {
    case 'planned': case 'queued': return 'planned'
    case 'running': return 'running'
    case 'succeeded': return 'completed'
    case 'blocked': return 'blocked'
    case 'needs_input': return 'needs_input'
    case 'unavailable': return 'unavailable'
    case 'cancelled': case 'budget_stopped': return 'cancelled'
    case 'skipped_fresh': return 'skipped'
    default: return 'failed'
  }
}

function recount(v: ResearchView) {
  // the status line speaks for the most recent task.started that has no terminal event yet
  let running = 0
  let latest: TaskRow | null = null
  for (const t of v.tasks) {
    if (t.state !== 'running') continue
    running += 1
    if (!latest || (t.started_at ?? '') >= (latest.started_at ?? '')) latest = t
  }
  v.running_count = running
  v.current = latest ? { task_id: latest.task_id, label: latest.label, property_id: latest.property_id, event_id: latest.first_event_id } : null
}

function upsertSourceOp(v: ResearchView, task: TaskRow | undefined, e: AgentEvent, status: SourceOperationStatus) {
  const p = e.payload
  const source_id = str(p.source_id) ?? task?.source_id ?? null
  if (!source_id || !e.task_id) return
  const key = `${e.task_id}:${source_id}`
  let i = v.sources.findIndex((s) => s.key === key)
  if (i < 0) {
    v.sources = [...v.sources, { key, task_id: e.task_id, source_id, property_id: e.property_id, purpose: str(p.purpose) ?? (task?.finding_type ? (findingTypeMeta(task.finding_type)?.label ?? task.finding_type).toLowerCase() : 'lookup'), status: 'planned', retrieved_at: null, observation_count: 0, reason: null, message: null, alternatives: [], bytes: null, last_event_id: e.event_id }]
    i = v.sources.length - 1
  }
  const cur = v.sources[i]
  const next: SourceOpRow = { ...cur, last_event_id: e.event_id }
  if (SOURCE_RANK[status] >= SOURCE_RANK[cur.status] || status === 'retrieved') next.status = status
  if (str(p.retrieved_at)) next.retrieved_at = str(p.retrieved_at)
  if (num(p.bytes) !== null) next.bytes = num(p.bytes)
  if (str(p.purpose)) next.purpose = str(p.purpose)!
  if (status === 'blocked' || status === 'failed') { next.reason = str(p.reason); next.message = str(p.message); next.alternatives = arr(p.alternatives) }
  const list = v.sources.slice(); list[i] = next; v.sources = list
}

/** Apply one event. Returns a new view (shallow copies of touched collections). */
export function applyResearchEvent(prev: ResearchView, e: AgentEvent): ResearchView {
  const v: ResearchView = { ...prev, event_count: prev.event_count + 1, last_at: e.at }
  if (e.fixture) v.fixture = true
  if (prev.last_seq && e.seq !== prev.last_seq + 1) v.gap = true
  v.last_seq = Math.max(prev.last_seq, e.seq)
  v.last_event_id = Math.max(prev.last_event_id, e.event_id)
  const p = e.payload
  const touchTask = (fn: (t: TaskRow) => TaskRow) => {
    if (!e.task_id) return undefined
    const i = v.taskIndex[e.task_id]
    if (i === undefined) return undefined
    const tasks = v.tasks.slice()
    tasks[i] = fn({ ...tasks[i], last_event_id: e.event_id })
    v.tasks = tasks
    return tasks[i]
  }
  const touchProperty = (fn: (pv: PropertyView) => PropertyView) => {
    const id = e.property_id
    if (!id) return
    const cur = v.properties[id] ?? { property_id: id, display_address: id, state: 'queued' as JobPropertyState, phase: null, opportunity_class: null, contact_readiness_class: null, started_at: null, ended_at: null, last_event_id: e.event_id, sections: {}, brief_completed: null }
    if (!v.properties[id]) v.propertyOrder = [...v.propertyOrder, id]
    v.properties = { ...v.properties, [id]: fn({ ...cur, last_event_id: e.event_id }) }
  }

  switch (e.type) {
    case 'job.created':
      v.depth = (str(p.depth) as ResearchDepth) ?? null
      v.property_count = num(p.property_count) ?? 0
      v.estimate = (p.estimate as CostEstimate) ?? null
      v.cap_usd = num(p.cap) ?? num((p.cap as Record<string, unknown> | null)?.batch_usd)
      v.remaining_usd = v.cap_usd
      v.created_at = e.at
      v.state = 'draft'
      break
    case 'job.confirmed':
      v.scope_sentence = str(p.scope_sentence)
      if (v.cap_usd === null) { v.cap_usd = num(p.cap) ?? num((p.cap as Record<string, unknown> | null)?.batch_usd); v.remaining_usd = v.cap_usd }
      v.confirmed_at = e.at
      v.state = 'queued'
      break
    case 'job.phase': {
      const phase = str(p.phase) as ResearchPhase
      v.phase = phase
      v.phase_history = [...v.phase_history, { phase, at: e.at, event_id: e.event_id }]
      if (phase === 'synthesizing') v.state = v.state === 'paused' ? 'paused' : 'synthesizing'
      else if (phase !== 'complete' && !RESEARCH_JOB_TERMINAL_STATES.includes(v.state) && v.state !== 'paused') v.state = 'running'
      // a task planned after research started re-bases progress ("+1 planned")
      break
    }
    case 'job.paused': v.paused = true; v.state = 'paused'; break
    case 'job.resumed': v.paused = false; v.state = v.phase === 'synthesizing' ? 'synthesizing' : 'running'; break
    case 'job.cancel_requested': v.cancel_requested = true; break
    case 'job.cancelled': v.state = 'cancelled'; v.ended_at = e.at; v.summary = str(p.summary); v.accrued_usd = num(p.accrued_usd) ?? v.accrued_usd; break
    case 'job.budget_exhausted': v.state = 'budget_exhausted'; v.ended_at = e.at; break
    case 'job.failed': v.state = 'failed'; v.ended_at = e.at; break
    case 'job.completed': v.state = (str(p.state) as ResearchJobState) ?? 'completed'; v.ended_at = e.at; v.summary = str(p.summary); v.accrued_usd = num(p.accrued_usd) ?? v.accrued_usd; break
    case 'job.property_state':
      touchProperty((pv) => {
        const state = (str(p.state) as JobPropertyState) ?? pv.state
        return {
          ...pv, state,
          display_address: str(p.display_address) ?? pv.display_address,
          phase: (str(p.phase) as ResearchPhase) ?? pv.phase,
          opportunity_class: (str(p.opportunity_class) as OpportunityClass) ?? pv.opportunity_class,
          contact_readiness_class: (str(p.contact_readiness_class) as ContactReadinessClass) ?? pv.contact_readiness_class,
          started_at: state === 'running' && !pv.started_at ? e.at : pv.started_at,
          ended_at: ['completed', 'completed_partial', 'cancelled', 'failed', 'skipped_fresh', 'budget_stopped'].includes(state) ? e.at : pv.ended_at,
        }
      })
      break
    case 'plan.task_added': {
      const id = str(p.task_id) ?? e.task_id
      if (!id) break
      const existing = v.taskIndex[id]
      const started = v.phase && v.phase !== 'planning'
      const row: TaskRow = {
        task_id: id, property_id: e.property_id, label: str(p.label) ?? 'Operation', operation: str(p.operation) ?? '', source_id: str(p.source_id), finding_type: (str(p.finding_type) as FindingType) ?? null,
        state: 'planned', phase: v.phase ?? 'planning', planned_seq: e.seq, planned_at: e.at, started_at: null, ended_at: null, duration_ms: null, cost_usd: 0, attempt: 1, billable: Boolean(p.billable), depends_on: arr(p.depends_on),
        steps: [], observations: [], finding_ids: [], reason: null, message: null, alternatives: [], question: null, options: [], retry_at: null, after_cancel: false, tool: null, rows: null, result_summary: null, prior_failure: null, first_event_id: e.event_id, last_event_id: e.event_id,
      }
      if (existing === undefined) {
        v.taskIndex = { ...v.taskIndex, [id]: v.tasks.length }
        v.tasks = [...v.tasks, row]
        if (started && row.operation !== 'research.synthesize_section') v.planned_growth = prev.planned_growth + 1
      }
      break
    }
    case 'plan.skipped_fresh':
      v.skipped_fresh = [...v.skipped_fresh, { finding_type: str(p.finding_type) ?? '', label: str(p.label) ?? 'Reused fresh evidence', fresh_until: str(p.fresh_until), property_id: e.property_id, event_id: e.event_id }]
      break
    case 'task.started': {
      if (e.task_id && v.taskIndex[e.task_id] === undefined) {
        // a start without a plan row (should not happen) still renders honestly
        v.taskIndex = { ...v.taskIndex, [e.task_id]: v.tasks.length }
        v.tasks = [...v.tasks, { task_id: e.task_id, property_id: e.property_id, label: str(p.label) ?? 'Operation', operation: str(p.operation) ?? '', source_id: str(p.source_id), finding_type: (str(p.finding_type) as FindingType) ?? null, state: 'planned', phase: v.phase ?? 'researching', planned_seq: e.seq, planned_at: e.at, started_at: null, ended_at: null, duration_ms: null, cost_usd: 0, attempt: 1, billable: false, depends_on: [], steps: [], observations: [], finding_ids: [], reason: null, message: null, alternatives: [], question: null, options: [], retry_at: null, after_cancel: false, tool: null, rows: null, result_summary: null, prior_failure: null, first_event_id: e.event_id, last_event_id: e.event_id }]
      }
      touchTask((t) => ({ ...t, state: 'running', started_at: e.attempt > 1 ? t.started_at ?? e.at : e.at, ended_at: null, attempt: e.attempt, phase: v.phase ?? t.phase, label: str(p.label) ?? t.label, question: null, options: [], prior_failure: e.attempt > 1 ? (t.reason ?? t.state) : t.prior_failure, first_event_id: e.attempt > 1 ? t.first_event_id : e.event_id }))
      if (e.attempt > 1) v.retries = prev.retries + 1
      break
    }
    case 'source.searched': case 'source.opened': case 'source.retrieved': case 'source.blocked': case 'source.failed': {
      const status = SOURCE_STATUS[e.type]
      const task = touchTask((t) => ({ ...t, steps: [...t.steps, { type: e.type, at: e.at, status, detail: str(p.message) ?? (num(p.bytes) !== null ? `${Math.round((num(p.bytes) ?? 0) / 1024).toLocaleString()} KB` : str(p.reason)), event_id: e.event_id }], ...(status === 'blocked' || status === 'failed' ? { reason: str(p.reason), message: str(p.message), alternatives: arr(p.alternatives), retry_at: str(p.retry_at) } : {}) }))
      upsertSourceOp(v, task, e, status)
      break
    }
    case 'observation.extracted': {
      touchTask((t) => ({ ...t, observations: [...t.observations, { display_value: str(p.display_value) ?? '', citation: str(p.citation), at: e.at }] }))
      const key = e.task_id ? v.sources.findIndex((s) => s.task_id === e.task_id) : -1
      if (key >= 0) { const list = v.sources.slice(); list[key] = { ...list[key], observation_count: list[key].observation_count + 1 }; v.sources = list }
      break
    }
    case 'finding.upserted': {
      const f = p.finding as Finding | undefined
      if (!f?.finding_id) break
      const cur = v.findings[f.finding_id]
      const fv: FindingView = { ...f, arrived_event_id: cur?.arrived_event_id ?? e.event_id, updated_event_id: e.event_id, history: [...(cur?.history ?? []), { event_id: e.event_id, evidence_status: f.evidence_status, contradicted_by: f.contradicted_by, confidence: f.confidence }] }
      v.findings = { ...v.findings, [f.finding_id]: fv }
      if (!cur) v.findingOrder = [...v.findingOrder, f.finding_id]
      if (e.task_id) touchTask((t) => (t.finding_ids.includes(f.finding_id) ? t : { ...t, finding_ids: [...t.finding_ids, f.finding_id] }))
      break
    }
    case 'finding.conflict': {
      const id = str(p.conflict_group_id)
      if (!id) break
      const cur = v.conflicts[id]
      const rawMembers = Array.isArray(p.members) ? (p.members as unknown[]) : []
      const claims: Record<string, ConflictClaimRef> = {}
      const members: string[] = []
      const toRef = (m: unknown): ConflictClaimRef | null => {
        if (typeof m === 'string') return { finding_id: m, claim: null, source_id: null, source_name: null, source_class: null, evidence_status: null, as_of: null }
        if (!m || typeof m !== 'object') return null
        const r = m as Record<string, unknown>
        const fid = str(r.finding_id)
        return fid ? { finding_id: fid, claim: str(r.claim), source_id: str(r.source_id), source_name: str(r.source_name), source_class: str(r.source_class), evidence_status: str(r.evidence_status), as_of: str(r.as_of) } : null
      }
      for (const m of rawMembers) { const ref = toRef(m); if (ref) { members.push(ref.finding_id); claims[ref.finding_id] = ref } }
      const bs = toRef(p.best_supported)
      const txt = (x: unknown) => (Array.isArray(x) ? x.filter((y) => typeof y === 'string').join(' ') || null : str(x))
      v.conflicts = { ...v.conflicts, [id]: { conflict_group_id: id, finding_type: str(p.finding_type) ?? '', members, rule: str(p.rule) ?? '', resolution_state: str(p.resolution_state) ?? 'open', event_id: e.event_id, opened_event_id: cur?.opened_event_id ?? e.event_id, property_id: e.property_id, claims, best_supported: bs, reason: txt(p.reason), remaining_uncertainty: txt(p.remaining_uncertainty), follow_up: txt(p.follow_up) } }
      break
    }
    case 'decision':
      v.decisions = [...v.decisions, { event_id: e.event_id, at: e.at, summary: (str(p.summary) ?? '').slice(0, 240), basis: arr(p.basis_finding_ids).concat(arr(p.basis_refs)), criterion: str(p.criterion), property_id: e.property_id }]
      break
    case 'task.completed': case 'task.blocked': case 'task.failed': case 'task.unavailable': case 'task.needs_input': case 'task.cancelled': {
      const state = TERMINAL_TASK[e.type]
      touchTask((t) => ({
        ...t, state,
        ended_at: state === 'needs_input' ? null : e.at,
        duration_ms: num(p.duration_ms) ?? (t.started_at ? Date.parse(e.at) - Date.parse(t.started_at) : null),
        cost_usd: num(p.cost_usd) ?? t.cost_usd,
        reason: str(p.reason) ?? str(p.error_code) ?? t.reason,
        alternatives: arr(p.alternatives).length ? arr(p.alternatives) : t.alternatives,
        question: str(p.question) ?? t.question,
        options: arr(p.options).length ? arr(p.options) : t.options,
        retry_at: str(p.retry_at) ?? t.retry_at,
        after_cancel: Boolean(p.after_cancel) || t.after_cancel,
      }))
      break
    }
    /* run-level lifecycle (a research job IS an agent.run(kind='research'); live runs may speak only run.*) */
    case 'run.created':
      v.created_at = v.created_at ?? e.at
      if (!v.depth && str(p.depth)) v.depth = str(p.depth) as ResearchDepth
      if (v.cap_usd === null && num(p.budget_cap_usd) !== null) { v.cap_usd = num(p.budget_cap_usd); v.remaining_usd = num(p.budget_cap_usd) }
      break
    case 'run.state': {
      const to = str(p.to)
      if (num(p.accrued_usd) !== null) v.accrued_usd = num(p.accrued_usd)!
      if (to === 'running' && (v.state === 'draft' || v.state === 'queued')) { v.state = 'running'; v.confirmed_at = v.confirmed_at ?? e.at }
      if (to === 'paused') { v.paused = true; v.state = 'paused' }
      break
    }
    case 'run.cancel_requested': v.cancel_requested = true; break
    case 'run.cancelled': if (!RESEARCH_JOB_TERMINAL_STATES.includes(v.state)) { v.state = 'cancelled'; v.ended_at = e.at; v.summary = str(p.summary) ?? v.summary } break
    case 'run.failed': if (!RESEARCH_JOB_TERMINAL_STATES.includes(v.state)) { v.state = 'failed'; v.ended_at = e.at; v.error_code = str(p.error_code) } break
    case 'run.budget_exhausted': if (!RESEARCH_JOB_TERMINAL_STATES.includes(v.state)) { v.state = 'budget_exhausted'; v.ended_at = e.at } break
    case 'run.completed':
      if (!RESEARCH_JOB_TERMINAL_STATES.includes(v.state)) {
        const st = str(p.state) as ResearchJobState | null
        v.state = st && RESEARCH_JOB_TERMINAL_STATES.includes(st) ? st : 'completed'
        v.ended_at = e.at
        v.summary = str(p.summary) ?? v.summary
      }
      if (num(p.accrued_usd) !== null) v.accrued_usd = num(p.accrued_usd)!
      break
    case 'context.attached': {
      const refs = Array.isArray(p.object_refs) ? (p.object_refs as Array<Record<string, unknown>>).map((r) => ({ id: str(r?.id) ?? str(r?.property_id), label: str(r?.label), kind: str(r?.kind) ?? str(r?.type) })) : []
      v.context = { app: str(p.app), refs, selection_count: num(p.selection_count), filter_summary: str(p.filter_summary) }
      break
    }
    /* read tools (T0) as timeline rows — a Quick Scan may report its reads as tool.* instead of task.* */
    case 'tool.started': {
      const id = `tool:${e.tool_call_id ?? e.event_id}`
      if (v.taskIndex[id] === undefined) {
        v.taskIndex = { ...v.taskIndex, [id]: v.tasks.length }
        v.tasks = [...v.tasks, { task_id: id, property_id: e.property_id, label: str(p.label) ?? str(p.tool) ?? 'Read', operation: str(p.operation) ?? 'tool.invoke', source_id: null, finding_type: null, state: 'running', phase: v.phase ?? 'researching', planned_seq: e.seq, planned_at: e.at, started_at: e.at, ended_at: null, duration_ms: null, cost_usd: 0, attempt: e.attempt || 1, billable: false, depends_on: [], steps: [], observations: [], finding_ids: [], reason: null, message: null, alternatives: [], question: null, options: [], retry_at: null, after_cancel: false, tool: str(p.tool), rows: null, result_summary: null, prior_failure: null, first_event_id: e.event_id, last_event_id: e.event_id }]
      } else {
        const tasks = v.tasks.slice(); const i = v.taskIndex[id]
        tasks[i] = { ...tasks[i], state: 'running', ended_at: null, attempt: e.attempt || tasks[i].attempt + 1, prior_failure: tasks[i].reason ?? tasks[i].state, last_event_id: e.event_id }
        v.tasks = tasks
      }
      if ((e.attempt || 1) > 1) v.retries = prev.retries + 1
      break
    }
    case 'tool.completed': case 'tool.failed': case 'tool.refused': case 'tool.outcome_unknown': {
      const id = `tool:${e.tool_call_id ?? ''}`
      const i = v.taskIndex[id]
      if (i === undefined) break
      const tasks = v.tasks.slice(); const t = tasks[i]
      const state: ResearchTaskState = e.type === 'tool.completed' ? 'succeeded' : e.type === 'tool.refused' ? 'blocked' : e.type === 'tool.outcome_unknown' ? 'unavailable' : 'failed'
      tasks[i] = { ...t, state, ended_at: e.at, duration_ms: num(p.duration_ms) ?? (t.started_at ? Date.parse(e.at) - Date.parse(t.started_at) : null), cost_usd: num(p.cost_usd) ?? t.cost_usd, rows: num(p.rows), result_summary: str(p.result_summary) ?? t.result_summary, reason: str(p.refusal_code) ?? str(p.error_code) ?? t.reason, message: str(p.message) ?? t.message, last_event_id: e.event_id }
      v.tasks = tasks
      break
    }
    case 'usage.reserved': v.reserved_usd = prev.reserved_usd + (num(p.worst_case_usd) ?? 0); break
    case 'usage.settled':
      v.accrued_usd = num(p.accrued_usd) ?? prev.accrued_usd + (num(p.actual_usd) ?? 0)
      if (num(p.remaining_usd) !== null) v.remaining_usd = num(p.remaining_usd)
      else if (v.cap_usd !== null) v.remaining_usd = Math.max(0, v.cap_usd - v.accrued_usd)
      break
    case 'brief.section': {
      const key = str(p.section_key) as BriefSectionKey
      const meta = BRIEF_SECTIONS.find((s) => s.key === key)
      if (!e.property_id && str(p.property_id)) e = { ...e, property_id: str(p.property_id) }
      touchProperty((pv) => ({ ...pv, sections: { ...pv.sections, [key]: { key, label: str(p.label) ?? meta?.label ?? key, claims: (p.claims as BriefClaim[]) ?? [], event_id: e.event_id, at: e.at } } }))
      break
    }
    case 'brief.completed':
      touchProperty((pv) => ({ ...pv, brief_completed: { opportunity_class: (str(p.opportunity_class) as OpportunityClass) ?? 'unknown', contact_readiness_class: (str(p.contact_readiness_class) as ContactReadinessClass) ?? 'unknown', sections_missing: arr(p.sections_missing), event_id: e.event_id } }))
      break
    default:
      break
  }
  recount(v)
  return v
}

export function reduceResearch(run_id: string, events: AgentEvent[]): ResearchView {
  let v = emptyResearch(run_id)
  for (const e of events) v = applyResearchEvent(v, e)
  return v
}

/* ── derived selectors (pure) ────────────────────────────────────────── */

export interface ResearchProgress { planned: number; done: number; running: number; blocked: number; failed: number; unavailable: number; needs_input: number; cancelled: number; succeeded: number; skipped: number; fraction: number }

export function progressOf(v: ResearchView, property_id?: string | null): ResearchProgress {
  const out: ResearchProgress = { planned: 0, done: 0, running: 0, blocked: 0, failed: 0, unavailable: 0, needs_input: 0, cancelled: 0, succeeded: 0, skipped: 0, fraction: 0 }
  for (const t of v.tasks) {
    if (property_id && t.property_id !== property_id) continue
    out.planned += 1
    switch (t.state) {
      case 'running': out.running += 1; break
      case 'succeeded': out.succeeded += 1; out.done += 1; break
      case 'blocked': out.blocked += 1; out.done += 1; break
      case 'failed': out.failed += 1; out.done += 1; break
      case 'unavailable': out.unavailable += 1; out.done += 1; break
      case 'cancelled': case 'budget_stopped': out.cancelled += 1; out.done += 1; break
      case 'needs_input': out.needs_input += 1; break
      case 'skipped_fresh': out.skipped += 1; out.done += 1; break
      default: break
    }
  }
  const skippedFresh = v.skipped_fresh.filter((s) => !property_id || s.property_id === property_id).length
  out.skipped += skippedFresh
  out.fraction = out.planned ? out.done / out.planned : 0
  return out
}

export interface BatchCounters { total: number; completed: number; running: number; queued: number; partial: number; cancelled: number; skipped: number; discoveries: number; ops_ok: number; ops_blocked: number; ops_failed: number }

export function batchCounters(v: ResearchView): BatchCounters {
  const c: BatchCounters = { total: v.propertyOrder.length || v.property_count, completed: 0, running: 0, queued: 0, partial: 0, cancelled: 0, skipped: 0, discoveries: 0, ops_ok: 0, ops_blocked: 0, ops_failed: 0 }
  for (const id of v.propertyOrder) {
    const s = v.properties[id].state
    if (s === 'completed') c.completed += 1
    else if (s === 'completed_partial') { c.completed += 1; c.partial += 1 }
    else if (s === 'running') c.running += 1
    else if (s === 'queued') c.queued += 1
    else if (s === 'cancelled' || s === 'budget_stopped' || s === 'failed') c.cancelled += 1
    else if (s === 'skipped_fresh') { c.skipped += 1; c.completed += 1 }
  }
  for (const id of v.findingOrder) if (v.findings[id].is_discovery) c.discoveries += 1
  for (const s of v.sources) {
    if (s.status === 'retrieved') c.ops_ok += 1
    else if (s.status === 'blocked') c.ops_blocked += 1
    else if (s.status === 'failed') c.ops_failed += 1
  }
  return c
}

export const isTerminal = (v: ResearchView) => RESEARCH_JOB_TERMINAL_STATES.includes(v.state)

/** Findings grouped into their inspector home panel (directive §5 evidence reveal). */
export function findingsByPanel(v: ResearchView, property_id: string | null): Record<string, FindingView[]> {
  const out: Record<string, FindingView[]> = {}
  for (const id of v.findingOrder) {
    const f = v.findings[id]
    if (property_id && f.property_id !== property_id) continue
    const panel = findingTypeMeta(f.finding_type)?.inspector_panel ?? 'other'
    ;(out[panel] ??= []).push(f)
  }
  return out
}

export const isContradicted = (f: Finding) => Boolean(f.contradicted_by)
