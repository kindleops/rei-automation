import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireSlot, streetViewQueueDepth } from './comp-street-view-queue'


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

/**
 * Every comp source through THE shared stored-imagery rule (resolveMapsImage):
 * own key at the coordinates → own key at the address → stored image last.
 * The rows below carry exactly the fields each source's payload carries.
 */
describe('comp Street View source — per comp source', () => {
  const VENDOR = 'https://maps.googleapis.com/maps/api/streetview?size=500x500&location=3606+Dupont+Ave+N&key=VENDOR&signature=abc'
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
  const load = async (key: string) => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', key)
    vi.resetModules()
    return (await import('./comp-street-view-queue')).compStreetViewUrl
  }
  const own = (url: string | null) => {
    expect(url).toMatch(/maps\/api\/streetview\?.*key=OWNKEY/)
    expect(url).not.toMatch(/signature=/)
  }

  it('MLS comp (engine pool: stored vendor URL + coordinates) builds from our key', async () => {
    const url = (await load('OWNKEY'))({ photo: VENDOR, lat: 45.0163, lng: -93.2946, address: '3606 Dupont Ave N, Minneapolis, MN 55412' })
    own(url)
    expect(url).toMatch(/location=45\.0163,-93\.2946/)
  })

  it('investor comp from the engine pool (stored vendor URL) builds from our key', async () => {
    own((await load('OWNKEY'))({ photo: VENDOR, lat: 45.0226, lng: -93.2962, address: '3722 Fremont Ave N' }))
  })

  it('investor / institutional deed from the transaction corpus (no stored image) builds from our key', async () => {
    own((await load('OWNKEY'))({ photo: null, lat: 45.031, lng: -93.30, address: '1 Corpus Deed St' }))
  })

  it('public-record deed builds from our key; with no coordinates it uses the address', async () => {
    const f = await load('OWNKEY')
    own(f({ photo: null, lat: 45.02, lng: -93.29, address: '2 Public Rec St' }))
    const byAddress = f({ photo: VENDOR, lat: null, lng: null, address: '2 Public Rec St, Minneapolis' })
    own(byAddress)
    expect(byAddress).toMatch(/location=2%20Public%20Rec%20St/)
  })

  it('canonical recent sale (mv_map_market_sales: coordinates, no stored image) builds from our key', async () => {
    own((await load('OWNKEY'))({ lat: 45.05, lng: -93.31, address: '9 Recent St' }))
  })

  it('asks Google for an honest 404 when there is no panorama', async () => {
    expect((await load('OWNKEY'))({ lat: 45.05, lng: -93.31 })).toMatch(/return_error_code=true/)
  })

  it('stored image only when no own-key URL can be built; never invents one', async () => {
    const noKey = await load('')
    expect(noKey({ photo: VENDOR, lat: 45.02, lng: -93.29, address: '1 Main St' })).toBe(VENDOR)
    expect(noKey({ photo: null, lat: null, lng: null })).toBeNull()
    const f = await load('OWNKEY')
    expect(f({ photo: null, lat: 0, lng: 0, address: null })).toBeNull()
  })
})

describe('evidence row layout', () => {
  it('the distance · date line wraps whole instead of being squeezed by the sale-type badge', () => {
    const css = readFileSync(fileURLToPath(new URL('./comps-workstation.css', import.meta.url)), 'utf8')
    const meta = css.match(/\.ciw-row__meta \{[^}]*\}/)?.[0] ?? ''
    expect(meta).toMatch(/flex-wrap: wrap/)
    const badge = readFileSync(fileURLToPath(new URL('./comp-evidence-media.css', import.meta.url)), 'utf8')
    expect(badge.match(/\.cst \{[^}]*\}/)?.[0] ?? '').toMatch(/max-width: 100%/)
    expect(badge.match(/\.cst__buyer \{[^}]*\}/)?.[0] ?? '').toMatch(/text-overflow: ellipsis/)
  })
})
