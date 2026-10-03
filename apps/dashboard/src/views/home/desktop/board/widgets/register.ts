import { MAP_LAYERS } from '../../command/home-command-model'
import { registerHomeWidget, type WidgetConfig } from '../widget-registry'
import { BriefWidget, FocusWidget, MachineFeedWidget, SignalsWidget } from './command-widgets'
import { EmailWidget, InboxWidget } from './comm-widgets'
import { CalendarWidget, CampaignWidget, ClosingWidget, PipelineWidget, WorkflowWidget } from './ops-widgets'
import { AnalyticsWidget, MapWidget } from './intel-widgets'
import { BrowserWidget, BuyersWidget, CompsWidget, DealIntelWidget, EntityWidget, QueueWidget } from './app-widgets'
import { ANALYTICS_METRICS } from './analytics-metrics'

/**
 * The first-party Home widgets. Each reads an existing canonical endpoint of
 * its owning app (see ../board-data.ts) and recomposes per size. The Deal
 * Intelligence, Comps, Buyer Match, Entity Graph and Queue instruments read
 * the narrow cached /api/cockpit/home/instruments (the apps' own tables and
 * rules); Browser reads its on-device recent research.
 */

const n = (v: number | null | undefined) => (v === null || v === undefined ? null : v.toLocaleString('en-US'))
const RANGES = [{ value: 'today', label: 'Today' }, { value: '7d', label: '7D' }, { value: '30d', label: '30D' }] as const

let done = false
export function registerFirstPartyWidgets() {
  if (done) return
  done = true

  registerHomeWidget({
    id: 'home.brief', ownerApp: 'home', name: 'Home Brief', icon: 'briefing', domain: 'Command',
    description: 'The greeting, the system state and the one line that says how the operation is doing.',
    sizes: ['small', 'medium', 'wide', 'feature'], defaultSize: 'wide',
    component: BriefWidget, defaultConfig: {},
    data: 'Queue health, today’s messaging, focus counts, 7-day performance',
    openAction: () => ({ label: 'Open Analytics', path: '/analytics' }),
    refresh: { everyMs: 60_000, events: ['/queue', '/inbox'] },
    emptyState: 'Nothing to report yet.',
    loadingState: 'lines',
  })

  registerHomeWidget({
    id: 'home.focus', ownerApp: 'home', name: 'Needs You', icon: 'target', domain: 'Command',
    description: 'Everything that needs you — Notification Center stories, Inbox, Queue, Campaigns, Pipeline and Closings — once, ranked.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large'], defaultSize: 'tall',
    component: FocusWidget, defaultConfig: {},
    data: 'Notification Center 2.0 “Needs you” stories + operational state from each app',
    openAction: () => ({ label: 'Open Notifications', path: '/notifications' }),
    refresh: { everyMs: 45_000, events: ['/inbox', '/queue', '/campaign-command', '/closing-desk'] },
    emptyState: 'Nothing is waiting on you.',
    preview: (m) => (m?.inbox ? `${n(m.inbox.awaiting)} replies awaiting` : null),
  })

  registerHomeWidget({
    id: 'inbox.replies', ownerApp: 'inbox', name: 'Inbox', icon: 'inbox', domain: 'Communication',
    description: 'New seller replies, priority and the conversations waiting — open one, inspect it or start a mission.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large', 'wide'], defaultSize: 'medium',
    component: InboxWidget, defaultConfig: {},
    data: 'Live inbox — new_replies bucket and canonical counts',
    openAction: () => ({ label: 'Open Inbox', path: '/inbox' }),
    openBesideAction: () => ({ label: 'Open Inbox beside', path: '/inbox' }),
    refresh: { everyMs: 45_000, events: ['/inbox'] },
    emptyState: 'No seller replies waiting.',
    preview: (m) => (m?.inbox ? `${n(m.inbox.awaiting)} awaiting · ${n(m.inbox.needs_review)} need review` : null),
  })

  registerHomeWidget({
    id: 'pipeline.flow', ownerApp: 'pipeline', name: 'Pipeline', icon: 'trending-up', domain: 'Acquisitions',
    description: 'Live deals, estimated value, the S1–S9 flow, deals that need attention and today’s movement.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large', 'wide', 'feature'], defaultSize: 'medium',
    component: PipelineWidget, defaultConfig: {},
    data: 'Pipeline command overview (active scope)',
    openAction: () => ({ label: 'Open Pipeline', path: '/pipeline' }),
    openBesideAction: () => ({ label: 'Open Pipeline beside', path: '/pipeline' }),
    refresh: { everyMs: 180_000, events: ['/pipeline'] },
    emptyState: 'No live deals.',
    preview: (m) => (m?.pipeline ? `${n(m.pipeline.live)} live · ${n(m.pipeline.moved_today)} moved today` : null),
  })

  registerHomeWidget<{ lens: string; range: string }>({
    id: 'map.pulse', ownerApp: 'map', name: 'Map', icon: 'map', domain: 'Command',
    description: 'The national field lit by one real metric. Hover a state for its total; click to frame it on the Map.',
    sizes: ['small', 'medium', 'tall', 'large', 'wide', 'feature'], defaultSize: 'large',
    component: MapWidget,
    defaultConfig: { lens: 'replies', range: '7d' },
    configSchema: [
      { key: 'lens', kind: 'select', label: 'Lens', options: MAP_LAYERS.map((l) => ({ value: l.id, label: l.label, hint: l.definition })) },
      { key: 'range', kind: 'segmented', label: 'Period', options: RANGES },
    ],
    data: 'Analytics performance by ZIP (replies, deliveries, stage moves, offers, buyer purchases, failures) · live pipeline points',
    openAction: () => ({ label: 'Open Map', path: '/map' }),
    openBesideAction: () => ({ label: 'Open Map beside', path: '/map' }),
    refresh: { everyMs: 300_000 },
    emptyState: 'Nothing to place on the map for this lens.',
    loadingState: 'chart',
    maxInstances: 4,
  })

  registerHomeWidget({
    id: 'campaign.engine', ownerApp: 'campaign-command', name: 'Campaigns', icon: 'bolt', domain: 'Acquisitions',
    description: 'Active campaigns, today’s throughput, deliveries, replies, what is blocked and ready capacity. Pin one campaign or follow the one you have open.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large'], defaultSize: 'medium',
    component: CampaignWidget, defaultConfig: {},
    contexts: ['global', 'pinned', 'linked'],
    data: 'Campaign list (Campaign Command), queue processor health, today’s messaging',
    openAction: ({ subject }) => ({ label: 'Open Campaign Command', path: subject ? `/campaign-command?campaign=${encodeURIComponent(subject.id)}` : '/campaign-command' }),
    openBesideAction: ({ subject }) => ({ label: 'Open beside', path: subject ? `/campaign-command?campaign=${encodeURIComponent(subject.id)}` : '/campaign-command' }),
    refresh: { everyMs: 120_000, events: ['/campaign-command', '/queue'] },
    emptyState: 'No campaigns running.',
    preview: (m) => (m?.campaigns ? `${n(m.campaigns.active)} active · ${n(m.campaigns.paused)} paused` : null),
  })

  registerHomeWidget<{ metric: string; period: string; market: string | null; display: string }>({
    id: 'analytics.metric', ownerApp: 'analytics', name: 'Analytics', icon: 'stats', domain: 'Intelligence',
    description: 'One metric you choose, for a period and market, against the previous period — with its definition.',
    sizes: ['compact', 'small', 'medium', 'tall', 'wide', 'large'], defaultSize: 'small',
    component: AnalyticsWidget,
    defaultConfig: { metric: 'replied', period: '7d', market: null, display: 'chart' },
    configSchema: [
      { key: 'metric', kind: 'select', label: 'Metric', options: ANALYTICS_METRICS.map((m) => ({ value: m.value, label: m.label })) },
      { key: 'period', kind: 'segmented', label: 'Period', options: [...RANGES, { value: '90d', label: '90D' }] },
      { key: 'market', kind: 'select', label: 'Market', options: [{ value: '', label: 'All markets' }], source: 'markets' },
      { key: 'display', kind: 'segmented', label: 'Display', options: [{ value: 'chart', label: 'Chart' }, { value: 'number', label: 'Number' }] },
    ],
    data: 'Analytics performance (canonical metric contracts)',
    openAction: () => ({ label: 'Open Analytics', path: '/analytics' }),
    openBesideAction: () => ({ label: 'Open Analytics beside', path: '/analytics' }),
    refresh: { everyMs: 300_000 },
    emptyState: 'No data for this period.',
    loadingState: 'chart',
  })

  registerHomeWidget({
    id: 'calendar.agenda', ownerApp: 'calendar', name: 'Calendar', icon: 'calendar', domain: 'Operations',
    description: 'Today, what is next, what is overdue and the scheduled send windows across the week.',
    sizes: ['compact', 'small', 'medium', 'tall', 'wide'], defaultSize: 'small',
    component: CalendarWidget, defaultConfig: {},
    data: 'Calendar events (follow-ups, workflow, campaigns, offers, contracts, title, closings)',
    openAction: () => ({ label: 'Open Calendar', path: '/calendar' }),
    openBesideAction: () => ({ label: 'Open Calendar beside', path: '/calendar' }),
    refresh: { everyMs: 300_000 },
    emptyState: 'Nothing scheduled this week.',
  })

  registerHomeWidget<{ lane: string; count: string }>({
    id: 'machine.feed', ownerApp: 'workflow-studio', name: 'Machine Feed', icon: 'activity', domain: 'Operations',
    description: 'The last meaningful things the machine did — one row per execution, not per log line.',
    sizes: ['compact', 'small', 'medium', 'tall', 'wide', 'large'], defaultSize: 'tall',
    component: MachineFeedWidget,
    defaultConfig: { lane: 'all', count: '8' },
    configSchema: [
      { key: 'lane', kind: 'select', label: 'Lane', options: [{ value: 'all', label: 'Everything' }, { value: 'seller', label: 'Sellers' }, { value: 'campaign', label: 'Campaigns' }, { value: 'orchestrator', label: 'Workflows' }, { value: 'closing', label: 'Closings' }] },
      { key: 'count', kind: 'segmented', label: 'Rows', options: [{ value: '5', label: '5' }, { value: '8', label: '8' }, { value: '10', label: '10' }] },
    ],
    data: 'Workflow Studio activity (last 24 hours)',
    openAction: () => ({ label: 'Open Workflow Studio', path: '/workflow-studio' }),
    refresh: { everyMs: 30_000, events: ['/inbox', '/queue', '/campaign-command', '/workflow-studio', '/closing-desk'] },
    emptyState: 'Nothing in the last 24 hours.',
  })

  registerHomeWidget({
    id: 'closing.desk', ownerApp: 'closing-desk', name: 'Closing Desk', icon: 'file-text', domain: 'Closings',
    description: 'Deals under contract, closings this week, title blocks and what needs you — and the next closing.',
    sizes: ['compact', 'small', 'medium', 'large'], defaultSize: 'medium',
    component: ClosingWidget, defaultConfig: {},
    data: 'Closing Desk (live cases only — fixtures are never shown)',
    openAction: () => ({ label: 'Open Closing Desk', path: '/closing-desk' }),
    openBesideAction: () => ({ label: 'Open Closing Desk beside', path: '/closing-desk' }),
    refresh: { everyMs: 180_000, events: ['/closing-desk'] },
    emptyState: 'No live closings.',
    preview: (m) => (m?.closing ? `${n(m.closing.active)} active · ${n(m.closing.needs_you)} need you` : null),
  })

  registerHomeWidget({
    id: 'workflow.runs', ownerApp: 'workflow-studio', name: 'Workflows', icon: 'layers', domain: 'Operations',
    description: 'Active runs, runs held for you, failures and the workflows doing the work.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large'], defaultSize: 'medium',
    component: WorkflowWidget, defaultConfig: {},
    data: 'Workflow Studio observatory registry',
    openAction: () => ({ label: 'Open Workflow Studio', path: '/workflow-studio' }),
    openBesideAction: () => ({ label: 'Open beside', path: '/workflow-studio' }),
    refresh: { everyMs: 120_000, events: ['/workflow-studio'] },
    emptyState: 'No workflows registered.',
    preview: (m) => (m?.workflow ? `${n(m.workflow.live_runs)} live runs · ${n(m.workflow.human_holds)} held` : null),
  })

  registerHomeWidget({
    id: 'email.command', ownerApp: 'email-command', name: 'Email Command', icon: 'mail', domain: 'Communication',
    description: 'Email that needs you, what the system is handling, failures and whether sending is on.',
    sizes: ['compact', 'small', 'medium', 'tall'], defaultSize: 'medium',
    component: EmailWidget, defaultConfig: {},
    data: 'Email Command home (first-party outbox + ledger)',
    openAction: () => ({ label: 'Open Email Command', path: '/email-command' }),
    openBesideAction: () => ({ label: 'Open beside', path: '/email-command' }),
    refresh: { everyMs: 120_000, events: ['/email-command'] },
    emptyState: 'No email needs you.',
    preview: (m) => (m?.email ? `${n(m.email.needs_you)} need you · sending ${m.email.sending_enabled ? 'on' : 'off'}` : null),
  })

  registerHomeWidget({
    id: 'signals.center', ownerApp: 'notifications', name: 'Signals', icon: 'radar', domain: 'Intelligence',
    description: 'Signal Center: open signals, what fired today and whether the evaluator is running.',
    sizes: ['compact', 'small', 'medium', 'tall'], defaultSize: 'small',
    component: SignalsWidget, defaultConfig: {},
    data: 'Signal Center (rules, ledger, watches)',
    openAction: () => ({ label: 'Open Signals', path: '/notifications' }),
    refresh: { everyMs: 120_000 },
    emptyState: 'No open signals.',
  })
  registerHomeWidget({
    id: 'deal.decisions', ownerApp: 'deal-intelligence', name: 'Deal Intelligence', icon: 'target', domain: 'Acquisitions',
    description: 'Active deals whose decision needs review, scores below the confidence gates, and live offers awaiting a response.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large'], defaultSize: 'medium',
    component: DealIntelWidget, defaultConfig: {},
    data: 'Acquisition scores for active opportunities (Deal Intelligence gates) + live seller offers',
    openAction: () => ({ label: 'Open Deal Intelligence', path: '/deal-intelligence' }),
    openBesideAction: () => ({ label: 'Open beside', path: '/deal-intelligence' }),
    refresh: { everyMs: 180_000, events: ['/pipeline'] },
    emptyState: 'No scored deal needs a decision.',
  })

  registerHomeWidget({
    id: 'comps.recent', ownerApp: 'comp-intelligence', name: 'Comps', icon: 'stats', domain: 'Intelligence',
    description: 'How fresh the sold-comp pool is, priced sales in the markets you have deals in, and the latest recorded sales.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large', 'wide'], defaultSize: 'medium',
    component: CompsWidget, defaultConfig: {},
    data: 'Recorded priced sales (the Map / Comps sold-comp pool)',
    openAction: () => ({ label: 'Open Comp Intelligence', path: '/comp-intelligence' }),
    refresh: { everyMs: 600_000 },
    emptyState: 'No priced sales on record.',
  })

  registerHomeWidget({
    id: 'buyers.matches', ownerApp: 'buyer-match', name: 'Buyer Match', icon: 'users', domain: 'Acquisitions',
    description: 'Strongest buyer matches for active deals and investor purchases in your markets. Buyer names are withheld.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large', 'wide'], defaultSize: 'medium',
    component: BuyersWidget, defaultConfig: {},
    data: 'Buyer match candidates for active deals (scores and buyer type only) + recorded investor purchases',
    openAction: () => ({ label: 'Open Buyer Match', path: '/buyer-match' }),
    refresh: { everyMs: 600_000 },
    emptyState: 'No buyer matches for active deals.',
  })

  registerHomeWidget({
    id: 'entity.network', ownerApp: 'entity-graph', name: 'Entity Graph', icon: 'link', domain: 'Intelligence',
    description: 'Resolved owners and the most connected portfolios in the graph.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large'], defaultSize: 'medium',
    component: EntityWidget, defaultConfig: {},
    data: 'Master owners (Entity Graph networks)',
    openAction: () => ({ label: 'Open Entity Graph', path: '/entity-graph' }),
    refresh: { everyMs: 900_000 },
    emptyState: 'No multi-property owners resolved yet.',
  })

  registerHomeWidget({
    id: 'queue.desk', ownerApp: 'queue', name: 'Queue', icon: 'send', domain: 'Operations',
    description: 'What is held and why, and how much sending capacity the fleet has left today.',
    sizes: ['compact', 'small', 'medium', 'tall', 'large'], defaultSize: 'medium',
    component: QueueWidget, defaultConfig: {},
    data: 'Send queue holds by reason + TextGrid sender capacity',
    openAction: () => ({ label: 'Open Queue', path: '/queue' }),
    openBesideAction: () => ({ label: 'Open Queue beside', path: '/queue' }),
    refresh: { everyMs: 60_000, events: ['/queue'] },
    emptyState: 'Nothing is held.',
    preview: (m) => (m?.queue ? `${n(m.queue.today_remaining)} remaining today` : null),
  })

  registerHomeWidget({
    id: 'browser.recent', ownerApp: 'browser', name: 'Browser', icon: 'compass', domain: 'Intelligence',
    description: 'The research you opened recently, one click to reopen it in the Browser.',
    sizes: ['compact', 'small', 'medium', 'tall'], defaultSize: 'small',
    component: BrowserWidget, defaultConfig: {},
    data: 'Browser recent research (on this device)',
    openAction: () => ({ label: 'Open Browser', path: '/browser' }),
    refresh: { everyMs: 600_000 },
    emptyState: 'No research opened on this device yet.',
  })
}

/** The widget an app becomes when it is dragged from the Command Rail onto Home. */
export const RAIL_DEFAULT_WIDGET: Record<string, string> = {
  inbox: 'inbox.replies',
  pipeline: 'pipeline.flow',
  map: 'map.pulse',
  'campaign-command': 'campaign.engine',
  queue: 'queue.desk',
  'deal-intelligence': 'deal.decisions',
  'comp-intelligence': 'comps.recent',
  'buyer-match': 'buyers.matches',
  'entity-graph': 'entity.network',
  browser: 'browser.recent',
  analytics: 'analytics.metric',
  calendar: 'calendar.agenda',
  'closing-desk': 'closing.desk',
  'workflow-studio': 'workflow.runs',
  'email-command': 'email.command',
  home: 'home.brief',
}

export type { WidgetConfig }
