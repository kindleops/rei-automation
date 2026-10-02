/**
 * NOTIFICATION CENTER 2.0 — the one client store (module singleton).
 *
 * One reader for the badge and the plane: page one on start, then incremental
 * refreshes (`since`) — 60s while the plane is closed, 20s while it is open.
 * No per-story requests. Arrivals voice ONE sound per story trigger through the
 * Sound System (event identity `story:<trigger id>`; the arbiter dedupes across
 * tabs, holds for Pause all alerts / quiet hours, and keeps cold loads silent),
 * and only when the Command Rail has not already voiced the same moment.
 */
import { useSyncExternalStore } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import { sound, type OperationalCue } from '../../../shared/sound'
import { applyLocal, countLocal, mergeStories, type LocalMarks, type StoriesResponse, type Story, type StoryCounts } from './story-model'

const PATH = '/api/cockpit/notifications/stories'
const CLOSED_MS = 60_000
const OPEN_MS = 20_000
const LOCAL_KEY = 'lc.notifications.story-marks'

export interface StoryStoreState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  stories: Map<string, Story>
  counts: StoryCounts | null
  generatedAt: string | null
  horizon: string | null
  truncated: boolean
  degraded: string[]
  stateStore: 'table' | 'notification_rows' | null
  nextCursor: string | null
  loadingMore: boolean
  /** ids that arrived while the plane was open (the "N new" pill decides whether to show them) */
  arrivals: string[]
}

let state: StoryStoreState = { status: 'idle', error: null, stories: new Map(), counts: null, generatedAt: null, horizon: null, truncated: false, degraded: [], stateStore: null, nextCursor: null, loadingMore: false, arrivals: [] }
const listeners = new Set<() => void>()
let marks: LocalMarks = readMarks()
let timer: ReturnType<typeof setTimeout> | null = null
let open = false
let started = 0
let inflight = false

function readMarks(): LocalMarks {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') as LocalMarks } catch { return {} }
}
function writeMarks() {
  try {
    // keep the store small: marks older than the server window are meaningless
    const floor = new Date(Date.now() - 8 * 864e5).toISOString()
    for (const [k, v] of Object.entries(marks)) if ((v.read_at || '') < floor && (v.resolved_at || '') < floor) delete marks[k]
    localStorage.setItem(LOCAL_KEY, JSON.stringify(marks))
  } catch { /* storage full or blocked: the marks live for this session */ }
}

function emit() { for (const l of listeners) l() }
function set(patch: Partial<StoryStoreState>) {
  state = { ...state, ...patch }
  if (patch.stories) state.counts = countLocal([...state.stories.values()])
  emit()
}

const overlay = (list: Story[]) => list.map((s) => applyLocal(s, marks))

async function read(qs: string): Promise<StoriesResponse | string> {
  const res = await callBackend<StoriesResponse>(`${PATH}?${qs}`, { timeoutMs: 45_000 })
  if (!res.ok) return res.status === 401 ? 'Sign in again to see notifications.' : 'Notifications could not be read right now.'
  const data = res.data as StoriesResponse | undefined
  return data?.ok ? data : 'Notifications could not be read right now.'
}

/** One sound per story trigger the rail has not voiced; derivatives never sound. */
export function voice(list: Story[]) {
  for (const s of list) {
    const c = s.sound
    if (!c || c.voiced_by !== 'plane' || s.resolved) continue
    const cue: OperationalCue = { id: c.id, category: c.category as OperationalCue['category'], priority: c.priority, cue: c.cue, emphasis: c.emphasis, at: c.at }
    sound.machine.event(cue)
  }
}

async function loadFirst() {
  if (inflight) return
  inflight = true
  if (state.status === 'idle') set({ status: 'loading' })
  const r = await read('lens=all&limit=100')
  inflight = false
  if (typeof r === 'string') { set({ status: state.stories.size ? 'ready' : 'error', error: r }); return }
  const { map } = mergeStories(new Map(), overlay(r.stories || []))
  set({ status: 'ready', error: null, stories: map, generatedAt: r.generated_at, horizon: r.horizon, truncated: r.truncated, degraded: r.degraded, stateStore: r.state_store, nextCursor: r.next_cursor ?? null })
}

async function refresh() {
  if (inflight) return
  if (!state.generatedAt) { await loadFirst(); return }
  inflight = true
  const r = await read(`since=${encodeURIComponent(state.generatedAt)}`)
  inflight = false
  if (typeof r === 'string') { set({ error: r }); return }
  // ids the server no longer holds aged out of its window; keep paged-in history (not in `ids`) only if older than the horizon
  const { map, arrived, changed } = mergeStories(state.stories, overlay(r.stories || []), null)
  if (r.ids) { const live = new Set(r.ids); for (const [id, s] of map) if (!live.has(id) && r.horizon && s.updated_at >= r.horizon) map.delete(id) }
  voice([...arrived, ...changed.filter((s) => s.sound && s.sound.id !== state.stories.get(s.id)?.sound?.id)])
  set({ error: null, stories: map, generatedAt: r.generated_at, horizon: r.horizon, truncated: r.truncated, degraded: r.degraded, stateStore: r.state_store, arrivals: open ? [...state.arrivals, ...arrived.map((s) => s.id)] : state.arrivals })
}

export async function loadMoreStories() {
  if (!state.nextCursor || state.loadingMore) return
  set({ loadingMore: true })
  const r = await read(`lens=all&limit=100&cursor=${encodeURIComponent(state.nextCursor)}`)
  if (typeof r === 'string') { set({ loadingMore: false, error: r }); return }
  const { map } = mergeStories(state.stories, overlay(r.stories || []))
  set({ loadingMore: false, stories: map, nextCursor: r.next_cursor ?? null })
}

function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => { await refresh(); schedule() }, open ? OPEN_MS : CLOSED_MS)
}

/** Start reading (the shell mounts this once). Returns the stop function. */
export function startStoryStore(): () => void {
  started += 1
  if (started === 1) { void loadFirst(); schedule() }
  return () => {
    started -= 1
    if (started === 0 && timer) { clearTimeout(timer); timer = null }
  }
}

/** The plane is open: refresh now and faster; arrivals are tracked for "N new". */
export function setPlaneOpen(v: boolean) {
  if (open === v) return
  open = v
  if (v) { set({ arrivals: [] }); void refresh() }
  schedule()
}

export function clearArrivals() { if (state.arrivals.length) set({ arrivals: [] }) }
export function retryStories() { set({ status: state.stories.size ? 'ready' : 'loading', error: null }); void (state.generatedAt ? refresh() : loadFirst()) }

/* ── READ / RESOLVED (separate, both persisted) ────────────────────────── */

type Action = 'read' | 'unread' | 'resolve' | 'reopen'
interface StateResponse { ok: boolean; stories: Story[]; persisted: Record<string, 'table' | 'notification_rows' | 'none'> }

function optimistic(ids: string[], action: Action) {
  const now = new Date().toISOString()
  const map = new Map(state.stories)
  for (const id of ids) {
    const s = map.get(id)
    if (!s) continue
    if (action === 'read') map.set(id, { ...s, read: true, read_at: now })
    if (action === 'unread') map.set(id, { ...s, read: false, read_at: null })
    if (action === 'resolve') map.set(id, applyLocal({ ...s, persistence: 'none' }, { [id]: { read_at: now, resolved_at: now } }))
  }
  set({ stories: map })
}

export async function markStories(ids: string[], action: Action) {
  const list = ids.filter((id) => state.stories.has(id))
  if (!list.length) return
  optimistic(list, action)
  const res = await callBackend<StateResponse>(`${PATH}/state`, { method: 'POST', body: JSON.stringify({ story_ids: list, action }), headers: { 'Content-Type': 'application/json' } })
  const now = new Date().toISOString()
  const data = res.ok ? (res.data as StateResponse | undefined) : undefined
  const map = new Map(state.stories)
  for (const id of list) {
    const persisted = data?.persisted?.[id] ?? 'none'
    const fresh = data?.stories?.find((s) => s.id === id)
    // the server could not keep it (no state table, no member alerts) → keep it here
    if (persisted === 'none' || !fresh) {
      const m = (marks[id] ||= {})
      if (action === 'read') m.read_at = now
      if (action === 'unread') m.read_at = null
      if (action === 'resolve') { m.resolved_at = now; m.read_at = m.read_at || now }
      if (action === 'reopen') m.resolved_at = null
    }
    if (fresh) map.set(id, applyLocal(fresh, marks))
    else { const s = map.get(id); if (s) map.set(id, applyLocal({ ...s, persistence: 'none' }, marks)) }
  }
  writeMarks()
  set({ stories: map })
}

/* ── hooks ─────────────────────────────────────────────────────────────── */

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const get = () => state
export const useStoryStore = () => useSyncExternalStore(subscribe, get, get)
const badge = () => state.counts?.badge ?? 0
export const useStoryBadge = () => useSyncExternalStore(subscribe, badge, badge)

export const __storyStore = { get, reset: () => { state = { ...state, status: 'idle', stories: new Map(), counts: null, generatedAt: null, arrivals: [] }; marks = {}; emit() } }
