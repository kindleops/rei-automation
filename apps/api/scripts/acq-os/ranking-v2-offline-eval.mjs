// ─── scripts/acq-os/ranking-v2-offline-eval.mjs ─────────────────────────────
// Acquisition OS §71 (retrospective) + §72 (offline evaluation). READ-ONLY,
// OFFLINE: runs over a local extract (CSV/JSONL produced by keyset reads with
// statement_timeout=30s) — it never connects to a database.
//
//   node --import ./tests/register-aliases.mjs scripts/acq-os/ranking-v2-offline-eval.mjs \
//        --data=<extract dir> --out=<results.json>
//
// Extract files: graph_*.csv (campaign_target_graph), msgs.csv (message_events
// per property), sq.csv (send_queue), ct.csv (campaign_targets), ao.csv
// (acquisition_opportunities), tas.csv (thread_ai_state asking_price),
// raw_features.jsonl / raw_properties.jsonl (A1 loader columns), mi_zip.csv,
// mi_buyers.csv (buyer names hashed at extract time).
//
// Outcomes are NEVER rewritten: labels are derived from the recorded intents,
// stages, opportunity rows and asking prices as they are.

import fs from 'node:fs'
import path from 'node:path'
import { buildRawFactsFromRows, scoreSellerSituation } from '@/lib/acquisition/seller-situation/index.js'
import { computeCampaignRankV2, compareCampaignRankV2 } from '@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js'
import { computeMarketQuality, marketQualityForRow } from '@/lib/domain/campaigns/ranking-v2/market-quality.js'
import { cohortSegment } from '@/lib/domain/campaigns/ranking-v2/campaign-quality-report.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const DATA = args.data
const OUT = args.out || path.join(DATA, '..', 'eval-results.json')
const NOW = args.now ? new Date(args.now) : new Date()
if (!DATA) { console.error('--data=<dir> required'); process.exit(2) }

// ── tiny CSV ──
function parseCSV(text) {
  const rows = []; let row = []; let f = ''; let q = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 1 } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' }
    else if (c !== '\r') f += c
  }
  if (f.length || row.length) { row.push(f); rows.push(row) }
  return rows
}
function load(name) {
  const r = parseCSV(fs.readFileSync(path.join(DATA, name), 'utf8'))
  const h = r.shift()
  return r.filter((x) => x.length === h.length).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i] === '' ? null : x[i]])))
}
function loadJsonl(name) {
  return fs.readFileSync(path.join(DATA, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

// ── load ──
const t0 = Date.now()
const graph = new Map()
for (const f of fs.readdirSync(DATA).filter((f) => /^graph_\d+\.csv$/.test(f)).sort()) for (const r of load(f)) graph.set(r.property_id, r)
const msgs = load('msgs.csv')
const sq = load('sq.csv')
const ct = load('ct.csv')
const ao = load('ao.csv')
const tas = load('tas.csv')
const features = new Map(loadJsonl('raw_features.jsonl').map((r) => [String(r.property_id), r]))
const properties = new Map(loadJsonl('raw_properties.jsonl').map((r) => [String(r.property_id), r]))
const tLoad = Date.now() - t0

// ── market quality map (same formula as the API; distinct investor buyers 36m) ──
const mi = load('mi_zip.csv').filter((r) => r.geo_level === 'zip' && r.period === '1y')
const buyers = load('mi_buyers.csv')
const cutoff = new Date(NOW.getTime() - 3 * 365.25 * 86400000).toISOString().slice(0, 10)
const buyerSets = new Map()
for (const b of buyers) {
  if (b.is_investor !== 't' || !b.sold_on || b.sold_on < cutoff) continue
  const u = num(b.units)
  const lane = u !== null && u >= 5 ? 'mf_5_plus' : u !== null && u >= 2 ? 'mf_2_4' : 'sfr'
  for (const k of [`${b.zip}|${lane}`, `${b.zip}|all`, ...(lane.startsWith('mf_') ? [`${b.zip}|mf`] : [])]) {
    if (!buyerSets.has(k)) buyerSets.set(k, new Set())
    buyerSets.get(k).add(b.buyer_h)
  }
}
const markets = new Map()
for (const r of mi) {
  const key = `${r.geo_key}|${r.asset}`
  markets.set(key, computeMarketQuality({
    zip: r.geo_key, asset: r.asset, qualified_sales_1y: r.qualified_sale_count, investor_purchases_1y: r.investor_count,
    buyer_known_1y: r.buyer_known_count, cash_purchases_1y: r.cash_count, distinct_investor_buyers_36m: buyerSets.get(key)?.size ?? 0,
    median_price: r.median_price, median_ppsf: r.median_ppsf, median_ppu: r.median_ppu, median_inv_price: r.median_inv_price, latest_sale: r.latest_sale,
  }))
}

// ── score every property we have raw facts for (A1 model, in-process) ──
const t1 = Date.now()
const situations = new Map()
for (const [id, p] of properties) {
  const rf = buildRawFactsFromRows({ property: p, features: features.get(id) ?? null })
  situations.set(id, scoreSellerSituation(rf, { now: NOW }))
}
const tScore = Date.now() - t1

// ── outcomes per property ──
const INTEREST_INTENTS = new Set(['seller_interested', 'asking_price_provided', 'asks_offer', 'latent_interest', 'condition_disclosed', 'contract_requested', 'callback_requested', 'need_time'])
const INTEREST_STAGES = new Set(['asking_price', 'SP', 'S3', 'S4', 'S4B', 'price_high_condition_probe', 'offer_reveal_cash', 'ask_condition_clarifier'])
const PROGRESS_STAGES = new Set(['S4', 'S4B', 'price_high_condition_probe', 'offer_reveal_cash', 'ask_condition_clarifier'])
const POSITIVE_UNCLEAR = /(offer|happy to talk|interested|how much|call me|give me a call|what.{0,10}pay|\$\s?\d|\d{3},\d{3}|\d{3}k\b|make me)/i
const NEGATIVE_UNCLEAR = /(not (4|for) sal|not for sell|nothing for sale|not sell|no vendo|not interested|\bnope\b|^no\b|^noo+\b|under contract|^sold\b|stop)/i
const outcome = new Map()
const ensure = (id) => {
  if (!outcome.has(id)) outcome.set(id, { first_out: null, outbound: 0, inbound: 0, intents: new Set(), stages: new Set(), opt_out: false, unclear_pos: false, unclear_neg: false, threads: new Set() })
  return outcome.get(id)
}
for (const m of msgs) {
  const o = ensure(m.property_id)
  if (m.thread_key) o.threads.add(m.thread_key)
  if (m.direction === 'outbound') { o.outbound += 1; if (!o.first_out || m.created_at < o.first_out) o.first_out = m.created_at }
}
for (const m of msgs) {
  if (m.direction !== 'inbound') continue
  const o = ensure(m.property_id)
  if (o.first_out && m.created_at < o.first_out) continue
  o.inbound += 1
  if (m.detected_intent) o.intents.add(m.detected_intent)
  if (m.stage_after) o.stages.add(m.stage_after)
  if (m.is_opt_out === 't' || m.detected_intent === 'opt_out') o.opt_out = true
  if (m.detected_intent === 'unclear' || !m.detected_intent) {
    const body = String(m.body || '').trim()
    if (NEGATIVE_UNCLEAR.test(body)) o.unclear_neg = true
    else if (POSITIVE_UNCLEAR.test(body)) o.unclear_pos = true
  }
}
const askByThread = new Map(tas.map((r) => [r.thread_key, num(r.asking_price)]))
const aoByProp = new Map()
for (const r of ao) if (r.property_id) aoByProp.set(r.property_id, r)

function labels(id) {
  const o = outcome.get(id)
  if (!o || !o.outbound) return null
  const a = aoByProp.get(id)
  let ask = num(a?.asking_price)
  if (ask === null) for (const t of o.threads) { const v = askByThread.get(t); if (v !== null && v !== undefined) { ask = v; break } }
  if (ask !== null && (ask < 30000 || ask > 20000000)) ask = null // rent / year / phone fragments are not asks
  const value = num(graph.get(id)?.estimated_value) ?? num(properties.get(id)?.estimated_value)
  const interested = [...o.intents].some((i) => INTEREST_INTENTS.has(i)) || [...o.stages].some((s) => INTEREST_STAGES.has(s)) || ask !== null
  const ownership = interested || o.intents.has('ownership_confirmed')
  const realistic = ask !== null && value !== null ? ask <= 1.2 * value : null
  const farAbove = ask !== null && value !== null ? ask > 1.5 * value || ask > value + 100000 : null
  const progressing = [...o.stages].some((s) => PROGRESS_STAGES.has(s)) || ['asking_price', 'property_condition', 'offer'].includes(a?.acquisition_stage)
  return {
    replied: o.inbound > 0,
    ownership,
    interested,
    interested_relaxed: interested || o.unclear_pos,
    asking_price: ask !== null,
    realistic: realistic === true,
    far_above: farAbove === true,
    progressing,
    nurture: o.intents.has('not_interested') || o.unclear_neg,
    hostile: o.intents.has('hostile_or_legal'),
    opt_out: o.opt_out,
    wrong_number: o.intents.has('wrong_number'),
    low_intent: o.opt_out || o.intents.has('hostile_or_legal') || o.intents.has('wrong_number'),
  }
}

// ── rank everyone contacted ──
function rankFor(id) {
  const row = graph.get(id) || { property_id: id, ...(properties.get(id) || {}) }
  const situation = situations.get(id) ?? null
  const market = marketQualityForRow(row, markets)
  return { row, situation, market, rank: computeCampaignRankV2(row, { situation, market, includeWhy: false }) }
}

// ── §71 retrospective ──
const CAMPAIGNS = {
  A: { id: 'cbc2a5d3-b4d4-4297-a168-1ac69e643ee0', name: 'SFR - Minneapolis, Houston, Dallas, Tampa (tired landlord)' },
  B: { id: '607e0599-6f83-4fd8-ae01-1da69a17e86a', name: 'Los Angeles · MFR / TL (tired landlord)' },
}
const SENT = new Set(['delivered', 'sent'])
const retro = {}
for (const [k, c] of Object.entries(CAMPAIGNS)) {
  const targets = ct.filter((r) => r.campaign_id === c.id)
  const sentProps = new Set(sq.filter((r) => r.campaign_id === c.id && SENT.has(r.queue_status)).map((r) => r.property_id))
  const firstSend = sq.filter((r) => r.campaign_id === c.id && SENT.has(r.queue_status)).map((r) => r.sent_at || r.created_at).sort()[0] || null
  const tiers = { A: 0, B: 0, C: 0, UNKNOWN: 0, no_raw_facts: 0 }
  const tiersSent = { A: 0, B: 0, C: 0, UNKNOWN: 0, no_raw_facts: 0 }
  const segments = {}
  const situationsDist = {}
  const out = { delivered_or_sent: 0, replied: 0, ownership: 0, interested: 0, interested_relaxed: 0, asking_price: 0, realistic: 0, far_above: 0, nurture: 0, hostile: 0, opt_out: 0, wrong_number: 0, progressing: 0 }
  const byTier = {}
  const tlFlag = { flagged: 0, flag_only_tier_c: 0 }
  const markets2 = {}
  for (const t of targets) {
    const id = t.property_id
    const s = situations.get(id)
    const tier = s ? s.opportunity_tier : 'no_raw_facts'
    tiers[tier] += 1
    const seg = s ? cohortSegment(s) : 'unknown_score'
    segments[seg] = (segments[seg] || 0) + 1
    if (s) situationsDist[s.seller_situation] = (situationsDist[s.seller_situation] || 0) + 1
    const flags = String(graph.get(id)?.property_flags_text || properties.get(id)?.property_flags_text || '')
    if (/tired landlord/i.test(flags)) { tlFlag.flagged += 1; if (tier === 'C') tlFlag.flag_only_tier_c += 1 }
    const mk = t.state || graph.get(id)?.market || '?'
    markets2[graph.get(id)?.market || mk] = (markets2[graph.get(id)?.market || mk] || 0) + 1
    if (!sentProps.has(id)) continue
    tiersSent[tier] += 1
    const l = labels(id)
    out.delivered_or_sent += 1
    byTier[tier] = byTier[tier] || { n: 0, replied: 0, interested: 0, interested_relaxed: 0, realistic: 0, opt_out: 0, hostile: 0, nurture: 0, progressing: 0 }
    byTier[tier].n += 1
    if (!l) continue
    for (const key of Object.keys(out)) if (key !== 'delivered_or_sent' && l[key]) out[key] += 1
    for (const key of Object.keys(byTier[tier])) if (key !== 'n' && l[key]) byTier[tier][key] += 1
  }
  retro[k] = { ...c, first_send: firstSend, targets: targets.length, sent_properties: sentProps.size, tiers_all_targets: tiers, tiers_sent: tiersSent, segments, situations: situationsDist, tired_landlord_flag: tlFlag, markets: markets2, outcomes: out, outcomes_by_tier: byTier }
}

// ── §72 offline evaluation ──
const population = [...outcome.keys()].filter((id) => outcome.get(id).outbound > 0 && (graph.has(id) || properties.has(id)))
const items = population.map((id) => {
  const r = rankFor(id)
  return { id, row: r.row, rank: r.rank, situation: r.situation, legacy: num(r.row.acquisition_score ?? r.row.final_acquisition_score), graph_id: r.row.graph_id || id, l: labels(id) }
}).filter((x) => x.l)

const orderLegacy = (list) => [...list].sort((a, b) => {
  // the production SQL order: acquisition_score desc nulls last, graph_id asc
  if (a.legacy !== b.legacy) { if (a.legacy === null) return 1; if (b.legacy === null) return -1; return b.legacy - a.legacy }
  return String(a.graph_id).localeCompare(String(b.graph_id))
})
const orderV2 = (list) => [...list].sort((a, b) => compareCampaignRankV2({ property_id: a.id, _rank_v2: a.rank }, { property_id: b.id, _rank_v2: b.rank }))

const GAIN = (l) => (l.progressing ? 3 : 0) + (l.realistic ? 2 : 0) + (l.interested ? 1 : 0) - 0 // non-negative gains
function precisionAt(sorted, k, key) { let h = 0; for (let i = 0; i < Math.min(k, sorted.length); i += 1) if (sorted[i].l[key]) h += 1; return h / Math.min(k, sorted.length) }
function ndcgAt(sorted, k) {
  const dcg = (arr) => arr.slice(0, k).reduce((s, x, i) => s + (2 ** GAIN(x.l) - 1) / Math.log2(i + 2), 0)
  const ideal = [...sorted].sort((a, b) => GAIN(b.l) - GAIN(a.l))
  const d = dcg(ideal)
  return d ? dcg(sorted) / d : 0
}
function auc(sorted, key) { // probability a random positive is ranked above a random negative
  let pos = 0; let neg = 0; let above = 0
  for (const x of sorted) { if (x.l[key]) { pos += 1 } else { neg += 1; above += pos } }
  return pos && neg ? above / (pos * neg) : null
}
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }
const METRIC_KEYS = ['interested', 'interested_relaxed', 'realistic', 'progressing', 'asking_price', 'replied', 'low_intent', 'opt_out', 'far_above', 'nurture']
function evaluate(list) {
  const L = orderLegacy(list); const V = orderV2(list)
  const ks = [100, 250, 500, 1000, Math.round(list.length * 0.1), Math.round(list.length * 0.25)]
  const res = { n: list.length, base_rates: {}, legacy: {}, v2: {} }
  for (const key of METRIC_KEYS) res.base_rates[key] = list.filter((x) => x.l[key]).length
  for (const [name, S] of [['legacy', L], ['v2', V]]) {
    res[name].precision = Object.fromEntries(ks.map((k) => [k, Object.fromEntries(METRIC_KEYS.map((key) => [key, precisionAt(S, k, key)]))]))
    res[name].ndcg = Object.fromEntries(ks.map((k) => [k, ndcgAt(S, k)]))
    res[name].auc = Object.fromEntries(METRIC_KEYS.map((key) => [key, auc(S, key)]))
  }
  return res
}
const full = evaluate(items)
// bootstrap CIs on the DIFFERENCE v2 − legacy (paired resample of properties)
const B = Number(args.boot || 400)
const rnd = seeded(20261007)
const diffs = { auc_interested: [], auc_realistic: [], auc_progressing: [], auc_low_intent: [], ndcg_10pct: [], p10_interested: [], p10_low_intent: [] }
const k10 = Math.round(items.length * 0.1)
for (let b = 0; b < B; b += 1) {
  const sample = Array.from({ length: items.length }, () => items[Math.floor(rnd() * items.length)])
  const L = orderLegacy(sample); const V = orderV2(sample)
  diffs.auc_interested.push(auc(V, 'interested') - auc(L, 'interested'))
  diffs.auc_realistic.push(auc(V, 'realistic') - auc(L, 'realistic'))
  diffs.auc_progressing.push(auc(V, 'progressing') - auc(L, 'progressing'))
  diffs.auc_low_intent.push(auc(V, 'low_intent') - auc(L, 'low_intent'))
  diffs.ndcg_10pct.push(ndcgAt(V, k10) - ndcgAt(L, k10))
  diffs.p10_interested.push(precisionAt(V, k10, 'interested') - precisionAt(L, k10, 'interested'))
  diffs.p10_low_intent.push(precisionAt(V, k10, 'low_intent') - precisionAt(L, k10, 'low_intent'))
}
const ci = (arr) => { const s = arr.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b); return { mean: s.reduce((a, b) => a + b, 0) / s.length, lo95: s[Math.floor(s.length * 0.025)], hi95: s[Math.floor(s.length * 0.975)] } }
const bootstrap = Object.fromEntries(Object.entries(diffs).map(([k, v]) => [k, ci(v)]))

// STRATIFIED by first-contact month: labels drift with the classifier/stage
// machine over time (Apr 0.9% interested vs Oct 2.7%), and legacy-null rows
// are mostly recent — so pooled AUC mixes era with rank. Within-month AUC
// compares orders only among sellers contacted under the same machine.
const monthOf = (x) => String(outcome.get(x.id)?.first_out || '').slice(0, 7) || 'unknown'
function stratifiedAuc(list, key, orderFn) {
  const strata = new Map()
  for (const x of list) { const m = monthOf(x); if (!strata.has(m)) strata.set(m, []); strata.get(m).push(x) }
  let above = 0; let pairs = 0
  for (const s of strata.values()) {
    let pos = 0; let neg = 0; let ab = 0
    for (const x of orderFn(s)) { if (x.l[key]) pos += 1; else { neg += 1; ab += pos } }
    above += ab; pairs += pos * neg
  }
  return pairs ? above / pairs : null
}
const STRAT_KEYS = ['interested', 'progressing', 'realistic', 'low_intent', 'opt_out', 'replied']
const stratified = { legacy: {}, v2: {} }
for (const key of STRAT_KEYS) { stratified.legacy[key] = stratifiedAuc(items, key, orderLegacy); stratified.v2[key] = stratifiedAuc(items, key, orderV2) }
const sdiffs = Object.fromEntries(STRAT_KEYS.map((k) => [k, []]))
const rnd2 = seeded(7)
for (let b = 0; b < B; b += 1) {
  const sample = Array.from({ length: items.length }, () => items[Math.floor(rnd2() * items.length)])
  for (const key of STRAT_KEYS) sdiffs[key].push(stratifiedAuc(sample, key, orderV2) - stratifiedAuc(sample, key, orderLegacy))
}
const stratifiedBootstrap = Object.fromEntries(Object.entries(sdiffs).map(([k, v]) => [k, ci(v)]))
// Within campaign A only (one machine, one opener, one week): the cleanest test.
const campA = new Set(sq.filter((r) => r.campaign_id === CAMPAIGNS.A.id && SENT.has(r.queue_status)).map((r) => r.property_id))
const itemsA = items.filter((x) => campA.has(x.id))
const campaignA = { n: itemsA.length, legacy: {}, v2: {} }
for (const key of STRAT_KEYS) { campaignA.legacy[key] = auc(orderLegacy(itemsA), key); campaignA.v2[key] = auc(orderV2(itemsA), key) }

// outcome rates by v2 tier/band and by legacy decile (calibration-style view)
const byBand = {}
for (const x of items) {
  const k = x.rank.band
  byBand[k] = byBand[k] || { n: 0 }
  byBand[k].n += 1
  for (const key of METRIC_KEYS) byBand[k][key] = (byBand[k][key] || 0) + (x.l[key] ? 1 : 0)
}
const legacyDeciles = {}
for (const x of items) {
  const k = x.legacy === null ? 'null' : `${Math.floor(x.legacy / 10) * 10}s`
  legacyDeciles[k] = legacyDeciles[k] || { n: 0 }
  legacyDeciles[k].n += 1
  for (const key of ['interested', 'realistic', 'progressing', 'low_intent', 'opt_out']) legacyDeciles[k][key] = (legacyDeciles[k][key] || 0) + (x.l[key] ? 1 : 0)
}

// Univariate separation (Wilson 95% CI) — which inputs actually separate
// outcomes on this history. Diagnostic only: nothing here fits weights.
function wilson(k, n) {
  if (!n) return [null, null]
  const z = 1.96; const p = k / n; const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n); const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.round(((c - r) / d) * 10000) / 10000, Math.round(((c + r) / d) * 10000) / 10000]
}
const bucket10 = (v) => (v === null || v === undefined ? 'unknown' : `${Math.min(90, Math.floor(Number(v) / 20) * 20)}+`)
const FEATURES = {
  v2_band: (x) => x.rank.band,
  seller_situation: (x) => x.situation?.seller_situation ?? 'none',
  forced_sale_pressure: (x) => bucket10(x.situation?.components?.forced_sale_pressure),
  landlord_fatigue: (x) => bucket10(x.situation?.components?.landlord_fatigue),
  equity_unlock: (x) => bucket10(x.situation?.components?.equity_unlock),
  tax_pain: (x) => bucket10(x.situation?.components?.tax_pain),
  sell365: (x) => bucket10(x.situation?.sell_probability?.d365),
  identity_alignment: (x) => x.row.identity_alignment || 'unknown',
  phone_type: (x) => x.row.phone_type || 'unknown',
  usage_2_months: (x) => x.row.usage_2_months || 'unknown',
  market_quality: (x) => x.rank.terms?.find((t) => t.key === 'market')?.used_prior ? 'unknown' : bucket10(x.rank.terms?.find((t) => t.key === 'market')?.value),
  legacy_score: (x) => (x.legacy === null ? 'null' : `${Math.floor(x.legacy / 10) * 10}s`),
  market: (x) => x.row.market || 'unknown',
  first_contact_month: (x) => String(outcome.get(x.id)?.first_out || '').slice(0, 7) || 'unknown',
}
const univariate = {}
for (const [name, fn] of Object.entries(FEATURES)) {
  const g = {}
  for (const x of items) {
    const k = fn(x)
    g[k] = g[k] || { n: 0, interested: 0, progressing: 0, opt_out: 0, low_intent: 0, replied: 0 }
    g[k].n += 1
    for (const key of ['interested', 'progressing', 'opt_out', 'low_intent', 'replied']) if (x.l[key]) g[k][key] += 1
  }
  univariate[name] = Object.entries(g).filter(([, v]) => v.n >= 30).map(([k, v]) => ({ value: k, ...v, interested_rate: Math.round((v.interested / v.n) * 10000) / 10000, interested_ci95: wilson(v.interested, v.n), opt_out_rate: Math.round((v.opt_out / v.n) * 10000) / 10000 })).sort((a, b) => b.n - a.n)
}

// §67 audit on the contacted set: tier-C-only rows that legacy put ahead of tier-A rows
const legacyOrder = orderLegacy(items)
let inversions = 0; let seenC = 0
for (const x of legacyOrder) { if (x.rank.band === 'C') seenC += 1; else if (x.rank.band === 'A') inversions += seenC }
const tierCount = (band) => items.filter((x) => x.rank.band === band).length

const result = {
  generated_at: new Date().toISOString(),
  now: NOW.toISOString(),
  timings_ms: { load: tLoad, score_all: tScore, scored: situations.size, per_property_us: Math.round((tScore * 1000) / Math.max(1, situations.size)) },
  retrospective: retro,
  offline_eval: {
    population: items.length,
    population_rule: 'properties with ≥1 outbound message_event and an extract row; labels from inbound after first outbound',
    bands: { A: tierCount('A'), B: tierCount('B'), C: tierCount('C'), FALLBACK: tierCount('FALLBACK'), UNRANKED: tierCount('UNRANKED') },
    full,
    bootstrap_v2_minus_legacy: { B, ...bootstrap },
    stratified_by_contact_month: { auc: stratified, bootstrap_v2_minus_legacy: stratifiedBootstrap },
    within_campaign_A: campaignA,
    by_v2_band: byBand,
    by_legacy_decile: legacyDeciles,
    legacy_order_tierC_ahead_of_tierA_pairs: inversions,
    univariate,
  },
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ out: OUT, population: items.length, timings: result.timings_ms, bands: result.offline_eval.bands }, null, 0))
