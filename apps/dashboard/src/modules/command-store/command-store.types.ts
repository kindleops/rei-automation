export type CommandStoreCategory =
  | 'Featured'
  | 'Execution Apps'
  | 'AI Agents'
  | 'Command Widgets'
  | 'Automations'
  | 'Industry Packs'
  | 'Map Layers'
  | 'Templates'
  | 'Reports / Dashboards'
  | 'Integrations'

export type CommandStoreItemType =
  | 'app'
  | 'agent'
  | 'widget'
  | 'automation'
  | 'pack'
  | 'map-layer'
  | 'template'
  | 'report'
  | 'integration'

export type CommandStoreStatus =
  | 'installed'
  | 'available'
  | 'connected'
  | 'disconnected'
  | 'beta'
  | 'needs_auth'

export type CommandSpaceId =
  | 'executive'
  | 'acquisition'
  | 'market-intelligence'
  | 'messaging'
  | 'queue'
  | 'deal-execution'
  | 'dispo'
  | 'automation'
  | 'revenue'

export interface CommandStoreAssets {
  apps: string[]
  widgets: string[]
  agents: string[]
  automations: string[]
  templates: string[]
  mapLayers: string[]
  reports: string[]
}

export interface CommandStoreItem {
  id: string
  name: string
  category: CommandStoreCategory
  type: CommandStoreItemType
  description: string
  longDescription: string
  icon: string
  accent: string
  status: CommandStoreStatus
  popularity: string
  recommendedSpaces: CommandSpaceId[]
  includedAssets: CommandStoreAssets
  setupTime: string
  permissions: string[]
  dependencies: string[]
  compatibleWidgets: string[]
  compatibleAutomations: string[]
  previewStats: Array<{ label: string; value: string }>
  tags: string[]
}

export interface CommandStoreSpace {
  id: CommandSpaceId
  name: string
  label: string
  description: string
}
