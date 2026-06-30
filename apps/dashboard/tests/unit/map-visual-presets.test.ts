import { describe, expect, it } from 'vitest'
import {
  LEGACY_MAP_VISUAL_PRESET_ALIASES,
  MAP_VISUAL_PRESETS,
  MAP_VISUAL_PRESET_OPTIONS,
  normalizeMapVisualPresetId,
} from '../../src/views/map/map-visual-presets'

describe('map visual presets', () => {
  it('exposes ten distinct visual presets', () => {
    expect(MAP_VISUAL_PRESET_OPTIONS).toHaveLength(10)
    expect(Object.keys(MAP_VISUAL_PRESETS)).toHaveLength(10)
  })

  it('renames legacy acquisition radar and night vision to radar night', () => {
    expect(normalizeMapVisualPresetId('acquisition_radar')).toBe('radar_night')
    expect(normalizeMapVisualPresetId('night_vision')).toBe('radar_night')
    expect(MAP_VISUAL_PRESETS.radar_night.label).toBe('Radar Night')
  })

  it('gives red ops, dark ops, blueprint, and matrix distinct basemap backgrounds', () => {
    const ids = ['red_ops', 'dark_ops', 'blueprint', 'matrix'] as const
    const backgrounds = ids.map((id) => MAP_VISUAL_PRESETS[id].basemap.background)
    expect(new Set(backgrounds).size).toBe(4)
  })

  it('uses vector street family for tactical presets', () => {
    expect(MAP_VISUAL_PRESETS.red_ops.basemap.family).toBe('street')
    expect(MAP_VISUAL_PRESETS.red_ops.basemap.styleId).toBe('vector_dark')
    expect(MAP_VISUAL_PRESETS.satellite.basemap.family).toBe('satellite')
    expect(MAP_VISUAL_PRESETS.light_street.basemap.styleId).toBe('vector_light')
  })

  it('maps legacy aliases without throwing', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_MAP_VISUAL_PRESET_ALIASES)) {
      expect(normalizeMapVisualPresetId(legacy)).toBe(canonical)
    }
  })
})