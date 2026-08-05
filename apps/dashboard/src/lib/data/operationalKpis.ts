import { useState, useEffect, useCallback, useRef } from 'react'
import { getSupabaseClient } from '../supabaseClient'
import { fetchOperationalKpis, type OperationalKpis, type OperationalKpi } from './inboxKpis'

/**
 * LANE F (§8.3): this surface was an async read with no timeout and no bounded
 * failure path. `fetchOperationalKpis` could hang indefinitely and the panel
 * rendered "Loading…" forever, indistinguishable from a slow network.
 *
 * `SLOW_AFTER_MS` lets the panel say *why* it is still waiting instead of
 * showing a bare spinner; `LOAD_TIMEOUT_MS` guarantees the wait ends.
 */
const SLOW_AFTER_MS = 2_000
const LOAD_TIMEOUT_MS = 12_000

/** Rejects if `promise` has not settled within `ms`. */
const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Operational telemetry timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    )
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })

export const useOperationalKpis = (
  timeWindow: OperationalKpi['timeWindow'] = '24h',
  options: { enabled?: boolean } = {},
) => {
  const enabled = options.enabled !== false
  const [kpis, setKpis] = useState<OperationalKpis | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [isLive, setIsLive] = useState(false)
  /** True once a load has been outstanding longer than SLOW_AFTER_MS. */
  const [isSlow, setIsSlow] = useState(false)

  const lastFetchRef = useRef<number>(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)


  const load = useCallback(async (isInitial = false) => {
    if (isInitial) setIsLoading(true)

    if (slowTimerRef.current) clearTimeout(slowTimerRef.current)
    setIsSlow(false)
    slowTimerRef.current = setTimeout(() => setIsSlow(true), SLOW_AFTER_MS)

    try {
      const data = await withTimeout(fetchOperationalKpis(timeWindow), LOAD_TIMEOUT_MS)
      setKpis(data)
      setError(null)
      lastFetchRef.current = Date.now()
    } catch (err) {
      console.error('[KPI Hook] Fetch failed:', err)
      setError(err instanceof Error ? err : new Error('Failed to fetch KPIs'))
    } finally {
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current)
        slowTimerRef.current = null
      }
      setIsSlow(false)
      // Unconditional: a failed refresh must never leave the panel loading.
      setIsLoading(false)
    }
  }, [timeWindow])

  const debouncedLoad = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    
    const now = Date.now()
    const timeSinceLastFetch = now - lastFetchRef.current
    
    if (timeSinceLastFetch > 2000) {
      load()
    } else {
      debounceTimerRef.current = setTimeout(() => {
        load()
      }, 2000 - timeSinceLastFetch)
    }
  }, [load])

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false)
      return undefined
    }
    let cancelled = false
    let cancelIdle: (() => void) | null = null
    const start = () => {
      if (cancelled) return
      void load(true)
    }
    /*
     * LANE F: this idle deadline was 5000ms, which is most of the 6-10s the
     * operator waited before "Loading…" became content — the fetch had not
     * even started. 1200ms still keeps the read off the first-paint critical
     * path without making the panel look broken.
     */
    import('../../shared/idleDefer').then(({ runWhenBrowserIdle }) => {
      if (cancelled) return
      cancelIdle = runWhenBrowserIdle(start, 1200)
    }).catch(() => start())

    /*
     * `getSupabaseClient()` throws synchronously when env vars are missing
     * (supabaseClient.ts:21-26). Unguarded here it would take down the whole
     * effect — including the load above — the same way it broke Live Activity.
     * Realtime is an enhancement; losing it must not cost us the KPIs.
     */
    let supabase: ReturnType<typeof getSupabaseClient> | null = null
    try {
      supabase = getSupabaseClient()
    } catch (err) {
      console.error('[KPI Hook] Realtime unavailable:', err)
    }

    // Subscribe to message events for real-time messaging updates
    const messageSub = supabase?.channel('kpi-messages')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_events' }, () => {
        setIsLive(true)
        debouncedLoad()
        setTimeout(() => setIsLive(false), 2000)
      })
      .subscribe()

    // Subscribe to send_queue for real-time automation updates
    const queueSub = supabase?.channel('kpi-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'send_queue' }, () => {
        setIsLive(true)
        debouncedLoad()
        setTimeout(() => setIsLive(false), 2000)
      })
      .subscribe()

    return () => {
      cancelled = true
      cancelIdle?.()
      if (messageSub) supabase?.removeChannel(messageSub)
      if (queueSub) supabase?.removeChannel(queueSub)
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current)
    }
  }, [enabled, timeWindow, debouncedLoad, load])

  // Rule-based recommendations
  const recommendations = useCallback(() => {
    if (!kpis) return []
    const recs: string[] = []
    
    const failRate = kpis.messaging.find(k => k.id === 'failure-rate')
    if (failRate && Number(failRate.value) > 10) {
      recs.push('High failure rate detected: Audit carrier routing or template compliance.')
    }

    const replyRate = kpis.messaging.find(k => k.id === 'reply-rate')
    if (replyRate && Number(replyRate.value) < 5) {
      recs.push('Reply rate is below target: Consider diversifying outreach templates.')
    }

    const queueFailed = kpis.automation.find(k => k.id === 'queue-failed')
    if (queueFailed && Number(queueFailed.value) > 0) {
      recs.push(`Action Required: ${queueFailed.value} automation failures detected in the last window.`)
    }

    const hotLeads = kpis.quality.find(k => k.id === 'hot-leads')
    if (hotLeads && Number(hotLeads.value) > 10) {
      recs.push('Acquisition surge: Increase operator focus on hot leads.')
    }

    return recs
  }, [kpis])

  return {
    kpis,
    isLoading,
    error,
    isLive,
    /** Load has been outstanding > 2s — the panel should say so, not just spin. */
    isSlow,
    recommendations: recommendations(),
    refresh: load
  }
}
