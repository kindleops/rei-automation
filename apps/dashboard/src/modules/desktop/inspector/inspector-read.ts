import { callBackend, type BackendResult } from '../../../lib/api/backendClient'

/**
 * HOW A RENDERER READS — and the few honest ways a read can fail.
 *
 * Every renderer reads one owning-app endpoint through `callBackend`. A failed
 * read becomes one of four operator states (never a raw status or code):
 *
 *   not_found      the object is not on record (any more)
 *   denied         this session may not read it
 *   not_connected  the backend could not be reached at all
 *   unavailable    the read answered but failed
 */

export type InspectorFailure = 'not_found' | 'denied' | 'not_connected' | 'unavailable'

export class InspectorReadError extends Error {
  readonly kind: InspectorFailure
  constructor(kind: InspectorFailure, detail?: string) {
    super(detail || kind)
    this.name = 'InspectorReadError'
    this.kind = kind
  }
}

const OFFLINE = new Set(['BACKEND_UNAVAILABLE', 'BACKEND_NETWORK_ERROR', 'BACKEND_CORS_ERROR', 'BACKEND_NOT_CONFIGURED', 'BACKEND_TIMEOUT'])

/** A failed BackendResult → the operator state it means. */
export function failureOf(res: { status: number; error: string }): InspectorFailure {
  if (OFFLINE.has(res.error) || res.status === 0) return 'not_connected'
  if (res.status === 401 || res.status === 403) return 'denied'
  if (res.status === 404 || /not_found$/.test(res.error)) return 'not_found'
  return 'unavailable'
}

export function failureOfError(e: unknown): InspectorFailure {
  return e instanceof InspectorReadError ? e.kind : 'unavailable'
}

type Caller = <T>(path: string, init: { signal: AbortSignal; timeoutMs?: number }) => Promise<BackendResult<T>>

/** Read one endpoint; anything but `ok` throws an InspectorReadError. */
export async function readInspector<T>(path: string, signal: AbortSignal, call: Caller = callBackend): Promise<T> {
  const res = await call<T & { ok?: boolean; error?: string }>(path, { signal, timeoutMs: 45_000 })
  if (!res.ok) throw new InspectorReadError(failureOf(res), res.error)
  const body = res.data as (T & { ok?: boolean; error?: string }) | null
  if (!body || body.ok === false) throw new InspectorReadError(/not_found$/.test(String(body?.error ?? '')) ? 'not_found' : 'unavailable', body?.error)
  return body as T
}

/* ── operator words ─────────────────────────────────────────────────── */

const clean = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())

/** "needs_human_review" → "Needs human review". Empty in, null out. */
export function words(code: unknown): string | null {
  const s = clean(code).replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : null
}

export const text = (v: unknown): string | null => clean(v) || null

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function money(v: unknown): string | null {
  const n = num(v)
  return n === null ? null : `$${Math.round(n).toLocaleString('en-US')}`
}

export function count(v: unknown, noun?: string): string | null {
  const n = num(v)
  if (n === null) return null
  const s = n.toLocaleString('en-US')
  return noun ? `${s} ${noun}${n === 1 ? '' : 's'}` : s
}

export function pct(v: unknown, scale: 1 | 100 = 100): string | null {
  const n = num(v)
  return n === null ? null : `${Math.round(scale === 1 ? n * 100 : n)}%`
}

/** A timestamp in the operator's clock ("Oct 1, 4:21 PM"); date-only values stay dates. */
export function when(v: unknown): string | null {
  const s = clean(v)
  if (!s) return null
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s)
  const d = new Date(dateOnly ? `${s}T12:00:00Z` : s)
  if (Number.isNaN(d.getTime())) return null
  return dateOnly
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export const isoOrNull = (v: unknown): string | null => {
  const s = clean(v)
  return s && !Number.isNaN(new Date(s).getTime()) ? s : null
}

export const joinParts = (parts: Array<string | null | undefined | false>, sep = ' · '): string | null =>
  parts.filter(Boolean).join(sep) || null

export const clip = (s: string | null, max = 120): string | null => (s && s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

export const enc = encodeURIComponent

/** Facts with no value are omitted (absent = not recorded, never "—"). */
export function present<T extends { value: string | null }>(rows: T[]): T[] {
  return rows.filter((r) => r.value !== null && r.value !== '')
}
