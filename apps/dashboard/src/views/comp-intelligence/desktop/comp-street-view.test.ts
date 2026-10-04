import { describe, expect, it, vi } from 'vitest'
import { acquireSlot, compStreetViewUrl, streetViewQueueDepth } from './comp-street-view-queue'

// The real builder reads the build-time key once; stand in for it with the same contract.
const env = vi.hoisted(() => ({ key: 'OWNKEY' as string | null }))
vi.mock('../../../modules/entity-graph/mobile/EntityGraphPropertyVisual', () => ({
  staticStreetViewUrl: (address: string | null, lat?: number | null, lng?: number | null) => {
    if (!env.key) return null
    const location = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : (address ?? '').trim()
    return location ? `https://maps.googleapis.com/maps/api/streetview?${new URLSearchParams({ size: '640x360', location, key: env.key })}` : null
  },
}))

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
  const VENDOR = 'https://maps.googleapis.com/maps/api/streetview?size=500x500&location=1+Main+St&key=VENDOR&signature=abc'

  it('builds from LeadCommand’s own key at the coordinates before any stored vendor URL', () => {
    env.key = 'OWNKEY'
    const url = compStreetViewUrl({ photo: VENDOR, lat: 45.02, lng: -93.29, address: '1 Main St' })
    expect(url).toMatch(/key=OWNKEY/)
    expect(url).toMatch(/location=45\.02%2C-93\.29/)
    expect(url).not.toMatch(/signature=/)
  })

  it('falls back to the address, then the stored image, and never invents one', () => {
    env.key = 'OWNKEY'
    expect(compStreetViewUrl({ photo: VENDOR, lat: null, lng: null, address: '1 Main St, Minneapolis' })).toMatch(/location=1\+Main\+St%2C\+Minneapolis.*key=OWNKEY/)
    expect(compStreetViewUrl({ photo: null, lat: 0, lng: 0, address: null })).toBeNull()
    env.key = null
    expect(compStreetViewUrl({ photo: VENDOR, lat: 45.02, lng: -93.29, address: '1 Main St' })).toBe(VENDOR)
    expect(compStreetViewUrl({ photo: null, lat: null, lng: null })).toBeNull()
  })
})
