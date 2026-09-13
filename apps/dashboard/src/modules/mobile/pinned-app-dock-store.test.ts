import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PINNED_APP_IDS,
  DEAL_INTELLIGENCE_APP_ID,
  addPinApp,
  isDockableAppId,
  removePinApp,
  reorderPinnedApps,
  recordRecentApp,
  togglePinApp,
} from './pinned-app-dock-store'

describe('pinned-app-dock-store', () => {
  /**
   * The default dock is now DERIVED from domain/app-registry's `defaultDock` flag and
   * deliberately holds four destinations, not the eight this used to freeze.
   *
   * Eight 44px targets plus their labels do not fit across a 390px viewport without
   * shrinking every one below a usable size — which is how the dock ended up collapsed
   * to a bare 16px handle showing no applications at all. Everything unpinned stays one
   * tap away in the App Launcher.
   *
   * The size ceiling is asserted rather than the exact list, so reordering the rail is
   * a registry decision and does not need a test edit — but overflowing it does fail.
   */
  it('ships a dock rail small enough to fit a 390px viewport', () => {
    expect(DEFAULT_PINNED_APP_IDS.length).toBeGreaterThan(0)
    expect(DEFAULT_PINNED_APP_IDS.length).toBeLessThanOrEqual(4)
    expect(DEFAULT_PINNED_APP_IDS).toEqual(['/inbox', '/entity-graph', '/map', '/pipeline'])
  })

  it('derives every default from the canonical registry', () => {
    // A default that is not dockable would be silently dropped by the sanitiser,
    // leaving the operator with a shorter rail than intended.
    for (const id of DEFAULT_PINNED_APP_IDS) {
      expect(isDockableAppId(id)).toBe(true)
    }
  })

  it('keeps Deal Intelligence dockable under its panel id', () => {
    // It is a panel inside the inbox workspace rather than a route, so it is stored
    // under a sentinel. Operators who pinned it keep a resolving dock.
    expect(isDockableAppId(DEAL_INTELLIGENCE_APP_ID)).toBe(true)
  })

  it('toggles pin state without dropping below one pinned app', () => {
    const base = { pinnedIds: [...DEFAULT_PINNED_APP_IDS], recentIds: [] }
    const unpinned = togglePinApp(base, '/map')
    expect(unpinned.pinnedIds).not.toContain('/map')
    const repinned = togglePinApp(unpinned, '/map')
    expect(repinned.pinnedIds).toContain('/map')
    const last = togglePinApp({ pinnedIds: ['/inbox'], recentIds: [] }, '/inbox')
    expect(last.pinnedIds).toEqual(['/inbox'])
  })

  it('removes apps from the dock', () => {
    const base = { pinnedIds: ['/inbox', '/map'], recentIds: [] }
    const next = removePinApp(base, '/map')
    expect(next.pinnedIds).toEqual(['/inbox'])
    expect(removePinApp({ pinnedIds: ['/inbox'], recentIds: [] }, '/inbox')).toEqual({ pinnedIds: ['/inbox'], recentIds: [] })
  })

  it('adds apps to the dock', () => {
    const base = { pinnedIds: ['/inbox'], recentIds: [] }
    const next = addPinApp(base, '/map')
    expect(next.pinnedIds).toEqual(['/inbox', '/map'])
    expect(addPinApp(next, '/map')).toEqual(next)
  })

  it('records recent apps with dedupe', () => {
    const base = { pinnedIds: [...DEFAULT_PINNED_APP_IDS], recentIds: ['/analytics'] }
    const next = recordRecentApp(base, '/buyer-match')
    expect(next.recentIds[0]).toBe('/buyer-match')
    expect(next.recentIds).toContain('/analytics')
  })

  it('reorders pinned apps', () => {
    expect(reorderPinnedApps(['/map', '/inbox', '/map'])).toEqual(['/map', '/inbox'])
  })
})