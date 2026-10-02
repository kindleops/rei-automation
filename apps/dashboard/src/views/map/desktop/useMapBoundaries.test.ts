import { describe, expect, it } from 'vitest'
import { BOUNDARY_REASON, ZIP_MIN_ZOOM, boundaryRequestFor } from './useMapBoundaries'

const MSP = { west: -93.42, south: 44.9, east: -93.1, north: 45.08 }

describe('boundary requests (mirror the server limits, so a refused view never calls)', () => {
  it('ZIP below its zoom or over a 4° box asks for nothing', () => {
    expect(boundaryRequestFor('zip', MSP, ZIP_MIN_ZOOM - 0.1)).toBeNull()
    expect(boundaryRequestFor('zip', { west: -100, south: 40, east: -93, north: 45 }, 10)).toBeNull()
  })
  it('a valid view asks for its own bbox and zoom', () => {
    expect(boundaryRequestFor('zip', MSP, 11.25)).toBe('/api/cockpit/map/boundaries?level=zip&bbox=-93.4200,44.9000,-93.1000,45.0800&zoom=11.3')
    expect(boundaryRequestFor('state', { west: -200, south: -89, east: 20, north: 89 }, 1.2)).toBe('/api/cockpit/map/boundaries?level=state&bbox=-180.0000,-85.0000,20.0000,85.0000&zoom=1.2')
  })
  it('every server refusal has plain words', () => {
    for (const k of ['zoom_out', 'too_large', 'not_installed', 'no_source', 'unavailable']) expect(BOUNDARY_REASON[k]).toBeTruthy()
  })
})
