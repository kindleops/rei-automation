import type { InboxStatus, SellerStage, AutomationState } from '../../lib/data/inboxWorkflowData'

export interface StatusVisual {
  label: string
  color: string
  bg: string
  border: string
  dot: string
  pulse: string
  description: string
}

export type WorkflowStatusOptionValue = InboxStatus | 'sent_message'

const sentMessageVisual: StatusVisual = {
  label: 'Sent Message',
  color: '#7bc6ff',
  bg: 'rgba(123,198,255,0.14)',
  border: 'rgba(123,198,255,0.38)',
  dot: '#7bc6ff',
  pulse: 'rgba(123,198,255,0.34)',
  description: 'Initial outreach sent and awaiting the first seller response.',
}

export const inboxStatusVisuals: Record<InboxStatus, StatusVisual> = {
  new_reply: {
    label: 'New Reply',
    color: '#0a84ff',
    bg: 'rgba(10,132,255,0.14)',
    border: 'rgba(10,132,255,0.42)',
    dot: '#0a84ff',
    pulse: 'rgba(10,132,255,0.42)',
    description: 'Fresh inbound message ready for triage.',
  },
  needs_review: {
    label: 'Needs Review',
    color: '#ff9f43',
    bg: 'rgba(255,159,67,0.12)',
    border: 'rgba(255,159,67,0.34)',
    dot: '#ff9f43',
    pulse: 'rgba(255,159,67,0.32)',
    description: 'Complexity requires operator review.',
  },
  ai_draft_ready: {
    label: 'Autopilot',
    color: '#a78bfa',
    bg: 'rgba(167,139,250,0.15)',
    border: 'rgba(167,139,250,0.42)',
    dot: '#a78bfa',
    pulse: 'rgba(167,139,250,0.42)',
    description: 'AI draft ready for approval.',
  },
  queued: {
    label: 'Queued',
    color: '#5bb6ff',
    bg: 'rgba(91,182,255,0.14)',
    border: 'rgba(91,182,255,0.4)',
    dot: '#5bb6ff',
    pulse: 'rgba(91,182,255,0.4)',
    description: 'Message scheduled or sending.',
  },
  waiting: {
    label: 'Waiting',
    color: '#ffd60a',
    bg: 'rgba(255,214,10,0.12)',
    border: 'rgba(255,214,10,0.38)',
    dot: '#ffd60a',
    pulse: 'rgba(255,214,10,0.38)',
    description: 'Awaiting seller response.',
  },
  suppressed: {
    label: 'Suppressed',
    color: '#ff6b64',
    bg: 'rgba(255,69,58,0.1)',
    border: 'rgba(255,69,58,0.28)',
    dot: '#ff453a',
    pulse: 'rgba(255,69,58,0.28)',
    description: 'Compliance suppression active.',
  },
  closed: {
    label: 'Dead',
    color: '#7d8797',
    bg: 'rgba(125,135,151,0.1)',
    border: 'rgba(125,135,151,0.24)',
    dot: '#7d8797',
    pulse: 'rgba(125,135,151,0.2)',
    description: 'Thread completed or archived.',
  },
}

export const sellerStageVisuals: Record<SellerStage, StatusVisual> = {
  ownership_check: {
    label: 'Ownership Check',
    color: '#aab3c5',
    bg: 'rgba(170,179,197,0.12)',
    border: 'rgba(170,179,197,0.28)',
    dot: '#aab3c5',
    pulse: 'rgba(170,179,197,0.28)',
    description: 'Verifying property ownership.',
  },
  interest_probe: {
    label: 'Interest Probe',
    color: '#64d2ff',
    bg: 'rgba(100,210,255,0.12)',
    border: 'rgba(100,210,255,0.3)',
    dot: '#64d2ff',
    pulse: 'rgba(100,210,255,0.3)',
    description: 'Gauging interest in selling.',
  },
  seller_response: {
    label: 'Active Communication',
    color: '#0a84ff',
    bg: 'rgba(10,132,255,0.12)',
    border: 'rgba(10,132,255,0.35)',
    dot: '#0a84ff',
    pulse: 'rgba(10,132,255,0.35)',
    description: 'Seller engaged in conversation.',
  },
  price_discovery: {
    label: 'Price Discovery',
    color: '#bf5af2',
    bg: 'rgba(191,90,242,0.12)',
    border: 'rgba(191,90,242,0.35)',
    dot: '#bf5af2',
    pulse: 'rgba(191,90,242,0.35)',
    description: 'Identifying price expectations.',
  },
  condition_details: {
    label: 'Condition / Details',
    color: '#ff9f0a',
    bg: 'rgba(255,159,10,0.12)',
    border: 'rgba(255,159,10,0.35)',
    dot: '#ff9f0a',
    pulse: 'rgba(255,159,10,0.35)',
    description: 'Gathering property details.',
  },
  offer_reveal: {
    label: 'Offer Stage',
    color: '#ff453a',
    bg: 'rgba(255,69,58,0.12)',
    border: 'rgba(255,69,58,0.35)',
    dot: '#ff453a',
    pulse: 'rgba(255,69,58,0.35)',
    description: 'Presenting acquisition offer.',
  },
  negotiation: {
    label: 'Negotiation',
    color: '#ffd60a',
    bg: 'rgba(255,214,10,0.12)',
    border: 'rgba(255,214,10,0.35)',
    dot: '#ffd60a',
    pulse: 'rgba(255,214,10,0.35)',
    description: 'Terms negotiation in progress.',
  },
  contract_path: {
    label: 'Contract Sent',
    color: '#30d158',
    bg: 'rgba(48,209,88,0.12)',
    border: 'rgba(48,209,88,0.35)',
    dot: '#30d158',
    pulse: 'rgba(48,209,88,0.35)',
    description: 'Moving toward executed contract.',
  },
  dead_suppressed: {
    label: 'Dead',
    color: '#7d8797',
    bg: 'rgba(125,135,151,0.12)',
    border: 'rgba(125,135,151,0.3)',
    dot: '#7d8797',
    pulse: 'rgba(125,135,151,0.3)',
    description: 'Lead dead or suppressed.',
  },
}

export const automationStateVisuals: Record<AutomationState, { label: string; color: string }> = {
  active: { label: 'Automation Active', color: '#30d158' },
  paused: { label: 'Automation Paused', color: '#ffd60a' },
  completed: { label: 'Automation Completed', color: '#7d8797' },
  manual_control: { label: 'Manual Control', color: '#ff9f43' },
}

export const inboxStatusOptions = Object.entries(inboxStatusVisuals).map(([value, visual]) => ({
  value: value as InboxStatus,
  ...visual,
}))

export const inboxStatusWorkflowOptions = [
  { value: 'sent_message' as const, ...sentMessageVisual },
  ...inboxStatusOptions,
]

export const sellerStageOptions = Object.entries(sellerStageVisuals).map(([value, visual]) => ({
  value: value as SellerStage,
  ...visual,
}))

const isSentMessageState = (
  status?: string | null,
  options?: { latestDirection?: string | null; lastOutboundAt?: string | null; lastInboundAt?: string | null },
): boolean => {
  const key = (status || 'new_reply') as InboxStatus
  return Boolean(
    key === 'waiting' &&
    options?.latestDirection === 'outbound' &&
    options?.lastOutboundAt &&
    (!options.lastInboundAt || new Date(options.lastOutboundAt).getTime() >= new Date(options.lastInboundAt).getTime()),
  )
}

export const getStatusVisual = (
  status?: string | null,
  options?: { latestDirection?: string | null; lastOutboundAt?: string | null; lastInboundAt?: string | null },
): StatusVisual => {
  const key = (status || 'new_reply') as InboxStatus
  const base = inboxStatusVisuals[key] ?? {
    label: String(status || 'Unknown').replaceAll('_', ' '),
    color: '#94a3b8',
    bg: 'rgba(148,163,184,0.12)',
    border: 'rgba(148,163,184,0.24)',
    dot: '#94a3b8',
    pulse: 'rgba(148,163,184,0.22)',
    description: 'Unknown status.',
  }
  if (isSentMessageState(key, options)) return sentMessageVisual
  return base
}

export const getWorkflowStatusOptionValue = (
  status?: string | null,
  options?: { latestDirection?: string | null; lastOutboundAt?: string | null; lastInboundAt?: string | null },
): WorkflowStatusOptionValue => (isSentMessageState(status, options) ? 'sent_message' : ((status || 'new_reply') as InboxStatus))

const VALID_SELLER_STAGES = new Set<string>([
  'ownership_check', 'interest_probe', 'seller_response', 'price_discovery',
  'condition_details', 'offer_reveal', 'negotiation', 'contract_path',
])

export const getSellerStageVisual = (stage?: string | null): StatusVisual => {
  if (String(stage || '').toLowerCase() === 'closed') {
    return {
      label: 'Closed',
      color: '#7d8797',
      bg: 'rgba(125,135,151,0.12)',
      border: 'rgba(125,135,151,0.3)',
      dot: '#7d8797',
      pulse: 'rgba(125,135,151,0.3)',
      description: 'Conversation workflow completed.',
    }
  }
  const safeKey = VALID_SELLER_STAGES.has(stage ?? '') ? (stage as SellerStage) : 'ownership_check'
  return sellerStageVisuals[safeKey]
}

export const statusStyleVars = (visual: StatusVisual) => ({
  '--status-color': visual.color,
  '--status-bg': visual.bg,
  '--status-border': visual.border,
  '--status-dot': visual.dot,
  '--status-pulse': visual.pulse,
}) as Record<string, string>
