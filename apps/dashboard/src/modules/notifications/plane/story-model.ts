/**
 * NOTIFICATION CENTER 2.0 — client model (pure).
 *
 * The server owns grouping, priority, lens and morph (lib/domain/notifications/
 * stories). The client only: merges pages and incremental refreshes by stable
 * story id, overlays local state for stories the server cannot persist yet,
 * holds arrivals back while the operator is reading history ("N new"), and maps a
 * story to the universal object registry for every action and deep link.
 *
 * ROLES (one event, one surface that interrupts):
 *   Toast          immediate LOCAL confirmation of something the operator just did
 *                  (saved, sent, failed to save). Never a server arrival.
 *   Notification   a story relevant enough to interrupt or inform: needs you, important
 *                  activity, what the machine handled, system health. Badge + plane (+ one
 *                  sound when the rail has not already voiced the moment).
 *   Machine Feed   the broad, complete history of every event. Never interrupts.
 */
import { campaignObject, closingObject, dealObject, propertyObject, sellerObject, workflowObject, type ObjectRef } from '../../desktop/objects'

export type StoryLens = 'needs_you' | 'now' | 'resolved' | 'system'
export type StoryPriority = 'critical' | 'action' | 'important' | 'info'
export type StoryTone = 'cyan' | 'gold' | 'green' | 'red' | 'violet' | 'neutral'

export interface StoryChainItem { id: string; at: string; label: string; detail: string | null; tone: StoryTone; role: 'trigger' | 'derivative' | 'resolver'; actor: string | null; type: string | null }
export interface StorySound { id: string; category: string; priority: number; cue: 'ready' | 'success' | 'warning' | 'error' | 'attention'; emphasis?: 'subtle' | 'normal' | 'strong'; at: number; voiced_by: 'rail' | 'plane' }

export interface Story {
  id: string
  subject: { type: string; id: string; thread_key?: string; property_id?: string | null; label: string | null }
  subject_key: string
  kind: 'message' | 'condition' | 'milestone' | 'fact'
  primary_event: { id: string; type: string | null; at: string }
  title: string
  summary: string | null
  reason: string | null
  priority: StoryPriority
  peak_priority: StoryPriority
  lens: StoryLens
  state: { code: string; label: string | null; tone: StoryTone | null }
  requires_operator: boolean
  resolved: boolean
  resolved_by: 'machine' | 'operator' | 'superseded' | null
  resolved_at: string | null
  read: boolean
  read_at: string | null
  persistence: 'table' | 'notification_rows' | 'none'
  aged: boolean
  created_at: string
  updated_at: string
  last_trigger_at: string
  counts: { messages: number; events: number }
  chain: StoryChainItem[]
  source_event_ids: string[]
  notification_ids: string[]
  deep_link: string | null
  run_link: string | null
  object: { type: string; id: string; label: string | null; hint?: Record<string, string | null> } | null
  replay: { type: 'seller' | 'property' | 'campaign' | 'closing' | 'workflow'; id: string; label: string | null } | null
  missions: Array<{ kind: 'work_seller' | 'move_deal'; label: string }>
  sound: StorySound | null
  /** Signal Center firings folded into this story (rule settings + the ledger rows a Resolve also clears) */
  signal?: { rule_keys: string[]; signal_ids: string[]; severity: string | null } | null
}

export interface StoryCounts { badge: number; needs_you: number; now: number; now_unread: number; resolved: number; system: number; system_active: number }

export interface StoriesResponse {
  ok: boolean
  generated_at: string
  horizon: string | null
  truncated: boolean
  degraded: string[]
  state_store: 'table' | 'notification_rows'
  counts: StoryCounts
  stories?: Story[]
  next_cursor?: string | null
  incremental?: boolean
  ids?: string[]
  /** 'projection' = persisted story rows; 'snapshot' = the builder fallback (migration not applied) */
  source?: 'projection' | 'snapshot'
}

/* ── last-known stories (session cache: the plane renders before the network answers) ── */

export interface StoryCache { v: 1; saved_at: string; generated_at: string | null; horizon: string | null; counts: StoryCounts | null; stories: Story[]; next_cursor: string | null }
export const CACHE_MAX_STORIES = 120
/** older than this, the cache still renders but reconciles with a full first page (not `since`) */
export const CACHE_INCREMENTAL_MS = 10 * 60e3

export function serializeCache(stories: Iterable<Story>, meta: { generatedAt: string | null; horizon: string | null; counts: StoryCounts | null; nextCursor: string | null }, now = Date.now()): string {
  const list = [...stories].sort(byActivity).slice(0, CACHE_MAX_STORIES)
  const c: StoryCache = { v: 1, saved_at: new Date(now).toISOString(), generated_at: meta.generatedAt, horizon: meta.horizon, counts: meta.counts, stories: list, next_cursor: meta.nextCursor }
  return JSON.stringify(c)
}

export function parseCache(raw: string | null, now = Date.now()): (StoryCache & { incremental: boolean }) | null {
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as StoryCache
    if (!c || c.v !== 1 || !Array.isArray(c.stories)) return null
    const age = now - Date.parse(c.saved_at || '')
    if (!Number.isFinite(age) || age < 0 || age > 8 * 864e5) return null
    return { ...c, incremental: age <= CACHE_INCREMENTAL_MS && Boolean(c.generated_at) }
  } catch { return null }
}

/* ── keyboard: ↑/↓ through the visible stories (clamped; Home/End jump) ── */

export function nextStoryIndex(cur: number, key: string, len: number): number | null {
  if (!len) return null
  if (key === 'ArrowDown') return cur < 0 ? 0 : Math.min(len - 1, cur + 1)
  if (key === 'ArrowUp') return cur < 0 ? 0 : Math.max(0, cur - 1)
  if (key === 'Home') return 0
  if (key === 'End') return len - 1
  return null
}

export const LENS_ORDER: StoryLens[] = ['needs_you', 'now', 'resolved', 'system']
export const LENS_LABEL: Record<StoryLens, string> = { needs_you: 'Needs you', now: 'Now', resolved: 'Resolved', system: 'System' }

/** Newest activity first; ties by id (the server's order). */
export const byActivity = (a: Story, b: Story) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id < b.id ? 1 : -1)

/* ── local state overlay (persistence 'none' until the state table exists) ── */

export interface LocalMark { read_at?: string | null; resolved_at?: string | null }
export type LocalMarks = Record<string, LocalMark>

/** A local mark only holds until the story's next trigger — exactly like the server rule. */
export function applyLocal(s: Story, marks: LocalMarks): Story {
  if (s.persistence !== 'none') return s
  const m = marks[s.id]
  if (!m) return s
  const fresh = (v?: string | null) => Boolean(v && v >= s.last_trigger_at)
  let out = s
  if (!s.read && fresh(m.read_at)) out = { ...out, read: true, read_at: m.read_at ?? null }
  if (!s.resolved && fresh(m.resolved_at)) {
    out = { ...out, read: true, resolved: true, resolved_by: 'operator', resolved_at: m.resolved_at ?? null, requires_operator: false, priority: 'info', lens: s.lens === 'system' ? 'system' : 'resolved', sound: null }
  }
  return out
}

/** Recount the badge after local overlays (same rule as the server's countStories). */
export function countLocal(stories: Story[]): StoryCounts {
  const c: StoryCounts = { badge: 0, needs_you: 0, now: 0, now_unread: 0, resolved: 0, system: 0, system_active: 0 }
  const rank: Record<StoryPriority, number> = { critical: 3, action: 2, important: 1, info: 0 }
  for (const s of stories) {
    c[s.lens] += 1
    if (s.lens === 'now' && !s.read) c.now_unread += 1
    if (s.lens === 'system' && !s.resolved) c.system_active += 1
    if (!s.resolved && (s.requires_operator || s.priority === 'critical' || (s.lens === 'now' && !s.read && rank[s.priority] >= 1))) c.badge += 1
  }
  return c
}

/* ── merging: pages + incremental refresh, stable ids ────────────────────── */

export interface MergeResult { map: Map<string, Story>; arrived: Story[]; changed: Story[] }

/** Merge fresh stories into the known set. `arrived` = ids never seen before. */
export function mergeStories(prev: Map<string, Story>, incoming: Story[], liveIds?: string[] | null): MergeResult {
  const map = new Map(prev)
  const arrived: Story[] = []
  const changed: Story[] = []
  for (const s of incoming) {
    const old = map.get(s.id)
    if (!old) arrived.push(s)
    else if (old.updated_at !== s.updated_at || old.lens !== s.lens || old.read !== s.read || old.resolved !== s.resolved) changed.push(s)
    map.set(s.id, s)
  }
  // the server's full id list drops stories that aged out of its window
  if (liveIds) { const live = new Set(liveIds); for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id) }
  return { map, arrived, changed }
}

/**
 * The visible order. While the operator reads history (scrolled away from the
 * top), arrivals are held and existing stories morph IN PLACE — nothing above the
 * reading position moves. At the top, the list is simply newest-first.
 */
export function visibleOrder(all: Story[], lens: StoryLens, frozen: string[] | null, held: Set<string>): Story[] {
  const inLens = all.filter((s) => s.lens === lens && !held.has(s.id))
  if (!frozen) return inLens.sort(byActivity)
  const pos = new Map(frozen.map((id, i) => [id, i]))
  const kept = inLens.filter((s) => pos.has(s.id)).sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0))
  const extra = inLens.filter((s) => !pos.has(s.id)).sort(byActivity)
  return [...kept, ...extra]
}

/** Default lens on open: what needs the operator, else what is happening. */
export function defaultLens(c: StoryCounts | null): StoryLens {
  if (!c) return 'needs_you'
  if (c.needs_you > 0) return 'needs_you'
  if (c.now > 0) return 'now'
  if (c.system_active > 0) return 'system'
  return 'now'
}

/* ── object registry mapping (canonical ids only) ────────────────────────── */

export function storyObject(s: Story): ObjectRef | null {
  const o = s.object
  if (!o) return null
  const src = 'notifications'
  if (o.type === 'seller') return sellerObject({ threadKey: o.id, propertyId: o.hint?.property_id ?? null, label: o.label, source: src })
  if (o.type === 'campaign') return campaignObject({ campaignId: o.id, label: o.label, source: src })
  if (o.type === 'closing') return closingObject({ closingId: o.id, label: o.label, source: src })
  if (o.type === 'deal') return dealObject({ opportunityId: o.id, label: o.label, source: src })
  if (o.type === 'property') return propertyObject({ propertyId: o.id, label: o.label, source: src })
  if (o.type === 'workflow') {
    const run = s.replay?.type === 'workflow' ? s.replay.id.slice(s.replay.id.indexOf(':') + 1) : null
    return workflowObject({ workflowKey: o.id, runId: run, label: o.label, source: src })
  }
  return null
}

/** The held seller run, as its own workflow object ("Review run"). */
export function runObject(s: Story): ObjectRef | null {
  if (!s.run_link) return null
  const q = new URLSearchParams(s.run_link.split('?')[1] || '')
  const wf = q.get('wf')
  return wf ? workflowObject({ workflowKey: wf, runId: q.get('run'), threadKey: s.subject.thread_key ?? null, propertyId: s.subject.property_id ?? null, source: 'notifications' }) : null
}

/* ── presentation ────────────────────────────────────────────────────────── */

/** Semantic accent: red = real problem, green = resolved, cyan = active/neutral, gold = attention/opportunity. */
export function storyTone(s: Story): StoryTone {
  if (s.resolved) return s.resolved_by === 'superseded' ? 'neutral' : 'green'
  if (s.priority === 'critical') return 'red'
  if (s.requires_operator) return 'gold'
  if (s.state.tone === 'red') return 'red'
  if (s.priority === 'info') return 'neutral'
  return 'cyan'
}

const MIN = 60e3
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  const d = Math.max(0, now - t)
  if (d < MIN) return 'now'
  if (d < 60 * MIN) return `${Math.floor(d / MIN)}m`
  if (d < 24 * 60 * MIN) return `${Math.floor(d / (60 * MIN))}h`
  if (d < 7 * 24 * 60 * MIN) return `${Math.floor(d / (24 * 60 * MIN))}d`
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function clockTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/** Truthful empty copy per lens — never sample notifications. */
export const EMPTY_COPY: Record<StoryLens, { title: string; body: string; icon: 'check' | 'activity' | 'check-double' | 'shield' }> = {
  needs_you: { title: 'Nothing needs you', body: 'Held replies, call requests, seller counters and blocked campaigns land here the moment they happen.', icon: 'check' },
  now: { title: 'Quiet right now', body: 'Seller replies and important activity appear here as they arrive.', icon: 'activity' },
  resolved: { title: 'Nothing handled yet', body: 'What the machine answered or you closed collects here, then ages into history.', icon: 'check-double' },
  system: { title: 'All systems healthy', body: 'Senders, queue and platform health report here — one story per component.', icon: 'shield' },
}

export const DEGRADED_LABEL: Record<string, string> = {
  workflow: 'automation runs', messages: 'messages', lead_state: 'stage changes', pipeline: 'deal changes', campaigns: 'campaigns', closing: 'closings',
}
export function degradedText(list: string[]): string | null {
  const names = [...new Set(list.map((d) => d.split(':')[0]).map((d) => DEGRADED_LABEL[d] || (d.startsWith('notification_events') ? 'alerts' : d.startsWith('platform_events') ? 'the event stream' : d)))]
  return names.length ? `Could not read ${names.join(', ')} just now — stories may be missing their latest step.` : null
}
