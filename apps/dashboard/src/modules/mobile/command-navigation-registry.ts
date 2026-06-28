import type { NavIconName } from './mobile-nav-routes'

export type CommandNavAction = 'route' | 'settings' | 'notifications'

export interface CommandNavRoute {
  path: string
  label: string
  description?: string
  icon: NavIconName
  workspaceKey?: string
  action?: CommandNavAction
}

/** Canonical application routes — single source for workspace launcher and command dock */
export const COMMAND_NAV_ROUTES: CommandNavRoute[] = [
  { path: '/inbox', label: 'Inbox', description: 'SMS threads & deal desk', icon: 'inbox', workspaceKey: 'deal_desk' },
  { path: '/map', label: 'Map', description: 'Market intelligence', icon: 'map', workspaceKey: 'command_map' },
  { path: '/pipeline', label: 'Pipeline', description: 'Stage lanes & velocity', icon: 'radar', workspaceKey: 'pipeline' },
  { path: '/entity-graph', label: 'Lists', description: 'Property lists & bulk ops', icon: 'grid' },
  { path: '/queue', label: 'Queue', description: 'Outbound lifecycle', icon: 'send' },
  { path: '/campaign-command', label: 'Campaign Command', description: 'Live sends & pacing', icon: 'send' },
  { path: '/workflow-studio', label: 'Workflow Studio', description: 'Automations & canvas', icon: 'grid' },
  { path: '/email-command', label: 'Email Command', description: 'Threads & replies', icon: 'mail' },
  { path: '/closing-desk', label: 'Closing Desk', description: 'S6–S10 operations', icon: 'file-text' },
  { path: '/deal-intelligence', label: 'Deal Intelligence', description: 'Property dossier', icon: 'target' },
  { path: '/buyer-match', label: 'Buyer Match', description: 'Buyer command', icon: 'users' },
  { path: '/analytics', label: 'Analytics', description: 'KPI intelligence', icon: 'stats' },
  { path: '/calendar', label: 'Calendar', description: 'Events & follow-ups', icon: 'bell' },
  { path: '__notifications__', label: 'Notifications', description: 'Operational intelligence feed', icon: 'bell', action: 'notifications' },
  { path: '__settings__', label: 'Settings', description: 'Preferences & workspace', icon: 'settings', action: 'settings' },
]

const INBOX_ROUTE_PATHS = new Set(['/', '/inbox', '/conversation'])

export function isCommandNavRouteActive(routePath: string, item: CommandNavRoute): boolean {
  if (item.action) return false
  if (item.path === '/inbox') return INBOX_ROUTE_PATHS.has(routePath)
  return routePath === item.path || routePath.startsWith(`${item.path}/`)
}

export function resolveCommandNavLabel(path: string): string {
  const match = COMMAND_NAV_ROUTES.find((route) => route.path === path)
  return match?.label ?? 'NEXUS'
}