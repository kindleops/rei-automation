import test from 'node:test'
import assert from 'node:assert/strict'
import { INCLUSION_THRESHOLD } from '../../src/lib/domain/comp-intelligence/comp-scoring.js'

test('inclusion threshold allows usable suburban comps', () => {
  assert.ok(INCLUSION_THRESHOLD <= 50)
})

test('canonical coordinate resolver rejects zero coordinates', async () => {
  const { parseCoordinate } = await import('../../src/lib/domain/comp-intelligence/coordinate-resolver.js')
  assert.equal(parseCoordinate(0), null)
  assert.equal(parseCoordinate('34.16738'), 34.16738)
})

test('missing sqft must not block comp candidate scoring shape', async () => {
  const { calculateCompMatchScore } = await import('../../src/lib/domain/comp-intelligence/comp-scoring.js')
  const result = calculateCompMatchScore(
    {
      distance_miles: 2.3,
      asset_type: 'single_family',
      property_type: 'SFR',
      sold_price: 420000,
      latitude: 34.14,
      longitude: -117.32,
      building_square_feet: 1800,
    },
    {
      asset_type: 'single_family',
      property_type: 'SFR',
      square_feet: null,
      estimated_value: null,
    },
  )
  assert.ok(result.score > 0)
  assert.ok(Array.isArray(result.exclusion_reasons))
})