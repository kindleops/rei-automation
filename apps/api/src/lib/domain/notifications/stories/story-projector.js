/**
 * NOTIFICATION STORIES — the projector (I/O around story-projection.js).
 *
 * Keeps `notification_stories` (PROPOSED migration) up to date as events occur:
 *
 *   projectStories()   incremental pass: read only what changed since the
 *                      projector's cursor (minus an overlap for late-landing
 *                      rows), upsert those inputs, rebuild ONLY the partitions they
 *                      touch with the builder, write the changed story rows.
 *   rebuildProjection() backfill / repair: the current builder's own full-window
 *                      read (story-sources), every partition rebuilt. Refuses (writes
 *                      nothing) while any source is degraded: never a partial backfill.
 *   requestProjection() debounced, single-flight trigger — called from the
 *                      notification emit points (upsert / resolve). The cron tick
 *                      runs passes directly. A READ NEVER TRIGGERS A PASS.
 *   readProjection()    the endpoint's read: story rows with keyset paging.
 *
 * Until the migration is applied AND a complete rebuild has run (the cursor row
 * carries rebuilt_at), every function reports `available: false`: the endpoint
 * keeps serving the snapshot builder (never an empty projection), and the
 * emit / stale-read triggers write nothing. Writes touch ONLY the three
 * projection tables (+ nothing else); they are idempotent, so two processes
 * projecting the same window converge on the same rows.
 */
import { supabase as defaultSupabase, hasSupabaseConfig } from '@/lib/supabase/client.js'
import { listPlatformEvents } from '@/lib/domain/platform/events/platform-events-service.js'
import { readEvents, readNotifications, isMissingTable, STATE_TABLE, WINDOW_MS } from './story-sources.js'
import { toInputs, projectPartitions, diffProjection, storyFromRow, countRows, partitionOfStory, PROJECTION_COLS } from './story-projection.js'
import { archivedFor, isArchivedPartition } from './story-archive-filter.js'

export const STORIES_TABLE = 'notification_stories'
export const INPUTS_TABLE = 'notification_story_inputs'
export const CURSOR_TABLE = 'notification_story_projector'
export const CURSOR_ID = 'stories'
/** re-read this far behind the cursor: rows that land late (ledger lag, observatory) still project */
export const OVERLAP_MS = 15 * 60e3
export const DEBOUNCE_MS = 1500
const INCREMENTAL_PAGES = 10
const REBUILD_PAGES = 60
const REBUILD_NOTIFICATIONS = 5000
const CHUNK = 100
const COUNT_LIMIT = 10000

const nowOf = (deps) => (deps.now ? deps.now() : Date.now())
const dbOf = (deps) => deps.supabase || defaultSupabase
const chunks = (list, n = CHUNK) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out }

/** The projector's cursor row, or { available: false } (migration not applied / never backfilled). */
export async function readCursor(deps = {}) {
  try {
    const { data, error } = await dbOf(deps).from(CURSOR_TABLE).select('id, events_through, notifications_through, rebuilt_at, projected_at, degraded, stats').eq('id', CURSOR_ID).limit(1)
    if (error) return { available: false, missing: isMissingTable(error) }
    const row = Array.isArray(data) ? data[0] : data
    if (!row || !row.rebuilt_at) return { available: false, missing: false, empty: true }
    return { available: true, row }
  } catch {
    return { available: false, missing: false }
  }
}

async function selectAll(q) {
  const { data, error } = await q
  if (error) throw error
  return data || []
}

/** Partition inputs inside the window (chunked by partition). */
async function loadInputs(db, partitions, since) {
  const out = []
  for (const part of chunks(partitions)) {
    out.push(...await selectAll(db.from(INPUTS_TABLE).select('input_id, kind, partition_key, occurred_at, payload').in('partition_key', part).gte('occurred_at', since).limit(20000)))
  }
  return out
}

async function loadExisting(db, partitions) {
  const out = []
  for (const part of chunks(partitions)) out.push(...await selectAll(db.from(STORIES_TABLE).select('story_id, content_hash').in('partition_key', part).limit(20000)))
  return out
}

function stateLoader(db) {
  return async (ids) => {
    const map = new Map()
    try {
      for (const part of chunks(ids)) {
        const { data, error } = await db.from(STATE_TABLE).select('story_id, read_at, unread_at, resolved_at, resolved_by, reopened, updated_at').in('story_id', part)
        if (error) return map
        for (const r of data || []) map.set(r.story_id, r)
      }
    } catch { /* no state table: the builder falls back to the member alert rows */ }
    return map
  }
}

/** Resolve Signal source events that are not in the batch to their partitions. */
async function hostLookup(db, inputsRaw) {
  const ids = []
  for (const r of inputsRaw.notifications || []) {
    const m = r?.metrics_snapshot && typeof r.metrics_snapshot === 'object' ? r.metrics_snapshot : {}
    const src = String(m.source_event_id || m.event_id || '').trim()
    if (r?.domain === 'signals' && src) ids.push(src)
  }
  const map = new Map()
  for (const part of chunks([...new Set(ids)])) {
    const rows = await selectAll(db.from(INPUTS_TABLE).select('input_id, partition_key').in('input_id', part))
    for (const r of rows) map.set(r.input_id, r.partition_key)
  }
  return (id) => map.get(id) || null
}

/**
 * Write inputs, rebuild their partitions, write the changed story rows.
 * `known` = inputs already in memory for those partitions (the rebuild path holds
 * the whole window); otherwise partitions are loaded back from the inputs table.
 */
async function applyInputs(db, inputs, { now, since, known = null, extraPartitions = [] }) {
  const projectedAt = new Date(now).toISOString()
  for (const part of chunks(inputs, 200)) {
    const { error } = await db.from(INPUTS_TABLE).upsert(part.map((i) => ({ ...i, updated_at: projectedAt })), { onConflict: 'input_id' })
    if (error) throw error
  }
  const partitions = [...new Set([...inputs.map((i) => i.partition_key), ...extraPartitions])]
  if (!partitions.length) return { partitions: 0, upserts: 0, deletes: 0, stories: [] }
  const all = known || await loadInputs(db, partitions, since)
  const { stories } = await projectPartitions(all, { now, loadState: stateLoader(db) })
  const existing = await loadExisting(db, partitions)
  const { upserts, deletes } = diffProjection(stories, existing, projectedAt)
  for (const part of chunks(upserts)) {
    const { error } = await db.from(STORIES_TABLE).upsert(part, { onConflict: 'story_id' })
    if (error) throw error
  }
  for (const part of chunks(deletes)) {
    const { error } = await db.from(STORIES_TABLE).delete().in('story_id', part)
    if (error) throw error
  }
  return { partitions: partitions.length, upserts: upserts.length, deletes: deletes.length, stories }
}

async function writeCursor(db, patch) {
  const { error } = await db.from(CURSOR_TABLE).upsert({ id: CURSOR_ID, ...patch }, { onConflict: 'id' })
  if (error) throw error
}

/**
 * Age out: inputs whose window clock left the window are deleted and their partitions re-projected
 * (a partition with nothing left loses its stories) — the builder simply stops reading them.
 */
async function ageOut(db, windowStartIso) {
  const old = await selectAll(db.from(INPUTS_TABLE).select('input_id, partition_key').lt('occurred_at', windowStartIso).limit(5000))
  if (!old.length) return []
  for (const part of chunks(old.map((r) => r.input_id))) { const { error } = await db.from(INPUTS_TABLE).delete().in('input_id', part); if (error) throw error }
  return [...new Set(old.map((r) => r.partition_key))]
}

/** Incremental pass (the normal path). */
export async function projectStories(deps = {}) {
  const db = dbOf(deps)
  const cur = await readCursor(deps)
  if (!cur.available) return { ok: true, available: false, reason: cur.missing ? 'migration_not_applied' : 'not_backfilled' }
  const now = nowOf(deps)
  const windowStart = now - WINDOW_MS
  const listEvents = deps.listEvents || ((q) => listPlatformEvents(q, { quiet: true }))
  const evSince = new Date(Math.max(windowStart, Date.parse(cur.row.events_through || 0) - OVERLAP_MS)).toISOString()
  const ntSince = new Date(Math.max(windowStart, Date.parse(cur.row.notifications_through || 0) - OVERLAP_MS)).toISOString()
  const [ev, nt] = await Promise.all([
    readEvents(listEvents, evSince, { maxPages: INCREMENTAL_PAGES }),
    readNotifications(db, ntSince, { limit: 2000 }),
  ])
  // a backlog bigger than one incremental read is a rebuild (never a silent gap)
  if (ev.truncated || nt.rows.length >= 2000) return rebuildProjection(deps)
  const raw = { events: ev.events, notifications: nt.rows }
  const inputs = toInputs(raw, await hostLookup(db, raw))
  const aged = await ageOut(db, new Date(windowStart).toISOString())
  const r = await applyInputs(db, inputs, { now, since: new Date(windowStart).toISOString(), extraPartitions: aged })
  const degraded = [...ev.degraded, ...nt.degraded]
  // a source that timed out is re-read from the old cursor next pass (no gap) — for up to an hour,
  // after which a chronically-down source no longer holds every other source's cursor back
  const held = ev.degraded.length && now - Date.parse(cur.row.events_through || 0) < 3600e3
  const evThrough = held ? cur.row.events_through : new Date(now).toISOString()
  await writeCursor(db, { events_through: evThrough, notifications_through: new Date(now).toISOString(), projected_at: new Date(now).toISOString(), degraded, stats: { inputs: inputs.length, partitions: r.partitions, upserts: r.upserts, deletes: r.deletes } })
  return { ok: true, available: true, inputs: inputs.length, partitions: r.partitions, upserts: r.upserts, deletes: r.deletes, degraded }
}

/** Backfill / repair: the builder's full-window read, every partition rebuilt; prunes rows that left the window. */
export async function rebuildProjection(deps = {}) {
  const db = dbOf(deps)
  const cur = await readCursor(deps)
  if (!cur.available && cur.missing) return { ok: true, available: false, reason: 'migration_not_applied' }
  const now = nowOf(deps)
  const since = new Date(now - WINDOW_MS).toISOString()
  const listEvents = deps.listEvents || ((q) => listPlatformEvents(q, { quiet: true }))
  const [ev, nt] = await Promise.all([
    readEvents(listEvents, since, { maxPages: REBUILD_PAGES }),
    readNotifications(db, since, { limit: REBUILD_NOTIFICATIONS }),
  ])
  // A rebuild is the projection's ground truth: with a source down it would be partial (stories missing their
  // automation step, un-morphed). Refuse and write nothing — the snapshot builder keeps serving until it succeeds.
  const degraded = [...ev.degraded, ...nt.degraded]
  if (degraded.length) return { ok: false, available: true, refused: 'sources_degraded', degraded, wrote: false }
  const raw = { events: ev.events, notifications: nt.rows }
  const inputs = toInputs(raw)
  const r = await applyInputs(db, inputs, { now, since, known: inputs })
  // prune: inputs whose window clock left the window; stories the full rebuild no longer produces
  await db.from(INPUTS_TABLE).delete().lt('occurred_at', since)
  const keep = new Set(r.stories.map((x) => x.id))
  const stale = (await selectAll(db.from(STORIES_TABLE).select('story_id').limit(COUNT_LIMIT))).map((x) => x.story_id).filter((id) => !keep.has(id))
  for (const part of chunks(stale)) { const { error } = await db.from(STORIES_TABLE).delete().in('story_id', part); if (error) throw error }
  const nowIso = new Date(now).toISOString()
  await writeCursor(db, { events_through: nowIso, notifications_through: nowIso, rebuilt_at: nowIso, projected_at: nowIso, degraded: [], stats: { inputs: inputs.length, partitions: r.partitions, upserts: r.upserts, deletes: r.deletes, truncated: ev.truncated } })
  return { ok: true, available: true, rebuilt: true, inputs: inputs.length, partitions: r.partitions, upserts: r.upserts, deletes: r.deletes, truncated: ev.truncated }
}

/** Re-project specific partitions (after an operator state change). Inputs whose payload changed are patched first. */
export async function reprojectPartitions(partitions, deps = {}, { patchedNotifications = [] } = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const since = new Date(now - WINDOW_MS).toISOString()
  if (patchedNotifications.length) {
    for (const r of patchedNotifications) {
      const { error } = await db.from(INPUTS_TABLE).update({ payload: r, updated_at: new Date(now).toISOString() }).eq('input_id', `ne:${r.id}`)
      if (error) throw error
    }
  }
  const parts = [...new Set(partitions.filter(Boolean))]
  if (!parts.length) return { stories: [] }
  const all = await loadInputs(db, parts, since)
  const projectedAt = new Date(now).toISOString()
  const { stories } = await projectPartitions(all, { now, loadState: stateLoader(db) })
  const existing = await loadExisting(db, parts)
  const { upserts, deletes } = diffProjection(stories, existing, projectedAt)
  for (const part of chunks(upserts)) { const { error } = await db.from(STORIES_TABLE).upsert(part, { onConflict: 'story_id' }); if (error) throw error }
  for (const part of chunks(deletes)) { const { error } = await db.from(STORIES_TABLE).delete().in('story_id', part); if (error) throw error }
  return { stories }
}

/* ── trigger: debounced, single flight per process ─────────────────────── */

let timer = null
let running = null
let dirty = false
let unavailableUntil = 0
let lastError = null

export function projectorStatus() { return { running: Boolean(running), dirty, unavailable_until: unavailableUntil || null, last_error: lastError } }
export function __resetProjector() { if (timer) clearTimeout(timer); timer = null; running = null; dirty = false; unavailableUntil = 0; lastError = null }

/**
 * Ask for an incremental pass soon. Never throws, never blocks the caller.
 * A no-op without database configuration (tests) or while the projection is
 * known to be unavailable (migration not applied — re-checked every 5 minutes).
 */
export function requestProjection(reason = 'event', deps = {}) {
  if (!deps.supabase && !hasSupabaseConfig()) return false
  if (process.env.NOTIFICATION_STORY_PROJECTION === 'off') return false
  if (Date.now() < unavailableUntil) return false
  if (running) { dirty = true; return true }
  if (timer) return true
  timer = setTimeout(() => {
    timer = null
    running = projectStories(deps)
      .then((r) => { if (!r.available) unavailableUntil = Date.now() + 5 * 60e3; lastError = null; return r })
      .catch((e) => { lastError = String(e?.message || e); return null })
      .finally(() => { running = null; if (dirty) { dirty = false; requestProjection(`${reason}:dirty`, deps) } })
  }, deps.debounceMs ?? DEBOUNCE_MS)
  timer.unref?.()
  return true
}

/* ── the read path ─────────────────────────────────────────────────────── */

const encode = (r) => Buffer.from(JSON.stringify({ t: r.updated_at, id: r.story_id ?? r.id }), 'utf8').toString('base64url')

/**
 * Read stories from the projection. Returns null when it is not available (the
 * caller serves the snapshot builder instead). `p` is the parsed story query.
 */
export async function readProjection(p, deps = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const windowStart = new Date(now - WINDOW_MS).toISOString()
  // one round trip of latency: cursor, narrow rows (counts + live ids) and the page in parallel
  const narrowQ = selectAll(db.from(STORIES_TABLE).select(PROJECTION_COLS).order('updated_at', { ascending: false }).limit(COUNT_LIMIT))
  let pageQ = null
  if (p.since) {
    // anything re-projected since the client's last read (5s skew: a pass may commit just after a read began)
    const since = new Date(Date.parse(p.since) - 5e3).toISOString()
    pageQ = selectAll(db.from(STORIES_TABLE).select('story_id, story, updated_at').gt('projected_at', since).order('updated_at', { ascending: false }).limit(500))
  } else if (!p.summary) {
    let q = db.from(STORIES_TABLE).select('story_id, story, updated_at')
    if (p.lens !== 'all') q = q.eq('lens', p.lens)
    if (p.cursor) q = q.or(`updated_at.lt.${p.cursor.t},and(updated_at.eq.${p.cursor.t},story_id.lt.${p.cursor.id})`)
    pageQ = selectAll(q.order('updated_at', { ascending: false }).order('story_id', { ascending: false }).limit(p.limit + 1))
  }
  const [cur, narrow, rows] = await Promise.allSettled([readCursor(deps), narrowQ, pageQ || Promise.resolve([])])
  if (cur.status !== 'fulfilled' || !cur.value.available) return null
  if (narrow.status !== 'fulfilled' || rows.status !== 'fulfilled') return null
  const row = cur.value.row
  // [8.3] stories whose subject is archived leave the lenses and the counts
  const pageStories = rows.value.map((r) => ({ r, s: storyFromRow(r, now) }))
  const { archived, degraded: archiveDegraded } = await archivedFor(db, [...narrow.value.map((r) => r.partition_key), ...pageStories.map((x) => partitionOfStory(x.s))], deps)
  const liveNarrow = narrow.value.filter((r) => !isArchivedPartition(archived, r.partition_key))
  const livePage = pageStories.filter((x) => !isArchivedPartition(archived, partitionOfStory(x.s)))
  // a read NEVER refreshes the projection (not inline, not in the background): passes come from the emit
  // points and the cron tick only, so no read shares its process with a full source read it caused
  const meta = {
    generated_at: new Date(now).toISOString(),
    horizon: windowStart,
    truncated: false,
    degraded: [...(Array.isArray(row.degraded) ? row.degraded : []), ...(archiveDegraded ? [archiveDegraded] : [])],
    state_store: 'table',
    counts: countRows(liveNarrow),
    source: 'projection',
    projected_at: row.projected_at,
  }
  if (p.summary) return { ok: true, ...meta }
  if (p.since) return { ok: true, ...meta, stories: livePage.map((x) => x.s), ids: liveNarrow.map((r) => r.story_id), incremental: true }
  // the cursor follows the raw page so an archived row never stalls pagination
  const raw = rows.value.slice(0, p.limit)
  const shown = new Set(raw.map((r) => r.story_id))
  return { ok: true, ...meta, lens: p.lens, stories: livePage.filter((x) => shown.has(x.r.story_id)).map((x) => x.s), next_cursor: rows.value.length > p.limit ? encode(raw[raw.length - 1]) : null }
}

/** Projection rows for specific story ids (the state endpoint). null when unavailable. */
export async function readProjectedStories(ids, deps = {}) {
  const cur = await readCursor(deps)
  if (!cur.available) return null
  const db = dbOf(deps)
  const out = []
  for (const part of chunks(ids)) out.push(...await selectAll(db.from(STORIES_TABLE).select('story_id, partition_key, story, updated_at').in('story_id', part)))
  return out
}

export async function readProjectionCounts(deps = {}) {
  const db = dbOf(deps)
  const windowStart = new Date(nowOf(deps) - WINDOW_MS).toISOString()
  const rows = await selectAll(db.from(STORIES_TABLE).select(PROJECTION_COLS).limit(COUNT_LIMIT))
  const { archived } = await archivedFor(db, rows.map((r) => r.partition_key), deps)
  return countRows(rows.filter((r) => !isArchivedPartition(archived, r.partition_key)))
}
