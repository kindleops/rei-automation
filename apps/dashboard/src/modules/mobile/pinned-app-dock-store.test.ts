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
   * The default pins are DERIVED from domain/app-registry's `defaultDock` flag rather
   * than frozen as a literal list here — that literal was one of five competing
   * definitions of "which applications exist".
   *
   * The set is asserted by membership, not by index, so reordering the dock is a
   * registry decision and does not need a test edit. What IS pinned down is that every
   * default resolves, because a default that is not dockable gets silently dropped by
   * the sanitiser and the operator quietly gets a shorter dock than intended.
   */
  it('ships the operator default dock, derived from the canonical registry', () => {
    expect(DEFAULT_PINNED_APP_IDS).toContain(DEAL_INTELLIGENCE_APP_ID)
    expect(new Set(DEFAULT_PINNED_APP_IDS)).toEqual(new Set([
      '/inbox',
      '/map',
      '/pipeline',
      '/queue',
      '/campaign-command',
      '/workflow-studio',
      '/closing-desk',
      DEAL_INTELLIGENCE_APP_ID,
    ]))
  })

  it('derives every default from the canonical registry', () => {
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