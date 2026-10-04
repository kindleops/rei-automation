import { describe, expect, it } from 'vitest'
import { withCardCoordinates } from './seller-card-coordinates'

describe('withCardCoordinates', () => {
  it('seeds the click position when the tile feature has no coordinates', () => {
    const tile = { property_id: '273446517', equity_percent: 40 }
    const out = withCardCoordinates(tile, [-93.29, 45.0])
    expect(out).toMatchObject({ property_id: '273446517', latitude: 45.0, longitude: -93.29 })
    expect(tile).not.toHaveProperty('latitude')
  })

  it('is identity-stable across renders for the same feature', () => {
    const tile = { property_id: '1' }
    expect(withCardCoordinates(tile, [-93.29, 45])).toBe(withCardCoordinates(tile, [-93.29, 45]))
  })

  it('never overrides hydrated coordinates', () => {
    const hydrated = { property_id: '1', latitude: 44.9, longitude: -93.1 }
    expect(withCardCoordinates(hydrated, [-93.29, 45])).toBe(hydrated)
    const alt = { property_id: '1', lat: '44.9', lng: '-93.1' }
    expect(withCardCoordinates(alt, [-93.29, 45])).toBe(alt)
  })

  it('leaves the record alone without usable coordinates', () => {
    const tile = { property_id: '1' }
    expect(withCardCoordinates(tile, null)).toBe(tile)
    expect(withCardCoordinates(tile, [0, 0])).toBe(tile)
  })
})
