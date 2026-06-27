import type { RealtimeChannel } from '@supabase/supabase-js'
import { getSupabaseClient } from '../supabaseClient'
import { shouldUseSupabase } from './shared'
import { invalidateRequestCache } from '../api/requestCache'

export interface RealtimeSubscription {
  channel: RealtimeChannel | null
  unsubscribe: () => void
}

export const subscribeToTableChanges = (
  table: string,
  onChange: () => void,
): RealtimeSubscription => {
  if (!shouldUseSupabase()) {
    return {
      channel: null,
      unsubscribe: () => undefined,
    }
  }

  const supabase = getSupabaseClient()
  const channel = supabase
    .channel(`nexus:${table}:changes`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      () => {
        onChange()
      },
    )
    .subscribe()

  return {
    channel,
    unsubscribe: () => {
      supabase.removeChannel(channel)
    },
  }
}

export const subscribeToCoreData = (onChange: () => void): RealtimeSubscription[] => {
  const tables = ['send_queue', 'message_events', 'owners', 'properties', 'markets']
  return tables.map((table) => subscribeToTableChanges(table, onChange))
}

export const subscribeToInboxRealtime = (onChange?: () => void): RealtimeSubscription[] => {
  if (!shouldUseSupabase()) {
    return []
  }
  const supabase = getSupabaseClient()
  const relevantTables = ['message_events', 'inbox_thread_state', 'send_queue', 'universal_lead_state_events', 'operator_entity_preferences']
  const subs: RealtimeSubscription[] = []

  for (const table of relevantTables) {
    const channel = supabase
      .channel(`nexus:inbox:${table}:live`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, (_payload) => {
        // Invalidate operational caches so next fetch is fresh (no stale counts/threads)
        invalidateRequestCache('/api/cockpit/inbox')
        if (onChange) onChange()
      })
      .subscribe()
    subs.push({
      channel,
      unsubscribe: () => { supabase.removeChannel(channel) },
    })
  }
  return subs
}
