import type { CommandNavRoute } from './command-navigation-registry'

export type PinnedAppId = string

export type PinnedAppDockPhase = 'collapsed' | 'docked' | 'expanded'

/** Universal operator preference — stored in NexusSettings.pinnedAppDock */
export interface PinnedAppDockSettings {
  pinnedIds: PinnedAppId[]
  recentIds: PinnedAppId[]
}

export interface PinnedAppDockPersisted extends PinnedAppDockSettings {
  phase: PinnedAppDockPhase
}

export interface DockAppBadge {
  count?: number
  tone?: 'default' | 'warning' | 'critical'
  dot?: boolean
}

export type DockAppBadges = Partial<Record<PinnedAppId, DockAppBadge>>

export interface DockAppItem extends CommandNavRoute {
  id: PinnedAppId
  pinned: boolean
}

export interface AppSessionSnapshot {
  scrollY: number
  containerScrolls: Record<string, number>
  selectedId: string | null
  savedAt: number
}