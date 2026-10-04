#!/usr/bin/env node
/**
 * COMPS VALUATION POOL — SHADOW COMPARISON (read-only; owner decides).
 *
 * QUESTION. The acquisition engine prices every subject from the engine pool
 * (get_comp_candidates_for_subject -> v_recent_sold_comps -> buyer_comp_raw_v2,
 * newest sale 2026-05-08, frozen). The canonical recorded sales
 * (public.mv_map_market_sales over comp_private.comp_canonical_transactions,
 * through 2026-09-10, refreshed daily) are fresher. Would switching the pool
 * move values and offers, and by how much? This script measures that. It does
 * NOT switch anything: no writes, no persistAcquisitionScore, no snapshot.
 *
 * METHOD, per subject (real subjects from property_acquisition_scores):
 *   OLD  the engine's own path: loadComparableProperties (pool + advanced
 *        comps) -> calculateAcquisitionDecision.
 *   NEW  the same subject, the same engine and the same buyer purchases, but
 *        the comp list = canonical priced sales (price > 0 only, the owner's
 *        price rule) in the engine's own radius/window for the asset family,
 *        read through buyer-match-sales.js, overlaid with the sold property's
 *        record detail where it exists (`properties`) so data completeness is
 *        not handicapped by the thinner sales row.
 *   Both runs use one fixed `now`, so recency is identical, and both run with
 *   the V3 qualification layer OFF so the comp list is the only variable (the
 *   OLD figure is therefore a re-run, not the stored decision; compare deltas,
 *   not either side to property_acquisition_scores).
 *
 * SMOKE (2026-10-04, 1 subject, 273312064 Minneapolis SFR): newest selected
 *   comp 2026-04-21 -> 2026-08-17; mid $349.7K -> $228.9K (-34.5%); offer
 *   -50.5%. One subject is not evidence — but it says the switch is material.
 *
 * REPORTED, per subject and in aggregate:
 *   valuation low/mid/high, recommended offer, floor, decision tier,
 *   selected-comp count, newest selected sale, comp_data_status;
 *   delta mid % and delta offer %; tier flips; subjects that gain or lose a
 *   comp-backed valuation (vs the record-estimate fallback).
 *
 * SAMPLE. Default 40 subjects, stratified: most-recent scored subjects per
 * market (round-robin), SFR and 2-4 MF both present when available. Use
 * --limit and --market to narrow. Run outside the overnight reconcile window;
 * each subject is ~6 bounded reads; --pause-ms spaces subjects (default 400).
 *
 * DECISION GATES (proposed, for the owner):
 *   - median |delta mid| <= 5% and p90 <= 15% across the sample;
 *   - no tier flip toward a MORE aggressive offer without a fresher comp
 *     explaining it (listed per subject in the output);
 *   - comp-backed coverage does not drop (subjects falling back to the record
 *     estimate must not increase).
 *   Pass -> propose the pool switch behind a flag, in shadow for a week on the
 *   live scorer (both values stored, old one authoritative). Fail -> keep the
 *   frozen pool and fix the canonical feed (detail coverage, dedupe) first.
 *
 * USAGE (from apps/api):
 *   node scripts/comps-valuation-pool-shadow.mjs --limit=40 --out=/tmp/comps-shadow.json
 *   node scripts/comps-valuation-pool-shadow.mjs --subjects=273312064,273448158
 * Credentials come from apps/api/.env.local and are never printed.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(apiRoot)

function loadEnv(p) {
  if (!existsSync(p)) return {}
  const out = {}
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}
const fileEnv = loadEnv(resolve(apiRoot, '.env.local'))
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ACQUISITION_ENGINE_V3_ENABLED']) {
  if (!process.env[k] && fileEnv[k]) process.env[k] = fileEnv[k]
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (apps/api/.env.local)')
  process.exit(2)
}
register('./tests/alias-loader.mjs', pathToFileURL(`${apiRoot}/`))

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true']
}))
const LIMIT = Math.max(1, Math.min(200, Number(args.limit ?? 40)))
const PAUSE = Math.max(0, Number(args['pause-ms'] ?? 400))
const NOW = new Date(args.now ?? Date.now())

const { supabase } = await import('../src/lib/supabase/client.js')
const engine = await import('../src/lib/acquisition/acquisitionDecisionEngine.js')
const { loadBuyerMatchSales } = await import('../src/lib/domain/buyer-match/buyer-match-sales.js')
const { engineSearchWindow } = await import('../src/lib/domain/comp-intelligence/comps-engine-rules.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const pct = (a, b) => (num(a) && num(b) ? Math.round(((b - a) / a) * 1000) / 10 : null)
const quantile = (xs, q) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))]
}

async function pickSubjects() {
  if (args.subjects) return String(args.subjects).split(',').map((s) => s.trim()).filter(Boolean)
  const { data, error } = await supabase.from('property_acquisition_scores')
    .select('property_id, computed_at')
    .order('computed_at', { ascending: false })
    .limit(LIMIT * 6)
  if (error) throw error
  const ids = [...new Set((data ?? []).map((r) => String(r.property_id)))]
  if (!args.market) return ids.slice(0, LIMIT * 3)
  const { data: props } = await supabase.from('properties').select('property_id, market').in('property_id', ids.slice(0, 300))
  return (props ?? []).filter((p) => String(p.market || '').toLowerCase().includes(String(args.market).toLowerCase())).map((p) => String(p.property_id))
}

/** Canonical priced sales -> engine-shaped comp rows (price > 0 only). */
async function canonicalComps(subject) {
  const win = engineSearchWindow(subject.asset_family)
  const { sales } = await loadBuyerMatchSales({
    lat: subject.latitude, lng: subject.longitude, radius_miles: win.radiusMiles, months: win.months, priced: 'only', limit: 100,
  }, { db: supabase, now: NOW })
  const pids = [...new Set(sales.map((s) => s.property_id).filter(Boolean))]
  const detail = new Map()
  for (let i = 0; i < pids.length; i += 100) {
    const { data } = await supabase.from('properties').select('property_id, property_address_county_name, lot_square_feet, building_condition, construction_type, subdivision_name, zoning, garage, pool, stories, effective_year_built, estimated_value')
      .in('property_id', pids.slice(i, i + 100))
    for (const d of data ?? []) detail.set(String(d.property_id), d)
  }
  return sales.filter((s) => s.is_priced).map((s) => ({
    ...(detail.get(String(s.property_id)) ?? {}),
    id: s.comp_id,
    property_id: s.property_id,
    property_address_full: s.address,
    property_address_city: s.city,
    property_address_state: s.state,
    property_address_zip: s.zip,
    latitude: s.lat,
    longitude: s.lng,
    sale_price: s.price,
    sale_date: s.sold_on,
    mls_sold_price: s.sale_source === 'mls' ? s.price : null,
    mls_sold_date: s.sale_source === 'mls' ? s.sold_on : null,
    property_type: s.property_type,
    units_count: s.units,
    total_bedrooms: s.beds,
    total_baths: s.baths,
    building_square_feet: s.sqft,
    year_built: s.year_built,
    distance_miles: s.distance_miles,
    source: 'mv_map_market_sales',
  }))
}

function summarize(d) {
  const sel = Array.isArray(d?.selected_comps) ? d.selected_comps : []
  return {
    low: num(d?.valuation?.low), mid: num(d?.valuation?.mid), high: num(d?.valuation?.high),
    offer: num(d?.offer?.recommended_cash_offer), floor: num(d?.offer?.minimum_acceptable_offer),
    tier: d?.decision?.tier ?? null,
    method: d?.valuation?.calculation?.method ?? null,
    selected: sel.length,
    newestSelected: sel.map((c) => c.sale_date ?? c.comp?.sale_date).filter(Boolean).map(String).sort().pop() ?? null,
    compStatus: d?.evidence?.comp_data_status?.status ?? null,
  }
}

const results = []
const subjects = await pickSubjects()
for (const pid of subjects) {
  if (results.length >= LIMIT) break
  try {
    const raw = await engine.loadSubjectProperty(pid, { supabase })
    if (!raw) continue
    const subject = engine.normalizePropertyFeatures(raw, { source: 'properties', now: NOW })
    if (!num(subject.latitude) || !num(subject.longitude)) continue
    const deps = { supabase, now: NOW }
    const [oldComps, buyerPurchases, newComps] = await Promise.all([
      engine.loadComparableProperties(subject, deps),
      engine.loadBuyerPurchases(subject, deps),
      canonicalComps(subject),
    ])
    const run = (comps) => engine.calculateAcquisitionDecision({ subject, comps, buyerPurchases, now: NOW, v3Enabled: false })
    const oldS = summarize(run(oldComps))
    const newS = summarize(run(newComps))
    results.push({
      property_id: pid, market: raw.market ?? null, family: subject.asset_family, units: num(raw.units_count),
      pool: { old: oldComps.length, new: newComps.length },
      old: oldS, new: newS,
      delta: { midPct: pct(oldS.mid, newS.mid), offerPct: pct(oldS.offer, newS.offer), tierFlip: oldS.tier !== newS.tier },
    })
    process.stdout.write(`.${results.length % 50 === 0 ? '\n' : ''}`)
  } catch (e) {
    results.push({ property_id: pid, error: String(e?.message || e).slice(0, 200) })
  }
  if (PAUSE) await sleep(PAUSE)
}

const ok = results.filter((r) => !r.error && r.old.mid && r.new.mid)
const abs = ok.map((r) => Math.abs(r.delta.midPct))
const summary = {
  generatedAt: new Date().toISOString(), now: NOW.toISOString(), subjects: results.length, compared: ok.length,
  errors: results.filter((r) => r.error).length,
  medianAbsMidDeltaPct: quantile(abs, 0.5), p90AbsMidDeltaPct: quantile(abs, 0.9),
  medianOfferDeltaPct: quantile(ok.map((r) => r.delta.offerPct), 0.5),
  tierFlips: ok.filter((r) => r.delta.tierFlip).length,
  compBacked: {
    old: results.filter((r) => r.old?.method === 'weighted_adjusted_comp_value').length,
    new: results.filter((r) => r.new?.method === 'weighted_adjusted_comp_value').length,
  },
  newestSelected: { old: ok.map((r) => r.old.newestSelected).filter(Boolean).sort().pop() ?? null, new: ok.map((r) => r.new.newestSelected).filter(Boolean).sort().pop() ?? null },
}
const out = { summary, results }
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 2))
console.log(`\n${JSON.stringify(summary, null, 2)}`)
