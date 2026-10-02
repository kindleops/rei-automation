/**
 * ANALYTICS 4.0 — one query store for the whole Lab.
 *
 *   · every read is a GET path (the analytical context base64url-encoded with
 *     sorted keys), so two sections asking the same question share ONE request
 *   · results live for a TTL (the server caches 60 s; live windows 90 s)
 *   · a section switching to a new question keeps showing its last answer,
 *     dimmed, until the new one lands — never a skeleton flash on refetch
 *   · a request nobody is watching any more is aborted (lens switches do not
 *     pile up on the browser's six connections), and at most four Lab reads
 *     run at once so the shell's own polling is never starved
 *
 * Components read through useSyncExternalStore; nothing here sets React state
 * inside an effect. The store never aggregates, derives or fills anything.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import type { RecordCohort } from '../../../domain/analytics/analytics-lab-api'
import { encodeB64Url } from '../../../domain/analytics/analytics-lab-api'

export type Snapshot<T = unknown> = { data: T | null; error: string | null; loading: boolean; updatedAt: number | null }
const EMPTY: Snapshot = Object.freeze({ data: null, error: null, loading: false, updatedAt: null })

type Entry = {
  snap: Snapshot
  listeners: Set<() => void>
  ctl: AbortController | null
  expires: number
  queued: boolean
  dropTimer: ReturnType<typeof setTimeout> | undefined
}

const MAX_IN_FLIGHT = 4
const DEFAULT_TTL = 60_000
const ABORT_GRACE = 1_500

/** Stable JSON (sorted keys) so the same question always has the same path. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}
export const encodeStable = (value: unknown) => encodeB64Url(JSON.parse(stableJson(value)))

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await callBackend<{ ok: boolean; data: T; error?: string }>(path, { signal, timeoutMs: 120_000 })
  if (!res.ok) {
    const body = (res as { data?: { error?: string } }).data
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(body?.error || upstream?.error || res.error || 'analytics_failed')
  }
  if (!res.data?.ok) throw new Error(res.data?.error || 'analytics_failed')
  return res.data.data
}

class QueryStore {
  private entries = new Map<string, Entry>()
  private inFlight = 0
  private waiting: string[] = []

  private entry(path: string): Entry {
    let e = this.entries.get(path)
    if (!e) {
      e = { snap: EMPTY, listeners: new Set(), ctl: null, expires: 0, queued: false, dropTimer: undefined }
      this.entries.set(path, e)
    }
    return e
  }

  private emit(e: Entry, snap: Snapshot) {
    e.snap = snap
    for (const l of [...e.listeners]) l()
  }

  read = (path: string | null): Snapshot => (path ? this.entries.get(path)?.snap ?? EMPTY : EMPTY)

  subscribe(path: string | null, listener: () => void): () => void {
    if (!path) return () => {}
    const e = this.entry(path)
    e.listeners.add(listener)
    clearTimeout(e.dropTimer)
    return () => {
      e.listeners.delete(listener)
      if (e.listeners.size) return
      // nobody is watching: let go of an in-flight or queued read after a grace period
      e.dropTimer = setTimeout(() => {
        if (e.listeners.size) return
        if (e.queued) { this.waiting = this.waiting.filter((p) => p !== path); e.queued = false; this.emit(e, { ...e.snap, loading: false }) }
        if (e.ctl) { e.ctl.abort(); e.ctl = null; e.expires = 0; this.emit(e, { ...e.snap, loading: false }) }
      }, ABORT_GRACE)
    }
  }

  /** Start a read if the answer is missing or expired and none is under way. */
  ensure(path: string, ttl = DEFAULT_TTL, force = false) {
    const e = this.entry(path)
    if (e.ctl || e.queued) return
    if (!force && e.snap.data !== null && Date.now() < e.expires) return
    if (!force && e.snap.error && Date.now() < e.expires) return
    e.expires = Date.now() + ttl
    e.queued = true
    this.waiting.push(path)
    this.emit(e, { ...e.snap, loading: true })
    this.pump()
  }

  private pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.waiting.length) {
      const path = this.waiting.shift() as string
      const e = this.entries.get(path)
      if (!e || !e.queued) continue
      e.queued = false
      const ctl = new AbortController()
      e.ctl = ctl
      this.inFlight += 1
      getJson<unknown>(path, ctl.signal)
        .then((data) => { if (!ctl.signal.aborted) this.emit(e, { data, error: null, loading: false, updatedAt: Date.now() }) })
        .catch((err: unknown) => {
          if (ctl.signal.aborted) return
          e.expires = Date.now() + 5_000 // a failure is retried on the next ask after a short pause
          this.emit(e, { ...e.snap, error: String((err as Error)?.message || err), loading: false })
        })
        .finally(() => {
          if (e.ctl === ctl) e.ctl = null
          this.inFlight -= 1
          this.pump()
        })
    }
  }

  reload(path: string) {
    const e = this.entries.get(path)
    if (e?.ctl) { e.ctl.abort(); e.ctl = null }
    this.ensure(path, DEFAULT_TTL, true)
  }
}

export const intelStore = new QueryStore()

export type IntelQuery<T> = Snapshot<T> & {
  /** the answer on screen belongs to an earlier question; the new one is loading */
  stale: boolean
  reload: () => void
}

/**
 * Read one path. `null` disables the read. While a new path loads, the last
 * answer this caller saw stays on screen (marked stale).
 */
export function useIntel<T>(path: string | null, ttl = DEFAULT_TTL): IntelQuery<T> {
  const subscribe = useCallback((cb: () => void) => intelStore.subscribe(path, cb), [path])
  const snap = useSyncExternalStore(subscribe, () => intelStore.read(path)) as Snapshot<T>
  useEffect(() => { if (path) intelStore.ensure(path, ttl) }, [path, ttl])
  // keep the previous answer while the next one loads (derived state, set during render)
  const [held, setHeld] = useState<{ path: string; data: T } | null>(null)
  if (path && snap.data !== null && (held === null || held.path !== path || held.data !== snap.data)) {
    setHeld({ path, data: snap.data })
  }
  const data = snap.data ?? (path ? held?.data ?? null : null)
  return {
    data,
    error: snap.error,
    loading: Boolean(path) && (snap.loading || (snap.data === null && snap.error === null)),
    updatedAt: snap.updatedAt,
    stale: Boolean(path) && snap.data === null && held !== null,
    reload: () => { if (path) intelStore.reload(path) },
  }
}

/* ── paths ──────────────────────────────────────────────────────────────── */

const BASE = '/api/cockpit/analytics/lab'
export type ViewName = 'metric' | 'breakdown' | 'series' | 'seriesBy' | 'heatmap' | 'histogram' | 'contribution' | 'table' | 'stages' | 'orchestrator' | 'buyers' | 'events' | 'money'

export const paths = {
  registry: () => `${BASE}/registry`,
  overview: (ctx: unknown) => `${BASE}/overview?ctx=${encodeStable(ctx)}`,
  query: (ctx: unknown, view: ViewName) => `${BASE}/query?ctx=${encodeStable(ctx)}&view=${view}`,
  records: (ctx: unknown, cohort: RecordCohort, page: number, pageSize: number, sort: string | null, dir: 'asc' | 'desc') =>
    `${BASE}/records?ctx=${encodeStable(ctx)}&cohort=${encodeStable(cohort)}&page=${page}&pageSize=${pageSize}${sort ? `&sort=${encodeURIComponent(sort)}` : ''}&dir=${dir}`,
  options: (ctx: unknown, field: string) => `${BASE}/options?ctx=${encodeStable(ctx)}&field=${encodeURIComponent(field)}`,
  views: () => `${BASE}/views`,
  /** ZIP outlines for the heat map (the ZIPs on screen, sorted so one set is one request) */
  boundaries: (zips: string[]) => `${BASE}/boundaries?zips=${[...zips].sort().join(',')}`,
}
