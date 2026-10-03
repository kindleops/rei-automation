/**
 * HOME READ KIT — the narrow PostgREST reads Home's own endpoints share
 * (map-activity, metrics). Small indexed range reads + by-id joins, with
 * the analytics_performance canary rule and reply attribution reproduced
 * exactly, so Home and Analytics count the same things.
 */
import { INTERNAL_TEST_PHONE_SET } from '@/lib/config/internal-phones.js'

export const PAGE = 1000
export const MAX_ROWS = 40_000
const ID_BATCH = 150
const CONCURRENCY = 8

export const clean = (v) => String(v ?? '').trim()
export const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
export const arr = (v) => (Array.isArray(v) ? v : [])
export const zip5 = (v) => { const z = clean(v).slice(0, 5); return z || null }
/** SQL: lower(coalesce(x, '')) in ('true','1','yes') — no trimming. */
const sqlTruthy = (v) => ['true', '1', 'yes'].includes(String(v ?? '').toLowerCase())

export function canaryPhoneSet() {
  const out = new Set()
  for (const p of INTERNAL_TEST_PHONE_SET) {
    const d = String(p).replace(/\D/g, '')
    out.add(String(p)); out.add(d); out.add(`+${d}`); if (d.length === 11) out.add(d.slice(1))
  }
  return out
}

/**
 * analytics_performance exclusion: coalesce(col,'') = any(p_exclude) on
 * thread/from/to; sends also drop source='internal_canary' and
 * exclude_from_kpis; inbound only the internal_canary flag.
 */
export function isExcludedRow(row, phones) {
  if (!row) return true
  const raw = (v) => String(v ?? '')
  if (phones.has(raw(row.thread_key)) || phones.has(raw(row.from_phone_number)) || phones.has(raw(row.to_phone_number))) return true
  if (row.source === 'internal_canary') return true
  if (sqlTruthy(row.md_canary) || sqlTruthy(row.md_kpi)) return true
  return false
}

export const isSent = (s) => s.sent_at != null || s.queue_status === 'sent' || s.queue_status === 'delivered'
export const isDelivered = (s) => s.delivered_at != null || s.queue_status === 'delivered' || ['true', 'delivered', 'yes'].includes(String(s.delivery_confirmed ?? '').toLowerCase())
export const isFailed = (s) => ['failed', 'failed_transport', 'undelivered'].includes(s.queue_status)
const TEST_ACTOR = /(cert|probe|fixture|qa_|test)/i
const TEST_REASON = /(certification|probe|fixture|restore test|regression)/i
export const isCountedTransition = (h) => !TEST_ACTOR.test(String(h.actor ?? '')) && !TEST_REASON.test(String(h.reason ?? ''))

export function unwrap(res, what) {
  if (res?.error) { const e = new Error(`${what}: ${res.error.message || 'read failed'}`); e.code = res.error.code; throw e }
  return arr(res?.data)
}

export async function pool(tasks, concurrency = CONCURRENCY) {
  const out = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i]() }
  })
  await Promise.all(workers)
  return out
}

/**
 * Every row a filtered query matches, past PostgREST's max-rows page.
 * The first page carries the exact count; the rest are read in parallel.
 */
export async function pagedRange(build, what, { orderBy = 'id' } = {}) {
  const first = await build(true).order(orderBy, { ascending: true }).range(0, PAGE - 1)
  const rows = unwrap(first, what)
  const total = num(first.count)
  if (total === null) {
    // No count (fake or older client): read sequentially until a short page.
    const out = [...rows]
    for (let from = PAGE; rows.length === PAGE && from < MAX_ROWS; from += PAGE) {
      const page = unwrap(await build(false).order(orderBy, { ascending: true }).range(from, from + PAGE - 1), what)
      out.push(...page)
      if (page.length < PAGE) return out
    }
    return out
  }
  if (total > MAX_ROWS) { const e = new Error(`${what}: ${total} rows in the period (cap ${MAX_ROWS})`); e.code = 'too_many_rows'; throw e }
  const tasks = []
  for (let from = PAGE; from < total; from += PAGE) tasks.push(async () => unwrap(await build(false).order(orderBy, { ascending: true }).range(from, from + PAGE - 1), what))
  return [...rows, ...(await pool(tasks)).flat()]
}

export async function byIds(client, table, idCol, columns, ids, extra = (q) => q) {
  const uniq = [...new Set(ids.map(clean).filter(Boolean))]
  const tasks = []
  for (let i = 0; i < uniq.length; i += ID_BATCH) {
    const b = uniq.slice(i, i + ID_BATCH)
    tasks.push(async () => unwrap(await extra(client.from(table).select(columns).in(idCol, b)), table))
  }
  return (await pool(tasks)).flat()
}

export async function propertyIndex(client, ids) {
  const rows = await byIds(client, 'properties', 'property_id', 'property_id,property_address_zip,latitude,longitude,canonical_market_id', ids)
  return new Map(rows.map((p) => [clean(p.property_id), { zip: zip5(p.property_address_zip), lat: num(p.latitude), lng: num(p.longitude), mkt: clean(p.canonical_market_id) || null }]))
}

/**
 * Replies' place, as analytics_performance resolves it: the message's own
 * property, else the property of the latest send on the thread at or before
 * the reply (each field coalesced separately, like the SQL).
 */
export async function attributeReplies(client, inbound, endIso) {
  const threads = [...new Set(inbound.map((m) => clean(m.thread_key)).filter(Boolean))]
  const [sends, msgProps] = await Promise.all([
    threads.length ? byIds(client, 'send_queue', 'thread_key', 'thread_key,property_id,created_at', threads, (q) => q.lt('created_at', endIso)) : [],
    propertyIndex(client, inbound.map((m) => m.property_id)),
  ])
  const byThread = new Map()
  for (const s of sends) { const k = clean(s.thread_key); if (!byThread.has(k)) byThread.set(k, []); byThread.get(k).push(s) }
  for (const list of byThread.values()) list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const attOf = (m) => (byThread.get(clean(m.thread_key)) ?? []).find((s) => Date.parse(s.created_at) <= Date.parse(m.created_at)) ?? null
  const withAtt = inbound.map((m) => ({ m, att: attOf(m) }))
  const attProps = await propertyIndex(client, withAtt.map(({ att }) => att?.property_id).filter((id) => id && !msgProps.has(clean(id))))
  const props = new Map([...msgProps, ...attProps])
  return withAtt.map(({ m, att }) => {
    const pm = props.get(clean(m.property_id)) ?? {}
    const pa = props.get(clean(att?.property_id)) ?? {}
    return { m, zip: pm.zip ?? pa.zip ?? null, mkt: pm.mkt ?? pa.mkt ?? null, lat: pm.lat ?? pa.lat ?? null, lng: pm.lng ?? pa.lng ?? null }
  })
}

/** canonical_markets is a small reference table (~60 rows): read whole. */
export async function marketTable(client) {
  const rows = unwrap(await client.from('canonical_markets').select('id,display_name,state').limit(PAGE), 'canonical_markets')
  return new Map(rows.map((m) => [clean(m.id), { id: clean(m.id), name: clean(m.display_name) || clean(m.id), state: m.state ?? null }]))
}

/** Single-flight + short TTL cache for a read keyed by its parameters. */
export function createReadCache({ ttlMs = 30_000, now = () => Date.now(), max = 200 } = {}) {
  const cache = new Map()
  return async function cached(key, read) {
    const hit = cache.get(key)
    if (hit && (hit.pending || now() - hit.at < ttlMs)) return hit.promise
    const entry = { promise: read(), pending: true, at: now() }
    cache.set(key, entry)
    if (cache.size > max) cache.delete(cache.keys().next().value)
    try {
      const data = await entry.promise
      entry.pending = false
      entry.at = now()
      return data
    } catch (error) {
      if (cache.get(key) === entry) cache.delete(key)
      throw error
    }
  }
}
