/**
 * FIXTURE KIT — the dev-only stand-in for the S1 event log.
 *
 * EVERYTHING IN THIS FOLDER IS SIMULATED. Scenarios are authored event logs in
 * the exact `agent.run_event` envelope (contracts.ts) about SYNTHETIC
 * properties and fixture-only sources (`test_data: true`, hosts ending in
 * `.sim`). Nothing here is fetched, researched, priced or reasoned: there is
 * no network call, no model call and no real seller record anywhere in it.
 *
 * The UI renders only from these events, exactly as it will from the real
 * stream (S3+). Operator controls (pause / resume / cancel / answer) are
 * answered here, by the fixture "server", as further events — the UI never
 * advances a state on its own.
 */
import {
  FINDING_TYPES, renderOperationLabel, confidenceBand,
  type AgentEvent, type AgentEventType, type Finding, type FindingType, type OperationId, type RunKind, type ResearchDepth, type SourceDescriptor,
} from '../contracts/contracts'

export type ScenarioId = 'single-deep' | 'blocked-conflict' | 'batch-25' | 'conversation'

export interface SyntheticProperty {
  property_id: string
  /** always carries the "(synthetic)" marker in UI copy */
  address: string
  city: string
  jurisdiction: string
  asset: string
  beds_baths: string
  sqft: number
  year_built: number
  owner_display: string
}

/** An event before the transport stamps run_id / seq / event_id / at. */
export interface DraftEvent {
  t: number
  type: AgentEventType
  payload: Record<string, unknown>
  property_id?: string | null
  task_id?: string | null
  tool_call_id?: string | null
  attempt?: number
  /** authored variants: kept only when the operator answered / did not answer that needs_input task */
  when?: { answered?: string; unanswered?: string }
}

export interface FixtureScenario {
  id: ScenarioId
  kind: RunKind
  title: string
  subtitle: string
  depth: ResearchDepth | null
  properties: SyntheticProperty[]
  sources: SourceDescriptor[]
  log: DraftEvent[]
  /** research jobs wait at this offset for the operator's explicit scope confirmation (DR §1G) */
  confirm_gate?: number
}

export type FixtureControl =
  | { kind: 'confirm'; t: number }
  | { kind: 'pause'; t: number }
  | { kind: 'resume'; t: number }
  | { kind: 'cancel'; t: number }
  | { kind: 'answer'; t: number; task_id: string; option: string }
  | { kind: 'approve_plan'; t: number; artifact_id: string }
  | { kind: 'deny_approval'; t: number; approval_id: string }
  | { kind: 'reject_plan'; t: number; artifact_id: string }

/* ── sources ─────────────────────────────────────────────────────────── */

export function fxSource(s: Omit<SourceDescriptor, 'adapter_version' | 'test_data' | 'billable' | 'supports_negative'> & Partial<Pick<SourceDescriptor, 'billable' | 'supports_negative'>>): SourceDescriptor {
  return { adapter_version: 1, billable: false, supports_negative: false, ...s, test_data: true }
}

/* ── finding builder ─────────────────────────────────────────────────── */

export function fxFinding(f: Pick<Finding, 'finding_id' | 'property_id' | 'finding_type' | 'evidence_status'> & Partial<Finding>): Finding {
  const confidence = f.confidence ?? (f.evidence_status === 'county_confirmed' ? 0.92 : f.evidence_status === 'recorded' ? 0.88 : f.evidence_status === 'vendor_reported' ? 0.55 : f.evidence_status === 'model_inference' ? 0.5 : 0)
  return {
    key: f.finding_type,
    value: null,
    display_value: null,
    is_inference: f.evidence_status === 'model_inference',
    is_discovery: false,
    is_negative_claim: false,
    freshness_state: 'fresh',
    observed_at: null,
    retrieved_at: null,
    fresh_until: null,
    source_id: null,
    citation: null,
    supersedes_id: null,
    contradicted_by: null,
    conflict_group_id: null,
    ...f,
    confidence,
    confidence_band: confidenceBand(confidence),
  }
}

/* ── research scenario builder ───────────────────────────────────────── */

type Step = [type: AgentEventType, dt: number, payload?: Record<string, unknown>]

export interface TaskSpec {
  id: string
  property: SyntheticProperty
  operation: OperationId
  source: SourceDescriptor
  finding_type: FindingType | null
  /** for research.cross_check */
  other_source?: SourceDescriptor
  section_label?: string
  planned_at: number
  start: number
  steps: Step[]
  end: Step
  billable?: boolean
  depends_on?: string[]
}

export class ScenarioWriter {
  readonly log: DraftEvent[] = []
  emit(t: number, type: AgentEventType, payload: Record<string, unknown> = {}, ids: { property_id?: string | null; task_id?: string | null; tool_call_id?: string | null } = {}) {
    this.log.push({ t, type, payload, ...ids })
    return this
  }

  label(spec: Pick<TaskSpec, 'operation' | 'source' | 'finding_type' | 'other_source' | 'section_label' | 'property'>): string {
    return renderOperationLabel(spec.operation, {
      jurisdiction: spec.property.jurisdiction,
      finding_label: spec.finding_type ? FINDING_TYPES[spec.finding_type].label.toLowerCase() : '',
      source_name: spec.source.name,
      other_source_name: spec.other_source?.name ?? '',
      section_label: spec.section_label ?? '',
      tool_label: '',
    })
  }

  /** plan.task_added at planned_at, task.started at start, then the steps (dt relative to start), then the terminal event. */
  task(spec: TaskSpec) {
    const label = this.label(spec)
    const ids = { property_id: spec.property.property_id, task_id: spec.id }
    this.emit(spec.planned_at, 'plan.task_added', { task_id: spec.id, operation: spec.operation, label, adapter_id: spec.source.adapter_id, source_id: spec.source.source_id, finding_type: spec.finding_type, depends_on: spec.depends_on ?? [], billable: Boolean(spec.billable) }, ids)
    this.emit(spec.start, 'task.started', { operation: spec.operation, label, source_id: spec.source.source_id, adapter_id: spec.source.adapter_id, finding_type: spec.finding_type }, ids)
    for (const [type, dt, payload] of spec.steps) this.emit(spec.start + dt, type, payload ?? {}, ids)
    const [type, dt, payload] = spec.end
    this.emit(spec.start + dt, type, payload ?? {}, ids)
    return label
  }

  sorted(): DraftEvent[] {
    // stable: equal t keeps authoring order
    return this.log.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e)
  }
}

/** Standard source-boundary steps for a successful retrieval. */
export function retrievalSteps(src: SourceDescriptor, purpose: string, retrievedAt: string, bytes: number, timing: [number, number, number] = [260, 640, 1180]): Step[] {
  const base = { source_id: src.source_id, host: src.host, http_class: '2xx', retrieved_at: retrievedAt, fetch_id: `fx-fetch-${src.source_id}-${timing[2]}`, purpose }
  return [
    ['source.searched', timing[0], base],
    ['source.opened', timing[1], base],
    ['source.retrieved', timing[2], { ...base, bytes }],
  ]
}

/* ── transport: materialize + controls ───────────────────────────────── */

const terminalTask = new Set<AgentEventType>(['task.completed', 'task.blocked', 'task.failed', 'task.unavailable', 'task.cancelled'])

/** Task ids that have started and not reached a terminal (or needs_input) event by time t. */
function runningTasksAt(log: DraftEvent[], t: number): Set<string> {
  const running = new Set<string>()
  for (const e of log) {
    if (e.t > t || !e.task_id) continue
    if (e.type === 'task.started') running.add(e.task_id)
    else if (terminalTask.has(e.type) || e.type === 'task.needs_input') running.delete(e.task_id)
  }
  return running
}

function plannedTasks(log: DraftEvent[], t: number): Map<string, DraftEvent> {
  const m = new Map<string, DraftEvent>()
  for (const e of log) if (e.t <= t && e.type === 'plan.task_added' && e.task_id) m.set(e.task_id, e)
  return m
}

function settledUsd(log: DraftEvent[], t: number): number {
  let usd = 0
  for (const e of log) if (e.t <= t && e.type === 'usage.settled') usd = Math.max(usd, Number(e.payload.accrued_usd ?? 0))
  return usd
}

const isJobRun = (log: DraftEvent[]) => log.some((e) => e.type === 'job.created')

/**
 * Pause (DR §1G): stop claiming new tasks. Running tasks finish (their events
 * keep their time); everything else is deferred until resume.
 */
function applyPause(log: DraftEvent[], t: number): { log: DraftEvent[]; deferred: DraftEvent[] } {
  const running = runningTasksAt(log, t)
  const keep: DraftEvent[] = []
  const deferred: DraftEvent[] = []
  for (const e of log) {
    if (e.t <= t) keep.push(e)
    else if (e.task_id && running.has(e.task_id) && e.type !== 'task.started') keep.push(e)
    else deferred.push(e)
  }
  const usd = settledUsd(log, t)
  keep.push({ t: t + 1, type: isJobRun(log) ? 'job.paused' : 'run.state', payload: isJobRun(log) ? { accrued_usd: usd } : { from: 'running', to: 'paused', reason: 'operator', accrued_usd: usd } })
  return { log: keep, deferred }
}

function applyResume(log: DraftEvent[], deferred: DraftEvent[], t: number): DraftEvent[] {
  const first = deferred.length ? Math.min(...deferred.map((e) => e.t)) : t
  const shift = Math.max(0, t + 300 - first)
  const usd = settledUsd(log, t)
  return [...log, { t: t + 1, type: isJobRun(log) ? 'job.resumed' : 'run.state', payload: isJobRun(log) ? { accrued_usd: usd } : { from: 'paused', to: 'running', reason: 'operator', accrued_usd: usd } }, ...deferred.map((e) => ({ ...e, t: e.t + shift }))]
}

/**
 * Cancel (DR §1G): queued tasks → cancelled; running tasks get the abort at the
 * next adapter boundary (cancelled, after_cancel when a billable call was
 * already in flight — it settles at its real cost); then job.cancelled. The
 * client never assumes a cancel succeeded until job.cancelled arrives.
 */
function applyCancel(log: DraftEvent[], t: number): DraftEvent[] {
  const job = isJobRun(log)
  const keep = log.filter((e) => e.t <= t)
  const running = runningTasksAt(log, t)
  const planned = plannedTasks(log, t)
  const started = new Set(keep.filter((e) => e.type === 'task.started').map((e) => e.task_id))
  const done = new Set(keep.filter((e) => e.task_id && (terminalTask.has(e.type))).map((e) => e.task_id))
  const out = [...keep]
  out.push({ t: t + 1, type: job ? 'job.cancel_requested' : 'run.cancel_requested', payload: { requested_by: 'operator', ...(job ? {} : { scope: 'run' }) } })
  let dt = 220
  for (const [id, e] of planned) {
    if (started.has(id) || done.has(id)) continue
    out.push({ t: t + dt, type: 'task.cancelled', payload: { after_cancel: false }, property_id: e.property_id, task_id: id })
    dt += 40
  }
  let usd = settledUsd(log, t)
  for (const id of running) {
    const e = planned.get(id)
    const billable = Boolean(e?.payload.billable)
    dt += 380
    if (billable) {
      usd = Math.round((usd + 0.011) * 1000) / 1000
      out.push({ t: t + dt - 60, type: 'usage.settled', payload: { reserve_id: `fx-res-${id}-cancel`, op_type: 'research.extract', route: 'research.extract', provider: 'fixture', model: 'fixture-model', tokens: 0, actual_usd: 0.011, accrued_usd: usd, remaining_usd: null }, property_id: e?.property_id, task_id: id })
    }
    out.push({ t: t + dt, type: 'task.cancelled', payload: { after_cancel: billable }, property_id: e?.property_id ?? null, task_id: id })
  }
  if (job) {
    const props = new Set(keep.filter((e) => e.type === 'job.property_state' && e.property_id).map((e) => e.property_id as string))
    const finished = new Set(keep.filter((e) => e.type === 'job.property_state' && ['completed', 'completed_partial', 'skipped_fresh'].includes(String(e.payload.state))).map((e) => e.property_id as string))
    for (const p of props) if (!finished.has(p)) out.push({ t: t + dt + 120, type: 'job.property_state', payload: { state: 'cancelled' }, property_id: p })
  }
  out.push({ t: t + dt + 260, type: job ? 'job.cancelled' : 'run.cancelled', payload: { summary: 'Cancelled by operator. Results gathered before the cancel are kept.', accrued_usd: usd, ...(job ? {} : { after_cancel_settled_usd: 0 }) } })
  return out
}

/** Answer a needs_input task: the task re-queues and runs (the scenario declares the tail in `answers`). */
function applyAnswer(log: DraftEvent[], t: number, task_id: string, option: string, answers: AnswerTails): DraftEvent[] {
  const tail = answers[task_id]?.(option) ?? []
  return [...log, ...tail.map((e) => ({ ...e, t: e.t + t, task_id: e.task_id ?? task_id }))]
}

export type AnswerTails = Record<string, (option: string) => DraftEvent[]>
export type PlanTails = Record<string, () => DraftEvent[]>

const answerRegistry = new Map<ScenarioId, AnswerTails>()
const planRegistry = new Map<ScenarioId, PlanTails>()
export function registerAnswers(id: ScenarioId, tails: AnswerTails) { answerRegistry.set(id, tails) }
export function registerPlanTails(id: ScenarioId, tails: PlanTails) { planRegistry.set(id, tails) }

/** Apply operator controls in time order to the authored log. Pure. */
export function applyControls(scenario: FixtureScenario, controls: FixtureControl[]): DraftEvent[] {
  const answered = new Set(controls.filter((c): c is Extract<FixtureControl, { kind: 'answer' }> => c.kind === 'answer').map((c) => c.task_id))
  let log = scenario.log.filter((e) => !e.when || (e.when.answered ? answered.has(e.when.answered) : true) && (e.when.unanswered ? !answered.has(e.when.unanswered) : true))
  // the scope gate: nothing past it plays until the operator confirms
  if (scenario.confirm_gate !== undefined) {
    const gate = scenario.confirm_gate
    const confirm = controls.find((c) => c.kind === 'confirm')
    log = confirm ? log.map((e) => (e.t > gate ? { ...e, t: e.t + Math.max(0, confirm.t - gate) } : e)) : log.filter((e) => e.t <= gate)
  }
  let deferred: DraftEvent[] = []
  const sorted = [...controls].filter((c) => c.kind !== 'confirm').sort((a, b) => a.t - b.t)
  for (const c of sorted) {
    if (c.kind === 'pause') { const r = applyPause(log, c.t); log = r.log; deferred = r.deferred }
    else if (c.kind === 'resume') { log = applyResume(log, deferred, c.t); deferred = [] }
    else if (c.kind === 'cancel') { log = applyCancel([...log, ...deferred], c.t); deferred = [] }
    else if (c.kind === 'answer') log = applyAnswer(log, c.t, c.task_id, c.option, answerRegistry.get(scenario.id) ?? {})
    else if (c.kind === 'approve_plan') {
      const tail = planRegistry.get(scenario.id)?.[c.artifact_id]?.() ?? []
      log = [...log, ...tail.map((e) => ({ ...e, t: e.t + c.t }))]
    } else if (c.kind === 'reject_plan') {
      log = [...log, { t: c.t + 1, type: 'plan.rejected', payload: { artifact_id: c.artifact_id, reason: 'operator_declined' } }, { t: c.t + 40, type: 'run.state', payload: { from: 'awaiting_plan_approval', to: 'completed', reason: 'plan_rejected' } }]
    } else if (c.kind === 'deny_approval') {
      log = [...log, { t: c.t + 1, type: 'approval.denied', payload: { approval_id: c.approval_id, payload_hash_prefix: 'fx', reason: 'operator_declined' } }]
    }
  }
  return log.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e)
}

/** Stamp the envelope: run_id, gapless seq from 1, event_id = base + seq, at = start + t, fixture: true. */
export function materialize(draft: DraftEvent[], runId: string, startWall: number, eventIdBase: number): AgentEvent[] {
  return draft.map((d, i) => ({
    event_id: eventIdBase + i + 1,
    run_id: runId,
    seq: i + 1,
    type: d.type,
    at: new Date(startWall + d.t).toISOString(),
    attempt: d.attempt ?? 1,
    visibility: 'operator' as const,
    property_id: d.property_id ?? null,
    task_id: d.task_id ?? null,
    tool_call_id: d.tool_call_id ?? null,
    payload: d.payload,
    fixture: true as const,
    fixture_t_ms: d.t,
  }))
}

export const lastT = (draft: DraftEvent[]) => draft.reduce((m, e) => Math.max(m, e.t), 0)
