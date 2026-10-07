// Seller Situation v2 / raw_facts_v1 (Acquisition OS §2–10, §78, §84, §88 scoring + performance).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORE_VERSION,
  INPUT_MODEL_VERSION,
  COMPONENTS,
  EXCLUDED_INPUTS,
  HARD_FAMILIES,
  SUPPORTING_CODES,
  STRONG_SUPPORTING_CODES,
  EVIDENCE_CATALOG,
  scoreSellerSituation,
  buildRawFactsFromRows,
  loadSellerRawFacts,
  encodeSellerSituationRow,
  decodeEvidence,
  rowBytes,
  whyTargeted,
  primeSellerScoringRawFactsFlag,
  isSellerScoringRawFactsActive,
} from '@/lib/acquisition/seller-situation/index.js';
import { __resetSellerScoringRawFactsFlag } from '@/lib/acquisition/seller-situation/flag.js';
import { calculateAcquisitionDecision, normalizePropertyFeatures } from '@/lib/acquisition/acquisitionDecisionEngine.js';
import fs from 'node:fs';

const NOW = '2026-10-07T00:00:00.000Z';

/** A neutral owner-occupied SFR: every core field known, no signal. */
function features(overrides = {}) {
  return {
    property_id: 'p1',
    as_of_date: '2026-08-07',
    lien_tax_delinquent: false, lien_tax_delinq_years: null, lien_has_tax: false, lien_active: false,
    lien_has_judgment: false, lien_has_lis_pendens: false, lien_has_municipal: false, lien_has_hoa: false, lien_total_amount_due: null,
    fcl_any: false, fcl_stale_nod: false, fcl_stage: null, fcl_auction_within_90d: false,
    life_probate: false, life_death_event: false, ent_owner_dissolved: false,
    phy_is_vacant: false, own_owner_occupied: true, own_absentee: false, own_absentee_class: 'same_address', own_is_corporate: false, own_is_bank_reo: false,
    own_tenure_years: 3, prt_total_properties: 1, prt_tired_landlord_corroborated: false,
    val_estimated_value: 300_000, eqt_equity_percent: 15, eqt_free_and_clear: false, eqt_high_equity_corroborated: false, eqt_ltv: 0.3,
    dbt_total_balance: 90_000, dbt_total_payment_mo: 600, dbt_payment_to_value: 0.024, dbt_has_adjustable: false, dbt_maturity_within_24m: false, dbt_junior_lien_count: 0,
    val_tax_amount: 2_700, val_eff_tax_rate: 0.009, txn_appreciation_ratio: 1.2, txn_price_reliable: true,
    phy_condition_class: 4, phy_year_built: 2005, phy_repair_tier: 'medium', phy_asset_class: 'sfr', phy_units_count: 1,
    dsp_buyer_liquidity: 0.2, mkt_sale_velocity_5y: 0.01,
    ...overrides,
  };
}
function property(overrides = {}) {
  return { property_id: 'p1', market: 'Dallas, TX', property_address_state: 'TX', property_address_zip: '75217', property_flags_text: '', ...overrides };
}
const score = (f = {}, p = {}, ctx = {}) => scoreSellerSituation(buildRawFactsFromRows({ features: features(f), property: property(p) }), { now: NOW, ...ctx });
const codes = (r) => r.evidence.map((e) => e.code);

// ── versioning ────────────────────────────────────────────────────────────
test('versioning: every result carries score_version, input_model_version, weights_version, scored_at', () => {
  const r = score();
  assert.equal(r.score_version, 'seller_situation_v2');
  assert.equal(r.input_model_version, 'raw_facts_v1.1');
  assert.equal(SCORE_VERSION, 'seller_situation_v2');
  assert.equal(INPUT_MODEL_VERSION, 'raw_facts_v1.1');
  assert.match(r.weights_version, /^ssv2_weights_/);
  assert.equal(r.scored_at, NOW);
  const row = encodeSellerSituationRow(r);
  assert.equal(row.score_version, 'seller_situation_v2');
  assert.equal(row.input_model_version, 'raw_facts_v1.1');
});

// ── no Podio contamination (§3) ───────────────────────────────────────────
test('no Podio contamination: legacy scores and podio_tags never move any output except legacy_shadow', () => {
  const base = score({}, {});
  const legacy = score({}, {
    final_acquisition_score: 99, structured_motivation_score: 99, tag_distress_score: 99, deal_strength_score: 99,
    ai_score: 99, podio_tags: 'Tax Delinquent; Vacant Home; Probate; Preforeclosure', priority_tier: 'A',
    seller_tags_text: 'vacant probate foreclosure tired landlord', financial_pressure_score: 99, urgency_score: 99,
  });
  const strip = (r) => ({ ...r, legacy_shadow: null });
  assert.deepEqual(strip(legacy), strip(base));
  assert.equal(legacy.legacy_shadow.final_acquisition_score, 99);
  assert.equal(base.legacy_shadow.final_acquisition_score, null);
});

test('no Podio contamination: the model source never reads an excluded legacy column', () => {
  const src = fs.readFileSync(new URL('../../src/lib/acquisition/seller-situation/model.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function scoreSellerSituation'));
  for (const col of ['final_acquisition_score', 'structured_motivation_score', 'tag_distress_score', 'deal_strength_score', 'podio_tags', 'ai_score', 'seller_tags_text']) {
    assert.ok(!body.includes(`F.${col}`) && !body.includes(`p.${col}`), `scorer reads ${col}`);
  }
});

// ── fairness ──────────────────────────────────────────────────────────────
test('fairness: age / familial / marital proxies never move the score', () => {
  const base = score();
  const proxies = score(
    { own_senior_owner_vendor: true, vendor_empty_nester: true, life_divorce_event: true },
    { property_flags_text: 'Senior Owner; Empty Nester; Cash Buyer; Likely To Move', language: 'es', est_household_income: 20_000 },
  );
  assert.deepEqual({ ...proxies, legacy_shadow: null }, { ...base, legacy_shadow: null });
  for (const f of ['own_senior_owner_vendor', 'vendor_empty_nester', 'life_divorce_event', 'language', 'age', 'marital_status', 'familial_status']) {
    assert.ok(EXCLUDED_INPUTS.fairness.includes(f), f);
  }
});

// ── nulls / coverage ──────────────────────────────────────────────────────
test('nulls: unknown is never zero — no source rows => UNKNOWN tier, null components, null probabilities', () => {
  const r = scoreSellerSituation(buildRawFactsFromRows({ property: { property_id: 'x' }, features: null }), { now: NOW });
  assert.equal(r.opportunity_tier, 'UNKNOWN');
  for (const c of COMPONENTS) assert.equal(r.components[c], null, c);
  assert.deepEqual(r.sell_probability, { d90: null, d180: null, d365: null });
  assert.equal(r.coverage.fields_known, 0);
  assert.equal(r.confidence, 0);
  assert.equal(r.conversation_angle, null);
});

test('nulls: a neutral, fully-covered property scores 0 (not null) with tier C and no angle', () => {
  const r = score();
  assert.equal(r.coverage.ratio, 1);
  assert.equal(r.components.forced_sale_pressure, 0);
  assert.equal(r.components.tax_pain, 0);
  assert.equal(r.opportunity_tier, 'C');
  assert.equal(r.seller_situation, 'NO_CLEAR_SITUATION');
  assert.equal(r.conversation_angle, null);
});

// ── raw mapping + provenance (§78) ────────────────────────────────────────
test('raw mapping: features_v1 is primary, properties is a named fallback, never silently mixed', () => {
  const rf = buildRawFactsFromRows({ features: features({ lien_tax_delinquent: true }), property: property({ tax_delinquent: false }) });
  assert.equal(rf.facts.tax_delinquent, true);
  assert.equal(rf.sources.tax_delinquent.table, 'seller.property_features_v1');
  const fb = buildRawFactsFromRows({ features: null, property: property({ tax_delinquent: true, owner_location: 'Absentee Owner' }) });
  assert.equal(fb.sources.tax_delinquent.table, 'properties');
  assert.equal(fb.sources.tax_delinquent.provenance, 'vendor_record');
  assert.equal(fb.facts.absentee, true);
  const r = scoreSellerSituation(fb, { now: NOW });
  const e = r.evidence.find((x) => x.code === 'TAX_DELINQUENT');
  assert.equal(e.source_table, 'properties');
  assert.equal(e.source_field, 'tax_delinquent');
});

test('explainability: every evidence item names code, points, component, source and provenance; components equal their evidence sums', () => {
  const r = score({ lien_tax_delinquent: true, lien_tax_delinq_years: 2, phy_is_vacant: true, own_absentee: true, own_owner_occupied: false, eqt_equity_percent: 70, own_tenure_years: 22 });
  assert.ok(r.evidence.length >= 6);
  for (const e of r.evidence) {
    assert.ok(e.code && Number.isFinite(e.points) && COMPONENTS.includes(e.component), JSON.stringify(e));
    assert.ok(e.source_table && e.source_field && e.provenance, JSON.stringify(e));
    assert.ok(EVIDENCE_CATALOG[e.code], `catalog label missing for ${e.code}`);
  }
  for (const c of COMPONENTS) {
    const sum = r.evidence.filter((e) => e.component === c).reduce((a, e) => a + e.points, 0);
    assert.equal(r.components[c], Math.min(100, sum), c);
  }
  assert.match(whyTargeted(r.evidence), /Tax delinquent/);
});

// ── signals ───────────────────────────────────────────────────────────────
test('tax: delinquency drives tax_pain + forced sale; multi-year adds more', () => {
  const one = score({ lien_tax_delinquent: true, lien_tax_delinq_years: 1 });
  const two = score({ lien_tax_delinquent: true, lien_tax_delinq_years: 3 });
  assert.equal(one.components.tax_pain, 40);
  assert.equal(two.components.tax_pain, 55);
  assert.ok(two.components.forced_sale_pressure > one.components.forced_sale_pressure);
  assert.ok(codes(two).includes('TAX_DELINQUENT_MULTI_YEAR'));
  assert.equal(one.seller_situation, 'TAX_DISTRESSED');
  assert.equal(one.conversation_angle, 'SPEED_CERTAINTY');
});

test('lien: typed liens score individually; a bare recorded lien scores as LIEN_RECORDED', () => {
  assert.ok(codes(score({ lien_active: true })).includes('LIEN_RECORDED'));
  const lp = score({ lien_active: true, lien_has_lis_pendens: true });
  assert.ok(codes(lp).includes('LIS_PENDENS'));
  assert.ok(!codes(lp).includes('LIEN_RECORDED'));
  assert.equal(lp.seller_situation, 'FINANCIALLY_PRESSURED');
});

test('vacancy: recorded vacancy beats the vendor flag; the flag is used only when the record is unknown', () => {
  assert.ok(codes(score({ phy_is_vacant: true })).includes('VACANT'));
  assert.ok(!codes(score({ phy_is_vacant: false }, { property_flags_text: 'Vacant Home' })).includes('VF_VACANT'));
  assert.ok(codes(score({ phy_is_vacant: null }, { property_flags_text: 'Vacant Home' })).includes('VF_VACANT'));
});

test('probate: probate / death event => INHERITED_PROBATE with convenience angle', () => {
  const r = score({ life_probate: true });
  assert.equal(r.seller_situation, 'INHERITED_PROBATE');
  assert.equal(r.conversation_angle, 'CONVENIENCE');
  assert.ok(codes(score({ life_death_event: true })).includes('DEATH_EVENT'));
});

test('absentee + tenure + portfolio: landlord fatigue only for non-owner-occupied or rental assets', () => {
  const owner = score({ own_tenure_years: 25, prt_total_properties: 6 });
  assert.equal(owner.components.landlord_fatigue, 0, 'owner-occupied SFR is not a landlord');
  const ll = score({ own_owner_occupied: false, own_absentee: true, own_absentee_class: 'out_of_state', own_tenure_years: 25, prt_total_properties: 6, prt_tired_landlord_corroborated: true });
  assert.ok(ll.components.landlord_fatigue >= 50);
  assert.equal(ll.seller_situation, 'FATIGUED_LANDLORD');
  assert.equal(ll.conversation_angle, 'TENANT_RELIEF');
  for (const c of ['ABSENTEE', 'OUT_OF_STATE', 'TENURE_20Y', 'PORTFOLIO_5P', 'TIRED_LANDLORD_CORROBORATED']) assert.ok(codes(ll).includes(c), c);
});

test('equity: banded equity_unlock when the loan is known; equity carries NO sell-probability weight (calibration §10)', () => {
  const lo = score({ eqt_equity_percent: 10, dbt_total_balance: 270_000, eqt_ltv: 0.9 });
  const hi = score({ eqt_equity_percent: 90, dbt_total_balance: 30_000, eqt_ltv: 0.1 });
  assert.ok(hi.components.equity_unlock > lo.components.equity_unlock);
  assert.ok(codes(hi).includes('EQUITY_80P'));
  assert.equal(hi.sell_probability.d365, score({ eqt_equity_percent: 50, dbt_total_balance: 30_000, eqt_ltv: 0.1 }).sell_probability.d365);
});

test('equity rule (owner 10-07): a 0 or blank loan balance means equity UNKNOWN, never 100%', () => {
  for (const loan of [0, null]) {
    const r = score({ dbt_total_balance: loan, eqt_equity_percent: 100, eqt_free_and_clear: true, eqt_ltv: 0, eqt_high_equity_corroborated: true, dbt_payment_to_value: null });
    assert.equal(r.components.equity_unlock, null, `loan=${loan}`);
    assert.equal(r.components.debt_pressure, null, 'LTV 0 from a missing loan is not "no debt"');
    for (const c of ['EQUITY_80P', 'EQUITY_60P', 'EQUITY_40P', 'FREE_AND_CLEAR', 'VF_FREE_AND_CLEAR', 'HIGH_EQUITY_CORROBORATED', 'LONG_HOLD_EQUITY', 'NON_PRIMARY_EQUITY']) {
      assert.ok(!codes(r).includes(c), `${c} fired on loan=${loan}`);
    }
    assert.ok(r.coverage.missing.includes('equity_known') && r.coverage.missing.includes('ltv'));
    assert.ok(r.coverage.ratio < 1);
  }
  // value unknown also => unknown
  assert.equal(score({ val_estimated_value: null, dbt_total_balance: 90_000 }, { estimated_value: null }).components.equity_unlock, null);
  // properties fallback: equity_percent 100 with total_loan_balance 0 is not evidence either
  const fb = scoreSellerSituation(buildRawFactsFromRows({ features: null, property: property({ equity_percent: 100, total_loan_balance: 0, estimated_value: 250_000 }) }), { now: NOW });
  assert.equal(fb.components.equity_unlock, null);
});

test('equity rule: vendor flags give a CLASS (no %) with vendor_flag provenance', () => {
  const zero = { dbt_total_balance: 0, eqt_equity_percent: 100, eqt_ltv: 0, own_owner_occupied: false, own_absentee: true };
  const fc = score(zero, { property_flags_text: 'Free And Clear; Absentee Owner' });
  const e = fc.evidence.find((x) => x.code === 'VF_FREE_AND_CLEAR');
  assert.ok(e, codes(fc).join(','));
  assert.equal(e.provenance, 'vendor_flag');
  assert.equal(e.source_field, 'property_flags_text');
  assert.ok(!codes(fc).includes('EQUITY_80P'), 'no % is invented from a flag');
  const he = score(zero, { property_flags_text: 'High Equity' });
  assert.ok(codes(he).includes('VF_HIGH_EQUITY'));
  assert.ok(he.components.equity_unlock < fc.components.equity_unlock);
  const le = score(zero, { property_flags_text: 'Low Equity' });
  assert.equal(le.components.equity_unlock, 0, 'low class is known, scores 0');
  // with a known loan the % governs, flags never override it
  const known = score({ eqt_equity_percent: 15, dbt_total_balance: 255_000, eqt_ltv: 0.85 }, { property_flags_text: 'Free And Clear' });
  assert.ok(!codes(known).includes('VF_FREE_AND_CLEAR'));
});

test('tier rule "1 acute hard + equity ≥ 40" fires only on KNOWN equity', () => {
  const zeroLoan = { fcl_any: true, dbt_total_balance: 0, eqt_equity_percent: 100, eqt_ltv: 0 };
  assert.notEqual(score(zeroLoan).opportunity_tier, 'A', 'zero loan must not count as high equity');
  assert.equal(score(zeroLoan, { property_flags_text: 'Free And Clear' }).opportunity_tier, 'A');
  assert.equal(score({ fcl_any: true, eqt_equity_percent: 55, dbt_total_balance: 135_000, eqt_ltv: 0.45 }).opportunity_tier, 'A');
});

test('repair: the $/sqft repair tier is a formula estimate — low weight, flagged formula_estimate, lowers confidence', () => {
  const r = score({ phy_repair_tier: 'heavy' });
  const e = r.evidence.find((x) => x.code === 'REPAIR_TIER_HEAVY_FORMULA');
  assert.equal(e.provenance, 'formula_estimate');
  assert.ok(e.points <= 6);
  assert.ok(r.confidence < score().confidence);
  assert.ok(score({ phy_condition_class: 2 }).components.property_burden > r.components.property_burden, 'vendor condition outweighs the formula');
});

test('probabilities: bounded 0–95 and monotone d90 ≤ d180 ≤ d365; forced sale moves them most', () => {
  const calm = score();
  const hot = score({ fcl_any: true, fcl_auction_within_90d: true, lien_tax_delinquent: true, lien_tax_delinq_years: 3, phy_is_vacant: true, lien_has_lis_pendens: true, eqt_ltv: 0.97, dbt_total_balance: 291_000 });
  for (const r of [calm, hot]) {
    const { d90, d180, d365 } = r.sell_probability;
    assert.ok(d90 >= 0 && d365 <= 95 && d90 <= d180 && d180 <= d365, JSON.stringify(r.sell_probability));
  }
  assert.ok(hot.sell_probability.d90 > calm.sell_probability.d90 + 20);
});

// ── tiers (§14) ───────────────────────────────────────────────────────────
test('tier A: two hard families (tax + vacancy), or one acute hard + equity ≥ 40', () => {
  const a = score({ lien_tax_delinquent: true, phy_is_vacant: true, eqt_equity_percent: 70 });
  assert.equal(a.opportunity_tier, 'A');
  assert.deepEqual(a.hard_signal_families.sort(), ['TAX', 'VACANCY']);
  assert.equal(score({ fcl_any: true, eqt_equity_percent: 55 }).opportunity_tier, 'A');
  assert.notEqual(score({ fcl_any: true, eqt_equity_percent: 5 }).opportunity_tier, 'A');
});

test('tier B: one hard + ≥2 supporting, or a stack with ≥2 strong signals', () => {
  const b1 = score({ lien_tax_delinquent: true, own_owner_occupied: false, own_absentee: true, own_tenure_years: 16, eqt_equity_percent: 85 });
  assert.equal(b1.opportunity_tier, 'B');
  const b2 = score({ own_owner_occupied: false, own_absentee: true, own_absentee_class: 'out_of_state', own_tenure_years: 22, eqt_equity_percent: 85, prt_total_properties: 4 });
  assert.equal(b2.opportunity_tier, 'B');
});

test('tier C: tired landlord only (and the ubiquitous absentee/high-equity/old-house stack) stays soft', () => {
  const tl = score({ own_owner_occupied: false, own_absentee: true, eqt_equity_percent: 85, eqt_free_and_clear: true, phy_year_built: 1950, own_tenure_years: 16 }, { property_flags_text: 'Tired Landlord; Heavily Dated; High Equity; Absentee Owner' });
  assert.equal(tl.opportunity_tier, 'C');
  assert.ok(codes(tl).includes('VF_TIRED_LANDLORD'));
});

test('tier sets are consistent with the evidence catalog', () => {
  for (const c of Object.values(HARD_FAMILIES).flat()) assert.equal(EVIDENCE_CATALOG[c]?.kind, 'hard', c);
  for (const c of STRONG_SUPPORTING_CODES) assert.equal(EVIDENCE_CATALOG[c]?.kind, 'strong', c);
  for (const c of SUPPORTING_CODES) assert.ok(['strong', 'support'].includes(EVIDENCE_CATALOG[c]?.kind), c);
});

test('angle only with evidence: wealth preservation gets TAX_FLEXIBILITY only with a reliable gain', () => {
  const wp = score({ own_owner_occupied: false, own_absentee: true, eqt_equity_percent: 90, own_tenure_years: 25, txn_appreciation_ratio: 3, txn_price_reliable: true });
  assert.equal(wp.seller_situation, 'WEALTH_PRESERVATION');
  assert.equal(wp.conversation_angle, 'TAX_FLEXIBILITY');
  const noGain = score({ own_owner_occupied: false, own_absentee: true, eqt_equity_percent: 90, own_tenure_years: 25, txn_appreciation_ratio: 3, txn_price_reliable: false, eqt_free_and_clear: false });
  assert.equal(noGain.conversation_angle, null);
});

// ── storage (§7) ──────────────────────────────────────────────────────────
test('storage: a worst-case row (every signal) stays far below 15 KB and evidence round-trips', () => {
  const r = score({
    lien_tax_delinquent: true, lien_tax_delinq_years: 4, lien_has_tax: true, lien_active: true, lien_has_judgment: true, lien_has_lis_pendens: true,
    lien_has_municipal: true, lien_has_hoa: true, lien_total_amount_due: 40_000, fcl_any: true, fcl_auction_within_90d: true, life_probate: true,
    ent_owner_dissolved: true, phy_is_vacant: true, own_owner_occupied: false, own_absentee: true, own_absentee_class: 'out_of_state', own_tenure_years: 30,
    prt_total_properties: 9, prt_tired_landlord_corroborated: true, eqt_equity_percent: 85, eqt_free_and_clear: true, eqt_high_equity_corroborated: true,
    eqt_ltv: 0.97, dbt_payment_to_value: 0.08, dbt_has_adjustable: true, dbt_maturity_within_24m: true, dbt_junior_lien_count: 2, val_eff_tax_rate: 0.025,
    txn_appreciation_ratio: 4, phy_condition_class: 1, phy_year_built: 1920, phy_repair_tier: 'heavy', phy_asset_class: 'small_multi',
  }, { property_flags_text: 'Tired Landlord; Heavily Dated; Vacant Home; Probate; Tax Delinquent; Preforeclosure' });
  const row = encodeSellerSituationRow(r, { featuresAsOf: '2026-08-07' });
  assert.ok(rowBytes(row) < 15_000, `row ${rowBytes(row)} bytes`);
  assert.ok(rowBytes(row) < 3_000, `row ${rowBytes(row)} bytes`);
  const back = decodeEvidence(row);
  assert.equal(back.length, r.evidence.length);
  for (let i = 0; i < back.length; i++) {
    assert.equal(back[i].code, r.evidence[i].code);
    assert.equal(back[i].component, r.evidence[i].component);
    assert.equal(back[i].source_table, r.evidence[i].source_table);
    assert.equal(back[i].source_field, r.evidence[i].source_field);
  }
});

// ── loader: batched, never N+1 (§88 performance) ──────────────────────────
test('loader: one query per source table for the whole id list', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, n: params[0].length });
      if (sql.includes('seller.property_features_v1')) return { rows: params[0].map((id) => features({ property_id: id })) };
      return { rows: params[0].map((id) => property({ property_id: id })) };
    },
  };
  const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
  const out = await loadSellerRawFacts([...ids, ...ids.slice(0, 10)], db);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.n === 200));
  assert.equal(out.size, 200);
  assert.ok(calls.every((c) => /property_id = any\(\$1::text\[\]\)/.test(c.sql)));
  assert.ok(!calls.some((c) => /final_acquisition_score/.test(c.sql) && c.sql.includes('seller.')), 'legacy columns only read from properties (shadow)');
  await assert.rejects(() => loadSellerRawFacts(Array.from({ length: 501 }, (_, i) => `x${i}`), db), /max_500/);
});

test('performance: scoring 2,000 properties in memory is well under 1 s (~ms/property budget)', () => {
  const rfs = Array.from({ length: 2000 }, (_, i) => buildRawFactsFromRows({ features: features({ property_id: `p${i}`, own_tenure_years: i % 40 }), property: property({ property_id: `p${i}` }) }));
  const t0 = performance.now();
  for (const rf of rfs) scoreSellerSituation(rf, { now: NOW });
  assert.ok(performance.now() - t0 < 1000);
});

// ── flag: double gate (§84) ───────────────────────────────────────────────
test('flag: env ceiling AND runtime switch; unprimed / slow / throwing = OFF', async () => {
  __resetSellerScoringRawFactsFlag();
  const on = { SELLER_SCORING_RAW_FACTS: 'true' };
  assert.equal(isSellerScoringRawFactsActive({ env: on }), false, 'unprimed');
  assert.equal(await primeSellerScoringRawFactsFlag({ env: {}, readSystemFlag: async () => true }), false, 'no env ceiling');
  assert.equal(await primeSellerScoringRawFactsFlag({ env: on, readSystemFlag: async () => false }), false);
  assert.equal(await primeSellerScoringRawFactsFlag({ env: on, readSystemFlag: async () => { throw new Error('db down'); } }), false);
  assert.equal(await primeSellerScoringRawFactsFlag({ env: on, readSystemFlag: () => new Promise((r) => setTimeout(() => r(true), 500)), timeoutMs: 20 }), false);
  assert.equal(await primeSellerScoringRawFactsFlag({ env: on, readSystemFlag: async () => 'true' }), true);
  assert.equal(isSellerScoringRawFactsActive({ env: on }), true);
  assert.equal(isSellerScoringRawFactsActive({ env: { SELLER_SCORING_RAW_FACTS: '1' } }), false, 'exact "true" only');
  assert.equal(isSellerScoringRawFactsActive({ env: on, nowMs: Date.now() + 60_000 }), false, 'expired cache');
  __resetSellerScoringRawFactsFlag();
});

// ── engine wiring ─────────────────────────────────────────────────────────
const SUBJECT = {
  property_id: 'eng-1', property_address_full: '100 Main St, Dallas, TX 75201', property_address_city: 'Dallas', property_address_state: 'TX',
  property_address_zip: '75201', market: 'Dallas, TX', latitude: 32.7767, longitude: -96.797, normalized_asset_class: 'single_family',
  property_type: 'Single Family', total_bedrooms: 3, total_baths: 2, building_square_feet: 1800, units_count: 1, year_built: 1988,
  building_condition: 'Average', estimated_repair_cost: 32_000, estimated_value: 360_000, equity_percent: 62, total_loan_balance: 125_000,
  ownership_years: 14, out_of_state_owner: true, tax_delinquent: true, active_lien: false,
  structured_motivation_score: 74, tag_distress_score: 58, final_acquisition_score: 81, deal_strength_score: 40,
  property_flags_text: 'Tired Landlord; Absentee Owner', mls_market_status: 'Off Market',
};
function comp(i, price) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, property_id: `sold-${i}`, property_address_full: `${100 + i} Main St, Dallas, TX 75201`,
    property_address_city: 'Dallas', property_address_state: 'TX', property_address_zip: '75201', market: 'Dallas, TX',
    latitude: 32.7767 + i * 0.001, longitude: -96.797 + i * 0.001, normalized_asset_class: 'single_family', property_type: 'Single Family',
    total_bedrooms: 3, total_baths: 2, building_square_feet: 1760 + i * 12, units_count: 1, year_built: 1986 + i, building_condition: 'Average',
    mls_sold_price: price, mls_sold_date: `2026-0${Math.min(i, 5)}-15`, source: 'buyer_comp_properties_v2',
  };
}
const COMPS = [comp(1, 330_000), comp(2, 338_000), comp(3, 342_000), comp(4, 348_000), comp(5, 352_000)];

test('engine OFF (default): Podio-era inputs unchanged, no raw-facts keys, byte-identical to an explicit OFF', () => {
  __resetSellerScoringRawFactsFlag();
  const s = normalizePropertyFeatures(SUBJECT, { source: 'properties', now: new Date(NOW) });
  assert.equal(s.motivation_score, 74);
  assert.equal(s.distress_score, 58);
  assert.ok(!('seller_situation_v2' in s));
  assert.ok(!('motivation_input_model' in s));
  const run = (opts) => JSON.stringify(calculateAcquisitionDecision({ subject: SUBJECT, comps: COMPS, now: new Date(NOW), v3Enabled: false, ...opts }));
  const prev = process.env.SELLER_SCORING_RAW_FACTS;
  try {
    delete process.env.SELLER_SCORING_RAW_FACTS;
    const a = run();
    process.env.SELLER_SCORING_RAW_FACTS = 'true'; // env ceiling alone (runtime switch unprimed) must not turn it on
    const b = run();
    assert.equal(b, a);
  } finally {
    if (prev === undefined) delete process.env.SELLER_SCORING_RAW_FACTS; else process.env.SELLER_SCORING_RAW_FACTS = prev;
  }
});

test('engine ON: motivation/distress come from raw facts; changing Podio scores changes nothing', () => {
  const on = (row) => normalizePropertyFeatures(row, { source: 'properties', now: new Date(NOW), sellerScoringRawFacts: true });
  const a = on(SUBJECT);
  const b = on({ ...SUBJECT, structured_motivation_score: 1, tag_distress_score: 1, final_acquisition_score: 1, deal_strength_score: 1 });
  assert.equal(a.motivation_input_model, 'raw_facts_v1.1');
  assert.equal(a.seller_situation_v2.score_version, 'seller_situation_v2');
  assert.equal(a.motivation_score, b.motivation_score);
  assert.equal(a.distress_score, b.distress_score);
  assert.notEqual(a.motivation_score, 74);
  assert.equal(a.master_financial_pressure_score, null);
  // comps never get the raw-facts model
  const c = normalizePropertyFeatures(comp(1, 1), { source: 'buyer_comp_properties_v2', sellerScoringRawFacts: true });
  assert.ok(!('seller_situation_v2' in c));
});
