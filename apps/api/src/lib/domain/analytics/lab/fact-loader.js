/**
 * ANALYTICS LAB — FACT LOADER.
 *
 * Reads the slim fact rows a period needs, over indexed windows only:
 *
 *   send_queue          attempt window (sent_at | created_at), idx_send_queue_sent_at + idx_send_queue_created_at
 *   message_events      inbound window (direction, created_at), idx_message_events_direction_created_at
 *   message_events      carrier failure bucket for failed rows, by queue_id (idx_message_events_queue_id)
 *   history / opps      whole tables (1.3K / 0.8K rows)
 *   autopilot runs      created_at window
 *   dimensions          by primary key for the ids the facts reference (properties, templates)
 *                       or whole small tables (campaigns 58, markets 58, senders 16)
 *
 * Everything is paged at PostgREST's 1,000-row cap with a bounded
 * concurrency, and cached by WINDOW CONTAINMENT: a 7-day request inside a
 * cached 60-day window is served from memory. Live windows (touching now) are
 * cached 90 s, closed windows 15 min; every response names its data-as-of time.
 *
 * NEVER writes. The only verbs used are select/count.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const PAGE = 1000
const LIVE_TTL = 90_000
const CLOSED_TTL = 15 * 60_000
const DIM_TTL = 15 * 60_000
const LIVE_SLACK = 10 * 60_000
const MAX_ENTRIES = 8

export const SEND_COLUMNS = [
  'id', 'thread_key', 'queue_status', 'created_at', 'sent_at', 'delivered_at', 'delivery_confirmed', 'scheduled_for', 'scheduled_for_utc',
  'campaign_id', 'property_id', 'template_id', 'textgrid_number_id', 'from_phone_number', 'to_phone_number', 'source', 'message_type',
  'touch_number', 'language', 'seller_display_name', 'failed_reason', 'blocked_reason', 'guard_reason', 'paused_reason',
  'md_internal_canary:metadata->>internal_canary', 'md_exclude_from_kpis:metadata->>exclude_from_kpis',
].join(',')
export const INBOUND_COLUMNS = 'id,thread_key,created_at,detected_intent,is_opt_out,opt_out_keyword,property_id,from_phone_number,to_phone_number,event_type,md_internal_canary:metadata->>internal_canary'
export const PROPERTY_COLUMNS = [
  'property_id', 'canonical_market_id', 'property_address_state', 'property_address_zip', 'property_address_county_name', 'property_county_name',
  'property_address_city', 'property_address_full', 'latitude', 'longitude', 'property_type', 'equity_percent', 'estimated_value', 'year_built',
  'building_square_feet', 'total_bedrooms', 'units_count', 'tax_delinquent', 'active_lien', 'ownership_years', 'owner_type', 'is_corporate_owner', 'out_of_state_owner',
].join(',')
const CAMPAIGN_COLUMNS = [
  'id', 'name', 'status', 'candidate_source', 'created_at', 'md_source:metadata->>source', 'md_proof:metadata->>proof', 'md_internal_proof:metadata->>internal_proof',
  'md_internal_canary:metadata->>internal_canary', 'md_not_business_data:metadata->>not_business_data', 'md_canary:metadata->>canary',
  'md_test_fixture:metadata->>test_fixture', 'md_proof_probe:metadata->>proof_probe', 'md_production_launch:metadata->>production_launch',
  'md_quarantine_active:metadata->quarantine->>active',
].join(',')

const iso = (ms) => new Date(ms).toISOString()

async function pool(tasks, concurrency = 6) {
  const out = new Array(tasks.length)
  let i = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (i < tasks.length) {
      const k = i++
      out[k] = await tasks[k]()
    }
  })
  await Promise.all(workers)
  return out
}

function unwrap(res, what) {
  if (res?.error) {
    const e = new Error(`${what}: ${res.error.message || res.error.code || 'query failed'}`)
    e.source = what
    throw e
  }
  return Array.isArray(res?.data) ? res.data : []
}

/**
 * Count, then fetch every page in parallel (ordered by id so pages never
 * overlap). supabase-js needs select() before filters, so `filters(query)`
 * is applied to each page's select.
 */
export async function fetchAll(client, table, columns, filters = (x) => x, { concurrency = 6, onRequest = () => {} } = {}) {
  onRequest()
  const first = await filters(client.from(table).select(columns, { count: 'exact' })).order('id', { ascending: true }).range(0, PAGE - 1)
  const rows = unwrap(first, table)
  const total = Number.isFinite(first.count) ? first.count : rows.length
  if (total <= rows.length) return rows
  const tasks = []
  for (let from = PAGE; from < total; from += PAGE) {
    tasks.push(async () => { onRequest(); return unwrap(await filters(client.from(table).select(columns)).order('id', { ascending: true }).range(from, from + PAGE - 1), table) })
  }
  const pages = await pool(tasks, concurrency)
  return rows.concat(...pages)
}

function chunk(list, n) {
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

export function createFactLoader({ supabase = defaultSupabase, clock = () => Date.now(), concurrency = 6 } = {}) {
  const windows = new Map() // table -> entries
  const dims = new Map() // table -> Map(id -> { at, row })
  const whole = new Map() // table -> { at, promise }
  const stats = { requests: 0, cacheHits: 0, cacheMisses: 0 }

  const onRequest = () => { stats.requests += 1 }
  const paged = (table, columns, filters) => fetchAll(supabase, table, columns, filters, { concurrency, onRequest })

  /** Windowed table read with containment caching. `fetch(start, end)` returns rows. */
  async function windowed(table, start, end, fetch) {
    const now = clock()
    const live = end >= now - LIVE_SLACK
    const list = windows.get(table) || []
    // A live entry holds everything up to its load time; a closed entry covers exactly its window.
    const hit = list.find((e) => e.start <= start && (e.live || e.end >= end) && now - e.loadedAt < (e.live ? LIVE_TTL : CLOSED_TTL))
    if (hit) { stats.cacheHits += 1; return { rows: await hit.promise, loadedAt: hit.loadedAt } }
    stats.cacheMisses += 1
    const fetchEnd = live ? now + 60_000 : end
    const entry = { start, end: fetchEnd, live, loadedAt: now, promise: fetch(start, fetchEnd) }
    list.unshift(entry)
    windows.set(table, list.slice(0, MAX_ENTRIES))
    try {
      return { rows: await entry.promise, loadedAt: entry.loadedAt }
    } catch (e) {
      windows.set(table, (windows.get(table) || []).filter((x) => x !== entry))
      throw e
    }
  }

  async function wholeTable(table, columns, ttl, filter = (b) => b) {
    const now = clock()
    const e = whole.get(table)
    if (e && now - e.at < ttl) { stats.cacheHits += 1; return { rows: await e.promise, loadedAt: e.at } }
    stats.cacheMisses += 1
    const entry = { at: now, promise: paged(table, columns, filter) }
    whole.set(table, entry)
    try {
      return { rows: await entry.promise, loadedAt: now }
    } catch (err) {
      whole.delete(table)
      throw err
    }
  }

  async function byIds(table, idColumn, columns, ids, { batch = 450 } = {}) {
    const now = clock()
    const store = dims.get(table) || new Map()
    dims.set(table, store)
    const want = [...new Set(ids.filter(Boolean).map(String))]
    const missing = want.filter((id) => { const e = store.get(id); return !e || now - e.at > DIM_TTL })
    if (missing.length) {
      stats.cacheMisses += 1
      const tasks = chunk(missing, batch).map((ids2) => async () => {
        stats.requests += 1
        return unwrap(await supabase.from(table).select(columns).in(idColumn, ids2), table)
      })
      const pages = await pool(tasks, Math.max(concurrency, 10))
      const found = new Set()
      for (const row of pages.flat()) { store.set(String(row[idColumn]), { at: now, row }); found.add(String(row[idColumn])) }
      // remember misses too, so an unknown id is not re-queried every request
      for (const id of missing) if (!found.has(id)) store.set(id, { at: now, row: null })
    } else if (want.length) stats.cacheHits += 1
    const out = new Map()
    for (const id of want) { const e = store.get(id); if (e?.row) out.set(id, e.row) }
    return out
  }

  /*
   * send_queue REPLICA. The heaviest fact table (19K rows) is mirrored in
   * process and kept current by an incremental read on updated_at, which the
   * zz_send_queue_touch_updated_at trigger bumps on EVERY insert and update.
   * A full refresh every 30 min also catches deletes. The first request never
   * waits for it: it reads its own window while the replica loads behind it.
   */
  const replica = { rows: null, version: 0, fullAt: 0, syncedAt: 0, checkedAt: 0, promise: null, filtered: new Map() }
  const REPLICA_COLUMNS = `${SEND_COLUMNS},updated_at`
  function syncReplica() {
    const now = clock()
    if (replica.promise) return replica.promise
    if (replica.rows && now - replica.checkedAt < LIVE_TTL / 3) return Promise.resolve()
    replica.promise = (async () => {
      const started = clock()
      if (!replica.rows || started - replica.fullAt > 30 * 60_000) {
        const rows = await paged('send_queue', REPLICA_COLUMNS, (x) => x)
        replica.rows = new Map(rows.map((r) => [r.id, r]))
        replica.fullAt = started
        stats.replicaFull = (stats.replicaFull || 0) + 1
      } else {
        // 2-minute overlap: a row updated while the previous sync ran is read again, never missed
        const since = new Date(replica.syncedAt - 120_000).toISOString()
        const rows = await paged('send_queue', REPLICA_COLUMNS, (x) => x.gte('updated_at', since))
        for (const r of rows) replica.rows.set(r.id, r)
        stats.replicaDelta = (stats.replicaDelta || 0) + rows.length
      }
      replica.syncedAt = started
      replica.checkedAt = clock()
      replica.version += 1
      replica.filtered.clear()
    })().finally(() => { replica.promise = null })
    return replica.promise
  }
  function replicaWindow(start, end, basis) {
    const key = `${basis}|${start}|${end}|${replica.version}`
    if (!replica.filtered.has(key)) {
      const out = []
      for (const r of replica.rows.values()) {
        const t = basis === 'created' ? Date.parse(r.created_at) : Date.parse(r.sent_at || r.created_at)
        if (t >= start && t < end) out.push(r)
      }
      out.sort((a, b) => (a.id < b.id ? -1 : 1))
      if (replica.filtered.size > 12) replica.filtered.delete(replica.filtered.keys().next().value)
      replica.filtered.set(key, out)
    }
    return { rows: replica.filtered.get(key), loadedAt: replica.syncedAt }
  }
  async function sendRows(start, end, basis) {
    if (replica.rows) {
      await syncReplica()
      return replicaWindow(start, end, basis)
    }
    // Narrow windows read only their own pages; the whole-table replica is
    // built only when a wide window (> 45 days) would read most of it anyway.
    if (end - start > 45 * 86_400_000) {
      try { await syncReplica() } catch (e) { console.error('analytics.lab_replica_failed', e?.message || e) }
      if (replica.rows) return replicaWindow(start, end, basis)
    }
    return sends(start, end, basis)
  }

  /* ── fact families ── */

  function sends(start, end, basis = 'attempt') {
    return windowed(`send_queue:${basis}`, start, end, (a, b) => paged('send_queue', SEND_COLUMNS, basis === 'created'
      ? (x) => x.gte('created_at', iso(a)).lt('created_at', iso(b))
      : (x) => x.or(`and(sent_at.gte.${iso(a)},sent_at.lt.${iso(b)}),and(sent_at.is.null,created_at.gte.${iso(a)},created_at.lt.${iso(b)})`)))
  }

  function inbound(start, end) {
    return windowed('message_events:inbound', start, end, (a, b) => paged('message_events', INBOUND_COLUMNS,
      (x) => x.eq('direction', 'inbound').gte('created_at', iso(a)).lt('created_at', iso(b))))
  }

  function runs(start, end) {
    const cols = 'id,status,created_at,property_id,thread_id,workflow_id,replay_only,md_block_reason:metadata->>block_reason'
    return windowed('seller_automation_executions', start, end, (a, b) => paged('seller_automation_executions', cols,
      (x) => x.gte('created_at', iso(a)).lt('created_at', iso(b))))
  }

  /** Latest carrier failure bucket per failed/rejected queue row. */
  async function failureBuckets(queueIds) {
    const store = dims.get('failure_bucket') || new Map()
    dims.set('failure_bucket', store)
    const now = clock()
    const missing = [...new Set(queueIds)].filter((id) => { const e = store.get(id); return !e || now - e.at > LIVE_TTL })
    if (missing.length) {
      const tasks = chunk(missing, 150).map((ids) => async () => {
        stats.requests += 1
        return unwrap(await supabase.from('message_events').select('queue_id,failure_bucket,created_at').in('queue_id', ids).not('failure_bucket', 'is', null).neq('direction', 'inbound'), 'message_events.failure_bucket')
      })
      const rows = (await pool(tasks, concurrency)).flat()
      const latest = new Map()
      for (const r of rows) {
        const prev = latest.get(r.queue_id)
        if (!prev || Date.parse(r.created_at) > Date.parse(prev.created_at)) latest.set(r.queue_id, r)
      }
      for (const id of missing) store.set(id, { at: now, bucket: latest.get(id)?.failure_bucket ?? null })
    }
    const out = new Map()
    for (const id of queueIds) out.set(id, store.get(id)?.bucket ?? null)
    return out
  }

  const history = () => wholeTable('acquisition_opportunity_history', 'id,opportunity_id,event_type,previous_value,new_value,created_at,source,actor,reason', LIVE_TTL,
    (b) => b.in('event_type', ['stage_transition', 'opportunity_created']))
  const opportunities = () => wholeTable('acquisition_opportunities', 'id,acquisition_stage,opportunity_status,stage_entered_at,last_activity_at,primary_property_id,primary_thread_key,campaign_ids,created_at', LIVE_TTL)
  const offers = () => wholeTable('seller_offers', 'id,offer_id,opportunity_id,property_id,thread_key,direction,status,purchase_price,created_at,accepted_at', LIVE_TTL)
  const closings = () => wholeTable('closing_cases', [
    'id', 'opportunity_id', 'property_id', 'thread_key', 'closing_status', 'terminal_outcome', 'contract_signed_date', 'recording_date', 'funding_date', 'created_at',
    // money, kept by basis (contract / expected / confirmed); provenance.voided is the Pipeline's void rule
    'seller_contract_price', 'buyer_price', 'assignment_fee', 'expected_gross_revenue', 'confirmed_gross_revenue', 'net_revenue', 'revenue_confirmed_date',
    'md_voided:provenance->>voided',
  ].join(','), LIVE_TTL)
  const campaigns = () => wholeTable('campaigns', CAMPAIGN_COLUMNS, LIVE_TTL)
  const markets = () => wholeTable('canonical_markets', 'id,display_name,state,region,is_active', DIM_TTL)
  const senders = () => wholeTable('textgrid_numbers', 'id,phone_number,friendly_name,market,status,health_state', DIM_TTL)
  const properties = (ids) => byIds('properties', 'property_id', PROPERTY_COLUMNS, ids)
  const templates = (ids) => byIds('sms_templates', 'template_id', 'id,template_id,template_name,use_case,language,stage_code,is_first_touch', ids)

  /**
   * Everything a set of windows needs. `lookbackMs` extends the send window
   * backwards so a reply can be attributed to the message that prompted it.
   */
  async function load({ start, end, lookbackMs = 30 * 86_400_000, basis = 'attempt' } = {}) {
    const t0 = Date.now()
    const timing = {}
    const time = (k, p) => { const t = Date.now(); return p.then((v) => { timing[k] = Date.now() - t; return v }) }
    const sendStart = start - lookbackMs
    const [s, r, h, o, ru, of, cl, ca, mk, se] = await Promise.all([
      time('sends', sendRows(sendStart, end, basis)), time('inbound', inbound(start, end)), time('history', history()), time('opportunities', opportunities()), time('runs', runs(start, end)),
      offers(), closings(), campaigns(), markets(), senders(),
    ])
    const failedIds = s.rows.filter((x) => ['failed_transport', 'undelivered', 'failed', 'paused_max_retries'].includes(String(x.queue_status || '').toLowerCase())).map((x) => x.id)
    const propertyIds = [
      ...s.rows.map((x) => x.property_id), ...r.rows.map((x) => x.property_id), ...o.rows.map((x) => x.primary_property_id), ...ru.rows.map((x) => x.property_id),
      ...of.rows.map((x) => x.property_id), ...cl.rows.map((x) => x.property_id),
    ].filter(Boolean)
    const templateIds = s.rows.map((x) => x.template_id).filter(Boolean)
    const [buckets, props, tpls] = await Promise.all([time('buckets', failureBuckets(failedIds)), time('properties', properties(propertyIds)), time('templates', templates(templateIds))])
    const loadedAt = Math.min(s.loadedAt, r.loadedAt, h.loadedAt, o.loadedAt, ru.loadedAt)
    return {
      window: { start, end, sendStart, basis },
      sends: s.rows, inbound: r.rows, history: h.rows, opportunities: o.rows, runs: ru.rows, offers: of.rows, closings: cl.rows,
      campaigns: ca.rows, markets: mk.rows, senders: se.rows, buckets, properties: props, templates: tpls,
      dataAsOf: new Date(loadedAt).toISOString(),
      loadMs: Date.now() - t0,
      timing,
      rows: { sends: s.rows.length, inbound: r.rows.length, runs: ru.rows.length, properties: props.size },
    }
  }

  return {
    load, stats,
    replicaState: () => ({ ready: Boolean(replica.rows), rows: replica.rows?.size ?? 0, version: replica.version, fullAt: replica.fullAt ? new Date(replica.fullAt).toISOString() : null, syncedAt: replica.syncedAt ? new Date(replica.syncedAt).toISOString() : null }),
    warm: () => syncReplica(),
    clear: () => { windows.clear(); dims.clear(); whole.clear(); replica.rows = null; replica.filtered.clear() },
  }
}

let shared = null
/** One loader per server process (its cache is the point). */
export function sharedFactLoader() {
  if (!shared) shared = createFactLoader()
  return shared
}
