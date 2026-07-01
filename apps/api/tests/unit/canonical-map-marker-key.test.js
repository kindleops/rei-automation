import { describe, expect, it } from 'vitest'
import { resolveCanonicalMapMarkerKey } from '../../src/lib/domain/map/canonical-map-marker-key.js'

describe('canonical map marker key resolver', () => {
  it('maps normalizeMapAssetType outputs to marker keys', () => {
    expect(resolveCanonicalMapMarkerKey({}, 'sfr')).toBe('single_family')
    expect(resolveCanonicalMapMarkerKey({}, 'multifamily_small')).toBe('multifamily_2_4')
    expect(resolveCanonicalMapMarkerKey({}, 'shopping_plaza')).toBe('retail_strip')
    expect(resolveCanonicalMapMarkerKey({ property_type: 'Duplex' }, 'unknown')).toBe('multifamily_2_4')
  })
})