import { useState, useEffect, useCallback, useId, useRef } from 'react'
import { getSupabaseClient } from '../supabaseClient'
import { fetchOperationalKpis, type OperationalKpis, type OperationalKpi } from './inboxKpis'

export const useOperationalKpis = (
  timeWindow: OperationalKpi['timeWindow'] = '24h',
  options: { enabled?: boolean } = {},
) => {
  const enabled = options.enabled !== false
  const [kpis, setKpis] = useState<OperationalKpis | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [isLive, setIsLive] = useState(false)
  
  const lastFetchRef = useRef<number>(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* supabase-js keys realtime channels by topic. Both subscriptions below used
     fixed names, so a second consumer of this hook on the same page threw
     "cannot add `postgres_changes` callbacks for realtime:kpi-messages after
     `subscribe()`" and took the subtree down with it. That was latent while
     Operational Intelligence was reachable only from /inbox; it fires the
     moment the panel can open on /analytics, which already renders
     KpiIntelligencePage against the same hook. One topic per instance. */
  const channelScope = useId().replace(/:/g, '')


  const load = useCallback(async (isInitial = false) => {
    if (isInitial) setIsLoading(true)
    
    try {
      const data = await fetchOperationalKpis(timeWindow)
      setKpis(data)
      setError(null)
      lastFetchRef.current = Date.now()
    } catch (err) {
      console.error('[KPI Hook] Fetch failed:', err)
      setError(err instanceof Error ? err : new Error('Failed to fetch KPIs'))
    } finally {
      if (isInitial) setIsLoading(false)
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
    import('../../shared/idleDefer').then(({ runWhenBrowserIdle }) => {
      if (cancelled) return
      cancelIdle = runWhenBrowserIdle(start, 5000)
    }).catch(() => start())

    const supabase = getSupabaseClient()
    
    // Subscribe to message events for real-time messaging updates
    const messageSub = supabase
      .channel(`kpi-messages-${channelScope}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_events' }, () => {
        setIsLive(true)
        debouncedLoad()
        setTimeout(() => setIsLive(false), 2000)
      })
      .subscribe()

    // Subscribe to send_queue for real-time automation updates
    const queueSub = supabase
      .channel(`kpi-queue-${channelScope}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'send_queue' }, () => {
        setIsLive(true)
        debouncedLoad()
        setTimeout(() => setIsLive(false), 2000)
      })
      .subscribe()

    return () => {
      cancelled = true
      cancelIdle?.()
      supabase.removeChannel(messageSub)
      supabase.removeChannel(queueSub)
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [enabled, timeWindow, debouncedLoad, load, channelScope])

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
    recommendations: recommendations(),
    refresh: load
  }
}
