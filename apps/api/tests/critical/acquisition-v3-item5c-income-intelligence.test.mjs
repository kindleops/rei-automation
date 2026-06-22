/**
 * Acquisition Engine V3 — Item 5C income intelligence foundation.
 *
 * Canonical income snapshot contract, deterministic source priority, conflict +
 * staleness, rent-comparable universes, cap-rate evidence rules, conversation
 * facts, completeness, and execution-state-basis hardening.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_BASIS,
  CONFLICT_STATUS,
  isKnown,
  emptyIncomeSnapshot,
} from '@/lib/acquisition/incomeSnapshotContract.js';
import { selectField, assessFreshness, FRESHNESS_STATUS } from '@/lib/acquisition/incomeSourcePriority.js';
import { buildRentComparables, RENT_UNIVERSE } from '@/lib/acquisition/incomeRentComps.js';
import { qualifyObservedCapRate, buildCapRateEvidence, CAP_RATE_KIND } from '@/lib/acquisition/incomeCapRateEvidence.js';
import { normalizeConversationFact, reconcileConversationFact } from '@/lib/acquisition/incomeConversationFacts.js';
import { resolveExpenseModel } from '@/lib/acquisition/incomeUnderwriting.js';
import { buildResidentialIncomeSubject } from '@/lib/acquisition/residentialIncomeContract.js';
import { normalizePropertyRow, buildCanonicalIncomeSnapshot } from '@/lib/acquisition/incomeSnapshotLoader.js';
import { buildExecutionStateBasis } from '@/lib/acquisition/executionStateBasis.js';
import { normalizeCandidate } from '@/lib/acquisition/compIdentityEnrichment.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');

/* -------------------------------------------------------------------------- */
/* Contract — UNKNOWN, never zero                                              */
/* -------------------------------------------------------------------------- */

test('missing snapshot fields remain UNKNOWN, never zero', () => {
  const s = emptyIncomeSnapshot({ propertyId: 'p1', lane: 'DUPLEX' });
  for (const f of ['actual_monthly_base_rent', 'actual_noi', 'implied_cap_rate', 'occupancy_rate', 'loan_balance']) {
    assert.equal(s[f].value, null, `${f} must be null`);
    assert.equal(s[f].basis, EVIDENCE_BASIS.UNKNOWN);
    assert.equal(isKnown(s[f]), false);
  }
});

/* -------------------------------------------------------------------------- */
/* Source priority                                                             */
/* -------------------------------------------------------------------------- */

test('verified rent roll outranks a newer modeled rent', () => {
  const sel = selectField([
    { value: 2400, basis: EVIDENCE_BASIS.MARKET_MODELED, observed_at: '2026-06-01', source: 'model' },
    { value: 2600, basis: EVIDENCE_BASIS.VERIFIED_DOCUMENT, observed_at: '2026-03-01', source: 'rent_roll' },
  ], { dataType: 'rent_roll', now: NOW });
  assert.equal(sel.value, 2600);
  assert.equal(sel.basis, EVIDENCE_BASIS.VERIFIED_DOCUMENT);
});

test('verified document outranks a seller statement', () => {
  const sel = selectField([
    { value: 1800, basis: EVIDENCE_BASIS.OWNER_REPORTED, observed_at: '2026-06-01', source: 'conversation' },
    { value: 2000, basis: EVIDENCE_BASIS.VERIFIED_DOCUMENT, observed_at: '2026-05-01', source: 'lease' },
  ], { now: NOW });
  assert.equal(sel.basis, EVIDENCE_BASIS.VERIFIED_DOCUMENT);
  assert.equal(sel.value, 2000);
});

test('seller statement outranks a generic market model when current and credible', () => {
  const sel = selectField([
    { value: 2200, basis: EVIDENCE_BASIS.MARKET_MODELED, observed_at: '2026-06-01', source: 'market' },
    { value: 1950, basis: EVIDENCE_BASIS.OWNER_REPORTED, observed_at: '2026-06-10', source: 'conversation', confidence: 65 },
  ], { now: NOW });
  assert.equal(sel.basis, EVIDENCE_BASIS.OWNER_REPORTED);
  assert.equal(sel.value, 1950);
});

test('stale source receives a confidence penalty and STALE/EXPIRED flag', () => {
  const fresh = assessFreshness('2026-06-01', 'occupancy', NOW);
  const stale = assessFreshness('2025-06-01', 'occupancy', NOW); // > expired window
  assert.equal(fresh.status, FRESHNESS_STATUS.FRESH);
  assert.equal(fresh.confidence_penalty, 0);
  assert.ok(stale.confidence_penalty > 0);
  assert.ok([FRESHNESS_STATUS.STALE, FRESHNESS_STATUS.EXPIRED].includes(stale.status));
  // A stale winner loses confidence vs its base basis confidence.
  const sel = selectField([{ value: 90, basis: EVIDENCE_BASIS.ACTUAL, observed_at: '2024-01-01', source: 'pm' }], { dataType: 'occupancy', now: NOW });
  assert.ok(sel.confidence < 85);
});

test('source conflict is preserved (not silently averaged)', () => {
  const sel = selectField([
    { value: 2600, basis: EVIDENCE_BASIS.ACTUAL, observed_at: '2026-06-01', source: 'pm' },
    { value: 3400, basis: EVIDENCE_BASIS.ACTUAL, observed_at: '2026-05-01', source: 'pm2' },
  ], { now: NOW });
  assert.equal(sel.conflict, CONFLICT_STATUS.MATERIAL);
  assert.equal(sel.value, 2600); // most recent of equal reliability, NOT an average
  assert.ok(sel.rejected.length === 1);
});

test('material conflict in the snapshot blocks underwritable status', () => {
  const candidateMap = {
    actual_monthly_base_rent: [
      { value: 2600, basis: EVIDENCE_BASIS.ACTUAL, observed_at: '2026-06-01', source: 'pm', data_type: 'rent_roll' },
      { value: 3500, basis: EVIDENCE_BASIS.ACTUAL, observed_at: '2026-05-01', source: 'pm2', data_type: 'rent_roll' },
    ],
  };
  const r = buildCanonicalIncomeSnapshot({ propertyId: 'p1', lane: 'DUPLEX', candidateMap, now: NOW });
  assert.equal(r.has_material_conflict, true);
  assert.ok(r.material_conflict_fields.includes('actual_monthly_base_rent'));
  assert.equal(r.max_underwritable, false);
});

/* -------------------------------------------------------------------------- */
/* Rent comps                                                                  */
/* -------------------------------------------------------------------------- */

test('asking rent is NOT treated as actual rent', () => {
  const subject = { lane: 'DUPLEX', beds: 2, baths: 1, unit_sqft: 900, zip: '75201' };
  const recs = [
    { monthly_rent: 1500, rent_kind: 'asking', beds: 2, baths: 1, unit_sqft: 900, zip: '75201', source: 'listing' },
    { monthly_rent: 1600, rent_kind: 'asking', beds: 2, baths: 1, unit_sqft: 920, zip: '75201', source: 'listing' },
  ];
  const out = buildRentComparables(subject, recs);
  assert.equal(out.universes[RENT_UNIVERSE.ASKING].available, true);
  assert.equal(out.universes[RENT_UNIVERSE.ACTUAL].available, false);
  // selection must never pick the asking universe as executed rent.
  assert.notEqual(out.selected_universe, RENT_UNIVERSE.ASKING);
});

test('actual rent universe is selected over asking when both exist', () => {
  const subject = { lane: 'DUPLEX', beds: 2, baths: 1, unit_sqft: 900, zip: '75201' };
  const recs = [
    { monthly_rent: 1700, rent_kind: 'asking', beds: 2, baths: 1, unit_sqft: 900, zip: '75201', source: 'listing' },
    { monthly_rent: 1500, rent_kind: 'signed', beds: 2, baths: 1, unit_sqft: 900, zip: '75201', source: 'lease' },
  ];
  const out = buildRentComparables(subject, recs);
  assert.equal(out.selected_universe, RENT_UNIVERSE.ACTUAL);
  assert.equal(out.selected_basis, EVIDENCE_BASIS.ACTUAL);
});

/* -------------------------------------------------------------------------- */
/* Cap-rate evidence                                                           */
/* -------------------------------------------------------------------------- */

test('modeled NOI cannot create an OBSERVED cap rate', () => {
  const q = qualifyObservedCapRate({
    consideration: 1000000, sale_price: 1000000, noi: 65000, noi_basis: EVIDENCE_BASIS.MARKET_MODELED,
    income_sale_month_gap: 1, same_property: true, source_record_id: 'x1', consideration_qualified: true,
  });
  assert.equal(q.qualified, false);
  assert.ok(q.reasons.includes('noi_not_observed_basis'));
});

test('a package transaction cannot create an observed cap rate', () => {
  const q = qualifyObservedCapRate({
    consideration: 1000000, noi: 65000, noi_basis: EVIDENCE_BASIS.ACTUAL, is_package: true,
    income_sale_month_gap: 0, same_property: true, source_record_id: 'x', consideration_qualified: true,
  });
  assert.equal(q.qualified, false);
  assert.ok(q.reasons.includes('package_consideration'));
});

test('observed cap rate requires a time-aligned qualified sale and NOI', () => {
  const misaligned = qualifyObservedCapRate({
    consideration: 1000000, noi: 65000, noi_basis: EVIDENCE_BASIS.ACTUAL, income_sale_month_gap: 24,
    same_property: true, source_record_id: 'x', consideration_qualified: true,
  });
  assert.equal(misaligned.qualified, false);
  assert.ok(misaligned.reasons.includes('income_sale_not_time_aligned'));

  const ok = qualifyObservedCapRate({
    consideration: 1000000, noi: 65000, noi_basis: EVIDENCE_BASIS.ACTUAL, income_sale_month_gap: 2,
    same_property: true, source_record_id: 'x', consideration_qualified: true, size_band: 'MF_5_20',
  }, { subjectBand: 'MF_5_20' });
  assert.equal(ok.qualified, true);
  assert.equal(ok.cap_rate, 0.065);
});

test('cap-rate evidence keeps OBSERVED / IMPLIED / MODELED_MARKET separate', () => {
  const ev = buildCapRateEvidence({ transactions: [], impliedNoi: 60000, impliedValue: 1000000, family: 'MULTIFAMILY' });
  assert.equal(ev.observed.kind, CAP_RATE_KIND.OBSERVED);
  assert.equal(ev.observed.cap_rate, null);
  assert.equal(ev.implied.kind, CAP_RATE_KIND.IMPLIED);
  assert.equal(ev.implied.cap_rate, 0.06);
  assert.equal(ev.modeled_market.kind, CAP_RATE_KIND.MODELED_MARKET);
  assert.notEqual(ev.implied.basis, ev.observed.basis);
});

/* -------------------------------------------------------------------------- */
/* Conversation facts                                                          */
/* -------------------------------------------------------------------------- */

test('a seller statement is OWNER_REPORTED and never overwrites a verified value', () => {
  const norm = normalizeConversationFact({ key: 'monthly_rent', value: 1500, thread_id: 't', message_id: 'm', extracted_at: '2026-06-01', extraction_confidence: 70, user_confirmed: true });
  assert.equal(norm.field.basis, EVIDENCE_BASIS.OWNER_REPORTED);
  assert.equal(norm.provenance.verified_document, false);
  const existingVerified = { value: 2000, basis: EVIDENCE_BASIS.VERIFIED_DOCUMENT };
  const rec = reconcileConversationFact(norm, existingVerified);
  assert.equal(rec.action, 'KEEP_EXISTING'); // verified value is never overwritten
  assert.equal(rec.conflict, CONFLICT_STATUS.MATERIAL); // 1500 vs 2000 = 25%
});

test('conversation fact applies when no existing value exists', () => {
  const norm = normalizeConversationFact({ key: 'loan_balance', value: 150000, thread_id: 't', message_id: 'm', extraction_confidence: 60, user_confirmed: false });
  const rec = reconcileConversationFact(norm, { value: null, basis: EVIDENCE_BASIS.UNKNOWN });
  assert.equal(rec.action, 'APPLY');
});

/* -------------------------------------------------------------------------- */
/* Expenses & taxes                                                            */
/* -------------------------------------------------------------------------- */

test('actual expenses outrank modeled expenses', () => {
  const sel = selectField([
    { value: 22000, basis: EVIDENCE_BASIS.ACTUAL, observed_at: '2026-01-01', source: 'pm' },
    { value: 18000, basis: EVIDENCE_BASIS.MARKET_MODELED, observed_at: '2026-06-01', source: 'model' },
  ], { dataType: 'expenses', now: NOW });
  assert.equal(sel.basis, EVIDENCE_BASIS.ACTUAL);
  assert.equal(sel.value, 22000);
});

test('taxes use property-specific evidence when available (provider over market model)', () => {
  const cmap = normalizePropertyRow({ property_id: 'p1', units_count: 4, building_square_feet: 4000, tax_amt: 5200 }, { observedAt: '2026-03-01' });
  const sel = selectField([
    ...cmap.property_taxes,
    { value: 7000, basis: EVIDENCE_BASIS.MARKET_MODELED, observed_at: '2026-06-01', source: 'tax_rate_model' },
  ], { dataType: 'taxes', now: NOW });
  assert.equal(sel.value, 5200);
  assert.equal(sel.basis, EVIDENCE_BASIS.PROVIDER_REPORTED);
});

test('total rent does not fabricate per-unit precision when only total is known', () => {
  const c = buildResidentialIncomeSubject({ property_type: 'Fourplex', units_count: 4, building_square_feet: 4000, monthly_rent: 5200 });
  // unit_mix stays UNKNOWN (no rent roll) — no fabricated per-unit breakdown.
  assert.equal(c.unit_mix.value, null);
});

test('unit-mix rent normalization summarizes a rent roll without inventing units', () => {
  const c = buildResidentialIncomeSubject({ property_type: 'Fourplex', units_count: 4, building_square_feet: 4000 },
    { rent_roll: [{ beds: 2, baths: 1, current_rent: 1300 }, { beds: 2, baths: 1, current_rent: 1350 }, { beds: 1, baths: 1, current_rent: 1000 }] });
  assert.ok(Array.isArray(c.unit_mix.value));
  const twoBed = c.unit_mix.value.find((u) => u.type === '2b/1ba');
  assert.equal(twoBed.count, 2);
  assert.equal(twoBed.avg_current_rent, 1325);
});

/* -------------------------------------------------------------------------- */
/* Completeness                                                                */
/* -------------------------------------------------------------------------- */

test('completeness is reported separately per domain and per strategy', () => {
  const cmap = normalizePropertyRow({ property_id: 'p1', units_count: 4, building_square_feet: 4000, tax_amt: 5200, total_loan_balance: 180000, total_loan_payment: 1400 }, { observedAt: '2026-03-01' });
  const r = buildCanonicalIncomeSnapshot({ propertyId: 'p1', lane: 'FOURPLEX', candidateMap: cmap, now: NOW });
  assert.equal(r.completeness.domains.physical.completeness, 100);
  assert.equal(r.completeness.domains.rent.completeness, 0);
  assert.ok(r.completeness.strategy.CASH.max_possible_qualification);
  assert.ok(r.completeness.strategy.SUBJECT_TO.missing_fields.includes('interest_rate'));
  // domains are distinct, not one blended number
  assert.notEqual(r.completeness.domains.physical.completeness, r.completeness.domains.rent.completeness);
});

/* -------------------------------------------------------------------------- */
/* Execution-state basis hardening (§10)                                       */
/* -------------------------------------------------------------------------- */

test('provisional cash stays unauthorized even when subject-to is underwritten', () => {
  const ranked = [
    { strategy: 'SUBJECT_TO', qualification_status: 'UNDERWRITTEN_SHADOW', authorized_offer: false },
    { strategy: 'CASH', qualification_status: 'PROVISIONAL_SCENARIO', authorized_offer: false },
  ];
  const basis = buildExecutionStateBasis({ ranked, executionState: 'SHADOW_MODE_READY', primaryStrategy: 'SUBJECT_TO' });
  assert.equal(basis.cash_authorized, false);
  assert.equal(basis.subject_to_underwritten, true);
  assert.equal(basis.authorized_strategy, null); // cash NOT authorized
  assert.equal(basis.execution_state_basis_strategy, 'SUBJECT_TO');
  assert.equal(basis.cash_scenario_only, true);
  assert.ok(basis.note && /SUBJECT_TO/.test(basis.note));
});

test('global SHADOW identifies the exact supporting strategy (Item 5B duplex regression)', () => {
  const Z = '75201';
  const cand = (id, p, d, s) => ({ comp_id: id, property_id: id, address: `${id} St`, zip: Z, city: 'Dallas', state: 'TX', latitude: 32.78, longitude: -96.79, sale_price: p, sale_date: d, asset_class: 'duplex', property_type: 'Duplex', units_count: 2, sqft: s, beds: 4, baths: 2, year_built: 1988, building_condition: 'Average', construction_type: 'Frame', distance_miles: 1.2, similarity_score: 90 });
  const raw = (id, p) => ({ id, property_id: id, apn_parcel_id: `apn-${id}`, owner_name: `INV ${id} LLC`, owner_1_name: `INV ${id} LLC`, is_corporate_owner: true, last_sale_doc_type: 'Warranty Deed', sale_price: p });
  const comp = (id, p, d, s) => normalizeCandidate(cand(id, p, d, s), raw(id, p), null);
  const DUP = { property_id: 'd', property_type: 'Duplex', property_address_zip: Z, building_square_feet: 2400, units_count: 2, estimated_value: 300000, monthly_rent: 2600, tax_amt: 4200, year_built: 1986, building_condition: 'Average' };
  const comps = [comp('a', 295000, '2025-03-01', 2350), comp('b', 305000, '2025-06-01', 2450), comp('c', 300000, '2025-09-01', 2400)];
  const v3 = buildV3Decision({ subjectRow: DUP, qualification: qualifyComps(DUP, comps), buyerPurchases: [], now: NOW }).v3;
  assert.equal(v3.execution_state, 'SHADOW_MODE_READY');
  const b = v3.execution_state_basis;
  assert.ok(b.execution_state_basis_strategy, 'a supporting strategy must be named');
  assert.ok(b.underwritten_strategies.length >= 1);
  // authorized monetary fields are strategy-specific.
  assert.equal(typeof b.cash_authorized, 'boolean');
  if (!b.cash_authorized) assert.equal(v3.offer_authorization.authorized_recommended_offer, null);
});

test('no outbound execution is enabled by the income-intelligence layer', () => {
  const Z = '75201';
  const cand = (id, p, d, s) => ({ comp_id: id, property_id: id, address: `${id} St`, zip: Z, city: 'Dallas', state: 'TX', latitude: 32.78, longitude: -96.79, sale_price: p, sale_date: d, asset_class: 'duplex', property_type: 'Duplex', units_count: 2, sqft: s, beds: 4, baths: 2, year_built: 1988, building_condition: 'Average', construction_type: 'Frame', distance_miles: 1.2, similarity_score: 90 });
  const raw = (id, p) => ({ id, property_id: id, apn_parcel_id: `apn-${id}`, owner_name: `INV ${id} LLC`, owner_1_name: `INV ${id} LLC`, is_corporate_owner: true, last_sale_doc_type: 'Warranty Deed', sale_price: p });
  const comp = (id, p, d, s) => normalizeCandidate(cand(id, p, d, s), raw(id, p), null);
  const DUP = { property_id: 'd', property_type: 'Duplex', property_address_zip: Z, building_square_feet: 2400, units_count: 2, estimated_value: 300000, monthly_rent: 2600, tax_amt: 4200 };
  const v3 = buildV3Decision({ subjectRow: DUP, qualification: qualifyComps(DUP, [comp('a', 295000, '2025-03-01', 2350), comp('b', 305000, '2025-06-01', 2450), comp('c', 300000, '2025-09-01', 2400)]), buyerPurchases: [], now: NOW }).v3;
  assert.equal(v3.auto_offer_eligible, false);
  assert.equal(v3.active_feature_flags.ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER, false);
});
