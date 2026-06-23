import { describe, expect, it } from 'vitest'
import { resolveCanonicalProperty } from './resolver'

describe('resolveCanonicalProperty', () => {
  it('resolves coordinates and square footage from property bag', () => {
    const result = resolveCanonicalProperty({
      dealContext: {
        propertyId: '217702430',
        propertyAddress: '3941 Don Diego St, San Bernardino, Ca 92407',
        property: {
          property_id: '217702430',
          latitude: 34.16738,
          longitude: -117.351567,
          building_square_feet: 1074,
          property_type: 'SFR',
          market: 'Inland Empire, CA',
        },
      } as never,
      thread: null,
    })

    expect(result?.property_id).toBe('217702430')
    expect(result?.latitude).toBeCloseTo(34.16738, 4)
    expect(result?.longitude).toBeCloseTo(-117.351567, 4)
    expect(result?.square_feet).toBe(1074)
    expect(result?.is_subject_resolved).toBe(true)
    expect(result?.is_market_fallback).toBe(false)
  })

  it('does not treat missing coordinates as zero', () => {
    const result = resolveCanonicalProperty({
      dealContext: {
        propertyId: '999',
        property: { property_id: '999', latitude: 0, longitude: 0 },
      } as never,
      thread: null,
    })

    expect(result?.latitude).toBeNull()
    expect(result?.longitude).toBeNull()
    expect(result?.is_subject_resolved).toBe(false)
  })
})