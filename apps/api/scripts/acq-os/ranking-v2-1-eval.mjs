// ─── scripts/acq-os/ranking-v2-1-eval.mjs ───────────────────────────────────
// Ranking v2.1 (layered: contact → pressure|contact → deal → market) vs the
// legacy Podio order, plus the targeting FUNNEL. READ-ONLY and OFFLINE (local
// extract; never connects to a database).
//
//   node --import ./tests/register-aliases.mjs scripts/acq-os/ranking-v2-1-eval.mjs \
//        --data=<extract dir> --out=<results.json> [--now=ISO] [--boot=1000]
//
// PRE-REGISTERED PROTOCOL (frozen in code before the first v2.1 run):
//   population  properties with a DELIVERED send_queue row (first delivery =
//               t0); outcomes = inbound after t0, opportunity + asking price.
//   holdout H   md5(property_id)[0..1] < 0x4d (≈30%). Market response context
//               is fitted on NOT-H only. All headline numbers are on H.
//   primary     stratified (by t0 month) AUC on H for
//                 (1) delivered → owner     (reach the right person)
//                 (2) owner → interested    (need to sell, given owner)
//               paired bootstrap (B draws) of v2.1 − legacy, 95% CI.
//   decision    "v2.1 better" only if BOTH primary lower bounds > 0.
//   secondary   every transition's stratified AUC; precision@10%/25% of H for
//               every stage label and for low-intent (opt-out|hostile|wrong #).
// Caveat recorded in the output: the v2.1 contact layer was designed after a
// full-data univariate look (v2.0 report), so H is not perfectly clean; the
// forward test cohort is the clean test.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildRawFactsFromRows, scoreSellerSituation } from '@/lib/acquisition/seller-situation/index.js'
import { annotatePhoneOwnerCounts, compareCampaignRankV2, computeCampaignRankV2 } from '@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js'
import { computeMarketQuality, marketQualityForRow } from '@/lib/domain/campaigns/ranking-v2/market-quality.js'
import { fitMarketResponse, responseContextFor, responseLane } from '@/lib/domain/campaigns/ranking-v2/market-response.js'
import { FUNNEL_STAGES, funnelBySignal, funnelLabels, funnelSignals } from '@/lib/domain/campaigns/ranking-v2/funnel-analytics.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const DATA = args.data
const OUT = args.out || path.join(DATA, '..', 'eval-v2-1.json')
const NOW = args.now ? new Date(args.now) : new Date()
const B = Number(args.boot || 1000)
if (!DATA) { console.error('--data=<dir> required'); process.exit(2) }

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
const load = (name) => { const r = parseCSV(fs.readFileSync(path.join(DATA, name), 'utf8')); const h = r.shift(); return r.filter((x) => x.length === h.length).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i] === '' ? null : x[i]]))) }
const jsonl = (name) => fs.readFileSync(path.join(DATA, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const bool = (v) => (v === 't' ? true : v === 'f' ? false : v)

// ── extract ──
const t0 = Date.now()
const graph = new Map()
for (const f of fs.readdirSync(DATA).filter((f) => /^graph_\d+\.csv$/.test(f)).sort()) {
  for (const r of load(f)) {
    for (const k of ['tax_delinquent', 'active_lien', 'out_of_state_owner', 'is_corporate_owner', 'sms_eligible', 'queue_eligible', 'never_contacted', 'true_post_contact_suppression']) r[k] = bool(r[k])
    graph.set(r.property_id, r)
  }
}
for (const r of load('graph_phone.csv')) { const g = graph.get(r.property_id); if (g) g.canonical_e164 = r.canonical_e164 }
const personKeys = JSON.parse(fs.readFileSync(path.join(DATA, 'person_keys.json'), 'utf8'))
const flagsByKey = new Map()
for (const p of jsonl('prospects.jsonl')) if (p.matching_flags && !flagsByKey.has(p.individual_key)) flagsByKey.set(p.individual_key, p.matching_flags)
for (const [pid, key] of Object.entries(personKeys)) { const g = graph.get(pid); if (g) { g.seller_person_key = key; g.matching_flags = flagsByKey.get(key) ?? null } }
const features = new Map(jsonl('raw_features.jsonl').map((r) => [String(r.property_id), r]))
const properties = new Map(jsonl('raw_properties.jsonl').map((r) => [String(r.property_id), r]))
const msgs = load('msgs.csv')
const sq = load('sq.csv')
const ao = load('ao.csv')
const tas = load('tas.csv')

// shared-phone ambiguity measured on the WHOLE graph (not a batch)
{
  const all = annotatePhoneOwnerCounts([...graph.values()])
  for (const r of all) graph.get(r.property_id).phone_owner_count = r.phone_owner_count
}

// markets (same formula as the API)
const cutoff = new Date(NOW.getTime() - 3 * 365.25 * 86400000).toISOString().slice(0, 10)
const buyerSets = new Map()
for (const b of load('mi_buyers.csv')) {
  if (b.is_investor !== 't' || !b.sold_on || b.sold_on < cutoff) continue
  const u = num(b.units); const lane = u !== null && u >= 5 ? 'mf_5_plus' : u !== null && u >= 2 ? 'mf_2_4' : 'sfr'
  for (const k of [`${b.zip}|${lane}`, `${b.zip}|all`, ...(lane.startsWith('mf_') ? [`${b.zip}|mf`] : [])]) { if (!buyerSets.has(k)) buyerSets.set(k, new Set()); buyerSets.get(k).add(b.buyer_h) }
}
const markets = new Map()
for (const r of load('mi_zip.csv').filter((x) => x.geo_level === 'zip' && x.period === '1y')) {
  markets.set(`${r.geo_key}|${r.asset}`, computeMarketQuality({ zip: r.geo_key, asset: r.asset, qualified_sales_1y: r.qualified_sale_count, investor_purchases_1y: r.investor_count, buyer_known_1y: r.buyer_known_count, cash_purchases_1y: r.cash_count, distinct_investor_buyers_36m: buyerSets.get(`${r.geo_key}|${r.asset}`)?.size ?? 0, median_price: r.median_price }))
}

// ── outcomes (population = delivered) ──
const firstDelivered = new Map()
for (const r of sq) {
  if (r.queue_status !== 'delivered' || !r.property_id) continue
  const t = r.sent_at || r.delivered_at || r.created_at
  if (!firstDelivered.has(r.property_id) || t < firstDelivered.get(r.property_id)) firstDelivered.set(r.property_id, t)
}
const agg = new Map()
for (const m of msgs) {
  const t = firstDelivered.get(m.property_id)
  if (!t) continue
  if (!agg.has(m.property_id)) agg.set(m.property_id, { inbound: 0, intents: new Set(), stages: new Set(), opt_out: false, threads: new Set() })
  const a = agg.get(m.property_id)
  if (m.thread_key) a.threads.add(m.thread_key)
  if (m.direction !== 'inbound' || m.created_at < t) continue
  a.inbound += 1
  if (m.detected_intent) a.intents.add(m.detected_intent)
  if (m.stage_after) a.stages.add(m.stage_after)
  if (m.is_opt_out === 't') a.opt_out = true
}
const askByThread = new Map(tas.map((r) => [r.thread_key, num(r.asking_price)]))
const aoByProp = new Map(ao.filter((r) => r.property_id).map((r) => [r.property_id, r]))

const holdout = (id) => parseInt(crypto.createHash('md5').update(String(id)).digest('hex').slice(0, 2), 16) < 0x4d

const items = []
for (const [id, t] of firstDelivered) {
  const row = graph.get(id)
  if (!row) continue
  const a = agg.get(id) || { inbound: 0, intents: new Set(), stages: new Set(), opt_out: false, threads: new Set() }
  const o = aoByProp.get(id)
  let ask = num(o?.asking_price)
  if (ask === null) for (const th of a.threads) { const v = askByThread.get(th); if (v !== null && v !== undefined) { ask = v; break } }
  const labels = funnelLabels({ delivered: true, inbound: a.inbound, intents: a.intents, stages: a.stages, opt_out: a.opt_out, ask, value: num(row.estimated_value), opportunity_stage: o?.acquisition_stage })
  labels.low_intent = labels.opt_out || labels.hostile || labels.wrong_number
  const p = properties.get(id)
  const situation = p ? scoreSellerSituation(buildRawFactsFromRows({ property: p, features: features.get(id) ?? null }), { now: NOW }) : null
  items.push({ id, row, t0: t, month: String(t).slice(0, 7), H: holdout(id), labels, situation, legacy: num(row.acquisition_score) })
}

// response context: fitted on NOT-H only (pre-registered)
const fitted = fitMarketResponse(items.filter((x) => !x.H).map((x) => ({ market: x.row.market, lane: responseLane(x.row), contacted_at: x.t0, interested: x.labels.interested })), { now: NOW.getTime() })
for (const x of items) {
  const market = marketQualityForRow(x.row, markets)
  x.rank = computeCampaignRankV2(x.row, { situation: x.situation, market, response: responseContextFor(x.row, fitted), includeWhy: false })
  x.signals = funnelSignals(x.row, { situation: x.situation, rank: x.rank })
}
const tPrep = Date.now() - t0

// ── orders ──
const orderLegacy = (list) => [...list].sort((a, b) => {
  if (a.legacy !== b.legacy) { if (a.legacy === null) return 1; if (b.legacy === null) return -1; return b.legacy - a.legacy }
  return String(a.row.graph_id || a.id).localeCompare(String(b.row.graph_id || b.id))
})
const orderV21 = (list) => [...list].sort((a, b) => compareCampaignRankV2({ property_id: a.id, _rank_v2: { ...a.rank, priority_score: a.rank.score } }, { property_id: b.id, _rank_v2: { ...b.rank, priority_score: b.rank.score } }))

function aucOrdered(sorted, key) { let pos = 0; let neg = 0; let above = 0; for (const x of sorted) { if (x.labels[key]) pos += 1; else { neg += 1; above += pos } } return pos && neg ? { auc: above / (pos * neg), pairs: pos * neg, pos } : { auc: null, pairs: 0, pos } }
function stratAuc(list, from, to, orderFn) {
  const strata = new Map()
  for (const x of list) { if (from && !x.labels[from]) continue; if (!strata.has(x.month)) strata.set(x.month, []); strata.get(x.month).push(x) }
  let above = 0; let pairs = 0; let pos = 0; let n = 0
  for (const s of strata.values()) { const r = aucOrdered(orderFn(s), to); if (r.auc !== null) { above += r.auc * r.pairs; pairs += r.pairs } pos += r.pos; n += s.length }
  return { auc: pairs ? above / pairs : null, n, positives: pos }
}
function precisionAt(sorted, k, key) { let h = 0; const m = Math.min(k, sorted.length); for (let i = 0; i < m; i += 1) if (sorted[i].labels[key]) h += 1; return m ? h / m : null }
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }
const ci = (arr) => { const s = arr.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? { mean: s.reduce((a, b) => a + b, 0) / s.length, lo95: s[Math.floor(s.length * 0.025)], hi95: s[Math.floor(s.length * 0.975)], draws: s.length } : null }

const H = items.filter((x) => x.H)
const TRANSITIONS = FUNNEL_STAGES.slice(1).map((to, i) => [FUNNEL_STAGES[i], to])
const transitionAuc = { legacy: {}, v2_1: {} }
for (const [from, to] of TRANSITIONS) {
  transitionAuc.legacy[`${from}→${to}`] = stratAuc(H, from, to, orderLegacy)
  transitionAuc.v2_1[`${from}→${to}`] = stratAuc(H, from, to, orderV21)
}
const PRIMARY = [['delivered', 'owner'], ['owner', 'interested']]
const rnd = seeded(20261007)
const boot = Object.fromEntries([...PRIMARY, ['delivered', 'interested'], ['delivered', 'price'], ['delivered', 'low_intent']].map(([f, t]) => [`${f}→${t}`, []]))
for (let b = 0; b < B; b += 1) {
  const sample = Array.from({ length: H.length }, () => H[Math.floor(rnd() * H.length)])
  for (const key of Object.keys(boot)) {
    const [f, t] = key.split('→')
    const from = f === 'delivered' ? null : f
    const v = stratAuc(sample, from, t, orderV21).auc
    const l = stratAuc(sample, from, t, orderLegacy).auc
    boot[key].push(v !== null && l !== null ? v - l : null)
  }
}
const bootCI = Object.fromEntries(Object.entries(boot).map(([k, v]) => [k, ci(v)]))
// delivered→low_intent: LOWER is better for a ranking (fewer bad contacts on top)
const extraAuc = { legacy: {}, v2_1: {} }
for (const key of ['interested', 'price', 'realistic', 'low_intent', 'opt_out']) { extraAuc.legacy[`delivered→${key}`] = stratAuc(H, null, key, orderLegacy); extraAuc.v2_1[`delivered→${key}`] = stratAuc(H, null, key, orderV21) }
const LH = orderLegacy(H); const VH = orderV21(H)
const precision = {}
for (const frac of [0.1, 0.25]) {
  const k = Math.round(H.length * frac)
  precision[`top_${frac * 100}%_k${k}`] = Object.fromEntries([...FUNNEL_STAGES.slice(1), 'low_intent', 'opt_out'].map((key) => [key, { legacy: precisionAt(LH, k, key), v2_1: precisionAt(VH, k, key), base: H.filter((x) => x.labels[key]).length / H.length }]))
}
const decision = PRIMARY.every(([f, t]) => (bootCI[`${f}→${t}`]?.lo95 ?? -1) > 0) ? 'v2.1 better on both primary endpoints' : 'NOT shown better (a primary lower bound ≤ 0)'

// ── funnel by signal (all delivered; and conditional on confirmed owner) ──
const SIGNALS = ['contact_confidence', 'line_type', 'identity', 'matching_tag', 'tier', 'seller_situation', 'forced_sale_pressure', 'landlord_fatigue', 'tax_pain', 'debt_pressure', 'property_burden', 'equity_unlock', 'sell365', 'equity_class', 'market_quality', 'market']
const funnelAll = funnelBySignal(items, { signals: SIGNALS })
const funnelOwners = funnelBySignal(items, { signals: SIGNALS, conditionalOn: 'owner' })
// response context transparency
const responseCells = [...fitted.values()].filter((c) => c.points !== null).sort((a, b) => b.points - a.points)

const result = {
  generated_at: new Date().toISOString(),
  now: NOW.toISOString(),
  protocol: { holdout: "md5(property_id)[0..1] < 0x4d (≈30%)", primary: PRIMARY.map((p) => p.join('→')), decision_rule: 'both primary bootstrap lower bounds > 0', stratified_by: 'first-delivered month', response_context_fit: 'not-holdout only', caveat: 'v2.1 contact layer designed after a full-data univariate look; forward cohort is the clean test' },
  timings_ms: { prepare: tPrep },
  population: { delivered: items.length, holdout: H.length, by_month: Object.fromEntries([...new Set(items.map((x) => x.month))].sort().map((m) => [m, items.filter((x) => x.month === m).length])) },
  funnel_overall: funnelAll.overall,
  holdout_eval: { transition_auc: transitionAuc, extra_auc: extraAuc, bootstrap_v2_1_minus_legacy: { B, ...bootCI }, precision_at_k: precision, decision },
  funnel_by_signal: funnelAll.by_signal,
  funnel_by_signal_given_owner: funnelOwners,
  response_context: { constants: 'see market-response.js', cells_with_context: responseCells.length, top: responseCells.slice(0, 8), bottom: responseCells.slice(-8) },
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ out: OUT, delivered: items.length, holdout: H.length, decision, prepare_ms: tPrep }))
