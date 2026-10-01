/**
 * PLATFORM EVENTS — listPlatformEvents(query, deps): one bounded, keyset-paged
 * stream over every adapter (see envelope.js for the ownership contract).
 *
 *   ?cursor&limit(<=200)&since&until&sources=&types=&severity=&subject_type=&subject_id=&market=&tail=1
 *   → { ok, events, next_cursor, sources: {name: {ok, freshness_at}}, degraded, generated_at }
 *
 * Every adapter read is bounded and runs under a timeout; a failing adapter is
 * listed in `degraded` and contributes nothing — it never fails the response.
 * Nothing here writes.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { canonicalTime, SEVERITIES, SOURCE_SYSTEMS, SUBJECT_TYPES, EVENT_TYPES } from './envelope.js'
import { decodeCursor, encodeCursor, keyOf, mergePage } from './keyset.js'
import { messagesAdapter } from './adapters/messages.js'
import { campaignSendsAdapter } from './adapters/campaign-sends.js'
import { workflowAdapter } from './adapters/workflow.js'
import { leadStateAdapter } from './adapters/lead-state.js'
import { pipelineAdapter } from './adapters/pipeline.js'
import { campaignsAdapter } from './adapters/campaigns.js'
import { closingAdapter, notificationsAdapter } from './adapters/closing-notifications.js'

export const ADAPTERS = Object.freeze([messagesAdapter, campaignSendsAdapter, workflowAdapter, leadStateAdapter, pipelineAdapter, campaignsAdapter, closingAdapter, notificationsAdapter])

const DAY = 864e5
const MAX_WINDOW_MS = 90 * DAY
const DEFAULT_WINDOW_MS = 7 * DAY
/** extra reads a short page may make to get past noise-only horizons */
const MAX_EMPTY_HOPS = 6
/** a live-tail cursor older than this is a reconnect (laptop waking up): never replayed as live */
export const TAIL_REPLAY_GUARD_MS = 15 * 60e3
const ADAPTER_TIMEOUT_MS = 12_000

export class PlatformEventsError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const clean = (v) => String(v ?? '').trim()

function withTimeout(promise, ms) {
  let t
  return Promise.race([promise.finally(() => clearTimeout(t)), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('source_timeout')), ms) })])
}

/** Validate + normalize the query (pure). */
export function parseQuery(q = {}, now = Date.now()) {
  const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit, 10) || 60))
  const cursor = q.cursor ? decodeCursor(q.cursor) : null
  if (q.cursor && !cursor) throw new PlatformEventsError('invalid_cursor', 'The cursor could not be read — reload the first page.')
  const until = q.until ? canonicalTime(q.until) : null
  if (q.until && !until) throw new PlatformEventsError('invalid_until', 'until must be an ISO time.')
  let since = q.since ? canonicalTime(q.since) : null
  if (q.since && !since) throw new PlatformEventsError('invalid_since', 'since must be an ISO time.')
  const floor = canonicalTime(now - MAX_WINDOW_MS)
  if (!since) since = canonicalTime((until ? Date.parse(until) : now) - DEFAULT_WINDOW_MS)
  if (since < floor) since = floor
  const systems = list(q.sources)
  for (const s of systems) if (!SOURCE_SYSTEMS.includes(s)) throw new PlatformEventsError('unknown_source', `Unknown source "${s}".`)
  const types = list(q.types)
  for (const t of types) if (!EVENT_TYPES[t]) throw new PlatformEventsError('unknown_event_type', `Unknown event type "${t}".`)
  const severity = list(q.severity)
  for (const s of severity) if (!SEVERITIES.includes(s)) throw new PlatformEventsError('unknown_severity', `Unknown severity "${s}".`)
  const subjectType = clean(q.subject_type) || null
  const subjectId = clean(q.subject_id) || null
  if (subjectType && !SUBJECT_TYPES.includes(subjectType)) throw new PlatformEventsError('unknown_subject_type', `Replay supports ${SUBJECT_TYPES.join(', ')}.`)
  if (subjectType && !subjectId) throw new PlatformEventsError('subject_id_required', 'subject_id is required with subject_type.')
  if (subjectType === 'workflow' && !/^[a-z0-9_:-]+:[^:]+$/i.test(subjectId)) throw new PlatformEventsError('invalid_workflow_subject', 'A workflow subject is "<workflow_key>:<run_id>".')
  return {
    limit, cursor, since, until: cursor ? null : until, tail: q.tail === '1' || q.tail === 'true' || q.tail === true,
    systems: systems.length ? new Set(systems) : null, types: types.length ? new Set(types) : null, severity: severity.length ? new Set(severity) : null,
    market: clean(q.market).toLowerCase() || null, subjectType, subjectId,
  }
}

/** Subject resolution for replay: one subject → the identifiers every adapter filters on. */
export async function resolveSubject(db, type, id) {
  if (!type) return null
  if (type === 'seller') {
    const { data, error } = await db.from('inbox_thread_state').select('thread_key, property_id, prospect_id, master_owner_id, market, seller_display_name').eq('thread_key', id).maybeSingle()
    if (error) throw new PlatformEventsError('subject_lookup_failed', 'The seller could not be resolved right now.', 503)
    if (!data) throw new PlatformEventsError('subject_not_found', 'No conversation with that thread key.', 404)
    return { type, id, label: data.seller_display_name || null, thread_keys: [data.thread_key], property_ids: data.property_id ? [String(data.property_id)] : [], prospect_id: data.prospect_id || null, master_owner_id: data.master_owner_id || null, market: data.market || null }
  }
  if (type === 'property') {
    const [{ data: threads, error }, { data: prop }] = await Promise.all([
      db.from('inbox_thread_state').select('thread_key').eq('property_id', id).limit(25),
      db.from('properties').select('property_id, property_address_full').eq('property_id', id).maybeSingle(),
    ])
    if (error) throw new PlatformEventsError('subject_lookup_failed', 'The property could not be resolved right now.', 503)
    if (!prop && !(threads || []).length) throw new PlatformEventsError('subject_not_found', 'No property with that id.', 404)
    return { type, id, label: prop?.property_address_full || null, thread_keys: (threads || []).map((t) => t.thread_key).filter(Boolean), property_ids: [id] }
  }
  if (type === 'campaign') {
    const { data, error } = await db.from('campaigns').select('id, name, market').eq('id', id).maybeSingle()
    if (error) throw new PlatformEventsError(/uuid/i.test(error.message || '') ? 'subject_not_found' : 'subject_lookup_failed', 'The campaign could not be resolved.', /uuid/i.test(error.message || '') ? 404 : 503)
    if (!data) throw new PlatformEventsError('subject_not_found', 'No campaign with that id.', 404)
    return { type, id, label: data.name || null, campaign_id: data.id, thread_keys: [], property_ids: [] }
  }
  if (type === 'closing') return { type, id, label: null, closing_id: id, thread_keys: [], property_ids: [] }
  if (type === 'workflow') {
    const i = id.lastIndexOf(':')
    return { type, id, label: null, workflow_key: id.slice(0, i), run_id: id.slice(i + 1), thread_keys: [], property_ids: [] }
  }
  throw new PlatformEventsError('unknown_subject_type', 'Unknown subject type.')
}

const wants = (a, p) => (!p.systems || a.systems.some((s) => p.systems.has(s))) && (!p.types || a.types.some((t) => p.types.has(t)))

export async function listPlatformEvents(query = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const p = parseQuery(query, now)
  const generated_at = new Date(now).toISOString()
  const adapters = deps.adapters || ADAPTERS
  const sources = {}
  for (const a of adapters) sources[a.name] = { ok: true, freshness_at: null, systems: a.systems, table: a.table, read: false }

  // live tail: a stale head is a reconnect — say so, return nothing, let the client reload page one
  if (p.tail && (!query.since || now - Date.parse(p.since) > TAIL_REPLAY_GUARD_MS)) {
    return { ok: true, events: [], next_cursor: null, sources, degraded: [], generated_at, replay_suppressed: true, window: { since: p.since, until: generated_at } }
  }

  const subject = await resolveSubject(db, p.subjectType, p.subjectId)
  const degraded = []
  const readPage = async (cursor) => {
  const scope = { since: p.since, until: p.until || (cursor ? null : canonicalTime(now + 1000)), cursor, limit: p.limit, subject, systems: p.systems, types: p.types }
  const results = await Promise.all(adapters.map(async (a) => {
    if (!a.supports(subject) || !wants(a, p)) return null
    sources[a.name].read = true
    try {
      const r = await withTimeout(a.read(scope, { db, now, observatory: deps.observatory }), deps.timeoutMs || ADAPTER_TIMEOUT_MS)
      let events = r.events || []
      if (p.types) events = events.filter((e) => p.types.has(e.event_type))
      if (p.systems) events = events.filter((e) => p.systems.has(e.source_system))
      if (p.severity) events = events.filter((e) => p.severity.has(e.severity))
      if (p.market) events = events.filter((e) => String(e.market || '').toLowerCase() === p.market)
      if (r.degraded_parts?.length) degraded.push(...r.degraded_parts.map((x) => `${a.name}:${x}`))
      if (!cursor) sources[a.name].freshness_at = (r.events || []).reduce((m, e) => (!m || e.occurred_at > m ? e.occurred_at : m), null)
      return { events, complete_above: r.complete_above || null }
    } catch (error) {
      sources[a.name].ok = false
      degraded.push(a.name)
      if (!deps.quiet) console.warn('platform.events.adapter_failed', a.name, error?.message || error)
      return null
    }
  }))
  return mergePage(results.filter(Boolean), { limit: p.limit, cursor })
  }
  // A source can read its whole row budget and keep none of it (noise it owns,
  // e.g. send-success bookkeeping), which raises the page horizon above every
  // real event: an empty page that still has a cursor. Keep walking — bounded —
  // until the page has events or the window is exhausted, so "nothing recorded"
  // is only ever said when it is true.
  let page = await readPage(p.cursor)
  const seen = new Set(page.events.map((e) => e.event_id))
  for (let hops = 0; page.next_cursor && page.events.length < p.limit && hops < MAX_EMPTY_HOPS; hops++) {
    const next = await readPage(decodeCursor(page.next_cursor))
    const fresh = next.events.filter((e) => !seen.has(e.event_id))
    for (const e of fresh) seen.add(e.event_id)
    const combined = [...page.events, ...fresh]
    page = combined.length > p.limit
      ? { events: combined.slice(0, p.limit), next_cursor: encodeCursor(keyOf(combined[p.limit - 1])) }
      : { events: combined, next_cursor: next.next_cursor }
  }
  return {
    ok: true,
    events: page.events,
    next_cursor: p.tail ? null : page.next_cursor,
    sources,
    degraded,
    generated_at,
    subject: subject ? { type: subject.type, id: subject.id, label: subject.label || null, thread_keys: subject.thread_keys, property_ids: subject.property_ids } : null,
    window: { since: p.since, until: p.until || generated_at },
    ...(p.tail ? { replay_suppressed: false, has_more: Boolean(page.next_cursor) } : {}),
  }
}
