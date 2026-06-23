/**
 * Acquisition Engine V3 — Item 4.5 §4 mathematical consistency (table-driven).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ASSET_FAMILIES } from '@/lib/acquisition/modelConstants.js';
import { buildCashOffer } from '@/lib/acquisition/offerEconomics.js';
import { buildNovation } from '@/lib/acquisition/novationModel.js';
import { buildSubjectTo } from '@/lib/acquisition/subjectToModel.js';
import { buildSellerFinance } from '@/lib/acquisition/sellerFinanceModel.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { amortizedPayment, remainingBalance, npv, irr } from '@/lib/acquisition/acquisitionMath.js';

const RES = ASSET_FAMILIES.RESIDENTIAL_SINGLE;
const co = (over = {}) => buildCashOffer({ conservativeBuyerExit: 200000, repair: { repair_mid: 20000 }, family: RES, buyerDemand: 60, confidence: 70, expectedDays: 60, ...over });

test('cash: recommended <= maximum <= conservative exit; opening <= recommended; costs >= 0', () => {
  for (const exit of [80000, 150000, 250000, 600000, 1500000]) {
    const o = co({ conservativeBuyerExit: exit });
    assert.ok(o.recommended_cash_offer <= o.maximum_cash_offer);
    assert.ok(o.maximum_cash_offer <= o.conservative_buyer_exit);
    assert.ok(o.opening_cash_offer <= o.recommended_cash_offer);
    for (const v of Object.values(o.cost_breakdown)) assert.ok(v >= 0, 'no negative cost');
  }
});

test('cash: repair monotonicity — more repairs never increases the maximum offer', () => {
  let prev = Infinity;
  for (const r of [0, 10000, 25000, 50000, 80000]) {
    const o = co({ repair: { repair_mid: r } });
    assert.ok(o.maximum_cash_offer <= prev + 1, `repair ${r} raised offer`);
    prev = o.maximum_cash_offer;
  }
});

test('cash: buyer-exit monotonicity — higher exit never decreases the offer', () => {
  let prev = -Infinity;
  for (const e of [100000, 150000, 200000, 300000, 500000]) {
    const o = co({ conservativeBuyerExit: e });
    assert.ok(o.recommended_cash_offer >= prev - 1, `exit ${e} lowered offer`);
    prev = o.recommended_cash_offer;
  }
});

test('cash: margin monotonicity — lower liquidity raises margin and lowers the offer', () => {
  const low = co({ buyerDemand: 10, confidence: 40 });
  const high = co({ buyerDemand: 90, confidence: 85 });
  assert.ok(low.margin_pct_used > high.margin_pct_used);
  assert.ok(low.maximum_cash_offer < high.maximum_cash_offer);
});

test('cash: bridge reconciles and no cost is deducted twice', () => {
  const o = co({ conservativeBuyerExit: 250000, repair: { repair_mid: 30000 } });
  const exit = o.bridge[0].amount;
  const negatives = o.bridge.slice(1, -1);
  const sumNeg = negatives.reduce((s, b) => s + b.amount, 0);
  assert.equal(exit + sumNeg, o.bridge[o.bridge.length - 1].amount);
  // each cost category appears exactly once in the bridge
  const steps = negatives.map((b) => b.step);
  assert.equal(new Set(steps).size, steps.length);
  assert.equal(o.cost_breakdown.buyer_repairs, 30000);
});

test('amortization / balloon / npv / irr are mathematically correct', () => {
  const pmt = amortizedPayment(200000, 0.06, 360);
  assert.ok(Math.abs(pmt - 1199.1) < 1.0, `pmt ~1199.10, got ${pmt}`);
  assert.ok(remainingBalance(200000, 0.06, 360, 0) === 200000);
  assert.ok(remainingBalance(200000, 0.06, 360, 360) < 1, 'fully amortized ~ 0');
  assert.equal(amortizedPayment(120000, 0, 360), 120000 / 360, 'zero-rate is linear');
  assert.ok(Math.abs(npv(0, [-100, 50, 50, 50]) - 50) < 1e-9);
  const r = irr([-100, 60, 60]);
  assert.ok(r > 0.12 && r < 0.14, `irr ~0.13, got ${r}`);
});

test('income value uses NOI / cap rate (not gross rent)', () => {
  const subject = { property_type: 'Single Family', estimated_value: 380000, building_square_feet: 1600, units_count: 1, noi_estimate: 24000, cap_rate: 0.06 };
  const q = qualifyComps(subject, []);
  const { v3 } = buildV3Decision({ subjectRow: subject, qualification: q, buyerPurchases: [], now: new Date('2026-06-20') });
  const inc = v3.universes.INCOME_VALUE;
  assert.ok(inc.available);
  assert.equal(inc.mid, Math.round(24000 / 0.06)); // 400000, NOT rent-based
  assert.equal(inc.cap_rate_used, 0.06);
});

test('subject-to: DSCR consistent units; stressed never better than base', () => {
  const subjectRow = { estimated_value: 320000, total_loan_balance: 180000, total_loan_payment: 1250, tax_amt: 4200, monthly_rent: 3200 };
  const st = buildSubjectTo({ subjectRow, marketRentMonthly: 3200, reconciliation: { reconciled_market_value_mid: 315000 } });
  assert.ok(st.dscr > 0);
  // DSCR is monthly NOI / monthly payment == annual / annual
  const approxAnnual = (st.monthly_noi * 12) / (1250 * 12);
  assert.ok(Math.abs(approxAnnual - st.dscr) < 0.01);
  assert.ok(st.stressed_dscr <= st.dscr, 'adverse stress cannot improve DSCR');
});

test('seller-finance: payment matches amortization; balloon correct; CoC uses cash invested', () => {
  const recon = { reconciled_market_value_mid: 300000, reconciled_market_value_high: 320000 };
  const sf = buildSellerFinance({ reconciliation: recon, subjectRow: { monthly_rent: 4000 }, marketRentMonthly: 4000, family: ASSET_FAMILIES.SMALL_MULTI });
  for (const s of sf.structures) {
    const expectedPmt = Math.round(amortizedPayment(s.financed_balance, s.interest_rate, s.amortization_months));
    assert.ok(Math.abs(expectedPmt - s.monthly_principal_interest) <= 1, `${s.structure} payment mismatch`);
    const expectedBalloon = Math.round(remainingBalance(s.financed_balance, s.interest_rate, s.amortization_months, s.balloon_months));
    assert.ok(Math.abs(expectedBalloon - s.balloon_balance) <= 2, `${s.structure} balloon mismatch`);
    if (s.cash_on_cash_return != null && s.dscr != null) {
      const noi = 4000 * 12 * 0.55;
      const annualCF = noi - s.monthly_principal_interest * 12;
      const coc = annualCF / s.down_payment;
      assert.ok(Math.abs(coc - s.cash_on_cash_return) < 0.01, 'CoC uses actual cash invested (down payment)');
    }
  }
});

test('novation: seller net + company net + costs reconcile to sale proceeds', () => {
  const retail = { available: true, value_classification: 'QUALIFIED', mid: 260000, effective_sample_size: 5, confidence: 75 };
  const nov = buildNovation({ retailUniverse: retail, subjectRow: {}, cashSellerNet: 150000, buyerDemand: 80 });
  const c = nov.cost_breakdown;
  const reconstructed = nov.expected_seller_net + c.agent + c.seller_closing + c.prep_allowance + c.holding + c.company_fee;
  assert.ok(Math.abs(reconstructed - nov.expected_sale_price) <= 2, 'proceeds reconcile');
  assert.equal(nov.novation_company_net, c.company_fee);
});

test('all monetary outputs are whole dollars (not cents/mixed units)', () => {
  const o = co({ conservativeBuyerExit: 237913 });
  for (const k of ['recommended_cash_offer', 'maximum_cash_offer', 'conservative_buyer_exit', 'projected_assignment_fee']) {
    assert.equal(o[k], Math.round(o[k]), `${k} must be whole dollars`);
  }
});
