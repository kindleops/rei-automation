import { describe, expect, it } from 'vitest'
import {
  shouldUseAggregateSource,
  shouldUseVectorTileSource,
} from '../../src/views/map/map-property-source'

describe('map property accounting source bands', () => {
  it('uses aggregates below zoom 9 and tiles at zoom 9+', () => {
    expect(shouldUseAggregateSource(5.5)).toBe(true)
    expect(shouldUseAggregateSource(8.9)).toBe(true)
    expect(shouldUseVectorTileSource(9)).toBe(true)
    expect(shouldUseVectorTileSource(12)).toBe(true)
    expect(shouldUseAggregateSource(9)).toBe(false)
  })

  it('never enables aggregate and tile sources on the same zoom', () => {
    for (const zoom of [0, 4, 6, 8, 8.99, 9, 10, 12, 14]) {
      const aggregate = shouldUseAggregateSource(zoom)
      const tiles = shouldUseVectorTileSource(zoom)
      expect(aggregate && tiles).toBe(false)
      if (zoom < 9) expect(aggregate).toBe(true)
      if (zoom >= 9) expect(tiles).toBe(true)
    }
  })
})