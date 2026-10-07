/**
 * ACQUISITION ENGINE V3 — MERGED (V3 structure + v3.1 corpus / comp rules / offer).
 * Contracts:
 *   1. Flags OFF: production output is byte-identical (pin) and carries no V3 keys.
 *   2. SHADOW (default whenever V3 is enabled): V2 owns every live field; V3 goes
 *      to evidence.v3_shadow ONLY (evidence.v3 stays null); scoreProperty persists
 *      the V2 row unchanged. LIVE requires ENABLED + ALLOW_PERSIST + SHADOW_MODE=false
 *      + owner cutover market and lane.
 *   3. Parity: the merged investor universe equals the frozen v3.1 oracle.
 *   4. Offer: as-is value, no repair / end-buyer cost subtraction, calibration,
 *      confidence haircut, margin-policy fee bands; flat-rate repairs are low
 *      confidence; identity conflicts and 2-4 units go to REVIEW.
 *   5. getAuthoritativeOffer: prod v2 today; merged only from a live block in a
 *      still-cut-over market; shadow is never money.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { calculateAcquisitionDecision, normalizePropertyFeatures, scoreProperty } from '../../src/lib/acquisition/acquisitionDecisionEngine.js'
import { valueSubjectV3, computeOfferV3 } from '../../src/lib/acquisition/shadow/investorValuationV3.js'
import { valueInvestorUniverse, INVESTOR_RULES_SFR } from '../../src/lib/acquisition/investorCompRules.js'
import { buildCashOfferMerged, MERGED_OFFER_POLICY } from '../../src/lib/acquisition/offerEconomics.js'
import { estimateRepairs } from '../../src/lib/acquisition/repairModel.js'
import { resolveV3Authority, subjectOfferLane } from '../../src/lib/acquisition/v3Authority.js'
import { assembleCanonicalCandidates, investorSubjectFrom, loadV3MergedCandidates } from '../../src/lib/acquisition/v3CanonicalCandidates.js'
import { applyMergedGates, MERGED_ENGINE_VERSION } from '../../src/lib/acquisition/v3DecisionPipeline.js'
import { authoritativeOfferFromScore, getAuthoritativeOffer, perUnitOf } from '../../src/lib/acquisition/offerAuthority.js'

const V3_ENV_KEYS = ['ACQUISITION_ENGINE_V3_ENABLED', 'ACQUISITION_ENGINE_V3_SHADOW_MODE', 'ACQUISITION_ENGINE_V3_ALLOW_PERSIST', 'ACQUISITION_ENGINE_V3_CUTOVER_MARKETS', 'ACQUISITION_ENGINE_V3_CUTOVER_LANES']
function withEnv(vars, fn) {
  const saved = Object.fromEntries(V3_ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of V3_ENV_KEYS) delete process.env[k]
  Object.assign(process.env, vars)
  try { return fn() } finally {
    for (const k of V3_ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}
async function withEnvAsync(vars, fn) {
  const saved = Object.fromEntries(V3_ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of V3_ENV_KEYS) delete process.env[k]
  Object.assign(process.env, vars)
  try { return await fn() } finally {
    for (const k of V3_ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

// ── fixtures: a Dallas SFR subject and canonical corpus rows around it ──
const NOW = new Date('2026-09-01T00:00:00Z')
const AS_OF = '2026-09-02'
const LAT = 32.9
const LNG = -96.7
const rawSubject = {
  property_id: 'S1', property_type: 'Single Family', units_count: 1, total_bedrooms: 3, total_baths: 2,
  building_square_feet: 1400, year_built: 1965, latitude: LAT, longitude: LNG, property_address_zip: '75238',
  estimated_value: 175000, estimated_repair_cost: 49000, market: 'Dallas, TX', building_condition: 'Average',
  situs_census_tract: '19033', subdivision_name: 'SKILLMAN FOREST 1', property_address_county_name: 'Dallas', lot_square_feet: 7000,
}
const dLat = (miles) => LAT + miles / 69.0
let seq = 0
const sale = (o = {}) => {
  seq += 1
  return {
    comp_id: `t:${seq}`, source: 'public_record', sold_on: '2026-07-01', price: 160000, lat: dLat(o.miles ?? 0.2), lng: LNG,
    property_id: `P${seq}`, address: `${seq} Main St`, city: 'Dallas', state: 'TX', zip: '75238', property_type: 'Single Family',
    beds: 3, baths: 2, sqft: 1400, year_built: 1964, units: 1, portfolio_size: 1, buyer_class: 'llc_investor', is_investor: true,
    buyer: null, doc_type: 'Warranty Deed', is_cash_purchase: null, is_arms_length: true, subdivision_name: 'SKILLMAN FOREST 1',
    census_tract: '019033', fips: '48113', estimated_repair_cost: 49000, lot_sqft: 7000, estimated_value: 170000, owner_linked: false, ...o,
  }
}
const rows = () => {
  seq = 0
  return [
    sale({ price: 158000, miles: 0.1 }), sale({ price: 165000, miles: 0.2, sold_on: '2026-06-01' }), sale({ price: 171000, miles: 0.3 }),
    sale({ price: 162000, miles: 0.4, sold_on: '2026-05-10' }), sale({ price: 168000, miles: 0.25 }), sale({ price: 175000, miles: 0.5, sold_on: '2026-04-01' }),
    sale({ price: 230000, miles: 0.3, source: 'mls', buyer_class: 'unknown', is_investor: false }),
    sale({ price: 225000, miles: 0.35, source: 'mls', buyer_class: 'unknown', is_investor: false }),
    sale({ price: 235000, miles: 0.45, source: 'mls', buyer_class: 'unknown', is_investor: false }),
    sale({ price: 30000, miles: 0.2, doc_type: 'Trustee Deed' }),
    sale({ price: 400000, miles: 3.1 }),
  ]
}
const neighbors = [{ fips: '48113', county_name: 'Dallas', census_tract: '019033', subdivision_name: 'SKILLMAN FOREST 1', miles: 0.005 }]
const subjectN = () => normalizePropertyFeatures(rawSubject, { source: 'properties', now: NOW })
const assembled = () => {
  const subject = subjectN()
  const investorSubject = investorSubjectFrom({ subject, raw: rawSubject, own: null, neighbors })
  return { subject, investorSubject, ...assembleCanonicalCandidates({ rows: rows(), subject, investorSubject, asOf: AS_OF }) }
}
const v2Comps = [
  ['c1', 160000, '2026-08-01', 1450, 0.3], ['c2', 165000, '2026-07-15', 1350, 0.5], ['c3', 170000, '2026-06-20', 1500, 0.8],
  ['c4', 158000, '2026-05-30', 1400, 1.1], ['c5', 166000, '2026-04-10', 1420, 1.4],
].map(([id, p, d, sf, dist]) => ({
  id, property_id: `V${id}`, property_type: 'Single Family', units_count: 1, total_bedrooms: 3, total_baths: 2, building_square_feet: sf,
  year_built: 1960, sale_price: p, sale_date: d, latitude: LAT, longitude: LNG, property_address_zip: '75238', distance_miles: dist, estimated_value: p, source: 'mv_map_market_sales',
}))
const run = (extra = {}) => {
  const a = assembled()
  return calculateAcquisitionDecision({
    subject: a.subject, comps: v2Comps, buyerPurchases: [], now: NOW,
    v3CompCandidates: a.candidates, v3LoaderDiagnostics: a.diagnostics, v3InvestorEvidence: a.investor_evidence, ...extra,
  })
}
const liveFields = (d) => JSON.stringify({ valuation: d.valuation, offer: d.offer, decision: d.decision, confidence: d.confidence, sel: d.selected_comps.map((s) => [s.comp.source_id, s.adjusted_price, s.weight]) })
const evidenceWithout = (ev, key) => { const { [key]: _drop, ...rest } = ev; return rest }

// ── 1 + 2: flag wiring ──
test('flags OFF: no V3 compute, no v3/v3_shadow keys, output identical to an explicit v3Enabled:false run', () => {
  withEnv({}, () => {
    const a = run()
    const b = run({ v3Enabled: false })
    assert.equal(a.evidence.v3, null)
    assert.equal('v3_shadow' in a.evidence, false)
    assert.equal('v3_shadow' in a, false)
    assert.equal(liveFields(a), liveFields(b))
  })
})

test('ENABLED alone (env): SHADOW by default — live fields byte-identical to OFF, V3 only in evidence.v3_shadow', () => {
  const off = withEnv({}, () => run())
  const shadow = withEnv({ ACQUISITION_ENGINE_V3_ENABLED: 'true' }, () => run())
  assert.equal(shadow.evidence.v3, null, 'evidence.v3 stays null (live readers treat it as authority)')
  assert.equal(shadow.v3, null)
  assert.ok(shadow.evidence.v3_shadow, 'shadow block present')
  assert.equal(shadow.evidence.v3_shadow.authority.mode, 'shadow')
  assert.deepEqual(shadow.evidence.v3_shadow.authority.reasons, ['shadow_mode_flag_on', 'persist_not_allowed', 'market_not_in_cutover'])
  assert.equal(liveFields(shadow), liveFields(off))
  // Whole evidence identical except the added key (computed_at uses the same injected now).
  assert.equal(JSON.stringify(evidenceWithout(shadow.evidence, 'v3_shadow')), JSON.stringify(off.evidence))
  assert.equal(shadow.evidence.v3_shadow.engine_version, MERGED_ENGINE_VERSION)
})

test('ALLOW_PERSIST without SHADOW_MODE=false, or without the cutover market, stays SHADOW', () => {
  for (const env of [
    { ACQUISITION_ENGINE_V3_ENABLED: 'true', ACQUISITION_ENGINE_V3_ALLOW_PERSIST: 'true' },
    { ACQUISITION_ENGINE_V3_ENABLED: 'true', ACQUISITION_ENGINE_V3_ALLOW_PERSIST: 'true', ACQUISITION_ENGINE_V3_SHADOW_MODE: 'false' },
    { ACQUISITION_ENGINE_V3_ENABLED: 'true', ACQUISITION_ENGINE_V3_SHADOW_MODE: 'false', ACQUISITION_ENGINE_V3_CUTOVER_MARKETS: 'Dallas, TX' },
    { ACQUISITION_ENGINE_V3_ENABLED: 'true', ACQUISITION_ENGINE_V3_ALLOW_PERSIST: 'true', ACQUISITION_ENGINE_V3_SHADOW_MODE: 'false', ACQUISITION_ENGINE_V3_CUTOVER_MARKETS: 'Houston, TX' },
    { ACQUISITION_ENGINE_V3_ENABLED: 'true', ACQUISITION_ENGINE_V3_ALLOW_PERSIST: 'true', ACQUISITION_ENGINE_V3_SHADOW_MODE: 'false', ACQUISITION_ENGINE_V3_CUTOVER_MARKETS: 'Dallas, TX', ACQUISITION_ENGINE_V3_CUTOVER_LANES: 'mf5' },
  ]) {
    const d = withEnv(env, () => run())
    assert.equal(d.evidence.v3, null, JSON.stringify(env))
    assert.equal(d.evidence.v3_shadow.authority.mode, 'shadow')
  }
})

test('LIVE only with ENABLED + ALLOW_PERSIST + SHADOW_MODE=false + cutover market and lane', () => {
  const d = withEnv({
    ACQUISITION_ENGINE_V3_ENABLED: 'true', ACQUISITION_ENGINE_V3_ALLOW_PERSIST: 'true', ACQUISITION_ENGINE_V3_SHADOW_MODE: 'false',
    ACQUISITION_ENGINE_V3_CUTOVER_MARKETS: 'Houston, TX; dallas,  tx',
  }, () => run())
  assert.ok(d.evidence.v3)
  assert.equal(d.evidence.v3.authority.mode, 'live')
  assert.equal(d.evidence.v3.authority_mode, 'live')
  assert.equal('v3_shadow' in d.evidence, false)
})

test('resolveV3Authority: 2-4 unit lane is never live; MF label with units<=1 is "other" (never live)', () => {
  const env = { ACQUISITION_ENGINE_V3_ENABLED: 'true', ACQUISITION_ENGINE_V3_ALLOW_PERSIST: 'true', ACQUISITION_ENGINE_V3_SHADOW_MODE: 'false', ACQUISITION_ENGINE_V3_CUTOVER_MARKETS: 'Dallas, TX', ACQUISITION_ENGINE_V3_CUTOVER_LANES: 'sfr;mf24;mf5' }
  assert.equal(subjectOfferLane({ asset_family: 'multifamily', units: 3 }), 'mf24')
  assert.equal(subjectOfferLane({ asset_family: 'multifamily', units: 1 }), 'other')
  assert.equal(resolveV3Authority({ subject: { market: 'Dallas, TX', asset_family: 'multifamily', units: 3 }, env }).mode, 'shadow')
  assert.equal(resolveV3Authority({ subject: { market: 'Dallas, TX', asset_family: 'multifamily', units: 12 }, env }).mode, 'live')
  assert.equal(resolveV3Authority({ subject: { market: 'Dallas, TX', asset_family: 'multifamily', units: 1 }, env }).mode, 'shadow')
  assert.equal(resolveV3Authority({ subject: { market: 'Dallas, TX', asset_family: 'residential' }, env: {} }).mode, 'off')
})

test('scoreProperty with V3 on (default flags): the persisted row is the V2 row; V3 only in evidence.v3_shadow', async () => {
  const a = assembled()
  const deps = (extra) => ({
    now: NOW,
    loadSubjectProperty: async () => rawSubject,
    loadComparableProperties: async () => v2Comps,
    loadBuyerPurchases: async () => [],
    loadV3CompCandidates: async () => ({ candidates: a.candidates, diagnostics: a.diagnostics, investor_evidence: a.investor_evidence }),
    persistAcquisitionScore: async (row) => ({ id: 'x', ...row }),
    persistImmutableScoreSnapshot: async () => ({ snapshot_id: 'snap' }),
    newSnapshotId: () => 'snap',
    ...extra,
  })
  const off = await withEnvAsync({}, () => scoreProperty('S1', deps({})))
  const on = await withEnvAsync({}, () => scoreProperty('S1', deps({ v3Enabled: true })))
  const strip = (s) => { const { evidence, ...rest } = s; return rest }
  assert.deepEqual(strip(on.score), strip(off.score), 'every live column identical')
  assert.equal(on.score.evidence.v3, null)
  assert.ok(on.score.evidence.v3_shadow)
  assert.equal(JSON.stringify(evidenceWithout(on.score.evidence, 'v3_shadow')), JSON.stringify(off.score.evidence))
  // An explicit v3Enabled from the backfill does NOT bypass the authority: still shadow.
  assert.equal(on.score.evidence.v3_shadow.authority.mode, 'shadow')
})

test('merged loader falls back to the legacy RPC (labelled) while the canonical SQL is not applied', async () => {
  const out = await loadV3MergedCandidates({ property_id: 'S1', latitude: LAT, longitude: LNG, raw: rawSubject, asset_family: 'residential' }, {
    now: NOW,
    runCanonicalRpc: async () => { const e = new Error('function not found'); e.code = 'PGRST202'; throw e },
    runRpc: async () => [],
  })
  assert.equal(out.investor_evidence, null)
  assert.equal(out.diagnostics.corpus, 'legacy_rpc_fallback')
  assert.equal(out.diagnostics.fallback_reason, 'canonical_rpc_not_applied')
})

// ── 3: parity with the frozen v3.1 oracle ──
test('parity: merged investor universe == frozen v3.1 oracle (value, method, confidence, selected ids)', () => {
  const a = assembled()
  const gate = () => []
  const oracle = valueSubjectV3({ subject: a.investorSubject, rows: a.investor_evidence.rows, asOf: AS_OF, gate })
  const merged = valueInvestorUniverse({ subject: a.investorSubject, rows: a.investor_evidence.rows, asOf: AS_OF, gate })
  for (const k of ['mid', 'low', 'high', 'method', 'confidence', 'selected', 'n_eff', 'lane']) assert.deepEqual(merged.value[k], oracle.value[k], k)
  const ids = (r) => r.comps.filter((c) => c.status === 'selected').map((c) => c.comp_id).sort()
  assert.deepEqual(ids(merged), ids(oracle))
  assert.ok(merged.value.mid > 150000 && merged.value.mid < 185000, `investor value ${merged.value.mid}`)
  // A 3.1 mi sale never reaches the SFR investor set (lane radius 2.5 mi), and the
  // trustee deed is excluded with its reason.
  assert.equal(a.investor_evidence.rows.some((r) => r.price === 400000), false)
  assert.ok(merged.comps.find((c) => c.price === 30000).reasons.includes('v3_distressed_or_non_sale_instrument'))
})

test('parity: merged offer == v3.1 proposed offer for SFR / 2-4 / 5+ lanes and every confidence tier', () => {
  for (const [lane, mid, conf, method] of [['sfr', 150000, 80, 'investor_comps'], ['sfr', 260000, 55, 'investor_comps'], ['sfr', 90000, 30, 'market_ratio_fallback'], ['mf24', 420000, 72, 'investor_comps'], ['mf5', 1076900, 57, 'investor_comps']]) {
    const units = lane === 'mf5' ? 11 : lane === 'mf24' ? 3 : null
    const o = computeOfferV3({ value: { mid, lane, confidence: conf, method, per_door: units ? { units, label: 'x' } : undefined }, subject: {} })
    const m = buildCashOfferMerged({ investorValue: mid, lane, confidence: conf, method, units })
    assert.equal(m.buyer_ceiling, o.buyer_ceiling, `${lane} ceiling`)
    assert.equal(m.recommended_cash_offer, o.recommended_cash_offer, `${lane} offer`)
    assert.equal(m.minimum_acceptable_offer, o.minimum_acceptable_offer, `${lane} minimum`)
    assert.equal(m.projected_assignment_fee, o.assignment_fee_target, `${lane} fee`)
  }
})

// ── 4: offer math, repairs, gates ──
test('offer: owner example $150K investor price -> ceiling ~$138K -> offer ~$121K; repairs never subtracted', () => {
  const o = buildCashOfferMerged({ investorValue: 150000, lane: 'sfr', confidence: 80 })
  assert.equal(o.buyer_ceiling, 138000)
  assert.equal(o.projected_assignment_fee, 16600) // 12% under the $150K ceiling
  assert.equal(o.recommended_cash_offer, 121400)
  assert.equal(o.cost_breakdown.buyer_repairs, 0)
  assert.equal(o.repairs_basis, 'embedded_in_as_is_investor_comps_not_subtracted_again')
  assert.ok(o.recommended_cash_offer <= o.buyer_ceiling && o.buyer_ceiling <= 150000)
  // $15K fee floor and the 5+ unit 6% band.
  assert.equal(buildCashOfferMerged({ investorValue: 60000, lane: 'sfr', confidence: 80 }).projected_assignment_fee, 15000)
  const mf = buildCashOfferMerged({ investorValue: 1076900, lane: 'mf5', confidence: 57, units: 11 })
  assert.equal(mf.margin_pct_used, MERGED_OFFER_POLICY.feePctByLane.mf5)
  assert.equal(mf.per_unit.units, 11)
  assert.ok(mf.per_unit.offer > 70000 && mf.per_unit.offer < 90000)
  // Per-unit math needs a REAL integer count >= 2.
  assert.equal(buildCashOfferMerged({ investorValue: 300000, lane: 'mf24', confidence: 80, units: 1 }).per_unit, undefined)
  assert.equal(buildCashOfferMerged({ investorValue: null, lane: 'sfr' }).available, false)
})

test('repairs: the flat $35/sqft import is LOW confidence; a recorded estimate with a real condition is not', () => {
  const flat = estimateRepairs({ estimated_repair_cost: 49000, building_square_feet: 1400, building_condition: 'Average' }, { family: 'RESIDENTIAL_SINGLE' })
  assert.equal(flat.repair_source, 'import_flat_rate_per_sqft')
  assert.equal(flat.repair_confidence, 30)
  const real = estimateRepairs({ estimated_repair_cost: 61000, building_square_feet: 1400, building_condition: 'Poor' }, { family: 'RESIDENTIAL_SINGLE' })
  assert.equal(real.repair_source, 'subject_estimated_repair_cost')
  assert.equal(real.repair_confidence, 85)
})

test('gates: identity conflict and 2-4 units downgrade an executable state to REVIEW (never upgrade)', () => {
  const ready = { execution_state: 'SHADOW_MODE_READY', reasons: [], auto_offer_ready_criteria_met: true, auto_offer_eligible: false }
  const offer = buildCashOfferMerged({ investorValue: 200000, lane: 'sfr', confidence: 80 })
  assert.equal(applyMergedGates(ready, { lane: 'sfr', cashOffer: offer, assetIdentityConflict: false }).confidence.execution_state, 'SHADOW_MODE_READY')
  const conflict = applyMergedGates(ready, { lane: 'sfr', cashOffer: offer, assetIdentityConflict: true })
  assert.equal(conflict.confidence.execution_state, 'REVIEW_REQUIRED')
  assert.equal(conflict.confidence.auto_offer_ready_criteria_met, false)
  assert.equal(applyMergedGates(ready, { lane: 'mf24', cashOffer: offer, assetIdentityConflict: false }).confidence.execution_state, 'REVIEW_REQUIRED')
  const noValue = applyMergedGates(ready, { lane: 'sfr', cashOffer: { available: false, reasons: ['no_qualified_investor_value'] }, investorUniverse: { unavailable_reason: 'no_qualified_investor_comps_within_2_5mi' } })
  assert.equal(noValue.confidence.execution_state, 'DATA_REQUIRED')
  const quarantined = { ...ready, execution_state: 'ANOMALY_QUARANTINE' }
  assert.equal(applyMergedGates(quarantined, { lane: 'sfr', cashOffer: offer, assetIdentityConflict: false }).confidence.execution_state, 'ANOMALY_QUARANTINE')
})

test('engine: MF label with units = 1 (627 Ontario pattern) never carries an authorized merged offer', () => {
  const raw = { ...rawSubject, property_id: 'O1', property_type: 'Multi-Family', units_count: 1 }
  const subject = normalizePropertyFeatures(raw, { source: 'properties', now: NOW })
  const investorSubject = investorSubjectFrom({ subject, raw, own: null, neighbors })
  const as = assembleCanonicalCandidates({ rows: rows(), subject, investorSubject, asOf: AS_OF })
  const d = calculateAcquisitionDecision({ subject, comps: [], buyerPurchases: [], now: NOW, v3Enabled: true, v3Mode: 'shadow', v3CompCandidates: as.candidates, v3InvestorEvidence: as.investor_evidence })
  const v = d.evidence.v3_shadow
  assert.equal(v.merged.asset_identity_conflict, true)
  assert.notEqual(v.execution_state, 'SHADOW_MODE_READY')
  assert.equal(v.offer_authorization.authorized_recommended_offer, null)
})

test('merged V3 shadow offer bridge has no repair or end-buyer cost lines and stays under the ceiling', () => {
  const d = withEnv({ ACQUISITION_ENGINE_V3_ENABLED: 'true' }, () => run())
  const v = d.evidence.v3_shadow
  assert.equal(v.cash_offer.offer_model, 'merged_v31')
  assert.deepEqual(v.cash_offer.bridge.map((b) => b.step), ['as_is_investor_value', 'less_calibration', 'less_confidence_haircut', 'buyer_ceiling', 'less_assignment_fee', 'recommended_cash_offer'])
  assert.ok(v.cash_offer.recommended_cash_offer <= v.cash_offer.buyer_ceiling)
  assert.equal(v.universes.LOCAL_INVESTOR_VALUE.model, 'merged_investor_rules')
  assert.ok(v.invariants.ok)
})

// ── 5: one authority interface ──
const prodRow = (extra = {}) => ({
  id: 'r1', property_id: 'S1', computed_at: '2026-09-30T00:00:00Z', decision_tier: 'AUTO_RANGE_OFFER', recommended_cash_offer: 100000,
  minimum_acceptable_offer: 95000, valuation_mid: 200000, estimated_repairs: 49000, comp_count: 8, confidence: 80, valuation_confidence: 80,
  evidence: {
    engine: { version: '2.0.0' }, offer_calculation: { effective_authorized_ceiling: 118000 },
    subject: { market: 'Dallas, TX', asset_family: 'residential', normalized_features: { units: 1 }, asset_identity_conflict: false },
    selected_comps: [{ comp_id: 'c1', sale_price: 190000 }], decision_inputs: { inputs: { property: { estimated_value: 210000 } } }, v3: null,
  },
  ...extra,
})
test('authority: production v2 is the source today; shadow is reported but never money', () => {
  const shadowBlock = withEnv({ ACQUISITION_ENGINE_V3_ENABLED: 'true' }, () => run()).evidence.v3_shadow
  const row = prodRow()
  row.evidence.v3_shadow = shadowBlock
  const a = authoritativeOfferFromScore(row, { now: Date.parse('2026-10-01T00:00:00Z'), env: {} })
  assert.equal(a.engine, 'acquisition_decision_engine')
  assert.equal(a.engine_version, '2.0.0')
  assert.equal(a.value, 200000)
  assert.equal(a.negotiation_authority.source, 'acquisition_decision_engine')
  if (a.authorized) {
    assert.equal(a.offer, 100000)
    assert.equal(a.ceiling, 118000)
  } else {
    assert.equal(a.offer, null)
  }
  assert.ok(a.shadow_candidate)
  assert.equal(a.shadow_candidate.authorized, false)
  assert.ok(a.shadow_candidate.reasons.includes('shadow_only_not_money'))
})

test('authority: a live merged block is used only while the market is still cut over', async () => {
  const env = { ACQUISITION_ENGINE_V3_ENABLED: 'true', ACQUISITION_ENGINE_V3_ALLOW_PERSIST: 'true', ACQUISITION_ENGINE_V3_SHADOW_MODE: 'false', ACQUISITION_ENGINE_V3_CUTOVER_MARKETS: 'Dallas, TX' }
  const live = withEnv(env, () => run()).evidence.v3
  const row = prodRow()
  row.evidence.v3 = live
  const nowMs = Date.parse('2026-10-01T00:00:00Z')
  const a = authoritativeOfferFromScore(row, { now: nowMs, env })
  assert.equal(a.engine, 'offer_engine_v3_merged')
  assert.equal(a.negotiation_authority.value_as_is, a.value)
  assert.equal(a.negotiation_authority.repairs_embedded_in_value, true)
  if (a.authorized) assert.ok(a.offer <= a.ceiling && a.ceiling <= a.value)
  const revoked = authoritativeOfferFromScore(row, { now: nowMs, env: { ...env, ACQUISITION_ENGINE_V3_CUTOVER_MARKETS: '' } })
  assert.equal(revoked.engine, 'acquisition_decision_engine')
  const viaLoader = await getAuthoritativeOffer('S1', { loadScore: async () => null, now: nowMs, env })
  assert.equal(viaLoader.authorized, false)
  assert.ok(viaLoader.reasons.includes('no_authority'))
})

test('authority: per-unit math only with a real integer unit count >= 2 and no identity conflict', () => {
  assert.equal(perUnitOf({ value: 900000, ceiling: 800000, offer: 700000, units: 1 }), null)
  assert.equal(perUnitOf({ value: 900000, ceiling: 800000, offer: 700000, units: 2.5 }), null)
  assert.equal(perUnitOf({ value: 900000, ceiling: 800000, offer: 700000, units: 10, identityConflict: true }), null)
  assert.deepEqual(perUnitOf({ value: 900000, ceiling: 800000, offer: 700000, units: 10 }), { units: 10, value: 90000, ceiling: 80000, offer: 70000 })
})

test('production pin (same fixture as investor-valuation-v3.test.mjs) is unchanged by the merge', () => {
  const pinSubject = {
    property_id: 'S1', property_type: 'Single Family', units_count: 1, total_bedrooms: 3, total_baths: 2,
    building_square_feet: 1500, year_built: 1960, latitude: 45.0, longitude: -93.3, property_address_zip: '55412',
    estimated_value: 250000, estimated_repair_cost: 40000, market: 'Minneapolis, MN', building_condition: 'Average',
  }
  const PNOW = new Date('2026-10-01T00:00:00Z')
  const comps = [
    ['c1', 260000, '2026-08-01', 1450, 0.3], ['c2', 245000, '2026-07-15', 1600, 0.5], ['c3', 275000, '2026-06-20', 1550, 0.8],
    ['c4', 238000, '2026-05-30', 1400, 1.1], ['c5', 255000, '2026-04-10', 1500, 1.4], ['c6', 268000, '2026-03-05', 1650, 1.9],
  ].map(([id, p, d, sf, dist]) => ({
    id, property_id: `P${id}`, property_type: 'Single Family', units_count: 1, total_bedrooms: 3, total_baths: 2,
    building_square_feet: sf, year_built: 1958, sale_price: p, sale_date: d, latitude: 45.0, longitude: -93.3,
    property_address_zip: '55412', distance_miles: dist, estimated_value: p, source: 'mv_map_market_sales',
  }))
  const d = withEnv({}, () => calculateAcquisitionDecision({ subject: normalizePropertyFeatures(pinSubject, { source: 'properties', now: PNOW }), comps, buyerPurchases: [], now: PNOW }))
  const sig = createHash('sha256').update(JSON.stringify({
    v: d.valuation, o: d.offer.recommended_cash_offer, f: d.offer.minimum_acceptable_offer, t: d.decision.tier, c: d.confidence,
    sel: d.selected_comps.map((s) => [s.comp.source_id, s.adjusted_price, s.weight]),
  })).digest('hex')
  assert.equal(sig, 'fd6b8fc103ca987f03a836f12fb398182d1101586b0c989827ea0a623c86e6c7')
  assert.equal(INVESTOR_RULES_SFR.radiusMiles, 2.5)
})
