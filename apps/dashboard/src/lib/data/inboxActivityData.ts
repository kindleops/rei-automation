import { getSupabaseClient, hasSupabaseEnv } from '../supabaseClient'
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

/**
 * Typed failure reasons. Constitution §10.1: an error must name what failed,
 * the operator impact, and the next step — which is impossible if the data
 * layer collapses every failure into an empty array.
 */
export type ActivityFetchErrorKind =
  | 'env_missing'
  | 'feed_not_provisioned'
  | 'network'
  | 'query_failed'
  | 'timeout'

export interface ActivityFetchError {
  kind: ActivityFetchErrorKind
  /** Operator-facing sentence. Never a raw driver message. */
  message: string
  /** Technical detail for the disclosure line only (§10.5). */
  detail?: string
}

export interface ActivityFetchResult {
  ok: boolean
  events: InboxActivityEvent[]
  error: ActivityFetchError | null
  fetchedAt: string
}

const MISSING_TABLE_HINTS = [
  'does not exist',
  'schema cache',
  'relation',
  'could not find the table',
  'pgrst205',
  '42p01',
]

const isMissingTable = (raw: string): boolean => {
  const value = raw.toLowerCase()
  return MISSING_TABLE_HINTS.some((hint) => value.includes(hint))
}

export const logInboxActivity = async (
  event: Omit<InboxActivityEvent, 'id' | 'created_at'>,
): Promise<boolean> => {
  if (!hasSupabaseEnv) return false
  try {
    const supabase = getSupabaseClient()
    const payload = {
      ...event,
      created_at: new Date().toISOString(),
    }

    const { error } = await supabase.from('inbox_activity_events').insert(payload)

    if (error) {
      console.warn('[ActivityLog] Failed to persist activity', mapErrorMessage(error))
      return false
    }
    return true
  } catch (error) {
    console.warn('[ActivityLog] Failed to persist activity', mapErrorMessage(error))
    return false
  }
}

/**
 * Fetch the activity feed. Never throws, never lies: a failure returns a typed
 * error rather than an empty array that renders as "no live activity".
 */
export const fetchInboxActivityResult = async (
  threadKey?: string,
  signal?: AbortSignal,
): Promise<ActivityFetchResult> => {
  const fetchedAt = new Date().toISOString()

  if (!hasSupabaseEnv) {
    return {
      ok: false,
      events: [],
      fetchedAt,
      error: {
        kind: 'env_missing',
        message: 'Live activity is not configured for this environment, so no operational events can be read.',
        detail: 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set.',
      },
    }
  }

  try {
    const supabase = getSupabaseClient()
    let query = supabase
      .from('inbox_activity_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)

    if (threadKey) query = query.eq('thread_key', threadKey)
    if (signal) query = query.abortSignal(signal)

    const { data, error } = await query

    if (error) {
      const raw = mapErrorMessage(error) || String(error)
      if (isMissingTable(raw)) {
        return {
          ok: false,
          events: [],
          fetchedAt,
          error: {
            kind: 'feed_not_provisioned',
            message: 'The activity feed table has not been provisioned, so operational events are not being recorded yet.',
            detail: raw,
          },
        }
      }
      return {
        ok: false,
        events: [],
        fetchedAt,
        error: {
          kind: 'query_failed',
          message: 'Live activity could not be read. Queue sends and replies are still happening — only this view is blind.',
          detail: raw,
        },
      }
    }

    return { ok: true, events: safeArray(data as InboxActivityEvent[]), error: null, fetchedAt }
  } catch (error) {
    const raw = mapErrorMessage(error) || String(error)
    const aborted = raw.toLowerCase().includes('abort')
    return {
      ok: false,
      events: [],
      fetchedAt,
      error: {
        kind: aborted ? 'timeout' : 'network',
        message: aborted
          ? 'Live activity timed out. The feed may be slow or unreachable.'
          : 'Live activity could not be reached. Queue sends and replies are still happening — only this view is blind.',
        detail: raw,
      },
    }
  }
}

/**
 * Back-compat shim for callers that only want rows. Prefer
 * `fetchInboxActivityResult` — this form cannot distinguish a quiet feed from
 * a broken one.
 */
export const fetchInboxActivity = async (threadKey?: string): Promise<InboxActivityEvent[]> => {
  const result = await fetchInboxActivityResult(threadKey)
  return result.events
}

/*
 * REMOVED: `undoInboxActivity`.
 *
 * It fetched the activity row, then returned `{ ok: true, message: 'Undo payload
 * ready' }` without performing any inverse mutation. The UI treated `ok: true`
 * as success and refreshed, so the operator saw no error and nothing changed —
 * a control that claims to have done work it never did.
 *
 * There is no inverse-mutation endpoint to call, so the honest fix is removal.
 * Reinstate it only alongside a real inverse workflow per event type.
 * See artifacts/lane-f/report.md ("Backend handoffs").
 */
