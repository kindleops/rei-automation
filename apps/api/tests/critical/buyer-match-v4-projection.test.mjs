import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUYER_MATCH_V4_VERSION,
  mapFallbackLevel,
  mapBuyerArchetype,
  mapInstitutionalStatus,
  resolveMarketDataState,
  buildReasonSummary,
} from '../../src/lib/intel/buyer-match-v4-projection.js';

test('mapFallbackLevel maps engine tiers to V4 labels', () => {
  assert.equal(mapFallbackLevel('zip'), 'EXACT_ZIP');
  assert.equal(mapFallbackLevel('radius'), 'RADIUS');
  assert.equal(mapFallbackLevel('market'), 'MARKET');
  assert.equal(mapFallbackLevel('state'), 'STATE');
  assert.equal(mapFallbackLevel('none'), 'NONE');
});

test('mapBuyerArchetype does not label hedge funds from score alone', () => {
  assert.equal(mapBuyerArchetype({ buyer_type: 'institutional' }), 'Verified institutional buyer');
  assert.equal(mapBuyerArchetype({ institutional_score: 95, buyer_type: 'corporate' }), 'Corporate repeat buyer');
  assert.equal(mapBuyerArchetype({ is_repeat_buyer: true }), 'Local investor');
  assert.equal(mapBuyerArchetype({}), 'Unknown');
});

test('mapInstitutionalStatus only marks verified institutional type', () => {
  assert.equal(mapInstitutionalStatus({ buyer_type: 'institutional' }), 'VERIFIED_INSTITUTIONAL');
  assert.equal(mapInstitutionalStatus({ institutional_score: 99 }), null);
  assert.equal(mapInstitutionalStatus({ is_corporate_buyer: true }), 'CORPORATE');
});

test('resolveMarketDataState returns NO_LOCAL_DATA when no buyers and no events', () => {
  const state = resolveMarketDataState({
    subject: { lat: 29.8, lng: -95.4, zip: '77091', is_subject_resolved: true },
    candidates: [],
    purchaseEvents: [],
    cached: false,
    cacheIncomplete: false,
    intelError: null,
    rollup: null,
  });
  assert.equal(state, 'NO_LOCAL_DATA');
});

test('resolveMarketDataState returns PARTIAL for incomplete cache with buyers', () => {
  const state = resolveMarketDataState({
    subject: { lat: 29.8, lng: -95.4, zip: '77091', is_subject_resolved: true },
    candidates: [{ fallback_level: 'zip', match_grade: 'A' }],
    purchaseEvents: [],
    cached: true,
    cacheIncomplete: true,
    intelError: null,
    rollup: null,
  });
  assert.equal(state, 'PARTIAL');
});

test('resolveMarketDataState returns SUBJECT_COORDINATES_REQUIRED when coords and zip missing', () => {
  const state = resolveMarketDataState({
    subject: { lat: null, lng: null, zip: null, is_subject_resolved: false },
    candidates: [],
    purchaseEvents: [],
    cached: false,
    cacheIncomplete: false,
    intelError: null,
    rollup: null,
  });
  assert.equal(state, 'SUBJECT_COORDINATES_REQUIRED');
});

test('buildReasonSummary prefers RPC reason_for_match', () => {
  const summary = buildReasonSummary({ reason_for_match: '6 purchases in ZIP 77091' });
  assert.deepEqual(summary, ['6 purchases in ZIP 77091']);
});

test('BUYER_MATCH_V4_VERSION is set', () => {
  assert.equal(BUYER_MATCH_V4_VERSION, 'buyer_match_v4.0');
});