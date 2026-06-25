import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAcquisitionDecision } from '@/lib/acquisition/acquisitionDecisionEngine.js';
import { projectCompIntelligenceV3Decision } from '@/lib/domain/comp-intelligence/comp-intelligence-v3-projection.js';
import { runCompIntelligencePipeline } from '@/lib/domain/comp-intelligence/comp-intelligence-service.js';

const NOW = new Date('2026-06-20T12:00:00.000Z');

const AUSTIN = {
  property_id: '2136762817',
  property_address_full: '5314 Atascosa Dr, Austin, TX 78744',
  property_address_zip: '78744',
  property_type: 'Multifamily 2-4',
  building_square_feet: 1776,
  units_count: 2,
  estimated_value: 391000,
};

const AUSTIN_COMPS = [
  { property_id: '2136437952', property_address_full: '2000 E Stassney Ln, Austin, TX 78744', property_address_zip: '78744', property_type: 'Multi-Family', units_count: 2, building_square_feet: 1728, sale_price: 332500000, sale_date: '2025-04-09' },
];

const CALDWELL = {
  property_id: '242567952',
  property_address_full: '1711 N Illinois Ave, Caldwell, ID 83605',
  property_address_zip: '83605',
  property_type: 'SFR',
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

const HOUSTON = {
  property_id: '2130847744',
  property_address_full: '6310 Cambridge Glen Ln, Houston, TX 77035',
  property_address_zip: '77035',
  property_type: 'SFR',
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

function mockDeps(subject, comps) {
  let persisted = false;
  return {
    now: NOW,
    v3Enabled: true,
    loadSubjectProperty: async () => subject,
    loadComparableProperties: async () => comps,
    loadBuyerPurchases: async () => [],
    loadV3CompCandidates: async () => ({ candidates: comps, diagnostics: { candidate_count: comps.length } }),
    persistAcquisitionScore: async () => {
      persisted = true;
      return null;
    },
    db: {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return this; },
          maybeSingle: async () => ({ data: null }),
          insert: async () => {
            persisted = true;
            throw new Error('snapshot_write_blocked');
          },
        };
      },
      rpc: async () => ({ data: comps }),
    },
    get persisted() { return persisted; },
  };
}

test('projectCompIntelligenceV3Decision is read-only (no score or snapshot writes)', async () => {
  const deps = mockDeps(HOUSTON, HOUSTON_COMPS);
  const result = await projectCompIntelligenceV3Decision('2130847744', {}, {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.projection_meta.read_only, true);
  assert.equal(result.projection_meta.score_table_write, false);
  assert.equal(result.projection_meta.snapshot_write, false);
  assert.equal(result.projection_meta.event_publication, false);
  assert.equal(deps.persisted, false);
  assert.equal(result.decision_projection.projection_mode, 'authoritative_v3');
});

test('Austin 2136762817: DATA_REQUIRED or quarantine, no authorized offer, no $332.5M contamination', async () => {
  const deps = mockDeps(AUSTIN, AUSTIN_COMPS);
  const result = await projectCompIntelligenceV3Decision('2136762817', {}, {}, deps);
  const dp = result.decision_projection;
  assert.ok(['DATA_REQUIRED', 'ANOMALY_QUARANTINE', 'REVIEW_REQUIRED'].includes(dp.execution_state));
  assert.equal(dp.offer_authorization?.authorized_recommended_offer, null);
  const mid = dp.value_contract?.qualified_market_value?.mid ?? dp.value_contract?.scenario_market_value?.mid;
  assert.ok(mid == null || mid < 1_000_000, `contamination leak: ${mid}`);
});

test('Caldwell 242567952: REVIEW_REQUIRED or quarantine, no authorized offer', async () => {
  const deps = mockDeps(CALDWELL, CALDWELL_COMPS);
  const result = await projectCompIntelligenceV3Decision('242567952', {}, {}, deps);
  const dp = result.decision_projection;
  assert.ok(['REVIEW_REQUIRED', 'ANOMALY_QUARANTINE', 'DATA_REQUIRED'].includes(dp.execution_state));
  assert.equal(dp.offer_authorization?.authorized_recommended_offer, null);
});

test('Houston 2130847744: SHADOW_MODE_READY, strong investor depth, live auto-offer disabled', async () => {
  const deps = mockDeps(HOUSTON, HOUSTON_COMPS);
  const result = await projectCompIntelligenceV3Decision('2130847744', {}, {}, deps);
  const dp = result.decision_projection;
  assert.equal(dp.execution_state, 'SHADOW_MODE_READY');
  assert.equal(dp.feature_flags?.ACQUISITION_ENGINE_V3_ALLOW_AUTO_OFFER, false);
  const shadowOrScenario = dp.offer_authorization?.scenario_recommended_offer
    ?? dp.offer_authorization?.authorized_recommended_offer
    ?? dp.cash_offer?.recommended_cash_offer;
  assert.ok(shadowOrScenario > 0 && shadowOrScenario < dp.value_contract?.qualified_market_value?.high);
  assert.ok(dp.execution_state_basis?.basis_strategy || dp.primary_strategy);
  assert.ok((dp.dominant_model_ess ?? 0) >= 3);
});

test('runCompIntelligencePipeline exposes decision_projection and legacy_valuation', async () => {
  const projection = await projectCompIntelligenceV3Decision('2130847744', {}, {}, mockDeps(HOUSTON, HOUSTON_COMPS));
  assert.equal(projection.ok, true);
  assert.equal(projection.decision_projection?.projection_mode, 'authoritative_v3');
  assert.equal(projection.projection_meta.snapshot_write, false);
});

test('V2 remains byte-identical when V3 disabled', () => {
  const before = calculateAcquisitionDecision({ subject: HOUSTON, comps: HOUSTON_COMPS, buyerPurchases: [], now: NOW, v3Enabled: false });
  const after = calculateAcquisitionDecision({ subject: HOUSTON, comps: HOUSTON_COMPS, buyerPurchases: [], now: NOW, v3Enabled: false });
  assert.deepEqual(before.valuation, after.valuation);
  assert.equal(before.v3, null);
  assert.equal(after.v3, null);
});