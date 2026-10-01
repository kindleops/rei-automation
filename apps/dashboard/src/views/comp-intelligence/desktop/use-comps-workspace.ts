import { useCallback, useEffect, useRef, useState } from 'react'
import { callBackend } from '../../../lib/api/backendClient'
import type { CompsWorkspace } from '../../../domain/comp-intelligence/comps-evidence-api'
import { sound } from '../../../shared/sound'

export type WorkspaceFailure = { kind: 'not_found' | 'unavailable'; detail: string }

interface Entry { data: CompsWorkspace | null; failure: WorkspaceFailure | null; at: number }

/**
 * Subject evidence, cached per (subject, radius, window) for the session:
 * switching Evidence ↔ Valuation ↔ Compare never refetches, and returning to
 * a window already seen is instant (§150). A success older than 10 minutes
 * is refreshed in the background while it stays on screen — recorded-sale
 * data changes daily, not by the second. A failure is never retried on its
 * own; the operator retries.
 */
const CACHE = new Map<string, Entry>()
const TTL = 10 * 60_000
const MAX = 16

const keyOf = (pid: string, radius: number | null, months: number | null) => `${pid}|${radius ?? 'engine'}|${months ?? 'engine'}`

function remember(key: string, entry: Entry) {
  CACHE.delete(key)
  CACHE.set(key, entry)
  while (CACHE.size > MAX) CACHE.delete(CACHE.keys().next().value as string)
}

function lastGoodFor(pid: string): CompsWorkspace | null {
  const entries = [...CACHE.entries()]
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [k, e] = entries[i]
    if (k.startsWith(`${pid}|`) && e.data) return e.data
  }
  return null
}

async function load(pid: string, radius: number | null, months: number | null, signal: AbortSignal): Promise<CompsWorkspace> {
  const qs = new URLSearchParams({ property_id: pid })
  if (radius !== null) qs.set('radius', String(radius))
  if (months !== null) qs.set('months', String(months))
  // One bounded read (~2s in production); an overloaded dev API can take minutes.
  const res = await callBackend<{ ok: boolean; data: CompsWorkspace }>(`/api/cockpit/comps/workspace?${qs.toString()}`, { signal, timeoutMs: 240_000 })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    const err = new Error(upstream?.error || res.error || 'comps_workspace_failed') as Error & { status?: number }
    err.status = res.status
    throw err
  }
  if (!res.data?.data) throw new Error('comps_workspace_empty')
  return res.data.data
}

export interface WorkspaceRequest { radius: number | null; months: number | null }

export function useCompsWorkspace(propertyId: string | null) {
  const [request, setRequest] = useState<WorkspaceRequest>({ radius: null, months: null })
  const [nonce, setNonce] = useState(0)
  const [, setVersion] = useState(0)
  const explicit = useRef<string | null>(null)

  // A new subject opens on the engine's own window again.
  const [seenPid, setSeenPid] = useState(propertyId)
  if (seenPid !== propertyId) {
    setSeenPid(propertyId)
    setRequest({ radius: null, months: null })
  }

  const key = propertyId ? keyOf(propertyId, request.radius, request.months) : null
  const entry = key ? CACHE.get(key) : undefined

  useEffect(() => {
    if (!propertyId || !key) return
    const hit = CACHE.get(key)
    if (hit?.failure) return
    if (hit?.data && Date.now() - hit.at < TTL) return
    const ctrl = new AbortController()
    load(propertyId, request.radius, request.months, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return
        remember(key, { data, failure: null, at: Date.now() })
        if (explicit.current === key) { explicit.current = null; sound.outcome.ready() }
        setVersion((v) => v + 1)
      })
      .catch((e: Error & { status?: number }) => {
        if (ctrl.signal.aborted) return
        const failure: WorkspaceFailure = e.status === 404 || e.message === 'property_not_found'
          ? { kind: 'not_found', detail: e.message }
          : { kind: 'unavailable', detail: e.message }
        // keep a stale success on screen; record the failure only when there is nothing to show
        if (!CACHE.get(key)?.data) remember(key, { data: null, failure, at: Date.now() })
        if (explicit.current === key) { explicit.current = null; sound.outcome.error() }
        setVersion((v) => v + 1)
      })
    return () => ctrl.abort()
  }, [propertyId, key, request.radius, request.months, nonce])

  /** An explicit operator recompute (radius / window): sounds when it lands. */
  const setWindow = useCallback((next: WorkspaceRequest) => {
    if (!propertyId) return
    const k = keyOf(propertyId, next.radius, next.months)
    explicit.current = CACHE.get(k)?.data ? null : k
    setRequest(next)
  }, [propertyId])

  const retry = useCallback(() => {
    if (!key) return
    CACHE.delete(key)
    explicit.current = key
    setNonce((n) => n + 1)
  }, [key])

  return {
    /** the payload for this window — or, while it loads, the last good frame for this subject */
    data: entry?.data ?? (propertyId ? lastGoodFor(propertyId) : null),
    /** the requested window itself has landed */
    settled: Boolean(entry?.data),
    loading: Boolean(propertyId) && !entry,
    failure: entry?.failure ?? null,
    request,
    setWindow,
    retry,
  }
}
