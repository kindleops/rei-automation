import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBuyerMatchError,
  sanitizeErrorMessage,
  buyerMatchErrorResponse,
} from '../../src/lib/intel/buyer-match-api-errors.js';
import { buildCanonicalBuyerDemand } from '../../src/lib/intel/buyer-match-demand.js';
import {
  buildIdempotencyKey,
  BUYER_MATCH_MODEL_VERSION,
} from '../../src/lib/intel/buyer-match-job-service.js';
import { normalizeSubject } from '../../src/lib/intel/buyer-match-engine.js';

test('sanitizeErrorMessage strips Sentry vendor-chunk paths', () => {
  const raw = "Cannot find module './vendor-chunks/@sentry.js' at /Users/dev/rei-automation/apps/api/.next/server/app/api/intel/buyer-match/route.js";
  const sanitized = sanitizeErrorMessage(raw);
  assert.ok(!sanitized.includes('vendor-chunks'));
  assert.ok(!sanitized.includes('/Users/'));
  assert.ok(!sanitized.includes('@sentry'));
  assert.match(sanitized, /stale|unavailable|Retry/i);
});

test('buyerMatchErrorResponse never exposes raw stack details', () => {
  const res = buyerMatchErrorResponse("MODULE_NOT_FOUND: webpack-runtime");
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'api_runtime_build_error');
  assert.ok(!String(res.message).includes('webpack'));
});

test('buildCanonicalBuyerDemand distinguishes source failure from zero buyers', () => {
  const failed = buildCanonicalBuyerDemand({
    candidates: [],
    source_failure: true,
    fallback_level: 'none',
  });
  assert.equal(failed.data_state, 'source_unavailable');
  assert.equal(failed.buyer_count, 0);

  const empty = buildCanonicalBuyerDemand({
    candidates: [],
    rollup: { purchase_count: 12, buyer_count: 4 },
    fallback_level: 'market',
  });
  assert.equal(empty.data_state, 'buyers_exist_no_match');
  assert.equal(empty.rollup_purchase_count, 12);
});

test('buildCanonicalBuyerDemand counts grades and liquidity tiers', () => {
  const demand = buildCanonicalBuyerDemand({
    candidates: [
      { match_grade: 'A+', is_repeat_buyer: true, last_purchase_date: new Date().toISOString() },
      { match_grade: 'A', is_corporate_buyer: true, buyer_type: 'corporate' },
      { match_grade: 'B' },
    ],
    demand_score: 72,
    liquidity_score: 68,
    confidence: 80,
    fallback_level: 'zip',
  });
  assert.equal(demand.a_plus_count, 1);
  assert.equal(demand.a_count, 1);
  assert.equal(demand.repeat_buyer_count, 1);
  assert.equal(demand.corporate_count, 1);
  assert.equal(demand.qualified_buyer_count, 3);
  assert.equal(demand.active_within_30d_count, 1);
  assert.ok(demand.likely_buyer_price_range === null || typeof demand.likely_buyer_price_range.low === 'number');
});

test('buildIdempotencyKey is deterministic per property and model version', () => {
  const key = buildIdempotencyKey({ property_id: 'p123', valuation_snapshot_id: 'vs1' });
  assert.match(key, /^p123:/);
  assert.ok(key.includes(BUYER_MATCH_MODEL_VERSION));
});

test('normalizeSubject uses canonical coordinate aliases', () => {
  const subject = normalizeSubject({
    property_id: '99',
    latitude: 36.154,
    longitude: -95.9928,
    property_zip: '74127',
    normalized_asset_class: 'single_family',
  });
  assert.equal(subject.lat, 36.154);
  assert.equal(subject.lng, -95.9928);
  assert.equal(subject.zip, '74127');
  assert.equal(subject.asset_class, 'single_family');
});

test('classifyBuyerMatchError marks coordinate issues non-retryable when appropriate', () => {
  const c = classifyBuyerMatchError('coordinates unavailable for subject');
  assert.equal(c.error_code, 'coordinates_unavailable');
});