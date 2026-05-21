export type HomeWidgetSize = 'small' | 'medium' | 'large'

export type HomeWidgetCategory =
  | 'Inbox'
  | 'Queue'
  | 'Dossier'
  | 'Map'
  | 'Offers'
  | 'Contracts'
  | 'Title'
  | 'Buyers'
  | 'Automation'
  | 'Revenue'

export interface HomeWidgetDefinition {
  id: string
  title: string
  source: string
  category: HomeWidgetCategory
  size: HomeWidgetSize
  status: 'healthy' | 'watch' | 'alert'
  primaryMetric: string
  secondaryText: string
  actionLabel: string
  appPath: string
}

export interface HomeWorkspace {
  id: string
  name: string
  description: string
  activeCount: string
  accent: 'emerald' | 'sky' | 'amber' | 'violet' | 'rose' | 'slate'
}

export interface HomeBriefingInsight {
  id: string
  label: string
  value: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
}

export interface HomeActivityItem {
  id: string
  kind: 'reply' | 'failed-send' | 'offer' | 'title' | 'buyer' | 'webhook'
  source: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  detail: string
  time: string
}

export interface HomePreset {
  id: string
  label: string
  description: string
  widgetIds: string[]
}

export interface HomeModel {
  workspaces: HomeWorkspace[]
  widgets: HomeWidgetDefinition[]
  presets: HomePreset[]
  briefingInsights: HomeBriefingInsight[]
  topMarkets: string[]
  activeMarkets: number
  leadPulses: number
  highPressureZones: number
  aiScanStatus: string
  activities: HomeActivityItem[]
}
