import { describe, expect, it, vi } from 'vitest'
import {
  MAX_FLIGHT_MS, MIN_FLIGHT_MS, PROPERTY_ZOOM, boundsOf, contextZoom, createAutoFramer, flightDuration,
  planPointFocus, planSetFocus, type FramerMap,
} from './focus-camera'

const VP = { width: 1440, height: 900 }

describe('camera plan', () => {
  it('flies 500–900 ms, longer for farther targets', () => {
    const diag = Math.hypot(VP.width, VP.height)
    const near = flightDuration(200, diag, 0)
    const far = flightDuration(diag * 40, diag, 6)
    expect(near).toBeGreaterThanOrEqual(MIN_FLIGHT_MS)
    expect(far).toBeLessThanOrEqual(MAX_FLIGHT_MS)
    expect(far).toBeGreaterThan(near)
    expect(flightDuration(1e9, diag, 20)).toBe(MAX_FLIGHT_MS)
  })

  it('zoom by context: property → parcel, keeps a closer operator zoom; market → market', () => {
    expect(contextZoom('property', 4)).toBe(PROPERTY_ZOOM)
    expect(contextZoom('property', 17)).toBe(17)
    expect(contextZoom('market', 16)).toBeLessThan(12)
  })

  it('a long hop arcs (fly); a near target eases; reduced motion jumps', () => {
    expect(planPointFocus({ to: [-93.27, 44.98], fromZoom: 4, distancePx: 20000, viewport: VP }).kind).toBe('fly')
    expect(planPointFocus({ to: [-93.27, 44.98], fromZoom: 15, distancePx: 300, viewport: VP }).kind).toBe('ease')
    expect(planPointFocus({ to: [-93.27, 44.98], fromZoom: 4, distancePx: 20000, viewport: VP, reducedMotion: true })).toMatchObject({ kind: 'jump', duration: 0 })
  })

  it('multi-property frames the bounds of ALL points, never the first pin', () => {
    const pts = [{ lat: 44.9, lng: -93.4 }, { lat: 45.1, lng: -93.1 }, { lat: 45.0, lng: -93.2 }]
    expect(boundsOf(pts)).toEqual([[-93.4, 44.9], [-93.1, 45.1]])
    const plan = planSetFocus({ points: pts, fromZoom: 9, distancePx: 400, viewport: VP })!
    expect(plan.kind).toBe('bounds')
    if (plan.kind === 'bounds') {
      expect(plan.duration).toBeGreaterThanOrEqual(MIN_FLIGHT_MS)
      expect(plan.duration).toBeLessThanOrEqual(MAX_FLIGHT_MS)
      expect(plan.padding.left).toBeGreaterThanOrEqual(24)
    }
    // one distinct place is a property focus
    expect(planSetFocus({ points: [pts[0], pts[0]], fromZoom: 15, distancePx: 0, viewport: VP })!.kind).toBe('ease')
    expect(planSetFocus({ points: [], fromZoom: 9, distancePx: 0, viewport: VP })).toBeNull()
  })

  it('ultrawide panes get proportionally more padding, capped', () => {
    const pts = [{ lat: 44.9, lng: -93.4 }, { lat: 45.1, lng: -93.1 }]
    const wide = planSetFocus({ points: pts, fromZoom: 9, distancePx: 0, viewport: { width: 5120, height: 1440 } })!
    const narrow = planSetFocus({ points: pts, fromZoom: 9, distancePx: 0, viewport: { width: 480, height: 700 } })!
    if (wide.kind === 'bounds' && narrow.kind === 'bounds') {
      expect(wide.padding.left).toBe(140)
      expect(narrow.padding.left).toBeGreaterThanOrEqual(24)
    } else throw new Error('expected bounds plans')
  })
})

/** A fake map that records calls and lets a test emit events. */
function fakeMap() {
  const handlers = new Map<string, Set<(e: { originalEvent?: unknown }) => void>>()
  const calls: Array<[string, unknown]> = []
  const m: FramerMap & { emit: (t: string, e?: { originalEvent?: unknown }) => void; calls: typeof calls; listeners: () => number } = {
    flyTo: (o) => calls.push(['flyTo', o]),
    easeTo: (o) => calls.push(['easeTo', o]),
    jumpTo: (o) => calls.push(['jumpTo', o]),
    fitBounds: (b, o) => calls.push(['fitBounds', { b, o }]),
    stop: () => calls.push(['stop', null]),
    on: (t, fn) => { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t)!.add(fn) },
    off: (t, fn) => { handlers.get(t)?.delete(fn) },
    emit: (t, e = {}) => handlers.get(t)?.forEach((fn) => fn(e)),
    calls,
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  }
  return m
}

const fly = { kind: 'fly' as const, center: [-93.27, 44.98] as [number, number], zoom: 15.6, duration: 800 }

describe('auto-framer', () => {
  it('lands on moveend and reports it', () => {
    const map = fakeMap()
    const f = createAutoFramer(map)
    const onLand = vi.fn()
    expect(f.run(fly, 'p1', { onLand })).toBe('started')
    expect(map.calls[0][0]).toBe('flyTo')
    expect(f.isFlying()).toBe(true)
    map.emit('moveend')
    expect(onLand).toHaveBeenCalledOnce()
    expect(f.isFlying()).toBe(false)
  })

  it('a drag mid-flight stops the camera and cancels the auto-framing', () => {
    const map = fakeMap()
    const f = createAutoFramer(map)
    const onLand = vi.fn(), onCancel = vi.fn()
    f.run(fly, 'p1', { onLand, onCancel })
    map.emit('dragstart', { originalEvent: {} })
    expect(map.calls.map((c) => c[0])).toContain('stop')
    expect(onCancel).toHaveBeenCalledOnce()
    map.emit('moveend')
    expect(onLand).not.toHaveBeenCalled()
  })

  it('wheel, rotate and tilt interrupt too; a programmatic zoomstart (no originalEvent) does not', () => {
    for (const g of ['wheel', 'rotatestart', 'pitchstart', 'zoomstart']) {
      const map = fakeMap()
      const f = createAutoFramer(map)
      f.run(fly, 'p', {})
      map.emit(g, {})
      expect(f.isFlying(), `${g} without a gesture`).toBe(true)
      map.emit(g, { originalEvent: {} })
      expect(f.isFlying(), g).toBe(false)
    }
  })

  it('the same focus twice is one flight (two triggers never stutter the camera)', () => {
    const map = fakeMap()
    const f = createAutoFramer(map)
    f.run(fly, 'p1')
    expect(f.run(fly, 'p1')).toBe('duplicate')
    map.emit('moveend')
    expect(f.run(fly, 'p1')).toBe('duplicate') // just landed
    expect(map.calls.filter((c) => c[0] === 'flyTo')).toHaveLength(1)
    expect(f.run({ ...fly, center: [-93, 45] }, 'p2')).toBe('started')
  })

  it('reduced motion jumps and lands immediately', () => {
    const map = fakeMap()
    const f = createAutoFramer(map)
    const onLand = vi.fn()
    f.run({ ...fly, kind: 'jump', duration: 0 }, 'p1', { onLand })
    expect(map.calls[0][0]).toBe('jumpTo')
    expect(onLand).toHaveBeenCalledOnce()
    expect(f.isFlying()).toBe(false)
  })

  it('bounds plans use fitBounds; dispose removes every listener', () => {
    const map = fakeMap()
    const f = createAutoFramer(map)
    f.run({ kind: 'bounds', bounds: [[-93.4, 44.9], [-93.1, 45.1]], padding: { top: 1, right: 1, bottom: 1, left: 1 }, maxZoom: 15, duration: 700 }, 'set')
    expect(map.calls[0][0]).toBe('fitBounds')
    f.dispose()
    expect(map.listeners()).toBe(0)
  })
})
