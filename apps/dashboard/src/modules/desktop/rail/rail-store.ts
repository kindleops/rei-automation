import { useEffect, useSyncExternalStore } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import { nextTransient, ROW_GAP_MS, type ShellEvent, type ShellTelemetry, type ShownTransient } from './rail-model'

/**
 * THE COMMAND RAIL STORE — one, for the whole shell.
 *
 * Owns: the last good telemetry (stable metrics + runtime heartbeats), the
 * transient each row is showing, per-row event queues, coalescing, priority,
 * row pacing, the bounded Live Machine buffer and one polite announcement.
 *
 * Rules it enforces:
 *  · cold load and reconnect never animate history (the server returns no
 *    events without a fresh cursor; events are deduplicated by canonical id);
 *  · one transient per row at a time, at least ROW_GAP_MS apart;
 *  · a failure or hold replaces routine execution on its row immediately;
 *  · at most three rows move at once — the rest wait their turn;
 *  · nothing here decides business state: it only replays what arrived.
 */

export interface MachineEvent extends ShellEvent { seenAt: number }

export interface RailSnapshot {
  telemetry: ShellTelemetry | null
  transients: Record<string, ShownTransient>
  recent: MachineEvent[]
  /** when the last real event landed (the mark traces once per arrival) */
  pulseAt: number | null
  updatedAt: number | null
  error: boolean
  announce: string | null
}

const POLL_VISIBLE_MS = 15_000
const POLL_HIDDEN_MS = 60_000
const RECENT_MAX = 50
const SEEN_MAX = 800
const MAX_MOVING_ROWS = 3
const ANNOUNCE_EVERY_MS = 8_000

let snap: RailSnapshot = { telemetry: null, transients: {}, recent: [], pulseAt: null, updatedAt: null, error: false, announce: null }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const set = (patch: Partial<RailSnapshot>) => { snap = { ...snap, ...patch }; emit() }

let refs = 0
let pollTimer = 0
let inflight = false
let cursor: string | null = null
const seen = new Set<string>()
const seenOrder: string[] = []
const pending = new Map<string, ShellEvent[]>()
const lastShownAt = new Map<string, number>()
const rowTimers = new Map<string, number>()
let lastAnnounceAt = 0

function remember(id: string) {
  seen.add(id)
  seenOrder.push(id)
  while (seenOrder.length > SEEN_MAX) seen.delete(seenOrder.shift()!)
}

function clearRow(app: string) {
  const { [app]: _gone, ...rest } = snap.transients
  void _gone
  set({ transients: rest })
}

function schedule(app: string, delay: number) {
  window.clearTimeout(rowTimers.get(app))
  rowTimers.set(app, window.setTimeout(() => pump(app), Math.max(0, delay)))
}

function pump(app: string) {
  const queue = pending.get(app)
  if (!queue?.length) return
  if (snap.transients[app]) return // the showing one reschedules us when it ends
  const now = Date.now()
  const since = now - (lastShownAt.get(app) ?? 0)
  if (since < ROW_GAP_MS) { schedule(app, ROW_GAP_MS - since); return }
  const next = nextTransient(queue)
  if (!next) return
  const moving = Object.keys(snap.transients).length
  if (moving >= MAX_MOVING_ROWS && next.show.tone !== 'crit' && next.show.tone !== 'attn') { schedule(app, 450); return }
  pending.set(app, queue.filter((e) => !next.consumed.has(e.id)))
  lastShownAt.set(app, now)
  const announce = next.show.tone === 'crit' || next.show.tone === 'attn' || next.show.transient === 'success'
    ? (now - lastAnnounceAt > ANNOUNCE_EVERY_MS ? `${appName(app)}: ${next.show.text}` : null)
    : null
  if (announce) lastAnnounceAt = now
  set({ transients: { ...snap.transients, [app]: next.show }, ...(announce ? { announce } : {}) })
  window.clearTimeout(rowTimers.get(app))
  rowTimers.set(app, window.setTimeout(() => {
    clearRow(app)
    lastShownAt.set(app, Date.now())
    if (pending.get(app)?.length) schedule(app, ROW_GAP_MS)
  }, next.show.durationMs))
}

const APP_NAMES: Record<string, string> = {
  '/inbox': 'Inbox', '/email-command': 'Email Command', '/queue': 'Queue', '/campaign-command': 'Campaign Command',
  '/pipeline': 'Pipeline', '/workflow-studio': 'Workflow Studio', '/closing-desk': 'Closing Desk',
}
export const appName = (route: string) => APP_NAMES[route] || route

function ingest(events: ShellEvent[]) {
  const fresh = events.filter((e) => e && e.id && !seen.has(e.id)).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
  if (!fresh.length) return
  const now = Date.now()
  for (const e of fresh) {
    remember(e.id)
    const q = pending.get(e.app) ?? []
    q.push(e)
    pending.set(e.app, q)
  }
  const recent = [...fresh.map((e) => ({ ...e, seenAt: now })).reverse(), ...snap.recent].slice(0, RECENT_MAX)
  set({ recent, pulseAt: now })
  for (const app of new Set(fresh.map((e) => e.app))) {
    const showing = snap.transients[app]
    const urgent = fresh.some((e) => e.app === app && e.priority === 1)
    // a failure or hold does not wait behind routine execution on its own row
    if (showing && urgent && showing.tone !== 'crit' && showing.tone !== 'attn') {
      window.clearTimeout(rowTimers.get(app))
      clearRow(app)
      lastShownAt.set(app, 0)
    }
    pump(app)
  }
}

async function poll() {
  if (inflight) return
  inflight = true
  try {
    const res = await callBackend<ShellTelemetry>(`/api/cockpit/shell/telemetry${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`, { timeoutMs: 60_000 })
    const t = res.ok ? (res.data as ShellTelemetry | undefined) : undefined
    if (t?.ok) {
      cursor = t.cursor
      ingest(Array.isArray(t.events) ? t.events : [])
      set({ telemetry: t, updatedAt: Date.now(), error: false })
    } else {
      set({ error: true })
    }
  } catch {
    set({ error: true })
  } finally {
    inflight = false
    if (refs > 0) {
      window.clearTimeout(pollTimer)
      pollTimer = window.setTimeout(poll, document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_VISIBLE_MS)
    }
  }
}

function onVisible() {
  if (document.visibilityState === 'visible' && refs > 0 && !inflight) {
    window.clearTimeout(pollTimer)
    pollTimer = window.setTimeout(poll, 300)
  }
}

function start() {
  refs += 1
  if (refs === 1) {
    // the surface comes first; the rail reads shortly after
    pollTimer = window.setTimeout(poll, 1200)
    document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    refs -= 1
    if (refs === 0) {
      window.clearTimeout(pollTimer)
      for (const t of rowTimers.values()) window.clearTimeout(t)
      rowTimers.clear()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const getSnapshot = () => snap

/** The rail's state. Mounting the hook starts the shared poller (ref-counted). */
export function useRail(): RailSnapshot {
  useEffect(() => start(), [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** test seam: feed events as if a poll returned them */
export const __railTest = { ingest, reset: () => { snap = { telemetry: null, transients: {}, recent: [], pulseAt: null, updatedAt: null, error: false, announce: null }; seen.clear(); seenOrder.length = 0; pending.clear(); lastShownAt.clear(); for (const t of rowTimers.values()) window.clearTimeout(t); rowTimers.clear(); lastAnnounceAt = 0 }, get: () => snap }

// DEV-ONLY QA seam: lets a capture script replay sample events into the rail
// to photograph each transient. Compiled out of production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __lcRail?: typeof __railTest }).__lcRail = __railTest
}
