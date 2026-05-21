export type CommandStoreItem = {
  id: string
  name: string
  type: 'app' | 'agent' | 'widget' | 'automation' | 'integration' | 'map_layer' | 'template' | 'report' | 'pack'
  category: string
  description: string
  longDescription?: string
  status: 'installed' | 'available' | 'beta' | 'connected' | 'needs_auth' | 'disconnected' | 'coming_soon'
  accent: string
  icon: string
  recommendedSpaces: string[]
  tags: string[]
  metrics?: {
    label: string
    value: string
  }[]
  includedWidgets?: string[]
  includedAutomations?: string[]
  requiredIntegrations?: string[]
  dataSources?: string[]
  lastAction?: string
  confidence?: string
  timeSaved?: string
  health?: 'healthy' | 'warning'
  lastSync?: string
}

export const COMMAND_SPACES = [
  'Acquisition Command',
  'Market Intelligence',
  'Messaging & AI',
  'Deal Execution',
  'Dispo / Buyers',
  'Automation Health',
  'Revenue / Executive',
  'Title & Closings',
  'Custom Space',
  'Homepage',
] as const

export const STORE_CATEGORY_FILTERS = [
  'All',
  'Featured',
  'Apps',
  'Agents',
  'Automations',
  'Widgets',
  'Dashboards',
  'Integrations',
  'Map Layers',
  'Templates',
  'Reports',
  'Installed',
] as const

export const STORE_SORT_OPTIONS = [
  'Recommended',
  'Most Used',
  'Recently Added',
  'Highest Impact',
  'Needs Setup',
  'Installed First',
] as const

export const STORE_VIEW_OPTIONS = ['Grid', 'Compact', 'Showcase'] as const

export const STORE_SIDEBAR_CATEGORIES = [
  { id: 'featured', label: 'Featured', icon: 'SF', count: 12 },
  { id: 'execution', label: 'Execution Apps', icon: 'EX', count: 18 },
  { id: 'agents', label: 'AI Agents', icon: 'AI', count: 24 },
  { id: 'widgets', label: 'Command Widgets', icon: 'WG', count: 31 },
  { id: 'automations', label: 'Automations', icon: 'AU', count: 19 },
  { id: 'industry', label: 'Industry Packs', icon: 'PK', count: 9 },
  { id: 'utility', label: 'Utility Apps', icon: 'UT', count: 15 },
  { id: 'productivity', label: 'Productivity', icon: 'PD', count: 10 },
  { id: 'kpi', label: 'KPIs & Analytics', icon: 'KP', count: 12 },
  { id: 'integrations', label: 'Integrations', icon: 'IN', count: 16 },
  { id: 'map', label: 'Map Layers', icon: 'MP', count: 14 },
  { id: 'templates', label: 'Templates', icon: 'TP', count: 11 },
  { id: 'reports', label: 'Reports', icon: 'RP', count: 12 },
  { id: 'installed', label: 'Installed', icon: 'OK', count: 30 },
] as const

export const STORE_SHORTCUTS = [
  { label: 'My Spaces', icon: 'MS' },
  { label: 'System Health', icon: 'SH' },
  { label: 'Command Center', icon: 'CC' },
  { label: 'Developer Hub', icon: 'DH' },
  { label: 'API Logs', icon: 'AL' },
] as const

const app = (
  id: string,
  name: string,
  description: string,
  accent: string,
  status: CommandStoreItem['status'],
  category: string,
  recommendedSpaces: string[],
  tags: string[],
): CommandStoreItem => ({
  id,
  name,
  type: 'app',
  category,
  description,
  longDescription: `${name} is built as a premium operating module for Command Spaces with install state, add-to-space controls, and widget or automation exposure for homepage and mission workflows.`,
  status,
  accent,
  icon: name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase(),
  recommendedSpaces,
  tags,
  metrics: [
    { label: 'Impact', value: 'High' },
    { label: 'Usage', value: 'Daily' },
  ],
})

const agent = (
  id: string,
  name: string,
  status: CommandStoreItem['status'],
  accent: string,
  lastAction: string,
  confidence: string,
  timeSaved: string,
): CommandStoreItem => ({
  id,
  name,
  type: 'agent',
  category: 'Agents',
  description: `${name} runs autonomous operating loops and escalates critical edge-cases for human approval.`,
  longDescription: `${name} observes events, reasoning context, and output quality across messaging, deal execution, and automation workflows, then drives approved actions in active Command Spaces.`,
  status,
  accent,
  icon: name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase(),
  recommendedSpaces: ['Messaging & AI', 'Deal Execution', 'Automation Health'],
  tags: ['agent', 'automation', 'ai'],
  metrics: [
    { label: 'Confidence', value: confidence },
    { label: 'Time Saved', value: timeSaved },
  ],
  lastAction,
  confidence,
  timeSaved,
  includedAutomations: ['Retry Failed Sends', 'Route Hot Replies'],
  requiredIntegrations: ['OpenAI', 'Supabase'],
  dataSources: ['Message Events', 'Send Queue', 'Offers'],
})

const integration = (
  id: string,
  name: string,
  status: CommandStoreItem['status'],
  health: 'healthy' | 'warning',
  lastSync: string,
  accent: string,
): CommandStoreItem => ({
  id,
  name,
  type: 'integration',
  category: 'Integrations',
  description: `${name} sync connector for command data, events, and orchestration actions.`,
  longDescription: `${name} connects operational data and event transport to the NEXUS command layer with observability hooks, sync health, and status monitoring for automation reliability.`,
  status,
  accent,
  icon: name
    .split(/[ /]+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase(),
  recommendedSpaces: ['Automation Health', 'Revenue / Executive'],
  tags: ['integration', 'sync', 'connector'],
  metrics: [
    { label: 'Last Sync', value: lastSync },
    { label: 'Health', value: health === 'healthy' ? 'Healthy' : 'Warning' },
  ],
  health,
  lastSync,
  requiredIntegrations: [name],
  dataSources: ['Webhook Logs', 'API Health'],
})

const widget = (id: string, name: string, accent: string): CommandStoreItem => ({
  id,
  name,
  type: 'widget',
  category: 'Widgets',
  description: `${name} snapshot widget for mission-critical command surfaces.`,
  status: 'available',
  accent,
  icon: name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase(),
  recommendedSpaces: ['Homepage', 'Acquisition Command', 'Revenue / Executive'],
  tags: ['widget', 'homepage'],
  metrics: [{ label: 'Surface', value: 'Widget' }],
})

const automation = (id: string, name: string, accent: string): CommandStoreItem => ({
  id,
  name,
  type: 'automation',
  category: 'Automations',
  description: `${name} command workflow that executes reliably with audit logging.`,
  status: 'available',
  accent,
  icon: name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase(),
  recommendedSpaces: ['Automation Health', 'Messaging & AI', 'Deal Execution'],
  tags: ['automation', 'workflow'],
  metrics: [{ label: 'Mode', value: 'Auto' }],
  includedAutomations: [name],
})

const mapLayer = (id: string, name: string, accent: string): CommandStoreItem => ({
  id,
  name,
  type: 'map_layer',
  category: 'Map Layers',
  description: `${name} geospatial intelligence overlay for Market Command System.`,
  status: 'available',
  accent,
  icon: name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase(),
  recommendedSpaces: ['Market Intelligence', 'Acquisition Command'],
  tags: ['map', 'layer', 'market'],
  metrics: [{ label: 'Layer', value: 'Live' }],
  dataSources: ['Markets', 'Zip Codes', 'Properties'],
})

const report = (id: string, name: string, accent: string): CommandStoreItem => ({
  id,
  name,
  type: 'report',
  category: 'Dashboards',
  description: `${name} executive dashboard for operational performance and risk.`,
  status: 'available',
  accent,
  icon: name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase(),
  recommendedSpaces: ['Revenue / Executive', 'Automation Health'],
  tags: ['kpi', 'dashboard'],
  metrics: [{ label: 'Refresh', value: 'Live' }],
})

export const COMMAND_STORE_ITEMS: CommandStoreItem[] = [
  {
    id: 'real-estate-acquisitions-pack',
    name: 'Real Estate Acquisitions Pack',
    type: 'pack',
    category: 'Featured',
    description:
      'Full acquisition operating system for seller inbox, queue, AI replies, offers, owner intelligence, and follow-up.',
    longDescription:
      'A complete acquisitions command layer with unified seller communication, queue reliability, offer operations, and owner intelligence surfaces built for high-velocity teams.',
    status: 'installed',
    accent: '#24d6a2',
    icon: 'RA',
    recommendedSpaces: ['Acquisition Command', 'Messaging & AI', 'Deal Execution'],
    tags: ['Acquisition', 'Messaging', 'AI', 'Core System'],
    metrics: [
      { label: 'Assets', value: '24' },
      { label: 'Installed Spaces', value: '3' },
    ],
    includedWidgets: ['Hot Replies', 'Ready Now', 'Failed Sends', 'Hot Sellers'],
    includedAutomations: ['Schedule Follow-Ups', 'Route Hot Replies'],
    requiredIntegrations: ['Podio', 'Supabase', 'TextGrid'],
    dataSources: ['MasterOwners', 'Owners', 'Prospects', 'Properties', 'Offers', 'Message Events'],
  },
  {
    id: 'market-command-system',
    name: 'Market Command System',
    type: 'app',
    category: 'Featured',
    description:
      'MapLibre-powered live market intelligence with heat layers, lead pulses, pressure zones, comp radius, and Street View context.',
    longDescription:
      'Live MapLibre intelligence layer for market pressure, lead pulses, heat maps, comp radius, Street View context, and operational map dashboards.',
    status: 'installed',
    accent: '#3fc7ff',
    icon: 'MC',
    recommendedSpaces: ['Market Intelligence', 'Acquisition Command'],
    tags: ['Market Intelligence', 'Map', 'Executive'],
    metrics: [
      { label: 'Active Layers', value: '14' },
      { label: 'Coverage', value: '312 zips' },
    ],
    includedWidgets: ['Mini map widget', 'Market pressure widget'],
    includedAutomations: ['Market Heat Recalculation'],
    requiredIntegrations: ['Supabase', 'Vercel'],
    dataSources: ['Markets', 'Zip Codes', 'Properties', 'Message Events', 'Offers', 'Send Queue'],
  },
  {
    id: 'queue-recovery-agent',
    name: 'Queue Recovery Agent',
    type: 'agent',
    category: 'Featured',
    description:
      'Autonomously classifies failed sends, retries recoverable messages, locks unsafe records, and escalates risk.',
    status: 'installed',
    accent: '#ffb347',
    icon: 'QR',
    recommendedSpaces: ['Messaging & AI', 'Automation Health'],
    tags: ['Queue', 'Automation', 'Messaging'],
    metrics: [
      { label: 'Recovered Today', value: '2,184' },
      { label: 'Confidence', value: '96%' },
    ],
    includedAutomations: ['Retry Failed Sends', 'Compliance Pause'],
    requiredIntegrations: ['TextGrid', 'Twilio'],
    dataSources: ['Send Queue', 'Message Events', 'TextGrid Numbers'],
    lastAction: 'Retried 163 failed sends 2m ago',
    confidence: '96%',
    timeSaved: '14h/week',
  },
  {
    id: 'seller-intelligence-dossier',
    name: 'Seller Intelligence Dossier',
    type: 'app',
    category: 'Featured',
    description:
      'Unified owner profile with properties, motivation signals, contact stack, conversation history, AI summary, and strategy recommendations.',
    status: 'installed',
    accent: '#7ae3c3',
    icon: 'SD',
    recommendedSpaces: ['Acquisition Command'],
    tags: ['Owners', 'Properties', 'Acquisitions'],
  },
  {
    id: 'offer-studio-featured',
    name: 'Offer Studio',
    type: 'app',
    category: 'Featured',
    description:
      'Generate, adjust, approve, and send cash, creative, novation, and multifamily offers from one command surface.',
    status: 'available',
    accent: '#7f8bff',
    icon: 'OS',
    recommendedSpaces: ['Deal Execution', 'Acquisition Command'],
    tags: ['Offers', 'Underwriting', 'Deals'],
  },
  {
    id: 'contract-studio-featured',
    name: 'Contract Studio',
    type: 'app',
    category: 'Featured',
    description:
      'Create, preview, edit, send, sign, track, and route real estate contracts through title.',
    status: 'available',
    accent: '#f49bff',
    icon: 'CS',
    recommendedSpaces: ['Deal Execution', 'Title & Closings'],
    tags: ['Contracts', 'Signatures', 'Title'],
  },

  app(
    'seller-inbox',
    'Seller Inbox',
    'Unified inbox for seller conversations and AI-assisted response operations.',
    '#30d6bb',
    'installed',
    'Apps',
    ['Acquisition Command', 'Messaging & AI'],
    ['inbox', 'messaging'],
  ),
  app('send-queue', 'Send Queue', 'Queue management for delivery throughput, retries, and approvals.', '#42c8ff', 'installed', 'Apps', ['Messaging & AI', 'Automation Health'], ['queue', 'delivery']),
  app('seller-dossier', 'Seller Dossier', 'Owner intelligence profile with property, motivation, and comms history.', '#7de4c7', 'installed', 'Apps', ['Acquisition Command'], ['owner intelligence']),
  app('property-intelligence', 'Property Intelligence', 'Property-level analytics and context for acquisition prioritization.', '#4fd4e4', 'installed', 'Apps', ['Acquisition Command', 'Market Intelligence'], ['property']),
  app('offer-studio', 'Offer Studio', 'Offer generation, underwriting snapshots, and approval routing.', '#8d9bff', 'available', 'Apps', ['Deal Execution'], ['offer']),
  app('contract-studio', 'Contract Studio', 'Contract drafting, signing, and status orchestration.', '#d78fff', 'available', 'Apps', ['Deal Execution', 'Title & Closings'], ['contracts']),
  app('title-command', 'Title Command', 'Title routing, issue tracking, and closing readiness.', '#ffc169', 'available', 'Apps', ['Title & Closings'], ['title']),
  app('closing-tracker', 'Closing Tracker', 'Timeline and blocker tracking for active closings.', '#ff8e7d', 'available', 'Apps', ['Title & Closings', 'Revenue / Executive'], ['closing']),
  app('buyer-match', 'Buyer Match', 'Disposition matching for buyers, criteria, and release sequencing.', '#7fd38c', 'available', 'Apps', ['Dispo / Buyers'], ['buyers']),
  app('revenue-command', 'Revenue Command', 'Revenue run-rate and assignment fee execution control.', '#55e0b3', 'available', 'Apps', ['Revenue / Executive'], ['revenue']),
  app('pipeline-command', 'Pipeline Command', 'Deal stage management from intake through close.', '#5fb8ff', 'available', 'Apps', ['Revenue / Executive', 'Deal Execution'], ['pipeline']),
  app('market-command', 'Market Command', 'Live market command center for heat, pressure, and comp signals.', '#38c0ff', 'installed', 'Apps', ['Market Intelligence'], ['market']),

  agent('ai-reply-agent', 'AI Reply Agent', 'installed', '#38c0ff', 'Drafted 21 replies 5m ago', '95%', '11h/week'),
  agent('ai-follow-up-agent', 'AI Follow-Up Agent', 'available', '#55d9b5', 'Queued follow-ups 14m ago', '91%', '8h/week'),
  agent('queue-recovery-agent-2', 'Queue Recovery Agent', 'installed', '#ffb34f', 'Recovered failed queue 2m ago', '96%', '14h/week'),
  agent('offer-pricing-agent', 'Offer Pricing Agent', 'beta', '#a58bff', 'Adjusted 7 pricing models 32m ago', '88%', '6h/week'),
  agent('deal-analyzer-agent', 'Deal Analyzer Agent', 'available', '#7ec6ff', 'Flagged 3 risk deals 1h ago', '90%', '5h/week'),
  agent('market-intel-agent', 'Market Intel Agent', 'available', '#2fd6d0', 'Updated zone priorities 19m ago', '93%', '7h/week'),
  agent('compliance-monitor', 'Compliance Monitor', 'installed', '#ff8f8f', 'Paused non-compliant batch 9m ago', '98%', '9h/week'),
  agent('title-risk-agent', 'Title Risk Agent', 'beta', '#ffc36e', 'Scored title packet 24m ago', '87%', '4h/week'),
  agent('executive-advisor', 'Executive Advisor', 'available', '#83a4ff', 'Published strategy brief 1h ago', '92%', '3h/week'),
  agent('lead-scoring-agent', 'Lead Scoring Agent', 'installed', '#42d2b7', 'Rescored 1,244 leads 8m ago', '94%', '10h/week'),
  agent('campaign-optimizer', 'Campaign Optimizer', 'available', '#67b6ff', 'Rebalanced campaign weights 21m ago', '89%', '6h/week'),
  agent('conversation-brain', 'Conversation Brain', 'installed', '#4be2dc', 'Summarized 18 threads 6m ago', '97%', '12h/week'),

  automation('retry-failed-sends', 'Retry Failed Sends', '#ffb44d'),
  automation('schedule-follow-ups', 'Schedule Follow-Ups', '#54d6b0'),
  automation('route-hot-replies', 'Route Hot Replies', '#4cbdf9'),
  automation('generate-offer-drafts', 'Generate Offer Drafts', '#8f9cff'),
  automation('send-to-title', 'Send to Title', '#ffc573'),
  automation('buyer-match-release', 'Buyer Match Release', '#7dd696'),
  automation('contract-status-sync', 'Contract Status Sync', '#f39bff'),
  automation('daily-briefing', 'Daily Briefing', '#75b9ff'),
  automation('compliance-pause', 'Compliance Pause', '#ff8f8f'),
  automation('market-heat-recalculation', 'Market Heat Recalculation', '#44ccff'),
  automation('revenue-forecast-update', 'Revenue Forecast Update', '#51d9a8'),

  widget('hot-replies', 'Hot Replies', '#45d5be'),
  widget('ready-now', 'Ready Now', '#42c4ff'),
  widget('failed-sends', 'Failed Sends', '#ffac5f'),
  widget('hot-sellers', 'Hot Sellers', '#79ddb7'),
  widget('market-heat', 'Market Heat', '#49c3ff'),
  widget('offers-ready', 'Offers Ready', '#9a9eff'),
  widget('title-blockers', 'Title Blockers', '#ffc073'),
  widget('webhook-failures', 'Webhook Failures', '#ff8d8d'),
  widget('pipeline-value', 'Pipeline Value', '#57dfb7'),
  widget('reply-rate', 'Reply Rate', '#69c8ff'),
  widget('opt-out-rate', 'Opt-Out Rate', '#ffb385'),
  widget('agent-load', 'Agent Load', '#7ea7ff'),
  widget('textgrid-health', 'TextGrid Health', '#5dd4ff'),
  widget('supabase-sync', 'Supabase Sync', '#55dca5'),
  widget('podio-sync', 'Podio Sync', '#9bc7ff'),

  mapLayer('lead-pulses', 'Lead Pulses', '#3fd0ff'),
  mapLayer('heat-mode', 'Heat Mode', '#4ac1ff'),
  mapLayer('distress-layer', 'Distress Layer', '#ff8f8f'),
  mapLayer('equity-layer', 'Equity Layer', '#74dfba'),
  mapLayer('absentee-owner-layer', 'Absentee Owner Layer', '#5fd7c8'),
  mapLayer('portfolio-owner-layer', 'Portfolio Owner Layer', '#7ecbff'),
  mapLayer('corporate-owner-layer', 'Corporate Owner Layer', '#8db5ff'),
  mapLayer('tax-delinquency-layer', 'Tax Delinquency Layer', '#ffad73'),
  mapLayer('probate-layer', 'Probate Layer', '#f79fff'),
  mapLayer('high-intent-replies', 'High-Intent Replies', '#44d2ff'),
  mapLayer('failed-send-clusters', 'Failed Send Clusters', '#ff976e'),
  mapLayer('buyer-demand-layer', 'Buyer Demand Layer', '#7cd890'),
  mapLayer('comp-radius', 'Comp Radius', '#6db5ff'),
  mapLayer('street-view-coverage', 'Street View Coverage', '#48c9ff'),

  report('executive-revenue-dashboard', 'Executive Revenue Dashboard', '#56dfb2'),
  report('reply-rate-monitor', 'Reply Rate Monitor', '#50c9ff'),
  report('opt-out-risk-monitor', 'Opt-Out Risk Monitor', '#ffb06d'),
  report('send-capacity-tracker', 'Send Capacity Tracker', '#7bc2ff'),
  report('campaign-performance', 'Campaign Performance', '#66dbb8'),
  report('agent-performance', 'Agent Performance', '#86a9ff'),
  report('market-heat-dashboard', 'Market Heat Dashboard', '#48c2ff'),
  report('pipeline-forecast', 'Pipeline Forecast', '#62d9a9'),
  report('assignment-fee-forecast', 'Assignment Fee Forecast', '#7ec8ff'),
  report('deal-velocity-tracker', 'Deal Velocity Tracker', '#93a2ff'),
  report('automation-health', 'Automation Health', '#4bd4c4'),
  report('system-reliability', 'System Reliability', '#89baff'),

  integration('podio', 'Podio', 'connected', 'healthy', '2m ago', '#7ac8ff'),
  integration('supabase', 'Supabase', 'connected', 'healthy', '45s ago', '#52dca8'),
  integration('textgrid', 'TextGrid', 'connected', 'healthy', '1m ago', '#5fcbff'),
  integration('vercel', 'Vercel', 'connected', 'healthy', '4m ago', '#9ca8ff'),
  integration('openai', 'OpenAI', 'connected', 'healthy', '35s ago', '#5ed9bc'),
  integration('gmail', 'Gmail', 'needs_auth', 'warning', '46m ago', '#ffb16e'),
  integration('google-calendar', 'Google Calendar', 'connected', 'healthy', '5m ago', '#7dc9ff'),
  integration('notion', 'Notion', 'disconnected', 'warning', '2h ago', '#d89bff'),
  integration('airtable', 'Airtable', 'connected', 'healthy', '8m ago', '#66d7c3'),
  integration('slack', 'Slack', 'connected', 'healthy', '3m ago', '#8da8ff'),
  integration('docusign-signpro', 'DocuSign / SignPro', 'needs_auth', 'warning', '1h ago', '#ffc176'),
  integration('google-drive', 'Google Drive', 'connected', 'healthy', '6m ago', '#65c8ff'),
  integration('stripe', 'Stripe', 'connected', 'healthy', '9m ago', '#7caeff'),
  integration('twilio', 'Twilio', 'connected', 'healthy', '2m ago', '#58ceff'),
  integration('posthog', 'PostHog', 'connected', 'healthy', '7m ago', '#ffb96d'),
  integration('zapier-make', 'Zapier / Make', 'connected', 'healthy', '11m ago', '#63d5b1'),
]

export const FEATURED_SYSTEM_IDS = [
  'real-estate-acquisitions-pack',
  'market-command-system',
  'queue-recovery-agent',
  'seller-intelligence-dossier',
  'offer-studio-featured',
  'contract-studio-featured',
] as const

export const POPULAR_APP_NAMES = [
  'Seller Inbox',
  'Send Queue',
  'Seller Dossier',
  'Property Intelligence',
  'Market Command',
  'Street View Coverage',
  'Offer Studio',
  'Contract Studio',
  'Title Command',
  'Closing Tracker',
  'Buyer Match',
  'Revenue Command',
] as const

export const AI_AGENT_NAMES = [
  'Queue Recovery Agent',
  'AI Follow-Up Agent',
  'AI Reply Agent',
  'Conversation Brain',
  'Market Intel Agent',
  'Deal Analyzer Agent',
  'Offer Pricing Agent',
  'Lead Scoring Agent',
  'Title Risk Agent',
  'Executive Advisor',
  'Compliance Monitor',
  'Campaign Optimizer',
] as const

export const UTILITY_APP_NAMES = [
  'Focus Mode',
  'Calendar Sync',
  'Notes Hub',
  'Task Command',
  'Daily Briefing',
  'Command Search',
  'Notification Center',
  'File Vault',
  'Meeting Notes',
  'Reminder Engine',
  'Activity Stream',
  'Keyboard Shortcuts',
] as const

export const KPI_NAMES = [
  'Executive Revenue Dashboard',
  'Reply Rate Monitor',
  'Opt-Out Risk Monitor',
  'Send Capacity Tracker',
  'Campaign Performance',
  'Agent Performance',
  'Market Heat Dashboard',
  'Pipeline Forecast',
  'Assignment Fee Forecast',
  'Deal Velocity Tracker',
  'Automation Health',
  'System Reliability',
] as const

export const INTEGRATION_NAMES = [
  'Podio',
  'Supabase',
  'TextGrid',
  'Vercel',
  'OpenAI',
  'Gmail',
  'Google Calendar',
  'Notion',
  'Airtable',
  'Slack',
  'DocuSign / SignPro',
  'Google Drive',
  'Stripe',
  'Twilio',
  'PostHog',
  'Zapier / Make',
] as const

export const TOP_CATEGORIES = [
  { label: 'Acquisition', count: 18 },
  { label: 'Messaging', count: 16 },
  { label: 'Executive', count: 14 },
  { label: 'Automation', count: 13 },
  { label: 'Deals', count: 12 },
  { label: 'Intelligence', count: 11 },
  { label: 'Research', count: 9 },
  { label: 'Marketing', count: 7 },
] as const

export const TRENDING = [
  { name: 'AI Executive Briefing', velocity: '+42% installs' },
  { name: 'Property Intelligence', velocity: '+38% installs' },
  { name: 'Queue Recovery Agent', velocity: '+33% installs' },
  { name: 'Market Command System', velocity: '+28% installs' },
  { name: 'Offer Studio', velocity: '+24% installs' },
] as const

export const RECOMMENDED_FOR_YOU = [
  'Contract Studio',
  'Title Command',
  'Buyer Match',
  'Revenue Command',
  'Street View Coverage',
] as const

export const SYSTEM_ALERTS = [
  { name: 'Gmail needs auth', state: 'warning' as const },
  { name: 'Notion disconnected', state: 'warning' as const },
  { name: 'TextGrid healthy', state: 'healthy' as const },
  { name: 'Supabase synced', state: 'healthy' as const },
  { name: 'Podio connected', state: 'healthy' as const },
] as const

export const HERO_ORBIT_TILES = [
  'Seller Inbox',
  'Queue Recovery Agent',
  'Market Command System',
  'AI Briefing',
  'Offer Studio',
  'Property Intelligence',
  'Contract Studio',
  'TextGrid Health',
] as const

export const COMMAND_DOCK_ITEMS = [
  { label: 'Store', icon: 'ST', active: true },
  { label: 'Spaces', icon: 'SP' },
  { label: 'Inbox', icon: 'IN', badge: 14 },
  { label: 'Pipeline', icon: 'PL' },
  { label: 'AI Ops', icon: 'AO' },
  { label: 'Reports', icon: 'RP' },
  { label: 'Map Intel', icon: 'MI' },
  { label: 'Calendar', icon: 'CA' },
  { label: 'Notes', icon: 'NO' },
  { label: 'Search', icon: 'SE' },
  { label: 'Alerts', icon: 'AL', badge: 7 },
  { label: 'Settings', icon: 'SG' },
] as const

export const APP_EXPOSURES: Record<string, string[]> = {
  'Seller Inbox': ['Hot Replies widget', 'Needs Response widget', 'AI Drafts Ready widget', 'Inbox app', 'Reply Agent'],
  'Send Queue': ['Ready Now widget', 'Awaiting Approval widget', 'Failed Sends widget', 'Send Capacity widget', 'Queue app', 'Queue Recovery Agent'],
  'Market Command System': ['Mini map widget', 'Heat layer', 'Live map app', 'Market pressure widget', 'Street View Explorer'],
  'Offer Studio': ['Offers Ready widget', 'Offer Generator', 'Underwriting card', 'Deal stage tracker'],
}
