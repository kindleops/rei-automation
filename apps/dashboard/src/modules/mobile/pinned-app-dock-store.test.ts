import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PINNED_APP_IDS,
  DEAL_INTELLIGENCE_APP_ID,
  addPinApp,
  removePinApp,
  reorderPinnedApps,
  recordRecentApp,
  togglePinApp,
} from './pinned-app-dock-store'

describe('pinned-app-dock-store', () => {
  it('keeps default pinned apps in expected order', () => {
    expect(DEFAULT_PINNED_APP_IDS).toContain(DEAL_INTELLIGENCE_APP_ID)
    expect(DEFAULT_PINNED_APP_IDS).toEqual([
      '/inbox',
      '/map',
      '/pipeline',
      '/campaign-command',
      '/queue',
      '/workflow-studio',
      '/closing-desk',
      '__deal_intelligence__',
    ])
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