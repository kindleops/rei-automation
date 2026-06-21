/**
 * Acquisition Engine V3 — Stage 1 anomaly-defense regression tests.
 *
 * Encodes the live production anomalies proven in the Phase 0 audit
 * (docs/backend/acquisition_engine_v3_audit.md):
 *   - property 2136762817 — $332.5M Austin duplex contamination
 *   - property 242567952  — $30.19M Caldwell package cluster
 *   - property 2130847744 — must remain plausible (control)
 *
 * These exercise the new pure modules WITHOUT touching the live engine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSET_LANES,
  ASSET_FAMILIES,
  LANE_FAMILY,
} from '@/lib/acquisition/modelConstants.js';
import {
  classifyAssetLane,
  laneCompatible,
} from '@/lib/acquisition/assetClassification.js';
import {
  buildTransactions,
  clusterTransactions,
  effectiveSampleSize,
} from '@/lib/acquisition/transactionClustering.js';
import {
  qualifyComps,
  deriveAnchors,
} from '@/lib/acquisition/transactionQualification.js';
import { assertAcquisitionInvariants } from '@/lib/acquisition/acquisitionInvariants.js';

/* --------------------------------------------------------------------- */
/* Subjects (from live `properties`)                                      */
/* --------------------------------------------------------------------- */

const AUSTIN_DUPLEX = {
  property_id: '2136762817',
  property_type: 'Multifamily 2-4',
  property_class: 'Residential',
  property_address_zip: '78744',
  building_square_feet: 1776,
  units_count: 2,
  estimated_value: 391000,
};

const CALDWELL_SFR = {
  property_id: '242567952',
  property_type: 'SFR',
  property_class: 'Residential',
  property_address_zip: '83605',
  building_square_feet: 1550,
  units_count: 1,
  estimated_value: 309000,
};

const HOUSTON_SFR = {
  property_id: '2130847744',
  property_type: 'SFR',
  property_class: 'Residential',
  property_address_zip: '77035',
  building_square_feet: 1356,
  units_count: 1,
  estimated_value: 156000,
};

/* --------------------------------------------------------------------- */
/* 1. Canonical asset classification (mission §1)                         */
/* --------------------------------------------------------------------- */

test('asset lane: Multifamily 2-4 with 2 units => DUPLEX (small-multi), not MF5+', () => {
  const c = classifyAssetLane(AUSTIN_DUPLEX);
  assert.equal(c.lane, ASSET_LANES.DUPLEX);
  assert.equal(c.family, ASSET_FAMILIES.SMALL_MULTI);
  assert.equal(LANE_FAMILY[c.lane], ASSET_FAMILIES.SMALL_MULTI);
});

test('asset lane: SFR stays SFR; 50-unit apartment => MULTIFAMILY_21_99', () => {
  assert.equal(classifyAssetLane(CALDWELL_SFR).lane, ASSET_LANES.SFR);
  const apt = classifyAssetLane({ property_type: 'Apartment', units_count: 50 });
  assert.equal(apt.lane, ASSET_LANES.MULTIFAMILY_21_99);
  assert.equal(apt.family, ASSET_FAMILIES.MULTIFAMILY);
});

test('asset lane: distinct commercial/land lanes are recognized', () => {
  assert.equal(classifyAssetLane({ property_type: 'Self Storage Facility' }).lane, ASSET_LANES.SELF_STORAGE);
  assert.equal(classifyAssetLane({ property_type: 'Strip Shopping Center' }).lane, ASSET_LANES.RETAIL_STRIP_CENTER);
  assert.equal(classifyAssetLane({ property_type: 'Medical Office Building' }).lane, ASSET_LANES.OFFICE_MEDICAL);
  assert.equal(classifyAssetLane({ property_type: 'General Office' }).lane, ASSET_LANES.OFFICE_GENERAL);
  assert.notEqual(
    classifyAssetLane({ property_type: 'Medical Office Building' }).lane,
    classifyAssetLane({ property_type: 'General Office' }).lane,
  );
  assert.equal(classifyAssetLane({ property_type: 'Vacant Land', is_vacant_land: true }).lane, ASSET_LANES.LAND_RESIDENTIAL);
});

test('asset lane: conflicting unit count lowers confidence + flags conflict', () => {
  const c = classifyAssetLane({ property_type: 'Single Family', units_count: 3 });
  assert.ok(c.conflicting_signals.length > 0, 'should flag conflict');
  assert.ok(c.confidence <= 45, `confidence should be capped, got ${c.confidence}`);
});

test('lane compatibility: DUPLEX never comps against MF21-99; SFR never against CONDO', () => {
  assert.equal(laneCompatible(ASSET_LANES.DUPLEX, ASSET_LANES.MULTIFAMILY_21_99, { allowFallback: true }).compatible, false);
  assert.equal(laneCompatible(ASSET_LANES.SFR, ASSET_LANES.CONDO, { allowFallback: true }).compatible, false);
  assert.equal(laneCompatible(ASSET_LANES.SFR, ASSET_LANES.SFR).exact, true);
  // condo<->townhome only with explicit fallback enabled
  assert.equal(laneCompatible(ASSET_LANES.CONDO, ASSET_LANES.TOWNHOME, { allowFallback: false }).compatible, false);
  assert.equal(laneCompatible(ASSET_LANES.CONDO, ASSET_LANES.TOWNHOME, { allowFallback: true }).fallback, true);
});

/* --------------------------------------------------------------------- */
/* 2. Transaction clustering & package/duplicate detection (mission §2)    */
/* --------------------------------------------------------------------- */

function broadcastRows(price, date, n, baseZip = 90000) {
  return Array.from({ length: n }, (_, i) => ({
    property_id: `pkg-${i}`,
    property_address_full: `${100 + i} Package Way`,
    property_address_zip: String(baseZip + i),
    property_address_city: `City${i % 5}`,
    property_type: 'Single Family',
    building_square_feet: 1500,
    units_count: 1,
    sale_price: price,
    sale_date: date,
  }));
}

test('clustering: 12 parcels sharing one consideration/date => ONE package, not 12 comps', () => {
  const txs = buildTransactions(broadcastRows(30191000, '2024-06-21', 12));
  const { clusters } = clusterTransactions(txs);
  assert.equal(clusters.length, 1, 'all 12 parcels collapse to one cluster');
  assert.equal(clusters[0].distinct_parcels, 12);
  assert.ok(clusters[0].is_package, 'must be flagged as a package');
  assert.ok(clusters[0].package_sale_probability >= 0.9);

  const ess = effectiveSampleSize(clusters);
  assert.equal(ess.effective_sample_size, 0, 'a package contributes ZERO comp depth');
  assert.equal(ess.package_cluster_count, 1);
});

test('clustering: exact duplicate parcel rows do not add depth', () => {
  const dupRow = {
    property_id: 'dup-1',
    property_address_full: '1 Dup St',
    property_address_zip: '75001',
    property_type: 'Single Family',
    sale_price: 250000,
    sale_date: '2025-01-01',
  };
  const txs = buildTransactions([dupRow, { ...dupRow }]);
  const { clusters } = clusterTransactions(txs);
  const ess = effectiveSampleSize(clusters);
  assert.equal(ess.duplicate_row_count, 1, 'second identical parcel row is a duplicate');
  assert.equal(clusters[0].distinct_parcels, 1);
});

/* --------------------------------------------------------------------- */
/* 3. Anomaly 1 — $332.5M Austin duplex (mission §29)                      */
/* --------------------------------------------------------------------- */

// The actual contaminating comp + real broadcast siblings (from the audit).
const AUSTIN_CONTAMINATED_COMPS = [
  { property_id: '2136437952', property_address_full: '2000 E Stassney Ln, Austin, Tx 78744', property_address_zip: '78744', property_address_city: 'Austin', property_type: 'Multi-Family', units_count: 2, building_square_feet: 1728, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2135840413', property_address_full: '7457 Beckwood Dr, Fort Worth, Tx 76112', property_address_zip: '76112', property_address_city: 'Fort Worth', property_type: 'Single Family', units_count: 1, building_square_feet: 1357, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2130879947', property_address_full: '22202 Meadowgate Dr, Spring, Tx 77373', property_address_zip: '77373', property_address_city: 'Spring', property_type: 'Single Family', units_count: 1, building_square_feet: 1546, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2130712449', property_address_full: '7214 Foxbend Ln, Humble, Tx 77338', property_address_zip: '77338', property_address_city: 'Humble', property_type: 'Single Family', units_count: 1, building_square_feet: 1591, sale_price: 332500000, sale_date: '2025-04-09' },
];

test('ANOMALY 1: $332.5M comps are fully quarantined; zero accepted; flags raised', () => {
  const result = qualifyComps(AUSTIN_DUPLEX, AUSTIN_CONTAMINATED_COMPS);
  assert.equal(result.subject_lane, ASSET_LANES.DUPLEX);
  assert.equal(result.sample.accepted_count, 0, 'no $332.5M comp may be accepted');
  assert.equal(result.sample.effective_sample_size, 0);
  assert.ok(result.anomaly_flags.includes('IMPLAUSIBLE_COMP_PRICE'));
  assert.ok(result.anomaly_flags.includes('PACKAGE_CONSIDERATION_DETECTED'));
  assert.ok(result.anomaly_flags.includes('NO_INDEPENDENT_COMPS'));
});

test('ANOMALY 1 (single comp): even ONE $332.5M comp cannot be accepted', () => {
  // Reproduces the comp_count=1 case where V2 had no outlier removal at all.
  const result = qualifyComps(AUSTIN_DUPLEX, [AUSTIN_CONTAMINATED_COMPS[0]]);
  assert.equal(result.sample.accepted_count, 0);
  const reasons = result.rejected.flatMap((r) => r.reasons);
  assert.ok(
    reasons.includes('price_exceeds_lane_ceiling') || reasons.includes('implausible_ppsf_high') || reasons.includes('price_vs_anchor_high'),
    `expected a plausibility quarantine, got: ${reasons.join(',')}`,
  );
});

/* --------------------------------------------------------------------- */
/* 4. Anomaly 2 — $30.19M Caldwell package cluster (mission §29)           */
/* --------------------------------------------------------------------- */

test('ANOMALY 2: 12x $30.19M parcels => package, zero accepted, consistency cannot inflate', () => {
  // Same consideration + date across 12 parcels in several ZIPs (Caldwell area).
  const comps = broadcastRows(30191000, '2024-06-21', 12, 83600).map((r, i) => ({
    ...r,
    property_address_city: 'Caldwell',
    property_type: 'Single Family',
    building_square_feet: 1500 + i * 10,
  }));
  const result = qualifyComps(CALDWELL_SFR, comps);
  assert.equal(result.subject_lane, ASSET_LANES.SFR);
  assert.equal(result.sample.accepted_count, 0, 'no $30.19M parcel may become an independent comp');
  assert.equal(result.sample.package_cluster_count, 1, '12 rows = ONE economic transaction');
  assert.ok(result.anomaly_flags.includes('PACKAGE_CONSIDERATION_DETECTED'));
  assert.ok(result.anomaly_flags.includes('IMPLAUSIBLE_COMP_PRICE'));
});

/* --------------------------------------------------------------------- */
/* 5. Control — property 2130847744 must remain plausible (mission §29)    */
/* --------------------------------------------------------------------- */

const HOUSTON_GOOD_COMPS = [
  { property_id: 'h1', property_address_full: '6300 Cambridge Glen Ln, Houston, TX 77035', property_address_zip: '77035', property_address_city: 'Houston', property_type: 'Single Family', units_count: 1, building_square_feet: 1340, sale_price: 165000, sale_date: '2025-09-01' },
  { property_id: 'h2', property_address_full: '6412 Sharpview Dr, Houston, TX 77074', property_address_zip: '77074', property_address_city: 'Houston', property_type: 'Single Family', units_count: 1, building_square_feet: 1400, sale_price: 190000, sale_date: '2025-08-15' },
  { property_id: 'h3', property_address_full: '5810 Birdwood Rd, Houston, TX 77096', property_address_zip: '77096', property_address_city: 'Houston', property_type: 'Single Family', units_count: 1, building_square_feet: 1290, sale_price: 178000, sale_date: '2025-07-20' },
  { property_id: 'h4', property_address_full: '5102 Grape St, Houston, TX 77096', property_address_zip: '77096', property_address_city: 'Houston', property_type: 'Single Family', units_count: 1, building_square_feet: 1500, sale_price: 205000, sale_date: '2025-06-10' },
  { property_id: 'h5', property_address_full: '4710 Loch Lomond Dr, Houston, TX 77096', property_address_zip: '77096', property_address_city: 'Houston', property_type: 'Single Family', units_count: 1, building_square_feet: 1420, sale_price: 198000, sale_date: '2025-05-05' },
];

test('CONTROL 2130847744: clean SFR comps are accepted and produce real depth', () => {
  const result = qualifyComps(HOUSTON_SFR, HOUSTON_GOOD_COMPS);
  assert.equal(result.subject_lane, ASSET_LANES.SFR);
  assert.equal(result.sample.accepted_count, 5, 'all 5 clean comps accepted');
  assert.ok(result.sample.effective_sample_size >= 3);
  assert.equal(result.anomaly_flags.includes('IMPLAUSIBLE_COMP_PRICE'), false);
  assert.equal(result.anomaly_flags.includes('PACKAGE_CONSIDERATION_DETECTED'), false);
  assert.equal(result.sample.quarantined_count, 0);
});

test('anchors: derived from subject + lane only (never from comps)', () => {
  const a = deriveAnchors(AUSTIN_DUPLEX);
  assert.equal(a.has_anchor, true);
  assert.equal(a.anchor_mid, 391000);
  assert.equal(a.lane, ASSET_LANES.DUPLEX);
  assert.ok(a.lane_ceiling < 332500000, 'duplex ceiling must be far below the contaminated price');
});

/* --------------------------------------------------------------------- */
/* 6. Hard invariants (mission §23)                                        */
/* --------------------------------------------------------------------- */

test('invariants: catch contaminated valuation/offer vs anchor', () => {
  const r = assertAcquisitionInvariants({ valuation_mid: 332498300, recommended_cash_offer: 173028700, anchor_value: 391000 });
  assert.equal(r.ok, false);
  const codes = r.violations.map((v) => v.code);
  assert.ok(codes.includes('valuation_exceeds_anchor_hard_multiple'));
  assert.ok(codes.includes('offer_exceeds_anchor_hard_multiple'));
});

test('invariants: enforce ordering and offer bounds', () => {
  assert.equal(assertAcquisitionInvariants({ valuation_low: 100, valuation_mid: 90 }).ok, false);
  assert.equal(assertAcquisitionInvariants({ recommended_cash_offer: 200, maximum_cash_offer: 100 }).ok, false);
  assert.equal(assertAcquisitionInvariants({ maximum_cash_offer: 100, conservative_buyer_exit: 50 }).ok, false);
  assert.equal(assertAcquisitionInvariants({ valuation_mid: Infinity }).ok, false);
  assert.equal(assertAcquisitionInvariants({ estimated_repairs: -5 }).ok, false);
});

test('invariants: a clean decision passes', () => {
  const r = assertAcquisitionInvariants({
    valuation_low: 140000, valuation_mid: 156000, valuation_high: 175000,
    recommended_cash_offer: 95000, maximum_cash_offer: 110000, conservative_buyer_exit: 120000,
    estimated_repairs: 18000, anchor_value: 156000,
  });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.ok(r.checked > 5);
});

test('invariants: throwOnViolation throws with violations attached', () => {
  assert.throws(
    () => assertAcquisitionInvariants({ recommended_cash_offer: 200, maximum_cash_offer: 100 }, { throwOnViolation: true }),
    (err) => Array.isArray(err.violations) && err.violations.length > 0,
  );
});
