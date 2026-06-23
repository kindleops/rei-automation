import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCompMatchScore,
  INCLUSION_THRESHOLD,
} from '../../src/lib/domain/comp-intelligence/comp-scoring.js';

test('calculateCompMatchScore auto-includes strong nearby residential comps', () => {
  const subject = {
    asset_type: 'single_family',
    property_type: 'Single Family',
    square_feet: 1400,
    bedrooms: 3,
    bathrooms: 2,
    year_built: 1985,
    condition: 'Average',
    estimated_value: 300000,
  };

  const comp = {
    asset_type: 'single_family',
    property_type: 'Single Family',
    square_feet: 1450,
    bedrooms: 3,
    bathrooms: 2,
    year_built: 1988,
    condition: 'Average',
    distance_miles: 0.2,
    sold_price: 310000,
    sale_date: new Date().toISOString(),
    latitude: 34.1,
    longitude: -117.29,
  };

  const scoring = calculateCompMatchScore(comp, subject);
  assert.ok(scoring.score >= INCLUSION_THRESHOLD);
  assert.equal(scoring.auto_included, true);
  assert.equal(scoring.auto_excluded, false);
});

test('calculateCompMatchScore excludes missing sale price', () => {
  const scoring = calculateCompMatchScore(
    { distance_miles: 0.1, asset_type: 'single_family' },
    { asset_type: 'single_family', square_feet: 1200 },
  );

  assert.equal(scoring.auto_included, false);
  assert.ok(scoring.exclusion_reasons.includes('Missing sale price'));
});