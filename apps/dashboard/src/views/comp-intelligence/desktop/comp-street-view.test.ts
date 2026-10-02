import { describe, expect, it } from 'vitest'
import { acquireSlot, compStreetViewUrl, streetViewQueueDepth } from './comp-street-view-queue'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** The fan-out rule: a list of comps never fires one image request per comp at once. */
describe('comp Street View load queue', () => {
  it('runs at most three loads at a time and hands the next slot over on release', async () => {
    const granted: number[] = []
    const cancels = Array.from({ length: 8 }, (_, i) => acquireSlot(() => granted.push(i)))
    await tick()
    expect(granted).toEqual([0, 1, 2])
    expect(streetViewQueueDepth()).toEqual({ inFlight: 3, waiting: 5 })
    cancels[0]()
    await tick()
    expect(granted).toEqual([0, 1, 2, 3])
    // a frame that scrolls away before its turn never loads
    cancels[4]()
    cancels[1]()
    await tick()
    expect(granted).toEqual([0, 1, 2, 3, 5])
    for (const c of cancels) c()
    await tick()
    expect(streetViewQueueDepth()).toEqual({ inFlight: 0, waiting: 0 })
  })
})

describe('comp Street View source', () => {
  it('prefers the record’s stored image, never invents one without coordinates', () => {
    expect(compStreetViewUrl({ photo: 'https://maps.googleapis.com/maps/api/streetview?x=1', lat: null, lng: null })).toMatch(/^https:/)
    expect(compStreetViewUrl({ photo: null, lat: null, lng: null })).toBeNull()
    expect(compStreetViewUrl({ photo: null, lat: 0, lng: 0 })).toBeNull()
  })
})
