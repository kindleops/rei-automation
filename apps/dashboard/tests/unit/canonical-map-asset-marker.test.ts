import { describe, expect, it } from 'vitest'
import {
  CANONICAL_MAP_MARKER_KEYS,
  MARKER_KEY_TO_PIN_ICON,
  resolveCanonicalMapMarkerKey,
} from '../../src/views/map/canonical-map-asset-marker'
import { PIN_ICON } from '../../src/views/map/pin-icons'

describe('canonical map asset marker keys', () => {
  it('normalizes API asset types into stable marker keys', () => {
    expect(resolveCanonicalMapMarkerKey({ assetType: 'sfr' })).toBe('single_family')
    expect(resolveCanonicalMapMarkerKey({ assetType: 'multifamily_small' })).toBe('multifamily_2_4')
    expect(resolveCanonicalMapMarkerKey({ assetType: 'multifamily_large' })).toBe('multifamily_5_plus')
    expect(resolveCanonicalMapMarkerKey({ assetType: 'shopping_plaza' })).toBe('retail_strip')
    expect(resolveCanonicalMapMarkerKey({ assetType: 'storage' })).toBe('storage')
    expect(resolveCanonicalMapMarkerKey({ propertyType: 'Vacant Land' })).toBe('land')
  })

  it('maps every canonical key to a registered pin sprite', () => {
    for (const key of CANONICAL_MAP_MARKER_KEYS) {
      expect(MARKER_KEY_TO_PIN_ICON[key]).toBeTruthy()
      expect(Object.values(PIN_ICON)).toContain(MARKER_KEY_TO_PIN_ICON[key])
    }
  })

  it('never returns empty for unknown raw types', () => {
    expect(resolveCanonicalMapMarkerKey({ propertyType: 'Totally Novel Asset' })).toBe('unknown')
  })
})