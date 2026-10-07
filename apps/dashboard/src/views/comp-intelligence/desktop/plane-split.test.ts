import { describe, expect, it } from 'vitest'
import { clampPlaneWidth, maxPlaneWidth, MAP_MIN, NO_PLANE_WIDTHS, parsePlaneWidths, planeKindOf, PLANE_MIN, SPLIT_TRACK } from './plane-split'

describe('the map ↔ plane split', () => {
  it('keeps the map at its minimum and the plane at its minimum', () => {
    expect(maxPlaneWidth(1634)).toBe(1634 - MAP_MIN - SPLIT_TRACK)
    expect(clampPlaneWidth(5000, 1634)).toBe(1634 - MAP_MIN - SPLIT_TRACK)
    expect(clampPlaneWidth(100, 1634)).toBe(PLANE_MIN)
    expect(clampPlaneWidth(720.6, 1634)).toBe(721)
  })

  it('reserves the insights column when it is shown', () => {
    expect(maxPlaneWidth(1634, 409)).toBe(1634 - MAP_MIN - SPLIT_TRACK - 409 - SPLIT_TRACK)
  })

  it('never returns less than the plane minimum, even in a body too narrow for both', () => {
    expect(maxPlaneWidth(500)).toBe(PLANE_MIN)
    expect(clampPlaneWidth(900, 500)).toBe(PLANE_MIN)
  })

  it('remembers Compare apart from the narrow modes', () => {
    expect(planeKindOf('compare')).toBe('compare')
    for (const p of ['evidence', 'valuation', 'market', 'model']) expect(planeKindOf(p)).toBe('default')
  })

  it('reads stored widths defensively', () => {
    expect(parsePlaneWidths(null)).toEqual(NO_PLANE_WIDTHS)
    expect(parsePlaneWidths('not json')).toEqual(NO_PLANE_WIDTHS)
    expect(parsePlaneWidths('{"compare":980.4,"default":"wide"}')).toEqual({ compare: 980, default: null })
    expect(parsePlaneWidths('{"compare":12}')).toEqual(NO_PLANE_WIDTHS)
  })
})
