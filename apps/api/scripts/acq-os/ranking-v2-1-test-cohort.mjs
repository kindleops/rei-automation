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
const MIN = 300
const MAX = 500

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
  layer1_contact: ["phone_type = 'W' (mobile)", "identity verified AND match tag ∈ {Likely Owner, not recorded}  — OR —  identity probable AND tag Likely Owner  — OR —  identity entity_company_linked AND tag Linked To Company (entity-owned)", 'match tag ≠ Resident/Likely Renting-only', 'phone not shared by >1 master owner (whole graph)'],
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
  const ok = (L.identity === 'verified' && (L.tag === 'likely_owner' || L.tag === 'missing'))
    || (L.identity === 'probable' && L.tag === 'likely_owner')
    || (L.identity === 'entity_company_linked' && L.tag === 'linked_to_company')
  if (!ok) return 'L1_identity_tag'
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
  composer_spec: {
    note: 'Composer-ready composition (save as a DRAFT from the Composer only after owner approval; nothing saved here). Explicit property list because tier / match tag are not graph columns until the PROPOSED projection lands.',
    name: 'TEST v2.1 · Dallas/Houston SFR · right-person × stacked pressure (DRAFT — do not launch)',
    template_use_case: 'ownership_check',
    filters: { properties: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: cohort.map((e) => e.row.property_id) }] },
  },
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ out: OUT, scope: graph.length, eligible: eligible.length, zips: chosenZips, cohort: cohort.length, by_tier: result.by_tier, funnel }))
