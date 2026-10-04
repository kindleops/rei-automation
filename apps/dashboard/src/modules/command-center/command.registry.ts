import type { CommandResult, GlobalCommandSearchContext } from '../../domain/command-center/command.types'
import { GLOBAL_COMMAND_ACTION_EVENT } from '../../domain/command-center/command.types'
import {
  NEXUS_APPS,
  isAppActive,
  type NexusApp,
} from '../../domain/app-registry/app-registry'

const buildStatic = (input: Omit<CommandResult, 'score' | 'action'> & {
  score?: number
  actionId?: string
  confirmMessage?: string
  eventPayload?: Record<string, unknown>
}): CommandResult => ({
  ...input,
  score: input.score ?? 0,
  payload: input.eventPayload ?? input.payload,
  action: input.actionId
    ? {
        id: input.actionId,
        kind: input.confirmMessage ? 'confirm_required' : 'dispatch_event',
        eventName: GLOBAL_COMMAND_ACTION_EVENT,
        confirmMessage: input.confirmMessage,
      }
    : undefined,
})

/**
 * APPLICATION DESTINATIONS, derived from the canonical registry.
 *
 * These were seven hand-written "Open X" commands — Inbox, Command Map, Pipeline,
 * Queue, Metrics, Buyers, Comp Intelligence — and every one of them declared
 * `route: '/inbox'` plus a `focus_workspace_view` event, because that was how those
 * surfaces were reached before they became routes. So the command palette named
 * SEVEN of the eighteen applications, addressed them all at one URL, and disagreed
 * with the launcher, the dock and the router about where they live. Entity Graph,
 * Campaign Command, Email Command, Workflow Studio, Closing Desk and Calendar were
 * simply not findable by name.
 *
 * Deriving them removes the fourth list. `isAppActive` gives the same
 * "you are already here" ranking the hardcoded `onInboxSurface` ternaries were
 * approximating, and action-only entries (Notifications, Settings) are excluded
 * because they cannot be pushed as a route — the launcher opens those.
 */
const applicationDestinations = (context: GlobalCommandSearchContext): CommandResult[] => {
  const available = context.isMobile
    ? NEXUS_APPS.filter((app) => app.mobile)
    : NEXUS_APPS.filter((app) => app.desktop)

  // On the modern desktop Settings is a real page, so it can be a destination.
  const settingsPage: CommandResult[] = context.isModernDesktop
    ? [buildStatic({
      id: 'app-open-settings',
      type: 'app',
      title: 'Open Settings',
      subtitle: 'Theme, background, alerts, workspace and keyboard',
      badge: 'App',
      icon: 'settings',
      route: '/settings',
      score: context.routePath === '/settings' ? 96 : 84,
      preview: { eyebrow: 'App', title: 'Settings', summary: 'Theme, accent, Liquid Glass, background, alerts and sound, workspace, keyboard.' },
      meta: { provider: 'app', groupLabel: 'Actions', keywords: ['settings', 'preferences', 'theme', 'appearance', 'sound', 'alerts', 'keyboard', 'shortcuts'] },
    })]
    : []

  return [...settingsPage, ...available
    .filter((app: NexusApp) => !app.action)
    .map((app) => buildStatic({
      id: `app-open-${app.id}`,
      type: 'app',
      title: `Open ${app.label}`,
      subtitle: app.description,
      badge: 'App',
      icon: app.icon,
      route: app.route,
      score: isAppActive(context.routePath, app) ? 96 : 84,
      preview: {
        eyebrow: 'App',
        title: app.label,
        summary: app.description,
      },
      meta: {
        provider: 'app',
        groupLabel: 'Actions',
        keywords: [app.label.toLowerCase(), app.shortLabel.toLowerCase(), app.id],
      },
    }))]
}

/**
 * MULTI-INBOX (desktop): open / focus / close / set the view of Inbox 1-4.
 * Handled by the Inbox itself (kind 'inbox_multi'); nothing here decides state.
 */
const MULTI_INBOX_VIEWS: Array<{ view: string; label: string }> = [
  { view: 'priority', label: 'Priority' },
  { view: 'new_replies', label: 'New Replies' },
  { view: 'needs_review', label: 'Needs Review' },
  { view: 'follow_up', label: 'Follow-ups' },
  { view: 'archived', label: 'Archived' },
]
const multiInboxCommands = (context: GlobalCommandSearchContext): CommandResult[] => {
  if (!context.isModernDesktop) return []
  const onInbox = context.routePath === '/inbox'
  const out: CommandResult[] = []
  const add = (id: string, title: string, subtitle: string, payload: Record<string, unknown>, keywords: string[], score = onInbox ? 74 : 58) => out.push(buildStatic({
    id, type: 'system_action', title, subtitle, badge: 'Inbox', icon: 'inbox', route: '/inbox',
    actionId: 'inbox_multi', eventPayload: { kind: 'inbox_multi', ...payload }, score,
    meta: { provider: 'system_action', groupLabel: 'Inbox panes', keywords },
  }))
  const ordinal = ['', 'second', 'third', 'fourth']
  for (const n of [2, 3, 4]) add(`inbox-multi-count-${n}`, `Open ${ordinal[n - 1]} Inbox`, `${n} Inboxes side by side, each with its own view`, { op: 'set_count', count: n }, ['multi inbox', 'split inbox', `${n} inboxes`, 'side by side'])
  add('inbox-multi-count-1', 'One Inbox', 'Back to a single Inbox (other panes keep their state)', { op: 'set_count', count: 1 }, ['single inbox', 'close panes'])
  for (const n of [1, 2, 3, 4]) add(`inbox-multi-focus-${n}`, `Focus Inbox ${n}`, `⌥${n}`, { op: 'focus', pane: n }, ['focus inbox', `inbox ${n}`], onInbox ? 66 : 40)
  for (const n of [2, 3, 4]) add(`inbox-multi-close-${n}`, `Close Inbox ${n}`, 'Its view is kept for this session', { op: 'close', pane: n }, ['close inbox', `inbox ${n}`], onInbox ? 62 : 36)
  for (const n of [2, 3, 4]) {
    for (const v of MULTI_INBOX_VIEWS) add(`inbox-multi-view-${n}-${v.view}`, `Set Inbox ${n} to ${v.label}`, `Inbox ${n} shows ${v.label}`, { op: 'set_view', pane: n, view: v.view }, ['set inbox', `inbox ${n}`, v.label.toLowerCase()], onInbox ? 60 : 34)
  }
  return out
}

export const getStaticCommandRegistry = (context: GlobalCommandSearchContext): CommandResult[] => {
  const onInboxSurface = context.routePath === '/inbox'
  const onQueueSurface = context.routePath === '/inbox' && context.currentView === 'queue'

  return [
    ...applicationDestinations(context),
    ...multiInboxCommands(context),
    buildStatic({
      id: 'filter-clear',
      type: 'filter',
      title: 'Clear Filters',
      subtitle: 'Reset inbox filters and search state',
      badge: 'Filter',
      icon: 'filter',
      route: '/inbox',
      actionId: 'clear_inbox_filters',
      eventPayload: { kind: 'clear_inbox_filters' },
      score: onInboxSurface ? 78 : 64,
      preview: {
        eyebrow: 'Filters',
        title: 'Clear Filters',
        summary: 'Reset inbox search, preset, stage, and source-mode filters back to the default state.',
      },
      meta: { provider: 'filter', groupLabel: 'Actions', keywords: ['clear filters', 'reset filters', 'reset search'] },
    }),
    buildStatic({
      id: 'filter-new-replies',
      type: 'filter',
      title: 'Show New Replies',
      subtitle: 'Filter inbox to new seller replies',
      badge: 'Filter',
      icon: 'message',
      route: '/inbox',
      actionId: 'apply_inbox_view',
      eventPayload: { kind: 'apply_inbox_view', view: 'new_replies' },
      score: onInboxSurface ? 84 : 70,
      preview: {
        eyebrow: 'Inbox Filter',
        title: 'New Replies',
        summary: 'Focus the inbox on conversations with fresh inbound activity.',
      },
      meta: { provider: 'filter', groupLabel: 'Actions', keywords: ['new replies', 'inbound', 'reply'] },
    }),
    buildStatic({
      id: 'filter-not-contacted',
      type: 'filter',
      title: 'Show Not Contacted',
      subtitle: 'Focus uncontacted sellers and not_contacted records',
      badge: 'Filter',
      icon: 'users',
      route: '/inbox',
      actionId: 'apply_inbox_view',
      eventPayload: { kind: 'apply_inbox_view', view: 'not_contacted', sourceMode: 'all_sellers' },
      score: onInboxSurface ? 84 : 70,
      preview: {
        eyebrow: 'Inbox Filter',
        title: 'Not Contacted',
        summary: 'Surface sellers and property records that have not been contacted yet.',
      },
      meta: { provider: 'filter', groupLabel: 'Actions', keywords: ['not contacted', 'uncontacted', 'cold sellers'] },
    }),
    buildStatic({
      id: 'filter-positive-intent',
      type: 'filter',
      title: 'Show Positive Intent',
      subtitle: 'Focus positive and hot seller intent',
      badge: 'Filter',
      icon: 'heart',
      route: '/inbox',
      actionId: 'apply_inbox_view',
      eventPayload: { kind: 'apply_inbox_view', view: 'positive_hot' },
      score: onInboxSurface ? 82 : 68,
      preview: {
        eyebrow: 'Inbox Filter',
        title: 'Positive Intent',
        summary: 'Surface hot or positive seller conversations first.',
      },
      meta: { provider: 'filter', groupLabel: 'Actions', keywords: ['positive intent', 'hot leads', 'interested sellers'] },
    }),
    buildStatic({
      id: 'map-theme-satellite',
      type: 'map_action',
      title: 'Switch Map Theme: Satellite',
      subtitle: 'Stable satellite reconnaissance baseline',
      badge: 'Theme',
      icon: 'globe',
      route: '/inbox',
      actionId: 'set_map_theme',
      eventPayload: { kind: 'set_map_theme', theme: 'satellite', view: 'command_map' },
      score: context.activeMapTheme === 'satellite' ? 96 : 72,
      preview: {
        eyebrow: 'Map Theme',
        title: 'Satellite',
        summary: 'Switch to the stable satellite baseline while keeping the map workspace active.',
      },
      meta: { provider: 'map', groupLabel: 'Actions', keywords: ['satellite', 'imagery', 'map theme'] },
    }),
    buildStatic({
      id: 'map-theme-dark',
      type: 'map_action',
      title: 'Switch Map Theme: Dark',
      subtitle: 'Premium dark operational surface',
      badge: 'Theme',
      icon: 'moon',
      route: '/inbox',
      actionId: 'set_map_theme',
      eventPayload: { kind: 'set_map_theme', theme: 'dark_ops', view: 'command_map' },
      score: context.activeMapTheme === 'dark_ops' ? 96 : 72,
      preview: {
        eyebrow: 'Map Theme',
        title: 'Dark',
        summary: 'Apply the premium dark operational theme without leaving the command map.',
      },
      meta: { provider: 'map', groupLabel: 'Actions', keywords: ['dark', 'dark ops', 'map theme'] },
    }),
    buildStatic({
      id: 'map-theme-red-ops',
      type: 'map_action',
      title: 'Switch Map Theme: Red Ops',
      subtitle: 'Black and red tactical map presentation',
      badge: 'Theme',
      icon: 'alert',
      route: '/inbox',
      actionId: 'set_map_theme',
      eventPayload: { kind: 'set_map_theme', theme: 'red_ops', view: 'command_map' },
      score: context.activeMapTheme === 'red_ops' ? 96 : 72,
      preview: {
        eyebrow: 'Map Theme',
        title: 'Red Ops',
        summary: 'Apply the red tactical theme for sharper alert-state map scanning.',
      },
      meta: { provider: 'map', groupLabel: 'Actions', keywords: ['red ops', 'red', 'tactical', 'map theme'] },
    }),
    buildStatic({
      id: 'map-theme-matrix',
      type: 'map_action',
      title: 'Switch Map Theme: Matrix',
      subtitle: 'Black and emerald tactical interface',
      badge: 'Theme',
      icon: 'cpu',
      route: '/inbox',
      actionId: 'set_map_theme',
      eventPayload: { kind: 'set_map_theme', theme: 'matrix', view: 'command_map' },
      score: context.activeMapTheme === 'matrix' ? 98 : 76,
      preview: {
        eyebrow: 'Map Theme',
        title: 'Matrix',
        summary: 'Switch to the premium black and emerald Matrix theme with tactical UI styling.',
      },
      meta: { provider: 'map', groupLabel: 'Actions', keywords: ['matrix', 'green', 'radar', 'map theme'] },
    }),
    buildStatic({
      id: 'queue-dry-run',
      type: 'system_action',
      title: 'Run Queue Dry Run',
      subtitle: 'Open Queue with dry-run intent only',
      description: 'Routes to Queue and marks this as confirm-required metadata for Phase 1.',
      badge: 'Safe',
      icon: 'play',
      route: '/inbox',
      actionId: 'queue_dry_run',
      eventPayload: { kind: 'queue_dry_run' },
      score: onQueueSurface ? 76 : 64,
      preview: {
        eyebrow: 'Queue Action',
        title: 'Run Queue Dry Run',
        summary: 'Phase 1 keeps this safe: open Queue and expose confirm metadata instead of silently executing.',
        tone: 'warning',
      },
      meta: { provider: 'queue', groupLabel: 'Actions', keywords: ['queue', 'dry run', 'safe batch'], confirmRequired: true },
    }),
    buildStatic({
      id: 'source-all-sellers',
      type: 'filter',
      title: 'Open All Sellers',
      subtitle: 'Switch inbox source mode to all sellers',
      badge: 'Source',
      icon: 'users',
      route: '/inbox',
      actionId: 'set_inbox_source_mode',
      eventPayload: { kind: 'set_inbox_source_mode', sourceMode: 'all_sellers' },
      score: 66,
      preview: {
        eyebrow: 'Inbox Source',
        title: 'All Sellers',
        summary: 'Show the full seller universe instead of only active conversation threads.',
      },
      meta: { provider: 'filter', groupLabel: 'Actions', keywords: ['all sellers', 'seller universe', 'source mode'] },
    }),
    buildStatic({
      id: 'source-conversations',
      type: 'filter',
      title: 'Open Conversations',
      subtitle: 'Switch inbox source mode to live conversations',
      badge: 'Source',
      icon: 'message',
      route: '/inbox',
      actionId: 'set_inbox_source_mode',
      eventPayload: { kind: 'set_inbox_source_mode', sourceMode: 'conversations' },
      score: 66,
      preview: {
        eyebrow: 'Inbox Source',
        title: 'Conversations',
        summary: 'Return the inbox source mode to live conversation threads.',
      },
      meta: { provider: 'filter', groupLabel: 'Actions', keywords: ['conversations', 'thread mode', 'source mode'] },
    }),
  ]
}
