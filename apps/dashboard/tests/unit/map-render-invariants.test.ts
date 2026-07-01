import { describe, expect, it } from 'vitest'
import { TILE_ACCOUNTING_EDGE_RULE, computeTileAccountingDelta, getCoveringTileCoords, isPointInBounds } from '../../src/views/map/map-property-accounting'

describe('map property accounting', () => {
  it('computes covering tiles for a bounds box', () => {
    const tiles = getCoveringTileCoords({ west: -119, south: 33, east: -117, north: 35 }, 10)
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles[0]).toHaveProperty('z', 10)
  })

  it('filters points to exact bounds', () => {
    expect(isPointInBounds(-118, 34, { west: -119, south: 33, east: -117, north: 35 })).toBe(true)
    expect(isPointInBounds(-120, 34, { west: -119, south: 33, east: -117, north: 35 })).toBe(false)
  })

  it('documents tile vs canonical edge rule', () => {
    expect(TILE_ACCOUNTING_EDGE_RULE).toMatch(/exact lng\/lat/)
  })

  it('computes canonical minus unique tile delta', () => {
    expect(computeTileAccountingDelta(1000, 980)).toBe(20)
    expect(computeTileAccountingDelta(500, 500)).toBe(0)
  })
})