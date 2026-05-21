import { getSupabaseClient } from '../supabaseClient'
import { mapErrorMessage, safeArray, type AnyRecord } from './shared'

export type ActivityEventType = 
  | 'stage_change'
  | 'archive_thread'
  | 'unarchive_thread'
  | 'star_thread'
  | 'unstar_thread'
  | 'pin_thread'
  | 'unpin_thread'
  | 'message_sent'
  | 'message_received'
  | 'message_failed'
  | 'note_added'
  | 'ai_copilot_interaction'


export interface InboxActivityEvent {
  id: string
  event_type: ActivityEventType
  thread_key: string
  actor: string
  title: string
  description: string
  metadata: AnyRecord
  undo_payload: AnyRecord | null
  created_at: string
}

export const logInboxActivity = async (event: Omit<InboxActivityEvent, 'id' | 'created_at'>): Promise<boolean> => {
  const supabase = getSupabaseClient()
  const payload = {
    ...event,
    created_at: new Date().toISOString(),
  }

  // Try to insert into inbox_activity_events. If table missing, we just log to console in dev.
  const { error } = await supabase.from('inbox_activity_events').insert(payload)
  
  if (error) {
    console.warn('[ActivityLog] Failed to persist activity', mapErrorMessage(error))
    // Fallback: we could store in a local session-based log if needed
    return false
  }
  return true
}

export const fetchInboxActivity = async (threadKey?: string): Promise<InboxActivityEvent[]> => {
  const supabase = getSupabaseClient()
  let query = supabase
    .from('inbox_activity_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)

  if (threadKey) {
    query = query.eq('thread_key', threadKey)
  }

  const { data, error } = await query
  if (error) {
    console.warn('[ActivityLog] Failed to fetch activity', mapErrorMessage(error))
    return []
  }

  return safeArray(data as InboxActivityEvent[])
}

export const undoInboxActivity = async (activityId: string): Promise<{ ok: boolean; message: string }> => {
  const supabase = getSupabaseClient()
  
  // 1. Fetch the activity
  const { data, error: fetchError } = await supabase
    .from('inbox_activity_events')
    .select('*')
    .eq('id', activityId)
    .single()

  if (fetchError || !data) return { ok: false, message: 'Activity not found' }
  
  const activity = data as InboxActivityEvent
  if (!activity.undo_payload) return { ok: false, message: 'This action cannot be undone' }

  // 2. Perform the undo based on type
  // This usually means calling the inverse workflow function
  // For now, we just return the payload so the UI can decide or we handle specific types here
  
  return { ok: true, message: 'Undo payload ready' }
}
