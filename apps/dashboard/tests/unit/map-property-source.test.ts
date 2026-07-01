import { describe, expect, it } from 'vitest'
import {
  formatClusterCountLabel,
  getMapPropertyFetchMode,
  getMapZoomBand,
  shouldUseAggregateSource,
  shouldUsePropertySource,
  shouldUseVectorTileSource,
} from '../../src/views/map/map-property-source'

describe('map property source zoom bands', () => {
  it('uses aggregate source below city zoom', () => {
    expect(shouldUseAggregateSource(4)).toBe(true)
    expect(shouldUseAggregateSource(7)).toBe(true)
    expect(shouldUsePropertySource(7)).toBe(false)
    expect(shouldUseVectorTileSource(7)).toBe(false)
    expect(shouldUseVectorTileSource(10)).toBe(true)
    expect(shouldUsePropertySource(10)).toBe(true)
  })

  it('classifies national, metro, city, neighborhood, and street bands', () => {
    expect(getMapZoomBand(4)).toBe('national')
    expect(getMapZoomBand(7)).toBe('metro')
    expect(getMapZoomBand(10)).toBe('city')
    expect(getMapZoomBand(12)).toBe('neighborhood')
    expect(getMapZoomBand(14)).toBe('street')
  })

  it('selects server fetch modes by zoom', () => {
    expect(getMapPropertyFetchMode(3)).toBe('national')
    expect(getMapPropertyFetchMode(7)).toBe('metro')
    expect(getMapPropertyFetchMode(11)).toBe('city')
    expect(getMapPropertyFetchMode(14)).toBe('street')
  })

  it('formats cluster counts for thousands', () => {
    expect(formatClusterCountLabel(982)).toBe('982')
    expect(formatClusterCountLabel(4800)).toBe('4.8K')
    expect(formatClusterCountLabel(12400)).toBe('12.4K')
  })
})