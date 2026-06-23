export const CANONICAL_VIEW_IDS = [
  'inbox',
  'conversation',
  'deal-intelligence',
  'comp-intelligence',
  'buyer-match',
  'queue',
  'pipeline',
  'calendar',
  'map',
  'analytics',
  'closing-desk',
  'campaign-command',
  'email-command',
  'workflow-studio',
] as const

export type CanonicalViewId = (typeof CANONICAL_VIEW_IDS)[number]

export interface CanonicalViewMeta {
  id: CanonicalViewId
  label: string
  route: string
  folder: string
}

export const CANONICAL_VIEWS: Record<CanonicalViewId, CanonicalViewMeta> = {
  inbox: {
    id: 'inbox',
    label: 'Inbox',
    route: '/inbox',
    folder: 'views/inbox',
  },
  conversation: {
    id: 'conversation',
    label: 'Conversation',
    route: '/conversation',
    folder: 'views/conversation',
  },
  'deal-intelligence': {
    id: 'deal-intelligence',
    label: 'Deal Intelligence',
    route: '/deal-intelligence',
    folder: 'views/deal-intelligence',
  },
  'comp-intelligence': {
    id: 'comp-intelligence',
    label: 'Comp Intelligence',
    route: '/comp-intelligence',
    folder: 'views/comp-intelligence',
  },
  'buyer-match': {
    id: 'buyer-match',
    label: 'Buyer Match',
    route: '/buyer-match',
    folder: 'views/buyer-match',
  },
  queue: {
    id: 'queue',
    label: 'Queue',
    route: '/queue',
    folder: 'views/queue',
  },
  pipeline: {
    id: 'pipeline',
    label: 'Pipeline',
    route: '/pipeline',
    folder: 'views/pipeline',
  },
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    route: '/calendar',
    folder: 'views/calendar',
  },
  map: {
    id: 'map',
    label: 'Map',
    route: '/map',
    folder: 'views/map',
  },
  analytics: {
    id: 'analytics',
    label: 'Analytics',
    route: '/analytics',
    folder: 'views/analytics',
  },
  'closing-desk': {
    id: 'closing-desk',
    label: 'Closing Desk',
    route: '/closing-desk',
    folder: 'views/closing-desk',
  },
  'campaign-command': {
    id: 'campaign-command',
    label: 'Campaign Command',
    route: '/campaign-command',
    folder: 'views/campaign-command',
  },
  'email-command': {
    id: 'email-command',
    label: 'Email Command',
    route: '/email-command',
    folder: 'views/email-command',
  },
  'workflow-studio': {
    id: 'workflow-studio',
    label: 'Workflow Studio',
    route: '/workflow-studio',
    folder: 'views/workflow-studio',
  },
}