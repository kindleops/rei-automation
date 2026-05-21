import type { RealtimeChannel } from '@supabase/supabase-js'
import { getSupabaseClient } from '../supabaseClient'
import { shouldUseSupabase } from './shared'

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
