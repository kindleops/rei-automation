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

  // ── Multifamily Stages (DealMachine MF Comp Mode) ────────────────────
  mf_ownership_check: {
    label: 'MF Ownership Check',
    color: '#aab3c5', bg: 'rgba(170,179,197,0.12)', border: 'rgba(170,179,197,0.28)', dot: '#aab3c5', pulse: 'rgba(170,179,197,0.28)',
    description: 'Verifying multifamily property ownership.',
  },
  mf_interested: {
    label: 'MF Interested',
    color: '#64d2ff', bg: 'rgba(100,210,255,0.12)', border: 'rgba(100,210,255,0.3)', dot: '#64d2ff', pulse: 'rgba(100,210,255,0.3)',
    description: 'Multifamily owner expressed interest.',
  },
  mf_units_confirmed: {
    label: 'MF Units Confirmed',
    color: '#0a84ff', bg: 'rgba(10,132,255,0.12)', border: 'rgba(10,132,255,0.35)', dot: '#0a84ff', pulse: 'rgba(10,132,255,0.35)',
    description: 'Number of units verified with owner.',
  },
  mf_occupancy_requested: {
    label: 'MF Occupancy Requested',
    color: '#bf5af2', bg: 'rgba(191,90,242,0.12)', border: 'rgba(191,90,242,0.35)', dot: '#bf5af2', pulse: 'rgba(191,90,242,0.35)',
    description: 'Awaiting occupancy data from owner.',
  },
  mf_rent_roll_requested: {
    label: 'MF Rent Roll Requested',
    color: '#ff9f0a', bg: 'rgba(255,159,10,0.12)', border: 'rgba(255,159,10,0.35)', dot: '#ff9f0a', pulse: 'rgba(255,159,10,0.35)',
    description: 'Awaiting rent roll documentation.',
  },
  mf_gross_rents_requested: {
    label: 'MF Gross Rents Requested',
    color: '#ffd60a', bg: 'rgba(255,214,10,0.12)', border: 'rgba(255,214,10,0.35)', dot: '#ffd60a', pulse: 'rgba(255,214,10,0.35)',
    description: 'Awaiting gross rent figures.',
  },
  mf_asking_price_requested: {
    label: 'MF Asking Price Requested',
    color: '#ff453a', bg: 'rgba(255,69,58,0.12)', border: 'rgba(255,69,58,0.35)', dot: '#ff453a', pulse: 'rgba(255,69,58,0.35)',
    description: 'Awaiting owner price expectations.',
  },
  mf_underwriting_needed: {
    label: 'MF Underwriting Needed',
    color: '#30d158', bg: 'rgba(48,209,88,0.12)', border: 'rgba(48,209,88,0.35)', dot: '#30d158', pulse: 'rgba(48,209,88,0.35)',
    description: 'Income data collected; needs underwriting.',
  },
  mf_offer_needed: {
    label: 'MF Offer Needed',
    color: '#34c759', bg: 'rgba(52,199,89,0.14)', border: 'rgba(52,199,89,0.36)', dot: '#34c759', pulse: 'rgba(52,199,89,0.36)',
    description: 'Underwriting complete; offer needs preparation.',
  },
  mf_offer_sent: {
    label: 'MF Offer Sent',
    color: '#007aff', bg: 'rgba(0,122,255,0.12)', border: 'rgba(0,122,255,0.32)', dot: '#007aff', pulse: 'rgba(0,122,255,0.32)',
    description: 'Multifamily offer delivered to owner.',
  },
  mf_negotiation: {
    label: 'MF Negotiation',
    color: '#ff9f43', bg: 'rgba(255,159,67,0.12)', border: 'rgba(255,159,67,0.34)', dot: '#ff9f43', pulse: 'rgba(255,159,67,0.32)',
    description: 'Negotiating multifamily terms.',
  },
  mf_contract_requested: {
    label: 'MF Contract Requested',
    color: '#ff3b30', bg: 'rgba(255,59,48,0.14)', border: 'rgba(255,59,48,0.36)', dot: '#ff3b30', pulse: 'rgba(255,59,48,0.36)',
    description: 'Owner agreed; contract needed.',
  },
  mf_dead: {
    label: 'MF Dead',
    color: '#7d8797', bg: 'rgba(125,135,151,0.1)', border: 'rgba(125,135,151,0.24)', dot: '#7d8797', pulse: 'rgba(125,135,151,0.2)',
    description: 'Multifamily lead is dead.',
  },
  mf_suppressed: {
    label: 'MF Suppressed',
    color: '#ff6b64', bg: 'rgba(255,107,100,0.1)', border: 'rgba(255,107,100,0.28)', dot: '#ff453a', pulse: 'rgba(255,107,100,0.28)',
    description: 'Multifamily lead suppressed.',
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
  'mf_ownership_check', 'mf_interested', 'mf_units_confirmed', 'mf_occupancy_requested',
  'mf_rent_roll_requested', 'mf_gross_rents_requested', 'mf_asking_price_requested',
  'mf_underwriting_needed', 'mf_offer_needed', 'mf_offer_sent', 'mf_negotiation',
  'mf_contract_requested', 'mf_dead', 'mf_suppressed',
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

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL THREAD STATE MODEL
// Status = operational communication/deal state
// Stage  = seller conversation progression (S1–S8)
// Temperature = lead quality/urgency (never use Hot/Warm/Cold for status)
// Autopilot = automation mode
// Compliance = legal/regulatory state
// ─────────────────────────────────────────────────────────────────────────────

export type ThreadStatus =
  | 'new_reply'
  | 'active_communication'
  | 'waiting'
  | 'follow_up'
  | 'offer_sent'
  | 'contract_sent'
  | 'under_contract'
  | 'closed'

export type ThreadStage =
  | 's1_ownership'
  | 's2_interest'
  | 's3_pricing'
  | 's4_condition'
  | 's5_offer'
  | 's6_negotiation'
  | 's7_follow_up'
  | 's8_closing'

export type ThreadTemperature = 'hot' | 'warm' | 'cold' | 'dead'

export type AutopilotMode = 'autopilot_on' | 'autopilot_paused' | 'manual_only'

export type ComplianceState = 'normal' | 'dnc' | 'wrong_number' | 'suppressed' | 'legal_risk'

export interface PillVisual {
  label: string
  shortLabel?: string
  color: string
  bg: string
  border: string
}

export const threadStatusVisuals: Record<ThreadStatus, PillVisual> = {
  new_reply:             { label: 'New Reply',            color: '#0a84ff', bg: 'rgba(10,132,255,0.14)',   border: 'rgba(10,132,255,0.38)' },
  active_communication:  { label: 'Active Communication', color: '#30d158', bg: 'rgba(48,209,88,0.12)',    border: 'rgba(48,209,88,0.32)' },
  waiting:               { label: 'Waiting',              color: '#ffd60a', bg: 'rgba(255,214,10,0.12)',   border: 'rgba(255,214,10,0.34)' },
  follow_up:             { label: 'Follow Up',            color: '#ff9f43', bg: 'rgba(255,159,67,0.12)',   border: 'rgba(255,159,67,0.34)' },
  offer_sent:            { label: 'Offer Sent',           color: '#bf5af2', bg: 'rgba(191,90,242,0.12)',   border: 'rgba(191,90,242,0.34)' },
  contract_sent:         { label: 'Contract Sent',        color: '#ff9f0a', bg: 'rgba(255,159,10,0.12)',   border: 'rgba(255,159,10,0.34)' },
  under_contract:        { label: 'Under Contract',       color: '#34c759', bg: 'rgba(52,199,89,0.14)',    border: 'rgba(52,199,89,0.36)' },
  closed:                { label: 'Closed',               color: '#7d8797', bg: 'rgba(125,135,151,0.1)',   border: 'rgba(125,135,151,0.24)' },
}

export const threadStageVisuals: Record<ThreadStage, PillVisual> = {
  s1_ownership:   { label: 'S1 Ownership Check', shortLabel: 'S1', color: '#aab3c5', bg: 'rgba(170,179,197,0.1)',  border: 'rgba(170,179,197,0.26)' },
  s2_interest:    { label: 'S2 Interest Probe',  shortLabel: 'S2', color: '#64d2ff', bg: 'rgba(100,210,255,0.1)',  border: 'rgba(100,210,255,0.28)' },
  s3_pricing:     { label: 'S3 Pricing',         shortLabel: 'S3', color: '#bf5af2', bg: 'rgba(191,90,242,0.1)',   border: 'rgba(191,90,242,0.28)' },
  s4_condition:   { label: 'S4 Condition',       shortLabel: 'S4', color: '#ff9f0a', bg: 'rgba(255,159,10,0.1)',   border: 'rgba(255,159,10,0.28)' },
  s5_offer:       { label: 'S5 Offer',           shortLabel: 'S5', color: '#ff453a', bg: 'rgba(255,69,58,0.1)',    border: 'rgba(255,69,58,0.28)' },
  s6_negotiation: { label: 'S6 Negotiation',     shortLabel: 'S6', color: '#ffd60a', bg: 'rgba(255,214,10,0.1)',   border: 'rgba(255,214,10,0.28)' },
  s7_follow_up:   { label: 'S7 Follow Up',       shortLabel: 'S7', color: '#ff9f43', bg: 'rgba(255,159,67,0.1)',   border: 'rgba(255,159,67,0.28)' },
  s8_closing:     { label: 'S8 Closing',         shortLabel: 'S8', color: '#30d158', bg: 'rgba(48,209,88,0.12)',   border: 'rgba(48,209,88,0.3)' },
}

export const threadTemperatureVisuals: Record<ThreadTemperature, PillVisual> = {
  hot:  { label: 'Hot',  color: '#ff6b35', bg: 'rgba(255,107,53,0.14)',  border: 'rgba(255,107,53,0.36)' },
  warm: { label: 'Warm', color: '#ff9f43', bg: 'rgba(255,159,67,0.12)',  border: 'rgba(255,159,67,0.32)' },
  cold: { label: 'Cold', color: '#64d2ff', bg: 'rgba(100,210,255,0.1)',  border: 'rgba(100,210,255,0.26)' },
  dead: { label: 'Dead', color: '#7d8797', bg: 'rgba(125,135,151,0.08)', border: 'rgba(125,135,151,0.2)' },
}

export const autopilotModeVisuals: Record<AutopilotMode, PillVisual> = {
  autopilot_on:     { label: 'Autopilot On',     color: '#a78bfa', bg: 'rgba(167,139,250,0.14)', border: 'rgba(167,139,250,0.36)' },
  autopilot_paused: { label: 'Autopilot Paused', color: '#ffd60a', bg: 'rgba(255,214,10,0.12)',  border: 'rgba(255,214,10,0.32)' },
  manual_only:      { label: 'Manual Only',      color: '#9ba8c0', bg: 'rgba(155,168,192,0.1)',  border: 'rgba(155,168,192,0.24)' },
}

export const complianceStateVisuals: Record<ComplianceState, PillVisual> = {
  normal:       { label: 'Normal',       color: '#9ba8c0', bg: 'rgba(155,168,192,0.08)', border: 'rgba(155,168,192,0.2)' },
  dnc:          { label: 'DNC',          color: '#ff453a', bg: 'rgba(255,69,58,0.12)',   border: 'rgba(255,69,58,0.32)' },
  wrong_number: { label: 'Wrong Number', color: '#ff9f43', bg: 'rgba(255,159,67,0.12)',  border: 'rgba(255,159,67,0.3)' },
  suppressed:   { label: 'Suppressed',   color: '#ff6b64', bg: 'rgba(255,107,100,0.1)', border: 'rgba(255,107,100,0.28)' },
  legal_risk:   { label: 'Legal Risk',   color: '#ff453a', bg: 'rgba(255,69,58,0.15)',   border: 'rgba(255,69,58,0.38)' },
}

// ── Resolvers: map legacy thread fields → canonical types ────────────────────

export const resolveThreadStatus = (thread: { inboxStatus?: string; status?: string; conversationStage?: string }): ThreadStatus => {
  const s = String(thread.inboxStatus || thread.status || '').toLowerCase()
  if (s.includes('new_reply') || s.includes('new reply')) return 'new_reply'
  if (s.includes('active') || s.includes('communication')) return 'active_communication'
  if (s.includes('follow')) return 'follow_up'
  if (s.includes('offer_sent') || s.includes('offer sent')) return 'offer_sent'
  if (s.includes('contract_sent') || s.includes('contract sent')) return 'contract_sent'
  if (s.includes('under_contract') || s.includes('under contract')) return 'under_contract'
  if (s.includes('close') || s.includes('dead') || s.includes('suppress')) return 'closed'
  if (s.includes('wait') || s.includes('queue')) return 'waiting'
  const stage = String(thread.conversationStage || '').toLowerCase()
  if (stage.includes('offer_reveal') || stage.includes('offer')) return 'offer_sent'
  if (stage.includes('contract')) return 'contract_sent'
  if (stage.includes('negotiat')) return 'active_communication'
  return 'waiting'
}

export const resolveThreadStage = (thread: { conversationStage?: string; threadWorkflowStage?: string }): ThreadStage => {
  const s = String(thread.conversationStage || thread.threadWorkflowStage || '').toLowerCase()
  if (s.includes('ownership') || s.includes('stage_1') || s.includes('s1')) return 's1_ownership'
  if (s.includes('interest') || s.includes('consider') || s.includes('stage_2') || s.includes('s2')) return 's2_interest'
  if (s.includes('pric') || s.includes('stage_3') || s.includes('s3')) return 's3_pricing'
  if (s.includes('condition') || s.includes('detail') || s.includes('stage_4') || s.includes('s4')) return 's4_condition'
  if (s.includes('offer') || s.includes('stage_5') || s.includes('s5')) return 's5_offer'
  if (s.includes('negotiat') || s.includes('stage_6') || s.includes('s6')) return 's6_negotiation'
  if (s.includes('follow') || s.includes('stage_7') || s.includes('s7')) return 's7_follow_up'
  if (s.includes('contract') || s.includes('close') || s.includes('stage_8') || s.includes('s8')) return 's8_closing'
  return 's1_ownership'
}

export const resolveThreadTemperature = (thread: {
  priority?: string
  leadTemperature?: string
  lead_temperature?: string
  isHotLead?: boolean
}): ThreadTemperature => {
  const t = String(thread.leadTemperature || thread.lead_temperature || thread.priority || '').toLowerCase()
  if (t.includes('hot') || t === 'very_hot' || t === 'ready_to_close' || t === 'urgent') return 'hot'
  if (t.includes('warm') || t === 'high') return 'warm'
  if (t.includes('cold') || t === 'low') return 'cold'
  if (t.includes('dead')) return 'dead'
  if (thread.isHotLead) return 'hot'
  return 'cold'
}

export const resolveAutopilotMode = (thread: {
  automationState?: string
  automationStatus?: string
  status?: string
}): AutopilotMode => {
  const s = String(thread.automationState || thread.automationStatus || '').toLowerCase()
  if (s.includes('active') || s.includes('auto-eligible') || s.includes('auto-queued') || s.includes('on')) return 'autopilot_on'
  if (s.includes('pause') || s.includes('paused')) return 'autopilot_paused'
  if (s.includes('manual') || s.includes('suppressed')) return 'manual_only'
  return 'manual_only'
}

export const resolveComplianceState = (thread: {
  isSuppressed?: boolean
  isOptOut?: boolean
  inboxStatus?: string
  conversationStage?: string
}): ComplianceState => {
  const s = String(thread.inboxStatus || '').toLowerCase()
  const stage = String(thread.conversationStage || '').toLowerCase()
  if (thread.isSuppressed || thread.isOptOut || s.includes('suppress') || stage.includes('suppress')) return 'suppressed'
  if (s.includes('dnc') || stage.includes('dnc')) return 'dnc'
  if (s.includes('wrong') || stage.includes('wrong')) return 'wrong_number'
  return 'normal'
}
