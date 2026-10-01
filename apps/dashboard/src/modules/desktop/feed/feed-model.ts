import type { IconName } from '../../../shared/icons'
import type { EntityRef, EntityType } from '../inspector/inspector-store'

/**
 * THE MACHINE FEED — model (pure, tested).
 *
 * The feed renders the platform event envelope (GET /api/cockpit/platform/events):
 * what LeadCommand is doing and did, newest first, live-tailed. It decides
 * nothing — every row is one ledger record the server projected, with its
 * provenance and the app path that owns it.
 */

export type SourceSystem = 'inbox' | 'queue' | 'campaign' | 'workflow' | 'pipeline' | 'closing' | 'email' | 'notification' | 'deal' | 'buyer' | 'search' | 'call'
export type Severity = 'info' | 'attention' | 'warning' | 'critical'

export interface EnvelopeRef { type: string; id: string; label?: string }
export interface PlatformEvent {
  event_id: string
  occurred_at: string
  source_system: SourceSystem
  event_type: string
  severity: Severity
  actor: { kind: 'seller' | 'operator' | 'automation' | 'system'; label?: string }
  entity_refs: EnvelopeRef[]
  summary: string
  details?: Record<string, unknown> | null
  deep_link: string | null
  provenance: { table: string; row_id: string; adapter: string; ledger?: string }
  property_id?: string
  thread_key?: string
  campaign_id?: string
  workflow_run_id?: string
  closing_id?: string
  opportunity_id?: string
  market?: string
}

export interface SourceHealth { ok: boolean; freshness_at: string | null; systems: string[]; table: string; read: boolean }
export interface EventsResponse {
  ok: boolean
  events: PlatformEvent[]
  next_cursor: string | null
  sources: Record<string, SourceHealth>
  degraded: string[]
  generated_at: string
  subject?: { type: string; id: string; label: string | null } | null
  window?: { since: string; until: string }
  replay_suppressed?: boolean
  has_more?: boolean
}

/* ── filters ─────────────────────────────────────────────────────────── */

export type FeedApp = 'all' | 'inbox' | 'queue' | 'campaign' | 'workflow' | 'pipeline' | 'closing' | 'notification'
export const FEED_APPS: ReadonlyArray<{ value: FeedApp; label: string; systems: SourceSystem[] }> = [
  { value: 'all', label: 'All apps', systems: [] },
  { value: 'inbox', label: 'Inbox', systems: ['inbox'] },
  { value: 'queue', label: 'Queue', systems: ['queue', 'email'] },
  { value: 'campaign', label: 'Campaigns', systems: ['campaign'] },
  { value: 'workflow', label: 'Workflows', systems: ['workflow'] },
  { value: 'pipeline', label: 'Pipeline', systems: ['pipeline'] },
  { value: 'closing', label: 'Closing', systems: ['closing'] },
  { value: 'notification', label: 'Alerts', systems: ['notification'] },
]

export type FeedWindow = '1h' | '24h' | '7d' | '30d'
export const WINDOW_MS: Record<FeedWindow, number> = { '1h': 3600e3, '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }
export type FeedSeverity = 'all' | 'attention' | 'warning'
export const SEVERITY_SET: Record<FeedSeverity, Severity[]> = { all: [], attention: ['attention', 'warning', 'critical'], warning: ['warning', 'critical'] }

/** Event-type families the operator can narrow to (each maps to real envelope types). */
export type FeedKind = 'all' | 'replies' | 'messages' | 'automation' | 'movement' | 'campaign' | 'alerts'
export const KIND_TYPES: Record<FeedKind, string[]> = {
  all: [],
  replies: ['seller.replied', 'seller.opted_out'],
  messages: ['message.sent', 'message.failed', 'email.sent', 'email.failed'],
  automation: ['workflow.completed', 'workflow.waiting', 'workflow.held', 'workflow.failed'],
  movement: ['stage.advanced', 'stage.regressed', 'deal.opened', 'deal.status_changed', 'offer.generated', 'offer.countered', 'fact.captured', 'lead.temperature_changed', 'lead.disposition_changed'],
  campaign: ['campaign.batch_sent', 'campaign.queue_planned', 'campaign.activated', 'campaign.hydrated', 'campaign.paused', 'campaign.resumed', 'campaign.completed', 'campaign.blocked', 'campaign.failed', 'campaign.stalled'],
  alerts: ['alert.triggered'],
}
export const FEED_KINDS: ReadonlyArray<{ value: FeedKind; label: string }> = [
  { value: 'all', label: 'All events' }, { value: 'replies', label: 'Seller replies' }, { value: 'messages', label: 'Messages' },
  { value: 'automation', label: 'Automation runs' }, { value: 'movement', label: 'Deal movement' }, { value: 'campaign', label: 'Campaign activity' }, { value: 'alerts', label: 'Alerts' },
]

export interface FeedSubject { type: 'seller' | 'property' | 'campaign' | 'closing' | 'workflow'; id: string; label?: string | null }
export interface FeedFilters { app: FeedApp; kind: FeedKind; severity: FeedSeverity; window: FeedWindow; market: string | null; subject: FeedSubject | null }
export const DEFAULT_FILTERS: FeedFilters = { app: 'all', kind: 'all', severity: 'all', window: '24h', market: null, subject: null }

/** The query string for one read. `since` defaults to the window; tail reads pass their own. */
export function buildQuery(f: FeedFilters, opts: { now: number; cursor?: string | null; tailSince?: string | null; limit?: number }): string {
  const q = new URLSearchParams()
  q.set('limit', String(opts.limit ?? 60))
  if (opts.tailSince) { q.set('tail', '1'); q.set('since', opts.tailSince) }
  else q.set('since', new Date(opts.now - WINDOW_MS[f.window]).toISOString())
  if (opts.cursor) q.set('cursor', opts.cursor)
  const app = FEED_APPS.find((a) => a.value === f.app)
  if (app?.systems.length) q.set('sources', app.systems.join(','))
  if (KIND_TYPES[f.kind].length) q.set('types', KIND_TYPES[f.kind].join(','))
  if (SEVERITY_SET[f.severity].length) q.set('severity', SEVERITY_SET[f.severity].join(','))
  if (f.market) q.set('market', f.market)
  if (f.subject) { q.set('subject_type', f.subject.type); q.set('subject_id', f.subject.id) }
  return q.toString()
}

/* ── ordering + live tail ────────────────────────────────────────────── */

export const byKeyDesc = (a: PlatformEvent, b: PlatformEvent) => (a.occurred_at === b.occurred_at ? (a.event_id < b.event_id ? 1 : a.event_id > b.event_id ? -1 : 0) : a.occurred_at < b.occurred_at ? 1 : -1)

/**
 * Fold a tail read into what is on screen. A row the operator already has is
 * updated in place (a growing campaign batch keeps its identity); a row they
 * have not seen is NEW. Nothing is dropped and nothing is invented.
 */
export function mergeTail(current: PlatformEvent[], incoming: PlatformEvent[]): { events: PlatformEvent[]; added: string[] } {
  const known = new Map(current.map((e) => [e.event_id, e]))
  const added: string[] = []
  for (const e of incoming) {
    if (!known.has(e.event_id)) added.push(e.event_id)
    known.set(e.event_id, e)
  }
  return { events: [...known.values()].sort(byKeyDesc), added }
}

/** Append an older page under what is shown (keyset: never overlaps; dedupe anyway). */
export function appendPage(current: PlatformEvent[], page: PlatformEvent[]): PlatformEvent[] {
  const seen = new Set(current.map((e) => e.event_id))
  return [...current, ...page.filter((e) => !seen.has(e.event_id))]
}

/** The tail asks from a little before the newest row (late ledger writes) — the server floors to batch buckets. */
export function tailSince(events: PlatformEvent[], now: number, overlapMs = 120_000): string {
  const newest = events.length ? Date.parse(events[0].occurred_at) : now
  return new Date(Math.min(now, newest) - overlapMs).toISOString()
}

/* ── presentation ────────────────────────────────────────────────────── */

export type FeedTone = 'exec' | 'ok' | 'attn' | 'crit' | 'flow' | 'neutral'
export function toneOf(e: Pick<PlatformEvent, 'severity' | 'event_type'>): FeedTone {
  if (e.severity === 'critical' || e.severity === 'warning') return 'crit'
  if (e.severity === 'attention') return 'attn'
  if (e.event_type.startsWith('workflow.')) return 'flow'
  if (e.event_type === 'seller.replied' || e.event_type.startsWith('stage.') || e.event_type.startsWith('deal.') || e.event_type.startsWith('offer.')) return 'ok'
  if (e.event_type.startsWith('message.') || e.event_type.startsWith('campaign.')) return 'exec'
  return 'neutral'
}

const GLYPH: Array<[RegExp, IconName]> = [
  [/^seller\.replied$/, 'message'], [/^seller\.opted_out$/, 'slash'], [/^message\./, 'send'], [/^email\./, 'mail'],
  [/^campaign\.batch_sent$/, 'layers'], [/^campaign\./, 'target'], [/^workflow\./, 'zap'], [/^stage\./, 'trending-up'],
  [/^deal\./, 'briefcase'], [/^offer\./, 'dollar-sign'], [/^fact\./, 'file-text'], [/^lead\./, 'user'],
  [/^closing\./, 'key'], [/^alert\./, 'bell'],
]
export const glyphOf = (type: string): IconName => GLYPH.find(([r]) => r.test(type))?.[1] ?? 'activity'

export const SYSTEM_LABEL: Record<string, string> = { inbox: 'Inbox', queue: 'Queue', campaign: 'Campaigns', workflow: 'Workflows', pipeline: 'Pipeline', closing: 'Closing', email: 'Email', notification: 'Alerts', deal: 'Deals', buyer: 'Buyers', search: 'Search', call: 'Calls' }
export const ADAPTER_LABEL: Record<string, string> = { messages: 'Messages', campaign_sends: 'Campaign sends', workflow: 'Automation runs', lead_state: 'Seller state', pipeline: 'Deal history', campaigns: 'Campaign lifecycle', closing: 'Closing activity', notifications: 'Alerts' }

export function clockOf(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'
}

export function dayOf(iso: string, now: number): string {
  const d = new Date(iso)
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  if (day(d) === day(new Date(now))) return 'Today'
  if (day(d) === day(new Date(now - 864e5))) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Rows grouped by day, order kept. */
export function groupByDay(events: PlatformEvent[], now: number): Array<{ day: string; events: PlatformEvent[] }> {
  const out: Array<{ day: string; events: PlatformEvent[] }> = []
  for (const e of events) {
    const d = dayOf(e.occurred_at, now)
    const last = out[out.length - 1]
    if (last && last.day === d) last.events.push(e)
    else out.push({ day: d, events: [e] })
  }
  return out
}

const INSPECTABLE: Record<string, EntityType> = { seller: 'seller', property: 'property', campaign: 'campaign', closing: 'closing', workflow: 'workflow', buyer: 'buyer' }
/** Envelope refs → inspector refs (the hint carries the identifier the owning endpoint reads). */
export function inspectorRefs(e: PlatformEvent): EntityRef[] {
  return e.entity_refs.flatMap((r) => {
    const type = INSPECTABLE[r.type]
    if (!type) return []
    const hint = type === 'seller' ? { thread_key: r.id, property_id: e.property_id ?? null } : type === 'property' ? { property_id: r.id, thread_key: e.thread_key ?? null } : undefined
    return [{ type, id: r.id, label: r.label ?? null, ...(hint ? { hint } : {}) }]
  })
}

/** The replay subject an event (or ref) offers — only types the envelope can resolve. */
export function replaySubjectOf(ref: { type: string; id: string; label?: string | null; hint?: Readonly<Record<string, string | null | undefined>> }): FeedSubject | null {
  if (ref.type === 'seller') { const id = ref.hint?.thread_key || ref.id; return id ? { type: 'seller', id, label: ref.label ?? null } : null }
  if (ref.type === 'property') { const id = ref.hint?.property_id || ref.id; return id ? { type: 'property', id, label: ref.label ?? null } : null }
  if (ref.type === 'campaign' || ref.type === 'closing') return { type: ref.type, id: ref.id, label: ref.label ?? null }
  if (ref.type === 'workflow' && /^[^:]+:.+$/.test(ref.id)) return { type: 'workflow', id: ref.id, label: ref.label ?? null }
  return null
}

/** The best subject to replay from a feed row: its seller, else campaign, else run, else closing. */
export function replayFromEvent(e: PlatformEvent): FeedSubject | null {
  const refs = inspectorRefs(e)
  for (const t of ['seller', 'campaign', 'workflow', 'closing', 'property']) {
    const r = refs.find((x) => x.type === t)
    const s = r ? replaySubjectOf(r) : null
    if (s) return s
  }
  return null
}

/** Sources that answered with nothing in the window vs. sources that could not be read. */
export function sourceNotes(res: Pick<EventsResponse, 'sources' | 'degraded'> | null): { degraded: string[]; quiet: string[] } {
  if (!res) return { degraded: [], quiet: [] }
  const degraded = res.degraded.map((d) => ADAPTER_LABEL[d.split(':')[0]] ?? d)
  const quiet = Object.entries(res.sources).filter(([, s]) => s.read && s.ok && !s.freshness_at).map(([k]) => ADAPTER_LABEL[k] ?? k)
  return { degraded: [...new Set(degraded)], quiet }
}
