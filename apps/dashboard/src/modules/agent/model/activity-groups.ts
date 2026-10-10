/**
 * ACTIVITY GROUPS (owner, 10-09) — routine activity collapses into meaningful
 * groups (property × tool family: "LeadCommand property record · 3 reads
 * completed"), while everything that matters stays ungrouped and visible:
 * blockers, failures, unavailable reads, questions, running work, discoveries,
 * and any read whose findings are in a conflict. Pure; derived only from the
 * view. The complete event log stays inspectable elsewhere (EventLog).
 */
import { RESEARCH_PHASES, RESEARCH_PHASE_LABELS, type ResearchPhase } from '../contracts/contracts'
import { timelineState, type DecisionView, type ResearchView, type TaskRow } from './research-model'
import type { SourceRef } from './evidence-class'

export type ActivityFilter = 'all' | 'recorded' | 'planned' | 'noval'
export type RowKind = 'recorded' | 'planned' | 'noval'

export const rowKind = (t: TaskRow): RowKind => {
  const s = timelineState(t.state)
  if (s === 'planned') return 'planned'
  if (s === 'blocked' || s === 'unavailable' || s === 'failed') return 'noval'
  return 'recorded'
}

/** Why a row is shown on its own (never folded into a group). */
export type Exception = 'running' | 'needs_input' | 'blocked' | 'failed' | 'unavailable' | 'discovery' | 'conflict' | 'contradicted' | 'retried'

export function exceptionOf(t: TaskRow, view: ResearchView, conflictMembers: Set<string>): Exception | null {
  switch (t.state) {
    case 'running': return 'running'
    case 'needs_input': return 'needs_input'
    case 'blocked': return 'blocked'
    case 'failed': return 'failed'
    case 'unavailable': return 'unavailable'
    default: break
  }
  for (const id of t.finding_ids) {
    const f = view.findings[id]
    if (!f) continue
    if (f.is_discovery) return 'discovery'
    if (conflictMembers.has(id) || f.conflict_group_id) return 'conflict'
    if (f.contradicted_by) return 'contradicted'
  }
  if (t.attempt > 1) return 'retried'
  return null
}

export interface Bucket {
  kind: 'bucket'
  key: string
  order: number
  family: string
  property_id: string | null
  tasks: TaskRow[]
  /** shown on their own, always */
  exceptions: Array<{ task: TaskRow; why: Exception }>
  /** folded until the group is opened */
  routine: TaskRow[]
  counts: { completed: number; planned: number; noval: number; running: number; findings: number; unavailableFindings: number; conflicts: number; discoveries: number }
}

export type TimelineEntry =
  | Bucket
  | { kind: 'decision'; key: string; order: number; decision: DecisionView }
  | { kind: 'skipped'; key: string; order: number; label: string; fresh_until: string | null }

export interface PhaseGroup { phase: string; label: string; entries: TimelineEntry[]; past: boolean; taskCount: number }

const familyOf = (t: TaskRow, sources: Record<string, SourceRef>) => (t.source_id ? sources[t.source_id]?.name ?? t.source_id : t.tool ?? t.operation ?? 'Operations')

function phaseAt(view: ResearchView, eventId: number): ResearchPhase {
  let p: ResearchPhase = 'planning'
  for (const h of view.phase_history) if (h.event_id <= eventId) p = h.phase
  return p
}

/** Group the timeline: phase → buckets (property × family) + decisions + reused-fresh rows. */
export function groupActivity(view: ResearchView, sources: Record<string, SourceRef>, opts: { propertyId: string | null; filter: ActivityFilter }): PhaseGroup[] {
  const conflictMembers = new Set<string>()
  for (const c of Object.values(view.conflicts)) for (const m of c.members) conflictMembers.add(m)
  const byPhase = new Map<string, TimelineEntry[]>()
  const bucketIndex = new Map<string, Bucket>()
  const add = (phase: string, e: TimelineEntry) => { if (!byPhase.has(phase)) byPhase.set(phase, []); byPhase.get(phase)!.push(e) }
  for (const t of view.tasks) {
    if (opts.propertyId && t.property_id !== opts.propertyId) continue
    const k = rowKind(t)
    if (opts.filter !== 'all' && k !== opts.filter) continue
    const phase = k === 'planned' ? 'next' : t.phase
    const family = familyOf(t, sources)
    const key = `${phase}|${opts.propertyId ? '' : t.property_id ?? ''}|${family}`
    let b = bucketIndex.get(key)
    if (!b) {
      b = { kind: 'bucket', key, order: k === 'planned' ? t.planned_seq : t.first_event_id, family, property_id: opts.propertyId ? null : t.property_id, tasks: [], exceptions: [], routine: [], counts: { completed: 0, planned: 0, noval: 0, running: 0, findings: 0, unavailableFindings: 0, conflicts: 0, discoveries: 0 } }
      bucketIndex.set(key, b)
      add(phase, b)
    }
    b.tasks.push(t)
    b.order = Math.min(b.order, k === 'planned' ? t.planned_seq : t.first_event_id)
    const why = exceptionOf(t, view, conflictMembers)
    if (why) b.exceptions.push({ task: t, why }); else b.routine.push(t)
    if (t.state === 'running') b.counts.running += 1
    else if (k === 'planned') b.counts.planned += 1
    else if (k === 'noval') b.counts.noval += 1
    else b.counts.completed += 1
    b.counts.findings += t.finding_ids.length
    b.counts.unavailableFindings += t.finding_ids.filter((id) => ['unavailable', 'blocked'].includes(view.findings[id]?.evidence_status ?? '')).length
    b.counts.conflicts += t.finding_ids.filter((id) => conflictMembers.has(id)).length
    b.counts.discoveries += t.finding_ids.filter((id) => view.findings[id]?.is_discovery).length
  }
  if (opts.filter === 'all' || opts.filter === 'recorded') {
    for (const d of view.decisions) {
      if (opts.propertyId && d.property_id && d.property_id !== opts.propertyId) continue
      add(phaseAt(view, d.event_id), { kind: 'decision', key: `d${d.event_id}`, order: d.event_id, decision: d })
    }
    for (const s of view.skipped_fresh) {
      if (opts.propertyId && s.property_id !== opts.propertyId) continue
      add(phaseAt(view, s.event_id), { kind: 'skipped', key: `s${s.event_id}`, order: s.event_id, label: s.label, fresh_until: s.fresh_until })
    }
  }
  const out: PhaseGroup[] = []
  const cur = view.phase ? RESEARCH_PHASES.indexOf(view.phase) : 0
  for (const ph of [...RESEARCH_PHASES, 'next'] as string[]) {
    const entries = byPhase.get(ph)
    if (!entries?.length) continue
    for (const b of entries) if (b.kind === 'bucket') { b.tasks.sort((x, y) => (ph === 'next' ? x.planned_seq - y.planned_seq : x.first_event_id - y.first_event_id)); b.routine.sort((x, y) => (ph === 'next' ? x.planned_seq - y.planned_seq : x.first_event_id - y.first_event_id)) }
    entries.sort((a, b) => a.order - b.order)
    out.push({ phase: ph, label: ph === 'next' ? 'Planned · not started' : RESEARCH_PHASE_LABELS[ph as ResearchPhase], entries, past: ph !== 'next' && RESEARCH_PHASES.indexOf(ph as ResearchPhase) < cur, taskCount: entries.reduce((n, e) => n + (e.kind === 'bucket' ? e.tasks.length : 0), 0) })
  }
  return out
}

/** "3 reads completed · 1 unavailable · 2 conflicts" */
export function bucketSummary(b: Bucket): string {
  const c = b.counts
  const parts: string[] = []
  if (c.completed) parts.push(`${c.completed} read${c.completed === 1 ? '' : 's'} completed`)
  if (c.running) parts.push(`${c.running} running`)
  if (c.planned) parts.push(`${c.planned} planned`)
  if (c.noval) parts.push(`${c.noval} returned no value`)
  if (c.unavailableFindings) parts.push(`${c.unavailableFindings} finding${c.unavailableFindings === 1 ? '' : 's'} unavailable`)
  if (c.discoveries) parts.push(`${c.discoveries} discover${c.discoveries === 1 ? 'y' : 'ies'}`)
  if (c.conflicts) parts.push(`${c.conflicts} in conflict`)
  return parts.join(' · ')
}

export const EXCEPTION_LABEL: Record<Exception, string> = {
  running: 'Running', needs_input: 'Needs you', blocked: 'Blocked', failed: 'Failed', unavailable: 'No value', discovery: 'Discovery', conflict: 'In conflict', contradicted: 'Contradicted', retried: 'Retried',
}
