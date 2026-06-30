import { loadSettings, saveSettings } from '../../shared/settings'
import { COMMAND_NAV_ROUTES, type CommandNavRoute } from './command-navigation-registry'
import type { PinnedAppDockSettings, PinnedAppId } from './pinned-app-dock.types'

const LEGACY_STORAGE_KEY = 'nx.pinned-app-dock.v1'

export const DEAL_INTELLIGENCE_APP_ID = '__deal_intelligence__' as const

export const DEFAULT_PINNED_APP_IDS: PinnedAppId[] = [
  '/inbox',
  '/map',
  '/pipeline',
  '/campaign-command',
  '/queue',
  '/workflow-studio',
  '/closing-desk',
  DEAL_INTELLIGENCE_APP_ID,
]

const DOCK_EXCLUDED_ACTIONS = new Set(['notifications', 'settings'])

export const DOCKABLE_APPS: CommandNavRoute[] = COMMAND_NAV_ROUTES.filter(
  (route) => !route.action || !DOCK_EXCLUDED_ACTIONS.has(route.action),
)

const DOCKABLE_BY_ID = new Map(DOCKABLE_APPS.map((app) => [app.path, app]))

export function resolveDockApp(path: string): CommandNavRoute | undefined {
  return DOCKABLE_BY_ID.get(path)
}

export function isDockableAppId(id: PinnedAppId): boolean {
  return DOCKABLE_BY_ID.has(id)
}

function sanitizePinnedIds(ids: unknown, fallback: PinnedAppId[]): PinnedAppId[] {
  if (!Array.isArray(ids)) return [...fallback]
  const cleaned = ids.filter((id): id is PinnedAppId => typeof id === 'string' && isDockableAppId(id))
  return cleaned.length > 0 ? cleaned : [...fallback]
}

function sanitizeRecentIds(ids: unknown): PinnedAppId[] {
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is PinnedAppId => typeof id === 'string' && isDockableAppId(id))
}

function readLegacyDock(): PinnedAppDockSettings | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PinnedAppDockSettings>
    return {
      pinnedIds: sanitizePinnedIds(parsed.pinnedIds, DEFAULT_PINNED_APP_IDS),
      recentIds: sanitizeRecentIds(parsed.recentIds),
    }
  } catch {
    return null
  }
}

function migrateLegacyDockIfNeeded() {
  const legacy = readLegacyDock()
  if (!legacy) return
  const settings = loadSettings()
  if (settings.pinnedAppDock?.pinnedIds?.length) return
  saveSettings({
    ...settings,
    pinnedAppDock: legacy,
  })
  localStorage.removeItem(LEGACY_STORAGE_KEY)
}

export function loadPinnedAppDockSettings(): PinnedAppDockSettings {
  migrateLegacyDockIfNeeded()
  const settings = loadSettings()
  return {
    pinnedIds: sanitizePinnedIds(settings.pinnedAppDock?.pinnedIds, DEFAULT_PINNED_APP_IDS),
    recentIds: sanitizeRecentIds(settings.pinnedAppDock?.recentIds),
  }
}

export function savePinnedAppDockSettings(next: PinnedAppDockSettings) {
  const settings = loadSettings()
  saveSettings({
    ...settings,
    pinnedAppDock: {
      pinnedIds: reorderPinnedApps(next.pinnedIds),
      recentIds: reorderPinnedApps(next.recentIds),
    },
  })
}

export function reorderPinnedApps(ids: PinnedAppId[]): PinnedAppId[] {
  return ids.filter((id, index) => ids.indexOf(id) === index && isDockableAppId(id))
}

export function togglePinApp(state: PinnedAppDockSettings, appId: PinnedAppId): PinnedAppDockSettings {
  if (!isDockableAppId(appId)) return state
  const pinned = new Set(state.pinnedIds)
  if (pinned.has(appId)) {
    if (pinned.size <= 1) return state
    pinned.delete(appId)
  } else {
    pinned.add(appId)
  }
  return { ...state, pinnedIds: reorderPinnedApps([...pinned]) }
}

export function addPinApp(state: PinnedAppDockSettings, appId: PinnedAppId): PinnedAppDockSettings {
  if (!isDockableAppId(appId) || state.pinnedIds.includes(appId)) return state
  return { ...state, pinnedIds: reorderPinnedApps([...state.pinnedIds, appId]) }
}

export function removePinApp(state: PinnedAppDockSettings, appId: PinnedAppId): PinnedAppDockSettings {
  if (!isDockableAppId(appId) || !state.pinnedIds.includes(appId) || state.pinnedIds.length <= 1) return state
  return { ...state, pinnedIds: reorderPinnedApps(state.pinnedIds.filter((id) => id !== appId)) }
}

export function recordRecentApp(state: PinnedAppDockSettings, appId: PinnedAppId): PinnedAppDockSettings {
  if (!isDockableAppId(appId)) return state
  const recentIds = [appId, ...state.recentIds.filter((id) => id !== appId)].slice(0, 12)
  return { ...state, recentIds }
}