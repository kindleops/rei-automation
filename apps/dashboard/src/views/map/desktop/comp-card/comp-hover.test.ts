import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../mobile/useSoldComps', () => ({
  COMP_LAYERS: { glow: 'nx-comps-glow', cluster: 'nx-comps-cluster', count: 'nx-comps-count', point: 'nx-comps-point', halo: 'nx-comps-selected' },
  loadCompDetail: vi.fn(() => { throw new Error('hover must never hydrate') }),
}))

import { attachCompHover, COMP_HOVER_DELAY_MS, type HoverMap } from './comp-hover'
import { loadCompDetail } from '../../mobile/useSoldComps'

type Fn = (e?: unknown) => void

function fakeMap() {
  const layerHandlers = new Map<string, Set<Fn>>()
  const mapHandlers = new Map<string, Set<Fn>>()
  const canvas = { style: { cursor: '' } }
  const map = {
    on(type: string, a: string | Fn, b?: Fn) {
      if (typeof a === 'string') { const k = `${type}:${a}`; if (!layerHandlers.has(k)) layerHandlers.set(k, new Set()); layerHandlers.get(k)!.add(b!) }
      else { if (!mapHandlers.has(type)) mapHandlers.set(type, new Set()); mapHandlers.get(type)!.add(a) }
    },
    off(type: string, a: string | Fn, b?: Fn) {
      if (typeof a === 'string') layerHandlers.get(`${type}:${a}`)?.delete(b!)
      else mapHandlers.get(type)?.delete(a)
    },
    project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: lat * 10 }),
    getCanvas: () => canvas,
  }
  const fire = (type: string, layer: string, props: Record<string, unknown>, coords: [number, number]) =>
    layerHandlers.get(`${type}:${layer}`)?.forEach((fn) => fn({ features: [{ properties: props, geometry: { type: 'Point', coordinates: coords } }] }))
  const fireMap = (type: string) => mapHandlers.get(type)?.forEach((fn) => fn())
  const count = () => [...layerHandlers.values(), ...mapHandlers.values()].reduce((n, s) => n + s.size, 0)
  return { map: map as unknown as HoverMap, fire, fireMap, count, canvas }
}

const fetchSpy = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('comp hover — zero network, debounced', () => {
  it('reports the hovered comp after the debounce, with no request of any kind', () => {
    const f = fakeMap()
    const onChange = vi.fn()
    attachCompHover(f.map, onChange)
    f.fire('mousemove', 'nx-comps-point', { comp_id: 't:1', n: 1, price: 300000, sold_on: '2026-09-01' }, [-93.3, 45])
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(COMP_HOVER_DELAY_MS)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toMatchObject({ key: 't:1', lngLat: [-93.3, 45], point: { x: -933, y: 450 } })
    expect(f.canvas.style.cursor).toBe('pointer')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(loadCompDetail).not.toHaveBeenCalled()
  })

  it('a sweep across many pins paints one preview (the last), not one per pin', () => {
    const f = fakeMap()
    const onChange = vi.fn()
    attachCompHover(f.map, onChange)
    for (let i = 0; i < 8; i++) {
      f.fire('mousemove', 'nx-comps-point', { comp_id: `t:${i}`, n: 1 }, [-93 - i / 100, 45])
      vi.advanceTimersByTime(20)
    }
    vi.advanceTimersByTime(COMP_HOVER_DELAY_MS)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].key).toBe('t:7')
    // moving within the same pin re-reports nothing
    f.fire('mousemove', 'nx-comps-point', { comp_id: 't:7', n: 1 }, [-93.07, 45])
    vi.advanceTimersByTime(COMP_HOVER_DELAY_MS * 2)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('leaving the pin, or the camera moving, hides it; detach removes every listener', () => {
    const f = fakeMap()
    const onChange = vi.fn()
    const detach = attachCompHover(f.map, onChange)
    const wired = f.count()
    expect(wired).toBe(5)
    f.fire('mousemove', 'nx-comps-cluster', { n: 12, price: 250000 }, [-93.3, 45])
    vi.advanceTimersByTime(COMP_HOVER_DELAY_MS)
    expect(onChange.mock.calls[0][0].key).toMatch(/^cluster:/)
    f.fireMap('movestart')
    expect(onChange).toHaveBeenLastCalledWith(null)
    detach()
    expect(f.count()).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
