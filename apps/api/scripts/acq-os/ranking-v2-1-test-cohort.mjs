// ─── scripts/acq-os/ranking-v2-1-test-cohort.mjs ────────────────────────────
// PREPARE (never launch) the deliberate ranking-v2.1 TEST COHORT from the
// offline extract. Writes the filter definition, counts, and a Composer-ready
// spec (explicit property_id list + the screener expression it came from).
// Nothing is written to the database. Eligibility is re-checked by the
// Composer's own gates at build time (the extract is a snapshot).
//
//   node --import ./tests/register-aliases.mjs scripts/acq-os/ranking-v2-1-test-cohort.mjs --data=<dir> --out=<file.json>
import fs from 'node:fs'
import path from 'node:path'
import { buildRawFactsFromRows, scoreSellerSituation } from '@/lib/acquisition/seller-situation/index.js'
import { annotatePhoneOwnerCounts, computeCampaignRankV2 } from '@/lib/domain/campaigns/ranking-v2/campaign-rank-v2.js'
import { computeMarketQuality, marketQualityForRow } from '@/lib/domain/campaigns/ranking-v2/market-quality.js'
import { equityEvidence } from '@/lib/domain/campaigns/ranking-v2/contact-evidence.js'
import { rankDiscoveryZips } from '@/lib/domain/campaigns/ranking-v2/campaign-discovery.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const DATA = args.data
const OUT = args.out || path.join(DATA, '..', 'test-cohort.json')
const NOW = new Date(args.now || '2026-10-07T05:00:00Z')
const MIN = 310 // owner decision 10-07: 310 vs 310
const MAX = 310

function parseCSV(text) { const rows = []; let row = []; let f = ''; let q = false; for (let i = 0; i < text.length; i += 1) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 1 } else q = false } else f += c } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = '' } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' } else if (c !== '\r') f += c } if (f.length || row.length) { row.push(f); rows.push(row) } return rows }
const load = (n) => { const r = parseCSV(fs.readFileSync(path.join(DATA, n), 'utf8')); const h = r.shift(); return r.filter((x) => x.length === h.length).map((x) => Object.fromEntries(h.map((k, i) => [k, x[i] === '' ? null : x[i]]))) }
const jsonl = (n) => fs.readFileSync(path.join(DATA, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const bool = (v) => (v === 't' ? true : v === 'f' ? false : v)

const SCOPE = new Set(['Dallas, TX', 'Houston, TX'])
const graph = []
for (const f of fs.readdirSync(DATA).filter((f) => /^graph_\d+\.csv$/.test(f)).sort()) for (const r of load(f)) {
  if (!SCOPE.has(r.market)) continue
  for (const k of ['tax_delinquent', 'active_lien', 'out_of_state_owner', 'is_corporate_owner', 'sms_eligible', 'queue_eligible', 'never_contacted', 'true_post_contact_suppression', 'pending_prior_touch', 'wrong_number']) r[k] = bool(r[k])
  graph.push(r)
}
const phone = new Map(load('graph_phone.csv').map((r) => [r.property_id, r.canonical_e164]))
const allPhones = load('graph_phone.csv')
const keys = JSON.parse(fs.readFileSync(path.join(DATA, 'person_keys.json'), 'utf8'))
const flags = new Map(); for (const p of jsonl('prospects.jsonl')) if (p.matching_flags && !flags.has(p.individual_key)) flags.set(p.individual_key, p.matching_flags)
const features = new Map(jsonl('raw_features.jsonl').map((r) => [String(r.property_id), r]))
const properties = new Map(jsonl('raw_properties.jsonl').map((r) => [String(r.property_id), r]))
// shared phone counted over the WHOLE graph's phones (owner ids from the full extract)
const ownersByPhone = new Map()
{
  const owner = new Map()
  for (const f of fs.readdirSync(DATA).filter((f) => /^graph_\d+\.csv$/.test(f))) for (const r of load(f)) owner.set(r.property_id, r.master_owner_id)
  for (const r of allPhones) { if (!r.canonical_e164) continue; if (!ownersByPhone.has(r.canonical_e164)) ownersByPhone.set(r.canonical_e164, new Set()); ownersByPhone.get(r.canonical_e164).add(owner.get(r.property_id)) }
}
for (const r of graph) { r.canonical_e164 = phone.get(r.property_id) || null; r.seller_person_key = keys[r.property_id] || null; r.matching_flags = r.seller_person_key ? flags.get(r.seller_person_key) ?? null : null; r.phone_owner_count = r.canonical_e164 ? ownersByPhone.get(r.canonical_e164)?.size ?? null : null }

const cutoff = new Date(NOW.getTime() - 3 * 365.25 * 86400000).toISOString().slice(0, 10)
const bs = new Map(); for (const b of load('mi_buyers.csv')) { if (b.is_investor !== 't' || b.sold_on < cutoff) continue; const u = Number(b.units); const lane = u >= 5 ? 'mf_5_plus' : u >= 2 ? 'mf_2_4' : 'sfr'; for (const k of [`${b.zip}|${lane}`, `${b.zip}|all`]) { if (!bs.has(k)) bs.set(k, new Set()); bs.get(k).add(b.buyer_h) } }
const markets = new Map(); for (const r of load('mi_zip.csv').filter((x) => x.geo_level === 'zip' && x.period === '1y')) markets.set(`${r.geo_key}|${r.asset}`, computeMarketQuality({ zip: r.geo_key, asset: r.asset, qualified_sales_1y: r.qualified_sale_count, investor_purchases_1y: r.investor_count, buyer_known_1y: r.buyer_known_count, distinct_investor_buyers_36m: bs.get(`${r.geo_key}|${r.asset}`)?.size ?? 0 }))

const ctx = graph.map((row) => {
  const p = properties.get(row.property_id)
  const situation = p ? scoreSellerSituation(buildRawFactsFromRows({ property: p, features: features.get(row.property_id) ?? null }), { now: NOW }) : null
  const market = marketQualityForRow(row, markets)
  return { situation, market, rank: computeCampaignRankV2(row, { situation, market, includeWhy: true }) }
})

// ── the cohort definition (frozen) ──
const DEFINITION = {
  name: 'v2.1 test cohort — right person × stacked pressure × liquid ZIP (Dallas/Houston SFR)',
  layer0_eligibility: ['queue_eligible = true', 'sms_eligible = true', 'true_post_contact_suppression = false', 'wrong_number = false', 'pending_prior_touch = false', 'never_contacted = true (no first touch on the property)'],
  layer1_contact: ["phone_type = 'W' (mobile)", "identity tier ∈ {strongest, strong}: verified + Likely Owner/Linked To Company tag · verified + no tag (absence ≠ negative) · probable + positive tag · entity_company_linked + Linked To Company (entity-owned)", 'match tag ≠ Resident/Likely Renting-only', 'phone not shared by >1 master owner (whole graph)'],
  layer2_pressure: ['seller_situation_v2 opportunity_tier ∈ {A, B}'],
  layer3_deal: ['equity class ≠ low (known % ≥ 40, or vendor High Equity class); unknown allowed and counted'],
  layer4_market: ['ZIP market_quality buyer_depth ≥ 65 (≥ ~8 distinct investor buyers / 36 m)'],
  asset: ['property_type Single Family'],
  zip_selection: 'ZIPs ordered by eligible-cohort count; added until the cohort reaches ≥ 300; capped at 500 by v2.1 priority',
  screener_expression: { all: [
    { m: 'market', op: 'in', v: ['Dallas, TX', 'Houston, TX'] }, { m: 'property_type', op: 'eq', v: 'Single Family' },
    { m: 'queue_eligible', op: 'is_true' }, { m: 'sms_eligible', op: 'is_true' }, { m: 'days_since_outbound', op: 'gte', v: 100000 },
    { m: 'mobile_reachable', op: 'is_true' }, { m: 'opportunity_tier', op: 'in', v: ['A', 'B'] },
    { m: 'identity_alignment', op: 'in', v: ['verified', 'probable', 'entity_company_linked'] }, { any: [{ m: 'matching_tag', op: 'in', v: ['likely_owner', 'linked_to_company'] }, { m: 'matching_tag', op: 'unknown' }] },
    { m: 'equity_class', op: 'in', v: ['high', 'unknown'] }, { m: 'buyer_depth', op: 'gte', v: 65 },
  ] },
}
function passes(row, c) {
  if (!(row.queue_eligible && row.sms_eligible && !row.true_post_contact_suppression && !row.wrong_number && !row.pending_prior_touch && row.never_contacted)) return 'L0'
  if (!/single family/i.test(row.property_type || '')) return 'asset'
  const L = c.rank.layers.contact
  if (L.line !== 'W') return 'L1_line'
  if (L.identity_tier !== 'strongest' && L.identity_tier !== 'strong') return 'L1_identity_tier'
  if ((row.phone_owner_count ?? 1) > 1) return 'L1_shared_phone'
  const t = c.situation?.opportunity_tier
  if (t !== 'A' && t !== 'B') return 'L2_tier'
  if (equityEvidence(row).class === 'low') return 'L3_equity_low'
  if ((c.market?.terms?.buyer_depth ?? -1) < 65) return 'L4_buyer_depth'
  return null
}
const funnel = {}
const eligible = []
graph.forEach((row, i) => { const r = passes(row, ctx[i]); funnel[r || 'pass'] = (funnel[r || 'pass'] || 0) + 1; if (!r) eligible.push({ row, c: ctx[i] }) })
const byZip = new Map(); for (const e of eligible) { const z = String(e.row.property_zip).slice(0, 5); if (!byZip.has(z)) byZip.set(z, []); byZip.get(z).push(e) }
const discovery = rankDiscoveryZips(graph, ctx, { limit: 40 })
const discRank = new Map(discovery.zips.map((z, i) => [z.zip, i]))
const zipOrder = [...byZip.entries()].sort((a, b) => b[1].length - a[1].length || (discRank.get(a[0]) ?? 99) - (discRank.get(b[0]) ?? 99))
const chosenZips = []; let pool = []
for (const [z, list] of zipOrder) { if (pool.length >= MIN) break; chosenZips.push(z); pool = pool.concat(list) }
pool.sort((a, b) => b.c.rank.score - a.c.rank.score || String(a.row.property_id).localeCompare(String(b.row.property_id)))
const cohort = pool.slice(0, MAX)
// ── CONTROL ARM + COUNTERFACTUAL: the OLD broad tired-landlord targeting ──
// Old method = campaign A's ACTUAL saved filter (campaigns.metadata.target_filters:
// properties.market ∈ {…} AND property_type = Single Family — no tired-landlord
// field; "tired landlord" was the angle/template, and every one of A's 2,689
// targets carried the DealMachine "Tired Landlord" flag), the same Layer-0
// eligibility, ordered by legacy final_acquisition_score desc, id asc (the
// production SQL order). No contact / pressure / equity / buyer-depth filter.
// Applied to the EXACT same ZIPs. TL-flag share is reported.
const testIds = new Set(cohort.map((e) => e.row.property_id))
const zipSet = new Set(cohort.map((e) => String(e.row.property_zip).slice(0, 5)))
const oldEligible = graph.map((row, i) => ({ row, c: ctx[i] })).filter(({ row }) =>
  zipSet.has(String(row.property_zip).slice(0, 5)) && /single family/i.test(row.property_type || '') &&
  row.queue_eligible && row.sms_eligible && !row.true_post_contact_suppression && !row.wrong_number && !row.pending_prior_touch && row.never_contacted)
const legacyOrder = (a, b) => { const la = a.row.acquisition_score === null ? null : Number(a.row.acquisition_score); const lb = b.row.acquisition_score === null ? null : Number(b.row.acquisition_score); if (la !== lb) { if (la === null) return 1; if (lb === null) return -1; return lb - la } return String(a.row.property_id).localeCompare(String(b.row.property_id)) }
oldEligible.sort(legacyOrder)
const counterfactual = oldEligible.slice(0, cohort.length) // what the old method would have picked, no exclusion
// control: per-ZIP matched to the test arm's ZIP counts, test members excluded
const testByZip = {}
for (const e of cohort) { const z = String(e.row.property_zip).slice(0, 5); testByZip[z] = (testByZip[z] || 0) + 1 }
const oldPool = oldEligible.filter((e) => !testIds.has(e.row.property_id))
const control = []
const used = new Set()
for (const [z, k] of Object.entries(testByZip)) { const inZip = oldPool.filter((e) => String(e.row.property_zip).slice(0, 5) === z).slice(0, k); for (const e of inZip) { control.push(e); used.add(e.row.property_id) } }
const shortfall = cohort.length - control.length
for (const e of oldPool) { if (control.length >= cohort.length) break; if (!used.has(e.row.property_id)) { control.push(e); used.add(e.row.property_id) } }
function mix(list) {
  const m = { n: list.length, tired_landlord_flag: list.filter((e) => /tired landlord/i.test(e.row.property_flags_text || '')).length, tier: {}, identity_tier: {}, contact_confidence: {}, line: {}, equity_class: {}, buyer_depth_strong: 0, situation: {}, legacy_score_median: null, priority_v2_1_median: null }
  const inc = (o, k) => { o[k] = (o[k] || 0) + 1 }
  const leg = []; const pri = []
  for (const e of list) {
    inc(m.tier, e.c.situation?.opportunity_tier ?? 'UNKNOWN')
    inc(m.identity_tier, e.c.rank.layers.contact.identity_tier)
    inc(m.contact_confidence, e.c.rank.contact_score >= 75 ? 'high' : e.c.rank.contact_score >= 50 ? 'medium' : 'low')
    inc(m.line, e.c.rank.layers.contact.line)
    inc(m.equity_class, equityEvidence(e.row).class)
    inc(m.situation, e.c.situation?.seller_situation ?? 'none')
    if ((e.c.market?.terms?.buyer_depth ?? -1) >= 65) m.buyer_depth_strong += 1
    if (e.row.acquisition_score !== null) leg.push(Number(e.row.acquisition_score))
    pri.push(e.c.rank.score)
  }
  const med = (v) => { const x = v.sort((a, b) => a - b); return x.length ? x[x.length >> 1] : null }
  m.legacy_score_median = med(leg); m.priority_v2_1_median = med(pri)
  return m
}
// ── INTERLEAVE SCHEDULE SPEC ──
// Matched pairs by ZIP (test_i ↔ control_i in the same ZIP, seeded shuffle),
// counterbalanced ABBA within each pair stream so neither arm is always first.
// Both arms: same template, same sender pool, same send window, equal daily
// cap; a pair is sent from the same sender within the same 15-minute block.
function seeded(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296 } }
const rnd = seeded(20261007)
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]] } return b }
const pairs = []
const ctrlByZip = {}
for (const e of control) { const z = String(e.row.property_zip).slice(0, 5); (ctrlByZip[z] ||= []).push(e) }
const testZip = {}
for (const e of cohort) { const z = String(e.row.property_zip).slice(0, 5); (testZip[z] ||= []).push(e) }
const leftovers = []
for (const z of Object.keys(testZip).sort()) { const T = shuffle(testZip[z]); const C = shuffle(ctrlByZip[z] || []); T.forEach((t, i) => { if (C[i]) pairs.push({ zip: z, test: t.row.property_id, control: C[i].row.property_id }); else leftovers.push({ zip: z, test: t.row.property_id }) }); for (const c of C.slice(T.length)) leftovers.push({ zip: z, control: c.row.property_id }) }
const unpairedControl = leftovers.filter((l) => l.control).map((l) => l.control)
for (const l of leftovers.filter((l) => l.test)) { const c = unpairedControl.shift(); if (c) pairs.push({ zip: l.zip, test: l.test, control: c, cross_zip: true }) }
const orderedPairs = shuffle(pairs)
const DAILY_PER_ARM = Number(args.daily || 50)
const schedule = orderedPairs.map((p, i) => ({ pair: i + 1, day: Math.floor(i / DAILY_PER_ARM) + 1, block_15m: Math.floor((i % DAILY_PER_ARM) / 2) + 1, first: i % 4 === 0 || i % 4 === 3 ? 'test' : 'control', ...p }))
const PREREG = {
  registered_at: new Date().toISOString(),
  design: 'two-arm, ZIP-matched, interleaved; test = v2.1 selection; control = old broad tired-landlord selection in the same ZIPs',
  unit: 'property (first delivered opener); outcomes attributed by property, first-touch campaign',
  primary: [
    { id: 'P1', metric: 'owner reached per delivered (delivered → owner)', test: 'two-proportion difference test − control, Newcombe hybrid-score 95% CI', win: 'lower bound > 0' },
    { id: 'P2', metric: 'interested per delivered (delivered → interested)', test: 'same', win: 'lower bound > 0 (secondary to P1 for the decision)' },
  ],
  secondary: ['replied per delivered', 'price obtained per delivered', 'realistic price per delivered', 'negotiation per delivered', 'contracts per 1,000 delivered (north star, descriptive)', 'profitable deals per 1,000 delivered (descriptive)'],
  guardrails: [{ metric: 'opt-out per delivered', stop_if: 'test − control lower bound > +5 pp at ≥72h' }, { metric: 'hostile per delivered', stop_if: 'test − control lower bound > +3 pp at ≥72h' }, 'wrong-number per delivered (reported)'],
  checkpoints: ['24h', '72h', '7d', '14d', '21d'],
  decision_at: '21d after the LAST opener of either arm (earlier checkpoints are informational; only guardrails can stop early)',
  minimum_n: '≥ 250 delivered per arm for the 21d read (else extend sends, never re-pick the cohort)',
  power_note: '310 delivered/arm at α=.05 gives 80% power for owner-reached 2.2% → 6.6% (≈3×); smaller lifts will read as inconclusive',
  contamination_checks: ['send-hour distribution by arm', 'sender id distribution by arm', 'template id by arm', 'delivery rate by arm'],
  no_peeking_rule: 'cohort membership and arms are frozen in this file; never re-select after launch',
}
const count = (f) => { const m = {}; for (const e of cohort) { const k = f(e); m[k] = (m[k] || 0) + 1 } return m }
const result = {
  generated_at: new Date().toISOString(),
  extract_as_of: '2026-10-07T04:24Z (offline keyset extract; re-verify at build)',
  definition: DEFINITION,
  scope_rows: graph.length,
  exclusion_funnel: funnel,
  eligible_in_scope: eligible.length,
  chosen_zips: chosenZips,
  cohort_size: cohort.length,
  by_zip: count((e) => String(e.row.property_zip).slice(0, 5)),
  by_tier: count((e) => e.c.situation.opportunity_tier),
  by_contact: count((e) => `${e.c.rank.layers.contact.identity}/${e.c.rank.layers.contact.tag}`),
  by_contact_confidence: count((e) => (e.c.rank.contact_score >= 75 ? 'high' : e.c.rank.contact_score >= 50 ? 'medium' : 'low')),
  by_equity_class: count((e) => equityEvidence(e.row).class),
  by_situation: count((e) => e.c.situation.seller_situation),
  priority: { min: cohort.length ? cohort[cohort.length - 1].c.rank.score : null, max: cohort.length ? cohort[0].c.rank.score : null },
  examples: cohort.slice(0, 8).map((e) => ({ property_id: e.row.property_id, zip: String(e.row.property_zip).slice(0, 5), tier: e.c.situation.opportunity_tier, priority: e.c.rank.score, layers: { contact: e.c.rank.layers.contact.score, pressure: e.c.rank.layers.pressure.effective, deal: e.c.rank.layers.deal.score, market: e.c.rank.layers.market.score }, why: e.c.rank.why.map((w) => w.label) })),
  control_arm: { size: control.length, zip_matched_shortfall_filled_from_same_zips: shortfall, selection: "campaign A's actual filter (market + Single Family) in the same ZIPs + same Layer-0 eligibility, legacy final_acquisition_score order, test members excluded, per-ZIP counts matched to the test arm" },
  counterfactual_old_selection_same_zips: { size: counterfactual.length, overlap_with_test_arm: counterfactual.filter((e) => testIds.has(e.row.property_id)).length, eligible_old_pool: oldEligible.length },
  mix: { test: mix(cohort), control: mix(control), counterfactual_old: mix(counterfactual) },
  interleave: { daily_per_arm: DAILY_PER_ARM, days: Math.ceil(orderedPairs.length / DAILY_PER_ARM), pairs: orderedPairs.length, cross_zip_pairs: pairs.filter((p) => p.cross_zip).length, rules: ['same template (ownership_check S1, the approved English/Spanish variants by canonical language)', 'same sender pool (Dallas + Houston approved pools); pair members from the same sender, same 15-minute block', 'same send window (recipient-local 8am–9pm policy)', 'equal daily cap per arm', 'ABBA counterbalancing of which arm goes first in a pair'], launch_reality: 'Composer launches campaigns, not pairs: create TWO drafts (test / control) with identical settings and launch them in the same minute; the 24h checkpoint verifies hour/sender/template balance and flags contamination', schedule },
  preregistration: PREREG,
  arms: { test: cohort.map((e) => e.row.property_id), control: control.map((e) => e.row.property_id) },
  composer_spec_control: {
    note: 'CONTROL arm draft (owner saves + launches; nothing saved here).',
    name: 'TEST v2.1 · CONTROL · broad tired landlord, same ZIPs (DRAFT — do not launch alone)',
    template_use_case: 'ownership_check',
    filters: { properties: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: control.map((e) => e.row.property_id) }] },
  },
  composer_spec: {
    note: 'Composer-ready composition (save as a DRAFT from the Composer only after owner approval; nothing saved here). Explicit property list because tier / match tag are not graph columns until the PROPOSED projection lands.',
    name: 'TEST v2.1 · Dallas/Houston SFR · right-person × stacked pressure (DRAFT — do not launch)',
    template_use_case: 'ownership_check',
    filters: { properties: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: cohort.map((e) => e.row.property_id) }] },
  },
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ out: OUT, scope: graph.length, eligible: eligible.length, zips: chosenZips, cohort: cohort.length, by_tier: result.by_tier, funnel }))
