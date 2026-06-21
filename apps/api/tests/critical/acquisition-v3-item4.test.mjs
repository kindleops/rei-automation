/**
 * Acquisition Engine V3 — Item 4 (valuation universes + offer engines) tests.
 * Deterministic, pure-module tests for the behaviors mandated in Item 4 §17.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VALUE_CLASSIFICATION as VC,
  VALUATION_UNIVERSES as U,
  ASSET_FAMILIES,
} from '@/lib/acquisition/modelConstants.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { buildValuationUniverses } from '@/lib/acquisition/valuationUniverses.js';
import { reconcileValuation } from '@/lib/acquisition/valuationReconciliation.js';
import { buildCashOffer } from '@/lib/acquisition/offerEconomics.js';
import { buildNovation } from '@/lib/acquisition/novationModel.js';
import { buildSubjectTo } from '@/lib/acquisition/subjectToModel.js';
import { buildSellerFinance } from '@/lib/acquisition/sellerFinanceModel.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
import { calculateAcquisitionDecision } from '@/lib/acquisition/acquisitionDecisionEngine.js';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const ZIP = '75201';

function sfr(id, price, { mls = false, buyer = '', date = '2025-06-01', sqft = 1400 } = {}) {
  return {
    property_id: id,
    property_address_full: `${id} Test St, Dallas, TX ${ZIP}`,
    property_address_zip: ZIP,
    property_address_city: 'Dallas',
    property_type: 'Single Family',
    units_count: 1,
    building_square_feet: sqft,
    total_bedrooms: 3,
    year_built: 1995,
    sale_price: price,
    sale_date: date,
    ...(mls ? { mls_sold_price: price, mls_sold_date: date, sale_price_source: 'MLS' } : {}),
    ...(buyer ? { buyer_name_clean: buyer } : {}),
  };
}

const investorComps = [
  sfr('i1', 175000, { buyer: 'ACME HOMES LLC', date: '2025-03-01' }),
  sfr('i2', 182000, { buyer: 'REI CAPITAL LLC', date: '2025-05-01' }),
  sfr('i3', 178000, { buyer: 'BLUE DOOR INVESTMENTS LLC', date: '2025-07-01' }),
  sfr('i4', 185000, { buyer: 'ACME HOMES LLC', date: '2025-09-01' }),
];
const retailComps = [
  sfr('r1', 225000, { mls: true, date: '2025-03-15' }),
  sfr('r2', 235000, { mls: true, date: '2025-05-15' }),
  sfr('r3', 228000, { mls: true, date: '2025-07-15' }),
  sfr('r4', 240000, { mls: true, date: '2025-09-15' }),
];

const SUBJECT = {
  property_id: 'subj',
  property_type: 'Single Family',
  property_address_zip: ZIP,
  building_square_feet: 1400,
  units_count: 1,
  estimated_value: 200000,
};

test('investor universe leads wholesale exit when strong qualified investor evidence exists', () => {
  const q = qualifyComps(SUBJECT, [...investorComps, ...retailComps]);
  const { universes, family } = buildValuationUniverses(SUBJECT, q, [], NOW);
  const recon = reconcileValuation(universes, family);
  assert.ok(universes[U.LOCAL_INVESTOR_VALUE].available);
  assert.ok(universes[U.RETAIL_MLS_VALUE].available);
  assert.equal(recon.investor_exit_classification, VC.QUALIFIED);
  assert.equal(recon.investor_exit_derived_from, null, 'investor exit must come from investor txns, not a retail discount');
  assert.ok(recon.base_investor_exit < universes[U.RETAIL_MLS_VALUE].mid, 'investor exit below retail');
});

test('MLS leads novation valuation when retail evidence is strong', () => {
  const subject = { ...SUBJECT, estimated_value: 235000 };
  const comps = [...retailComps, sfr('r5', 232000, { mls: true, date: '2025-10-01' }), sfr('i9', 200000, { buyer: 'X LLC' })];
  const q = qualifyComps(subject, comps);
  const { universes, family } = buildValuationUniverses(subject, q, [], NOW);
  const recon = reconcileValuation(universes, family);
  const nov = buildNovation({ retailUniverse: universes[U.RETAIL_MLS_VALUE], subjectRow: subject, cashSellerNet: 150000, buyerDemand: 70 });
  assert.equal(recon.dominant_model, U.RETAIL_MLS_VALUE);
  assert.ok(nov.available);
  assert.equal(nov.expected_sale_price, universes[U.RETAIL_MLS_VALUE].mid, 'novation prices off the retail universe');
});

test('package transactions contribute demand but NOT price', () => {
  const q = qualifyComps(SUBJECT, investorComps);
  const noEvents = buildV3Decision({ subjectRow: SUBJECT, qualification: q, buyerPurchases: [], now: NOW });
  const institutionalPackage = Array.from({ length: 8 }, (_, i) => ({
    buyer_key: 'INVITATION HOMES LP',
    buyer_name: 'Invitation Homes',
    is_corporate_buyer: true,
    property_zip: ZIP,
    units_count: 1,
    purchase_price: 95000000, // package consideration — demand signal only
    purchase_date: '2025-08-01',
  }));
  const withEvents = buildV3Decision({ subjectRow: SUBJECT, qualification: q, buyerPurchases: institutionalPackage, now: NOW });
  assert.equal(
    withEvents.v3.reconciliation.reconciled_market_value_mid,
    noEvents.v3.reconciliation.reconciled_market_value_mid,
    'valuation is identical regardless of buyer-event package',
  );
  assert.ok(
    withEvents.v3.buyer_exit.buyer_demand_score > noEvents.v3.buyer_exit.buyer_demand_score,
    'package buyer events raise demand only',
  );
});

test('subject anchor never becomes a qualified valuation or an authorized offer', () => {
  const subject = { ...SUBJECT, estimated_value: 309000 };
  const contaminated = [sfr('bad', 30191000)];
  const q = qualifyComps(subject, contaminated);
  const d = buildV3Decision({ subjectRow: subject, qualification: q, buyerPurchases: [], now: NOW });
  assert.equal(d.v3.value_classification, VC.SUBJECT_ANCHOR_SCENARIO);
  assert.equal(d.surfaced.recommended_cash_offer, null, 'zero accepted comps -> no authorized offer');
  assert.equal(d.v3.auto_offer_eligible, false);
  assert.notEqual(d.v3.execution_state, 'AUTO_OFFER_READY');
});

test('low effective sample size cannot meet auto-offer criteria', () => {
  const q = qualifyComps(SUBJECT, investorComps.slice(0, 2)); // ess 2
  const d = buildV3Decision({ subjectRow: SUBJECT, qualification: q, buyerPurchases: [], now: NOW });
  assert.ok(d.v3.sample.effective_sample_size < 3);
  assert.equal(d.v3.auto_offer_ready_criteria_met, false);
  assert.equal(d.surfaced.recommended_cash_offer, null);
  assert.equal(d.v3.execution_state, 'DATA_REQUIRED');
});

test('investor/retail disagreement is preserved and explained, not averaged away', () => {
  const subject = { ...SUBJECT, estimated_value: 190000 };
  const lowInvestor = [sfr('i1', 120000, { buyer: 'A LLC', date: '2025-04-01' }), sfr('i2', 122000, { buyer: 'B LLC', date: '2025-06-01' }), sfr('i3', 118000, { buyer: 'C LLC', date: '2025-08-01' })];
  const highRetail = [sfr('r1', 258000, { mls: true, date: '2025-04-15' }), sfr('r2', 262000, { mls: true, date: '2025-06-15' }), sfr('r3', 260000, { mls: true, date: '2025-08-15' })];
  const q = qualifyComps(subject, [...lowInvestor, ...highRetail]);
  const { universes, family } = buildValuationUniverses(subject, q, [], NOW);
  const recon = reconcileValuation(universes, family);
  assert.ok(recon.model_disagreement_score >= 30, `expected high disagreement, got ${recon.model_disagreement_score}`);
  assert.ok(universes[U.LOCAL_INVESTOR_VALUE].available && universes[U.RETAIL_MLS_VALUE].available);
  assert.ok(recon.reasoning.join(' ').includes('model_disagreement'));
});

test('cash offer: bridge balances, no double-counted costs, never exceeds conservative exit', () => {
  const repair = { repair_mid: 25000, immediate_repairs: 15000 };
  const offer = buildCashOffer({ conservativeBuyerExit: 200000, repair, family: ASSET_FAMILIES.RESIDENTIAL_SINGLE, buyerDemand: 60, confidence: 70, expectedDays: 60 });
  assert.ok(offer.available);
  assert.equal(offer.cost_breakdown.buyer_repairs, 25000, 'rehab counted once');
  // bridge: exit + sum(negatives) === maximum_safe (last step)
  const exit = offer.bridge[0].amount;
  const sumNeg = offer.bridge.slice(1, -1).reduce((s, b) => s + b.amount, 0);
  assert.equal(exit + sumNeg, offer.bridge[offer.bridge.length - 1].amount);
  assert.ok(offer.recommended_cash_offer <= offer.maximum_cash_offer);
  assert.ok(offer.maximum_cash_offer <= offer.conservative_buyer_exit);
});

test('assignment margin is dynamic by liquidity and price band (not a fixed $15k)', () => {
  const repair = { repair_mid: 10000 };
  const lowLiq = buildCashOffer({ conservativeBuyerExit: 200000, repair, family: ASSET_FAMILIES.RESIDENTIAL_SINGLE, buyerDemand: 15, confidence: 40, expectedDays: 140 });
  const highLiq = buildCashOffer({ conservativeBuyerExit: 200000, repair, family: ASSET_FAMILIES.RESIDENTIAL_SINGLE, buyerDemand: 90, confidence: 85, expectedDays: 30 });
  const bigPrice = buildCashOffer({ conservativeBuyerExit: 1500000, repair, family: ASSET_FAMILIES.RESIDENTIAL_SINGLE, buyerDemand: 60, confidence: 70, expectedDays: 60 });
  assert.notEqual(lowLiq.margin_pct_used, highLiq.margin_pct_used);
  assert.ok(lowLiq.margin_pct_used > highLiq.margin_pct_used, 'low liquidity demands higher margin');
  assert.notEqual(highLiq.margin_pct_used, bigPrice.margin_pct_used);
  assert.notEqual(lowLiq.projected_assignment_fee, 15000);
});

test('novation fails when retail depth/liquidity is insufficient', () => {
  const thinRetail = { available: true, value_classification: VC.QUALIFIED, mid: 240000, effective_sample_size: 1, confidence: 70 };
  const nov = buildNovation({ retailUniverse: thinRetail, subjectRow: SUBJECT, cashSellerNet: 150000, buyerDemand: 60 });
  assert.equal(nov.available, false);
  assert.ok(nov.novation_disqualifiers.includes('insufficient_retail_depth'));
});

test('novation compares seller net vs cash net and reports company net', () => {
  const retail = { available: true, value_classification: VC.QUALIFIED, mid: 260000, effective_sample_size: 5, confidence: 75 };
  const nov = buildNovation({ retailUniverse: retail, subjectRow: SUBJECT, cashSellerNet: 150000, buyerDemand: 80 });
  assert.ok(nov.available);
  assert.ok(typeof nov.expected_seller_net === 'number');
  assert.ok(typeof nov.novation_company_net === 'number');
  assert.equal(nov.cash_seller_net, 150000);
  assert.ok(nov.seller_net_advantage_vs_cash !== null);
});

test('subject-to remains non-executable with missing debt information', () => {
  const st = buildSubjectTo({ subjectRow: { ...SUBJECT }, marketRentMonthly: 1500, reconciliation: { reconciled_market_value_mid: 200000 } });
  assert.equal(st.available, false);
  assert.equal(st.executable, false);
  assert.equal(st.execution_state, 'DATA_REQUIRED');
  assert.ok(st.missing_required_information.includes('total_loan_balance'));
});

test('subject-to fails stressed DSCR', () => {
  const subjectRow = { ...SUBJECT, total_loan_balance: 200000, total_loan_payment: 1800, tax_amt: 3600 };
  const st = buildSubjectTo({ subjectRow, marketRentMonthly: 1500, reconciliation: { reconciled_market_value_mid: 200000 } });
  assert.equal(st.executable, false);
  assert.ok(st.subject_to_disqualifiers.includes('fails_stressed_dscr'));
});

test('seller-finance solves terms toward target DSCR with labeled assumptions', () => {
  const recon = { reconciled_market_value_mid: 300000, reconciled_market_value_high: 320000 };
  const sf = buildSellerFinance({ reconciliation: recon, subjectRow: { ...SUBJECT, monthly_rent: 4000 }, marketRentMonthly: 4000, family: ASSET_FAMILIES.SMALL_MULTI });
  assert.ok(sf.available);
  assert.equal(sf.structures.length, 3);
  const feasible = sf.structures.filter((s) => s.feasible && s.dscr != null);
  assert.ok(feasible.length >= 1, 'at least one feasible structure');
  assert.ok(feasible.some((s) => s.dscr >= 1.2), 'a structure hits the target DSCR band');
  assert.ok(sf.labels.assumptions.length > 0, 'assumptions labeled');
});

test('no outbound execution path is activated (flags off, not eligible)', () => {
  const q = qualifyComps(SUBJECT, [...investorComps, ...retailComps]);
  const d = buildV3Decision({ subjectRow: SUBJECT, qualification: q, buyerPurchases: [], now: NOW });
  assert.equal(d.v3.active_feature_flags.ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER, false);
  assert.equal(d.v3.auto_offer_eligible, false);
});

test('V2 remains byte-identical when V3 is disabled', () => {
  const decision = calculateAcquisitionDecision({ subject: SUBJECT, comps: investorComps, buyerPurchases: [], now: NOW, v3Enabled: false });
  assert.equal(decision.v3, null);
  assert.equal(decision.evidence.v3, null);
});
