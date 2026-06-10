import type {
  CommandSpaceId,
  CommandStoreCategory,
  CommandStoreItem,
  CommandStoreItemType,
  CommandStoreSpace,
  CommandStoreStatus,
} from './command-store.types'

export const COMMAND_STORE_INSTALL_KEY = 'leadcommand:command-store-installed'
export const COMMAND_STORE_SPACE_ITEMS_KEY = 'leadcommand:command-store-space-items'

export const COMMAND_SPACES: CommandStoreSpace[] = [
  { id: 'executive', name: 'Executive Command', label: 'Executive', description: 'Briefings, forecasting, and decision control.' },
  { id: 'acquisition', name: 'Acquisition Command', label: 'Acquisition', description: 'Seller intake, offer readiness, and response velocity.' },
  { id: 'market-intelligence', name: 'Market Intelligence', label: 'Market Intel', description: 'Maps, comps, pressure layers, and expansion signals.' },
  { id: 'messaging', name: 'Messaging Command', label: 'Messaging', description: 'AI replies, SMS/email delivery, and objection handling.' },
  { id: 'queue', name: 'Queue Command', label: 'Queue', description: 'Send queues, retries, approvals, and suppression logic.' },
  { id: 'deal-execution', name: 'Deal Execution', label: 'Deals', description: 'Offers, contracts, title, and closing movement.' },
  { id: 'dispo', name: 'Dispo Command', label: 'Dispo', description: 'Buyer matching, packages, campaigns, and demand scoring.' },
  { id: 'automation', name: 'Automation Command', label: 'Automation', description: 'Workflow reliability, integrations, and recovery systems.' },
  { id: 'revenue', name: 'Revenue Command', label: 'Revenue', description: 'Pipeline value, assignment fees, pace, and conversion.' },
]

export const COMMAND_STORE_CATEGORIES: Array<{ id: CommandStoreCategory | 'Installed'; label: string; description: string }> = [
  { id: 'Featured', label: 'Featured', description: 'Highest-leverage systems for this command center.' },
  { id: 'Execution Apps', label: 'Execution Apps', description: 'Full command surfaces for daily operations.' },
  { id: 'AI Agents', label: 'AI Agents', description: 'Specialized operators for replies, pricing, title, and recovery.' },
  { id: 'Command Widgets', label: 'Command Widgets', description: 'Bento tiles, KPIs, and live operational modules.' },
  { id: 'Automations', label: 'Automations', description: 'Workflow chains that move work without manual babysitting.' },
  { id: 'Industry Packs', label: 'Industry Packs', description: 'Opinionated systems for vertical-specific execution.' },
  { id: 'Map Layers', label: 'Map Layers', description: 'Market overlays, risk fields, and owner intelligence.' },
  { id: 'Templates', label: 'Templates', description: 'Message, document, and follow-up packs.' },
  { id: 'Reports / Dashboards', label: 'Reports', description: 'Executive dashboards and operational reporting.' },
  { id: 'Integrations', label: 'Integrations', description: 'Connectors for the systems LeadCommand orchestrates.' },
  { id: 'Installed', label: 'Installed', description: 'Everything already active in this workspace.' },
]

const emptyAssets = {
  apps: [] as string[],
  widgets: [] as string[],
  agents: [] as string[],
  automations: [] as string[],
  templates: [] as string[],
  mapLayers: [] as string[],
  reports: [] as string[],
}

const item = (
  input: Omit<CommandStoreItem, 'includedAssets' | 'permissions' | 'dependencies' | 'compatibleWidgets' | 'compatibleAutomations' | 'previewStats' | 'tags'> & {
    includedAssets?: Partial<CommandStoreItem['includedAssets']>
    permissions?: string[]
    dependencies?: string[]
    compatibleWidgets?: string[]
    compatibleAutomations?: string[]
    previewStats?: Array<{ label: string; value: string }>
    tags?: string[]
  },
): CommandStoreItem => ({
  ...input,
  includedAssets: { ...emptyAssets, ...input.includedAssets },
  permissions: input.permissions ?? ['Read workspace activity', 'Write layout changes'],
  dependencies: input.dependencies ?? ['NEXUS workspace'],
  compatibleWidgets: input.compatibleWidgets ?? [],
  compatibleAutomations: input.compatibleAutomations ?? [],
  previewStats: input.previewStats ?? [
    { label: 'Setup', value: input.setupTime },
    { label: 'Usage', value: input.popularity },
  ],
  tags: input.tags ?? [input.category, input.type],
})

const mkSimple = (
  id: string,
  name: string,
  category: CommandStoreCategory,
  type: CommandStoreItemType,
  accent: string,
  spaces: CommandSpaceId[],
  status: CommandStoreStatus = 'available',
): CommandStoreItem =>
  item({
    id,
    name,
    category,
    type,
    icon: name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
    accent,
    status,
    popularity: 'Operator-ready',
    setupTime: type === 'integration' ? '8 min' : '2 min',
    description: `${name} installs a focused ${category.toLowerCase()} module into the selected Command Space.`,
    longDescription: `${name} is packaged as a production-style command module with mock install state, destination routing, compatible widgets, and recommended operating spaces. It is designed to make LeadCommand feel like an AI execution OS instead of a static CRM.`,
    recommendedSpaces: spaces,
    includedAssets: {
      apps: type === 'app' ? [name] : [],
      widgets: type === 'widget' ? [name] : [],
      agents: type === 'agent' ? [name] : [],
      automations: type === 'automation' ? [name] : [],
      templates: type === 'template' ? [name] : [],
      mapLayers: type === 'map-layer' ? [name] : [],
      reports: type === 'report' ? [name] : [],
    },
    permissions: type === 'integration' ? ['OAuth connection', 'Read/write sync status', 'Webhook events'] : undefined,
    dependencies: type === 'integration' ? ['Provider account', 'NEXUS workspace'] : undefined,
    tags: [category, type, ...spaces],
  })

export const COMMAND_STORE_ITEMS: CommandStoreItem[] = [
  item({
    id: 'real-estate-acquisitions-pack',
    name: 'Real Estate Acquisitions Pack',
    category: 'Featured',
    type: 'pack',
    icon: 'RA',
    accent: '#3ecf8e',
    status: 'installed',
    popularity: 'Core system',
    setupTime: '6 min',
    description: 'A full operating system for acquisitions: inbox, queue, offer studio, dossier, and AI review loops.',
    longDescription: 'The Real Estate Acquisitions Pack gives operators a complete execution layer for seller intake, reply triage, offer readiness, lead scoring, and automated handoff into deal execution.',
    recommendedSpaces: ['executive', 'acquisition', 'messaging', 'queue'],
    includedAssets: {
      apps: ['Seller Inbox', 'Send Queue', 'Offer Studio', 'Seller Dossier'],
      widgets: ['Hot Replies', 'Ready Now', 'Offer Approval', 'Pipeline Value'],
      agents: ['Acquisition Agent', 'Seller Reply Agent', 'Offer Builder Agent'],
      automations: ['Hot Reply to AI Draft', 'Seller Asking Price to Offer Studio'],
      templates: ['Seller SMS Core Pack', 'Objection Handling Pack'],
      reports: ['Acquisition Warboard', 'Message Deliverability'],
    },
    permissions: ['Read seller records', 'Write queue actions', 'Generate offer drafts', 'Update command layouts'],
    dependencies: ['Seller Inbox', 'TextGrid', 'Dossier'],
    compatibleWidgets: ['Hot Replies', 'Ready Now', 'Failed Sends', 'Pipeline Value'],
    compatibleAutomations: ['Hot Reply to AI Draft', 'No Reply Smart Follow-Up'],
    previewStats: [
      { label: 'Assets', value: '19' },
      { label: 'Setup', value: '6 min' },
      { label: 'Spaces', value: '4' },
    ],
    tags: ['real estate', 'acquisition', 'featured', 'seller'],
  }),
  item({
    id: 'queue-recovery-agent',
    name: 'Queue Recovery Agent',
    category: 'Featured',
    type: 'agent',
    icon: 'QR',
    accent: '#f5b849',
    status: 'beta',
    popularity: 'High impact',
    setupTime: '3 min',
    description: 'Autonomously classifies failed sends, retries recoverable messages, and locks unsafe records.',
    longDescription: 'Queue Recovery Agent is a focused reliability operator for SMS and email execution. It inspects carrier failures, retry windows, opt-out risk, and provider pressure before recommending or executing recovery paths.',
    recommendedSpaces: ['queue', 'automation', 'messaging'],
    includedAssets: {
      widgets: ['Failed Sends', 'Queue Pressure', 'TextGrid Health'],
      agents: ['Queue Recovery Agent'],
      automations: ['Failed SMS Retry Ladder', 'Opt-Out Compliance Lock'],
      reports: ['Queue Health'],
    },
    permissions: ['Read send queue', 'Write retry actions', 'Read opt-out flags'],
    dependencies: ['TextGrid', 'Send Queue'],
    compatibleWidgets: ['Failed Sends', 'Queue Pressure', 'Opt-Out Risk'],
    compatibleAutomations: ['Failed SMS Retry Ladder', 'Wrong Number Suppression Flow'],
    tags: ['queue', 'recovery', 'agent', 'featured'],
  }),
  item({
    id: 'market-command-system',
    name: 'Market Command System',
    category: 'Featured',
    type: 'app',
    icon: 'MC',
    accent: '#38bdf8',
    status: 'installed',
    popularity: 'Live map native',
    setupTime: '4 min',
    description: 'Combines MapLibre intelligence, pressure layers, lead pulses, comp radius, and Street View context.',
    longDescription: 'Market Command System turns the live map into a decision surface with market pressure, lead heat, street-level context, comp updates, and portfolio-density overlays.',
    recommendedSpaces: ['market-intelligence', 'executive', 'acquisition'],
    includedAssets: {
      apps: ['Market Map', 'Street View Explorer', 'Comp Radius'],
      widgets: ['Market Heat', 'Street View Snapshot', 'Comp Spread'],
      mapLayers: ['Heat Map Layer', 'Lead Pulse Layer', 'Street View Layer', 'Comp Radius Layer'],
      automations: ['Street View Snapshot to Dossier', 'Comp Radius Updated to Offer Recalc'],
      reports: ['Market Performance'],
    },
    permissions: ['Read lead coordinates', 'Read market overlays', 'Write map layer preferences'],
    dependencies: ['MapLibre', 'Google Maps optional'],
    compatibleWidgets: ['Market Heat', 'Street View Snapshot', 'Comp Spread'],
    compatibleAutomations: ['Street View Snapshot to Dossier', 'Market Pressure Alert'],
    tags: ['map', 'market intelligence', 'street view', 'featured'],
  }),
  item({
    id: 'ceo-daily-briefing',
    name: 'CEO Daily Briefing',
    category: 'Featured',
    type: 'report',
    icon: 'CB',
    accent: '#9f8dff',
    status: 'available',
    popularity: 'Executive favorite',
    setupTime: '2 min',
    description: 'A daily executive intelligence layer for pipeline, queue health, risk, revenue, and recommended actions.',
    longDescription: 'CEO Daily Briefing summarizes the business into a fast, opinionated operating readout: cash conversion, acquisition risk, automation reliability, and the few actions that deserve executive attention.',
    recommendedSpaces: ['executive', 'revenue', 'automation'],
    includedAssets: {
      widgets: ['Pipeline Value', 'Revenue Pace', 'Deals At Risk'],
      agents: ['Executive Briefing Agent'],
      reports: ['CEO Daily Briefing', 'Revenue Forecast', 'Automation Reliability'],
      automations: ['Daily CEO Briefing', 'Revenue Forecast Update'],
    },
    compatibleWidgets: ['Pipeline Value', 'Revenue Pace', 'Closing Forecast'],
    compatibleAutomations: ['Daily CEO Briefing', 'Revenue Forecast Update'],
    tags: ['executive', 'briefing', 'revenue', 'featured'],
  }),

  ...[
    'Seller Inbox',
    'Send Queue',
    'Seller Dossier',
    'Property Intelligence',
    'Offer Studio',
    'Contract Studio',
    'Title Command',
    'Closing Tracker',
    'Buyer Match',
    'Dispo Campaigns',
    'Revenue Command',
    'Automation Health',
    'Market Map',
    'Street View Explorer',
    'Comp Radius',
    'AI Call Review',
    'Lead Scoring Lab',
    'Follow-Up Planner',
  ].map((name) =>
    mkSimple(
      `app-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'Execution Apps',
      'app',
      name.includes('Map') || name.includes('Street') || name.includes('Comp') ? '#38bdf8' : '#3ecf8e',
      name.includes('Buyer') || name.includes('Dispo')
        ? ['dispo', 'deal-execution']
        : name.includes('Title') || name.includes('Contract') || name.includes('Closing')
          ? ['deal-execution', 'revenue']
          : name.includes('Market') || name.includes('Street') || name.includes('Comp')
            ? ['market-intelligence', 'acquisition']
            : ['acquisition', 'messaging'],
      ['Seller Inbox', 'Send Queue', 'Property Intelligence', 'Market Map', 'Automation Health'].includes(name) ? 'installed' : 'available',
    ),
  ),

  ...[
    'Acquisition Agent',
    'Seller Reply Agent',
    'Offer Builder Agent',
    'Pricing Justification Agent',
    'Objection Handler',
    'Follow-Up Agent',
    'Title Coordinator',
    'Buyer Match Agent',
    'Dispo Copywriter',
    'Compliance Monitor',
    'Data Hygiene Agent',
    'Executive Briefing Agent',
    'Market Analyst',
    'Spanish Seller Agent',
    'Probate Specialist',
    'Creative Finance Agent',
  ].map((name) =>
    mkSimple(
      `agent-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'AI Agents',
      'agent',
      name.includes('Title') ? '#f5b849' : name.includes('Buyer') || name.includes('Dispo') ? '#9f8dff' : '#38bdf8',
      name.includes('Executive') ? ['executive'] : name.includes('Market') ? ['market-intelligence'] : name.includes('Title') ? ['deal-execution'] : ['acquisition', 'messaging'],
      ['Seller Reply Agent', 'Objection Handler', 'Follow-Up Agent'].includes(name) ? 'installed' : 'available',
    ),
  ),

  ...[
    'Hot Replies',
    'Ready Now',
    'Failed Sends',
    'Queue Pressure',
    'Market Heat',
    'Offer Approval',
    'Title Blockers',
    'Pipeline Value',
    'AI Confidence',
    'Negative Reply Rate',
    'Opt-Out Risk',
    'TextGrid Health',
    'Podio Sync',
    'Supabase Sync',
    'Buyer Demand',
    'Closing Forecast',
    'Revenue Pace',
    'Daily Win Counter',
    'Deals At Risk',
    'Agent Performance',
    'Best Contact Window',
    'Street View Snapshot',
    'Comp Spread',
    'Portfolio Owner Radar',
    'High Equity Owners',
    'Probate Queue',
    'Tax Delinquent Watch',
    'Vacancy Signals',
    'Corporate Owner Feed',
  ].map((name) =>
    mkSimple(
      `widget-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'Command Widgets',
      'widget',
      name.includes('Market') || name.includes('Street') || name.includes('Comp') ? '#38bdf8' : name.includes('Revenue') || name.includes('Pipeline') ? '#3ecf8e' : '#f5b849',
      name.includes('Buyer') ? ['dispo'] : name.includes('Market') || name.includes('Street') || name.includes('Comp') ? ['market-intelligence'] : name.includes('Revenue') || name.includes('Pipeline') ? ['revenue', 'executive'] : ['acquisition', 'queue'],
      ['Hot Replies', 'Ready Now', 'Failed Sends', 'Market Heat', 'Pipeline Value'].includes(name) ? 'installed' : 'available',
    ),
  ),

  ...[
    'Hot Reply to AI Draft',
    'Failed SMS Retry Ladder',
    'Seller Asking Price to Offer Studio',
    'Offer Accepted to Contract Studio',
    'Contract Signed to Title Command',
    'Buyer Interested to Dispo Follow-Up',
    'No Reply Smart Follow-Up',
    'Wrong Number Suppression Flow',
    'Opt-Out Compliance Lock',
    'High Equity Owner Priority Queue',
    'Probate Lead Specialist Agent',
    'Corporate Owner Custom Outreach',
    'Title Blocker Escalation',
    'Daily CEO Briefing',
    'Market Pressure Alert',
    'Revenue Forecast Update',
    'Street View Snapshot to Dossier',
    'Comp Radius Updated to Offer Recalc',
  ].map((name) =>
    mkSimple(
      `automation-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'Automations',
      'automation',
      name.includes('Street') || name.includes('Market') || name.includes('Comp') ? '#38bdf8' : '#f28ca8',
      name.includes('CEO') || name.includes('Revenue') ? ['executive', 'revenue'] : name.includes('Title') || name.includes('Contract') ? ['deal-execution'] : name.includes('Street') || name.includes('Market') || name.includes('Comp') ? ['market-intelligence', 'acquisition'] : ['messaging', 'queue'],
      name.includes('Opt-Out') ? 'installed' : 'available',
    ),
  ),

  ...[
    'Wholesale Real Estate Pack',
    'Dispo / Buyer Pack',
    'Property Management Pack',
    'Home Services Pack',
    'Roofing Sales Pack',
    'Solar Sales Pack',
    'Insurance Sales Pack',
    'Med Spa Follow-Up Pack',
    'Legal Intake Pack',
    'Recruiting Pack',
    'Agency Sales Pack',
    'B2B Appointment Setting Pack',
    'Private Equity Deal Sourcing Pack',
    'Collections / Recovery Pack',
  ].map((name) =>
    mkSimple(
      `pack-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'Industry Packs',
      'pack',
      '#9f8dff',
      name.includes('Buyer') ? ['dispo'] : name.includes('Recovery') ? ['queue', 'automation'] : ['acquisition', 'messaging', 'revenue'],
      'available',
    ),
  ),

  ...[
    'Heat Map Layer',
    'Lead Pulse Layer',
    'Distress Layer',
    'Equity Layer',
    'Probate Layer',
    'Vacancy Layer',
    'Tax Delinquency Layer',
    'Foreclosure Layer',
    'Corporate Owner Layer',
    'Buyer Demand Layer',
    'Rent Growth Layer',
    'Flood Risk Layer',
    'Wind Risk Layer',
    'Fire Risk Layer',
    'Opportunity Zones',
    'Street View Layer',
    'Comp Radius Layer',
    'Portfolio Density Layer',
    'Queue Pressure Layer',
    'Contact Window Layer',
  ].map((name) =>
    mkSimple(
      `layer-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'Map Layers',
      'map-layer',
      name.includes('Risk') ? '#f87171' : '#38bdf8',
      ['market-intelligence', 'acquisition'],
      ['Heat Map Layer', 'Lead Pulse Layer'].includes(name) ? 'installed' : 'available',
    ),
  ),

  ...[
    'Seller SMS Core Pack',
    'Spanish Seller SMS Pack',
    'Probate Follow-Up Pack',
    'Corporate Owner Outreach Pack',
    'Tax Delinquent Pack',
    'Tired Landlord Pack',
    'Buyer Blast Pack',
    'JV Partner Pack',
    'Title Follow-Up Pack',
    'Contract Reminder Pack',
    'Closing Update Pack',
    'Cold Email Pack',
    'Compliance Safe Replies',
    'Objection Handling Pack',
    'Creative Finance Pack',
  ].map((name) =>
    mkSimple(
      `template-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'Templates',
      'template',
      '#f5b849',
      name.includes('Buyer') ? ['dispo'] : name.includes('Title') || name.includes('Contract') || name.includes('Closing') ? ['deal-execution'] : ['messaging', 'acquisition'],
      ['Seller SMS Core Pack', 'Objection Handling Pack'].includes(name) ? 'installed' : 'available',
    ),
  ),

  ...[
    'Acquisition Warboard',
    'Market Performance',
    'Agent Performance',
    'Queue Health',
    'Message Deliverability',
    'Revenue Forecast',
    'Title Pipeline',
    'Buyer Demand',
    'Campaign ROI',
    'Opt-Out Risk',
    'Close Probability',
    'Automation Reliability',
    'Sync Health',
    'Deal Velocity',
    'Cash Conversion Funnel',
  ].map((name) =>
    mkSimple(
      `report-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'Reports / Dashboards',
      'report',
      name.includes('Revenue') || name.includes('Cash') ? '#3ecf8e' : '#38bdf8',
      name.includes('Revenue') || name.includes('Cash') ? ['revenue', 'executive'] : name.includes('Market') ? ['market-intelligence'] : name.includes('Buyer') ? ['dispo'] : ['executive', 'automation'],
      'available',
    ),
  ),

  ...[
    ['Podio', 'connected'],
    ['Supabase', 'connected'],
    ['TextGrid', 'connected'],
    ['Gmail', 'needs_auth'],
    ['Google Calendar', 'connected'],
    ['Vercel', 'connected'],
    ['PostHog', 'disconnected'],
    ['Notion', 'disconnected'],
    ['Airtable', 'needs_auth'],
    ['DocuSign / SignPro', 'disconnected'],
    ['Stripe', 'connected'],
    ['DealMachine', 'needs_auth'],
    ['Google Maps', 'needs_auth'],
    ['Mapillary', 'available'],
    ['Twilio', 'available'],
    ['Slack', 'available'],
    ['Zapier / Make', 'available'],
    ['OpenAI', 'connected'],
    ['Anthropic', 'available'],
    ['ElevenLabs', 'available'],
    ['GoHighLevel', 'available'],
    ['HubSpot', 'available'],
    ['Salesforce', 'available'],
  ].map(([name, status]) =>
    mkSimple(
      `integration-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      'Integrations',
      'integration',
      status === 'connected' ? '#3ecf8e' : status === 'needs_auth' ? '#f5b849' : '#8ca0b4',
      ['automation', 'executive'],
      status as CommandStoreStatus,
    ),
  ),
]

export const getInstallSet = (): Set<string> => {
  if (typeof window === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMMAND_STORE_INSTALL_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export const saveInstallSet = (ids: Set<string>) => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(COMMAND_STORE_INSTALL_KEY, JSON.stringify(Array.from(ids)))
}

export const getResolvedStatus = (item: CommandStoreItem, installedIds: Set<string>): CommandStoreStatus => {
  if (installedIds.has(item.id)) return item.type === 'integration' ? 'connected' : 'installed'
  return item.status
}

export const isInstalledStatus = (status: CommandStoreStatus) =>
  status === 'installed' || status === 'connected'

export const addStoreItemToSpace = (itemId: string, spaceId: CommandSpaceId) => {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(COMMAND_STORE_SPACE_ITEMS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    const bySpace = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, string[]> : {}
    const current = Array.isArray(bySpace[spaceId]) ? bySpace[spaceId] : []
    if (!current.includes(itemId)) {
      bySpace[spaceId] = [...current, itemId]
      window.localStorage.setItem(COMMAND_STORE_SPACE_ITEMS_KEY, JSON.stringify(bySpace))
    }
  } catch {
    // local mock state only
  }
}
