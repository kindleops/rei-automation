/**
 * Acquisition Engine V3 — Item 4.5 §2/§9 strategy-qualification + authorization.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STRATEGY_QUALIFICATION as Q,
  STRATEGIES,
  VALUE_CLASSIFICATION as VC,
} from '@/lib/acquisition/modelConstants.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
import { calculateAcquisitionDecision } from '@/lib/acquisition/acquisitionDecisionEngine.js';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const Z = '75201';
const sfr = (id, price, o = {}) => ({
  property_id: id, property_address_full: `${id} St, Dallas TX ${Z}`, property_address_zip: Z, property_address_city: 'Dallas',
  property_type: o.type || 'Single Family', units_count: o.units || 1, building_square_feet: o.sqft || 1400,
  total_bedrooms: 3, year_built: 1996, sale_price: price, sale_date: o.date || '2025-06-01',
  ...(o.mls ? { mls_sold_price: price, sale_price_source: 'MLS' } : {}), ...(o.buyer ? { buyer_name_clean: o.buyer } : {}),
});
const decide = (subject, comps, buyers = []) => buildV3Decision({ subjectRow: subject, qualification: qualifyComps(subject, comps), buyerPurchases: buyers, now: NOW });
const entryFor = (v3, s) => v3.strategy_ranking.ranked.find((x) => x.strategy === s);

const investorComps = [
  sfr('i1', 175000, { buyer: 'ACME HOMES LLC', date: '2025-03-01' }),
  sfr('i2', 182000, { buyer: 'REI CAPITAL LLC', date: '2025-05-01' }),
  sfr('i3', 178000, { buyer: 'BLUE DOOR LLC', date: '2025-07-01' }),
  sfr('i4', 185000, { buyer: 'ACME HOMES LLC', date: '2025-09-01' }),
];
const SUBJECT = { property_id: 's', property_type: 'Single Family', property_address_zip: Z, building_square_feet: 1400, units_count: 1, estimated_value: 200000 };

test('Austin: subject-anchor scenario, no qualified value, no authorized offer, NO_OFFER primary', () => {
  const subject = { property_id: '2136762817', property_type: 'Multifamily 2-4', property_address_zip: '78744', building_square_feet: 1776, units_count: 2, estimated_value: 391000 };
  const d = decide(subject, [{ property_id: 'c', property_address_full: '2000 E Stassney Ln, Austin TX 78744', property_address_zip: '78744', property_type: 'Multi-Family', units_count: 2, building_square_feet: 1728, sale_price: 332500000, sale_date: '2025-04-09' }]);
  assert.equal(d.v3.value_classification, VC.SUBJECT_ANCHOR_SCENARIO);
  assert.equal(d.v3.value_contract.qualified_market_value, null);
  assert.ok(d.v3.value_contract.scenario_market_value);
  assert.equal(d.v3.offer_authorization.authorized_recommended_offer, null);
  assert.equal(d.v3.strategy_ranking.primary_strategy, STRATEGIES.NO_OFFER);
  const cash = entryFor(d.v3, STRATEGIES.CASH);
  assert.equal(cash.authorized_offer, false);
  assert.equal(cash.scenario_only, true);
  assert.equal(d.v3.execution_state, 'ANOMALY_QUARANTINE');
});

test('Houston-style qualified SFR: qualified value, authorized (shadow) offer, transparent bridge', () => {
  const comps = [
    sfr('h1', 165000, { date: '2025-09-01' }), sfr('h2', 190000, { date: '2025-08-01' }),
    sfr('h3', 178000, { date: '2025-07-01' }), sfr('h4', 205000, { date: '2025-06-01' }), sfr('h5', 198000, { date: '2025-05-01' }),
  ];
  const d = decide({ ...SUBJECT, estimated_value: 156000 }, comps);
  assert.equal(d.v3.value_classification, VC.QUALIFIED);
  assert.ok(d.v3.value_contract.qualified_market_value.mid > 0);
  const cash = entryFor(d.v3, STRATEGIES.CASH);
  assert.equal(cash.qualification_status, Q.UNDERWRITTEN_SHADOW);
  assert.equal(cash.authorized_offer, true);
  assert.equal(cash.execution_eligible, false); // flags off
  assert.equal(d.v3.offer_authorization.authorized_recommended_offer, d.v3.cash_offer.recommended_cash_offer);
  assert.ok(d.v3.cash_offer.bridge.length >= 6);
  assert.equal(d.v3.strategy_ranking.primary_strategy, STRATEGIES.CASH);
});

test('investor-led SFR: CASH leads and is underwritten-shadow', () => {
  const d = decide(SUBJECT, [...investorComps, sfr('r1', 232000, { mls: true }), sfr('r2', 238000, { mls: true })], [{ buyer_key: 'b1', is_corporate_buyer: true, property_zip: Z, units_count: 1, purchase_price: 180000, purchase_date: '2025-07-01' }]);
  assert.equal(d.v3.strategy_ranking.primary_strategy, STRATEGIES.CASH);
  assert.equal(entryFor(d.v3, STRATEGIES.CASH).qualification_status, Q.UNDERWRITTEN_SHADOW);
});

test('retail-led SFR: NOVATION may lead when fully qualified', () => {
  const comps = [245000, 252000, 248000, 255000, 250000].map((p, i) => sfr(`r${i}`, p, { mls: true, sqft: 1500, date: `2025-0${i + 4}-01` }));
  comps.push(sfr('inv', 212000, { buyer: 'FLIP LLC' }));
  const d = decide({ ...SUBJECT, estimated_value: 250000, building_square_feet: 1500 }, comps);
  assert.equal(d.v3.strategy_ranking.primary_strategy, STRATEGIES.NOVATION);
  assert.equal(entryFor(d.v3, STRATEGIES.NOVATION).qualification_status, Q.UNDERWRITTEN_SHADOW);
});

test('duplex creative: subject-to is UNDERWRITTEN_SHADOW only with verified debt; DATA_REQUIRED without', () => {
  const duplexComps = [300000, 318000, 312000, 325000].map((p, i) => sfr(`d${i}`, p, { type: 'Duplex', units: 2, sqft: 2400, buyer: 'DUO LLC', date: `2025-0${i + 3}-01` }));
  const withDebt = { property_id: 'C', property_type: 'Duplex', property_address_zip: Z, building_square_feet: 2400, units_count: 2, estimated_value: 320000, monthly_rent: 3200, total_loan_balance: 180000, total_loan_payment: 1250, tax_amt: 4200 };
  const d1 = decide(withDebt, duplexComps);
  const st1 = entryFor(d1.v3, STRATEGIES.SUBJECT_TO);
  assert.equal(st1.qualification_status, Q.UNDERWRITTEN_SHADOW);
  assert.ok(st1.ranking_eligible);

  const noDebt = { ...withDebt, total_loan_balance: undefined, total_loan_payment: undefined };
  const d2 = decide(noDebt, duplexComps);
  const st2 = entryFor(d2.v3, STRATEGIES.SUBJECT_TO);
  assert.equal(st2.qualification_status, Q.DATA_REQUIRED);
  assert.notEqual(d2.v3.strategy_ranking.primary_strategy, STRATEGIES.SUBJECT_TO);
});

test('seller-finance with missing rent stays PROVISIONAL and cannot outrank an underwritten strategy', () => {
  const d = decide(SUBJECT, investorComps); // SFR subject has no rent
  const sf = entryFor(d.v3, STRATEGIES.SELLER_FINANCE);
  assert.equal(sf.qualification_status, Q.PROVISIONAL_SCENARIO);
  assert.equal(sf.scenario_only, true);
  const cash = entryFor(d.v3, STRATEGIES.CASH);
  assert.ok(cash.composite > sf.composite, 'underwritten cash outranks provisional seller-finance');
  assert.notEqual(d.v3.strategy_ranking.primary_strategy, STRATEGIES.SELLER_FINANCE);
});

test('ranking rules: DATA_REQUIRED and DISQUALIFIED are never primary or backup', () => {
  const d = decide(SUBJECT, investorComps);
  const { primary_strategy, backup_strategy, ranked } = d.v3.strategy_ranking;
  const statusOf = (s) => ranked.find((x) => x.strategy === s)?.qualification_status;
  for (const s of [primary_strategy, backup_strategy].filter(Boolean)) {
    if (s === STRATEGIES.NO_OFFER) continue;
    assert.notEqual(statusOf(s), Q.DATA_REQUIRED);
    assert.notEqual(statusOf(s), Q.DISQUALIFIED);
  }
  // lease option is reserved => DISQUALIFIED, never ranking-eligible
  assert.equal(statusOf(STRATEGIES.LEASE_OPTION), Q.DISQUALIFIED);
  assert.equal(entryFor(d.v3, STRATEGIES.LEASE_OPTION).ranking_eligible, false);
});

test('low ESS caps confidence and blocks auto-offer criteria', () => {
  const d = decide(SUBJECT, investorComps.slice(0, 2));
  assert.ok(d.v3.sample.effective_sample_size < 3);
  assert.equal(d.v3.auto_offer_ready_criteria_met, false);
  assert.equal(d.v3.execution_state, 'DATA_REQUIRED');
});

test('disabled flags => no execution eligibility anywhere', () => {
  const d = decide({ ...SUBJECT, estimated_value: 156000 }, [165000, 190000, 178000, 205000, 198000].map((p, i) => sfr(`h${i}`, p, { date: `2025-0${i + 4}-01` })));
  assert.equal(d.v3.auto_offer_eligible, false);
  assert.ok(d.v3.strategy_ranking.ranked.every((s) => s.execution_eligible === false));
});

test('V2 remains byte-identical with V3 disabled', () => {
  const dec = calculateAcquisitionDecision({ subject: SUBJECT, comps: investorComps, buyerPurchases: [], now: NOW, v3Enabled: false });
  assert.equal(dec.v3, null);
  assert.equal(dec.evidence.v3, null);
});
