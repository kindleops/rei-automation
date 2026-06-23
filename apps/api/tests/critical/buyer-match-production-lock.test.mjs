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
import {
  hydrateBuyerMatchSubjectFromCanonical,
  normalizeSubject,
} from '../../src/lib/intel/buyer-match-engine.js';

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

test('hydrateBuyerMatchSubjectFromCanonical copies exact canonical coordinates', async () => {
  const canonicalLat = 47.69097;
  const canonicalLng = -117.402042;
  const propertyId = '2145765207';

  const { subject } = await hydrateBuyerMatchSubjectFromCanonical(
    { property_id: propertyId },
    {
      loadCanonicalSubjectProperty: async () => ({
        ok: true,
        subject: {
          property_id: propertyId,
          latitude: { value: canonicalLat, present: true },
          longitude: { value: canonicalLng, present: true },
          canonical_address: { value: '527 E Gordon Ave, Spokane, WA', present: true },
          zip: { value: '99202', present: true },
          market: { value: 'Spokane', present: true },
          state: { value: 'WA', present: true },
          asset_type: { value: 'single_family', present: true },
          is_subject_resolved: true,
          is_market_fallback: false,
          coordinate_source: 'properties.latitude',
        },
      }),
    },
  );

  const normalized = normalizeSubject(subject);
  assert.equal(normalized.lat, canonicalLat);
  assert.equal(normalized.lng, canonicalLng);
  assert.equal(normalized.property_id, propertyId);
  assert.equal(normalized.zip, '99202');
});

test('hydrateBuyerMatchSubjectFromCanonical preserves caller coordinates when provided', async () => {
  const { subject } = await hydrateBuyerMatchSubjectFromCanonical(
    { property_id: '2145765207', lat: 1.23, lng: 4.56 },
    {
      loadCanonicalSubjectProperty: async () => {
        throw new Error('canonical loader must not run when coordinates are present');
      },
    },
  );

  assert.equal(subject.lat, 1.23);
  assert.equal(subject.lng, 4.56);
});

test('hydrateBuyerMatchSubjectFromCanonical rejects resolved canonical subject without coordinates', async () => {
  await assert.rejects(
    () => hydrateBuyerMatchSubjectFromCanonical(
      { property_id: '2145765207' },
      {
        loadCanonicalSubjectProperty: async () => ({
          ok: true,
          subject: {
            property_id: '2145765207',
            latitude: { value: null, present: false },
            longitude: { value: null, present: false },
            is_subject_resolved: true,
            is_market_fallback: false,
          },
        }),
      },
    ),
    (error) => error?.code === 'coordinates_unavailable',
  );
});