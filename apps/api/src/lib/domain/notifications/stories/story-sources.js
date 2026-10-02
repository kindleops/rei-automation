/**
 * NOTIFICATION STORIES — the bounded source reads (shared by the snapshot
 * builder and the projector). Read-only. No second event log: the inputs are
 * the platform event envelope (story types only) and notification_events.
 */
import { STORY_EVENT_TYPES } from './story-grammar.js'

export const WINDOW_MS = 7 * 864e5
export const MAX_PAGES = 5
export const PAGE = 200
export const NOTIFICATION_LIMIT = 800
export const STATE_TABLE = 'notification_story_state'
export const NOTIFICATION_COLS = 'id, event_type, domain, severity, title, description, source_entity_type, source_entity_id, property_id, campaign_id, sender_number_id, workflow_id, deal_id, closing_id, metrics_snapshot, action_state, group_count, status, read_at, dismissed_at, resolved_at, created_at, updated_at'

export const isMissingTable = (e) => /does not exist|schema cache|could not find the table|42P01|PGRST205/i.test(`${e?.code || ''} ${e?.message || e || ''}`)

/** The story-type envelope events since `since`, newest first, ≤ maxPages pages. */
export async function readEvents(listEvents, since, { maxPages = MAX_PAGES } = {}) {
  const events = []
  const degraded = new Set()
  let cursor = null
  let pages = 0
  let horizon = null
  do {
    const r = await listEvents({ types: STORY_EVENT_TYPES.join(','), since, limit: PAGE, ...(cursor ? { cursor } : {}) })
    for (const d of r.degraded || []) degraded.add(d)
    events.push(...(r.events || []))
    cursor = r.next_cursor || null
    pages += 1
    if (r.events?.length) horizon = r.events[r.events.length - 1].occurred_at
  } while (cursor && pages < maxPages)
  // the window actually covered: everything above `horizon` is complete
  return { events, degraded: [...degraded], horizon: cursor ? horizon : new Date(Date.parse(since)).toISOString(), truncated: Boolean(cursor), pages }
}

/** notification_events rows touched since `since`. */
export async function readNotifications(db, since, { limit = NOTIFICATION_LIMIT } = {}) {
  const { data, error } = await db.from('notification_events').select(NOTIFICATION_COLS).gte('updated_at', since).order('updated_at', { ascending: false }).limit(limit)
  if (error) {
    if (isMissingTable(error)) return { rows: [], degraded: ['notification_events:missing'] }
    throw error
  }
  return { rows: data || [], degraded: [] }
}

/** Persisted operator state (READ ≠ RESOLVED) touched since `since`. */
export async function readState(db, since) {
  const { data, error } = await db.from(STATE_TABLE).select('story_id, read_at, unread_at, resolved_at, resolved_by, reopened, updated_at').gte('updated_at', since).limit(5000)
  if (error) return { available: false, map: new Map(), missing: isMissingTable(error) }
  return { available: true, map: new Map((data || []).map((r) => [r.story_id, r])) }
}
