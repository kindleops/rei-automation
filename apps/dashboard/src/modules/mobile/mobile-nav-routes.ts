export type NavIconName =
  | 'radar'
  | 'inbox'
  | 'alert'
  | 'stats'
  | 'map'
  | 'users'
  | 'file-text'
  | 'settings'
  | 'bell'
  | 'star'
  | 'grid'
  | 'target'
  | 'send'
  | 'mail'

export type MobileNavTab = 'inbox' | 'map' | 'pipeline' | 'more'

const INBOX_PATHS = new Set(['/', '/inbox', '/conversation'])
const MAP_PATHS = new Set(['/map'])
const PIPELINE_PATHS = new Set(['/pipeline'])

export function resolveMobileNavTab(path: string): MobileNavTab {
  if (INBOX_PATHS.has(path)) return 'inbox'
  if (MAP_PATHS.has(path)) return 'map'
  if (PIPELINE_PATHS.has(path)) return 'pipeline'
  return 'more'
}

export const MOBILE_MORE_ROUTES: Array<{
  path: string
  label: string
  description: string
  icon: NavIconName
}> = [
  { path: '/campaign-command', label: 'Campaign Command', description: 'Live sends & pacing', icon: 'send' },
  { path: '/queue', label: 'Queue', description: 'Outbound lifecycle', icon: 'send' },
  { path: '/entity-graph', label: 'Property Lists', description: 'Saved views & bulk ops', icon: 'grid' },
  { path: '/workflow-studio', label: 'Workflow Studio', description: 'Live executions', icon: 'grid' },
  { path: '/email-command', label: 'Email Command', description: 'Threads & replies', icon: 'mail' },
  { path: '/closing-desk', label: 'Closing Desk', description: 'S6–S10 operations', icon: 'file-text' },
  { path: '/deal-intelligence', label: 'Deal Intelligence', description: 'Property dossier', icon: 'target' },
  { path: '/analytics', label: 'Analytics', description: 'KPI intelligence', icon: 'stats' },
  { path: '__settings__', label: 'Settings', description: 'Theme & preferences', icon: 'settings' },
]

export const MOBILE_TAB_ROUTES: Record<Exclude<MobileNavTab, 'more'>, string> = {
  inbox: '/inbox',
  map: '/map',
  pipeline: '/pipeline',
}