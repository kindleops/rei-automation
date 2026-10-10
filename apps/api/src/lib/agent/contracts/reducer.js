// LeadCommand Global AI Agent — pure event reducer (S1).
//
// Pure ESM; imports only sibling contracts. The server uses this to build the
// reload snapshot (GET …/runs/:id) and the UI may use the same function so the
// two can never disagree. Everything visible is derived from events: no
// timers, no invented steps, no interpolated progress.
//
// Idempotent under redelivery: events with an event_id ≤ the run's cursor are
// ignored, so replay-after-reconnect never duplicates rows. A seq gap marks
// the run `gap_detected` (the client must refetch from its cursor).

import { RESEARCH_PHASE_LABELS } from './states.js'

/** Artifact kinds (§5.4). */
export const ARTIFACT_KINDS = Object.freeze([
  'plan',
  'brief',
  'audience_proposal',
  'campaign_draft_summary',
  'reply_draft_set',
  'followup_plan',
  'action_plan',
  'diagnosis',
  'report',
  'table',
  'chart_spec',
  'economics_scenario',
  'offer_range_recommendation',
  'record_change_proposal',
])

/** @returns {Object} an empty run view */
export function emptyRunView(run_id) {
  return {
    run_id,
    kind: null,
    title: null,
    depth: null,
    state: 'created',
    phase: null,
    phase_label: null,
    status_line: null, // label of the latest started-but-unfinished operation
    last_event_id: 0,
    last_seq: 0,
    gap_detected: false,
    fixture: false,
    timeline: [], // one row per task/tool operation
    sources: {}, // source_id → source operation summary
    findings: {}, // finding_id → finding
    conflicts: {}, // conflict_group_id → conflict
    decisions: [],
    brief_sections: [],
    brief_completed: null,
    properties: {}, // property_id → { state, phase, opportunity_class, ... }
    approvals: {}, // approval_id → approval request (+ state)
    artifacts: {},
    ui_intents: [],
    messages: [],
    cost: { accrued_usd: 0, open_reserve_usd: 0, settled: [], budget_stopped: null },
    counters: { planned: 0, done: 0, blocked: 0, failed: 0, needs_input: 0, running: 0, discoveries: 0 },
    cancel_requested: false,
    terminal: false,
  }
}

const TASK_DONE_TYPES = new Set(['task.completed', 'task.blocked', 'task.failed', 'task.unavailable', 'task.cancelled'])
const TERMINAL_RUN_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.budget_exhausted',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'job.budget_exhausted',
])

function rowKey(event) {
  return event.task_id || event.tool_call_id || null
}

function findRow(view, key) {
  if (!key) return null
  for (let i = view.timeline.length - 1; i >= 0; i -= 1) {
    if (view.timeline[i].key === key) return view.timeline[i]
  }
  return null
}

function recomputeStatusLine(view) {
  for (let i = view.timeline.length - 1; i >= 0; i -= 1) {
    if (view.timeline[i].state === 'running') {
      view.status_line = view.timeline[i].label
      return
    }
  }
  view.status_line = null
}

/**
 * Apply one event to a run view (mutates and returns the view).
 * @param {Object} view
 * @param {import('./events.js').AgentEvent} event
 */
export function applyEvent(view, event) {
  if (!event || event.run_id !== view.run_id) return view
  if (event.visibility === 'internal') return view
  if (Number(event.event_id) <= view.last_event_id) return view // redelivery / replay overlap
  if (view.last_seq && Number(event.seq) !== view.last_seq + 1) view.gap_detected = true
  view.last_event_id = Number(event.event_id)
  view.last_seq = Number(event.seq)
  if (event.fixture === true) view.fixture = true

  const p = event.payload || {}
  const key = rowKey(event)

  switch (event.type) {
    case 'run.created':
      view.kind = p.kind ?? view.kind
      view.title = p.title ?? view.title
      view.depth = p.depth ?? view.depth
      break
    case 'run.state':
      view.state = p.to
      break
    case 'run.cancel_requested':
    case 'job.cancel_requested':
      view.cancel_requested = true
      break
    case 'job.phase':
      view.phase = p.phase
      view.phase_label = RESEARCH_PHASE_LABELS[p.phase] || null
      break
    case 'job.paused':
      view.state = 'paused'
      break
    case 'job.resumed':
      view.state = 'running'
      break
    case 'message.operator':
    case 'message.completed':
      view.messages.push({ event_id: event.event_id, role: event.type === 'message.operator' ? 'operator' : 'assistant', text: p.text, turn_id: p.turn_id })
      break
    case 'decision':
      view.decisions.push({ event_id: event.event_id, at: event.at, summary: p.summary, criterion: p.criterion || null, basis_finding_ids: p.basis_finding_ids || [] })
      break
    case 'plan.task_added':
      view.counters.planned += 1
      view.timeline.push({
        key,
        kind: 'task',
        label: p.label,
        operation: p.operation,
        state: 'planned',
        property_id: event.property_id,
        source_id: p.source_id || null,
        finding_type: p.finding_type || null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        cost_usd: null,
        evidence: [],
        attempt: event.attempt,
        reason: null,
      })
      break
    case 'plan.skipped_fresh':
      view.timeline.push({ key: `fresh:${event.event_id}`, kind: 'skipped_fresh', label: p.label || null, state: 'skipped_fresh', property_id: event.property_id, finding_type: p.finding_type, evidence: [] })
      break
    case 'task.started':
    case 'tool.started': {
      let row = findRow(view, key)
      if (!row) {
        row = { key, kind: event.type === 'tool.started' ? 'tool' : 'task', evidence: [], property_id: event.property_id }
        view.timeline.push(row)
        if (event.type === 'task.started') view.counters.planned += 1
      }
      row.label = p.label
      row.operation = p.operation
      row.state = 'running'
      row.started_at = event.at
      row.attempt = event.attempt
      row.source_id = p.source_id ?? row.source_id ?? null
      row.tier = p.tier ?? null
      view.counters.running += 1
      break
    }
    case 'tool.completed':
    case 'task.completed':
    case 'task.blocked':
    case 'task.failed':
    case 'task.unavailable':
    case 'task.needs_input':
    case 'task.cancelled':
    case 'tool.refused':
    case 'tool.failed': {
      const row = findRow(view, key)
      const nextState = {
        'tool.completed': 'completed',
        'task.completed': 'completed',
        'task.blocked': 'blocked',
        'task.failed': 'failed',
        'task.unavailable': 'unavailable',
        'task.needs_input': 'needs_input',
        'task.cancelled': 'cancelled',
        'tool.refused': 'refused',
        'tool.failed': 'failed',
      }[event.type]
      if (row) {
        if (row.state === 'running') view.counters.running = Math.max(0, view.counters.running - 1)
        row.state = nextState
        row.finished_at = event.at
        row.duration_ms = p.duration_ms ?? null
        row.cost_usd = p.cost_usd ?? null
        row.reason = p.reason || p.error_code || p.refusal_code || null
        if (p.question) row.question = p.question
        if (p.alternatives) row.alternatives = p.alternatives
      }
      if (TASK_DONE_TYPES.has(event.type) || event.type === 'tool.completed') view.counters.done += 1
      if (event.type === 'task.blocked') view.counters.blocked += 1
      if (event.type === 'task.failed' || event.type === 'tool.failed') view.counters.failed += 1
      if (event.type === 'task.needs_input') view.counters.needs_input += 1
      break
    }
    case 'source.searched':
    case 'source.opened':
    case 'source.retrieved':
    case 'source.blocked':
    case 'source.failed': {
      const status = event.type.split('.')[1]
      const sk = `${p.source_id}:${event.property_id || '*'}`
      const prev = view.sources[sk] || { source_id: p.source_id, property_id: event.property_id, observation_count: 0 }
      view.sources[sk] = {
        ...prev,
        status,
        host: p.host ?? prev.host,
        purpose: p.purpose ?? prev.purpose,
        retrieved_at: p.retrieved_at ?? prev.retrieved_at ?? null,
        reason: p.reason ?? null,
        message: p.message ?? null,
        alternatives: p.alternatives ?? prev.alternatives ?? [],
        task_id: event.task_id,
      }
      break
    }
    case 'observation.extracted': {
      const row = findRow(view, key)
      if (row && p.display_value) row.evidence.push({ display_value: p.display_value, finding_type: p.finding_type })
      for (const s of Object.values(view.sources)) {
        if (s.task_id === event.task_id) s.observation_count += Array.isArray(p.observation_ids) ? p.observation_ids.length : 1
      }
      break
    }
    case 'finding.upserted': {
      const f = p.finding
      if (f && f.finding_id) {
        if (f.supersedes_id && view.findings[f.supersedes_id]) view.findings[f.supersedes_id].superseded_by = f.finding_id
        if (f.contradicts_id && view.findings[f.contradicts_id]) view.findings[f.contradicts_id].contradicted_by = f.finding_id
        if (f.is_discovery && !view.findings[f.finding_id]) view.counters.discoveries += 1
        view.findings[f.finding_id] = { ...(view.findings[f.finding_id] || {}), ...f }
      }
      break
    }
    case 'finding.conflict':
      view.conflicts[p.conflict_group_id] = { ...p }
      break
    case 'brief.section':
      view.brief_sections.push({ section_key: p.section_key, label: p.label, claims: p.claims || [], claim_count: p.claim_count ?? (p.claims || []).length })
      break
    case 'brief.completed':
      view.brief_completed = { ...p }
      break
    case 'job.property_state':
      view.properties[event.property_id] = { ...(view.properties[event.property_id] || {}), ...p, property_id: event.property_id }
      break
    case 'approval.requested':
      if (p.approval?.approval_id) view.approvals[p.approval.approval_id] = { ...p.approval }
      break
    case 'approval.granted':
    case 'approval.denied':
    case 'approval.expired':
    case 'approval.invalidated':
    case 'approval.consumed': {
      const a = view.approvals[p.approval_id]
      if (a) a.state = event.type.split('.')[1]
      break
    }
    case 'artifact.created':
    case 'artifact.updated':
    case 'artifact.applied':
      view.artifacts[p.artifact_id] = { ...(view.artifacts[p.artifact_id] || {}), ...p }
      break
    case 'artifact.superseded':
      if (view.artifacts[p.artifact_id]) view.artifacts[p.artifact_id].status = 'superseded'
      break
    case 'ui.intent':
      view.ui_intents.push({ event_id: event.event_id, ...p })
      break
    case 'usage.reserved':
      view.cost.open_reserve_usd = round6(view.cost.open_reserve_usd + Number(p.worst_case_usd || 0))
      break
    case 'usage.settled':
      view.cost.settled.push({ provider: p.provider, model: p.model, op_type: p.op_type, actual_usd: Number(p.actual_usd || 0) })
      view.cost.accrued_usd = Number(p.accrued_usd ?? view.cost.accrued_usd + Number(p.actual_usd || 0))
      view.cost.open_reserve_usd = 0
      break
    case 'budget.stopped':
      view.cost.budget_stopped = { binding_cap: p.binding_cap, next_op: p.next_op }
      break
    default:
      break
  }

  if (p.accrued_usd !== undefined && event.type !== 'usage.settled' && event.type !== 'usage.reserved') {
    view.cost.accrued_usd = Number(p.accrued_usd)
  }
  if (TERMINAL_RUN_EVENTS.has(event.type)) {
    view.terminal = true
    view.state = p.state || event.type.split('.')[1]
    if (view.kind === 'research' || event.type.startsWith('job.')) {
      view.phase = event.type === 'job.completed' ? 'complete' : view.phase
      view.phase_label = view.phase ? RESEARCH_PHASE_LABELS[view.phase] || null : null
    }
  }
  recomputeStatusLine(view)
  return view
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6
}

/**
 * Reduce an ordered (or unordered) event list into per-run views.
 * @param {import('./events.js').AgentEvent[]} events
 * @returns {Record<string, Object>} run_id → view
 */
export function reduceEvents(events) {
  const sorted = [...(events || [])].sort((a, b) => Number(a.event_id) - Number(b.event_id))
  const views = {}
  for (const e of sorted) {
    if (!views[e.run_id]) views[e.run_id] = emptyRunView(e.run_id)
    applyEvent(views[e.run_id], e)
  }
  return views
}
