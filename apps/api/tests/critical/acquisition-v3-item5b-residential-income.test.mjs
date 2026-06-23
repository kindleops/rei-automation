/**
 * Acquisition Engine V3 — Item 5B residential-income specialization.
 *
 * Deterministic coverage of the income contract, 2–4 unit + 5+ valuation,
 * NOI/cap/PPU/PPSF/GRM/EGIM math, repair double-count guard, buyer exit, and the
 * cash/novation/subject-to/commercial-debt/seller-finance strategies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ASSET_FAMILIES, VALUATION_UNIVERSES as U } from '@/lib/acquisition/modelConstants.js';
import { normalizeCandidate } from '@/lib/acquisition/compIdentityEnrichment.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
import {
  buildResidentialIncomeSubject,
  missingInputs,
  FIELD_BASIS,
} from '@/lib/acquisition/residentialIncomeContract.js';
import {
  computeNOI,
  valueFromCap,
  grm,
  egim,
  pricePerUnit,
  pricePerRentableSqft,
  dscr,
  resolveExpenseModel,
  resolveRentModel,
  buildOperatingStatement,
} from '@/lib/acquisition/incomeUnderwriting.js';
import { buildSmallMultiValuation } from '@/lib/acquisition/smallMultiValuation.js';
import { buildMultifamilyValuation } from '@/lib/acquisition/multifamilyValuation.js';
import { buildIncomeRepairStabilization } from '@/lib/acquisition/incomeRepairStabilization.js';
import {
  buildIncomeCashOffer,
  buildIncomeNovation,
  buildIncomeDebtStrategy,
  buildIncomeSellerFinance,
} from '@/lib/acquisition/incomeStrategies.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const Z = '75201';

// ---- Comp fixtures (income lanes) ------------------------------------------
const cand = (id, units, price, date, sqft) => ({
  comp_id: id, property_id: id, address: `${id} St`, zip: Z, city: 'Dallas', state: 'TX',
  latitude: 32.78, longitude: -96.79, sale_price: price, sale_date: date,
  asset_class: units >= 5 ? 'multifamily' : units === 4 ? 'fourplex' : units === 3 ? 'triplex' : 'duplex',
  property_type: units >= 5 ? 'Multifamily' : units === 4 ? 'Fourplex' : units === 3 ? 'Triplex' : 'Duplex',
  units_count: units, sqft, beds: units * 2, baths: units, year_built: 1988,
  building_condition: 'Average', construction_type: 'Frame', distance_miles: 1.2, similarity_score: 90,
});
const raw = (id, price) => ({ id, property_id: id, apn_parcel_id: `apn-${id}`, owner_name: `INV ${id} LLC`, owner_1_name: `INV ${id} LLC`, is_corporate_owner: true, owner_address_full: '1 Mail', document_type: '', last_sale_doc_type: 'Warranty Deed', recording_date: null, sale_price: price });
const comp = (id, units, price, date, sqft) => normalizeCandidate(cand(id, units, price, date, sqft), raw(id, price), null);

const DUPLEX = { property_id: 'd', property_type: 'Duplex', property_address_zip: Z, building_square_feet: 2400, units_count: 2, estimated_value: 300000, monthly_rent: 2600, tax_amt: 4200, year_built: 1986, building_condition: 'Average' };
const TRIPLEX = { ...DUPLEX, property_type: 'Triplex', units_count: 3, building_square_feet: 3300, estimated_value: 420000, monthly_rent: 3900 };
const FOURPLEX = { ...DUPLEX, property_type: 'Fourplex', units_count: 4, building_square_feet: 4400, estimated_value: 560000, monthly_rent: 5200 };
const MF12 = { property_id: 'm', property_type: 'Multifamily', property_address_zip: Z, building_square_feet: 11000, units_count: 12, estimated_value: 1500000, monthly_rent: 13800, tax_amt: 22000, year_built: 1979, building_condition: 'Average' };

const decide = (subject, comps, income) => buildV3Decision({ subjectRow: subject, qualification: qualifyComps(subject, comps), buyerPurchases: [], now: NOW, income }).v3;
const contractOf = (s, income) => buildResidentialIncomeSubject(s, income);

/* -------------------------------------------------------------------------- */
/* Contract                                                                    */
/* -------------------------------------------------------------------------- */

test('contract: missing values are UNKNOWN, never zero', () => {
  const c = contractOf(DUPLEX);
  assert.equal(c.payroll_annual.value, null);
  assert.equal(c.payroll_annual.basis, FIELD_BASIS.UNKNOWN);
  assert.equal(c.rent_roll.value, null);
  assert.equal(c.rent_roll.basis, FIELD_BASIS.UNKNOWN);
  assert.ok(missingInputs(c).includes('payroll_annual'));
});

test('contract: verified rent roll outranks subject estimate with KNOWN basis', () => {
  const c = contractOf(DUPLEX, { rent_roll: [{ beds: 2, baths: 1, current_rent: 1400 }, { beds: 2, baths: 1, current_rent: 1450 }] });
  assert.equal(c.current_gross_monthly_rent.value, 2850);
  assert.equal(c.current_gross_monthly_rent.source, 'verified_rent_roll');
  assert.equal(c.current_gross_monthly_rent.basis, FIELD_BASIS.KNOWN);
  assert.ok(Array.isArray(c.unit_mix.value));
});

/* -------------------------------------------------------------------------- */
/* NOI / EGI / cap math                                                        */
/* -------------------------------------------------------------------------- */

test('NOI excludes debt service, depreciation, income tax and capex', () => {
  const noi = computeNOI({ gprAnnual: 120000, otherIncomeAnnual: 5000, vacancyPct: 0.05, opexAnnual: 40000 });
  // NOI = EGI - opex ONLY. EGI = 120000 + 5000 - 6000 = 119000; NOI = 79000.
  assert.equal(noi.effective_gross_income, 119000);
  assert.equal(noi.noi, 79000);
  assert.deepEqual(noi.excludes, ['debt_service', 'depreciation', 'income_tax', 'capital_expenditures']);
});

test('vacancy reduces EGI and NOI', () => {
  const low = computeNOI({ gprAnnual: 120000, vacancyPct: 0.05, opexAnnual: 40000 });
  const high = computeNOI({ gprAnnual: 120000, vacancyPct: 0.15, opexAnnual: 40000 });
  assert.ok(high.effective_gross_income < low.effective_gross_income);
  assert.ok(high.noi < low.noi);
});

test('higher operating expenses reduce value; higher NOI raises value; higher cap reduces value', () => {
  const noiLowExp = computeNOI({ gprAnnual: 120000, vacancyPct: 0.05, opexAnnual: 30000 }).noi;
  const noiHighExp = computeNOI({ gprAnnual: 120000, vacancyPct: 0.05, opexAnnual: 60000 }).noi;
  assert.ok(valueFromCap(noiLowExp, 0.06) > valueFromCap(noiHighExp, 0.06), 'more expenses → lower value');
  assert.ok(valueFromCap(90000, 0.06) > valueFromCap(70000, 0.06), 'more NOI → higher value');
  assert.ok(valueFromCap(80000, 0.05) > valueFromCap(80000, 0.08), 'higher cap → lower value');
});

test('PPU / PPSF / GRM / EGIM compute correctly', () => {
  assert.equal(pricePerUnit(1200000, 12), 100000);
  assert.equal(pricePerRentableSqft(1100000, 11000), 100);
  assert.equal(grm(1080000, 120000), 9);
  assert.equal(egim(1190000, 119000), 10);
  assert.equal(dscr(90000, 60000), 1.5);
});

/* -------------------------------------------------------------------------- */
/* Rent / expense models — labeled assumptions                                 */
/* -------------------------------------------------------------------------- */

test('expense model uses actuals where present and LABELS modeled lines as assumed', () => {
  const c = contractOf(MF12, { expenses: { taxes: 22000 } });
  const m = resolveExpenseModel(c, { band: 'MF_5_20', egiAnnual: 150000, subjectValue: 1500000 });
  assert.equal(m.lines.taxes.basis, FIELD_BASIS.KNOWN);
  assert.equal(m.lines.management.basis, FIELD_BASIS.ASSUMED);
  assert.ok(m.assumed_lines.includes('management'));
  assert.ok(m.known_lines.includes('taxes'));
  // Not one universal ratio: small vs large bands differ.
  const small = resolveExpenseModel(contractOf(DUPLEX), { band: 'SMALL_MULTI', egiAnnual: 30000, subjectValue: 300000 });
  assert.notEqual(m.lines.management.source, small.lines.management.source);
});

test('rent model labels an assumed market rent and reports source lineage + missing inputs', () => {
  const c = contractOf(DUPLEX); // only a subject estimate, no market rents
  const r = resolveRentModel(c);
  assert.equal(r.market_basis, FIELD_BASIS.ASSUMED);
  assert.ok(r.missing_inputs.includes('market_rents'));
  assert.ok(r.source_lineage.length >= 1);
});

test('unsupported income remains provisional', () => {
  const c = contractOf({ ...DUPLEX, monthly_rent: undefined, rent_estimate: 2400 }); // only estimate
  const op = buildOperatingStatement(c, { lane: 'DUPLEX' });
  assert.equal(op.income_supported, false);
  assert.equal(op.provisional, true);
});

/* -------------------------------------------------------------------------- */
/* 2–4 unit valuation — exact comps + cross-unit fallback                      */
/* -------------------------------------------------------------------------- */

test('exact DUPLEX comps are Tier 1 and yield a QUALIFIED direct comparable', () => {
  const comps = [comp('a', 2, 295000, '2025-03-01', 2350), comp('b', 2, 305000, '2025-06-01', 2450), comp('c', 2, 300000, '2025-09-01', 2400)];
  const v3 = decide(DUPLEX, comps);
  const ri = v3.residential_income;
  assert.equal(ri.family, ASSET_FAMILIES.SMALL_MULTI);
  assert.equal(ri.valuation.comp_tier, 'TIER_1_EXACT_UNIT');
  assert.equal(ri.valuation.exact_unit_comp_count, 3);
  assert.equal(ri.valuation.values.direct_adjusted_comparable.value_classification, 'QUALIFIED');
});

test('exact TRIPLEX comps are Tier 1', () => {
  const comps = [comp('a', 3, 410000, '2025-03-01', 3200), comp('b', 3, 425000, '2025-06-01', 3350), comp('c', 3, 418000, '2025-09-01', 3300)];
  const v3 = decide(TRIPLEX, comps);
  assert.equal(v3.canonical_asset_lane, 'TRIPLEX');
  assert.equal(v3.residential_income.valuation.comp_tier, 'TIER_1_EXACT_UNIT');
  assert.equal(v3.residential_income.valuation.exact_unit_comp_count, 3);
});

test('exact FOURPLEX comps are Tier 1', () => {
  const comps = [comp('a', 4, 550000, '2025-03-01', 4300), comp('b', 4, 565000, '2025-06-01', 4450), comp('c', 4, 558000, '2025-09-01', 4400)];
  const v3 = decide(FOURPLEX, comps);
  assert.equal(v3.canonical_asset_lane, 'FOURPLEX');
  assert.equal(v3.residential_income.valuation.comp_tier, 'TIER_1_EXACT_UNIT');
});

test('cross-unit fallback is explicit, confidence-reduced and NOT autonomously eligible', () => {
  // Duplex subject but only triplex comps available → cross-unit fallback.
  const comps = [comp('a', 3, 410000, '2025-03-01', 3200), comp('b', 3, 425000, '2025-06-01', 3350), comp('c', 3, 418000, '2025-09-01', 3300)];
  const v3 = decide(DUPLEX, comps);
  const f = v3.residential_income.valuation.cross_unit_fallback;
  assert.equal(f.used, true);
  assert.equal(f.autonomous_eligible, false);
  assert.ok(f.confidence_penalty > 0);
  assert.equal(v3.residential_income.valuation.comp_tier, 'FALLBACK_CROSS_UNIT');
  assert.notEqual(v3.residential_income.valuation.values.direct_adjusted_comparable.value_classification, 'QUALIFIED');
});

/* -------------------------------------------------------------------------- */
/* 5+ multifamily — size-band isolation, ARV never dominant                    */
/* -------------------------------------------------------------------------- */

test('MF5+ never uses residential ARV as the dominant model', () => {
  const comps = [comp('a', 12, 1450000, '2025-03-01', 10800), comp('b', 14, 1600000, '2025-06-01', 12000), comp('c', 11, 1400000, '2025-09-01', 10200)];
  const v3 = decide(MF12, comps);
  const ri = v3.residential_income;
  assert.equal(ri.family, ASSET_FAMILIES.MULTIFAMILY);
  assert.equal(ri.valuation.residential_arv_dominant, false);
  assert.equal(ri.valuation.dominant_model, 'STABILIZED_NOI_MARKET_CAP');
});

test('a six-unit does NOT use 100+ unit properties as primary comps', () => {
  const subject6 = { ...MF12, units_count: 6, building_square_feet: 5400, estimated_value: 720000, monthly_rent: 6600 };
  const comps = [comp('big1', 180, 28000000, '2025-03-01', 170000), comp('big2', 220, 35000000, '2025-06-01', 210000)];
  const v3 = decide(subject6, comps);
  const ri = v3.residential_income;
  assert.equal(ri.valuation.size_band, 'MF_5_20');
  assert.equal(ri.valuation.same_band_comp_count, 0, '100+ comps are not same-band');
  // With no same-band comps the model must not silently treat 100+ as primary;
  // either it falls back (adjacent) explicitly or has no qualified comp value.
  assert.equal(ri.valuation.values.comparable_income_transactions.value_classification !== 'QUALIFIED', true);
});

test('adjacent-band fallback (when used) is explicit, size-adjusted and non-autonomous', () => {
  // 18-unit subject (MF_5_20) with only 24/28-unit (MF_21_99) comps, priced
  // within the subject anchor multiple so they survive as REVIEW fallback comps.
  const subject18 = { ...MF12, units_count: 18, building_square_feet: 16200, estimated_value: 2400000, monthly_rent: 19800 };
  const comps = [comp('a', 24, 3000000, '2025-03-01', 22000), comp('b', 28, 3600000, '2025-06-01', 26000)];
  const v3 = decide(subject18, comps);
  const val = v3.residential_income.valuation;
  assert.equal(val.size_band, 'MF_5_20');
  assert.equal(val.same_band_comp_count, 0);
  const fb = val.size_band_fallback;
  assert.equal(fb.used, true);
  assert.equal(fb.autonomous_eligible, false);
  assert.ok(fb.adjacent_bands.includes('MF_21_99'));
});

/* -------------------------------------------------------------------------- */
/* Repair double-count guard                                                   */
/* -------------------------------------------------------------------------- */

test('repairs are not double-counted across valuation / offer / income', () => {
  const repair = { repair_mid: 100000, stabilization_capex: 50000, replacement_reserve_annual: 6000, repair_confidence: 55, missing_repair_inputs: [] };
  const rs = buildIncomeRepairStabilization(repair, contractOf(MF12));
  // One-time categories sum to the one-time total (no inflation).
  const sum = Object.values(rs.one_time_categories).reduce((s, v) => s + v, 0);
  assert.equal(sum, rs.one_time_total);
  // Stabilization and recurring reserves are tracked separately, never merged.
  assert.equal(rs.double_count_guard.offer_stabilization, 50000);
  assert.ok(rs.double_count_guard.excluded_from_baseline.includes('optional_value_add_renovation'));
  // The cash bridge consumes EXACTLY one-time + stabilization (not optional value-add).
  const cash = buildIncomeCashOffer({ buyerExit: { conservative_exit: 800000, confidence: 60 }, repairStab: rs, family: ASSET_FAMILIES.MULTIFAMILY, demand: 50, confidence: 60 });
  const repairLine = cash.bridge.find((b) => b.line === 'one_time_repairs').amount;
  const stabLine = cash.bridge.find((b) => b.line === 'stabilization_capex').amount;
  assert.equal(repairLine, -rs.one_time_total);
  assert.equal(stabLine, -50000);
});

/* -------------------------------------------------------------------------- */
/* Strategies                                                                  */
/* -------------------------------------------------------------------------- */

test('2–4 retail/owner-occupant demand may support novation', () => {
  const comps = [comp('a', 2, 295000, '2025-03-01', 2350), comp('b', 2, 305000, '2025-06-01', 2450), comp('c', 2, 300000, '2025-09-01', 2400),
    // an MLS retail resale to populate the retail universe
    normalizeCandidate({ ...cand('r1', 2, 360000, '2025-05-01', 2400), mls_sold_price: 360000 }, { id: 'r1', apn_parcel_id: 'apn-r1', owner_name: 'Jane Buyer', owner_1_name: 'Jane Buyer', is_corporate_owner: false, last_sale_doc_type: 'Warranty Deed', sale_price: 360000, mls_sold_price: 360000 }, null)];
  const v3 = decide(DUPLEX, comps);
  const nov = v3.residential_income.strategies.novation;
  assert.equal(nov.applicable, true);
  assert.notEqual(nov.qualification, 'DISQUALIFIED');
});

test('5+ receives NO residential novation (separate commercial disposition)', () => {
  const nov = buildIncomeNovation({ family: ASSET_FAMILIES.MULTIFAMILY, valuation: {}, buyerExit: {}, cashRecommended: 1000000 });
  assert.equal(nov.applicable, false);
  assert.equal(nov.qualification, 'DISQUALIFIED');
  assert.equal(nov.alternative_strategy, 'COMMERCIAL_MARKETED_DISPOSITION');
});

test('residential subject-to requires verified debt', () => {
  const noDebt = buildIncomeDebtStrategy({ family: ASSET_FAMILIES.SMALL_MULTI, contract: contractOf(DUPLEX), operatingStatement: null });
  assert.equal(noDebt.debt_model, 'RESIDENTIAL_SUBJECT_TO');
  assert.equal(noDebt.qualification, 'DATA_REQUIRED');
  assert.equal(noDebt.verified_debt, false);

  const withDebt = buildIncomeDebtStrategy({
    family: ASSET_FAMILIES.SMALL_MULTI,
    contract: contractOf(DUPLEX, { debt: { balance: 220000, monthly_payment: 1500, interest_rate: 0.045 } }),
    operatingStatement: { current_noi: { noi: 28000 } },
  });
  assert.equal(withDebt.verified_debt, true);
  assert.notEqual(withDebt.qualification, 'DATA_REQUIRED');
});

test('5+ debt takeover is labeled COMMERCIAL, never residential subject-to', () => {
  const c = contractOf(MF12, { debt: { balance: 900000, monthly_payment: 5200, maturity_date: '2029-06-01', balloon_months: 60, recourse: false, assumable: true } });
  const d = buildIncomeDebtStrategy({ family: ASSET_FAMILIES.MULTIFAMILY, contract: c, operatingStatement: { current_noi: { noi: 95000 } } });
  assert.equal(d.debt_model, 'COMMERCIAL_DEBT_TAKEOVER');
  assert.equal(d.is_residential_subject_to, false);
  assert.equal(d.commercial_terms.balloon_months, 60);
  assert.equal(d.commercial_terms.assumable, true);
  assert.ok(d.debt_yield !== null);
});

test('seller-finance produces a structure that satisfies the target DSCR when NOI is strong', () => {
  const valuation = { values: { stabilized_noi_market_cap: { available: true, mid: 1000000 } }, operating_statement: { income_supported: true, current_noi: { noi: 120000 } } };
  const sf = buildIncomeSellerFinance({ valuation, operatingStatement: valuation.operating_statement, family: ASSET_FAMILIES.MULTIFAMILY });
  const anySatisfies = Object.values(sf.structures).some((s) => s.satisfies_target_dscr);
  assert.equal(anySatisfies, true);
  assert.equal(sf.qualification, 'UNDERWRITTEN_SHADOW');
  // Each structure reports DSCR, cash-on-cash and a down payment.
  assert.ok(sf.structures.balanced.dscr !== null);
  assert.ok(sf.structures.balanced.cash_on_cash !== null);
  assert.ok(sf.structures.balanced.down_payment > 0);
});

test('seller-finance on unsupported income stays provisional', () => {
  const valuation = { values: { direct_adjusted_comparable: { available: true, mid: 300000 } }, operating_statement: { income_supported: false, current_noi: { noi: 18000 } } };
  const sf = buildIncomeSellerFinance({ valuation, operatingStatement: valuation.operating_statement, family: ASSET_FAMILIES.SMALL_MULTI });
  assert.equal(sf.qualification, 'PROVISIONAL_SCENARIO');
  assert.ok(sf.note);
});

/* -------------------------------------------------------------------------- */
/* Integration & safety                                                        */
/* -------------------------------------------------------------------------- */

test('income families produce a residential_income block; SFR does not', () => {
  const comps = [comp('a', 2, 295000, '2025-03-01', 2350), comp('b', 2, 305000, '2025-06-01', 2450), comp('c', 2, 300000, '2025-09-01', 2400)];
  const v3 = decide(DUPLEX, comps);
  assert.ok(v3.residential_income);
  const sfr = decide({ property_id: 's', property_type: 'Single Family', property_address_zip: Z, building_square_feet: 1400, units_count: 1, estimated_value: 200000 }, []);
  assert.equal(sfr.residential_income, null);
});

test('no outbound execution / auto-offer is enabled for income assets', () => {
  const comps = [comp('a', 12, 1450000, '2025-03-01', 10800), comp('b', 14, 1600000, '2025-06-01', 12000), comp('c', 11, 1400000, '2025-09-01', 10200)];
  const v3 = decide(MF12, comps);
  assert.equal(v3.auto_offer_eligible, false);
  assert.equal(v3.active_feature_flags.ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER, false);
  assert.equal(v3.active_feature_flags.ACQUISITION_ENGINE_V3_ALLOW_AUTO_CREATIVE, false);
});

test('income strategy qualifications never emit an AUTO state', () => {
  const comps = [comp('a', 2, 295000, '2025-03-01', 2350), comp('b', 2, 305000, '2025-06-01', 2450), comp('c', 2, 300000, '2025-09-01', 2400)];
  const v3 = decide(DUPLEX, comps);
  const strat = v3.residential_income.strategies;
  const quals = [strat.cash.qualification, strat.novation.qualification, strat.debt_strategy.qualification, strat.seller_finance.qualification];
  for (const q of quals) {
    assert.ok(!/AUTO/.test(String(q)), `qualification ${q} must not be an AUTO state`);
  }
});
