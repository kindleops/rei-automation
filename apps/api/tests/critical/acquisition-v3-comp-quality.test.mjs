/**
 * Acquisition Engine V3 — transaction pricing-eligibility hardening (§10).
 * Foreclosure/government exclusion, peer-relative outliers, builder/new-construction
 * + renovated-flip routing, and the corrected Caldwell regression.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { VALUATION_UNIVERSES as U, VALUE_CLASSIFICATION as VC } from '@/lib/acquisition/modelConstants.js';
import { classifyTransactionChannel, EVIDENCE_ROLES as R } from '@/lib/acquisition/transactionChannelClassification.js';
import { resolveBuyer, BUYER_ARCHETYPES } from '@/lib/acquisition/buyerIdentityResolution.js';
import { classifyPeerOutliers, PEER_STATUS } from '@/lib/acquisition/peerRelativeOutliers.js';
import { normalizeCandidate } from '@/lib/acquisition/compIdentityEnrichment.js';
import { qualifyComps } from '@/lib/acquisition/transactionQualification.js';
import { buildV3Decision } from '@/lib/acquisition/v3DecisionPipeline.js';
import { calculateAcquisitionDecision } from '@/lib/acquisition/acquisitionDecisionEngine.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');

/* --------------------- channel / routing --------------------- */

test("Trustee's Deed routes to distressed/liquidation only (no ordinary pricing)", () => {
  const c = classifyTransactionChannel({ salePrice: 330500, documentType: 'Trustee’s Deed', archetype: BUYER_ARCHETYPES.LOCAL_INVESTOR });
  assert.equal(c.evidence_role, R.DISTRESSED_LIQUIDATION_PRICING);
  assert.equal(c.pricing_eligible, false);
  assert.equal(c.universe, U.LIQUIDATION_VALUE);
});

test('government/nonprofit transfer is pricing-ineligible by default; arms-length needs explicit proof', () => {
  const buyer = resolveBuyer({ name: 'Tule River Homebuyer Earned Equity Agency', isCorporate: true });
  assert.equal(buyer.archetype, BUYER_ARCHETYPES.GOVERNMENT_OR_NONPROFIT);
  const c = classifyTransactionChannel({ salePrice: 359989, archetype: buyer.archetype });
  assert.equal(c.evidence_role, R.GOVERNMENT_PROGRAM_CONTEXT_ONLY);
  assert.equal(c.pricing_eligible, false); // default-excluded; no arms-length proof signal present
});

test('builder/new-construction routes to retail new-construction, not ordinary investor', () => {
  const c = classifyTransactionChannel({ salePrice: 309890, yearBuilt: 2025, saleDate: '2026-02-04', archetype: BUYER_ARCHETYPES.LOCAL_INVESTOR });
  assert.equal(c.evidence_role, R.RETAIL_NEW_CONSTRUCTION_PRICING);
  assert.equal(c.universe, U.RETAIL_MLS_VALUE);
  assert.notEqual(c.universe, U.LOCAL_INVESTOR_VALUE);
});

test('renovated-flip buyer routes to ARV/retail, not as-is investor', () => {
  const c = classifyTransactionChannel({ salePrice: 560098, buyerName: 'Macfarlane Renovations LLC', yearBuilt: 1961, saleDate: '2026-04-28', archetype: BUYER_ARCHETYPES.LOCAL_INVESTOR });
  assert.equal(c.evidence_role, R.RENOVATED_ARV_PRICING);
  assert.equal(c.universe, U.RETAIL_MLS_VALUE);
});

test('ordinary investor (older stock, LLC, priced, off-market) still routes to LOCAL_INVESTOR', () => {
  const c = classifyTransactionChannel({ salePrice: 348686, yearBuilt: 1951, saleDate: '2026-01-12', archetype: BUYER_ARCHETYPES.LOCAL_INVESTOR });
  assert.equal(c.evidence_role, R.ORDINARY_INVESTOR_PRICING);
  assert.equal(c.universe, U.LOCAL_INVESTOR_VALUE);
});

/* --------------------- peer-relative outliers --------------------- */

test('peer-relative high outlier is detected ($1.03M among $300-465k)', () => {
  const m = classifyPeerOutliers([
    { key: 'a', value: 309890 }, { key: 'b', value: 348686 }, { key: 'c', value: 356400 },
    { key: 'd', value: 465780 }, { key: 'e', value: 1030750 },
  ]);
  assert.equal(m.get('e').status, PEER_STATUS.PEER_HIGH_OUTLIER);
  assert.equal(m.get('a').status, PEER_STATUS.PEER_CONSISTENT);
});

test('peer-relative low outlier is detected', () => {
  const m = classifyPeerOutliers([
    { key: 'a', value: 300000 }, { key: 'b', value: 320000 }, { key: 'c', value: 340000 },
    { key: 'd', value: 360000 }, { key: 'e', value: 90000 },
  ]);
  assert.equal(m.get('e').status, PEER_STATUS.PEER_LOW_OUTLIER);
});

test('small sample with zero MAD still detects an extreme record (ratio fallback)', () => {
  const m = classifyPeerOutliers([
    { key: 'a', value: 200000 }, { key: 'b', value: 200000 }, { key: 'c', value: 200000 },
    { key: 'd', value: 200000 }, { key: 'e', value: 2000000 },
  ]);
  assert.equal(m.get('e').status, PEER_STATUS.PEER_HIGH_OUTLIER);
});

test('leave-one-out prevents an outlier from validating itself', () => {
  const m = classifyPeerOutliers([
    { key: 'a', value: 100000 }, { key: 'b', value: 100000 }, { key: 'c', value: 100000 }, { key: 'd', value: 1000000 },
  ]);
  assert.equal(m.get('d').status, PEER_STATUS.PEER_HIGH_OUTLIER);
});

test('metric conflict (value high but PPSF low) becomes REVIEW/CONFLICT, not silent acceptance', () => {
  const m = classifyPeerOutliers([
    { key: 'a', value: 300000, ppsf: 200 }, { key: 'b', value: 320000, ppsf: 210 },
    { key: 'c', value: 340000, ppsf: 205 }, { key: 'd', value: 360000, ppsf: 215 },
    { key: 'e', value: 1000000, ppsf: 40 },
  ]);
  assert.equal(m.get('e').status, PEER_STATUS.METRIC_CONFLICT);
});

test('insufficient peer depth does not reject (kept, not outlier)', () => {
  const m = classifyPeerOutliers([{ key: 'a', value: 300000 }, { key: 'b', value: 900000 }]);
  assert.equal(m.get('b').status, PEER_STATUS.INSUFFICIENT_PEER_DEPTH);
});

/* --------------------- Caldwell corrected regression --------------------- */

const CALDWELL = { property_id: '242567952', property_type: 'SFR', property_address_zip: '83605', building_square_feet: 1550, units_count: 1, year_built: 1940, estimated_value: 309000 };

function cc(id, { price, sqft = 1550, yr = 1960, date = '2026-01-15', owner, doc = 'Warranty Deed', mls = null, zip = '83605' }) {
  const candidate = { comp_id: id, property_id: id, address: `${id} St, Caldwell ID ${zip}`, zip, city: 'Caldwell', state: 'ID', latitude: 43.66, longitude: -116.68, sale_price: price, sale_date: date, mls_sold_price: mls, asset_class: 'single_family', property_type: 'Single Family', units_count: 1, sqft, beds: 3, baths: 2, year_built: yr, building_condition: 'Average', construction_type: 'Frame', distance_miles: 2.3, similarity_score: 71 };
  const raw = { id, property_id: id, apn_parcel_id: `apn-${id}`, owner_name: owner, owner_1_name: owner, is_corporate_owner: true, owner_address_full: '1 Mail Rd', document_type: '', last_sale_doc_type: doc, recording_date: null, sale_price: price, mls_sold_price: mls };
  return normalizeCandidate(candidate, raw, null);
}

test('CALDWELL corrected: package excluded; foreclosure/government/$1.03M excluded from investor; builders+flip to retail; not authorized on contaminated evidence', () => {
  const comps = [
    // Cougar Crossing package (6 of ~30) — same buyer/date/consideration across parcels
    ...[1, 2, 3, 4, 5, 6].map((i) => cc(`pkg${i}`, { price: 30191000, sqft: 1557, yr: 2024, date: '2025-12-05', owner: 'Cougar Crossing LLC', zip: '83605' })),
    cc('godina', { price: 330500, yr: 2021, date: '2025-11-24', owner: 'Godina Real Estate LLC', doc: 'Trustee’s Deed' }), // foreclosure
    cc('tule', { price: 359989, yr: 1996, date: '2026-04-13', owner: 'Tule River Homebuyer Earned Equity Agency' }), // government
    cc('lyb', { price: 1030750, sqft: 1467, yr: 1937, date: '2026-01-15', owner: 'Lyb Properties LLC' }), // peer outlier
    cc('hayden1', { price: 309890, sqft: 1794, yr: 2025, date: '2026-02-04', owner: 'Hayden Homes Idaho LLC' }), // new construction
    cc('hayden2', { price: 402893, sqft: 1402, yr: 2025, date: '2025-11-17', owner: 'Hayden Homes Idaho LLC' }), // new construction
    cc('mac', { price: 560098, sqft: 1855, yr: 1961, date: '2026-04-28', owner: 'Macfarlane Renovations LLC' }), // flip
    cc('snh', { price: 348686, sqft: 1843, yr: 1951, date: '2026-01-12', owner: 'Snh Investments LLC' }),
    cc('autumn', { price: 356400, sqft: 1746, yr: 2021, date: '2026-04-17', owner: 'Autumngold Senior Services INC' }),
    cc('altitude', { price: 465780, sqft: 1920, yr: 1909, date: '2026-04-30', owner: 'Altitude Development LLC' }),
    cc('stw', { price: 354112, sqft: 1260, yr: 1994, date: '2026-04-03', owner: 'Stw Investments LLC', mls: 354112 }), // MLS retail
  ];
  const q = qualifyComps(CALDWELL, comps);
  const { v3 } = buildV3Decision({ subjectRow: CALDWELL, qualification: q, buyerPurchases: [], now: NOW });

  // package contributes no price
  assert.ok(v3.sample.package_cluster_count >= 1);
  // $30.191M never an accepted comp
  assert.ok(v3.universes[U.LOCAL_INVESTOR_VALUE].mid == null || v3.universes[U.LOCAL_INVESTOR_VALUE].mid < 1000000);
  // the $1.03M outlier is not in ordinary investor pricing
  const inv = v3.universes[U.LOCAL_INVESTOR_VALUE];
  const invConsiderations = (inv.comps ?? []).map((c) => c.consideration);
  assert.ok(!invConsiderations.includes(1030750), 'Lyb $1.03M must not be in investor pricing');
  assert.ok((inv.mid ?? 0) < 600000, `investor value must not be inflated, got ${inv.mid}`);
  // builders + flip routed to retail (not investor)
  const builderRoles = comps.filter((c) => ['hayden1', 'hayden2'].some((id) => c.id === id)).map((c) => c.evidence_role);
  assert.ok(builderRoles.every((r) => r === R.RETAIL_NEW_CONSTRUCTION_PRICING));
  assert.equal(comps.find((c) => c.id === 'mac').evidence_role, R.RENOVATED_ARV_PRICING);
  // foreclosure + government excluded from pricing
  assert.equal(comps.find((c) => c.id === 'godina').v3_pricing_eligible, false);
  assert.equal(comps.find((c) => c.id === 'tule').v3_pricing_eligible, false);
  // Evidence-supported result (NOT forced): whatever the state, the value/offer
  // must be UNCONTAMINATED — never derived from the $1.03M outlier, the package,
  // distressed, government, builder, or flip records.
  const auth = v3.offer_authorization.authorized_recommended_offer;
  assert.ok(auth === null || auth < 350000, `offer must be uncontaminated, got ${auth}`);
  assert.ok((inv.mid ?? 0) < 600000, `investor value must be de-inflated, got ${inv.mid}`);
  assert.ok(v3.reconciliation.reconciled_market_value_mid < 700000, 'market value must not be contaminated');
});

/* --------------------- guardrails --------------------- */

test('Austin remains non-executable; Houston disagreement behavior intact; V2 byte-identical', () => {
  const austin = { property_id: '2136762817', property_type: 'Multifamily 2-4', property_address_zip: '78744', building_square_feet: 1776, units_count: 2, estimated_value: 391000 };
  const aq = qualifyComps(austin, [cc('a1', { price: 332500000, sqft: 1728, yr: 1981, owner: 'X LLC' })]);
  const ad = buildV3Decision({ subjectRow: austin, qualification: aq, buyerPurchases: [], now: NOW });
  assert.equal(ad.v3.offer_authorization.authorized_recommended_offer, null);
  assert.notEqual(ad.v3.execution_state, 'SHADOW_MODE_READY');

  const off = calculateAcquisitionDecision({ subject: { property_id: 'x', property_type: 'SFR', estimated_value: 200000, building_square_feet: 1400, units_count: 1 }, comps: [], buyerPurchases: [], now: NOW, v3Enabled: false });
  assert.equal(off.v3, null);
});
