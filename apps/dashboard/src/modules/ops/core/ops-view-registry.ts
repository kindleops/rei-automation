export const OPS_VIEW_IDS = [
  'inbox',
  'conversation',
  'deal_intelligence',
  'comp_intelligence',
  'buyer_match',
  'queue',
  'pipeline',
  'calendar',
  'map',
  'analytics',
  'closing_desk',
  'campaign_command',
  'email_command',
  'workflow_studio',
] as const

export type OpsViewId = typeof OPS_VIEW_IDS[number]

export type OpsViewSlot = 'left' | 'main' | 'right' | 'focus' | 'overlay'

export interface OpsViewDefinition {
  id: OpsViewId
  label: string
  shortLabel: string
  description: string
  defaultSlot: OpsViewSlot
  allowFullscreen: boolean
  allowSidePanel: boolean
}

export const OPS_VIEW_REGISTRY: Record<OpsViewId, OpsViewDefinition> = {
  inbox: {
    id: 'inbox',
    label: 'Inbox',
    shortLabel: 'Inbox',
    description: 'Seller inbox rail and triage controls.',
    defaultSlot: 'left',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  conversation: {
    id: 'conversation',
    label: 'Conversation',
    shortLabel: 'Conversation',
    description: 'Active seller thread and composer.',
    defaultSlot: 'main',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  deal_intelligence: {
    id: 'deal_intelligence',
    label: 'Deal Intelligence',
    shortLabel: 'Deal Intel',
    description: 'Seller and property intelligence panel.',
    defaultSlot: 'right',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  comp_intelligence: {
    id: 'comp_intelligence',
    label: 'Comp Intelligence',
    shortLabel: 'Comps',
    description: 'Comps, ARV, underwriting, and offer structure.',
    defaultSlot: 'right',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  buyer_match: {
    id: 'buyer_match',
    label: 'Buyer Match',
    shortLabel: 'Buyers',
    description: 'Buyer fit, demand score, and dispo matching.',
    defaultSlot: 'right',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  queue: {
    id: 'queue',
    label: 'Queue',
    shortLabel: 'Queue',
    description: 'Queue execution and delivery status.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  pipeline: {
    id: 'pipeline',
    label: 'Pipeline',
    shortLabel: 'Pipeline',
    description: 'Stage flow and deal movement.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    shortLabel: 'Calendar',
    description: 'Follow-up schedule and event timeline.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  map: {
    id: 'map',
    label: 'Map',
    shortLabel: 'Map',
    description: 'Command map for market and routing context.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  analytics: {
    id: 'analytics',
    label: 'Analytics',
    shortLabel: 'Analytics',
    description: 'Operational KPI and analytics modules.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  closing_desk: {
    id: 'closing_desk',
    label: 'Closing Desk',
    shortLabel: 'Closing',
    description: 'Offers, contracts, title, escrow, and signatures.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  campaign_command: {
    id: 'campaign_command',
    label: 'Campaign Command',
    shortLabel: 'Campaigns',
    description: 'SMS campaign intelligence, targets, and send performance.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  email_command: {
    id: 'email_command',
    label: 'Email Command',
    shortLabel: 'Email',
    description: 'Brevo email records, inbox, composer, templates, and provider health.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
  workflow_studio: {
    id: 'workflow_studio',
    label: 'Workflow Studio',
    shortLabel: 'Workflows',
    description: 'Workflow definitions, template variants, sender pools, and dry-run previews.',
    defaultSlot: 'focus',
    allowFullscreen: true,
    allowSidePanel: true,
  },
}

export const isOpsViewId = (value: unknown): value is OpsViewId => {
  return typeof value === 'string' && OPS_VIEW_IDS.includes(value as OpsViewId)
}

export const normalizeOpsViewId = (value: unknown, fallback: OpsViewId = 'inbox'): OpsViewId => {
  return isOpsViewId(value) ? value : fallback
}