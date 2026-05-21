import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchThreadPhase3Intelligence, type Phase3Intelligence } from '../../../lib/data/inboxIntelligencePhase3'
import { getSupabaseClient } from '../../../lib/supabaseClient'

export const usePhase3Intelligence = (threadKey: string | undefined) => {
  const [data, setData] = useState<Phase3Intelligence | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const channelInstanceIdRef = useRef(`phase3-${Math.random().toString(36).slice(2, 10)}`)

  const refresh = useCallback(async () => {
    if (!threadKey) {
      setData(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const intel = await fetchThreadPhase3Intelligence(threadKey)
      setData(intel)
    } catch (err: any) {
      console.error('[usePhase3Intelligence] refresh failed', err)
      setError(err.message || 'Failed to fetch intelligence')
    } finally {
      setLoading(false)
    }
  }, [threadKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Real-time subscription
  useEffect(() => {
    if (!threadKey || !data?.thread?.id) return

    const supabase = getSupabaseClient()
    const threadId = data.thread.id

    const channel = supabase
      .channel(`phase3-intel-${threadId}-${channelInstanceIdRef.current}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seller_state_snapshots', filter: `thread_id=eq.${threadId}` }, () => {
        void refresh()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_turns', filter: `thread_id=eq.${threadId}` }, () => {
        void refresh()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'routing_decisions', filter: `thread_id=eq.${threadId}` }, () => {
        void refresh()
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [threadKey, data?.thread?.id, refresh])

  return {
    data,
    loading,
    error,
    refresh
  }
}
