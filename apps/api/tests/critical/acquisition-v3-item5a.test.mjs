/**
 * Acquisition Engine V3 — Item 5A: identity-aware loader, exact-lane filtering,
 * universe routing, and transaction-vs-property anomaly materiality (§13).
 * Deterministic; the loader's DB primitives are injected (no network, no N+1).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { VALUATION_UNIVERSES as U, VALUE_CLASSIFICATION as VC } from '@/lib/acquisition/modelConstants.js';
import { loadV3CompCandidates } from '@/lib/acquisition/compCandidateLoader.js';
import { normalizeCandidate } from '@/lib/acquisition/compIdentityEnrichment.js';
import { resolveBuyer, BUYER_ARCHETYPES } from '@/lib/acquisition/buyerIdentityResolution.js';
import { classifyTransactionChannel } from '@/lib/acquisition/transactionChannelClassification.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { buildValuationUniverses } from '@/lib/acquisition/valuationUniverses.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const Z = '75201';

// RPC-candidate shape
const cand = (comp_id, o = {}) => ({
  comp_id, property_id: o.pid ?? comp_id, address: `${comp_id} St, Dallas TX ${Z}`, zip: Z, city: 'Dallas', state: 'TX',
  latitude: 32.78, longitude: -96.79, sale_price: o.sale_price ?? 0, sale_date: o.date ?? '2025-06-01',
  mls_sold_price: o.mls ?? null, asset_class: o.asset_class ?? 'single_family', property_type: o.ptype ?? 'Single Family',
  units_count: o.units ?? 1, sqft: o.sqft ?? 1400, beds: 3, baths: 2, year_built: 1995,
  building_condition: 'Good', construction_type: 'Frame', distance_miles: 1.2, similarity_score: 90,
});
// buyer_comp_raw_v2 shape
const raw = (id, o = {}) => ({
  id, property_id: o.pid ?? id, apn_parcel_id: o.apn ?? `apn-${id}`, owner_name: o.owner ?? null, owner_1_name: o.owner ?? null,
  is_corporate_owner: o.corp ?? false, owner_address_full: o.mail ?? '1 Mailing Rd, Dallas TX', document_type: o.doc ?? '',
  recording_date: o.rec ?? '2025-06-02', sale_price: o.sale_price ?? 0, mls_sold_price: o.mls ?? null,
  subdivision_name: 'Sub', school_district_name: 'ISD',
});

const SFR = { property_id: 'subj', property_type: 'Single Family', property_address_zip: Z, building_square_feet: 1400, units_count: 1, estimated_value: 200000 };

/* ---------------- loader: deterministic identity join + batching ---------- */

test('identity enrichment joins each candidate to the correct source row (by comp_id == raw.id)', async () => {
  const candidates = [cand('A', { sale_price: 180000 }), cand('B', { sale_price: 175000 })];
  const rows = [raw('A', { owner: 'ACME HOMES LLC', corp: true, apn: 'apn-A', sale_price: 180000 }), raw('B', { owner: 'Jane Q Public', apn: 'apn-B', sale_price: 175000 })];
  const { candidates: out } = await loadV3CompCandidates(SFR, {
    db: {}, runRpc: async () => candidates, fetchRawIdentity: async () => rows, fetchEntities: async () => [],
  });
  const a = out.find((c) => c.id === 'A');
  const b = out.find((c) => c.id === 'B');
  assert.equal(a.buyer_name_clean, 'ACME HOMES LLC');
  assert.equal(a.apn_parcel_id, 'apn-A');
  assert.equal(b.buyer_name_clean, 'Jane Q Public');
  assert.equal(b.apn_parcel_id, 'apn-B');
  assert.equal(a.identity_unresolved, false);
});

test('candidate with no matching identity row stays IDENTITY_UNRESOLVED with reduced pricing eligibility', async () => {
  const { candidates: out } = await loadV3CompCandidates(SFR, {
    db: {}, runRpc: async () => [cand('Z', { sale_price: 150000 })], fetchRawIdentity: async () => [], fetchEntities: async () => [],
  });
  assert.equal(out[0].identity_unresolved, true);
  assert.equal(out[0].v3_pricing_eligible, false);
});

test('batch enrichment performs no N+1 (one rpc, one identity query, one entity query)', async () => {
  let rpc = 0, idq = 0, ent = 0;
  const candidates = Array.from({ length: 25 }, (_, i) => cand(`c${i}`, { sale_price: 150000 + i, date: `2025-0${(i % 9) + 1}-01` }));
  const rows = candidates.map((c) => raw(c.comp_id, { owner: `INV ${c.comp_id} LLC`, corp: true, sale_price: c.sale_price }));
  await loadV3CompCandidates(SFR, {
    db: {},
    runRpc: async () => { rpc += 1; return candidates; },
    fetchRawIdentity: async (ids) => { idq += 1; assert.ok(ids.length === 25); return rows; },
    fetchEntities: async () => { ent += 1; return []; },
  });
  assert.equal(rpc, 1); assert.equal(idq, 1); assert.equal(ent, 1);
});

/* ---------------- buyer + channel routing ---------------- */

test('buyer archetypes resolve from name + corporate flag', () => {
  assert.equal(resolveBuyer({ name: 'ACME HOMES LLC', isCorporate: true }).archetype, BUYER_ARCHETYPES.LOCAL_INVESTOR);
  assert.equal(resolveBuyer({ name: 'Invitation Homes LP', isCorporate: true }).archetype, BUYER_ARCHETYPES.INSTITUTIONAL_SFR);
  assert.equal(resolveBuyer({ name: 'Secretary of Veteran Affairs', isCorporate: true }).archetype, BUYER_ARCHETYPES.GOVERNMENT_OR_NONPROFIT);
  assert.equal(resolveBuyer({ name: 'Jane Q Homeowner', isCorporate: false }).archetype, BUYER_ARCHETYPES.OWNER_OCCUPANT);
});

test('channel routing: investor→LOCAL_INVESTOR, institutional→INSTITUTIONAL, MLS→RETAIL, unknown non-sale excluded', () => {
  assert.equal(classifyTransactionChannel({ salePrice: 180000, archetype: BUYER_ARCHETYPES.LOCAL_INVESTOR }).universe, U.LOCAL_INVESTOR_VALUE);
  assert.equal(classifyTransactionChannel({ salePrice: 180000, archetype: BUYER_ARCHETYPES.INSTITUTIONAL_SFR }).universe, U.INSTITUTIONAL_VALUE);
  assert.equal(classifyTransactionChannel({ salePrice: 0, mlsSoldPrice: 230000, archetype: BUYER_ARCHETYPES.OWNER_OCCUPANT }).universe, U.RETAIL_MLS_VALUE);
  const nonSale = classifyTransactionChannel({ salePrice: 0, archetype: BUYER_ARCHETYPES.UNKNOWN });
  assert.equal(nonSale.pricing_eligible, false);
  const govt = classifyTransactionChannel({ salePrice: 50000, archetype: BUYER_ARCHETYPES.GOVERNMENT_OR_NONPROFIT });
  assert.equal(govt.pricing_eligible, false);
});

test('unknown/unresolved buyer never becomes investor evidence', () => {
  const c = normalizeCandidate(cand('U', { sale_price: 170000 }), null, null); // no identity row
  assert.equal(c.buyer_archetype, BUYER_ARCHETYPES.UNKNOWN);
  assert.notEqual(c.v3_universe_hint, U.LOCAL_INVESTOR_VALUE);
  assert.equal(c.v3_pricing_eligible, false); // identity unresolved, non-MLS
});

/* ---------------- exact-lane filtering before valuation ---------------- */

function enrich(c, r) { return normalizeCandidate(c, r, null); }

test('SFR subject rejects duplex and MF5+ candidates (exact lane)', () => {
  const comps = [
    enrich(cand('s1', { sale_price: 185000 }), raw('s1', { owner: 'A LLC', corp: true, sale_price: 185000 })),
    enrich(cand('dx', { sale_price: 300000, ptype: 'Multifamily 2-4', units: 2, asset_class: 'multi_family' }), raw('dx', { owner: 'B LLC', corp: true, sale_price: 300000 })),
    enrich(cand('mf', { sale_price: 2000000, ptype: 'Multifamily 5+', units: 20, asset_class: 'multi_family' }), raw('mf', { owner: 'C LLC', corp: true, sale_price: 2000000 })),
  ];
  const q = qualifyComps(SFR, comps);
  for (const a of q.accepted) assert.equal(a.comp_lane, 'SFR');
  assert.ok(q.rejected.some((r) => r.reasons.includes('asset_lane_mismatch')));
});

test('duplex subject rejects SFR and MF5+ candidates', () => {
  const dup = { property_id: 'd', property_type: 'Duplex', property_address_zip: Z, building_square_feet: 2400, units_count: 2, estimated_value: 320000 };
  const comps = [
    enrich(cand('d1', { sale_price: 310000, ptype: 'Duplex', units: 2, asset_class: 'multi_family', sqft: 2400 }), raw('d1', { owner: 'A LLC', corp: true, sale_price: 310000 })),
    enrich(cand('s1', { sale_price: 200000 }), raw('s1', { owner: 'B LLC', corp: true, sale_price: 200000 })),
    enrich(cand('mf', { sale_price: 2000000, ptype: 'Multifamily 5+', units: 30, asset_class: 'multi_family' }), raw('mf', { owner: 'C LLC', corp: true, sale_price: 2000000 })),
  ];
  const q = qualifyComps(dup, comps);
  for (const a of q.accepted) assert.equal(a.comp_lane, 'DUPLEX');
});

/* ---------------- package: collapse, no price, demand available ---------------- */

test('institutional package collapses to one cluster, contributes no price, demand flag remains', () => {
  const pkg = Array.from({ length: 6 }, (_, i) => enrich(
    cand(`p${i}`, { sale_price: 95000000, date: '2025-08-01', pid: `p${i}` }),
    raw(`p${i}`, { owner: 'Invitation Homes LP', corp: true, sale_price: 95000000 }),
  ));
  // spread across ZIPs to trigger package detection
  pkg.forEach((c, i) => { c.property_address_zip = String(75200 + i); });
  const q = qualifyComps(SFR, pkg);
  assert.equal(q.sample.package_cluster_count, 1);
  assert.equal(q.sample.accepted_count, 0, 'package contributes no accepted pricing comp');
  const { universes } = buildValuationUniverses(SFR, q, [], NOW);
  assert.equal(universes[U.INSTITUTIONAL_VALUE].available, false, 'package price never enters institutional pricing');
  // demand signal preserved at the candidate level
  assert.equal(pkg[0].v3_demand_eligible, true);
});

/* ---------------- materiality: isolate bad rows vs quarantine property ------- */

const cleanInvestor = (id, price, date) => enrich(cand(id, { sale_price: price, date }), raw(id, { owner: `INV ${id} LLC`, corp: true, sale_price: price }));

test('rejected candidate does NOT auto-quarantine a property with sufficient clean evidence (SHADOW + warnings)', () => {
  const comps = [
    cleanInvestor('a', 178000, '2025-03-01'), cleanInvestor('b', 185000, '2025-05-01'),
    cleanInvestor('c', 182000, '2025-07-01'), cleanInvestor('d', 176000, '2025-08-01'),
    // one contaminated row that must be ISOLATED, not propagate
    enrich(cand('bad', { sale_price: 50000000, date: '2025-09-01' }), raw('bad', { owner: 'X LLC', corp: true, sale_price: 50000000 })),
  ];
  const q = qualifyComps(SFR, comps);
  const { v3 } = buildV3Decision({ subjectRow: SFR, qualification: q, buyerPurchases: [], now: NOW });
  assert.ok(v3.transaction_anomaly_present, 'a bad row was present');
  assert.equal(v3.transaction_anomaly_material, false, 'but it is non-material (isolated)');
  assert.ok(v3.clean_independent_transaction_count >= 3);
  assert.equal(v3.execution_state, 'SHADOW_MODE_READY');
  assert.ok(v3.nonmaterial_warning_reasons.length >= 1);
});

test('insufficient clean evidence with contaminated candidates → ANOMALY_QUARANTINE', () => {
  const comps = [
    enrich(cand('bad1', { sale_price: 40000000, date: '2025-09-01' }), raw('bad1', { owner: 'X LLC', corp: true, sale_price: 40000000 })),
    enrich(cand('bad2', { sale_price: 45000000, date: '2025-09-01' }), raw('bad2', { owner: 'Y LLC', corp: true, sale_price: 45000000 })),
  ];
  const q = qualifyComps(SFR, comps);
  const { v3 } = buildV3Decision({ subjectRow: SFR, qualification: q, buyerPurchases: [], now: NOW });
  assert.equal(v3.transaction_anomaly_material, true);
  assert.equal(v3.clean_independent_transaction_count, 0);
  assert.equal(v3.execution_state, 'ANOMALY_QUARANTINE');
  assert.equal(v3.offer_authorization.authorized_recommended_offer, null);
});

test('non-sale / IDENTITY_UNRESOLVED candidates are excluded from pricing but a clean set still qualifies', () => {
  const comps = [
    cleanInvestor('a', 178000, '2025-03-01'), cleanInvestor('b', 185000, '2025-05-01'), cleanInvestor('c', 182000, '2025-07-01'),
    enrich(cand('ns', { sale_price: 0, date: '2025-06-01' }), raw('ns', { owner: 'Z LLC', corp: true, sale_price: 0 })), // non-sale
    normalizeCandidate(cand('ur', { sale_price: 170000 }), null, null), // identity unresolved
  ];
  const q = qualifyComps(SFR, comps);
  const accepts = q.accepted.map((a) => a.address);
  assert.ok(q.sample.accepted_count >= 3);
  assert.ok(q.rejected.some((r) => r.reasons.includes('not_pricing_eligible')));
  void accepts;
});

test('no outbound execution: auto_offer_eligible false; flags off', () => {
  const comps = [cleanInvestor('a', 178000, '2025-03-01'), cleanInvestor('b', 185000, '2025-05-01'), cleanInvestor('c', 182000, '2025-07-01')];
  const { v3 } = buildV3Decision({ subjectRow: SFR, qualification: qualifyComps(SFR, comps), buyerPurchases: [], now: NOW });
  assert.equal(v3.auto_offer_eligible, false);
  assert.equal(v3.active_feature_flags.ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER, false);
});
