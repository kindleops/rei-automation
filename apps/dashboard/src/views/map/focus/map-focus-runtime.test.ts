import { describe, expect, it, vi } from 'vitest'
import type { MapPropertyFocus } from '../../../domain/map/map-property-focus'
import { resolveFocusRequest, type FocusResolverDeps } from './map-focus-runtime'

const req = (over: Partial<MapPropertyFocus> = {}): MapPropertyFocus => ({ seq: 1, propertyId: 'p1', label: '1 Main St', threadKey: null, lat: null, lng: null, source: 'inbox', at: 0, ...over })
const deps = (over: Partial<FocusResolverDeps> = {}): FocusResolverDeps => ({
  selectFromPins: vi.fn(() => false),
  selectAt: vi.fn(),
  fetchCanonical: vi.fn(async () => null),
  wait: vi.fn(async () => {}),
  attempts: 3,
  ...over,
})
const signal = () => new AbortController().signal

describe('Show on Map — the canonical fallback chain', () => {
  it('1. the pin index wins (the same selection a tap makes)', async () => {
    const d = deps({ selectFromPins: vi.fn(() => true) })
    expect(await resolveFocusRequest(req(), d, signal())).toMatchObject({ status: 'focused', via: 'pin' })
    expect(d.fetchCanonical).not.toHaveBeenCalled()
  })

  it('waits for pins that are still loading before falling back', async () => {
    let n = 0
    const d = deps({ selectFromPins: vi.fn(() => ++n === 3) })
    expect(await resolveFocusRequest(req(), d, signal())).toMatchObject({ via: 'pin' })
    expect(d.wait).toHaveBeenCalledTimes(2)
  })

  it('2. coordinates the caller read canonically are used without waiting out the pin budget', async () => {
    const d = deps()
    const out = await resolveFocusRequest(req({ lat: 45.02, lng: -93.29 }), d, signal())
    expect(out).toMatchObject({ status: 'focused', via: 'caller' })
    expect(d.selectAt).toHaveBeenCalledWith('p1', [-93.29, 45.02], '1 Main St')
    expect(d.wait).not.toHaveBeenCalled()
  })

  it('3. the canonical property subject supplies coordinates', async () => {
    const d = deps({ fetchCanonical: vi.fn(async () => [-93.2, 44.9] as [number, number]) })
    expect(await resolveFocusRequest(req(), d, signal())).toMatchObject({ status: 'focused', via: 'canonical' })
    expect(d.selectAt).toHaveBeenCalledWith('p1', [-93.2, 44.9], '1 Main St')
  })

  it('4. no location anywhere → unavailable with the reason; nothing is placed', async () => {
    const d = deps({ fetchCanonical: vi.fn(async () => { throw new Error('offline') }) })
    const out = await resolveFocusRequest(req(), d, signal())
    expect(out).toEqual({ seq: 1, status: 'unavailable', propertyId: 'p1', reason: 'No coordinates are on record for this property' })
    expect(d.selectAt).not.toHaveBeenCalled()
  })

  it('a newer request supersedes this one', async () => {
    const ctl = new AbortController()
    const d = deps({ wait: vi.fn(async () => { ctl.abort() }) })
    expect(await resolveFocusRequest(req(), d, ctl.signal)).toMatchObject({ status: 'unavailable', reason: 'Superseded by a newer focus' })
    expect(d.fetchCanonical).not.toHaveBeenCalled()
  })
})
