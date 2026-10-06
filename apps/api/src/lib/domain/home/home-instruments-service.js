/**
 * HOME INSTRUMENTS — narrow, at-a-glance reads for the Home widgets of apps
 * whose own surfaces are subject-scoped (Deal Intelligence, Comps, Buyer
 * Match, Entity Graph) or heavy (the Queue desk). Each kind reads the same
 * tables and applies the same rules as its owning app, with a handful of
 * indexed queries — never the app's full bundle. Read-only.
 *
 *   deal     property_acquisition_scores for active opportunities (Deal
 *            Intelligence's gates: confidence >= 85, valuation confidence
 *            >= 80; decision_tier REVIEW_REQUIRED) + live seller_offers
 *            (status sent/pending/presented/countered, not superseded)
 *   comps    mv_map_market_sales (the canonical sales projection, via the
 *            Buyer Match sales adapter's source + price rule): freshness,
 *            30/90-day priced counts, active-market counts, latest sales
 *   buyers   buyer_match_candidates for active deals (scores, grades, buyer
 *            type — buyer NAMES ARE NEVER RETURNED) + investor purchases
 *            (is_investor, activity) around each active market
 *   entity   master_owners: most connected owners (Entity Graph networks),
 *            new owners in 7 days
 *   queue    send_queue holds by reason (the desk's hold codes) +
 *            textgrid_numbers sender capacity today
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { clean, num } from './home-read-kit.js'
import { withDerivedSentToday } from '@/lib/domain/delivery/sender-sent-today.js'
import { BUYER_MATCH_SALES_SOURCE, SALES_COLUMNS, isPricedSale, shapeSale } from '@/lib/domain/buyer-match/buyer-match-sales.js'

export const INSTRUMENT_KINDS = Object.freeze(['deal', 'comps', 'buyers', 'entity', 'queue'])

const DAY = 86_400_000
const LIVE_OFFER = ['sent', 'pending', 'presented', 'countered']
export const HOLD_STATUSES = Object.freeze([
  'blocked', 'blocked_by_health_guard', 'blocked_sender_ineligible', 'duplicate_blocked', 'held',
  'paused_duplicate', 'paused_global_lock', 'paused_invalid_queue_row', 'paused_max_retries', 'paused_name_missing', 'paused_operator_review', 'approval',
])

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const fail = (error, what) => { if (error) { const e = new Error(`${what}: ${error.message}`); e.cause = error; throw e } }

let oppsMemo = null
/** Active opportunities, shared by the deal / comps / buyers reads for 60s (one read, not three). */
async function activeOpportunities(db) {
  const t = Date.now()
  if (oppsMemo && oppsMemo.db === db && t - oppsMemo.at < 60_000) return oppsMemo.promise
  const promise = readActiveOpportunities(db)
  oppsMemo = { db, at: t, promise }
  promise.catch(() => { if (oppsMemo?.promise === promise) oppsMemo = null })
  return promise
}
export const __resetInstrumentMemo = () => { oppsMemo = null }

async function readActiveOpportunities(db) {
  const { data, error } = await db.from('acquisition_opportunities')
    .select('id, primary_property_id, primary_thread_key, master_owner_id, property_address_full, market, acquisition_stage, current_offer, recommended_offer, last_activity_at')
    .eq('opportunity_status', 'active')
    .limit(2000)
  fail(error, 'active opportunities')
  return data || []
}

/** "Dallas, TX" → { city: 'Dallas', state: 'TX' } (the canonical market label shape). */
export function splitMarket(m) {
  const s = clean(m)
  const i = s.lastIndexOf(',')
  if (i < 0) return null
  const city = s.slice(0, i).trim()
  const state = s.slice(i + 1).trim().toUpperCase()
  return city && /^[A-Z]{2}$/.test(state) ? { city, state, label: `${city}, ${state}` } : null
}

function topMarkets(opps, limit = 5) {
  const by = new Map()
  for (const o of opps) { const m = splitMarket(o.market); if (m) by.set(m.label, { ...m, deals: (by.get(m.label)?.deals ?? 0) + 1 }) }
  return [...by.values()].sort((a, b) => b.deals - a.deals).slice(0, limit)
}

/* ── deal ── */

export function summarizeDeals(opps, scores, offers) {
  const latest = new Map()
  for (const s of scores) { const p = clean(s.property_id); const prev = latest.get(p); if (!prev || clean(s.computed_at) > clean(prev.computed_at)) latest.set(p, s) }
  const rows = opps.map((o) => ({ o, s: latest.get(clean(o.primary_property_id)) ?? null }))
  const scored = rows.filter((r) => r.s)
  const review = scored.filter((r) => clean(r.s.decision_tier) === 'REVIEW_REQUIRED')
  const low = scored.filter((r) => (num(r.s.confidence) ?? 0) < 85 || (num(r.s.valuation_confidence) ?? 0) < 80)
  const tiers = {}
  for (const r of scored) { const t = clean(r.s.decision_tier) || 'UNTIERED'; tiers[t] = (tiers[t] ?? 0) + 1 }
  const item = (r) => ({
    opportunityId: r.o.id, propertyId: clean(r.o.primary_property_id) || null, threadKey: clean(r.o.primary_thread_key) || null, masterOwnerId: clean(r.o.master_owner_id) || null,
    address: clean(r.o.property_address_full) || null, market: clean(r.o.market) || null, stage: clean(r.o.acquisition_stage) || null,
    tier: clean(r.s?.decision_tier) || null, confidence: num(r.s?.confidence), valuationConfidence: num(r.s?.valuation_confidence), recommendedOffer: num(r.s?.recommended_cash_offer),
  })
  const live = offers.filter((x) => !x.superseded_at && LIVE_OFFER.includes(clean(x.status).toLowerCase()))
  return {
    active: opps.length,
    scored: scored.length,
    unscored: opps.length - scored.length,
    review: review.length,
    lowConfidence: low.length,
    tiers,
    offersAwaiting: live.length,
    reviewItems: review.slice(0, 6).map(item),
    lowItems: low.filter((r) => !review.includes(r)).sort((a, b) => (num(a.s.confidence) ?? 0) - (num(b.s.confidence) ?? 0)).slice(0, 6).map(item),
    offers: live.slice(0, 6).map((x) => ({ id: x.id, propertyId: clean(x.property_id) || null, opportunityId: x.opportunity_id ?? null, price: num(x.purchase_price), status: clean(x.status), sentAt: x.sent_at ?? x.created_at ?? null })),
    rules: { lowConfidence: 'confidence < 85 or valuation confidence < 80 (Deal Intelligence gates)', review: 'decision tier REVIEW_REQUIRED' },
  }
}

async function readDeal(db) {
  // offers do not depend on the opportunity list: read them alongside it
  const offersRead = db.from('seller_offers').select('id, property_id, opportunity_id, purchase_price, status, sent_at, created_at, superseded_at').in('status', LIVE_OFFER).is('superseded_at', null).order('created_at', { ascending: false }).limit(50)
  const opps = await activeOpportunities(db)
  const ids = [...new Set(opps.map((o) => clean(o.primary_property_id)).filter(Boolean))]
  const chunks = []
  for (let i = 0; i < ids.length; i += 300) chunks.push(ids.slice(i, i + 300))
  const [offers, ...scoreReads] = await Promise.all([offersRead, ...chunks.map((c) => db.from('property_acquisition_scores').select('property_id, decision_tier, confidence, valuation_confidence, recommended_cash_offer, computed_at').in('property_id', c))])
  fail(offers.error, 'seller offers')
  const scores = []
  for (const r of scoreReads) { fail(r.error, 'acquisition scores'); scores.push(...(r.data || [])) }
  return summarizeDeals(opps, scores, offers.data || [])
}

/* ── comps + buyers: the canonical sales projection ── */

/*
 * SOURCE: public.mv_map_market_sales (BUYER_MATCH_SALES_SOURCE) — refreshed
 * daily; the legacy mv_map_sold_comps froze on 2026-05-08 and is never read.
 * PRICE RULE (owner): price > 0 is priced comp evidence; zero / NULL price is
 * transaction activity only — never a priced comp or a price stat.
 * Index-friendly: every read is bounded by sold_on (index) and, per market,
 * by a lat/lng box around the market's active deals (index on (lat, lng)).
 */
const SALES = BUYER_MATCH_SALES_SOURCE
const BOX_LAT = 0.36 // ~25 mi
const BOX_LNG = 0.45

/** Each top market's centre: the median coordinate of its active deals' properties. */
async function marketBoxes(db, opps, limit) {
  const markets = topMarkets(opps, limit)
  if (!markets.length) return []
  const idsByMarket = new Map(markets.map((m) => [m.label, opps.filter((o) => splitMarket(o.market)?.label === m.label).map((o) => clean(o.primary_property_id)).filter(Boolean).slice(0, 40)]))
  const all = [...new Set([...idsByMarket.values()].flat())]
  const { data, error } = await db.from('properties').select('property_id, latitude, longitude').in('property_id', all)
  fail(error, 'deal coordinates')
  const at = new Map((data || []).map((p) => [clean(p.property_id), [num(p.latitude), num(p.longitude)]]))
  const median = (xs) => { const v = xs.filter((x) => x !== null && x !== 0).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null }
  return markets.map((m) => {
    const pts = (idsByMarket.get(m.label) || []).map((id) => at.get(id)).filter(Boolean)
    const lat = median(pts.map((p) => p[0])), lng = median(pts.map((p) => p[1]))
    return { ...m, lat, lng }
  }).filter((m) => m.lat !== null && m.lng !== null)
}

const inBox = (q, m) => q.gte('lat', m.lat - BOX_LAT).lte('lat', m.lat + BOX_LAT).gte('lng', m.lng - BOX_LNG).lte('lng', m.lng + BOX_LNG)
const countOf = async (q, what) => { const { count, error } = await q; fail(error, what); return count ?? 0 }

async function readComps(db, now) {
  const since90 = isoDay(now - 90 * DAY)
  const since30 = isoDay(now - 30 * DAY)
  const head = () => db.from(SALES).select('comp_id', { count: 'exact', head: true })
  const [newest, priced30, priced90, activity90, recent, boxes] = await Promise.all([
    db.from(SALES).select('sold_on').gt('price', 0).order('sold_on', { ascending: false }).limit(1),
    countOf(head().gte('sold_on', since30).gt('price', 0), '30d priced sales'),
    countOf(head().gte('sold_on', since90).gt('price', 0), '90d priced sales'),
    countOf(head().gte('sold_on', since90), '90d sales activity'),
    db.from(SALES).select(SALES_COLUMNS).gt('price', 0).order('sold_on', { ascending: false }).limit(8),
    activeOpportunities(db).then((o) => marketBoxes(db, o, 4)),
  ])
  fail(newest.error, 'newest sale'); fail(recent.error, 'recent sales')
  const byMarket = await Promise.all(boxes.map(async (m) => ({ market: m.label, deals: m.deals, comps90: await countOf(inBox(head().gte('sold_on', since90).gt('price', 0), m), 'market priced sales') })))
  const newestOn = newest.data?.[0]?.sold_on ?? null
  return {
    newestSale: newestOn,
    freshnessDays: newestOn ? Math.max(0, Math.floor((now - Date.parse(`${newestOn}T00:00:00Z`)) / DAY)) : null,
    sales30: priced30,
    sales90: priced90,
    activity90,
    recent: (recent.data || []).filter(isPricedSale).map((r) => { const x = shapeSale(r); return { id: String(r.comp_id), propertyId: clean(r.property_id) || null, address: clean(r.address) || null, city: clean(r.city) || null, state: clean(r.state) || null, soldOn: r.sold_on, price: x.price ?? num(r.price), ppsf: x.ppsf ?? null, type: clean(r.property_type) || null, units: num(r.units), lat: num(r.lat), lng: num(r.lng) } }),
    activeMarkets: byMarket,
    source: `${SALES} (priced sales: price > 0; ~25 mi around each market's active deals)`,
  }
}

async function readBuyers(db, now) {
  const opps = await activeOpportunities(db)
  const byProperty = new Map(opps.map((o) => [clean(o.primary_property_id), o]))
  const ids = [...byProperty.keys()].filter(Boolean)
  const since = isoDay(now - 90 * DAY)
  const head = () => db.from(SALES).select('comp_id', { count: 'exact', head: true })
  const candReads = []
  // buyer_display_name is deliberately NOT selected: names stay out of Home
  for (let i = 0; i < ids.length; i += 300) candReads.push(db.from('buyer_match_candidates').select('property_id, buyer_type, match_score, match_grade, buyer_response_status').in('property_id', ids.slice(i, i + 300)).order('match_score', { ascending: false }).limit(1000))
  const [boxes, ...candResults] = await Promise.all([marketBoxes(db, opps, 5), ...candReads])
  const cands = []
  for (const r of candResults) { fail(r.error, 'buyer match candidates'); cands.push(...(r.data || [])) }
  const perDeal = new Map()
  for (const c of cands) { const p = clean(c.property_id); const cur = perDeal.get(p) ?? { count: 0, best: null }; cur.count += 1; if (!cur.best || (num(c.match_score) ?? 0) > (num(cur.best.match_score) ?? 0)) cur.best = c; perDeal.set(p, cur) }
  const strongest = [...perDeal.entries()].sort((a, b) => (num(b[1].best.match_score) ?? 0) - (num(a[1].best.match_score) ?? 0)).slice(0, 6).map(([p, v]) => {
    const o = byProperty.get(p)
    return { opportunityId: o?.id ?? null, propertyId: p, threadKey: clean(o?.primary_thread_key) || null, address: clean(o?.property_address_full) || null, market: clean(o?.market) || null, candidates: v.count, bestScore: num(v.best.match_score), bestGrade: clean(v.best.match_grade) || null, bestBuyerType: clean(v.best.buyer_type) || null }
  })
  // investor purchases are ACTIVITY: any recorded sale counts, priced or not
  const demand = await Promise.all(boxes.map(async (m) => {
    const [sales90, investorPurchases90] = await Promise.all([
      countOf(inBox(head().gte('sold_on', since), m), 'market sales'),
      countOf(inBox(head().gte('sold_on', since).eq('is_investor', true), m), 'investor purchases'),
    ])
    return { market: m.label, deals: m.deals, sales90, investorPurchases90 }
  }))
  return {
    activeDeals: opps.length,
    dealsWithMatches: perDeal.size,
    candidates: cands.length,
    contacted: cands.filter((c) => clean(c.buyer_response_status) && clean(c.buyer_response_status) !== 'not_contacted').length,
    strongest,
    demand,
    privacy: 'Buyer company and person names are withheld on Home.',
  }
}

/* ── entity ── */

const titleCase = (s) => clean(s).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b(Llc|Lp|Llp|Inc|Ii|Iii|Iv)\b/g, (w) => w.toUpperCase())

async function readEntity(db) {
  const [top, owners] = await Promise.all([
    db.from('master_owners').select('master_owner_id, display_name, owner_type_guess, property_count, portfolio_total_value, markets_text').gt('property_count', 1).order('property_count', { ascending: false, nullsFirst: false }).limit(8),
    db.from('master_owners').select('master_owner_id', { count: 'estimated', head: true }),
  ])
  fail(top.error, 'top owners'); fail(owners.error, 'owner count')
  return {
    owners: owners.count ?? null,
    ownersEstimated: true,
    connected: (top.data || []).map((r) => ({ id: String(r.master_owner_id), name: titleCase(r.display_name) || 'Owner', kind: clean(r.owner_type_guess) || null, properties: num(r.property_count) ?? 0, value: num(r.portfolio_total_value), markets: clean(r.markets_text).split(/[,|;]/).map((s) => s.trim()).filter(Boolean).slice(0, 2) })),
    // there is no relationship-change ledger: Home does not invent "recent changes"
    changes: null,
  }
}

/* ── queue ── */

export function holdCodeOf(r) { return clean(r.guard_reason) || clean(r.blocked_reason) || clean(r.paused_reason) || clean(r.queue_status) || 'unknown' }

async function readQueue(db, now) {
  const fleetRead = await db.from('textgrid_numbers').select('phone_number, friendly_name, market, status, daily_limit, messages_sent_today, health_state, cooling_until, spam_flagged_at, last_used_at, metadata')
  fail(fleetRead.error, 'sender fleet')
  // TRUE sends in each sender's day, split COLD (the daily cap's count) and
  // CONVERSATIONAL (replies; never capped by it) — sender-sent-today.js.
  const fleet = { data: await withDerivedSentToday(db, fleetRead.data || [], { now: new Date(now) }) }
  // PostgREST caps a read at 1000 rows: page through the holds (bounded)
  const heldRows = []
  for (let from = 0; from < 10_000; from += 1000) {
    const { data, error } = await db.from('send_queue').select('id, queue_status, guard_reason, blocked_reason, paused_reason').in('queue_status', HOLD_STATUSES).order('id').range(from, from + 999)
    fail(error, 'held rows')
    heldRows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const held = { data: heldRows }
  const reasons = new Map()
  for (const r of held.data || []) { const c = holdCodeOf(r); reasons.set(c, (reasons.get(c) ?? 0) + 1) }
  const numbers = (fleet.data || []).map((n) => {
    const cooling = n.cooling_until && Date.parse(n.cooling_until) > now
    const flagged = Boolean(n.spam_flagged_at)
    const active = clean(n.status).toLowerCase() === 'active' && !cooling && !flagged
    const limit = num(n.daily_limit)
    const sent = num(n.messages_sent_today) ?? 0
    const replies = n.sent_today_basis === 'send_queue' ? num(n.messages_sent_today_conversational) ?? 0 : null
    return { phone: clean(n.phone_number), label: clean(n.friendly_name) || null, market: clean(n.market) || null, state: active ? 'active' : cooling ? 'cooling' : flagged ? 'flagged' : clean(n.status) || 'unknown', health: clean(n.health_state) || null, limit, sent, replies, remaining: active && limit != null ? Math.max(0, limit - sent) : 0 }
  })
  return {
    held: (held.data || []).length,
    heldCapped: heldRows.length >= 10_000,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
    senders: { total: numbers.length, active: numbers.filter((n) => n.state === 'active').length, cooling: numbers.filter((n) => n.state === 'cooling').length, flagged: numbers.filter((n) => n.state === 'flagged').length, remainingToday: numbers.reduce((s, n) => s + n.remaining, 0), dailyCapacity: numbers.filter((n) => n.state === 'active').reduce((s, n) => s + (n.limit ?? 0), 0), coldSentToday: numbers.reduce((s, n) => s + n.sent, 0), repliesToday: numbers.some((n) => n.replies !== null) ? numbers.reduce((s, n) => s + (n.replies ?? 0), 0) : null },
    numbers: numbers.sort((a, b) => b.remaining - a.remaining).slice(0, 8),
    note: numbers.length && (fleet.data || []).every((n) => n.sent_today_basis === 'send_queue') ? 'cold sends in each sender\'s day (replies are not capped)' : 'messages_sent_today as each number reports it',
  }
}

export function createHomeInstrumentsReader({ db = defaultSupabase, now = () => Date.now() } = {}) {
  return async function read(kind) {
    const t = now()
    if (kind === 'deal') return readDeal(db)
    if (kind === 'comps') return readComps(db, t)
    if (kind === 'buyers') return readBuyers(db, t)
    if (kind === 'entity') return readEntity(db)
    if (kind === 'queue') return readQueue(db, t)
    throw new Error(`unknown kind ${kind}`)
  }
}
