import type { FeedSubject, PlatformEvent } from '../feed/feed-model'

/**
 * THE TIME MACHINE — model (pure, tested). Read-only replay of one subject's
 * recorded history: lanes per owning system, a real time axis, a cursor that
 * steps event to event, and causal arrows ONLY where the ledgers link two
 * events deterministically. Spacing is the recorded time — nothing is spread
 * out to look alive.
 */

export type ReplayRange = '72h' | '7d' | '30d' | 'custom'
export const RANGE_MS: Record<Exclude<ReplayRange, 'custom'>, number> = { '72h': 72 * 3600e3, '7d': 7 * 864e5, '30d': 30 * 864e5 }

export interface Lane { key: string; label: string; systems: string[] }
export const LANES: ReadonlyArray<Lane> = [
  { key: 'inbox', label: 'Inbox', systems: ['inbox'] },
  { key: 'queue', label: 'Queue', systems: ['queue', 'email'] },
  { key: 'campaign', label: 'Campaign', systems: ['campaign'] },
  { key: 'workflow', label: 'Workflow', systems: ['workflow'] },
  { key: 'pipeline', label: 'Pipeline', systems: ['pipeline', 'deal', 'buyer'] },
  { key: 'closing', label: 'Closing', systems: ['closing'] },
  { key: 'alerts', label: 'Alerts', systems: ['notification'] },
]
export const laneOf = (e: Pick<PlatformEvent, 'source_system'>): string => LANES.find((l) => l.systems.includes(e.source_system))?.key ?? 'alerts'

/** Which replay subjects the envelope resolves (and the release order). */
export const REPLAY_TYPES: ReadonlyArray<FeedSubject['type']> = ['seller', 'campaign', 'workflow', 'closing', 'property']
export const SUBJECT_NOUN: Record<FeedSubject['type'], string> = { seller: 'Seller', property: 'Property', campaign: 'Campaign', closing: 'Closing', workflow: 'Workflow run' }

export interface ReplayNode { event: PlatformEvent; lane: string; t: number; x: number }
export interface ReplayTimeline { from: number; to: number; nodes: ReplayNode[]; lanes: Lane[] }

/** Oldest → newest, placed on [from, to]. Only lanes that have events are drawn. */
export function buildTimeline(events: PlatformEvent[], range: { from: number; to: number }): ReplayTimeline {
  const span = Math.max(1, range.to - range.from)
  const nodes = events
    .map((e) => ({ event: e, lane: laneOf(e), t: Date.parse(e.occurred_at) }))
    .filter((n) => Number.isFinite(n.t))
    .sort((a, b) => a.t - b.t || (a.event.event_id < b.event.event_id ? -1 : 1))
    .map((n) => ({ ...n, x: Math.min(1, Math.max(0, (n.t - range.from) / span)) }))
  const used = new Set(nodes.map((n) => n.lane))
  return { from: range.from, to: range.to, nodes, lanes: LANES.filter((l) => used.has(l.key)) }
}

export interface CausalLink { from: string; to: string; why: string }
/**
 * Deterministic links only:
 *   reply → the automation run that handled THAT message (run.source_message_id)
 *   consecutive steps of the same workflow run (same run id)
 *   a send and an automation run that name the same queue row
 */
export function causalLinks(events: PlatformEvent[]): CausalLink[] {
  const ids = new Set(events.map((e) => e.event_id))
  const out: CausalLink[] = []
  for (const e of events) {
    const m = e.details?.source_message_id
    if (typeof m === 'string' && ids.has(`me:${m}`)) out.push({ from: `me:${m}`, to: e.event_id, why: 'This run handled that reply' })
  }
  const byRun = new Map<string, PlatformEvent[]>()
  for (const e of events) if (e.event_type === 'workflow.step' && e.workflow_run_id) (byRun.get(e.workflow_run_id) ?? byRun.set(e.workflow_run_id, []).get(e.workflow_run_id)!).push(e)
  for (const steps of byRun.values()) {
    const s = [...steps].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0))
    for (let i = 1; i < s.length; i++) out.push({ from: s[i - 1].event_id, to: s[i].event_id, why: 'Same run' })
  }
  const byQueue = new Map<string, PlatformEvent[]>()
  for (const e of events) { const q = e.details?.queue_id; if (typeof q === 'string' && q) (byQueue.get(q) ?? byQueue.set(q, []).get(q)!).push(e) }
  for (const group of byQueue.values()) {
    const s = [...group].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))
    for (let i = 1; i < s.length; i++) out.push({ from: s[i - 1].event_id, to: s[i].event_id, why: 'Same queue row' })
  }
  return out
}

/** Step player: index moves event to event (oldest → newest). */
export const stepTo = (index: number, count: number, dir: 1 | -1) => (count ? Math.min(count - 1, Math.max(0, index + dir)) : -1)

/** Scrubbing: the event nearest the scrub position (fraction 0..1 of the range). */
export function nearestIndex(tl: ReplayTimeline, x: number): number {
  if (!tl.nodes.length) return -1
  let best = 0
  for (let i = 1; i < tl.nodes.length; i++) if (Math.abs(tl.nodes[i].x - x) < Math.abs(tl.nodes[best].x - x)) best = i
  return best
}

/** Axis ticks at natural boundaries for the span (hours for ≤3 days, days beyond). */
export function ticksFor(from: number, to: number): Array<{ t: number; x: number; label: string; major: boolean }> {
  const span = to - from
  if (span <= 0) return []
  const H = 3600e3
  const step = span <= 26 * H ? 3 * H : span <= 4 * 864e5 ? 12 * H : span <= 10 * 864e5 ? 864e5 : 5 * 864e5
  const out: Array<{ t: number; x: number; label: string; major: boolean }> = []
  const start = new Date(from)
  start.setMinutes(0, 0, 0)
  if (step >= 864e5) start.setHours(0)
  for (let t = start.getTime(); t <= to; t += step) {
    if (t < from) continue
    const d = new Date(t)
    const major = d.getHours() === 0
    out.push({ t, x: (t - from) / span, major, label: major || step >= 864e5 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : d.toLocaleTimeString('en-US', { hour: 'numeric' }) })
    if (out.length > 40) break
  }
  return out
}

/** The replay window: preset back from now, or a custom from/to (validated). */
export function rangeOf(r: ReplayRange, now: number, custom?: { from: number; to: number } | null): { from: number; to: number } {
  if (r === 'custom' && custom && custom.to > custom.from) return { from: custom.from, to: Math.min(custom.to, now) }
  return { from: now - RANGE_MS[r === 'custom' ? '7d' : r], to: now }
}

/** Fold the replay into one-line counts per lane (what the header says). */
export function laneCounts(tl: ReplayTimeline): Record<string, number> {
  const out: Record<string, number> = {}
  for (const n of tl.nodes) out[n.lane] = (out[n.lane] ?? 0) + 1
  return out
}
