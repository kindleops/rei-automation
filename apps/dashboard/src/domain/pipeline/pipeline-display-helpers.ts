import type { PipelineGroupByMode, PipelineOpportunity } from './pipeline-opportunity.types'

export type StageTone = 'cyan' | 'blue' | 'gold' | 'orange' | 'green' | 'red' | 'neutral' | 'amber'

export interface StageDefinition {
  id: string
  label: string
  tone: StageTone
}

export const ACQUISITION_STAGE_GROUPS: StageDefinition[] = [
  { id: 'needs_review', label: 'New / Needs Review', tone: 'neutral' },
  { id: 'ownership_confirmation', label: 'Ownership Confirmation', tone: 'cyan' },
  { id: 'interest_qualification', label: 'Interest Qualification', tone: 'blue' },
  { id: 'price_discovery', label: 'Price Discovery', tone: 'gold' },
  { id: 'underwriting', label: 'Underwriting', tone: 'orange' },
  { id: 'decision_and_offer', label: 'Decision & Offer', tone: 'green' },
  { id: 'contract_to_close', label: 'Contract to Close', tone: 'green' },
]

export const STATUS_GROUPS: StageDefinition[] = [
  { id: 'active', label: 'Active', tone: 'blue' },
  { id: 'waiting', label: 'Waiting', tone: 'blue' },
  { id: 'paused', label: 'Paused', tone: 'amber' },
  { id: 'nurture', label: 'Nurture', tone: 'cyan' },
  { id: 'won', label: 'Won', tone: 'green' },
  { id: 'lost', label: 'Lost', tone: 'red' },
  { id: 'dead', label: 'Dead', tone: 'red' },
  { id: 'suppressed', label: 'Suppressed', tone: 'red' },
  { id: 'archived', label: 'Archived', tone: 'neutral' },
]

export const CONVERSATION_GROUPS: StageDefinition[] = [
  { id: 'needs_reply', label: 'Needs Reply', tone: 'amber' },
  { id: 'awaiting_seller', label: 'Awaiting Seller', tone: 'blue' },
  { id: 'seller_replied', label: 'Seller Replied', tone: 'cyan' },
  { id: 'needs_review', label: 'Needs Review', tone: 'amber' },
  { id: 'no_recent_activity', label: 'No Recent Activity', tone: 'neutral' },
]

export const QUEUE_GROUPS: StageDefinition[] = [
  { id: 'not_queued', label: 'Not Queued', tone: 'neutral' },
  { id: 'scheduled', label: 'Scheduled', tone: 'blue' },
  { id: 'queued', label: 'Queued', tone: 'blue' },
  { id: 'sending', label: 'Sending', tone: 'blue' },
  { id: 'sent', label: 'Sent', tone: 'cyan' },
  { id: 'delivered', label: 'Delivered', tone: 'green' },
  { id: 'failed', label: 'Failed', tone: 'red' },
  { id: 'cancelled', label: 'Cancelled', tone: 'neutral' },
]

export const WORKFLOW_GROUPS: StageDefinition[] = [
  { id: 'not_enrolled', label: 'Not Enrolled', tone: 'neutral' },
  { id: 'active', label: 'Active', tone: 'green' },
  { id: 'waiting', label: 'Waiting', tone: 'blue' },
  { id: 'approval_required', label: 'Approval Required', tone: 'amber' },
  { id: 'blocked', label: 'Blocked', tone: 'red' },
  { id: 'paused', label: 'Paused', tone: 'amber' },
  { id: 'completed', label: 'Completed', tone: 'green' },
  { id: 'failed', label: 'Failed', tone: 'red' },
]

export const PIPELINE_VIEW_OPTIONS: Array<{ value: PipelineGroupByMode; label: string; hint?: string }> = [
  { value: 'acquisition_stage', label: 'Acquisition Stage' },
  { value: 'opportunity_status', label: 'Opportunity Status' },
  { value: 'conversation_state', label: 'Conversation State' },
  { value: 'queue_execution', label: 'Queue Execution', hint: 'Operational execution view — not the deal pipeline' },
  { value: 'workflow_state', label: 'Workflow State' },
  { value: 'market', label: 'Market' },
  { value: 'strategy', label: 'Strategy' },
  { value: 'priority', label: 'Priority' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'follow_up', label: 'Follow-Up' },
  { value: 'asset_class', label: 'Asset Class' },
]

const STORAGE_KEY = 'pipeline_group_by_v1'

export function loadPipelineGroupBy(): PipelineGroupByMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && PIPELINE_VIEW_OPTIONS.some((o) => o.value === raw)) return raw as PipelineGroupByMode
  } catch { /* ignore */ }
  return 'acquisition_stage'
}

export function savePipelineGroupBy(mode: PipelineGroupByMode) {
  try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* ignore */ }
}

export function formatUnknownMetric(value: number | null | undefined, kind: 'currency' | 'percent' | 'score' = 'score'): string {
  if (value === null || value === undefined) return kind === 'currency' ? 'Unknown' : 'Not calculated'
  if (value === 0 && kind !== 'score') return 'Pending engine run'
  return String(value)
}

export function displayCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Unknown'
  if (value === 0) return 'Pending engine run'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

export function stageLabel(code: string): string {
  return ACQUISITION_STAGE_GROUPS.find((s) => s.id === code)?.label ?? code.replace(/_/g, ' ')
}

export function groupKeyForOpportunity(opp: PipelineOpportunity, groupBy: PipelineGroupByMode): string {
  switch (groupBy) {
    case 'acquisition_stage': return opp.acquisition_stage
    case 'opportunity_status': return opp.opportunity_status
    case 'conversation_state': return opp.conversation_state
    case 'queue_execution': return opp.queue_state
    case 'workflow_state': return opp.workflow_state
    case 'market': return opp.market || 'Market Unknown'
    case 'strategy': return opp.strategy || 'Strategy Unknown'
    case 'priority': return opp.priority || 'normal'
    case 'assignee': return opp.assigned_operator || 'Unassigned'
    case 'follow_up': return opp.next_action_due && new Date(opp.next_action_due) <= new Date() ? 'Due Now' : 'Scheduled'
    case 'asset_class': return opp.asset_class || 'Unknown'
    default: return opp.acquisition_stage
  }
}

export function groupDefinitionsForMode(
  groupBy: PipelineGroupByMode,
  opportunities: PipelineOpportunity[],
): StageDefinition[] {
  if (groupBy === 'acquisition_stage') return ACQUISITION_STAGE_GROUPS
  if (groupBy === 'opportunity_status') return STATUS_GROUPS
  if (groupBy === 'conversation_state') return CONVERSATION_GROUPS
  if (groupBy === 'queue_execution') return QUEUE_GROUPS
  if (groupBy === 'workflow_state') return WORKFLOW_GROUPS

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