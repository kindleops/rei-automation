import { describe, expect, it } from 'vitest'
import { routeDataKey } from './AppInstanceHost'

/*
 * Opening a property in the Entity Graph moves the pane to
 * /entity-graph/property/:id. Keyed by pathname that was a new route-data
 * entry in 'loading' → the pane skeleton replaced the app → the grid unmounted
 * and lost ~1,200 loaded rows, scroll, selection (owner, 2026-10-08).
 */
describe('pane route data is keyed by the route, not the path', () => {
  it('every Entity Graph deep link shares the one entry (no remount on selection)', () => {
    const base = routeDataKey('/entity-graph', 0)
    expect(routeDataKey('/entity-graph/property/24507162', 0)).toBe(base)
    expect(routeDataKey('/entity-graph/owner/mo_6ae6ed8a02724ee3e8366fdd', 0)).toBe(base)
    expect(routeDataKey('/entity-graph/prospect/pros_aaaaaaaaaaaaaaaaaaaaaaaa', 0)).toBe(base)
  })
  it('a retry is still a fresh load, and a different app a different entry', () => {
    expect(routeDataKey('/entity-graph/property/1', 1)).not.toBe(routeDataKey('/entity-graph', 0))
    expect(routeDataKey('/inbox', 0)).not.toBe(routeDataKey('/entity-graph', 0))
  })
})
