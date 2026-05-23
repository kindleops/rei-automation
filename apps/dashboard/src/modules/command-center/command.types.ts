import type { IconName } from '../../shared/icons'

export const GLOBAL_COMMAND_OPEN_EVENT = 'nexus:open-global-command'
export const GLOBAL_COMMAND_CONTEXT_EVENT = 'nexus:command-context'
export const GLOBAL_COMMAND_ACTION_EVENT = 'nexus:command-action'

export type CommandResultType =
  | 'property'
  | 'seller'
  | 'conversation'
  | 'buyer'
  | 'market'
  | 'pipeline'
  | 'queue'
  | 'map_action'
  | 'app'
  | 'filter'
  | 'system_action'
  | 'location'
  | 'leads'
  | 'comps'
  | 'underwrite'
  | 'recent'

export type LocationResult = {
  id: string
  label: string
  query: string
  latitude: number
  longitude: number
  address?: string
  city?: string
  state?: string
  zip?: string
  country?: string
  placeType?: 'address' | 'zip' | 'city' | 'county' | 'neighborhood' | 'poi' | 'unknown'
  confidence?: number
  source: 'mapbox' | 'backend' | 'cache' | 'stub'
}

export type CommandPreviewTone = 'default' | 'accent' | 'success' | 'warning' | 'danger'

export type CommandResultPreview = {
  eyebrow?: string
  title?: string
  summary?: string
  details?: Array<{ label: string; value: string }>
  tone?: CommandPreviewTone
}

export type CommandActionKind = 'dispatch_event' | 'confirm_required' | 'noop'

export type CommandAction = {
  id: string
  kind: CommandActionKind
  label?: string
  eventName?: string
  confirmMessage?: string
}

export type CommandResult = {
  id: string
  type: CommandResultType
  title: string
  subtitle: string
  description?: string
  badge?: string
  icon?: IconName
  score: number
  route?: string
  action?: CommandAction
  payload?: Record<string, unknown>
  preview?: CommandResultPreview
  location?: LocationResult
  meta?: {
    provider?: string
    groupLabel?: string
    keywords?: string[]
    disabled?: boolean
    confirmRequired?: boolean
    hint?: string
  }
}

export type GlobalCommandSearchContext = {
  routePath: string
  currentView?: string | null
  selectedMarket?: string | null
  activeMapTheme?: string | null
  activeFilters?: Record<string, unknown> | null
}

export type GlobalCommandProvider = {
  id: string
  search: (query: string, context: GlobalCommandSearchContext) => Promise<CommandResult[]>
}
