export type ShellSurfaceId =
  | 'workspace'
  | 'queue'
  | 'search'
  | 'action-center'
  | 'profile'
  | 'notifications'
  | 'activity'
  | null

export type LiveStateKind = 'live' | 'updating' | 'updated' | 'delayed' | 'degraded' | 'offline'

export type WorkspaceAvailability = 'ready' | 'coming_soon' | 'backend_not_ready'

export interface WorkspaceLauncherItem {
  key: string
  label: string
  description?: string
  icon?: string
  availability?: WorkspaceAvailability
  layoutModes?: Array<'25' | '50' | '75' | '100'>
  selected?: boolean
  pinned?: boolean
  recent?: boolean
}

export interface ActionCenterItem {
  id: string
  label: string
  count?: number | null
  loading?: boolean
  unavailableReason?: string
  hidden?: boolean
  onSelect: () => void
}