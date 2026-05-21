import { getSupabaseClient } from '../supabaseClient'

export interface WatchlistEntry {
  id: string
  watch_type: 'seller' | 'property' | 'thread' | 'prospect' | 'owner'
  watch_key: string
  thread_key: string | null
  prospect_id: string | null
  owner_id: string | null
  master_owner_id: string | null
  property_id: string | null
  phone: string | null
  label: string | null
  address: string | null
  market: string | null
  priority: string
  notify_in_app: boolean
  watch_replies: boolean
  watch_queue_events: boolean
  watch_offer_events: boolean
  watch_buyer_events: boolean
  watch_contract_events: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export type WatchlistTogglePayload = {
  watch_type: WatchlistEntry['watch_type']
  watch_key: string
  label?: string
  thread_key?: string
  prospect_id?: string
  owner_id?: string
  master_owner_id?: string
  property_id?: string
  phone?: string
  address?: string
  market?: string
}

export const fetchWatchlist = async (): Promise<WatchlistEntry[]> => {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('notification_watchlist')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
  if (error || !data) return []
  return data as WatchlistEntry[]
}

export const toggleWatch = async (payload: WatchlistTogglePayload): Promise<'added' | 'removed'> => {
  const supabase = getSupabaseClient()

  const { data: existing } = await supabase
    .from('notification_watchlist')
    .select('id, is_active')
    .eq('watch_type', payload.watch_type)
    .eq('watch_key', payload.watch_key)
    .maybeSingle()

  if (existing) {
    const row = existing as { id: string; is_active: boolean }
    const newActive = !row.is_active
    await supabase
      .from('notification_watchlist')
      .update({ is_active: newActive })
      .eq('id', row.id)
    return newActive ? 'added' : 'removed'
  }

  await supabase.from('notification_watchlist').insert({
    watch_type: payload.watch_type,
    watch_key: payload.watch_key,
    label: payload.label ?? null,
    thread_key: payload.thread_key ?? null,
    prospect_id: payload.prospect_id ?? null,
    owner_id: payload.owner_id ?? null,
    master_owner_id: payload.master_owner_id ?? null,
    property_id: payload.property_id ?? null,
    phone: payload.phone ?? null,
    address: payload.address ?? null,
    market: payload.market ?? null,
    is_active: true,
  })
  return 'added'
}

export const unwatch = async (watch_type: string, watch_key: string): Promise<void> => {
  const supabase = getSupabaseClient()
  await supabase
    .from('notification_watchlist')
    .update({ is_active: false })
    .eq('watch_type', watch_type)
    .eq('watch_key', watch_key)
}
