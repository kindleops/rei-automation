/**
 * THE CANONICAL APPLICATION REGISTRY.
 *
 * Before this file the product carried four independent lists of "what applications
 * exist", and they did not agree:
 *
 *   app/routes.tsx            24 route entries (the only one that could actually render)
 *   command-navigation-registry  15 entries  — drove the mobile launcher AND the dock
 *   CommandCenterApp.navItems    15 entries  — drove keyboard shortcuts and the room label
 *   views/view-registry.ts       14 entries  — zero consumers, pure drift
 *   mobile-nav-routes.ts          9 entries  — zero consumers, pure drift
 *
 * The disagreement was not cosmetic. Properties and Comp Intelligence render fine at
 * /properties and /comp-intelligence but appear in NO navigation surface a phone can
 * reach, so on mobile they simply did not exist. Deal Intelligence was listed in the
 * mobile sheet pointing at /inbox. Entity Graph was called "Lists" in one list,
 * "Property Lists" in another and "Entity Graph" in a third.
 *
 * So: ONE registry, and every other list derives from it. Adding an application here
 * is what makes it reachable — there is no second place to remember.
 *
 * This registry describes navigation and context only. It holds no acquisition truth:
 * stage, status, temperature and economics come from the canonical read model in
 * domain/acquisition-view, never from here.
 */
import type { IconName } from '../../shared/icons'

export type AppId =
  | 'inbox'
  | 'conversation'
  | 'deal-intelligence'
  | 'properties'
  | 'entity-graph'
  | 'comp-intelligence'
  | 'buyer-match'
  | 'map'
  | 'pipeline'
  | 'queue'
  | 'campaign-command'
  | 'email-command'
  | 'workflow-studio'
  | 'closing-desk'
  | 'analytics'
  | 'calendar'
  | 'notifications'
  | 'settings'

/** Where an app sits in the launcher. Ordering inside a group is the array order. */
export type AppGroup = 'communication' | 'intelligence' | 'operations' | 'system'

export const APP_GROUP_LABELS: Record<AppGroup, string> = {
  communication: 'Communication',
  intelligence: 'Acquisition Intelligence',
  operations: 'Operations',
  system: 'System',
}

/**
 * How an app accepts an entity context.
 *
 * This is a CAPABILITY declaration, not a wish list: a key may only appear here when
 * the target surface already reads that identifier. The contextual navigator turns
 * these into focused destinations, and an app that declares nothing keeps its plain
 * path — which is the pre-existing behaviour, so a missing declaration can never
 * break a route that worked.
 */
export interface AppContextSupport {
  /** Query param or path segment the destination reads, keyed by locator field. */
  propertyId?: 'path:/entity-graph/property' | 'query:property_id' | 'locator'
  opportunityId?: 'query:opp'
  threadKey?: 'locator' | 'query:thread'
}

/** Which live signal, if any, legitimately badges this app. */
export type AppBadgeSource = 'inbox_unread' | 'queue_health' | 'notification_unread' | null

export interface NexusApp {
  id: AppId
  label: string
  /** Used where horizontal space is scarce — the dock rail and compact chips. */
  shortLabel: string
  description: string
  icon: IconName
  /**
   * The path the router resolves. Action-only entries (notifications, settings) use a
   * sentinel and must declare `action`; they are never pushed onto history.
   */
  route: string
  group: AppGroup
  desktop: boolean
  mobile: boolean
  /** May be pinned into the bottom dock / offered in the dock catalog. */
  dockable: boolean
  /** Ships in the permanent dock rail for a new operator. Keep this set very small. */
  defaultDock: boolean
  /** Single-key navigation shortcut (desktop command grammar). */
  shortcut?: string
  badge: AppBadgeSource
  context: AppContextSupport
  /**
   * Non-route behaviours. `deal_intelligence` is a panel inside the inbox workspace
   * rather than a route, which is why it cannot simply be pushed.
   */
  action?: 'deal_intelligence' | 'notifications' | 'settings'
  /** Present only while a surface is not yet usable on a phone — shown as an honest note. */
  mobileCaveat?: string
}

/**
 * Order matters: this is launcher order within each group, and the first
 * `defaultDock: true` entries become the default dock rail left-to-right.
 */
export const NEXUS_APPS: NexusApp[] = [
  {
    id: 'inbox',
    label: 'Inbox',
    shortLabel: 'Inbox',
    description: 'Seller threads, replies and the deal desk',
    icon: 'inbox',
    route: '/inbox',
    group: 'communication',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: true,
    shortcut: 'I',
    badge: 'inbox_unread',
    context: { threadKey: 'locator', propertyId: 'locator' },
  },
  {
    id: 'conversation',
    label: 'Conversation',
    shortLabel: 'Convo',
    description: 'Single-thread conversation view',
    icon: 'message',
    route: '/conversation',
    group: 'communication',
    desktop: true,
    mobile: true,
    dockable: false,
    defaultDock: false,
    shortcut: 'C',
    badge: null,
    context: { threadKey: 'locator' },
  },
  {
    id: 'email-command',
    label: 'Email Command',
    shortLabel: 'Email',
    description: 'Email threads, records and templates',
    icon: 'mail',
    route: '/email-command',
    group: 'communication',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'Y',
    badge: null,
    context: {},
  },
  {
    id: 'notifications',
    label: 'Notifications',
    shortLabel: 'Alerts',
    description: 'Operational intelligence feed',
    icon: 'bell',
    route: '__notifications__',
    group: 'communication',
    desktop: true,
    mobile: true,
    dockable: false,
    defaultDock: false,
    badge: 'notification_unread',
    context: {},
    action: 'notifications',
  },

  {
    id: 'deal-intelligence',
    label: 'Deal Intelligence',
    shortLabel: 'Deal Intel',
    description: 'Seller, property and offer intelligence',
    icon: 'target',
    route: '/deal-intelligence',
    group: 'intelligence',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'D',
    badge: null,
    context: { threadKey: 'locator', propertyId: 'locator' },
    action: 'deal_intelligence',
  },
  {
    id: 'properties',
    label: 'Properties',
    shortLabel: 'Property',
    description: 'Property intelligence workspace',
    icon: 'home',
    route: '/properties',
    group: 'intelligence',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    badge: null,
    // PropertyIntelligenceApp has no locator consumer, so it cannot be focused yet.
    // Declaring one here would produce a URL nothing reads.
    context: {},
  },
  {
    id: 'entity-graph',
    label: 'Entity Graph',
    shortLabel: 'Graph',
    description: 'Ownership relationships, cohorts and bulk operations',
    // Not 'grid': the launcher button in the dock rail uses 'grid', and the two sat
    // side by side as identical glyphs. 'link' also says what the surface is — an
    // ownership graph, not a tile view.
    icon: 'link',
    route: '/entity-graph',
    group: 'intelligence',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: true,
    shortcut: 'E',
    badge: null,
    context: { propertyId: 'path:/entity-graph/property' },
  },
  {
    id: 'comp-intelligence',
    label: 'Comp Intelligence',
    shortLabel: 'Comps',
    description: 'Accepted and rejected comparables behind a valuation',
    icon: 'stats',
    route: '/comp-intelligence',
    group: 'intelligence',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'O',
    badge: null,
    context: { propertyId: 'locator' },
  },
  {
    id: 'buyer-match',
    label: 'Buyer Match',
    shortLabel: 'Buyers',
    description: 'Buyer fit candidates and buy-box intelligence',
    icon: 'users',
    route: '/buyer-match',
    group: 'intelligence',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'B',
    badge: null,
    // BuyerMatchWorkspace resolves its subject from its own selection, not the
    // locator. Left empty until it reads one.
    context: {},
  },
  {
    id: 'map',
    label: 'Map',
    shortLabel: 'Map',
    description: 'Geographic command and market intelligence',
    icon: 'map',
    route: '/map',
    group: 'intelligence',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: true,
    shortcut: 'M',
    badge: null,
    context: { propertyId: 'locator' },
  },

  {
    id: 'pipeline',
    label: 'Pipeline',
    shortLabel: 'Pipeline',
    description: 'Canonical acquisition stages and velocity',
    icon: 'radar',
    route: '/pipeline',
    group: 'operations',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: true,
    shortcut: 'P',
    badge: null,
    context: { opportunityId: 'query:opp' },
  },
  {
    id: 'queue',
    label: 'Queue',
    shortLabel: 'Queue',
    description: 'Outbound lifecycle, failures and delivery',
    icon: 'send',
    route: '/queue',
    group: 'operations',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'Q',
    badge: 'queue_health',
    // QueuePage parses the query string but never reads `property_id`; the dock used
    // to append it anyway, producing a focused-looking URL with no effect.
    context: {},
  },
  {
    id: 'campaign-command',
    label: 'Campaign Command',
    shortLabel: 'Campaigns',
    description: 'Campaign build, schedule and pacing',
    icon: 'bolt',
    route: '/campaign-command',
    group: 'operations',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'G',
    badge: null,
    // Deliberately empty: no endpoint answers "which campaign contains this property",
    // so focusing it would be a fabrication.
    context: {},
  },
  {
    id: 'workflow-studio',
    label: 'Workflow Studio',
    shortLabel: 'Workflows',
    description: 'Automation graphs, triggers and live executions',
    icon: 'layers',
    route: '/workflow-studio',
    group: 'operations',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'W',
    badge: null,
    context: {},
    mobileCaveat: 'Canvas editing is desktop-only for now',
  },
  {
    id: 'closing-desk',
    label: 'Closing Desk',
    shortLabel: 'Closing',
    description: 'S6–S10 post-contract operations',
    icon: 'file-text',
    route: '/closing-desk',
    group: 'operations',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'K',
    badge: null,
    context: {},
  },
  {
    id: 'calendar',
    label: 'Calendar',
    shortLabel: 'Calendar',
    description: 'Scheduled follow-ups and events',
    icon: 'calendar',
    route: '/calendar',
    group: 'operations',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'L',
    badge: null,
    context: {},
  },

  {
    id: 'analytics',
    label: 'Analytics',
    shortLabel: 'Analytics',
    description: 'KPI intelligence and the war room',
    icon: 'trending-up',
    route: '/analytics',
    group: 'system',
    desktop: true,
    mobile: true,
    dockable: true,
    defaultDock: false,
    shortcut: 'A',
    badge: null,
    context: {},
  },
  {
    id: 'settings',
    label: 'Settings',
    shortLabel: 'Settings',
    description: 'Theme, appearance and operator preferences',
    icon: 'settings',
    route: '__settings__',
    group: 'system',
    desktop: true,
    mobile: true,
    dockable: false,
    defaultDock: false,
    badge: null,
    context: {},
    action: 'settings',
  },
]

const BY_ID = new Map(NEXUS_APPS.map((app) => [app.id, app]))
const BY_ROUTE = new Map(NEXUS_APPS.map((app) => [app.route, app]))

export const getApp = (id: AppId): NexusApp | undefined => BY_ID.get(id)
export const getAppByRoute = (route: string): NexusApp | undefined => BY_ROUTE.get(route)

export const MOBILE_APPS = NEXUS_APPS.filter((app) => app.mobile)
export const DESKTOP_APPS = NEXUS_APPS.filter((app) => app.desktop)
export const DOCKABLE_APP_ROUTES = NEXUS_APPS.filter((app) => app.dockable)
export const DEFAULT_DOCK_APPS = NEXUS_APPS.filter((app) => app.defaultDock)

/**
 * Routes that are real destinations, in the order the launcher shows them.
 * Action entries are included — the launcher can open a sheet as well as a route.
 */
export const APPS_BY_GROUP: Array<{ group: AppGroup; label: string; apps: NexusApp[] }> = (
  ['communication', 'intelligence', 'operations', 'system'] as AppGroup[]
).map((group) => ({
  group,
  label: APP_GROUP_LABELS[group],
  apps: NEXUS_APPS.filter((app) => app.group === group),
}))

/** Inbox owns three paths; everything else is exact-or-prefix. */
const INBOX_ROUTE_PATHS = new Set(['/', '/inbox', '/conversation'])

export function isAppActive(routePath: string, app: NexusApp): boolean {
  if (app.action === 'deal_intelligence') {
    return routePath === '/deal-intelligence' || routePath.startsWith('/deal-intelligence/')
  }
  if (app.action) return false
  if (app.id === 'inbox') return INBOX_ROUTE_PATHS.has(routePath)
  return routePath === app.route || routePath.startsWith(`${app.route}/`)
}

/** Which app is the operator currently in? Falls back to Inbox, which owns '/'. */
export function resolveAppForRoute(routePath: string): NexusApp {
  return NEXUS_APPS.find((app) => isAppActive(routePath, app)) ?? BY_ID.get('inbox')!
}

/**
 * Legacy paths that must keep resolving. This is the ONE table — `routes.tsx` and
 * `CommandCenterApp` each carried their own copy and they had already drifted
 * (`/watchlists` mapped to /properties in one and nowhere in the other).
 */
export const LEGACY_ROUTE_ALIASES: Record<string, string> = {
  '/dashboard/kpis': '/analytics',
  '/agents': '/analytics',
  '/buyer': '/buyer-match',
  '/campaigns': '/campaign-command',
  '/email': '/email-command',
  '/workflows-v2': '/workflow-studio',
  '/workflow-studio-v1': '/workflow-studio',
  '/list': '/entity-graph',
  '/markets': '/map',
  '/dossier': '/deal-intelligence',
  '/watchlists': '/properties',
  '/mobile': '/inbox',
  '/notifications': '/inbox',
}

export function canonicalizeRoutePath(target?: string): string {
  if (!target || target === '/') return '/inbox'
  return LEGACY_ROUTE_ALIASES[target] ?? target
}
