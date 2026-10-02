/**
 * NOTIFICATION STORIES — the aggregated read model (Notification Center 2.0).
 *
 *   GET  /api/cockpit/notifications/stories
 *        ?lens=needs_you|now|resolved|system|all  &limit(<=100)  &cursor
 *        ?since=<generated_at>   incremental: only stories whose updated_at moved
 *        ?summary=1              counts only (the badge) — served from the snapshot
 *   POST /api/cockpit/notifications/stories/state  { story_ids[], action: read|unread|resolve|reopen }
 *
 * One snapshot per process, rebuilt at most every SNAPSHOT_TTL_MS (single
 * flight), so the badge poll and the open plane share one bounded read: the
 * platform event stream (story types only, ≤ MAX_PAGES pages) + notification_events
 * touched in the window + persisted story state. No per-story queries (no N+1).
 *
 * State: READ ≠ RESOLVED, both persisted. Authority order:
 *   1. notification_story_state (PROPOSED migration) when applied
 *   2. the member notification_events rows' own read_at / status (the old bell's
 *      state — written through, so bell, phone and plane agree)
 *   3. none → `persistence: 'none'`; the client keeps local state for that story
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { listPlatformEvents } from '@/lib/domain/platform/events/platform-events-service.js'
import { writeNotificationActionAudit } from '@/lib/domain/notifications/notification-intelligence-service.js'
import { STORY_EVENT_TYPES, LENSES } from './story-grammar.js'
import { buildStories, countStories } from './story-builder.js'

export const WINDOW_MS = 7 * 864e5
export const SNAPSHOT_TTL_MS = 45e3
export const MAX_PAGES = 5
export const PAGE = 200
export const NOTIFICATION_LIMIT = 800
export const STATE_TABLE = 'notification_story_state'
const NOTIFICATION_COLS = 'id, event_type, domain, severity, title, description, source_entity_type, source_entity_id, property_id, campaign_id, sender_number_id, workflow_id, deal_id, closing_id, metrics_snapshot, action_state, group_count, status, read_at, dismissed_at, resolved_at, created_at, updated_at'
const ACTIONS = new Set(['read', 'unread', 'resolve', 'reopen'])

export class StoryError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}

const clean = (v) => String(v ?? '').trim()
const isMissingTable = (e) => /does not exist|schema cache|could not find the table|42P01|PGRST205/i.test(`${e?.code || ''} ${e?.message || e || ''}`)

let cache = { at: 0, snapshot: null, inflight: null }
export function __resetStoryCache() { cache = { at: 0, snapshot: null, inflight: null } }

async function readEvents(listEvents, since, now) {
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
  } while (cursor && pages < MAX_PAGES)
  // the window actually covered: everything above `horizon` is complete
  return { events, degraded: [...degraded], horizon: cursor ? horizon : new Date(Date.parse(since)).toISOString(), truncated: Boolean(cursor), pages }
}

async function readNotifications(db, since) {
  const { data, error } = await db.from('notification_events').select(NOTIFICATION_COLS).gte('updated_at', since).order('updated_at', { ascending: false }).limit(NOTIFICATION_LIMIT)
  if (error) {
    if (isMissingTable(error)) return { rows: [], degraded: ['notification_events:missing'] }
    throw error
  }
  return { rows: data || [], degraded: [] }
}

async function readState(db, since) {
  const { data, error } = await db.from(STATE_TABLE).select('story_id, read_at, unread_at, resolved_at, resolved_by, reopened, updated_at').gte('updated_at', since).limit(5000)
  if (error) return { available: false, map: new Map(), missing: isMissingTable(error) }
  return { available: true, map: new Map((data || []).map((r) => [r.story_id, r])) }
}

/** Build (or reuse) the process snapshot. */
export async function loadSnapshot(deps = {}) {
  const now = deps.now ? deps.now() : Date.now()
  if (!deps.fresh && cache.snapshot && now - cache.at < (deps.ttlMs ?? SNAPSHOT_TTL_MS)) return cache.snapshot
  if (!deps.fresh && cache.inflight) return cache.inflight
  const db = deps.supabase || defaultSupabase
  const listEvents = deps.listEvents || ((q) => listPlatformEvents(q, { quiet: true }))
  const since = new Date(now - WINDOW_MS).toISOString()
  const run = (async () => {
    const [ev, nt, st] = await Promise.all([
      readEvents(listEvents, since, now).catch((e) => ({ events: [], degraded: [`platform_events:${e?.message || 'failed'}`], horizon: null, truncated: false, failed: true })),
      readNotifications(db, since).catch((e) => ({ rows: [], degraded: [`notification_events:${e?.message || 'failed'}`], failed: true })),
      readState(db, since).catch(() => ({ available: false, map: new Map() })),
    ])
    if (ev.failed && nt.failed) throw new StoryError('stories_unavailable', 'Notifications could not be read right now.', 503)
    // a source that timed out this round (the Workflow Observatory and the message ledger are
    // the slowest) keeps the events the previous snapshot read — still true facts — instead of
    // silently un-morphing or dropping stories; the response still says it is degraded
    const prev = cache.snapshot
    const down = new Set(ev.degraded.map((d) => String(d).split(':')[0]))
    if (prev && down.size) {
      const have = new Set(ev.events.map((e) => e.event_id))
      for (const e of prev.raw.events) if (down.has(e.provenance?.adapter) && !have.has(e.event_id)) ev.events.push(e)
    }
    const snap = { raw: { events: ev.events, notifications: nt.rows }, state: st.map, stateTable: st.available, degraded: [...ev.degraded, ...nt.degraded], horizon: ev.horizon, truncated: ev.truncated, built_at: new Date(now).toISOString(), now }
    assemble(snap, now)
    cache = { at: now, snapshot: snap, inflight: null }
    return snap
  })()
  cache.inflight = run
  try { return await run } finally { if (cache.inflight === run) cache.inflight = null }
}

function assemble(snap, now) {
  const { stories, stats } = buildStories({ ...snap.raw, state: snap.state, now })
  snap.stories = stories
  snap.byId = new Map(stories.map((s) => [s.id, s]))
  snap.stats = stats
  snap.counts = countStories(stories)
}

const encode = (s) => Buffer.from(JSON.stringify({ t: s.updated_at, id: s.id }), 'utf8').toString('base64url')
const decode = (c) => { try { const o = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); return o && typeof o.t === 'string' && typeof o.id === 'string' ? o : null } catch { return null } }
const older = (s, k) => s.updated_at < k.t || (s.updated_at === k.t && s.id < k.id)

export function parseStoryQuery(q = {}) {
  const lens = clean(q.lens) || 'all'
  if (lens !== 'all' && !LENSES.includes(lens)) throw new StoryError('unknown_lens', `Lens is one of ${LENSES.join(', ')} or all.`)
  const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit, 10) || 30))
  const cursor = q.cursor ? decode(q.cursor) : null
  if (q.cursor && !cursor) throw new StoryError('invalid_cursor', 'The cursor could not be read — reload the first page.')
  const since = clean(q.since) || null
  if (since && !Number.isFinite(Date.parse(since))) throw new StoryError('invalid_since', 'since must be an ISO time.')
  return { lens, limit, cursor, since, summary: q.summary === '1' || q.summary === 'true' }
}

const meta = (snap) => ({ generated_at: snap.built_at, horizon: snap.horizon, truncated: snap.truncated, degraded: snap.degraded, state_store: snap.stateTable ? 'table' : 'notification_rows', counts: snap.counts })

export async function getNotificationStories(query = {}, deps = {}) {
  const p = parseStoryQuery(query)
  const snap = await loadSnapshot(deps)
  if (p.summary) return { ok: true, ...meta(snap) }
  if (p.since) {
    const changed = snap.stories.filter((s) => s.updated_at > p.since || (s.resolved_at && s.resolved_at > p.since))
    return { ok: true, ...meta(snap), stories: changed, ids: snap.stories.map((s) => s.id), incremental: true }
  }
  let list = p.lens === 'all' ? snap.stories : snap.stories.filter((s) => s.lens === p.lens)
  if (p.cursor) list = list.filter((s) => older(s, p.cursor))
  const page = list.slice(0, p.limit)
  return { ok: true, ...meta(snap), lens: p.lens, stories: page, next_cursor: list.length > p.limit ? encode(page[page.length - 1]) : null }
}

/** Persist READ / RESOLVED for stories (write-through to the member alert rows). */
export async function updateStoryState(body = {}, deps = {}) {
  const action = clean(body.action)
  if (!ACTIONS.has(action)) throw new StoryError('unknown_action', 'action is read, unread, resolve or reopen.')
  const ids = [...new Set((Array.isArray(body.story_ids) ? body.story_ids : [body.story_id]).map(clean).filter(Boolean))].slice(0, 200)
  if (!ids.length) throw new StoryError('story_ids_required', 'story_ids is required.')
  const db = deps.supabase || defaultSupabase
  const audit = deps.audit || writeNotificationActionAudit
  const operator = clean(body.operator_id) || clean(deps.operatorId) || 'operator'
  const snap = await loadSnapshot(deps)
  const nowIso = new Date(deps.now ? deps.now() : Date.now()).toISOString()
  const stories = ids.map((id) => snap.byId.get(id)).filter(Boolean)
  const missing = ids.filter((id) => !snap.byId.has(id))

  // 1. the story state table (when the migration is applied)
  let table = false
  if (stories.length) {
    const rows = stories.map((s) => {
      const prev = snap.state.get(s.id) || {}
      const row = { story_id: s.id, operator_id: operator, subject_key: s.subject_key, last_trigger_at: s.last_trigger_at, updated_at: nowIso, read_at: prev.read_at || null, unread_at: prev.unread_at || null, resolved_at: prev.resolved_at || null, resolved_by: prev.resolved_by || null, reopened: false }
      if (action === 'read') { row.read_at = nowIso; row.unread_at = null }
      if (action === 'unread') { row.unread_at = nowIso; row.read_at = null }
      if (action === 'resolve') { row.resolved_at = nowIso; row.resolved_by = operator; row.read_at = row.read_at || nowIso }
      if (action === 'reopen') { row.resolved_at = null; row.resolved_by = null; row.reopened = true }
      return row
    })
    const { error } = await db.from(STATE_TABLE).upsert(rows, { onConflict: 'story_id' })
    if (!error) { table = true; for (const r of rows) snap.state.set(r.story_id, r) }
    else if (!isMissingTable(error)) throw new StoryError('state_write_failed', 'Story state could not be saved.', 503)
  }

  // 2. write-through to the member alert rows (the old bell / phone read the same state)
  const memberIds = [...new Set(stories.flatMap((s) => s.notification_ids))]
  let rowsUpdated = 0
  if (memberIds.length) {
    const rowsById = new Map(snap.raw.notifications.map((r) => [String(r.id), r]))
    const patchFor = (r) => {
      if (action === 'read') return r.read_at ? null : { read_at: nowIso }
      if (action === 'unread') return { read_at: null }
      if (action === 'resolve') return r.status === 'active' ? { status: 'resolved', resolved_at: nowIso, read_at: r.read_at || nowIso, action_state: { ...(r.action_state || {}), resolved_by: 'operator', story_resolved: true } } : null
      if (action === 'reopen') return r.status === 'resolved' && r.action_state?.story_resolved ? { status: 'active', resolved_at: null, action_state: { ...(r.action_state || {}), story_resolved: false } } : null
      return null
    }
    for (const id of memberIds) {
      const r = rowsById.get(id)
      if (!r) continue
      const patch = patchFor(r)
      if (!patch) continue
      const { error } = await db.from('notification_events').update({ ...patch, updated_at: r.updated_at }).eq('id', id)
      if (!error) { Object.assign(r, patch); rowsUpdated += 1 }
    }
  }

  // audit: resolve / reopen are decisions; reads are not recorded (no hover spam)
  if (action === 'resolve' || action === 'reopen') {
    for (const s of stories) if (s.notification_ids[0]) await audit({ notification_id: s.notification_ids[0], action_type: `story_${action}`, operator_id: operator, outcome: 'ok', details: { story_id: s.id, subject_key: s.subject_key, notification_ids: s.notification_ids } })
  }

  assemble(snap, deps.now ? deps.now() : Date.now())
  const updated = ids.map((id) => snap.byId.get(id)).filter(Boolean)
  return {
    ok: true,
    action,
    stories: updated,
    persisted: Object.fromEntries(updated.map((s) => [s.id, table ? 'table' : s.notification_ids.length ? 'notification_rows' : 'none'])),
    rows_updated: rowsUpdated,
    missing,
    counts: snap.counts,
  }
}
