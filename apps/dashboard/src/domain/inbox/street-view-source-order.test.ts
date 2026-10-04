import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Subject / property Street View order (2026-10-04): our own key at the
 * coordinates, then the address, the stored link last. Stored subject links
 * (properties.streetview_image) are the same data vendor's signed URLs as the
 * comp links — same key fingerprint, referrer-restricted, erroring from
 * ops.leadcommand.ai. The referrer is never stripped.
 */
const VENDOR = 'https://maps.googleapis.com/maps/api/streetview?size=500x500&location=212+Monterrey+St&key=VENDOR&signature=abc'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

const load = async (key: string) => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', key)
  vi.resetModules()
  return import('./inbox-normalization')
}

describe('resolveStreetViewImage', () => {
  it('builds from our key at the coordinates before anything stored', async () => {
    const { resolveStreetViewImage } = await load('OWNKEY')
    const url = resolveStreetViewImage({ stored: VENDOR, address: '1 Main St', lat: 45.02, lng: -93.29 })
    expect(url).toMatch(/location=45\.02,-93\.29.*key=OWNKEY/)
    expect(url).not.toMatch(/signature=/)
  })

  it('then the address, and the stored link only when nothing can be built', async () => {
    const { resolveStreetViewImage } = await load('OWNKEY')
    expect(resolveStreetViewImage({ stored: VENDOR, address: '1 Main St', lat: 0, lng: 0 })).toMatch(/location=1%20Main%20St.*key=OWNKEY/)
    expect(resolveStreetViewImage({ stored: VENDOR, address: '  ', lat: null, lng: null })).toBe(VENDOR)
    expect(resolveStreetViewImage({ stored: 'http://insecure/x.jpg' })).toBeNull()
    const noKey = await load('')
    expect(noKey.resolveStreetViewImage({ stored: VENDOR, address: '1 Main St', lat: 45.02, lng: -93.29 })).toBe(VENDOR)
    expect(noKey.resolveStreetViewImage({})).toBeNull()
  })
})

describe('seller map card hero', () => {
  it('prefers our key over a stored vendor link', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'OWNKEY')
    vi.resetModules()
    const { buildSellerMapCardViewModel } = await import('../../views/map/seller-card/seller-map-card-view-model')
    const vm = buildSellerMapCardViewModel({ property_id: 'P1', property_address_full: '1 Main St, Elgin, TX 78621', latitude: 30.3, longitude: -97.37, streetview_image: VENDOR })
    expect(vm.property.imageUrl).toMatch(/key=OWNKEY/)
    expect(vm.property.imageUrl).not.toMatch(/signature=/)
  })
})
