/**
 * THE Command Wall data channel (§24, §28–§31, §56). One per page.
 *
 * Every widget (map, rail, feed, status, capsule) reads from this one channel;
 * nothing else on the wall talks to the network except the map's cached
 * context layers. Cadence per display:
 *   events     every 15 s   (server: one shared tick)
 *   state      every 30 s   (server: one shared snapshot)
 *   heartbeat  every 60 s   (server: ≤ 1 write/min)
 *   ≈ 7 requests/min/display, zero when the page is hidden.
 *
 * Failures go through the recovery ladder; the last good data is kept and
 * shown (with its age) whatever happens.
 */
import { applyEventsReply, emptyEvents, type WallEventsState } from './wall-feed-model'
import { BACKOFF_MS, backoffFor, createRecoveryLadder, type RecoveryAction, type RecoveryLadder } from './wall-recovery'
import { WallHttpError, type WallApi } from './wall-api'
import type { WallConnection, WallEvent, WallSession, WallState } from './wall-types'

export const EVENTS_MS = 15_000
export const STATE_MS = 30_000
export const HEARTBEAT_MS = 60_000

export interface WallChannelSnapshot {
  session: WallSession | null
  state: WallState | null
  events: WallEventsState
  connection: WallConnection
  unpaired: boolean
  lastOkAt: number | null
  lastStateAt: number | null
  lastEventsAt: number | null
  errors: number
  reconnects: number
  softReloads: number
  version: number
}

export interface WallTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

export interface WallChannelOptions {
  api: WallApi
  now?: () => number
  timers?: WallTimers
  online?: () => boolean
  ladder?: RecoveryLadder
  /** extra fields for the heartbeat (build, render mode, preset, client), given the current view context */
  heartbeatInfo?: (ctx: WallViewContext) => Record<string, unknown>
  /** does the active view need the Market Intelligence section? which markets? */
  miQuery?: (ctx: WallViewContext) => { mi: boolean; markets: string[] }
  onSoftReload?: () => void
  /** Return true when the reload happened; false (e.g. origin unreachable) keeps the channel retrying. */
  onFullReload?: () => boolean | Promise<boolean>
}

type Job = 'events' | 'state' | 'heartbeat'

/** What the page is currently showing — set by the UI, read when a request is built. */
export interface WallViewContext { preset: string; renderMode: string; market: string | null }

export function createWallChannel(opts: WallChannelOptions) {
  const api = opts.api
  const now = opts.now ?? (() => Date.now())
  const timers: WallTimers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const online = opts.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  const ladder = opts.ladder ?? createRecoveryLadder({ now })
  const listeners = new Set<() => void>()
  const arrivalListeners = new Set<(evs: WallEvent[]) => void>()
  const handles: Partial<Record<Job, unknown>> = {}
  const inflight: Partial<Record<Job, boolean>> = {}
  let running = false
  let paused = false
  let context: WallViewContext = { preset: 'national_command', renderMode: 'full', market: null }
  const startedAt = now()

  let snap: WallChannelSnapshot = {
    session: null, state: null, events: emptyEvents(), connection: 'connecting', unpaired: false,
    lastOkAt: null, lastStateAt: null, lastEventsAt: null, errors: 0, reconnects: 0, softReloads: 0, version: 0,
  }
  const set = (patch: Partial<WallChannelSnapshot>) => {
    snap = { ...snap, ...patch, version: snap.version + 1 }
    for (const l of listeners) l()
  }

  const cadence: Record<Job, number> = { events: EVENTS_MS, state: STATE_MS, heartbeat: HEARTBEAT_MS }

  function schedule(job: Job, ms: number) {
    if (!running) return
    if (handles[job]) timers.clearTimeout(handles[job])
    handles[job] = timers.setTimeout(() => { handles[job] = undefined; void run(job) }, Math.max(0, ms))
  }

  function ok() {
    ladder.success()
    set({ connection: 'live', lastOkAt: now() })
  }

  const sideAttempts: Partial<Record<Job, number>> = {}
  function handleFailure(job: Job, error: unknown) {
    const e = error instanceof WallHttpError ? error : new WallHttpError(0, 'unknown')
    if (e.unpaired) { stop(); set({ unpaired: true, connection: 'offline' }); return }
    if (e.status === 429) { schedule(job, Math.max(cadence[job], e.retryAfterMs ?? 30_000)); return }
    // Only the events job drives the ladder: three jobs failing together are ONE outage,
    // not three times the failures (the soak caught a 4-min 503 escalating to a reload).
    if (job !== 'events') {
      sideAttempts[job] = (sideAttempts[job] || 0) + 1
      set({ errors: snap.errors + 1, connection: online() ? 'reconnecting' : 'offline' })
      schedule(job, Math.max(cadence[job], backoffFor(sideAttempts[job] as number)))
      return
    }
    const action: RecoveryAction = ladder.failure({ online: online() })
    set({ errors: snap.errors + 1, connection: online() ? 'reconnecting' : 'offline' })
    switch (action.type) {
      case 'retry':
      case 'hold':
        schedule(job, action.delayMs)
        break
      case 'reconnect':
        set({ reconnects: snap.reconnects + 1 })
        // a reconnect re-reads from the cursor; the server resends anything newer
        schedule(job, action.delayMs)
        break
      case 'refresh_data':
        set({ events: { ...snap.events, epoch: null } })
        schedule('state', action.delayMs)
        schedule('events', action.delayMs)
        break
      case 'soft_reload':
        set({ softReloads: snap.softReloads + 1 })
        opts.onSoftReload?.()
        schedule(job, action.delayMs)
        break
      case 'full_reload':
        // the app decides (probing the origin first); either way keep retrying until the page goes
        void Promise.resolve(opts.onFullReload?.() ?? false).then((reloaded) => { if (reloaded) ladder.noteFullReload() })
        schedule(job, BACKOFF_MS[BACKOFF_MS.length - 1])
        break
    }
  }

  async function run(job: Job) {
    if (!running || paused || inflight[job]) return
    inflight[job] = true
    try {
      if (job === 'events') {
        const reply = await api.events({ after: snap.events.head, epoch: snap.events.epoch })
        const { state, arrived } = applyEventsReply(snap.events, reply)
        set({ events: state, lastEventsAt: now() })
        if (arrived.length) for (const l of arrivalListeners) l(arrived)
        // config changed server-side → pick it up now instead of at the next beat
        if (snap.session && reply.config_version !== snap.session.config_version) void run('heartbeat')
      } else if (job === 'state') {
        const q = opts.miQuery?.(context) ?? { mi: false, markets: [] }
        const state = await api.state(q)
        set({ state, lastStateAt: now() })
      } else {
        const out = await api.heartbeat({ ...(opts.heartbeatInfo?.(context) ?? {}), connection: snap.connection, uptime_s: Math.round((now() - startedAt) / 1000), errors: snap.errors, reconnects: snap.reconnects, config_version: snap.session?.config_version ?? null })
        set({ session: out.display })
      }
      sideAttempts[job] = 0
      ok()
      schedule(job, cadence[job])
    } catch (error) {
      handleFailure(job, error)
    } finally {
      inflight[job] = false
    }
  }

  async function start() {
    if (running) return
    running = true
    paused = false
    try {
      const s = await api.session()
      set({ session: s.display, unpaired: false })
      ok()
    } catch (error) {
      const e = error instanceof WallHttpError ? error : null
      if (e?.unpaired) { running = false; set({ unpaired: true, connection: 'offline' }); return }
      // session unreachable: still try the data jobs; the ladder takes it from here
      handleFailure('heartbeat', error)
    }
    void run('state')
    void run('events')
    schedule('heartbeat', 2_000)
  }

  function stop() {
    running = false
    for (const j of Object.keys(handles) as Job[]) if (handles[j]) timers.clearTimeout(handles[j])
  }

  /** Page hidden (TV input switched / screen off): no requests at all. */
  function pause() {
    paused = true
    for (const j of Object.keys(handles) as Job[]) if (handles[j]) timers.clearTimeout(handles[j])
  }

  /** Visible / online / pageshow: catch up immediately (staggered). */
  function resume() {
    if (!running) return
    paused = false
    schedule('events', 0)
    schedule('state', 400)
    schedule('heartbeat', 1_200)
  }

  return {
    start,
    stop,
    pause,
    resume,
    refreshState: () => schedule('state', 0),
    /** The UI reports what it shows; a preset change that needs other data refreshes state once. */
    setContext(next: WallViewContext) {
      const needsState = next.preset !== context.preset || next.market !== context.market
      context = next
      if (needsState && snap.session) schedule('state', 0)
    },
    getSnapshot: () => snap,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    onArrivals(fn: (evs: WallEvent[]) => void) { arrivalListeners.add(fn); return () => { arrivalListeners.delete(fn) } },
    /** test/soak introspection: listener + timer counts must stay flat over hours */
    _debug: () => ({ listeners: listeners.size, arrivalListeners: arrivalListeners.size, timers: Object.values(handles).filter(Boolean).length, ladder: ladder.state(), requests: api.stats() }),
  }
}

export type WallChannel = ReturnType<typeof createWallChannel>
