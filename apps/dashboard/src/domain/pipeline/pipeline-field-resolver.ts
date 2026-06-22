import type { PipelineFieldDefinition } from './pipeline-card-design.types'
import type { PipelineOpportunity } from './pipeline-opportunity.types'
import {
  displayAos,
  displayCurrency,
  formatUnknownMetric,
  isFollowUpDue,
  portfolioLabel,
  resolvePipelineStage,
  resolvePropertyType,
  resolveTemperature,
  resolveUniversalStatus,
  stageAgeDays,
  stageLabel,
} from './pipeline-display-helpers'
import { getPipelineField } from './pipeline-display-field-registry'
import { formatRelativeTime } from '../../shared/formatters'

const OFFER_PLUS_STAGES = new Set([
  'offer', 'formal_contract', 'under_contract', 'disposition', 'prepared_to_close', 'closed',
])

export interface ResolvedFieldValue {
  key: string
  label: string
  display: string
  raw: unknown
  visible: boolean
  empty: boolean
  tone?: string
  tooltip?: string
  actionable?: boolean
  action?: 'open_conversation'
}

function hasEngineRun(opp: PipelineOpportunity): boolean {
  return Boolean(opp.acquisition_engine_run_id?.trim())
}

function isOfferPlusStage(opp: PipelineOpportunity): boolean {
  const stage = resolvePipelineStage(opp)
  return OFFER_PLUS_STAGES.has(stage)
}

function canShowEngineField(opp: PipelineOpportunity, field: PipelineFieldDefinition): boolean {
  if (field.visibilityCondition === 'engine_run_success') {
    if (!hasEngineRun(opp)) return false
    if (field.key === 'aos' && opp.aos == null) return false
  }
  if (field.stageApplicability === 'offer_plus' && !isOfferPlusStage(opp)) {
    if (!hasEngineRun(opp)) return false
  }
  return true
}

export function resolveReplyAttentionState(opp: PipelineOpportunity): string | null {
  const cs = String(opp.conversation_state ?? '').toLowerCase()
  if (cs === 'needs_reply') return 'Needs Reply'
  if (cs === 'seller_replied') return 'Seller Replied'
  if (cs === 'awaiting_seller' || opp.opportunity_status === 'waiting') return 'Awaiting Seller'
  if (cs === 'new_inbound' || cs === 'unread') return 'New Inbound'
  return null
}

export function resolveFieldValue(
  opp: PipelineOpportunity,
  fieldKey: string,
  opts?: { forceShow?: boolean },
): ResolvedFieldValue | null {
  const field = getPipelineField(fieldKey)
  if (!field) return null

  const visible = opts?.forceShow || canShowEngineField(opp, field)
  const tooltip = [
    field.description,
    field.calculated ? 'Calculated field.' : 'Sourced from opportunity record.',
    field.canBeStale ? 'May be stale if engine inputs changed.' : '',
    field.editable ? 'Manually editable.' : 'Read-only on card.',
  ].filter(Boolean).join(' ')

  let display = field.emptyLabel
  let raw: unknown = null
  let empty = true
  let tone: string | undefined
  let actionable = false
  let action: ResolvedFieldValue['action']

  switch (fieldKey) {
    case 'seller_display_name':
      raw = opp.seller_display_name
      display = opp.seller_display_name || field.emptyLabel
      empty = !opp.seller_display_name
      break
    case 'property_address_full':
      raw = opp.property_address_full
      display = portfolioLabel(opp)
      empty = !opp.property_address_full && (opp.portfolio_property_count ?? 0) <= 1
      break
    case 'property_type_market': {
      const pt = resolvePropertyType(opp)
      const mkt = opp.market || 'Market Unknown'
      display = `${pt} · ${mkt}`
      empty = pt === 'Unknown' && !opp.market
      break
    }
    case 'market':
      raw = opp.market
      display = opp.market || field.emptyLabel
      empty = !opp.market
      break
    case 'property_type':
      display = resolvePropertyType(opp)
      empty = display === 'Unknown'
      break
    case 'property_state':
      display = opp.property_state || 'Unknown'
      empty = !opp.property_state
      break
    case 'units_count':
      raw = opp.units_count
      display = opp.units_count != null ? String(opp.units_count) : field.emptyLabel
      empty = opp.units_count == null
      break
    case 'portfolio_property_count':
      raw = opp.portfolio_property_count
      display = String(opp.portfolio_property_count ?? 0)
      empty = !opp.portfolio_property_count
      break
    case 'latest_message_preview':
      raw = opp.latest_message_preview
      display = opp.latest_message_preview || field.emptyLabel
      empty = !opp.latest_message_preview
      break
    case 'latest_intent':
      raw = opp.latest_intent
      display = opp.latest_intent || field.emptyLabel
      empty = !opp.latest_intent
      break
    case 'reply_attention_state': {
      const state = resolveReplyAttentionState(opp)
      if (!state) return null
      display = state
      empty = false
      tone = state === 'Needs Reply' || state === 'New Inbound' ? 'unread' : state === 'Seller Replied' ? 'replied' : 'neutral'
      actionable = false
      action = undefined
      break
    }
    case 'last_activity_at':
      raw = opp.last_activity_at
      display = opp.last_activity_at ? formatRelativeTime(opp.last_activity_at) : field.emptyLabel
      empty = !opp.last_activity_at
      break
    case 'last_contact_at':
      raw = opp.last_contact_at
      display = opp.last_contact_at ? formatRelativeTime(opp.last_contact_at) : field.emptyLabel
      empty = !opp.last_contact_at
      break
    case 'pipeline_stage':
      display = stageLabel(resolvePipelineStage(opp))
      empty = false
      break
    case 'universal_status':
      display = stageLabel(resolveUniversalStatus(opp))
      empty = false
      break
    case 'temperature':
      display = stageLabel(resolveTemperature(opp))
      empty = resolveTemperature(opp) === 'unknown'
      tone = resolveTemperature(opp)
      break
    case 'stage_age':
      raw = stageAgeDays(opp)
      display = `${Math.round(stageAgeDays(opp))}d`
      empty = !opp.stage_entered_at
      break
    case 'priority':
      display = opp.priority || field.emptyLabel
      empty = !opp.priority
      break
    case 'next_action':
      display = opp.next_action || field.emptyLabel
      empty = !opp.next_action
      break
    case 'next_action_due':
    case 'follow_up_due': {
      const iso = opp.next_action_due || opp.next_follow_up_at
      raw = iso
      display = iso ? formatRelativeTime(iso) : field.emptyLabel
      empty = !iso
      if (isFollowUpDue(opp)) tone = 'due'
      break
    }
    case 'follow_up_reason':
      display = opp.follow_up_reason || field.emptyLabel
      empty = !opp.follow_up_reason
      break
    case 'blocker':
      if (!opp.blocker) return null
      display = opp.blocker
      empty = false
      tone = 'blocked'
      break
    case 'automation_state':
      display = opp.automation_state || field.emptyLabel
      empty = !opp.automation_state
      break
    case 'workflow_state':
      display = stageLabel(String(opp.workflow_state ?? 'not_enrolled'))
      empty = false
      break
    case 'queue_state':
      display = stageLabel(String(opp.queue_state ?? 'not_queued'))
      empty = false
      break
    case 'asking_price':
      display = displayCurrency(opp.asking_price)
      empty = opp.asking_price == null
      break
    case 'recommended_offer':
      if (!visible) return null
      display = formatUnknownMetric(opp.recommended_offer, 'currency', opp.acquisition_engine_run_id)
      empty = opp.recommended_offer == null
      break
    case 'current_offer':
      display = displayCurrency(opp.current_offer)
      empty = opp.current_offer == null
      break
    case 'seller_counter':
      display = displayCurrency(opp.seller_counter)
      empty = opp.seller_counter == null
      break
    case 'offer_to_ask_gap':
      display = displayCurrency(opp.offer_to_ask_gap)
      empty = opp.offer_to_ask_gap == null
      break
    case 'motivation_score':
      display = formatUnknownMetric(opp.motivation_score, 'percent')
      empty = opp.motivation_score == null
      break
    case 'cooperation_score':
      display = formatUnknownMetric(opp.cooperation_score, 'percent')
      empty = opp.cooperation_score == null
      break
    case 'strategy':
      if (!visible) return null
      display = opp.strategy || field.emptyLabel
      empty = !opp.strategy
      break
    case 'aos':
      if (!visible) return null
      display = displayAos(opp)
      empty = !hasEngineRun(opp) || opp.aos == null
      tone = opp.aos != null && opp.aos >= 75 ? 'hot' : undefined
      break
    case 'aos_confidence':
      if (!visible) return null
      display = formatUnknownMetric(opp.confidence, 'percent', opp.acquisition_engine_run_id)
      empty = opp.confidence == null
      break
    case 'engine_run_state':
      display = hasEngineRun(opp) ? 'Complete' : 'Not Run'
      empty = !hasEngineRun(opp)
      break
    case 'estimated_value':
      display = displayCurrency(opp.estimated_value)
      empty = opp.estimated_value == null
      break
    case 'arv':
      if (!visible) return null
      display = formatUnknownMetric(opp.arv, 'currency', opp.acquisition_engine_run_id)
      empty = opp.arv == null
      break
    case 'equity_amount':
      display = displayCurrency(opp.equity_amount)
      empty = opp.equity_amount == null
      break
    case 'opportunity_status':
      display = stageLabel(opp.opportunity_status)
      empty = false
      if (opp.opportunity_status === 'suppressed') tone = 'suppressed'
      break
    default:
      return null
  }

  if (!visible && ['aos', 'recommended_offer', 'strategy', 'arv', 'aos_confidence'].includes(fieldKey)) {
    return null
  }

  return {
    key: fieldKey,
    label: field.label,
    display,
    raw,
    visible,
    empty,
    tone,
    tooltip,
    actionable,
    action,
  }
}

/** Resolve preview with fallback to next_action per default spec. */
export function resolvePreviewField(opp: PipelineOpportunity, fieldKey: string | null): ResolvedFieldValue | null {
  if (!fieldKey) return null
  if (fieldKey === 'latest_message_preview') {
    const msg = resolveFieldValue(opp, 'latest_message_preview')
    if (msg && !msg.empty) return msg
    return resolveFieldValue(opp, 'next_action')
  }
  return resolveFieldValue(opp, fieldKey)
}

/** Apply conditional badge replacements per default spec. */
export function resolveBadgeSlots(
  opp: PipelineOpportunity,
  slots: Array<string | null>,
): ResolvedFieldValue[] {
  const badges: ResolvedFieldValue[] = []
  const suppressed = opp.opportunity_status === 'suppressed' || opp.opportunity_status === 'dead'

  for (const key of slots) {
    if (!key) continue
    if (key === 'reply_attention_state') {
      const reply = resolveFieldValue(opp, 'reply_attention_state')
      if (reply) badges.push(reply)
      continue
    }
    const val = resolveFieldValue(opp, key)
    if (val && (!val.empty || val.key === 'pipeline_stage')) badges.push(val)
  }

  if (suppressed && !badges.some((b) => b.tone === 'suppressed')) {
    badges.unshift({
      key: 'suppressed',
      label: 'Suppressed',
      display: 'Suppressed',
      raw: opp.opportunity_status,
      visible: true,
      empty: false,
      tone: 'suppressed',
    })
  }

  if (opp.blocker && badges.length < 3) {
    const blocker = resolveFieldValue(opp, 'blocker')
    if (blocker && !badges.some((b) => b.key === 'blocker')) badges.push(blocker)
  }

  return badges.slice(0, 3)
}

/** Conditional metric replacement: AOS at Offer+ with engine run may replace a metric. */
export function resolveMetricSlots(
  opp: PipelineOpportunity,
  slots: Array<string | null>,
): ResolvedFieldValue[] {
  const metrics: ResolvedFieldValue[] = []
  const keys = [...slots]

  if (isOfferPlusStage(opp) && hasEngineRun(opp) && opp.aos != null) {
    const aosIdx = keys.findIndex((k) => k === 'asking_price' || k === 'stage_age')
    if (aosIdx >= 0 && !keys.includes('aos')) keys[aosIdx] = 'aos'
  }

  const seen = new Set<string>()
  for (const key of keys) {
    if (!key) continue
    const val = resolveFieldValue(opp, key)
    if (val && !val.empty && !seen.has(val.key)) {
      seen.add(val.key)
      metrics.push(val)
    }
  }
  return metrics.slice(0, 3)
}