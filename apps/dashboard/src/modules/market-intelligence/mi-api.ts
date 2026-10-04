import { useSyncExternalStore } from 'react'
import { callBackend } from '../../lib/api/backendClient'
import type { MiFail, MiWarming } from './mi-types'

/**
 * Market Intelligence API adapter + a tiny query store.
 *
 * One GET endpoint (/api/cockpit/market-intel?op=…). While the server builds its
 * sales index it answers { status: 'loading', progress }: the store re-polls
 * every 1.5 s and the UI shows the real progress, never a fake spinner.
 * Results are cached per query key for the session (the index changes at most
 * daily); `refresh` drops one key.
 */
export const MI_PATH = '/api/cockpit/market-intel'

export function miUrl(op: string, params: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams({ op })
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  return `${MI_PATH}?${q.toString()}`
}

/** The API's own words for a refusal (its body), never a raw URL dump. */
function failMessage(res: { error: string; upstream?: unknown }): string {
  const b = (res.upstream ?? null) as Partial<MiFail> | null
  return b?.message || b?.error || res.error || 'Request failed'
}

export type MiQueryState<T> =
  | { kind: 'idle' }
  | { kind: 'loading'; previous?: T }
  | { kind: 'warming'; warming: MiWarming }
  | { kind: 'ready'; data: T; at: number }
  | { kind: 'error'; message: string; status: number; previous?: T }

type Entry = { state: MiQueryState<unknown>; subs: Set<() => void>; timer: number | null; inflight: boolean }
const store = new Map<string, Entry>()
const POLL_MS = 1500
const IDLE: MiQueryState<never> = { kind: 'idle' }

const entry = (key: string): Entry => {
  let e = store.get(key)
  if (!e) { e = { state: IDLE, subs: new Set(), timer: null, inflight: false }; store.set(key, e) }
  return e
}
const emit = (e: Entry) => { for (const s of e.subs) s() }

const isWarming = (d: unknown): d is MiWarming => {
  const s = (d as { status?: unknown } | null)?.status
  return typeof s === 'string' && s !== 'ready' && (s === 'loading' || s === 'deferred' || s === 'error' || s === 'cold')
}

async function run(key: string) {
  const e = entry(key)
  if (e.inflight) return
  e.inflight = true
  const previous = e.state.kind === 'ready' ? (e.state.data as unknown) : (e.state.kind === 'loading' || e.state.kind === 'error') ? e.state.previous : undefined
  if (e.state.kind !== 'warming') { e.state = { kind: 'loading', previous }; emit(e) }
  const res = await callBackend<unknown>(key, { timeoutMs: 60_000 })
  e.inflight = false
  if (!res.ok) {
    e.state = { kind: 'error', message: failMessage(res), status: res.status, previous }
  } else if (isWarming(res.data)) {
    e.state = { kind: 'warming', warming: res.data }
    if (e.timer === null && e.subs.size) e.timer = window.setTimeout(() => { e.timer = null; void run(key) }, POLL_MS)
  } else if ((res.data as { ok?: boolean })?.ok === false) {
    const f = res.data as MiFail
    e.state = { kind: 'error', message: f.message || f.error, status: f.status ?? 400, previous }
  } else {
    e.state = { kind: 'ready', data: res.data, at: Date.now() }
  }
  emit(e)
}

/** Subscribe to one query. `key` null = idle (nothing requested). */
export function useMiQuery<T>(key: string | null): MiQueryState<T> {
  return useSyncExternalStore(
    (cb) => {
      if (!key) return () => {}
      const e = entry(key)
      e.subs.add(cb)
      if (e.state.kind === 'idle' || (e.state.kind === 'warming' && e.timer === null)) void run(key)
      return () => { e.subs.delete(cb); if (!e.subs.size && e.timer !== null) { window.clearTimeout(e.timer); e.timer = null } }
    },
    () => (key ? (entry(key).state as MiQueryState<T>) : (IDLE as MiQueryState<T>)),
    () => IDLE as MiQueryState<T>,
  )
}

export const refreshMiQuery = (key: string) => { const e = store.get(key); if (e) { e.state = IDLE; void run(key) } }

/** After a server-side source changes (a seller-universe state loaded): drop every cached
 *  result, re-run the mounted ones. Unmounted keys re-run when next viewed. */
export function refreshAllMiQueries() {
  for (const [key, e] of store) {
    if (key.includes('op=status') || key.includes('op=registry')) continue
    const keep = e.state.kind === 'ready' ? e.state.data : undefined
    e.state = keep === undefined ? IDLE : { kind: 'loading', previous: keep }
    if (e.subs.size) void run(key)
    else e.state = IDLE
  }
}

/** One-shot (search / imperative reads). */
export async function miFetch<T>(op: string, params: Record<string, string | number | null | undefined> = {}, signal?: AbortSignal): Promise<{ ok: true; data: T } | { ok: false; message: string; warming?: MiWarming }> {
  const res = await callBackend<unknown>(miUrl(op, params), { timeoutMs: 30_000, signal })
  if (!res.ok) return { ok: false, message: failMessage(res) }
  if (isWarming(res.data)) return { ok: false, message: 'Building the market index', warming: res.data }
  if ((res.data as { ok?: boolean })?.ok === false) return { ok: false, message: (res.data as MiFail).message || (res.data as MiFail).error }
  return { ok: true, data: res.data as T }
}

/** The data a state carries, if any (ready, or the previous value while reloading). */
export function dataOf<T>(s: MiQueryState<T>): T | null {
  if (s.kind === 'ready') return s.data
  if ((s.kind === 'loading' || s.kind === 'error') && s.previous) return s.previous
  return null
}

export const _resetMiStore = () => store.clear()
