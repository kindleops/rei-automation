/**
 * HOME MAP ACTIVITY — the Home Map widget's own read.
 *
 * One lens, one period, aggregated by ZIP. The widget used to pull the whole
 * Analytics performance bundle (every metric, both periods, campaigns,
 * cohorts…) just to draw one heat layer; under production load that RPC hit
 * PostgREST's 8s statement_timeout and the map showed "Couldn't load".
 *
 * Here each lens reads only the rows it counts, through indexed range
 * filters (send_queue.created_at, message_events(direction, created_at),
 * acquisition_opportunity_history, seller_offers), then joins the handful of
 * properties it touched. Counting rules mirror analytics_performance so the
 * map and Analytics agree:
 *   - canary phones / internal_canary / exclude_from_kpis rows are excluded;
 *   - replies are distinct conversations, placed at the message's property,
 *     else at the property of the send that prompted it;
 *   - delivered / failed use the same status predicates;
 *   - stage moves exclude certification/probe/fixture history rows.
 * Buyer purchases live in comp_private and need a narrow RPC
 * (PROPOSED home_map_buyer_purchases); until it exists the lens says so
 * instead of drawing zero.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { resolvePeriod } from '@/lib/domain/analytics/analytics-performance-service.js'
import {
  arr, attributeReplies, byIds, canaryPhoneSet, clean, isCountedTransition, isDelivered, isExcludedRow, isFailed,
  marketTable, num, pagedRange, propertyIndex, zip5,
} from './home-read-kit.js'

export { canaryPhoneSet, isExcludedRow, isDelivered, isFailed, isCountedTransition }

export const MAP_LENSES = Object.freeze(['replies', 'delivered', 'failed', 'moves', 'offers', 'buyers'])
const PLACE_LIMIT = 400

const placed = (lat, lng) => lat !== null && lng !== null && lat !== 0 && lng !== 0

/**
 * Items → places. An item is one counted thing at one location
 * ({ k, zip, mkt, lat, lng }); `distinct` counts distinct k per place
 * (conversations), otherwise every item counts. Items without coordinates
 * are reported as `unplaced`, never dropped silently.
 */
export function aggregatePlaces(items, { distinct = false, limit = PLACE_LIMIT } = {}) {
  const groups = new Map()
  const unplacedKeys = new Set()
  let unplaced = 0
  for (const it of items) {
    const lat = num(it.lat)
    const lng = num(it.lng)
    if (!placed(lat, lng)) {
      if (distinct) unplacedKeys.add(clean(it.k)); else unplaced += 1
      continue
    }
    const key = it.zip || `@${lat.toFixed(3)},${lng.toFixed(3)}`
    let g = groups.get(key)
    if (!g) { g = { key, zip: it.zip || null, markets: new Map(), latSum: 0, lngSum: 0, n: 0, keys: new Set(), count: 0 }; groups.set(key, g) }
    g.latSum += lat; g.lngSum += lng; g.n += 1
    if (it.mkt) g.markets.set(it.mkt, (g.markets.get(it.mkt) ?? 0) + 1)
    if (distinct) g.keys.add(clean(it.k)); else g.count += 1
  }
  const places = [...groups.values()].map((g) => ({
    key: g.key,
    zip: g.zip,
    market: [...g.markets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    lat: Math.round((g.latSum / g.n) * 1e5) / 1e5,
    lng: Math.round((g.lngSum / g.n) * 1e5) / 1e5,
    value: distinct ? g.keys.size : g.count,
  })).filter((p) => p.value > 0).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
  return {
    places: places.slice(0, limit),
    truncated: places.length > limit,
    total: places.reduce((s, p) => s + p.value, 0),
    unplaced: distinct ? unplacedKeys.size : unplaced,
  }
}

/* ── reads ──────────────────────────────────────────────────────────── */

const SEND_COLUMNS = 'id,thread_key,queue_status,delivered_at,delivery_confirmed,property_id,source,from_phone_number,to_phone_number,md_canary:metadata->>internal_canary,md_kpi:metadata->>exclude_from_kpis'

// Server-side narrowing (a superset of the JS predicate, which stays the authority).
export const SEND_NARROW = {
  delivered: (q) => q.or('delivered_at.not.is.null,queue_status.eq.delivered,delivery_confirmed.ilike.true,delivery_confirmed.ilike.delivered,delivery_confirmed.ilike.yes'),
  failed: (q) => q.in('queue_status', ['failed', 'failed_transport', 'undelivered']),
}

async function sendItems(client, period, phones, keep, narrow) {
  const rows = await pagedRange((first) => narrow(client.from('send_queue').select(SEND_COLUMNS, first ? { count: 'exact' } : undefined).gte('created_at', period.start).lt('created_at', period.end)), 'send_queue')
  const counted = rows.filter((s) => !isExcludedRow(s, phones) && keep(s))
  const props = await propertyIndex(client, counted.map((s) => s.property_id))
  return counted.map((s) => { const p = props.get(clean(s.property_id)) ?? {}; return { k: s.id, zip: p.zip ?? null, mkt: p.mkt ?? null, lat: p.lat ?? null, lng: p.lng ?? null } })
}

const INBOUND_COLUMNS = 'id,thread_key,created_at,property_id,from_phone_number,to_phone_number,md_canary:metadata->>internal_canary'

async function replyItems(client, period, phones) {
  const rows = await pagedRange((first) => client.from('message_events').select(INBOUND_COLUMNS, first ? { count: 'exact' } : undefined).eq('direction', 'inbound').gte('created_at', period.start).lt('created_at', period.end), 'message_events')
  const placedReplies = await attributeReplies(client, rows.filter((m) => !isExcludedRow(m, phones)), period.end)
  // count(distinct thread_key) ignores replies without a thread, as the bundle does
  return placedReplies.filter(({ m }) => m.thread_key != null).map(({ m, zip, mkt, lat, lng }) => ({ k: String(m.thread_key), zip, mkt, lat, lng }))
}

async function moveItems(client, period) {
  const rows = await pagedRange((first) => client.from('acquisition_opportunity_history').select('id,opportunity_id,actor,reason', first ? { count: 'exact' } : undefined).eq('event_type', 'stage_transition').gte('created_at', period.start).lt('created_at', period.end), 'acquisition_opportunity_history')
  const counted = rows.filter(isCountedTransition)
  const opps = await byIds(client, 'acquisition_opportunities', 'id', 'id,primary_property_id', counted.map((h) => h.opportunity_id))
  const propOf = new Map(opps.map((o) => [clean(o.id), clean(o.primary_property_id)]))
  const known = counted.filter((h) => propOf.has(clean(h.opportunity_id))) // the RPC inner-joins opportunities
  const props = await propertyIndex(client, known.map((h) => propOf.get(clean(h.opportunity_id))))
  return known.map((h) => { const p = props.get(propOf.get(clean(h.opportunity_id))) ?? {}; return { k: h.id, zip: p.zip ?? null, mkt: p.mkt ?? null, lat: p.lat ?? null, lng: p.lng ?? null } })
}

async function offerItems(client, period) {
  const rows = await pagedRange((first) => client.from('seller_offers').select('offer_id,property_id,direction', first ? { count: 'exact' } : undefined).gte('created_at', period.start).lt('created_at', period.end), 'seller_offers', { orderBy: 'offer_id' })
  // "Offers made" = offers_issued: seller counters (inbound) are not our offers.
  const made = rows.filter((o) => clean(o.direction) !== 'inbound')
  const props = await propertyIndex(client, made.map((o) => o.property_id))
  return made.map((o) => { const p = props.get(clean(o.property_id)) ?? {}; return { k: o.offer_id, zip: p.zip ?? null, mkt: p.mkt ?? null, lat: p.lat ?? null, lng: p.lng ?? null } })
}

const MISSING_FN = (err) => err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(clean(err.message)))

async function buyerResult(client, period) {
  const { data, error } = await client.rpc('home_map_buyer_purchases', { p_start: period.start.slice(0, 10), p_end: period.end.slice(0, 10) })
  if (MISSING_FN(error)) {
    return { available: false, reason: 'buyer_read_not_installed', message: 'Buyer purchases are not readable on Home yet (home_map_buyer_purchases is a proposed read, not applied).' }
  }
  if (error) { const e = new Error(`home_map_buyer_purchases: ${error.message}`); e.code = error.code; throw e }
  const rows = arr(data?.rows)
  const items = rows.flatMap((r) => Array.from({ length: Math.max(0, Math.trunc(num(r.n) ?? 0)) }, () => ({ zip: zip5(r.zip), mkt: clean(r.market) || null, lat: num(r.lat), lng: num(r.lng) })))
  return { available: true, items, dataThrough: data?.data_through ?? null }
}

export const LENS_SOURCE = Object.freeze({
  replies: 'message_events inbound → property (or the prompting send’s property); distinct conversations per ZIP',
  delivered: 'send_queue delivered in the period → property ZIP',
  failed: 'send_queue failed / failed_transport / undelivered in the period → property ZIP',
  moves: 'acquisition_opportunity_history stage_transition (test rows excluded) → opportunity property',
  offers: 'seller_offers created in the period, seller counters excluded → property',
  buyers: 'comp_private.mv_comp_market_evidence identified-buyer purchases via home_map_buyer_purchases',
})

export async function getHomeMapActivity({ lens = 'replies', range = '7d', start = null, end = null } = {}, deps = {}) {
  if (!MAP_LENSES.includes(lens)) { const e = new Error(`unknown lens: ${lens}`); e.code = 'bad_lens'; throw e }
  const client = deps.supabase || defaultSupabase
  const period = resolvePeriod({ range, start, end, now: deps.now ?? Date.now() })
  const phones = canaryPhoneSet()
  const t0 = Date.now()
  const base = { lens, period: { range: period.range, start: period.start, end: period.end }, source: LENS_SOURCE[lens] }

  let items
  let dataThrough = null
  const namesP = marketTable(client).catch(() => new Map()) // labels only; the counts never depend on it
  if (lens === 'buyers') {
    const b = await buyerResult(client, period)
    if (!b.available) return { ...base, available: false, reason: b.reason, message: b.message, places: [], total: 0, unplaced: 0, truncated: false, markets: [], queryMs: Date.now() - t0 }
    items = b.items
    dataThrough = b.dataThrough
  } else if (lens === 'replies') items = await replyItems(client, period, phones)
  else if (lens === 'delivered') items = await sendItems(client, period, phones, isDelivered, SEND_NARROW.delivered)
  else if (lens === 'failed') items = await sendItems(client, period, phones, isFailed, SEND_NARROW.failed)
  else if (lens === 'moves') items = await moveItems(client, period)
  else items = await offerItems(client, period)

  const agg = aggregatePlaces(items, { distinct: lens === 'replies' })
  const names = await namesP
  return {
    ...base,
    available: true,
    places: agg.places.map((p) => ({ ...p, marketName: p.market ? names.get(p.market)?.name ?? null : null })),
    total: agg.total,
    unplaced: agg.unplaced,
    truncated: agg.truncated,
    dataThrough,
    queryMs: Date.now() - t0,
  }
}
