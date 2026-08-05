import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchInboxActivityResult,
  type ActivityFetchError,
  type InboxActivityEvent,
} from '../../lib/data/inboxActivityData'

/**
 * Live Activity data hook.
 *
 * The panel this replaces did:
 *
 *   setLoading(true)
 *   const data = await fetchInboxActivity(threadKey)   // can reject
 *   setActivities(data)
 *   setLoading(false)                                  // never runs on reject
 *
 * with `void refresh()` swallowing the rejection and no error state at all, so
 * a failure rendered "Loading activity…" forever and re-threw every 30s.
 *
 * Constitution R8.3: every async surface has a timeout and no spinner may
 * outlive its request. This hook guarantees `phase` always leaves 'loading'.
 */

const POLL_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000

export type ActivityPhase = 'loading' | 'ready' | 'error'

export interface OperationsActivityState {
  phase: ActivityPhase
  events: InboxActivityEvent[]
  error: ActivityFetchError | null
  /** Last successful read — drives the "showing data from…" stale marker. */
  lastLoadedAt: string | null
  /** True while a background refresh runs over already-valid content (R8.5). */
  refreshing: boolean
  retry: () => void
}

export function useOperationsActivity(threadKey?: string): OperationsActivityState {
  const [phase, setPhase] = useState<ActivityPhase>('loading')
  const [events, setEvents] = useState<InboxActivityEvent[]>([])
  const [error, setError] = useState<ActivityFetchError | null>(null)
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const mountedRef = useRef(true)
  const inFlightRef = useRef<AbortController | null>(null)
  const hasContentRef = useRef(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      inFlightRef.current?.abort()
    }
  }, [])

  const load = useCallback(async () => {
    inFlightRef.current?.abort()
    const controller = new AbortController()
    inFlightRef.current = controller

    // R8.3 — the request cannot outlive its timeout.
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    if (hasContentRef.current) setRefreshing(true)
    else setPhase('loading')

    try {
      const result = await fetchInboxActivityResult(threadKey, controller.signal)
      if (!mountedRef.current || controller.signal.aborted) return

      if (result.ok) {
        hasContentRef.current = true
        setEvents(result.events)
        setError(null)
        setLastLoadedAt(result.fetchedAt)
        setPhase('ready')
        return
      }

      setError(result.error)
      // R8.5 / R10.4 — keep previously-valid content on screen, marked stale,
      // rather than blanking the panel on a transient failure.
      setPhase(hasContentRef.current ? 'ready' : 'error')
    } catch (unexpected) {
      // Defence in depth: the data layer already swallows, but a spinner must
      // never survive an exception here either.
      if (!mountedRef.current) return
      setError({
        kind: 'network',
        message: 'Live activity could not be read. Queue sends and replies are still happening — only this view is blind.',
        detail: unexpected instanceof Error ? unexpected.message : String(unexpected),
      })
      setPhase(hasContentRef.current ? 'ready' : 'error')
    } finally {
      window.clearTimeout(timeoutId)
      if (mountedRef.current) setRefreshing(false)
    }
  }, [threadKey])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => { void load() }, POLL_MS)
    return () => window.clearInterval(interval)
  }, [load, attempt])

  const retry = useCallback(() => {
    hasContentRef.current = false
    setAttempt((n) => n + 1)
  }, [])

  return { phase, events, error, lastLoadedAt, refreshing, retry }
}
