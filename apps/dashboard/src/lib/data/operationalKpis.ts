import { useState, useEffect, useCallback } from 'react'
import { getSupabaseClient } from '../supabaseClient'
import { fetchOperationalKpis, buildOperationalKpis, type OperationalKpis, type OperationalKpi } from './inboxKpis'

export type LiveKpiDeltas = {
  sent_count: number
  delivered_count: number
  failed_count: number
  received_count: number
  opt_out_count: number
  queue_waiting_count: number
  queue_failed_today_count: number
  priority_threads: number
  suppressed_threads: number
  new_replies_count: number
}

export type LiveKpiStore = {
  baselineRaw: any | null
  deltas: LiveKpiDeltas
  computed: OperationalKpis | null
  loading: boolean
  error: Error | null
  loadedAt: number
  lastEventAt: number
  realtimeConnected: boolean
  reconciliationStatus: 'idle' | 'reconciling' | 'error'
}

const emptyDeltas = (): LiveKpiDeltas => ({
  sent_count: 0,
  delivered_count: 0,
  failed_count: 0,
  received_count: 0,
  opt_out_count: 0,
  queue_waiting_count: 0,
  queue_failed_today_count: 0,
  priority_threads: 0,
  suppressed_threads: 0,
  new_replies_count: 0
})

const globalLiveStore: Record<string, LiveKpiStore> = {}
const storeListeners: Record<string, Set<() => void>> = {}

const notifyListeners = (window: string) => {
  storeListeners[window]?.forEach(listener => listener())
}

const applyDeltas = (window: string) => {
  const store = globalLiveStore[window]
  if (!store || !store.baselineRaw) return

  const combinedMetrics = { ...store.baselineRaw }
  for (const key in store.deltas) {
    combinedMetrics[key] = (combinedMetrics[key] || 0) + (store.deltas as any)[key]
  }

  store.computed = buildOperationalKpis(combinedMetrics, window as OperationalKpi['timeWindow'])
  notifyListeners(window)
}

const reconcileKpis = async (window: OperationalKpi['timeWindow']) => {
  const store = globalLiveStore[window]
  if (!store) return

  store.reconciliationStatus = 'reconciling'
  notifyListeners(window)

  try {
    const freshKpis = await fetchOperationalKpis(window)
    store.baselineRaw = freshKpis.diagnostics
    // Reset deltas safely since baseline now includes them
    store.deltas = emptyDeltas()
    store.loadedAt = Date.now()
    store.reconciliationStatus = 'idle'
    store.error = null
    applyDeltas(window)
  } catch (err) {
    console.error(`[KPI Reconciliation] Failed for ${window}:`, err)
    store.reconciliationStatus = 'error'
    notifyListeners(window)
  }
}

export const preloadKpis = async () => {
  const windows: OperationalKpi['timeWindow'][] = ['today', '24h', '7d']
  for (const w of windows) {
    if (!globalLiveStore[w]) {
      globalLiveStore[w] = { 
        baselineRaw: null, 
        deltas: emptyDeltas(), 
        computed: null, 
        loading: true, 
        error: null, 
        loadedAt: 0, 
        lastEventAt: 0, 
        realtimeConnected: false, 
        reconciliationStatus: 'idle' 
      }
      storeListeners[w] = new Set()
    }
    
    // Initial fetch
    fetchOperationalKpis(w).then(data => {
      const store = globalLiveStore[w]
      store.baselineRaw = data.diagnostics
      store.loading = false
      store.loadedAt = Date.now()
      applyDeltas(w)
    }).catch(err => {
      const store = globalLiveStore[w]
      store.loading = false
      store.error = err
      notifyListeners(w)
    })
  }
  
  // Setup global realtime listener once
  setupGlobalRealtime()
}

let realtimeSetupDone = false
const setupGlobalRealtime = () => {
  if (realtimeSetupDone) return
  realtimeSetupDone = true
  
  const supabase = getSupabaseClient()
  
  const handleEvent = (deltaUpdate: Partial<LiveKpiDeltas>) => {
    const windows = Object.keys(globalLiveStore)
    let updated = false
    
    for (const w of windows) {
      const store = globalLiveStore[w]
      if (!store) continue
      
      store.lastEventAt = Date.now()
      for (const key in deltaUpdate) {
        if (deltaUpdate[key as keyof LiveKpiDeltas] !== undefined) {
          store.deltas[key as keyof LiveKpiDeltas] += deltaUpdate[key as keyof LiveKpiDeltas]!
          updated = true
        }
      }
      if (updated) applyDeltas(w)
    }
    
    if (import.meta.env.VITE_SHOW_DEBUG === "true") {
      console.log('[REALTIME KPI ENGINE] Deltas applied:', deltaUpdate)
      console.log('[REALTIME KPI ENGINE] Store state:', globalLiveStore)
    }
  }

  const messageSub = supabase
    .channel('kpi-engine-messages')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_events' }, (payload: any) => {
      const newRow = payload.new
      const oldRow = payload.old
      const eventType = payload.eventType
      
      const deltas: Partial<LiveKpiDeltas> = {}
      
      if (eventType === 'INSERT') {
        if (newRow.direction === 'inbound') deltas.received_count = 1
        if (newRow.event_type === 'outbound_send' || newRow.sent_at) deltas.sent_count = 1
        if (newRow.delivery_status === 'delivered') deltas.delivered_count = 1
        if (newRow.delivery_status === 'failed') deltas.failed_count = 1
        if (newRow.is_opt_out) deltas.opt_out_count = 1
      } else if (eventType === 'UPDATE') {
        if (newRow.delivery_status === 'delivered' && oldRow.delivery_status !== 'delivered') deltas.delivered_count = 1
        if (newRow.delivery_status === 'failed' && oldRow.delivery_status !== 'failed') deltas.failed_count = 1
        if (newRow.is_opt_out && !oldRow.is_opt_out) deltas.opt_out_count = 1
        if (newRow.sent_at && !oldRow.sent_at) deltas.sent_count = 1
      }
      
      if (Object.keys(deltas).length > 0) handleEvent(deltas)
    })
    .subscribe((status) => {
      const connected = status === 'SUBSCRIBED'
      Object.values(globalLiveStore).forEach(store => store.realtimeConnected = connected)
    })

  const queueSub = supabase
    .channel('kpi-engine-queue')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'send_queue' }, (payload: any) => {
      const newRow = payload.new
      const oldRow = payload.old
      const eventType = payload.eventType
      
      const deltas: Partial<LiveKpiDeltas> = {}
      
      const isPending = (status: string) => ['queued', 'pending', 'scheduled'].includes(status)
      const isFailed = (status: string) => status?.includes('failed')
      
      if (eventType === 'INSERT') {
        if (isPending(newRow.queue_status)) deltas.queue_waiting_count = 1
        if (isFailed(newRow.queue_status)) deltas.queue_failed_today_count = 1
      } else if (eventType === 'UPDATE') {
        if (isPending(newRow.queue_status) && !isPending(oldRow.queue_status)) deltas.queue_waiting_count = 1
        if (!isPending(newRow.queue_status) && isPending(oldRow.queue_status)) deltas.queue_waiting_count = -1
        
        if (isFailed(newRow.queue_status) && !isFailed(oldRow.queue_status)) deltas.queue_failed_today_count = 1
      } else if (eventType === 'DELETE') {
        if (isPending(oldRow.queue_status)) deltas.queue_waiting_count = -1
      }
      
      if (Object.keys(deltas).length > 0) handleEvent(deltas)
    })
    .subscribe()

  const threadSub = supabase
    .channel('kpi-engine-threads')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'inbox_thread_state' }, (payload: any) => {
      const newRow = payload.new
      const oldRow = payload.old
      
      const deltas: Partial<LiveKpiDeltas> = {}
      
      const isPriority = (stage: string) => ['priority', 'high', 'hot'].includes(stage?.toLowerCase() || '')
      
      if (isPriority(newRow.stage) && !isPriority(oldRow.stage)) deltas.priority_threads = 1
      if (!isPriority(newRow.stage) && isPriority(oldRow.stage)) deltas.priority_threads = -1
      
      if (newRow.is_suppressed && !oldRow.is_suppressed) deltas.suppressed_threads = 1
      if (!newRow.is_suppressed && oldRow.is_suppressed) deltas.suppressed_threads = -1
      
      if (Object.keys(deltas).length > 0) handleEvent(deltas)
    })
    .subscribe()
    
  // Background reconciliation loop every 30s
  setInterval(() => {
    const windows = Object.keys(globalLiveStore) as OperationalKpi['timeWindow'][]
    windows.forEach(w => reconcileKpis(w))
  }, 30000)
}

export const useOperationalKpis = (timeWindow: OperationalKpi['timeWindow'] = '24h') => {
  const [storeState, setStoreState] = useState<LiveKpiStore | null>(globalLiveStore[timeWindow] || null)

  useEffect(() => {
    if (!globalLiveStore[timeWindow]) {
      preloadKpis() // Kick off if it wasn't preloaded
    }
    
    const listener = () => {
      setStoreState({ ...globalLiveStore[timeWindow] }) // Force trigger render with new object reference
    }
    
    if (!storeListeners[timeWindow]) storeListeners[timeWindow] = new Set()
    storeListeners[timeWindow].add(listener)
    
    // Set initial state safely
    if (globalLiveStore[timeWindow]) {
        setStoreState({ ...globalLiveStore[timeWindow] })
    }
    
    return () => {
      storeListeners[timeWindow]?.delete(listener)
    }
  }, [timeWindow])

  // Rule-based recommendations
  const recommendations = useCallback(() => {
    const kpis = storeState?.computed
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
  }, [storeState?.computed])

  return {
    kpis: storeState?.computed || null,
    isLoading: storeState?.loading || false,
    error: storeState?.error || null,
    isLive: storeState?.lastEventAt ? (Date.now() - storeState.lastEventAt < 3000) : false,
    realtimeConnected: storeState?.realtimeConnected || false,
    reconciliationStatus: storeState?.reconciliationStatus || 'idle',
    lastEventAt: storeState?.lastEventAt || 0,
    recommendations: recommendations(),
    refresh: () => reconcileKpis(timeWindow)
  }
}
