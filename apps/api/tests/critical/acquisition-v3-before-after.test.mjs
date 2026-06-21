/**
 * Acquisition Engine V3 — before/after proof through the LIVE engine.
 *
 * Runs calculateAcquisitionDecision with the V3 flag OFF (reproduces the V2
 * contamination) and ON (defense layer active) over the real contaminating comp
 * rows from the audit. Proves:
 *   - flag OFF  => byte-for-byte V2 behavior (v3 block is null)
 *   - flag ON   => $332.5M / $30.19M comps removed; sane, non-executable result
 *   - control   => stays plausible under both
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateAcquisitionDecision } from '@/lib/acquisition/acquisitionDecisionEngine.js';

const NOW = new Date('2026-06-20T12:00:00.000Z');

const AUSTIN_DUPLEX = {
  property_id: '2136762817',
  property_address_full: '5314 Atascosa Dr, Austin, TX 78744',
  property_address_zip: '78744',
  market: 'Austin, TX',
  property_type: 'Multifamily 2-4',
  property_class: 'Residential',
  building_square_feet: 1776,
  units_count: 2,
  estimated_value: 391000,
};

// Real contaminating comp (same ZIP, near-identical) + real broadcast siblings.
const AUSTIN_COMPS = [
  { property_id: '2136437952', property_address_full: '2000 E Stassney Ln, Austin, TX 78744', property_address_zip: '78744', property_type: 'Multi-Family', units_count: 2, building_square_feet: 1728, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2135840413', property_address_full: '7457 Beckwood Dr, Fort Worth, TX 76112', property_address_zip: '76112', property_type: 'Single Family', units_count: 1, building_square_feet: 1357, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2130879947', property_address_full: '22202 Meadowgate Dr, Spring, TX 77373', property_address_zip: '77373', property_type: 'Single Family', units_count: 1, building_square_feet: 1546, sale_price: 332500000, sale_date: '2025-04-09' },
  { property_id: '2130712449', property_address_full: '7214 Foxbend Ln, Humble, TX 77338', property_address_zip: '77338', property_type: 'Single Family', units_count: 1, building_square_feet: 1591, sale_price: 332500000, sale_date: '2025-04-09' },
];

const CALDWELL_SFR = {
  property_id: '242567952',
  property_address_full: '1711 N Illinois Ave, Caldwell, ID 83605',
  property_address_zip: '83605',
  market: 'Boise, ID',
  property_type: 'SFR',
  property_class: 'Residential',
  building_square_feet: 1550,
  units_count: 1,
  estimated_value: 309000,
};

const CALDWELL_COMPS = Array.from({ length: 12 }, (_, i) => ({
  property_id: `cald-${i}`,
  property_address_full: `${100 + i} Package Ave, Caldwell, ID 83605`,
  property_address_zip: '83605',
  property_type: 'Single Family',
  units_count: 1,
  building_square_feet: 1500 + i * 10,
  sale_price: 30191000,
  sale_date: '2024-06-21',
}));

const HOUSTON_SFR = {
  property_id: '2130847744',
  property_address_full: '6310 Cambridge Glen Ln, Houston, TX 77035',
  property_address_zip: '77035',
  market: 'Houston, TX',
  property_type: 'SFR',
  property_class: 'Residential',
  building_square_feet: 1356,
  units_count: 1,
  estimated_value: 156000,
  latitude: 29.65086,
  longitude: -95.50109,
};

const HOUSTON_COMPS = [
  { property_id: 'h1', property_address_full: '6300 Cambridge Glen Ln, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1340, sale_price: 165000, sale_date: '2025-09-01', latitude: 29.6510, longitude: -95.5012 },
  { property_id: 'h2', property_address_full: '6412 Sharpview Dr, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1400, sale_price: 190000, sale_date: '2025-08-15', latitude: 29.6520, longitude: -95.5030 },
  { property_id: 'h3', property_address_full: '5810 Birdwood Rd, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1290, sale_price: 178000, sale_date: '2025-07-20', latitude: 29.6495, longitude: -95.4995 },
  { property_id: 'h4', property_address_full: '5102 Grape St, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1500, sale_price: 205000, sale_date: '2025-06-10', latitude: 29.6531, longitude: -95.5040 },
  { property_id: 'h5', property_address_full: '4710 Loch Lomond Dr, Houston, TX 77035', property_address_zip: '77035', property_type: 'Single Family', units_count: 1, building_square_feet: 1420, sale_price: 198000, sale_date: '2025-05-05', latitude: 29.6488, longitude: -95.4980 },
];

function run(subject, comps, v3Enabled) {
  return calculateAcquisitionDecision({ subject, comps, buyerPurchases: [], now: NOW, v3Enabled });
}

test('BEFORE/AFTER 2136762817 (Austin duplex)', () => {
  const before = run(AUSTIN_DUPLEX, AUSTIN_COMPS, false);
  const after = run(AUSTIN_DUPLEX, AUSTIN_COMPS, true);
  console.log('  Austin BEFORE valuation_mid=%s offer=%s', before.valuation.mid, before.offer.recommended_cash_offer);
  console.log('  Austin AFTER  valuation_mid=%s offer=%s state=%s flags=%j',
    after.valuation.mid, after.offer.recommended_cash_offer, after.v3.execution_state, after.v3.anomaly_flags);

  assert.ok(before.valuation.mid > 100_000_000, 'V2 reproduces the contamination');
  assert.equal(before.v3, null, 'flag OFF => no v3 block (V2 unchanged)');

  assert.ok(after.valuation.mid < 1_000_000, `V3 valuation must be sane, got ${after.valuation.mid}`);
  assert.equal(after.v3.canonical_asset_lane, 'DUPLEX');
  assert.equal(after.v3.execution_state, 'ANOMALY_QUARANTINE');
  assert.ok(after.v3.anomaly_flags.includes('IMPLAUSIBLE_COMP_PRICE'));
  assert.ok(after.offer.recommended_cash_offer === null || after.offer.recommended_cash_offer < 1_000_000);
});

test('BEFORE/AFTER 242567952 (Caldwell package)', () => {
  const before = run(CALDWELL_SFR, CALDWELL_COMPS, false);
  const after = run(CALDWELL_SFR, CALDWELL_COMPS, true);
  console.log('  Caldwell BEFORE valuation_mid=%s offer=%s', before.valuation.mid, before.offer.recommended_cash_offer);
  console.log('  Caldwell AFTER  valuation_mid=%s offer=%s state=%s flags=%j',
    after.valuation.mid, after.offer.recommended_cash_offer, after.v3.execution_state, after.v3.anomaly_flags);

  assert.ok(before.valuation.mid > 10_000_000, 'V2 reproduces the package contamination');
  assert.ok(after.valuation.mid < 1_000_000, `V3 valuation must be sane, got ${after.valuation.mid}`);
  assert.equal(after.v3.execution_state, 'ANOMALY_QUARANTINE');
  assert.equal(after.v3.sample.package_cluster_count, 1, '12 rows = ONE economic transaction');
  assert.ok(after.v3.anomaly_flags.includes('PACKAGE_CONSIDERATION_DETECTED'));
});

test('REGRESSION 2130847744 (Houston SFR) stays plausible under both', () => {
  const before = run(HOUSTON_SFR, HOUSTON_COMPS, false);
  const after = run(HOUSTON_SFR, HOUSTON_COMPS, true);
  console.log('  Houston BEFORE valuation_mid=%s offer=%s', before.valuation.mid, before.offer.recommended_cash_offer);
  console.log('  Houston AFTER  valuation_mid=%s offer=%s state=%s flags=%j',
    after.valuation.mid, after.offer.recommended_cash_offer, after.v3.execution_state, after.v3.anomaly_flags);

  for (const r of [before, after]) {
    assert.ok(r.valuation.mid > 120_000 && r.valuation.mid < 320_000, `plausible valuation, got ${r.valuation.mid}`);
  }
  assert.equal(after.v3.canonical_asset_lane, 'SFR');
  assert.equal(after.v3.anomaly_flags.includes('IMPLAUSIBLE_COMP_PRICE'), false);
  assert.equal(after.v3.anomaly_flags.includes('PACKAGE_CONSIDERATION_DETECTED'), false);
  assert.ok(after.v3.sample.effective_sample_size >= 3);
  assert.equal(after.v3.execution_state, 'SHADOW_MODE_READY');
  assert.ok(after.offer.recommended_cash_offer > 0 && after.offer.recommended_cash_offer <= after.valuation.high);
});

test('flag OFF leaves V2 output identical (no v3 block on any path)', () => {
  const off = run(HOUSTON_SFR, HOUSTON_COMPS, false);
  assert.equal(off.v3, null);
  assert.equal(off.evidence.v3, null);
});
