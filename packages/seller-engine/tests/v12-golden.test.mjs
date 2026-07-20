// Golden tests for the EXACT V12 port. Every expectation below is derived by
// hand from the sanitized source (sha 89adfaeb…); these tests pin legacy
// behavior INCLUDING its quirks. If one of these fails, the port drifted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcFinancialPressure_, calcUrgency_, contactabilityScore_, equityBonus_,
  priorityScore_, priorityTierFromScore_, followUpCadence_, phoneConfidenceBucket_,
  scoreContactFallback_, scorePhoneFallback_, scoreEmailFinal_, normalizeLinkageScore_,
  scoreV12Owner, classifyOwnerType_,
} from '../scores/v12Baseline.mjs';

const base = () => ({
  tax_delinquent_count: 0, oldest_tax_delinquent_year: 0,
  portfolio_total_value: 0, portfolio_total_equity: 0, portfolio_total_loan_balance: 0,
  best_buying_power: '', best_income: '', best_net_asset: '',
  seller_tags_text: '', last_sale_doc_type: '', max_ownership_years: 5,
  distress_marker_count: 0, is_absentee: false, active_lien_count: 0, property_count: 1,
  best_contact_score: 0, best_phone_score: 0,
});

test('golden: tax delinquency — FP +35 for any count; +8 at 2y depth; +15 at 3y (2026 hardcoded)', () => {
  assert.equal(calcFinancialPressure_({ ...base(), tax_delinquent_count: 1 }), 35);
  assert.equal(calcFinancialPressure_({ ...base(), tax_delinquent_count: 1, oldest_tax_delinquent_year: 2024 }), 43);
  assert.equal(calcFinancialPressure_({ ...base(), tax_delinquent_count: 1, oldest_tax_delinquent_year: 2022 }), 50);
});

test('golden: multiple delinquency years — urgency ladder 15/25/40', () => {
  assert.equal(calcUrgency_({ ...base(), tax_delinquent_count: 1 }), 15);
  assert.equal(calcUrgency_({ ...base(), tax_delinquent_count: 1, oldest_tax_delinquent_year: 2024 }), 25);
  assert.equal(calcUrgency_({ ...base(), tax_delinquent_count: 1, oldest_tax_delinquent_year: 2021 }), 40);
});

test('golden: tax delinquent DOUBLE COUNT — count term + tag term stack (+35 +30)', () => {
  const o = { ...base(), tax_delinquent_count: 1, seller_tags_text: 'Tax Delinquent' };
  assert.equal(calcFinancialPressure_(o), 65);
});

test('golden: high LTV bands 8/15/25', () => {
  const o = (ltv) => ({ ...base(), portfolio_total_value: 100000, portfolio_total_loan_balance: ltv * 100000 });
  assert.equal(calcFinancialPressure_(o(0.65)), 8);
  assert.equal(calcFinancialPressure_(o(0.80)), 15);
  assert.equal(calcFinancialPressure_(o(0.95)), 25);
  assert.equal(calcFinancialPressure_(o(0.50)), 0);
});

test('golden: buying-power branches — incl. legacy shadowing: "Potential but High Risk" lands on +15 in FP but +20 in contact fallback', () => {
  assert.equal(calcFinancialPressure_({ ...base(), best_buying_power: 'Very High Risk' }), 20);
  assert.equal(calcFinancialPressure_({ ...base(), best_buying_power: 'Caution Buyers' }), 20);
  assert.equal(calcFinancialPressure_({ ...base(), best_buying_power: 'High Risk' }), 15);
  // FP checks 'high risk' AFTER 'very high risk' but BEFORE 'potential but high risk':
  assert.equal(calcFinancialPressure_({ ...base(), best_buying_power: 'Potential but High Risk' }), 15);
  assert.equal(calcFinancialPressure_({ ...base(), best_buying_power: 'Moderate and Emerging Buyers' }), 5);
});

test('golden: income category regex bands 15/10/5', () => {
  assert.equal(calcFinancialPressure_({ ...base(), best_income: '$20,000-$24,999' }), 15);
  assert.equal(calcFinancialPressure_({ ...base(), best_income: '$30,000-$34,999' }), 10);
  assert.equal(calcFinancialPressure_({ ...base(), best_income: '$45,000-$49,999' }), 5);
  assert.equal(calcFinancialPressure_({ ...base(), best_income: '$85,000-$89,999' }), 0);
});

test('golden: net-asset bands 15/10/5 (incl. startsWith("$0") catch-all)', () => {
  assert.equal(calcFinancialPressure_({ ...base(), best_net_asset: '$0-24,999' }), 15);
  assert.equal(calcFinancialPressure_({ ...base(), best_net_asset: '$25,000-49,999' }), 10);
  assert.equal(calcFinancialPressure_({ ...base(), best_net_asset: '$50,000-74,999' }), 5);
});

test('golden: preforeclosure tag — FP +40; urgency legacy stacking: preforeclosure ALSO matches "foreclosure" (+40+35=75)', () => {
  assert.equal(calcFinancialPressure_({ ...base(), seller_tags_text: 'Preforeclosure' }), 40);
  assert.equal(calcUrgency_({ ...base(), seller_tags_text: 'Preforeclosure' }), 75);
});

test('golden: probate tag — FP +35, urgency +25', () => {
  assert.equal(calcFinancialPressure_({ ...base(), seller_tags_text: 'Probate' }), 35);
  assert.equal(calcUrgency_({ ...base(), seller_tags_text: 'Probate' }), 25);
});

test('golden: tired landlord +25 (FP); vacancy FP +20 / urgency +18; repair tags +20/+12', () => {
  assert.equal(calcFinancialPressure_({ ...base(), seller_tags_text: 'Tired Landlord' }), 25);
  assert.equal(calcFinancialPressure_({ ...base(), seller_tags_text: 'Vacant Home' }), 20);
  assert.equal(calcUrgency_({ ...base(), seller_tags_text: 'Vacant Home' }), 18);
  assert.equal(calcFinancialPressure_({ ...base(), seller_tags_text: 'Major Repairs Needed' }), 20);
  assert.equal(calcFinancialPressure_({ ...base(), seller_tags_text: 'Heavily Dated' }), 12);
});

test('golden: deed types 40/30/28/12', () => {
  assert.equal(calcFinancialPressure_({ ...base(), last_sale_doc_type: 'Distress Sale' }), 40);
  assert.equal(calcFinancialPressure_({ ...base(), last_sale_doc_type: 'Trustee’s Deed' }), 30);
  assert.equal(calcFinancialPressure_({ ...base(), last_sale_doc_type: 'Administrator’s Deed' }), 28);
  assert.equal(calcFinancialPressure_({ ...base(), last_sale_doc_type: 'Quit Claim Deed' }), 12);
});

test('golden: ownership duration ladders + short-hold penalty (FP 6/10/12/15, -10; URG 10/15/20, -10)', () => {
  assert.equal(calcFinancialPressure_({ ...base(), max_ownership_years: 11 }), 6);
  assert.equal(calcFinancialPressure_({ ...base(), max_ownership_years: 26 }), 15);
  assert.equal(calcFinancialPressure_({ ...base(), max_ownership_years: 2 }), 0);   // -10 clamped at 0
  assert.equal(calcUrgency_({ ...base(), max_ownership_years: 26 }), 20);
  assert.equal(calcUrgency_({ ...base(), max_ownership_years: 16 }), 10);
});

test('golden: active lien +12, absentee +10, portfolio count +5/+10, distress markers 5x capped 30 (urgency)', () => {
  assert.equal(calcUrgency_({ ...base(), active_lien_count: 2 }), 12);
  assert.equal(calcUrgency_({ ...base(), is_absentee: true }), 10);
  assert.equal(calcUrgency_({ ...base(), property_count: 3 }), 5);
  assert.equal(calcUrgency_({ ...base(), property_count: 6 }), 10);
  assert.equal(calcUrgency_({ ...base(), distress_marker_count: 4 }), 20);
  assert.equal(calcUrgency_({ ...base(), distress_marker_count: 9 }), 30); // cap
});

test('golden: contact fallback — renter/tenant/resident hard -1; likely owner +48; flag stack; buying power +20 shadow branch', () => {
  // legacy quirk: the boolean field gates, and 'renter'/'tenant'/'resident'
  // substrings gate — but the flag string 'Likely Renting' does NOT ('renting'
  // does not contain 'renter'). Pinned exactly as written in source.
  assert.equal(scoreContactFallback_({ likely_renting: 'true', matching_flags: '', buying_power: '' }), -1);
  assert.equal(scoreContactFallback_({ matching_flags: 'Likely Renting', buying_power: '' }), 0);
  assert.equal(scoreContactFallback_({ matching_flags: 'Resident, Family', buying_power: '' }), -1);
  assert.equal(scoreContactFallback_({ matching_flags: 'Likely Owner', buying_power: '' }), 48);
  assert.equal(scoreContactFallback_({ matching_flags: 'Family', buying_power: '' }), 20);
  assert.equal(scoreContactFallback_({ matching_flags: 'Likely Owner', buying_power: 'Potential but High Risk' }), 68); // 48+20 shadow
  assert.equal(scoreContactFallback_({ matching_flags: 'Likely Owner', buying_power: 'Very High Risk',
    person_flags_text: 'Primary Decision Maker; Property Owner; Real Estate Investor; Home Business' }), 100); // 48+30+10+8+6+4=106 -> clamp
});

test('golden: phone fallback — wireless only; u2 "Very Heavy" lands on heavy (+40); activity bonuses; clamp', () => {
  assert.equal(scorePhoneFallback_('L', '', '', ''), -1);
  assert.equal(scorePhoneFallback_('W', '', '', ''), 40);
  assert.equal(scorePhoneFallback_('W', '', '', 'Very Heavy Usage'), 80);   // legacy substring
  assert.equal(scorePhoneFallback_('W', 'Active 12 months or longer', 'Heavy', 'Heavy'), 100); // 40+40+10+20=110 clamp
  assert.equal(scorePhoneFallback_('W', 'Inactive', '', ''), 32);
});

test('golden: email linkage tier table + contact kicker + rank bonus', () => {
  assert.equal(normalizeLinkageScore_(95000), 100);
  assert.equal(normalizeLinkageScore_(45000), 76);
  assert.equal(normalizeLinkageScore_(5), 40);
  assert.equal(normalizeLinkageScore_(0), 0);
  assert.equal(scoreEmailFinal_(82000, 100, 0), 100);          // 96+min(15,12)+6 = 114 -> clamp 100
  assert.equal(scoreEmailFinal_(15000, 50, 1), 52 + 6 + 3);
});

test('golden: contactability composite 0.6/0.4', () => {
  assert.equal(contactabilityScore_(90, 80), 86);
  assert.equal(contactabilityScore_(0, 0), 0);
});

test('golden: equity bonus 20/10/0 and priority formula with cap', () => {
  assert.equal(equityBonus_(60000, 100000), 20);
  assert.equal(equityBonus_(35000, 100000), 10);
  assert.equal(equityBonus_(10000, 100000), 0);
  assert.equal(equityBonus_(50000, 0), 0);
  const p = priorityScore_({ financial_pressure_score: 100, urgency_score: 100, contactability_score: 100,
    portfolio_total_equity: 90, portfolio_total_value: 100 });
  assert.equal(p, 100); // 30+30+20+20 = 100 exactly at cap
  assert.equal(priorityScore_({ financial_pressure_score: 50, urgency_score: 40, contactability_score: 30,
    portfolio_total_equity: 0, portfolio_total_value: 100 }), 33); // 15+12+6+0
});

test('golden: priority tiers and cadence at boundaries', () => {
  assert.equal(priorityTierFromScore_(70), 'TIER_1');
  assert.equal(priorityTierFromScore_(69), 'TIER_2');
  assert.equal(priorityTierFromScore_(45), 'TIER_2');
  assert.equal(priorityTierFromScore_(44), 'TIER_3');
  assert.equal(followUpCadence_('TIER_1'), 'AGGRESSIVE');
  assert.equal(followUpCadence_('TIER_2'), 'STANDARD');
  assert.equal(followUpCadence_('TIER_3'), 'PASSIVE');
  assert.equal(phoneConfidenceBucket_(75), 'A');
  assert.equal(phoneConfidenceBucket_(74), 'B');
  assert.equal(phoneConfidenceBucket_(25), 'C');
  assert.equal(phoneConfidenceBucket_(24), 'D');
});

test('golden: FP clamps at 100 on stacked evidence (final score cap)', () => {
  const o = { ...base(), tax_delinquent_count: 1, oldest_tax_delinquent_year: 2021,
    portfolio_total_value: 100000, portfolio_total_loan_balance: 95000,
    best_buying_power: 'Very High Risk', best_income: '$20,000', best_net_asset: '$0-24,999',
    seller_tags_text: 'Preforeclosure; Probate; Tax Delinquent; Tired Landlord; Vacant Home',
    last_sale_doc_type: 'Distress Sale', max_ownership_years: 30 };
  assert.equal(calcFinancialPressure_(o), 100);
});

test('golden: owner classification (entity | occupancy)', () => {
  assert.equal(classifyOwnerType_('SUNRISE HOLDINGS LLC', 'Absentee Owner', ''), 'LLC/CORP | ABSENTEE');
  assert.equal(classifyOwnerType_('SMITH FAMILY TRUST', 'Owner Occupied', ''), 'TRUST/ESTATE | OWNER_OCC');
  assert.equal(classifyOwnerType_('JOHN SMITH', '', 'Bank Owned'), 'BANK/INSTITUTION | ABSENTEE');
  assert.equal(classifyOwnerType_('JOHN SMITH', 'Resident', ''), 'INDIVIDUAL | OWNER_OCC');
});

test('golden: end-to-end owner scoring reproduces composition exactly', () => {
  const o = scoreV12Owner({ ...base(), tax_delinquent_count: 1, oldest_tax_delinquent_year: 2023,
    seller_tags_text: 'Tax Delinquent; Absentee Owner', is_absentee: true, active_lien_count: 1,
    portfolio_total_value: 200000, portfolio_total_equity: 120000, portfolio_total_loan_balance: 80000,
    max_ownership_years: 18, distress_marker_count: 2, best_contact_score: 70, best_phone_score: 90 });
  // FP: 35(count)+15(3y:2026-2023)+0(ltv .4)+30(tag)+10(oy 18>=15) = 90
  assert.equal(o.financial_pressure_score, 90);
  // URG: 40(count+3y)+10(markers2x5)+10(absentee)+12(lien)+10(oy>=15)=82
  assert.equal(o.urgency_score, 82);
  // CONTACT: 70*.6+90*.4 = 78
  assert.equal(o.contactability_score, 78);
  // PRIORITY: round(27+24.6+15.6)+20(equity .6) = round(67.2)+... = round(27+24.6+15.6+20)=round(87.2)=87
  assert.equal(o.priority_score, 87);
  assert.equal(o.priority_tier, 'TIER_1');
  assert.equal(o.follow_up_cadence, 'AGGRESSIVE');
});
