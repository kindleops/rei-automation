import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCoordinate,
  resolveCanonicalCoordinates,
} from '../../src/lib/domain/comp-intelligence/coordinate-resolver.js';

test('parseCoordinate rejects zero and invalid values', () => {
  assert.equal(parseCoordinate(null), null);
  assert.equal(parseCoordinate(''), null);
  assert.equal(parseCoordinate('0'), null);
  assert.equal(parseCoordinate('abc'), null);
  assert.equal(parseCoordinate('34.123'), 34.123);
});

test('resolveCanonicalCoordinates prefers property latitude/longitude', () => {
  const result = resolveCanonicalCoordinates({
    property: {
      property_id: 'p1',
      latitude: 34.1083,
      longitude: -117.2898,
      property_address_zip: '92407',
      market: 'San Bernardino',
    },
  });

  assert.equal(result.coordinate_source, 'subject_property');
  assert.equal(result.latitude, 34.1083);
  assert.equal(result.longitude, -117.2898);
  assert.equal(result.is_subject_resolved, true);
  assert.equal(result.is_market_fallback, false);
});

test('resolveCanonicalCoordinates reads lat/lng aliases', () => {
  const result = resolveCanonicalCoordinates({
    property: {
      lat: '34.0500',
      lng: '-117.3000',
    },
  });

  assert.equal(result.coordinate_source, 'subject_property');
  assert.equal(result.latitude, 34.05);
  assert.equal(result.longitude, -117.3);
});

test('resolveCanonicalCoordinates falls back to raw_payload_json', () => {
  const result = resolveCanonicalCoordinates({
    property: {
      raw_payload_json: { latitude: 34.2, longitude: -117.4 },
    },
  });

  assert.equal(result.coordinate_source, 'raw_payload');
  assert.equal(result.is_subject_resolved, true);
});

test('resolveCanonicalCoordinates detects reversed coordinates', () => {
  const result = resolveCanonicalCoordinates({
    property: {
      latitude: -117.2898,
      longitude: 34.1083,
    },
  });

  assert.equal(result.coordinate_reversed, true);
  assert.equal(result.latitude, 34.1083);
  assert.equal(result.longitude, -117.2898);
});

test('resolveCanonicalCoordinates returns market search only when unresolved', () => {
  const result = resolveCanonicalCoordinates({
    property: {
      property_address_zip: '92407',
      market: 'San Bernardino',
    },
  });

  assert.equal(result.is_subject_resolved, false);
  assert.equal(result.is_market_fallback, true);
  assert.equal(result.coordinate_source, 'market_search_only');
  assert.match(result.failure_reason, /market-level/i);
});