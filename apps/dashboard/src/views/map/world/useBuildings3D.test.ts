import { describe, expect, it } from 'vitest'
import { expression } from '@maplibre/maplibre-gl-style-spec'
import { buildingPaint, HEIGHT_EXPR } from './useBuildings3D'

const heightOf = (props: Record<string, unknown>) => {
  const parsed = expression.createExpression(HEIGHT_EXPR as never)
  if (parsed.result !== 'success') throw new Error('bad expression')
  return parsed.value.evaluate({ zoom: 16 } as never, { type: 'Polygon', properties: props } as never)
}

describe('real building heights', () => {
  it('uses the source height when the source has one', () => {
    expect(heightOf({ render_height: 78 })).toBe(78)
    expect(heightOf({ render_height: 26.5 })).toBe(26.5)
  })
  it('treats the schema default (exactly 5 m) and missing heights as unknown — flat, never invented', () => {
    expect(heightOf({ render_height: 5 })).toBe(0.4)
    expect(heightOf({})).toBe(0.4)
    expect(heightOf({ render_height: 'n/a' })).toBe(0.4)
  })
  it('rises with zoom from footprints to full volumes, per theme', () => {
    const dark = buildingPaint('dark_ops', false)
    expect(dark['fill-extrusion-height'][0]).toBe('interpolate')
    expect(dark['fill-extrusion-height'].slice(3)).toEqual([14, 0, 15.4, HEIGHT_EXPR])
    expect(buildingPaint('light_street', false)['fill-extrusion-opacity']).toBeLessThan(dark['fill-extrusion-opacity'])
    expect(buildingPaint('dark_ops', true)['fill-extrusion-color']).not.toBe(dark['fill-extrusion-color'])
    expect(buildingPaint('light_street', true)['fill-extrusion-color']).toBe(buildingPaint('light_street', false)['fill-extrusion-color'])
  })
})
