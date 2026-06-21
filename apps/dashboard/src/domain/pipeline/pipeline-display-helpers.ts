import type { PipelineGroupByMode, PipelineOpportunity } from './pipeline-opportunity.types'

export type StageTone = 'cyan' | 'blue' | 'gold' | 'orange' | 'green' | 'red' | 'neutral' | 'amber'

export interface StageDefinition {
  id: string
  label: string
  tone: StageTone
  matches?: string[]
}

/** Universal pipeline stages — matches InboxPipelineView / v_inbox_enriched. */
export const PIPELINE_STAGE_GROUPS: StageDefinition[] = [
  { id: 'ownership_check', label: 'Ownership Check', tone: 'cyan', matches: ['ownership'] },
  { id: 'interest_probe', label: 'Interest Probe', tone: 'blue', matches: ['interest'] },
  { id: 'active_communication', label: 'Active Communication', tone: 'blue', matches: ['active', 'seller_response', 'communication'] },
  { id: 'price_discovery', label: 'Price Discovery', tone: 'gold', matches: ['price'] },
  { id: 'condition_details', label: 'Condition Details', tone: 'orange', matches: ['condition'] },
  { id: 'underwriting', label: 'Underwriting', tone: 'orange', matches: ['underwrit'] },
  { id: 'offer_sent', label: 'Offer Sent', tone: 'green', matches: ['offer', 'negotiat', 'counter'] },
  { id: 'contract_sent', label: 'Contract Sent', tone: 'green', matches: ['contract'] },
  { id: 'title_closing', label: 'Title / Closing', tone: 'green', matches: ['title', 'closing'] },
  { id: 'dead_suppressed', label: 'Dead / Suppressed', tone: 'red', matches: ['dead', 'suppressed', 'closed'] },
]

export const SELLER_STATUS_GROUPS: StageDefinition[] = [
  { id: 'new', label: 'New', tone: 'cyan', matches: ['new'] },
  { id: 'not_contacted', label: 'Not Contacted', tone: 'neutral', matches: ['not_contacted'] },
  { id: 'ownership_check_sent', label: 'Ownership Check Sent', tone: 'blue', matches: ['ownership_check_sent'] },
  { id: 'message_sent', label: 'Message Sent', tone: 'blue', matches: ['message_sent', 'sent_message'] },
  { id: 'awaiting_response', label: 'Awaiting Response', tone: 'blue', matches: ['waiting', 'awaiting_response'] },
  { id: 'seller_replied', label: 'Seller Replied', tone: 'cyan', matches: ['new_reply', 'seller_replied'] },
  { id: 'positive_intent', label: 'Positive Intent', tone: 'green', matches: ['positive', 'interested'] },
  { id: 'asking_price_provided', label: 'Asking Price Provided', tone: 'gold', matches: ['asking_price'] },
  { id: 'needs_follow_up', label: 'Needs Follow-Up', tone: 'amber', matches: ['follow_up'] },
  { id: 'negotiating', label: 'Negotiating', tone: 'green', matches: ['negotiat'] },
  { id: 'offer_sent', label: 'Offer Sent', tone: 'green', matches: ['offer_sent'] },
  { id: 'contract_sent', label: 'Contract Sent', tone: 'green', matches: ['contract_sent'] },
  { id: 'review_required', label: 'Review Required', tone: 'amber', matches: ['review'] },
  { id: 'auto_blocked', label: 'Auto Blocked', tone: 'red', matches: ['auto_blocked'] },
  { id: 'suppressed', label: 'Suppressed', tone: 'red', matches: ['suppressed'] },
  { id: 'wrong_number', label: 'Wrong Number', tone: 'red', matches: ['wrong_number'] },
  { id: 'failed', label: 'Failed', tone: 'red', matches: ['failed'] },
]

export const TEMPERATURE_GROUPS: StageDefinition[] = [
  { id: 'hot', label: 'Hot', tone: 'red' },
  { id: 'warm', label: 'Warm', tone: 'amber' },
  { id: 'cold', label: 'Cold', tone: 'cyan' },
  { id: 'dead', label: 'Dead', tone: 'neutral' },
]

export const QUEUE_STATUS_GROUPS: StageDefinition[] = [
  { id: 'scheduled', label: 'Scheduled', tone: 'blue', matches: ['scheduled'] },
  { id: 'queued', label: 'Queued', tone: 'blue', matches: ['queued'] },
  { id: 'ready', label: 'Ready', tone: 'cyan', matches: ['ready'] },
  { id: 'sending', label: 'Sending', tone: 'blue', matches: ['sending'] },
  { id: 'sent', label: 'Sent', tone: 'blue', matches: ['sent'] },
  { id: 'delivered', label: 'Delivered', tone: 'green', matches: ['delivered'] },
  { id: 'failed', label: 'Failed', tone: 'red', matches: ['failed'] },
  { id: 'blocked', label: 'Blocked', tone: 'red', matches: ['blocked'] },
  { id: 'cancelled', label: 'Cancelled', tone: 'neutral', matches: ['cancelled'] },
  { id: 'paused', label: 'Paused', tone: 'amber', matches: ['paused'] },
  { id: 'not_queued', label: 'Not Queued', tone: 'neutral', matches: ['not_queued'] },
]

export const WORKFLOW_STATUS_GROUPS: StageDefinition[] = [
  { id: 'not_enrolled', label: 'Not Enrolled', tone: 'neutral' },
  { id: 'active', label: 'Active', tone: 'green' },
  { id: 'waiting', label: 'Waiting', tone: 'blue' },
  { id: 'approval_required', label: 'Approval Required', tone: 'amber' },
  { id: 'blocked', label: 'Blocked', tone: 'red' },
  { id: 'paused', label: 'Paused', tone: 'amber' },
  { id: 'completed', label: 'Completed', tone: 'green' },
  { id: 'failed', label: 'Failed', tone: 'red' },
]

export const FOLLOW_UP_STATE_GROUPS: StageDefinition[] = [
  { id: 'due_now', label: 'Due Now', tone: 'amber' },
  { id: 'scheduled', label: 'Scheduled', tone: 'blue' },
  { id: 'none', label: 'None', tone: 'neutral' },
]

export const PROPERTY_TYPE_ORDER = [
  'Single Family',
  'Multifamily',
  'Apartment',
  'Duplex/Triplex/Quadplex',
  'Land',
  'Commercial',
  'Unknown',
]

export interface PipelineViewOption {
  value: PipelineGroupByMode
  label: string
  hint?: string
  section: 'core' | 'property' | 'operations'
  readOnly?: boolean
}

export const PIPELINE_VIEW_OPTIONS: PipelineViewOption[] = [
  { value: 'stage', label: 'Stage', section: 'core' },
  { value: 'status', label: 'Status', section: 'core' },
  { value: 'temperature', label: 'Temperature', section: 'core' },
  { value: 'market', label: 'Market', section: 'property', readOnly: true },
  { value: 'state', label: 'State', section: 'property', readOnly: true },
  { value: 'property_type', label: 'Property Type', section: 'property', readOnly: true },
  { value: 'queue_status', label: 'Queue Status', section: 'operations', readOnly: true, hint: 'Operational execution view' },
  { value: 'workflow_status', label: 'Workflow Status', section: 'operations', readOnly: true },
  { value: 'follow_up_state', label: 'Follow-Up State', section: 'operations', readOnly: true },
]

const LEGACY_GROUP_BY: Record<string, PipelineGroupByMode> = {
  acquisition_stage: 'stage',
  opportunity_status: 'status',
  conversation_state: 'status',
  queue_execution: 'queue_status',
  workflow_state: 'workflow_status',
  follow_up: 'follow_up_state',
  asset_class: 'property_type',
  strategy: 'stage',
  priority: 'temperature',
  assignee: 'market',
}

const STORAGE_KEY = 'pipeline_group_by_v2'

const ACQUISITION_TO_UNIVERSAL_STAGE: Record<string, string> = {
  needs_review: 'ownership_check',
  ownership_confirmation: 'ownership_check',
  interest_qualification: 'interest_probe',
  price_discovery: 'price_discovery',
  underwriting: 'underwriting',
  decision_and_offer: 'offer_sent',
  contract_to_close: 'contract_sent',
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

export function loadPipelineGroupBy(): PipelineGroupByMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('pipeline_group_by_v1')
    if (!raw) return 'stage'
    const mapped = LEGACY_GROUP_BY[raw] ?? raw
    if (PIPELINE_VIEW_OPTIONS.some((o) => o.value === mapped)) return mapped as PipelineGroupByMode
  } catch { /* ignore */ }
  return 'stage'
}

export function savePipelineGroupBy(mode: PipelineGroupByMode) {
  try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* ignore */ }
}

export function isGroupByMutable(groupBy: PipelineGroupByMode): boolean {
  return groupBy === 'stage' || groupBy === 'status' || groupBy === 'temperature'
}

export function isGroupByReadOnly(groupBy: PipelineGroupByMode): boolean {
  return !isGroupByMutable(groupBy)
}

export function resolvePipelineStage(opp: PipelineOpportunity): string {
  const meta = opp.metadata && typeof opp.metadata === 'object' ? opp.metadata : {}
  const direct = norm(opp.pipeline_stage || meta.pipeline_stage)
  if (direct && PIPELINE_STAGE_GROUPS.some((s) => s.id === direct)) return direct

  const legacy = norm(opp.acquisition_stage)
  if (legacy && ACQUISITION_TO_UNIVERSAL_STAGE[legacy]) return ACQUISITION_TO_UNIVERSAL_STAGE[legacy]

  for (const stage of PIPELINE_STAGE_GROUPS) {
    if (stage.matches?.some((m) => legacy.includes(m) || direct.includes(m))) return stage.id
  }
  return 'ownership_check'
}

export function resolveSellerStatus(opp: PipelineOpportunity): string {
  const meta = opp.metadata && typeof opp.metadata === 'object' ? opp.metadata : {}
  const direct = norm(opp.seller_status || meta.seller_status)
  if (direct && SELLER_STATUS_GROUPS.some((s) => s.id === direct)) return direct

  const raw = `${direct} ${norm(opp.opportunity_status)} ${norm(opp.conversation_state)} ${norm(opp.latest_intent)}`
  const match = SELLER_STATUS_GROUPS.find((group) => group.matches?.some((m) => raw.includes(m)))
  if (match) return match.id

  if (opp.conversation_state === 'seller_replied' || opp.conversation_state === 'needs_reply') return 'seller_replied'
  if (opp.conversation_state === 'awaiting_seller') return 'awaiting_response'
  if (opp.opportunity_status === 'suppressed' || opp.opportunity_status === 'dead') return 'suppressed'
  if (opp.opportunity_status === 'waiting') return 'awaiting_response'
  return 'new'
}

export function resolveTemperature(opp: PipelineOpportunity): string {
  const t = norm(opp.temperature || opp.priority)
  if (t.includes('hot') || t === 'urgent') return 'hot'
  if (t.includes('warm') || t === 'high') return 'warm'
  if (t.includes('dead') || opp.opportunity_status === 'dead') return 'dead'
  if (t.includes('cold') || t === 'low' || t === 'normal') return 'cold'
  if (opp.aos != null && opp.aos >= 75) return 'hot'
  return 'cold'
}

export function resolvePropertyType(opp: PipelineOpportunity): string {
  const meta = opp.metadata && typeof opp.metadata === 'object' ? opp.metadata : {}
  return String(opp.property_type || meta.property_type || opp.asset_class || 'Unknown')
}

export function resolvePropertyState(opp: PipelineOpportunity): string {
  const meta = opp.metadata && typeof opp.metadata === 'object' ? opp.metadata : {}
  return String(opp.property_state || meta.property_state || meta.state || 'State Unknown')
}

export function resolveQueueStatus(opp: PipelineOpportunity): string {
  const raw = norm(opp.queue_state)
  return QUEUE_STATUS_GROUPS.find((g) => g.matches?.some((m) => raw.includes(m)) || g.id === raw)?.id ?? 'not_queued'
}

export function resolveWorkflowStatus(opp: PipelineOpportunity): string {
  const raw = norm(opp.workflow_state)
  return WORKFLOW_STATUS_GROUPS.find((g) => g.id === raw)?.id ?? 'not_enrolled'
}

export function resolveFollowUpState(opp: PipelineOpportunity): string {
  const iso = opp.next_action_due || opp.next_follow_up_at
  if (!iso) return 'none'
  return new Date(iso).getTime() <= Date.now() ? 'due_now' : 'scheduled'
}

export function displayAos(opp: PipelineOpportunity): string {
  if (!opp.acquisition_engine_run_id) return 'No analysis yet'
  if (opp.aos == null) return 'No analysis yet'
  return String(Math.round(opp.aos))
}

export function displayCurrency(
  value: number | null | undefined,
  opts?: { engineRunId?: string | null },
): string {
  if (value === null || value === undefined) return 'Unknown'
  if (value === 0 && !opts?.engineRunId) return 'Unknown'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

export function formatUnknownMetric(
  value: number | null | undefined,
  kind: 'currency' | 'percent' | 'score' = 'score',
  engineRunId?: string | null,
): string {
  if (value === null || value === undefined) return kind === 'currency' ? 'Unknown' : 'Not calculated'
  if (value === 0 && kind === 'currency' && !engineRunId) return 'Unknown'
  if (kind === 'currency') return displayCurrency(value, { engineRunId })
  if (kind === 'percent') return `${Math.round(value)}%`
  return String(value)
}

export function stageLabel(code: string): string {
  return PIPELINE_STAGE_GROUPS.find((s) => s.id === code)?.label
    ?? SELLER_STATUS_GROUPS.find((s) => s.id === code)?.label
    ?? code.replace(/_/g, ' ')
}

export function groupKeyForOpportunity(opp: PipelineOpportunity, groupBy: PipelineGroupByMode): string {
  switch (groupBy) {
    case 'stage': return resolvePipelineStage(opp)
    case 'status': return resolveSellerStatus(opp)
    case 'temperature': return resolveTemperature(opp)
    case 'market': return opp.market || 'Market Unknown'
    case 'state': return resolvePropertyState(opp)
    case 'property_type': return resolvePropertyType(opp)
    case 'queue_status': return resolveQueueStatus(opp)
    case 'workflow_status': return resolveWorkflowStatus(opp)
    case 'follow_up_state': return resolveFollowUpState(opp)
    default: return resolvePipelineStage(opp)
  }
}

export function groupDefinitionsForMode(
  groupBy: PipelineGroupByMode,
  opportunities: PipelineOpportunity[],
): StageDefinition[] {
  if (groupBy === 'stage') return PIPELINE_STAGE_GROUPS
  if (groupBy === 'status') return SELLER_STATUS_GROUPS
  if (groupBy === 'temperature') return TEMPERATURE_GROUPS
  if (groupBy === 'queue_status') return QUEUE_STATUS_GROUPS
  if (groupBy === 'workflow_status') return WORKFLOW_STATUS_GROUPS
  if (groupBy === 'follow_up_state') return FOLLOW_UP_STATE_GROUPS

  if (groupBy === 'property_type') {
    const counts = new Map<string, number>()
    for (const opp of opportunities) {
      const key = resolvePropertyType(opp)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const dynamic = Array.from(counts.keys()).filter((k) => !PROPERTY_TYPE_ORDER.includes(k))
    const ordered = [...PROPERTY_TYPE_ORDER, ...dynamic]
    const tones: StageTone[] = ['cyan', 'blue', 'gold', 'orange', 'green', 'red', 'neutral']
    return ordered
      .filter((label) => counts.has(label) || label === 'Unknown')
      .map((label, index) => ({ id: label, label, tone: tones[index % tones.length] ?? 'neutral' }))
  }

  const counts = new Map<string, number>()
  for (const opp of opportunities) {
    const key = groupKeyForOpportunity(opp, groupBy)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const tones: StageTone[] = ['cyan', 'blue', 'gold', 'orange', 'green', 'red', 'neutral']
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label], index) => ({ id: label, label, tone: tones[index % tones.length] ?? 'neutral' }))
}

export function isFollowUpDue(opp: PipelineOpportunity): boolean {
  const iso = opp.next_action_due || opp.next_follow_up_at
  if (!iso) return false
  return new Date(iso).getTime() <= Date.now() + 36 * 3600000
}

export function stageAgeDays(opp: PipelineOpportunity): number {
  if (!opp.stage_entered_at) return 0
  const d = (Date.now() - new Date(opp.stage_entered_at).getTime()) / 86400000
  return Number.isFinite(d) && d >= 0 ? d : 0
}

export function portfolioLabel(opp: PipelineOpportunity): string {
  const count = opp.portfolio_property_count || opp.portfolio_property_ids?.length || 0
  if (count > 1) return `${count} matched properties`
  return opp.property_address_full || 'Property Unknown'
}