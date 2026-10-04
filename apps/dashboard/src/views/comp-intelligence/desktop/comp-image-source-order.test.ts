import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Every comp-image surface uses one order: LeadCommand's own key at the
 * coordinates, then the address, the stored vendor URL last (its key is
 * referrer-restricted and errors from our origin). Never strip the referrer.
 */
const VENDOR = 'https://maps.googleapis.com/maps/api/streetview?size=500x500&location=1+Main+St&key=VENDOR&signature=abc'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('comp image source order', () => {
  it('Comp Intelligence V4 media: own key first, stored last', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'OWNKEY')
    const { resolveCompMediaUrl } = await import('../../comp-intelligence-v4/adapters/media')
    expect(resolveCompMediaUrl({ streetview_image: VENDOR }, '1 Main St', 45.02, -93.29)).toMatch(/location=45\.02,-93\.29.*key=OWNKEY/)
    expect(resolveCompMediaUrl({ streetview_image: VENDOR }, '1 Main St', null, null)).toMatch(/location=1%20Main%20St.*key=OWNKEY/)
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '')
    expect(resolveCompMediaUrl({ streetview_image: VENDOR }, '1 Main St', 45.02, -93.29)).toBe(VENDOR)
  })

  it('Map comp card: own key first, stored last', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'OWNKEY')
    const { compStreetViewUrl } = await import('../../map/mobile/MapCompCard')
    const url = compStreetViewUrl({ streetview_image: VENDOR, lat: 45.02, lng: -93.29, address: '1 Main St' } as never)
    expect(url).toMatch(/key=OWNKEY/)
    expect(url).not.toMatch(/signature=/)
    expect(compStreetViewUrl({ streetview_image: VENDOR, lat: null, lng: null, address: '1 Main St' } as never)).toMatch(/location=1\+Main\+St.*key=OWNKEY/)
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '')
    vi.resetModules()
    const again = await import('../../map/mobile/MapCompCard')
    expect(again.compStreetViewUrl({ streetview_image: VENDOR, lat: 45.02, lng: -93.29, address: '1 Main St' } as never)).toBe(VENDOR)
  })
})
