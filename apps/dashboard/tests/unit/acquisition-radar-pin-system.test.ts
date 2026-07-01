import { describe, expect, it } from 'vitest'
import {
  ACQUISITION_RADAR_STATE_MATRIX,
  ACQUISITION_RADAR_ZOOM,
  getAcquisitionRadarZoomBand,
  getPriorityGlowTier,
  isPriorityBreakoutPin,
  resolveAcquisitionRadarSemanticKey,
} from '../../src/views/map/acquisition-radar-state-matrix'
import {
  aggregatePropertyUniverseClusterStats,
  buildIndividualPinVisibilityFilter,
  enrichAcquisitionRadarFeature,
} from '../../src/views/map/acquisition-radar-pin-renderer'
import { getMapPinThemeTokens } from '../../src/views/map/map-pin-theme-tokens'

describe('acquisition radar semantic state matrix', () => {
  it('maps uncontacted properties to cool blue ring color', () => {
    const key = resolveAcquisitionRadarSemanticKey({ markerState: 'not_contacted' })
    expect(key).toBe('uncontacted')
    expect(ACQUISITION_RADAR_STATE_MATRIX[key].ring).toBe('#7A8FA8')
    expect(ACQUISITION_RADAR_STATE_MATRIX[key].haloOpacity).toBeGreaterThanOrEqual(0.1)
  })

  it('prioritizes suppressed over active communication', () => {
    expect(resolveAcquisitionRadarSemanticKey({
      markerState: 'suppressed',
      contactStatus: 'active_communication',
    })).toBe('suppressed_dnc')
  })

  it('identifies priority breakout pins', () => {
    expect(isPriorityBreakoutPin('new_reply')).toBe(true)
    expect(isPriorityBreakoutPin('uncontacted')).toBe(false)
  })
})

describe('priority glow tiers', () => {
  it('keeps unscored pins thin without double ring', () => {
    const tier = getPriorityGlowTier(null, true)
    expect(tier.dashedSecondary).toBe(true)
    expect(tier.doubleRing).toBe(false)
  })

  it('amplifies halo for high priority scores without changing ring semantics', () => {
    const low = getPriorityGlowTier(20)
    const high = getPriorityGlowTier(90)
    expect(high.haloOpacityMultiplier).toBeGreaterThan(low.haloOpacityMultiplier)
    expect(high.doubleRing).toBe(true)
    expect(high.markerScale).toBeGreaterThan(low.markerScale)
  })
})

describe('zoom bands', () => {
  it('classifies regional, city, neighborhood, and street zoom', () => {
    expect(getAcquisitionRadarZoomBand(7)).toBe('regional')
    expect(getAcquisitionRadarZoomBand(10)).toBe('metro')
    expect(getAcquisitionRadarZoomBand(12)).toBe('city')
    expect(getAcquisitionRadarZoomBand(13)).toBe('neighborhood')
    expect(getAcquisitionRadarZoomBand(14)).toBe('street')
    expect(ACQUISITION_RADAR_ZOOM.clusterMaxZoom).toBe(14)
  })
})

describe('pin enrichment', () => {
  it('applies theme glass and preserves uncontacted cool blue ring', () => {
    const props = enrichAcquisitionRadarFeature(
      { properties: { property_id: 'p1', markerState: 'not_contacted', assetType: 'sfr', acquisitionScore: 72 } },
      'satellite',
    )
    expect(props.ring_color).toBe('#7A8FA8')
    expect(props.icon_color).toBe('#66B8FF')
    expect(props.glass_color).toBe(getMapPinThemeTokens('satellite').glassFill)
    expect(props.halo_scale).toBeGreaterThan(1)
    expect(props.motion).toBe('static')
  })

  it('marks selected and hovered pins for scale treatment', () => {
    const props = enrichAcquisitionRadarFeature(
      { properties: { property_id: 'p2', markerState: 'new_reply', acquisitionScore: 40 } },
      'dark_ops',
      { selectedPropertyId: 'p2', hoveredPropertyId: 'p2' },
    )
    expect(props.pin_selected).toBe(1)
    expect(props.pin_hovered).toBe(1)
    expect(props.motion).toBe('reply_ripple')
  })
})

describe('individual pin visibility filter', () => {
  it('builds a valid filter without selected property id', () => {
    const filter = buildIndividualPinVisibilityFilter(null)
    expect(JSON.stringify(filter)).not.toContain('false')
    expect(filter[0]).toBe('all')
  })

  it('includes selected property breakout at far zoom when provided', () => {
    const filter = buildIndividualPinVisibilityFilter('sel-1')
    expect(JSON.stringify(filter)).toContain('sel-1')
  })
})

describe('cluster stats aggregation', () => {
  it('summarizes operational composition for cluster hover', () => {
    const stats = aggregatePropertyUniverseClusterStats([
      { properties: { semanticKey: 'uncontacted', assetType: 'sfr', acquisitionScore: 10 } },
      { properties: { semanticKey: 'uncontacted', assetType: 'sfr', acquisitionScore: 20 } },
      { properties: { semanticKey: 'new_reply', assetType: 'retail', acquisitionScore: 80 } },
      { properties: { semanticKey: 'negotiating', assetType: 'retail', acquisitionScore: 60 } },
    ])
    expect(stats.total).toBe(4)
    expect(stats.uncontacted).toBe(2)
    expect(stats.newReply).toBe(1)
    expect(stats.negotiating).toBe(1)
    expect(stats.dominantAssetType).toBe('sfr')
    expect(stats.avgScore).toBe(43)
  })
})

describe('map pin theme tokens', () => {
  it('gives each preset distinct ambient accents', () => {
    const satellite = getMapPinThemeTokens('satellite').ambientAccent
    const redOps = getMapPinThemeTokens('red_ops').ambientAccent
    const matrix = getMapPinThemeTokens('matrix').ambientAccent
    expect(satellite).not.toBe(redOps)
    expect(matrix).not.toBe(satellite)
  })
})