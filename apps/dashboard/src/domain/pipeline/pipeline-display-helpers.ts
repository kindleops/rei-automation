import type { PipelineGroupByMode, PipelineOpportunity } from './pipeline-opportunity.types'
import {
  UNIVERSAL_STAGE_LABELS,
  UNIVERSAL_STAGE_ORDER,
  UNIVERSAL_STATUS_LABELS,
  UNIVERSAL_STATUS_ORDER,
  UNIVERSAL_TEMPERATURE_LABELS,
  UNIVERSAL_TEMPERATURE_ORDER,
} from './pipeline-canonical-taxonomy'

export type StageTone = 'cyan' | 'blue' | 'gold' | 'orange' | 'green' | 'red' | 'neutral' | 'amber'

export interface StageDefinition {
  id: string
  label: string
  tone: StageTone
  matches?: string[]
}

const STAGE_TONES: StageTone[] = ['cyan', 'blue', 'gold', 'orange', 'green', 'green', 'green', 'blue', 'green', 'red']

/** Canonical universal acquisition stages (API-aligned). */
export const UNIVERSAL_PIPELINE_STAGE_GROUPS: StageDefinition[] = UNIVERSAL_STAGE_ORDER.map((id, i) => ({
  id,
  label: UNIVERSAL_STAGE_LABELS[id] ?? id,
  tone: STAGE_TONES[i] ?? 'neutral',
}))

export const UNIVERSAL_STATUS_GROUPS: StageDefinition[] = UNIVERSAL_STATUS_ORDER.map((id, i) => ({
  id,
  label: UNIVERSAL_STATUS_LABELS[id] ?? id,
  tone: (['cyan', 'blue', 'neutral', 'amber', 'amber', 'neutral'] as StageTone[])[i] ?? 'neutral',
}))

export const TEMPERATURE_GROUPS: StageDefinition[] = UNIVERSAL_TEMPERATURE_ORDER.map((id, i) => ({
  id,
  label: UNIVERSAL_TEMPERATURE_LABELS[id] ?? id,
  tone: (['red', 'amber', 'cyan', 'cyan', 'neutral', 'neutral'] as StageTone[])[i] ?? 'neutral',
}))

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
  { id: 'due_today', label: 'Due Today', tone: 'amber' },
  { id: 'overdue', label: 'Overdue', tone: 'red' },
  { id: 'upcoming', label: 'Upcoming', tone: 'blue' },
  { id: 'waiting_on_seller', label: 'Waiting on Seller', tone: 'blue' },
  { id: 'none', label: 'No Follow-Up', tone: 'neutral' },
  { id: 'cancelled', label: 'Cancelled', tone: 'neutral' },
]

export const PROPERTY_TYPE_ORDER = [
  'Single Family',
  'Multifamily 2–4',
  'Multifamily 5+',
  'Mobile Home',
  'Condo / Townhome',
  'Land',
  'Retail / Strip Mall',
  'Self-Storage',
  'Office',
  'Industrial',
  'Hospitality',
  'Mixed Use',
  'Commercial Other',
  'Unknown',
]

export type PipelineScope = 'active' | 'needs_attention' | 'all' | 'dead' | 'suppressed' | 'closed'

export const PIPELINE_SCOPE_OPTIONS: Array<{ value: PipelineScope; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'needs_attention', label: 'Needs Attention' },
  { value: 'all', label: 'All' },
  { value: 'dead', label: 'Dead' },
  { value: 'suppressed', label: 'Suppressed' },
  { value: 'closed', label: 'Closed / Archived' },
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
const SCOPE_STORAGE_KEY = 'pipeline_scope_v1'

const STAGE_LABELS: Record<string, string> = Object.fromEntries(
  UNIVERSAL_PIPELINE_STAGE_GROUPS.map((s) => [s.id, s.label]),
)

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

export function loadPipelineScope(): PipelineScope {
  try {
    const raw = localStorage.getItem(SCOPE_STORAGE_KEY)
    if (raw && PIPELINE_SCOPE_OPTIONS.some((o) => o.value === raw)) return raw as PipelineScope
  } catch { /* ignore */ }
  return 'active'
}

export function savePipelineScope(scope: PipelineScope) {
  try { localStorage.setItem(SCOPE_STORAGE_KEY, scope) } catch { /* ignore */ }
}

export function isGroupByMutable(groupBy: PipelineGroupByMode): boolean {
  return groupBy === 'stage' || groupBy === 'status' || groupBy === 'temperature'
}

export function isGroupByReadOnly(groupBy: PipelineGroupByMode): boolean {
  return !isGroupByMutable(groupBy)
}

export function resolvePipelineStage(opp: PipelineOpportunity): string {
  const code = norm(opp.pipeline_stage || opp.acquisition_stage)
  if (code && STAGE_LABELS[code]) return code
  if (code === 'needs_review') return 'ownership_confirmation'
  if (code === 'interest_qualification') return 'offer_interest'
  if (code === 'price_discovery') return 'asking_price'
  if (code === 'underwriting') return 'property_condition'
  if (code === 'decision_and_offer') return 'offer'
  if (code === 'contract_to_close') return 'formal_contract'
  if (code.includes('ownership')) return 'ownership_confirmation'
  if (code === 'offer_interest' || code === 'interest_qualification' || code === 'interest_probe') return 'offer_interest'
  if (code.includes('asking') || code === 'price_discovery') return 'asking_price'
  if (code.includes('condition') || code === 'underwriting') return 'property_condition'
  if (code.includes('offer') && !code.includes('interest')) return 'offer'
  if (code.includes('contract') || code === 'formal_contract') return 'formal_contract'
  if (code === 'under_contract') return 'under_contract'
  if (code === 'disposition') return 'disposition'
  if (code.includes('prepared') || code.includes('closing') || code === 'title_closing') return 'prepared_to_close'
  if (code.includes('closed') || code.includes('dead') || code.includes('suppressed')) return 'closed'
  return 'ownership_confirmation'
}

export function resolveUniversalStatus(opp: PipelineOpportunity): string {
  const direct = norm((opp as { universal_status?: string }).universal_status)
  if (direct && UNIVERSAL_STATUS_GROUPS.some((s) => s.id === direct)) return direct
  if (opp.conversation_state === 'needs_reply') return 'priority'
  if (opp.opportunity_status === 'waiting') return 'waiting'
  if (opp.opportunity_status === 'dead') return 'cold'
  if (opp.opportunity_status === 'suppressed') return 'cold'
  return 'unknown'
}

export function resolveTemperature(opp: PipelineOpportunity): string {
  const t = norm(opp.temperature)
  if (!t) return 'unknown'
  if (t === 'warm') return 'warming'
  if (TEMPERATURE_GROUPS.some((g) => g.id === t)) return t
  if (t.includes('hot')) return 'hot'
  if (t.includes('warm')) return 'warming'
  if (t.includes('engag')) return 'engaged'
  if (t.includes('dead')) return 'dead'
  if (t.includes('cold')) return 'cold'
  return 'unknown'
}

export function resolvePropertyType(opp: PipelineOpportunity): string {
  const meta = opp.metadata && typeof opp.metadata === 'object' ? opp.metadata : {}
  const hydrated = String(opp.property_type || meta.property_type || '').trim()
  if (hydrated && hydrated !== 'Unknown') return hydrated
  const raw = String(opp.property_type_raw || opp.asset_class || '').trim()
  if (raw.toLowerCase() === 'sfr') return 'Single Family'
  if (raw) return raw
  return 'Unknown'
}

export function resolvePropertyState(opp: PipelineOpportunity): string {
  const meta = opp.metadata && typeof opp.metadata === 'object' ? opp.metadata : {}
  const state = String(opp.property_state || meta.property_state || meta.state || '').trim()
  return state || 'Unknown'
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
  if (!iso) {
    if (opp.opportunity_status === 'waiting' || opp.conversation_state === 'awaiting_seller') return 'waiting_on_seller'
    return 'none'
  }
  const due = new Date(iso).getTime()
  const now = Date.now()
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const endOfToday = startOfToday.getTime() + 86400000
  if (due < now - 3600000) return 'overdue'
  if (due <= now) return 'due_now'
  if (due < endOfToday) return 'due_today'
  return 'upcoming'
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
  if (value === 0 && kind === 'score' && !engineRunId) return 'Not calculated'
  if (value === 0 && kind === 'currency' && !engineRunId) return 'Unknown'
  if (kind === 'currency') return displayCurrency(value, { engineRunId })
  if (kind === 'percent') return `${Math.round(value)}%`
  return String(value)
}

export function stageLabel(code: string): string {
  return STAGE_LABELS[code]
    ?? UNIVERSAL_STATUS_GROUPS.find((s) => s.id === code)?.label
    ?? TEMPERATURE_GROUPS.find((s) => s.id === code)?.label
    ?? code.replace(/_/g, ' ')
}

export function groupKeyForOpportunity(opp: PipelineOpportunity, groupBy: PipelineGroupByMode): string {
  switch (groupBy) {
    case 'stage': return resolvePipelineStage(opp)
    case 'status': return resolveUniversalStatus(opp)
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
  if (groupBy === 'stage') return UNIVERSAL_PIPELINE_STAGE_GROUPS
  if (groupBy === 'status') return UNIVERSAL_STATUS_GROUPS
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
    return ordered.map((label, index) => ({
      id: label,
      label: label === 'Unknown' ? 'Unclassified' : label,
      tone: tones[index % tones.length] ?? 'neutral',
    }))
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
  const state = resolveFollowUpState(opp)
  return state === 'due_now' || state === 'due_today' || state === 'overdue'
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

/** @deprecated Use resolveUniversalStatus */
export function resolveSellerStatus(opp: PipelineOpportunity): string {
  return resolveUniversalStatus(opp)
}

/** @deprecated Legacy stage groups — do not use for grouping */
export const PIPELINE_STAGE_GROUPS = UNIVERSAL_PIPELINE_STAGE_GROUPS
export const SELLER_STATUS_GROUPS = UNIVERSAL_STATUS_GROUPS