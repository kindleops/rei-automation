import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CampaignLaunchMode, CampaignLaunchPayload, CampaignLaunchResult, CreateCampaignPayload } from './campaigns.types'
import { buildCampaignTargetSnapshots, createCampaign, launchCampaign } from './campaigns.adapter'
import {
  CAMPAIGN_FIELD_KEY_ALIASES,
  createEmptyFilterGroups,
  defaultOperatorForField,
  defaultValueForField,
  getFieldCatalog,
  previewTargets,
  searchFieldOptions,
  serializeFilterGroups,
  type CampaignDomainKey,
  type CampaignFieldCatalog,
  type CampaignFieldDefinition,
  type CampaignFieldOption,
  type CampaignFilterCondition,
  type CampaignFilterGroups,
  type CampaignPreviewResult,
  type CampaignSampleTarget,
  type CampaignWizardDraft,
} from './campaignWizardAdapter'
import { emitNotification } from '../../shared/NotificationToast'
import { Icon } from '../../shared/icons'
import './campaign-pacing.css'

interface CreateCampaignModalProps {
  onClose: () => void
  onSuccess: (newCampaignId: string) => void
}

type FilterStatus = 'editing_new' | 'editing_saved' | 'active'

const EMPTY_VALUE_OPERATORS = new Set(['is_empty', 'is_not_empty'])
const OPTION_OPERATORS = new Set(['is_any_of', 'is_not_any_of'])
const ALL_DOMAIN_KEYS: CampaignDomainKey[] = ['properties', 'prospects', 'master_owners', 'phones', 'outreach', 'sender_coverage']

type PacingMode = 'conservative' | 'normal' | 'aggressive' | 'custom'

interface LaunchSettings {
  mode: CampaignLaunchMode
  pacing: PacingMode
  max_targets: string
  daily_cap: string
  per_sender_cap: string
  per_market_cap: string
  first_scheduled_at: string
  spread_interval_seconds: string
  contact_window_start: string
  contact_window_end: string
}

// Operator-facing pacing presets. Each preset sets the throttles that govern how
// fast a campaign drains: daily cap, per-message spacing, per-sender cap and
// per-market cap. "Custom" leaves the operator in full control via Advanced
// Settings. Values are tuned for compliant SMS land-and-expand outreach.
interface PacingPresetConfig {
  key: PacingMode
  label: string
  blurb: string
  daily_cap: string
  spread_interval_seconds: string
  per_sender_cap: string
  per_market_cap: string
}

const PACING_PRESETS: PacingPresetConfig[] = [
  { key: 'conservative', label: 'Conservative', blurb: 'Slow & safe', daily_cap: '250', spread_interval_seconds: '90', per_sender_cap: '75', per_market_cap: '150' },
  { key: 'normal', label: 'Normal', blurb: 'Balanced cadence', daily_cap: '750', spread_interval_seconds: '45', per_sender_cap: '150', per_market_cap: '400' },
  { key: 'aggressive', label: 'Aggressive', blurb: 'Max throughput', daily_cap: '2000', spread_interval_seconds: '20', per_sender_cap: '300', per_market_cap: '1000' },
  { key: 'custom', label: 'Custom', blurb: 'Advanced controls', daily_cap: '', spread_interval_seconds: '', per_sender_cap: '', per_market_cap: '' },
]

const PACING_PRESET_BY_KEY = new Map(PACING_PRESETS.map((preset) => [preset.key, preset]))

interface OptionLoadState {
  loading: boolean
  degraded?: boolean
  message?: string
}

interface PreviewMeta {
  ms: number
  ts: string
  requestId: string
  resultHash?: string | null
  previousTotalMatched?: number | null
  countUnchanged?: boolean
}

const FRIENDLY_OPERATORS: Record<string, string> = {
  eq: 'is',
  is_any_of: 'is any of',
  is_not_any_of: 'is not any of',
  contains: 'contains',
  gte: 'at least',
  lte: 'at most',
  between: 'between',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  is_true: 'is true',
  is_false: 'is false',
  on_or_after: 'on or after',
  on_or_before: 'on or before',
}

const SUGGESTED_FIELD_KEYS: Record<string, string[]> = {
  'properties.Location & Market': [
    'properties.market', 'properties.property_address_state', 'properties.property_address_zip', 'properties.market_region',
  ],
  'properties.Asset Type & Structure': [
    'properties.property_type', 'properties.property_class', 'properties.year_built', 'properties.units_count',
  ],
  'properties.Value / Equity / Debt': [
    'properties.estimated_value', 'properties.equity_percent', 'properties.total_loan_balance', 'properties.ownership_years',
  ],
  'properties.Distress & Motivation': [
    'properties.tax_delinquent', 'properties.active_lien', 'properties.seller_tags_text', 'properties.final_acquisition_score',
  ],
  'properties.Condition / Repair': [
    'properties.building_condition', 'properties.rehab_level', 'properties.estimated_repair_cost', 'properties.building_quality',
  ],
  'properties.Land / Lot / Zoning': [
    'properties.zoning', 'properties.flood_zone', 'properties.lot_acreage', 'properties.lot_square_feet',
  ],
  'properties.Tax / Assessment': [
    'properties.assd_total_value', 'properties.calculated_total_value', 'properties.assd_year',
  ],
  'properties.Owner Relationship': [
    'properties.owner_type', 'properties.is_corporate_owner', 'properties.out_of_state_owner', 'properties.deal_list_label',
  ],
  'prospects.Demographics': [
    'prospects.age_bucket', 'prospects.language_preference', 'prospects.timezone', 'prospects.contact_window',
  ],
  'prospects.Matching & Eligibility': [
    'prospects.matching_flags', 'prospects.person_flags_text', 'prospects.sms_eligible', 'prospects.seller_tags_text',
  ],
  'master_owners.Profile': [
    'master_owners.priority_tier', 'master_owners.owner_type_guess', 'master_owners.follow_up_cadence',
  ],
  'master_owners.Scores': [
    'master_owners.priority_score', 'master_owners.contactability_score',
    'master_owners.financial_pressure_score', 'master_owners.urgency_score',
  ],
  'master_owners.Portfolio Financials': [
    'master_owners.portfolio_total_value', 'master_owners.portfolio_total_equity',
    'master_owners.property_count', 'master_owners.portfolio_total_units',
  ],
  'master_owners.Portfolio Distress': [
    'master_owners.tax_delinquent_count', 'master_owners.active_lien_count', 'master_owners.oldest_tax_delinquent_year',
  ],
  'phones.Quality': [
    'phones.phone_owner', 'phones.activity_status', 'phones.usage_12_months', 'phones.usage_2_months',
  ],
  'outreach.Rules': [
    'outreach.never_contacted', 'outreach.last_outbound_at', 'outreach.touch_count',
    'outreach.pending_prior_touch', 'outreach.duplicate_queue_status',
  ],
  'sender_coverage.Routing': [
    'sender_coverage.routing_allowed', 'sender_coverage.routing_tier',
    'sender_coverage.selected_textgrid_market', 'sender_coverage.sender_coverage_status',
  ],
}

const DOMAIN_SOURCE_VIEWS: Record<string, string> = {
  properties: 'v_properties',
  prospects: 'v_prospects',
  master_owners: 'v_master_owners',
  phones: 'v_phones',
  outreach: 'v_outreach_ctx',
  sender_coverage: 'v_sender_coverage_ctx',
}

const SPECIAL_DISPLAY_LABELS: Record<string, string> = {
  age: 'Age',
  age_bucket: 'Age Bucket',
  phone_owner: 'Carrier / Phone Owner',
  sms_eligible: 'SMS Eligible',
  next_allowed_sms_at: 'Next Allowed SMS At',
  last_sms_at: 'Last SMS At',
}

const createDefaultDraft = (): CampaignWizardDraft => ({
  name: '',
  description: '',
  template_use_case: 'ownership_check',
  stage_code: 'first_touch',
  target_filters: createEmptyFilterGroups(),
})

const getDefaultFutureDateTimeLocal = (): string => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

const DEFAULT_PACING: PacingMode = 'normal'

const createDefaultLaunchSettings = (): LaunchSettings => {
  const preset = PACING_PRESET_BY_KEY.get(DEFAULT_PACING)!
  return {
    mode: 'dry_run',
    pacing: DEFAULT_PACING,
    max_targets: '1000',
    daily_cap: preset.daily_cap,
    per_sender_cap: preset.per_sender_cap,
    per_market_cap: preset.per_market_cap,
    first_scheduled_at: getDefaultFutureDateTimeLocal(),
    spread_interval_seconds: preset.spread_interval_seconds,
    contact_window_start: '09:00',
    contact_window_end: '20:00',
  }
}

// Minutes between two "HH:MM" local clock times, clamped to a sane send window.
const sendWindowHours = (start: string, end: string): number => {
  const parse = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
    if (!match) return null
    const h = Number(match[1])
    const m = Number(match[2])
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null
    return h * 60 + m
  }
  const startMin = parse(start)
  const endMin = parse(end)
  if (startMin == null || endMin == null) return 11
  const span = (endMin - startMin) / 60
  if (!Number.isFinite(span) || span <= 0) return 11
  return Math.min(24, span)
}

const formatNumber = (value: number | undefined | null): string => {
  return Number(value || 0).toLocaleString()
}

const formatDateTime = (value: string | undefined | null): string => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const parsePositiveInt = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

// Blended per-segment SMS cost estimate (carrier + provider). Clearly an estimate;
// the operator-facing label always reads "Est." so this is never presented as billed truth.
const ESTIMATED_COST_PER_SMS_USD = 0.0083

const toLocalDateTimeInput = (date: Date): string => {
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16)
}

const formatDurationApprox = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 90) return `~${Math.round(seconds)}s`
  const minutes = seconds / 60
  if (minutes < 90) return `~${Math.round(minutes)} min`
  const hours = minutes / 60
  if (hours < 36) return `~${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hr`
  const days = hours / 24
  return `~${days < 10 ? days.toFixed(1) : Math.round(days)} days`
}

const formatUsdApprox = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  if (value >= 100) return `$${Math.round(value).toLocaleString()}`
  return `$${value.toFixed(2)}`
}

interface LaunchEstimates {
  deliverable: number
  senderCovered: number
  senderCoveragePct: number | null
  effectiveSends: number
  durationLabel: string
  runtimeCapped: boolean
  spanDays: number
  dailyVolume: number
  spacingSeconds: number
  windowHours: number
  cost: number
}

// All estimates derive from the verified preview funnel (deliverable = ready_to_queue,
// sender coverage from sender_covered) and the operator's pacing settings. No mock numbers.
//
// Runtime is modelled from the real throttles, not a naïve sends/daily_cap. Daily
// throughput is bounded by BOTH the daily cap AND how many spaced messages physically
// fit inside the send window (window_hours * 3600 / spacing). Calendar days to drain =
// ceil(sends / daily_throughput). This is why a 1/day default no longer reports an
// absurd ~1000-day runtime: the floor is a realistic daily volume.
const computeLaunchEstimates = (
  preview: CampaignPreviewResult | null,
  settings: LaunchSettings,
): LaunchEstimates => {
  const deliverable = Number(preview?.ready_to_queue ?? 0)
  const senderCovered = Number(preview?.sender_covered ?? 0)
  const universe = Number(
    preview?.addressable_properties ?? preview?.total_matched_properties ?? preview?.total_matched ?? 0,
  )
  const senderCoveragePct = universe > 0 ? Math.round((senderCovered / universe) * 100) : null

  const maxTargets = parsePositiveInt(settings.max_targets, deliverable || 1)
  const dailyCap = parsePositiveInt(settings.daily_cap, 750)
  const spacing = Math.max(1, parsePositiveInt(settings.spread_interval_seconds, 45))
  const windowHours = sendWindowHours(settings.contact_window_start, settings.contact_window_end)
  const windowSeconds = windowHours * 3600

  // Send cap governs total volume; deliverable is the hard ceiling.
  const effectiveSends = Math.max(0, Math.min(deliverable, maxTargets))
  // Physical capacity of one send window given spacing, then the operator's daily cap.
  const sendsPerWindow = Math.max(1, Math.floor(windowSeconds / spacing))
  const dailyVolume = Math.max(1, Math.min(dailyCap, sendsPerWindow))
  const spanDays = effectiveSends > 0 ? Math.max(1, Math.ceil(effectiveSends / dailyVolume)) : 0

  let durationSeconds: number
  if (spanDays <= 1) {
    durationSeconds = Math.max(0, effectiveSends - 1) * spacing
  } else {
    const lastDaySends = effectiveSends - (spanDays - 1) * dailyVolume
    durationSeconds = (spanDays - 1) * windowSeconds + Math.max(0, lastDaySends - 1) * spacing
  }
  const runtimeCapped = spanDays > 90
  const durationLabel = effectiveSends <= 0
    ? '—'
    : runtimeCapped
      ? '90+ days'
    : spanDays > 1
      ? `~${spanDays} day${spanDays > 1 ? 's' : ''}`
      : formatDurationApprox(durationSeconds)

  const cost = effectiveSends * ESTIMATED_COST_PER_SMS_USD
  return {
    deliverable,
    senderCovered,
    senderCoveragePct,
    effectiveSends,
    durationLabel,
    runtimeCapped,
    spanDays,
    dailyVolume,
    spacingSeconds: spacing,
    windowHours,
    cost,
  }
}

type LaunchReadiness = 'ready' | 'warning' | 'blocked' | 'loading' | 'no_preview'

const computeLaunchReadiness = (
  preview: CampaignPreviewResult | null,
  loading: boolean,
  draftCount: number,
  estimates: LaunchEstimates,
): { status: LaunchReadiness; reasons: string[]; graphPartial: boolean } => {
  if (loading) return { status: 'loading', reasons: [], graphPartial: false }
  if (!preview) return { status: 'no_preview', reasons: ['Run a preview to validate targeting counts.'], graphPartial: false }
  const graphPartial = preview.graph_refresh_scope === 'partial'
  if (estimates.deliverable === 0) return { status: 'blocked', reasons: ['No contacts match the current targeting.'], graphPartial }
  const reasons: string[] = []
  if (graphPartial) reasons.push('Target graph is incomplete — counts reflect a partial market sample, not the full universe')
  if (draftCount > 0) reasons.push(`${draftCount} filter${draftCount !== 1 ? 's' : ''} edited but not applied`)
  if (estimates.senderCoveragePct !== null && estimates.senderCoveragePct < 50) {
    reasons.push(`Low sender coverage (${estimates.senderCoveragePct}%)`)
  }
  return { status: reasons.length > 0 ? 'warning' : 'ready', reasons, graphPartial }
}

const SCHEDULE_PRESETS: Array<{ key: string; label: string; value: () => string }> = [
  { key: 'in_2h', label: 'In 2 hours', value: () => toLocalDateTimeInput(new Date(Date.now() + 2 * 3_600_000)) },
  { key: 'tomorrow_9', label: 'Tomorrow 9 AM', value: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return toLocalDateTimeInput(d) } },
  { key: 'tomorrow_12', label: 'Tomorrow Noon', value: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return toLocalDateTimeInput(d) } },
  { key: 'next_mon_9', label: 'Next Mon 9 AM', value: () => { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + add); d.setHours(9, 0, 0, 0); return toLocalDateTimeInput(d) } },
]

const formatLabel = (value: string): string => {
  if (SPECIAL_DISPLAY_LABELS[value]) return SPECIAL_DISPLAY_LABELS[value]
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const formatScopeLabel = (value: string | undefined | null): string => {
  const normalized = String(value ?? '').trim()
  if (!normalized) return 'Preview'
  if (normalized === 'public.properties' || normalized.startsWith('public.properties.')) return 'Full source'
  if (normalized === 'full_source') return 'Full source'
  if (normalized === 'candidate_window') return 'Preview window'
  if (normalized === 'preview_options') return 'Preview policy'
  return formatLabel(normalized.replace(/[.:]+/g, '_'))
}

const asDiagnosticRecords = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
}

const asStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

const diagnosticFieldKey = (item: Record<string, unknown>): string => {
  return String(item.field_key ?? item.fieldKey ?? item.field ?? item.key ?? '').trim()
}

const diagnosticLabel = (item: Record<string, unknown>, fallback = 'Filter'): string => {
  const explicit = String(item.label ?? '').trim()
  if (explicit) return explicit
  const fieldKey = diagnosticFieldKey(item)
  if (fieldKey) return formatLabel(fieldKey.replace(/[.:]+/g, '_'))
  return fallback
}

const diagnosticReason = (item: Record<string, unknown>, fallback = 'n/a'): string => {
  return String(item.unsupported_reason ?? item.reason ?? item.skipped_reason ?? item.message ?? fallback).trim() || fallback
}

const shortHash = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null
  return normalized.length > 12 ? normalized.slice(0, 12) : normalized
}

const formatPreviewWarning = (warning: string): string => {
  const normalized = warning.toLowerCase()
  if (normalized.includes('campaign_target_graph_select_compat_fallback')) {
    return 'Graph source is missing newer filter columns; using compatible preview columns.'
  }
  if (normalized.includes('campaign_target_graph_count_unavailable') && normalized.includes('does not exist')) {
    return 'Filter applied, but the graph column is missing in the database migration.'
  }
  if (normalized.includes('campaign_target_graph_rows_unavailable') && normalized.includes('does not exist')) {
    return 'Preview source is missing a graph column required by the latest compiler.'
  }
  return warning.replace(/_/g, ' ')
}

const humanizeLaunchBlocker = (value: unknown): string => {
  const raw = String(value ?? '').trim()
  const normalized = raw.toLowerCase()
  if (!raw) return ''
  if (normalized.includes('campaign_status_not_queueable') && normalized.includes('draft')) {
    return 'Save this campaign before scheduling.'
  }
  if (
    normalized.includes('routing_blocked') ||
    normalized.includes('no_valid_textgrid_number') ||
    normalized.includes('missing_sender_route') ||
    normalized.includes('sender_coverage') ||
    normalized.includes('no_sender')
  ) {
    return 'No active sender route covers this audience.'
  }
  if (
    normalized.includes('no_reachable') ||
    normalized.includes('missing_phone') ||
    normalized.includes('no_valid_phone') ||
    normalized.includes('no_best_phone') ||
    normalized.includes('no_phone') ||
    normalized.includes('zero_targets') ||
    normalized.includes('no_targets')
  ) {
    return 'No reachable contacts match this filter.'
  }
  if (normalized.includes('unsupported')) {
    return 'This audience uses a field that is not available for launch yet.'
  }
  return formatLabel(raw.replace(/[.:]+/g, '_'))
}

const humanizeLaunchError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return humanizeLaunchBlocker(raw) || 'Launch could not be prepared. Review the audience and try again.'
}

const valueAsArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((entry) => String(entry))
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

const valueAsRange = (value: unknown): [string, string] => {
  if (Array.isArray(value)) return [String(value[0] ?? ''), String(value[1] ?? '')]
  return ['', '']
}

const draftHasMeaningfulFilters = (draft: CampaignWizardDraft): boolean => {
  return Object.values(draft.target_filters).flat().some((filter) => {
    if (EMPTY_VALUE_OPERATORS.has(filter.operator) || filter.operator === 'is_true' || filter.operator === 'is_false') return true
    if (Array.isArray(filter.value)) return filter.value.some((entry) => String(entry ?? '').trim().length > 0)
    return String(filter.value ?? '').trim().length > 0
  })
}

const makeFilterId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const buildActiveFilterDraft = (
  draft: CampaignWizardDraft,
  statuses: Record<string, FilterStatus>,
): CampaignWizardDraft => {
  const groups = ALL_DOMAIN_KEYS.reduce((acc, domain) => {
    acc[domain] = (draft.target_filters[domain] ?? []).filter(f => statuses[f.id] === 'active')
    return acc
  }, {} as CampaignFilterGroups)
  return { ...draft, target_filters: groups }
}

const isFilterValid = (filter: CampaignFilterCondition, field: CampaignFieldDefinition): boolean => {
  const op = filter.operator
  if (!filter.fieldKey || !op) return false
  if (EMPTY_VALUE_OPERATORS.has(op) || op === 'is_true' || op === 'is_false') return true
  if (field.type === 'boolean') return true
  if (op === 'between') {
    const [a, b] = valueAsRange(filter.value)
    return Boolean(a.trim()) && Boolean(b.trim())
  }
  if (OPTION_OPERATORS.has(op) || (field.supports_options && op !== 'contains')) {
    return valueAsArray(filter.value).length > 0
  }
  if (field.type === 'number') {
    const s = String(filter.value ?? '').trim()
    return s.length > 0 && !Number.isNaN(Number(s))
  }
  return String(filter.value ?? '').trim().length > 0
}

const getFilterValidationMessage = (filter: CampaignFilterCondition, field: CampaignFieldDefinition): string => {
  const op = filter.operator
  if (!filter.fieldKey) return 'Select a field'
  if (!op) return 'Select an operator'
  if (op === 'between') {
    const [a, b] = valueAsRange(filter.value)
    if (!a.trim() || !b.trim()) return 'Enter both min and max values'
  }
  if (OPTION_OPERATORS.has(op) || (field.supports_options && op !== 'contains')) {
    if (valueAsArray(filter.value).length === 0) return 'Select at least one value'
  }
  if (field.type === 'number') {
    const s = String(filter.value ?? '').trim()
    if (!s) return 'Enter a number'
    if (Number.isNaN(Number(s))) return 'Enter a valid number'
  }
  if (!EMPTY_VALUE_OPERATORS.has(op) && op !== 'is_true' && op !== 'is_false' && field.type !== 'boolean') {
    if (!String(filter.value ?? '').trim()) return 'Enter a value'
  }
  return ''
}

const buildCreatePayload = (draft: CampaignWizardDraft): CreateCampaignPayload => ({
  name: draft.name.trim(),
  description: draft.description.trim(),
  status: 'draft',
  campaign_type: 'outbound_sms',
  template_use_case: draft.template_use_case,
  stage_code: draft.stage_code,
  target_filters: {
    catalog_version: 'locked_approved_campaign_fields_v1',
    filter_mode: 'grouped_source_of_truth_domains',
    ...serializeFilterGroups(draft.target_filters),
  } as unknown as CreateCampaignPayload['target_filters'],
})

const buildLaunchPayload = (settings: LaunchSettings): CampaignLaunchPayload => {
  const isLive = settings.mode === 'live'
  const isNoSend = settings.mode === 'no_send'
  const firstScheduledDate = settings.first_scheduled_at ? new Date(settings.first_scheduled_at) : null
  const firstScheduledAt = firstScheduledDate && !Number.isNaN(firstScheduledDate.getTime())
    ? firstScheduledDate.toISOString()
    : undefined

  return {
    dry_run: settings.mode === 'dry_run',
    no_send: isNoSend,
    confirm_live: isLive,
    create_send_queue_rows: isLive,
    explicit_operator_action: true,
    pacing: settings.pacing,
    max_targets: parsePositiveInt(settings.max_targets, 1),
    daily_cap: parsePositiveInt(settings.daily_cap, 750),
    per_sender_cap: parsePositiveInt(settings.per_sender_cap, 150),
    per_market_cap: parsePositiveInt(settings.per_market_cap, 400),
    first_scheduled_at: firstScheduledAt,
    spread_interval_seconds: parsePositiveInt(settings.spread_interval_seconds, 45),
    contact_window_start: settings.contact_window_start,
    contact_window_end: settings.contact_window_end,
  }
}

const launchModeLabel = (mode: CampaignLaunchMode): string => {
  if (mode === 'dry_run') return 'Preview'
  if (mode === 'no_send') return 'Schedule'
  return 'Activation'
}

const getLaunchSummaryValue = (
  result: CampaignLaunchResult | null,
  key: keyof NonNullable<CampaignLaunchResult['launch_summary']> | keyof CampaignLaunchResult,
) => {
  if (!result) return undefined
  const summary = result.launch_summary ?? {}
  return (summary as Record<string, unknown>)[key as string] ?? (result as Record<string, unknown>)[key as string]
}

export const CreateCampaignModal = ({ onClose, onSuccess }: CreateCampaignModalProps) => {
  const [draft, setDraft] = useState<CampaignWizardDraft>(() => createDefaultDraft())
  const [filterStatuses, setFilterStatuses] = useState<Record<string, FilterStatus>>({})
  const [catalog, setCatalog] = useState<CampaignFieldCatalog | null>(null)
  const [activeDomain, setActiveDomain] = useState<CampaignDomainKey>('properties')
  const [fieldSearch, setFieldSearch] = useState<Record<string, string>>({})
  const [optionSearch, setOptionSearch] = useState<Record<string, string>>({})
  const [optionsCache, setOptionsCache] = useState<Record<string, CampaignFieldOption[]>>({})
  const [optionStatus, setOptionStatus] = useState<Record<string, OptionLoadState>>({})
  const [preview, setPreview] = useState<CampaignPreviewResult | null>(null)
  const [isCatalogLoading, setIsCatalogLoading] = useState(true)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isLaunching, setIsLaunching] = useState(false)
  const [fieldPickerState, setFieldPickerState] = useState<{ domain: CampaignDomainKey; category: string } | null>(null)
  const [previewMeta, setPreviewMeta] = useState<PreviewMeta | null>(null)
  const [savedCampaignId, setSavedCampaignId] = useState<string | null>(null)
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings>(() => createDefaultLaunchSettings())
  const [launchPanelExpanded, setLaunchPanelExpanded] = useState(false)
  const [pendingLivePayload, setPendingLivePayload] = useState<CampaignLaunchPayload | null>(null)
  const [pendingLaunchIntent, setPendingLaunchIntent] = useState<'schedule' | 'activate'>('schedule')
  const [launchResult, setLaunchResult] = useState<CampaignLaunchResult | null>(null)
  const latestPreviewRequestRef = useRef<string | null>(null)
  const previewSequenceRef = useRef(0)
  const previewResultRef = useRef<CampaignPreviewResult | null>(null)

  const activeFilterDraft = useMemo(
    () => buildActiveFilterDraft(draft, filterStatuses),
    [draft, filterStatuses],
  )
  const hasMeaningfulFilters = draftHasMeaningfulFilters(activeFilterDraft)
  const activePreviewKey = useMemo(() => {
    const filters = serializeFilterGroups(activeFilterDraft.target_filters)
    return JSON.stringify({
      filters,
      template_use_case: activeFilterDraft.template_use_case,
      stage_code: activeFilterDraft.stage_code,
    })
  }, [activeFilterDraft])

  useEffect(() => {
    let cancelled = false
    setIsCatalogLoading(true)
    getFieldCatalog()
      .then((data) => {
        if (!cancelled) setCatalog(data)
      })
      .catch((error) => {
        console.error('[CreateCampaignModal] catalog load failed', error)
        emitNotification({ title: 'Campaign catalog unavailable', detail: 'The approved field catalog could not load.', severity: 'critical' })
      })
      .finally(() => {
        if (!cancelled) setIsCatalogLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const runPreview = useCallback((reason: 'auto' | 'manual' = 'auto') => {
    const sequence = previewSequenceRef.current + 1
    previewSequenceRef.current = sequence
    const requestId = `campaign-preview-${Date.now()}-${sequence}`
    latestPreviewRequestRef.current = requestId
    const activeCount = Object.values(activeFilterDraft.target_filters).reduce((sum, filters) => sum + filters.length, 0)
    const previous = previewResultRef.current
    const t0 = Date.now()
    setIsPreviewLoading(true)
    previewTargets(activeFilterDraft, { requestId })
      .then((result) => {
        if (latestPreviewRequestRef.current !== requestId) return
        const previousTotal = previous?.total_matched ?? null
        const countUnchanged = previousTotal !== null && activeCount > 0 && previousTotal === result.total_matched
        previewResultRef.current = result
        setPreview(result)
        setPreviewMeta({
          ms: result.query_ms ?? Date.now() - t0,
          ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          requestId: result.request_id ?? requestId,
          resultHash: result.result_hash ?? null,
          previousTotalMatched: previousTotal,
          countUnchanged,
        })
        if (import.meta.env.DEV) {
          console.info('[CreateCampaignModal] preview updated', {
            reason,
            requestId,
            resultHash: result.result_hash,
            totalMatched: result.total_matched,
          })
        }
      })
      .catch((error) => {
        if (latestPreviewRequestRef.current !== requestId) return
        console.error('[CreateCampaignModal] preview failed', error)
        setPreview(null)
        previewResultRef.current = null
        emitNotification({
          title: 'Campaign preview failed',
          detail: error instanceof Error ? error.message : String(error),
          severity: 'critical',
        })
      })
      .finally(() => {
        if (latestPreviewRequestRef.current === requestId) setIsPreviewLoading(false)
      })
  }, [activeFilterDraft, activePreviewKey])

  useEffect(() => {
    runPreview('auto')
    // activePreviewKey is the serialized active-filter contract; draft-only edits should not trigger preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePreviewKey])

  const fieldsByKey = useMemo(() => {
    const map = new Map((catalog?.fields ?? []).map((field) => [field.key, field]))
    // Resolve legacy geography keys from saved campaigns to their canonical field def.
    for (const [legacyKey, canonicalKey] of Object.entries(CAMPAIGN_FIELD_KEY_ALIASES)) {
      const canonicalField = map.get(canonicalKey)
      if (canonicalField && !map.has(legacyKey)) map.set(legacyKey, canonicalField)
    }
    return map
  }, [catalog])

  const activeDomainDefinition = useMemo(() => {
    return catalog?.domains.find((domain) => domain.key === activeDomain) ?? null
  }, [activeDomain, catalog])

  const activeDomainFields = catalog?.fieldsByDomain[activeDomain] ?? []
  const totalActiveCount = useMemo(
    () => Object.values(activeFilterDraft.target_filters).reduce((sum, filters) => sum + filters.length, 0),
    [activeFilterDraft],
  )
  const totalDraftCount = useMemo(
    () => Object.values(draft.target_filters).flat().filter(f => filterStatuses[f.id] !== 'active').length,
    [draft, filterStatuses],
  )
  const canSaveDraft = Boolean(draft.name.trim()) || Object.values(draft.target_filters).flat().length > 0
  const canRunLaunch = Boolean(draft.name.trim()) && canSaveDraft

  const optionCacheKey = (fieldKey: string, search = '') => `${fieldKey}::${search}`

  const loadOptions = (fieldKey: string, search = '') => {
    const cacheKey = optionCacheKey(fieldKey, search)
    if (optionsCache[cacheKey] || optionStatus[cacheKey]?.loading) return
    setOptionStatus((prev) => ({
      ...prev,
      [cacheKey]: { loading: true },
    }))
    searchFieldOptions(fieldKey, search)
      .then((items) => {
        setOptionsCache((prev) => ({ ...prev, [cacheKey]: items }))
        const degradedItem = items.find((item) => item.degraded)
        setOptionStatus((prev) => ({
          ...prev,
          [cacheKey]: {
            loading: false,
            degraded: Boolean(degradedItem),
            message: degradedItem?.degradedReason,
          },
        }))
      })
      .catch((error) => {
        console.error('[CreateCampaignModal] option search failed', { fieldKey, error })
        setOptionStatus((prev) => ({
          ...prev,
          [cacheKey]: {
            loading: false,
            message: 'Options unavailable',
          },
        }))
      })
  }

  const updateDraftRoot = (key: keyof Omit<CampaignWizardDraft, 'target_filters'>, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const updateFilterGroups = (updater: (groups: CampaignFilterGroups) => CampaignFilterGroups) => {
    setDraft((prev) => ({ ...prev, target_filters: updater(prev.target_filters) }))
  }

  const addFilterForField = (field: CampaignFieldDefinition) => {
    const operator = defaultOperatorForField(field)
    const filter: CampaignFilterCondition = {
      id: makeFilterId(),
      domain: field.domain,
      category: field.category,
      fieldKey: field.key,
      operator,
      value: defaultValueForField(field, operator),
    }
    updateFilterGroups((groups) => ({
      ...groups,
      [field.domain]: [...groups[field.domain], filter],
    }))
    setFilterStatuses((prev) => ({ ...prev, [filter.id]: 'editing_new' }))
    setFieldPickerState(null)
    if (field.supports_options) loadOptions(field.key)
  }

  const setFilter = (filter: CampaignFilterCondition, field: CampaignFieldDefinition) => {
    if (!isFilterValid(filter, field)) return
    setFilterStatuses((prev) => ({ ...prev, [filter.id]: 'active' }))
  }

  const editFilter = (filterId: string) => {
    setFilterStatuses((prev) => ({ ...prev, [filterId]: 'editing_saved' }))
    const filter = Object.values(draft.target_filters).flat().find(f => f.id === filterId)
    if (filter) {
      const field = fieldsByKey.get(filter.fieldKey)
      if (field?.supports_options) loadOptions(filter.fieldKey)
    }
  }

  const cancelDraftFilter = (filter: CampaignFilterCondition) => {
    updateFilterGroups((groups) => ({
      ...groups,
      [filter.domain]: groups[filter.domain].filter((entry) => entry.id !== filter.id),
    }))
    setFilterStatuses((prev) => {
      const next = { ...prev }
      delete next[filter.id]
      return next
    })
  }

  const updateFilter = (filter: CampaignFilterCondition, patch: Partial<CampaignFilterCondition>) => {
    updateFilterGroups((groups) => ({
      ...groups,
      [filter.domain]: groups[filter.domain].map((entry) => (
        entry.id === filter.id ? { ...entry, ...patch } : entry
      )),
    }))
  }

  const removeFilter = (filter: CampaignFilterCondition) => {
    updateFilterGroups((groups) => ({
      ...groups,
      [filter.domain]: groups[filter.domain].filter((entry) => entry.id !== filter.id),
    }))
    setFilterStatuses((prev) => {
      const next = { ...prev }
      delete next[filter.id]
      return next
    })
  }

  const changeField = (filter: CampaignFilterCondition, nextFieldKey: string) => {
    const field = fieldsByKey.get(nextFieldKey)
    if (!field) return
    const operator = defaultOperatorForField(field)
    updateFilter(filter, {
      fieldKey: field.key,
      category: field.category,
      operator,
      value: defaultValueForField(field, operator),
    })
    setFieldSearch((prev) => ({ ...prev, [filter.id]: '' }))
    setOptionSearch((prev) => ({ ...prev, [filter.id]: '' }))
    if (field.supports_options) loadOptions(field.key)
  }

  const changeOperator = (filter: CampaignFilterCondition, field: CampaignFieldDefinition, operator: string) => {
    updateFilter(filter, {
      operator,
      value: defaultValueForField(field, operator),
    })
  }

  const handleOptionSearch = (filter: CampaignFilterCondition, field: CampaignFieldDefinition, search: string) => {
    setOptionSearch((prev) => ({ ...prev, [filter.id]: search }))
    loadOptions(field.key, search)
  }

  const getCachedOptions = (filter: CampaignFilterCondition): CampaignFieldOption[] => {
    const field = fieldsByKey.get(filter.fieldKey)
    if (!field?.supports_options) return []
    const search = optionSearch[filter.id] ?? ''
    return optionsCache[optionCacheKey(field.key, search)] ?? optionsCache[optionCacheKey(field.key)] ?? []
  }

  const getValueLabel = (filter: CampaignFilterCondition, field: CampaignFieldDefinition): string => {
    const op = filter.operator
    if (EMPTY_VALUE_OPERATORS.has(op)) return '(no value required)'
    if (op === 'is_true') return 'True'
    if (op === 'is_false') return 'False'
    if (field.type === 'boolean') return op === 'is_true' ? 'True' : 'False'
    if (op === 'between') {
      const [a, b] = valueAsRange(filter.value)
      return `${a} – ${b}`
    }
    const values = valueAsArray(filter.value)
    if (values.length > 0) {
      const cached = optionsCache[optionCacheKey(field.key)] ?? optionsCache[optionCacheKey(field.key, '')] ?? []
      const labelMap = new Map(cached.map(o => [o.value, o.label]))
      const labels = values.map(v => labelMap.get(v) ?? v)
      if (labels.length <= 3) return labels.join(', ')
      return `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`
    }
    return String(filter.value ?? '').trim() || '—'
  }

  const saveCampaign = async () => {
    if (!draft.name.trim()) {
      emitNotification({ title: 'Campaign name required', detail: 'Add a campaign name before saving.', severity: 'warning' })
      return
    }
    try {
      setIsSaving(true)
      const newCampaignId = await createCampaign(buildCreatePayload(activeFilterDraft))
      setSavedCampaignId(newCampaignId)
      emitNotification({ title: 'Campaign Draft Created', detail: 'The approved targeting catalog was saved with the draft.', severity: 'success' })
      onSuccess(newCampaignId)
    } catch (error) {
      emitNotification({ title: 'Creation Failed', detail: String(error), severity: 'critical' })
    } finally {
      setIsSaving(false)
    }
  }

  const closeModal = () => {
    if (savedCampaignId) {
      onSuccess(savedCampaignId)
      return
    }
    onClose()
  }

  const updateLaunchSetting = (patch: Partial<LaunchSettings>) => {
    setLaunchSettings((prev) => {
      const next = { ...prev, ...patch }
      // Hand-editing a throttle drops the campaign into Custom pacing unless the
      // patch itself set the pacing mode (i.e. a preset was just applied).
      if (
        patch.pacing === undefined &&
        ('daily_cap' in patch || 'spread_interval_seconds' in patch || 'per_sender_cap' in patch || 'per_market_cap' in patch)
      ) {
        next.pacing = 'custom'
      }
      return next
    })
  }

  const applyPacingPreset = (key: PacingMode) => {
    const preset = PACING_PRESET_BY_KEY.get(key)
    if (!preset) return
    if (key === 'custom') {
      updateLaunchSetting({ pacing: 'custom' })
      return
    }
    updateLaunchSetting({
      pacing: key,
      daily_cap: preset.daily_cap,
      spread_interval_seconds: preset.spread_interval_seconds,
      per_sender_cap: preset.per_sender_cap,
      per_market_cap: preset.per_market_cap,
    })
  }

  const ensureCampaignForLaunch = async (): Promise<string | null> => {
    if (savedCampaignId) return savedCampaignId
    if (!draft.name.trim()) {
      emitNotification({ title: 'Campaign name required', detail: 'Add a campaign name before launch execution.', severity: 'warning' })
      return null
    }
    const newCampaignId = await createCampaign(buildCreatePayload(activeFilterDraft))
    setSavedCampaignId(newCampaignId)
    emitNotification({ title: 'Campaign draft saved', detail: 'Launch execution is now attached to the saved campaign.', severity: 'success' })
    return newCampaignId
  }

  const executeLaunch = async (payload: CampaignLaunchPayload, mode: CampaignLaunchMode) => {
    try {
      setIsLaunching(true)
      setLaunchResult(null)
      const campaignId = await ensureCampaignForLaunch()
      if (!campaignId) return

      let targetBuild: CampaignLaunchResult['target_build'] = null
      if (mode === 'no_send' || mode === 'live') {
        targetBuild = await buildCampaignTargetSnapshots(campaignId, {
          limit: payload.max_targets,
        })
      }

      const result = await launchCampaign(campaignId, payload)
      const resultWithBuild = { ...result, target_build: targetBuild }
      setLaunchResult(resultWithBuild)
      emitNotification({
        title: result.ok === false ? 'Launch blocked' : `${launchModeLabel(mode)} complete`,
        detail: `${formatNumber(getLaunchSummaryValue(resultWithBuild, 'targets_created') as number)} targets planned, ${formatNumber(getLaunchSummaryValue(resultWithBuild, 'queue_rows_created') as number)} queue rows created.`,
        severity: result.ok === false ? 'warning' : 'success',
      })
    } catch (error) {
      emitNotification({ title: 'Launch execution failed', detail: humanizeLaunchError(error), severity: 'critical' })
    } finally {
      setIsLaunching(false)
      setPendingLivePayload(null)
    }
  }

  // Activation flow: Preview runs a plan (no rows); Schedule/Activate are live and
  // always pass through the launch summary modal before any queue rows are created.
  const runLaunch = (mode: CampaignLaunchMode, overrides: Partial<LaunchSettings> = {}, intent: 'schedule' | 'activate' = 'schedule') => {
    if (!canRunLaunch) {
      emitNotification({ title: 'Campaign name required', detail: 'Add a campaign name before scheduling or activating.', severity: 'warning' })
      return
    }
    const mergedSettings = { ...launchSettings, ...overrides, mode }
    if (Object.keys(overrides).length) setLaunchSettings(mergedSettings)
    const payload = buildLaunchPayload(mergedSettings)
    if (mode === 'live') {
      setPendingLaunchIntent(intent)
      setPendingLivePayload(payload)
      return
    }
    void executeLaunch(payload, mode)
  }

  const requestPreview = () => runLaunch('dry_run')
  const requestSchedule = () => runLaunch('live', {}, 'schedule')
  const requestActivate = () => runLaunch('live', { first_scheduled_at: toLocalDateTimeInput(new Date(Date.now() + 60_000)) }, 'activate')

  const renderValueControl = (filter: CampaignFilterCondition, field: CampaignFieldDefinition) => {
    const options = getCachedOptions(filter)
    const search = optionSearch[filter.id] ?? ''
    const optionState = optionStatus[optionCacheKey(field.key, search)] ?? optionStatus[optionCacheKey(field.key)]
    const selectedValues = valueAsArray(filter.value)
    const selectedCount = options
      .filter((option) => selectedValues.includes(option.value))
      .reduce((sum, option) => sum + Number(option.count || 0), 0)
    const availableCount = options.reduce((sum, option) => sum + Number(option.count || 0), 0)
    const badgeCount = selectedCount || availableCount

    if (EMPTY_VALUE_OPERATORS.has(filter.operator)) {
      return (
        <div className="cmp-filter-value-cell">
          <input value="No value required" disabled />
        </div>
      )
    }

    if (field.type === 'boolean') {
      return (
        <div className="cmp-filter-value-cell">
          <select
            value={String(filter.operator === 'is_true')}
            onChange={(event) => changeOperator(filter, field, event.target.value === 'true' ? 'is_true' : 'is_false')}
          >
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        </div>
      )
    }

    if (filter.operator === 'between') {
      const [min, max] = valueAsRange(filter.value)
      return (
        <div className="cmp-filter-value-cell cmp-filter-value-cell--range">
          <input
            type={field.type === 'date' ? 'date' : 'number'}
            value={min}
            onChange={(event) => updateFilter(filter, { value: [event.target.value, max] })}
            placeholder="Min"
          />
          <input
            type={field.type === 'date' ? 'date' : 'number'}
            value={max}
            onChange={(event) => updateFilter(filter, { value: [min, event.target.value] })}
            placeholder="Max"
          />
        </div>
      )
    }

    if (field.type === 'number') {
      return (
        <div className="cmp-filter-value-cell">
          <input
            type="number"
            value={String(filter.value ?? '')}
            onChange={(event) => updateFilter(filter, { value: event.target.value })}
            placeholder="Number"
          />
        </div>
      )
    }

    if (field.type === 'date') {
      return (
        <div className="cmp-filter-value-cell">
          <input
            type="date"
            value={String(filter.value ?? '')}
            onChange={(event) => updateFilter(filter, { value: event.target.value })}
          />
        </div>
      )
    }

    if (field.supports_options && OPTION_OPERATORS.has(filter.operator)) {
      return (
        <div className="cmp-filter-value-cell">
          <div className="cmp-option-search">
            <Icon name="search" size={12} />
            <input
              value={optionSearch[filter.id] ?? ''}
              onChange={(event) => handleOptionSearch(filter, field, event.target.value)}
              placeholder="Search values"
            />
            {field.supports_counts && badgeCount > 0 && (
              <span className="cmp-option-count">{formatNumber(badgeCount)}</span>
            )}
            {optionState?.loading && <span className="cmp-option-state">Loading options</span>}
            {optionState?.degraded && !optionState.loading && (
              <span className="cmp-option-state is-degraded">Local options</span>
            )}
          </div>
          <select
            multiple
            size={Math.min(4, Math.max(3, options.length || 3))}
            value={selectedValues}
            onChange={(event) => {
              updateFilter(filter, {
                value: Array.from(event.currentTarget.selectedOptions, (option) => option.value),
              })
            }}
          >
            {optionState?.loading && options.length === 0 ? (
              <option value="" disabled>Loading options...</option>
            ) : null}
            {!optionState?.loading && options.length === 0 ? (
              <option value="" disabled>No values found</option>
            ) : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}{option.count ? ` (${formatNumber(option.count)})` : ''}
              </option>
            ))}
          </select>
        </div>
      )
    }

    return (
      <div className="cmp-filter-value-cell">
        <input
          value={String(filter.value ?? '')}
          onChange={(event) => updateFilter(filter, { value: event.target.value })}
          placeholder={field.type === 'json' ? 'Search JSON/text' : 'Value'}
        />
      </div>
    )
  }

  const renderActiveFilterCard = (filter: CampaignFilterCondition) => {
    const field = fieldsByKey.get(filter.fieldKey)
    if (!field) return null
    const valueLabel = getValueLabel(filter, field)
    const baseOptions = optionsCache[optionCacheKey(field.key)] ?? optionsCache[optionCacheKey(field.key, '')] ?? []
    const selectedValues = valueAsArray(filter.value)
    const optionCount = baseOptions
      .filter(o => selectedValues.includes(o.value))
      .reduce((sum, o) => sum + Number(o.count || 0), 0)
    const operatorLabel = FRIENDLY_OPERATORS[filter.operator] ?? filter.operator

    return (
      <div key={filter.id} className="cmp-active-filter-card">
        <div className="cmp-active-filter-summary">
          <span className="cmp-active-filter-field">{field.label}</span>
          <span className="cmp-active-filter-op">{operatorLabel}</span>
          <span className="cmp-active-filter-value">{valueLabel}</span>
        </div>
        <div className="cmp-active-filter-meta">
          {optionCount > 0 && (
            <span className="cmp-active-filter-badge cmp-active-filter-badge--count">{formatNumber(optionCount)} options</span>
          )}
          <span className="cmp-active-filter-badge cmp-active-filter-badge--domain">{field.domain.replace(/_/g, ' ')}</span>
          {field.supported_in_preview ? (
            <span className="cmp-active-filter-badge cmp-active-filter-badge--preview">Preview ✓</span>
          ) : (
            <span className="cmp-active-filter-badge cmp-active-filter-badge--unsupported">~preview</span>
          )}
          {field.source_column && (
            <span className="cmp-active-filter-badge cmp-active-filter-badge--source">src: {field.source_column}</span>
          )}
          <div className="cmp-active-filter-actions">
            <button type="button" onClick={() => editFilter(filter.id)}>Edit</button>
            <button type="button" onClick={() => removeFilter(filter)}>Remove</button>
          </div>
        </div>
      </div>
    )
  }

  const renderFilterRow = (filter: CampaignFilterCondition, categoryFields: CampaignFieldDefinition[]) => {
    const field = fieldsByKey.get(filter.fieldKey)
    if (!field) return null
    const status = filterStatuses[filter.id]
    const isNew = status === 'editing_new'
    const valid = isFilterValid(filter, field)
    const validationMsg = !valid ? getFilterValidationMessage(filter, field) : ''

    const search = fieldSearch[filter.id] ?? ''
    const searchableFields = categoryFields.filter((candidate) => {
      const haystack = `${candidate.label} ${candidate.key}`.toLowerCase()
      return haystack.includes(search.toLowerCase())
    })

    return (
      <div key={filter.id} className="cmp-filter-row is-editing">
        <div className="cmp-filter-field-cell">
          <label>
            <span>Field</span>
            <div className="cmp-field-search">
              <Icon name="search" size={12} />
              <input
                value={search}
                onChange={(event) => setFieldSearch((prev) => ({ ...prev, [filter.id]: event.target.value }))}
                placeholder="Search approved fields"
              />
            </div>
            <select value={filter.fieldKey} onChange={(event) => changeField(filter, event.target.value)}>
              {searchableFields.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="cmp-filter-operator-cell">
          <span>Operator</span>
          <select value={filter.operator} onChange={(event) => changeOperator(filter, field, event.target.value)}>
            {field.operators.map((operator) => (
              <option key={operator.key} value={operator.key}>
                {FRIENDLY_OPERATORS[operator.key] ?? operator.label}
              </option>
            ))}
          </select>
        </label>

        <label className="cmp-filter-value-wrap">
          <span>Value</span>
          {renderValueControl(filter, field)}
        </label>

        <div className="cmp-filter-meta">
          <span className="cmp-field-type">{field.type}</span>
          {field.supports_options && <span className="cmp-field-type">opts</span>}
          {!field.supported_in_preview && (
            <span className="cmp-unsupported-warning" title="Approved field — not included in preview estimate">
              ~preview
            </span>
          )}
        </div>

        <div className="cmp-filter-actions">
          <button type="button" title="Remove filter" onClick={() => removeFilter(filter)}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="cmp-filter-set-bar">
          <span className="cmp-filter-validation-msg">{validationMsg}</span>
          <div className="cmp-filter-set-actions">
            {isNew && (
              <button type="button" className="cmp-filter-cancel-btn" onClick={() => cancelDraftFilter(filter)}>
                Cancel Draft
              </button>
            )}
            <button
              type="button"
              className="cmp-filter-set-btn"
              disabled={!valid}
              title={!valid ? validationMsg : 'Set filter — applies to preview'}
              onClick={() => setFilter(filter, field)}
            >
              Set Filter
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (isCatalogLoading || !catalog || !activeDomainDefinition) {
    return createPortal(
      <div className="cmp-studio-overlay">
        <div className="cmp-studio">
          <div className="cmp-studio-loading">Loading catalog...</div>
        </div>
      </div>,
      document.body,
    )
  }

  const degradedOptionState = Object.values(optionStatus).find((state) => state.degraded)
  const backendDegraded = Boolean(catalog.degraded || preview?.degraded || degradedOptionState)
  const backendDegradedMessage = preview?.degradedReason ?? catalog.degradedReason ?? degradedOptionState?.message ?? 'Backend degraded / using local preview fallback'
  const launchEstimates = computeLaunchEstimates(preview, launchSettings)
  const launchReadiness = computeLaunchReadiness(preview, isPreviewLoading, totalDraftCount, launchEstimates)
  // Schedule/Activate require a live backend preview. Degraded (local-fallback) state or no
  // preview mean counts are unknown — block the action rather than let operators launch blind.
  const canScheduleNow = canRunLaunch && !isPreviewLoading && preview !== null && !backendDegraded

  const modal = (
    <div className="cmp-studio-overlay">
      <div className="cmp-studio cmp-studio--catalog">
        <div className="cmp-studio-workspace">
          <div className="cmp-studio-header">
            <div>
              <div className="cmp-studio-title">
                New Campaign
                <span className="cmp-anchor-pill">Properties Anchor</span>
              </div>
              <div className="cmp-studio-subtitle">Approved field catalog — grouped by source-of-truth domain</div>
            </div>
            <button className="cmp-studio-close" onClick={closeModal} title="Close">
              <Icon name="x" size={16} />
            </button>
          </div>

          <div className="cmp-mission-strip">
            <label>
              <span>Campaign Name</span>
              <input
                value={draft.name}
                onChange={(event) => updateDraftRoot('name', event.target.value)}
                placeholder="e.g. Dallas high-equity first touch"
              />
            </label>
            <label>
              <span>Scenario</span>
              <select value={draft.template_use_case} onChange={(event) => updateDraftRoot('template_use_case', event.target.value)}>
                <option value="ownership_check">Ownership Check</option>
                <option value="consider_selling">Consider Selling</option>
                <option value="seller_asking_price">Asking Price</option>
              </select>
            </label>
            <label>
              <span>Stage</span>
              <select value={draft.stage_code} onChange={(event) => updateDraftRoot('stage_code', event.target.value)}>
                <option value="first_touch">First Touch</option>
                <option value="second_touch">Second Touch</option>
                <option value="reengagement">Reengagement</option>
              </select>
            </label>
            <label className="cmp-mission-description">
              <span>Description</span>
              <input
                value={draft.description}
                onChange={(event) => updateDraftRoot('description', event.target.value)}
                placeholder="Optional"
              />
            </label>
          </div>

          {backendDegraded ? (
            <div className="cmp-degraded-banner">
              <Icon name="alert" size={14} />
              <span>{backendDegradedMessage}</span>
            </div>
          ) : null}

          <div className={`cmp-launch-execution cmp-launch-execution--activation cmp-launch-execution--polished ${launchPanelExpanded ? 'is-expanded' : ''}`}>
            {launchReadiness.graphPartial && (
              <div className="cmp-draft-filter-warn cmp-graph-stale-warn">
                <Icon name="alert" size={12} />
                <span>Target graph is incomplete — counts reflect a partial market sample ({preview?.graph_row_count?.toLocaleString() ?? '?'} rows). A full rebuild is required to show the real universe.</span>
              </div>
            )}
            {totalDraftCount > 0 && (
              <div className="cmp-draft-filter-warn">
                <Icon name="alert-circle" size={12} />
                <span>{totalDraftCount} filter{totalDraftCount !== 1 ? 's' : ''} edited but not applied — set them to include in targeting counts</span>
              </div>
            )}
            <div className="cmp-readiness-strip" role="group" aria-label="Launch readiness">
              <div className="cmp-readiness-hero">
                <span className="cmp-readiness-label">Ready To Schedule</span>
                <div className="cmp-readiness-kpi">
                  <strong className={`cmp-readiness-number${isPreviewLoading ? ' is-loading' : ''}`}>
                    {formatNumber(launchEstimates.deliverable)}
                  </strong>
                  <span className={`cmp-readiness-badge is-${launchReadiness.status}`}>
                    {launchReadiness.status === 'loading' ? 'Updating'
                      : launchReadiness.status === 'no_preview' ? 'No Preview'
                      : launchReadiness.status === 'ready' ? 'Ready'
                      : launchReadiness.status === 'warning' ? 'Review'
                      : 'Blocked'}
                  </span>
                </div>
                {launchReadiness.reasons.length > 0 && (
                  <div className="cmp-readiness-reasons">
                    {launchReadiness.reasons.map((r) => <span key={r}>{r}</span>)}
                  </div>
                )}
                <div className="cmp-readiness-secondary">
                  <span>
                    {launchEstimates.senderCoveragePct != null
                      ? `${launchEstimates.senderCoveragePct}% sender coverage`
                      : `${formatNumber(launchEstimates.senderCovered)} covered`}
                  </span>
                  <span>{formatNumber(launchEstimates.dailyVolume)}/day</span>
                  <span>{launchEstimates.durationLabel}</span>
                  <span>{formatUsdApprox(launchEstimates.cost)} est.</span>
                </div>
              </div>
              <div className="cmp-readiness-actions">
                <div className="cmp-readiness-sched-wrap">
                  <span className="cmp-readiness-sched-label">Schedule for</span>
                  <span className="cmp-readiness-sched-value">{formatDateTime(launchSettings.first_scheduled_at)}</span>
                </div>
                <div className="cmp-readiness-actions-row">
                  <button
                    type="button"
                    className="cmp-launch-btn is-accent cmp-launch-strip-cta"
                    disabled={isLaunching || !canScheduleNow}
                    title={
                      !canRunLaunch ? 'Add a campaign name first'
                        : isPreviewLoading ? 'Wait for targeting count to update'
                        : backendDegraded ? 'Cannot schedule while backend is degraded — counts are unavailable'
                        : preview === null ? 'Run a preview first to confirm targeting counts before scheduling'
                        : 'Schedule this campaign for the selected time'
                    }
                    onClick={requestSchedule}
                  >
                    {isLaunching ? 'Working…' : 'Schedule'}
                  </button>
                  <button
                    type="button"
                    className="cmp-launch-advanced-toggle"
                    onClick={() => setLaunchPanelExpanded((value) => !value)}
                    aria-expanded={launchPanelExpanded}
                    title="Advanced settings"
                  >
                    Advanced
                    <Icon name="chevron-down" size={12} />
                  </button>
                </div>
              </div>
            </div>

            {launchPanelExpanded && (
              <div className="cmp-launch-expanded">
                <div className="cmp-activation-controls">
                  <label className="cmp-launch-mini-field">
                    <span>Send Cap</span>
                    <input
                      type="number"
                      min={1}
                      value={launchSettings.max_targets}
                      onChange={(event) => updateLaunchSetting({ max_targets: event.target.value })}
                    />
                  </label>

                  <label className="cmp-launch-mini-field cmp-launch-mini-field--time">
                    <span>Schedule</span>
                    <input
                      type="datetime-local"
                      value={launchSettings.first_scheduled_at}
                      onChange={(event) => updateLaunchSetting({ first_scheduled_at: event.target.value })}
                    />
                  </label>

                  <div className="cmp-schedule-presets" role="group" aria-label="Quick schedule presets">
                    {SCHEDULE_PRESETS.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        className="cmp-schedule-preset"
                        onClick={() => updateLaunchSetting({ first_scheduled_at: preset.value() })}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <div className="cmp-pacing-block">
                    <span className="cmp-pacing-block-label">Pacing</span>
                    <div className="cmp-pacing-presets" role="group" aria-label="Pacing presets">
                      {PACING_PRESETS.map((preset) => (
                        <button
                          key={preset.key}
                          type="button"
                          className={`cmp-pacing-preset ${launchSettings.pacing === preset.key ? 'is-active' : ''}`}
                          onClick={() => applyPacingPreset(preset.key)}
                          title={preset.blurb}
                        >
                          <strong>{preset.label}</strong>
                          {preset.key !== 'custom' && <span>{formatNumber(Number(preset.daily_cap))}/day</span>}
                        </button>
                      ))}
                    </div>
                    <div className="cmp-pacing-readout" role="group" aria-label="Pacing summary">
                      <span><em>Messages/day</em><strong>{formatNumber(launchEstimates.dailyVolume)}/day</strong></span>
                      <span><em>Spacing</em><strong>{launchEstimates.spacingSeconds}s</strong></span>
                      <span><em>Sender cap</em><strong>{formatNumber(parsePositiveInt(launchSettings.per_sender_cap, 150))}/day</strong></span>
                      <span><em>Market cap</em><strong>{formatNumber(parsePositiveInt(launchSettings.per_market_cap, 400))}/day</strong></span>
                      <span><em>Runtime</em><strong>{launchEstimates.durationLabel}</strong></span>
                    </div>
                  </div>
                </div>

                <div className="cmp-activation-actions">
                  <button
                    type="button"
                    className="cmp-launch-btn cmp-launch-btn--ghost"
                    disabled={isLaunching || !canRunLaunch}
                    title="Run a targeting plan — no queue rows created"
                    onClick={requestPreview}
                  >
                    Preview Targeting
                  </button>
                  <button
                    type="button"
                    className="cmp-launch-btn cmp-launch-btn--outline"
                    disabled={isLaunching || !canScheduleNow}
                    title={
                      !canRunLaunch ? 'Add a campaign name first'
                        : isPreviewLoading ? 'Wait for targeting count to update'
                        : backendDegraded ? 'Cannot schedule while backend is degraded — counts are unavailable'
                        : preview === null ? 'Run a preview first to confirm targeting counts before scheduling'
                        : 'Schedule this campaign for the selected time'
                    }
                    onClick={requestSchedule}
                  >
                    Schedule Campaign
                  </button>
                  <button
                    type="button"
                    className="cmp-launch-btn is-accent"
                    disabled={isLaunching || !canScheduleNow}
                    title={
                      !canRunLaunch ? 'Add a campaign name first'
                        : isPreviewLoading ? 'Wait for targeting count to update'
                        : backendDegraded ? 'Cannot activate while backend is degraded — counts are unavailable'
                        : preview === null ? 'Run a preview first to confirm targeting counts before activating'
                        : 'Activate now — send queue starts immediately'
                    }
                    onClick={requestActivate}
                  >
                    {isLaunching ? 'Working…' : 'Activate Campaign'}
                  </button>
                </div>

                <details className="cmp-launch-advanced" open={launchSettings.pacing === 'custom'}>
                  <summary>
                    <span>Advanced Settings</span>
                    <Icon name="chevron-down" size={12} />
                  </summary>
                  <div className="cmp-launch-field-grid cmp-launch-field-grid--advanced">
                    <label>
                      <span>Daily Cap</span>
                      <input
                        type="number"
                        min={1}
                        value={launchSettings.daily_cap}
                        onChange={(event) => updateLaunchSetting({ daily_cap: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Sender Cap</span>
                      <input
                        type="number"
                        min={1}
                        value={launchSettings.per_sender_cap}
                        onChange={(event) => updateLaunchSetting({ per_sender_cap: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Market Cap</span>
                      <input
                        type="number"
                        min={1}
                        value={launchSettings.per_market_cap}
                        onChange={(event) => updateLaunchSetting({ per_market_cap: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Spacing Seconds</span>
                      <input
                        type="number"
                        min={1}
                        value={launchSettings.spread_interval_seconds}
                        onChange={(event) => updateLaunchSetting({ spread_interval_seconds: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Window Start</span>
                      <input
                        type="time"
                        value={launchSettings.contact_window_start}
                        onChange={(event) => updateLaunchSetting({ contact_window_start: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Window End</span>
                      <input
                        type="time"
                        value={launchSettings.contact_window_end}
                        onChange={(event) => updateLaunchSetting({ contact_window_end: event.target.value })}
                      />
                    </label>
                  </div>
                </details>
              </div>
            )}
          </div>

          <div className="cmp-domain-tabs">
            {catalog.domains.map((domain) => {
              const count = activeFilterDraft.target_filters[domain.key].length
              return (
                <button
                  key={domain.key}
                  className={`cmp-domain-tab ${activeDomain === domain.key ? 'is-active' : ''} ${domain.key === 'properties' ? 'is-anchor' : ''}`}
                  onClick={() => { setActiveDomain(domain.key); setFieldPickerState(null) }}
                >
                  <span>{domain.tabLabel}</span>
                  {count > 0 && <strong>{count}</strong>}
                </button>
              )
            })}
          </div>

          <div className="cmp-anchor-explanation">
            <Icon name="database" size={11} />
            Every campaign begins with a property. Prospect, owner, phone, outreach, and sender filters refine who can be contacted.
          </div>

          <div className="cmp-studio-content">
            <div className="cmp-domain-heading">
              <div>
                <span className="cmp-domain-kicker">{formatLabel(activeDomainDefinition.key)}</span>
                <h3>{activeDomainDefinition.tabLabel}</h3>
              </div>
              <div className={`cmp-domain-sot ${activeDomain === 'properties' ? 'is-anchor' : ''}`}>
                <Icon name={activeDomain === 'properties' ? 'database' : 'layers'} size={14} />
                <span>{activeDomainDefinition.sourceOfTruth}</span>
              </div>
            </div>

            <div className="cmp-category-stack">
              {activeDomainDefinition.categories.map((category) => {
                const categoryFields = activeDomainFields.filter((field) => field.category === category)
                const categoryFilters = draft.target_filters[activeDomain].filter((filter) => filter.category === category)
                const activeInCategory = categoryFilters.filter(f => filterStatuses[f.id] === 'active').length
                const draftInCategory = categoryFilters.filter(f => filterStatuses[f.id] !== 'active').length
                const suggestedKeys = SUGGESTED_FIELD_KEYS[`${activeDomain}.${category}`] ?? []
                const isPickerOpen = fieldPickerState?.domain === activeDomain && fieldPickerState?.category === category

                return (
                  <section key={category} className="cmp-filter-category">
                    <div className="cmp-filter-category-header">
                      <div>
                        <span>{category}</span>
                        <strong>{categoryFields.length} fields</strong>
                        {activeInCategory > 0 && (
                          <em className="cmp-category-count cmp-category-count--active">{activeInCategory} active</em>
                        )}
                        {draftInCategory > 0 && (
                          <em className="cmp-category-count cmp-category-count--draft">{draftInCategory} draft</em>
                        )}
                      </div>
                      <button
                        type="button"
                        className={isPickerOpen ? 'is-active' : ''}
                        onClick={() => {
                          setFieldPickerState(isPickerOpen ? null : { domain: activeDomain, category })
                        }}
                      >
                        <Icon name="filter" size={13} />
                        Add Filter
                      </button>
                    </div>

                    {isPickerOpen && (
                      <FieldPickerInline
                        categoryFields={categoryFields}
                        suggestedKeys={suggestedKeys}
                        onPick={addFilterForField}
                        onClose={() => setFieldPickerState(null)}
                      />
                    )}

                    {categoryFilters.length > 0 ? (
                      <div className="cmp-filter-row-stack">
                        {categoryFilters.map((filter) => {
                          const status = filterStatuses[filter.id]
                          if (status === 'active') {
                            return renderActiveFilterCard(filter)
                          }
                          return renderFilterRow(filter, categoryFields)
                        })}
                      </div>
                    ) : (
                      <div className="cmp-empty-category">
                        {suggestedKeys.length > 0 && (
                          <>
                            <div className="cmp-suggested-label">Suggested</div>
                            <div className="cmp-suggested-chips">
                              {suggestedKeys
                                .map((key) => fieldsByKey.get(key))
                                .filter((f): f is CampaignFieldDefinition => !!f)
                                .map((field) => (
                                  <button
                                    key={field.key}
                                    className="cmp-suggested-chip"
                                    onClick={() => addFilterForField(field)}
                                    title={field.description}
                                  >
                                    + {field.label}
                                  </button>
                                ))
                              }
                              <button
                                className="cmp-suggested-chip cmp-suggested-chip--more"
                                onClick={() => setFieldPickerState({ domain: activeDomain, category })}
                              >
                                Browse all {categoryFields.length}…
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          </div>

          <div className="cmp-studio-footer">
            <div className="cmp-footer-left">
              <button className="cmp-btn-ghost" onClick={closeModal}>Cancel</button>
              <div className="cmp-footer-status">
                <strong>{totalActiveCount}</strong>
                <span>active filter{totalActiveCount !== 1 ? 's' : ''}</span>
                {totalDraftCount > 0 && (
                  <span className="cmp-footer-draft-notice">{totalDraftCount} draft not applied</span>
                )}
              </div>
            </div>
            <div className="cmp-launch-bar">
              <div className="cmp-launch-btn-wrap">
                <button
                  className="cmp-launch-btn is-primary"
                  onClick={saveCampaign}
                  disabled={isSaving || !canSaveDraft}
                  title={canSaveDraft ? 'Save as draft' : 'Add a name or filter first'}
                >
                  {isSaving ? 'Saving…' : 'Save Draft'}
                </button>
                {!canSaveDraft && <span className="cmp-launch-btn-reason">Name or filter required</span>}
              </div>
              <div className="cmp-launch-btn-wrap">
                <button
                  className="cmp-launch-btn"
                  disabled={isPreviewLoading}
                  title={hasMeaningfulFilters ? 'Refresh target reach preview' : 'Preview the full property universe'}
                  onClick={() => {
                    runPreview('manual')
                  }}
                >
                  {isPreviewLoading ? 'Updating…' : 'Preview Targets'}
                </button>
                {!hasMeaningfulFilters && totalDraftCount > 0 && (
                  <span className="cmp-launch-btn-reason">Draft filters not included</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <TargetReachPanel
          preview={preview}
          loading={isPreviewLoading}
          activeDomain={activeDomain}
          previewMeta={previewMeta}
          backendDegraded={backendDegraded}
          filterGroups={activeFilterDraft.target_filters}
          totalDraftCount={totalDraftCount}
        />

        {pendingLivePayload && (
          <LaunchConfirmModal
            intent={pendingLaunchIntent}
            settings={launchSettings}
            payload={pendingLivePayload}
            estimates={launchEstimates}
            busy={isLaunching}
            onCancel={() => setPendingLivePayload(null)}
            onConfirm={() => executeLaunch(pendingLivePayload, 'live')}
          />
        )}

        {launchResult && (
          <LaunchSummaryModal
            result={launchResult}
            onClose={() => setLaunchResult(null)}
            onDone={closeModal}
          />
        )}
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

const _LaunchStripMetric = ({
  label,
  value,
  muted,
  accent,
}: {
  label: string
  value: string
  muted?: string
  accent?: boolean
}) => (
  <div className="cmp-launch-strip-metric">
    <span>{label}</span>
    <strong className={accent ? 'is-accent' : ''}>{value}</strong>
    {muted ? <em>{muted}</em> : null}
  </div>
)
void _LaunchStripMetric

const LaunchConfirmModal = ({
  intent,
  payload,
  estimates,
  busy,
  onCancel,
  onConfirm,
}: {
  intent: 'schedule' | 'activate'
  settings: LaunchSettings
  payload: CampaignLaunchPayload
  estimates: LaunchEstimates
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) => {
  const isActivate = intent === 'activate'
  const title = isActivate ? 'Activate Campaign' : 'Schedule Campaign'
  const lede = isActivate
    ? 'Queueing begins immediately within the sending window. Review before going live.'
    : `Targets will be queued for ${formatDateTime(payload.first_scheduled_at)}. Review before scheduling.`
  const confirmLabel = busy ? 'Working…' : isActivate ? 'Activate Campaign' : 'Schedule Campaign'

  return (
    <div className="cmp-nested-modal">
      <div className="cmp-launch-confirm">
        <div className="cmp-launch-confirm__header">
          <Icon name="shield" size={18} />
          <div>
            <h3>{title}</h3>
            <p>{lede}</p>
          </div>
        </div>

        <div className="cmp-launch-confirm__estimates">
          <div className="cmp-est-chip">
            <span className="cmp-est-label">Deliverable</span>
            <strong className="cmp-est-value is-accent">{formatNumber(estimates.effectiveSends)}</strong>
            <span className="cmp-est-sub">of {formatNumber(estimates.deliverable)} ready</span>
          </div>
          <div className="cmp-est-chip">
            <span className="cmp-est-label">Sender Coverage</span>
            <strong className="cmp-est-value">{estimates.senderCoveragePct != null ? `${estimates.senderCoveragePct}%` : formatNumber(estimates.senderCovered)}</strong>
            <span className="cmp-est-sub">{formatNumber(estimates.senderCovered)} covered</span>
          </div>
          <div className="cmp-est-chip">
            <span className="cmp-est-label">Estimated Runtime</span>
            <strong className="cmp-est-value">{estimates.durationLabel}</strong>
            <span className="cmp-est-sub">{isActivate ? 'starting now' : formatDateTime(payload.first_scheduled_at)} · {formatNumber(estimates.dailyVolume)}/day</span>
          </div>
          <div className="cmp-est-chip">
            <span className="cmp-est-label">Est. Cost</span>
            <strong className="cmp-est-value">{formatUsdApprox(estimates.cost)}</strong>
            <span className="cmp-est-sub">~${ESTIMATED_COST_PER_SMS_USD.toFixed(4)}/sms</span>
          </div>
        </div>

        <div className="cmp-launch-confirm__grid">
          <div><span>Pacing</span><strong>{PACING_PRESET_BY_KEY.get(payload.pacing ?? 'custom')?.label ?? 'Custom'}</strong></div>
          <div><span>Send Cap</span><strong>{payload.max_targets}</strong></div>
          <div><span>Daily Cap</span><strong>{payload.daily_cap}</strong></div>
          <div><span>Sender Cap</span><strong>{payload.per_sender_cap ?? '—'}</strong></div>
          <div><span>Market Cap</span><strong>{payload.per_market_cap ?? '—'}</strong></div>
          <div><span>First Send</span><strong>{isActivate ? 'Now' : formatDateTime(payload.first_scheduled_at)}</strong></div>
          <div><span>Spacing</span><strong>{payload.spread_interval_seconds}s</strong></div>
        </div>

        <div className="cmp-launch-confirm__note">
          <Icon name="shield" size={12} />
          <span>Guarded queue: suppression, duplicate prevention, sender balancing, and market-safe routing are enforced on every row.</span>
        </div>

        <div className="cmp-launch-confirm__actions">
          <button type="button" className="cmp-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="cmp-launch-btn is-accent" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const LaunchSummaryModal = ({
  result,
  onClose,
  onDone,
}: {
  result: CampaignLaunchResult
  onClose: () => void
  onDone: () => void
}) => {
  const targetsCreated = Number(getLaunchSummaryValue(result, 'targets_created') ?? 0)
  const queueRowsCreated = Number(getLaunchSummaryValue(result, 'queue_rows_created') ?? result.send_queue_rows_created ?? 0)
  const skippedCount = Number(getLaunchSummaryValue(result, 'skipped_count') ?? 0)
  const blockedCount = Number(getLaunchSummaryValue(result, 'blocked_count') ?? 0)
  const status = String(getLaunchSummaryValue(result, 'status') ?? result.status ?? 'unknown')
  const senderDistribution = (getLaunchSummaryValue(result, 'sender_distribution') ?? []) as NonNullable<CampaignLaunchResult['sender_distribution']>
  const templateDistribution = (getLaunchSummaryValue(result, 'template_distribution') ?? []) as NonNullable<CampaignLaunchResult['template_distribution']>
  const firstScheduledAt = getLaunchSummaryValue(result, 'first_scheduled_at') as string | null | undefined
  const lastScheduledAt = getLaunchSummaryValue(result, 'last_scheduled_at') as string | null | undefined
  const blockers = Array.from(new Set((result.exact_blockers ?? result.blockers ?? [])
    .map(humanizeLaunchBlocker)
    .filter(Boolean)))

  return (
    <div className="cmp-nested-modal">
      <div className="cmp-launch-summary">
        <div className="cmp-launch-summary__header">
          <div>
            <span className={`cmp-summary-status ${result.ok === false ? 'is-degraded' : 'is-ready'}`}>
              {result.ok === false ? 'Blocked' : 'Complete'}
            </span>
            <h3>Launch Summary</h3>
          </div>
          <button className="cmp-studio-close" onClick={onClose} title="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="cmp-launch-summary__grid">
          <Metric label="Contacts Targeted" value={targetsCreated} />
          <Metric label="Messages Scheduled" value={queueRowsCreated} variant="success" />
          <Metric label="Skipped" value={skippedCount} />
          <Metric label="Blocked" value={blockedCount} />
          <div className="cmp-launch-summary__stat">
            <span>First Message</span>
            <strong>{formatDateTime(firstScheduledAt)}</strong>
          </div>
          <div className="cmp-launch-summary__stat">
            <span>Last Message</span>
            <strong>{formatDateTime(lastScheduledAt)}</strong>
          </div>
          <div className="cmp-launch-summary__stat">
            <span>Campaign Status</span>
            <strong>{status.replace(/_/g, ' ')}</strong>
          </div>
          <div className="cmp-launch-summary__stat">
            <span>Snapshots Built</span>
            <strong>{formatNumber(result.target_build?.built_count ?? 0)}</strong>
          </div>
        </div>

        <div className="cmp-launch-summary__columns">
          <DistributionList title="Sender Distribution" items={senderDistribution} />
          <DistributionList title="Message Templates" items={templateDistribution} />
        </div>

        {blockers.length > 0 && (
          <div className="cmp-launch-summary__blockers">
            <span>Blockers</span>
            {blockers.map((blocker) => (
              <strong key={blocker}>{blocker}</strong>
            ))}
          </div>
        )}

        <div className="cmp-launch-confirm__actions">
          <button type="button" className="cmp-btn-ghost" onClick={onClose}>Keep Editing</button>
          <button type="button" className="cmp-launch-btn is-primary" onClick={onDone}>Done</button>
        </div>
      </div>
    </div>
  )
}

const DistributionList = ({
  title,
  items,
}: {
  title: string
  items: NonNullable<CampaignLaunchResult['sender_distribution']>
}) => {
  return (
    <div className="cmp-launch-summary__distribution">
      <span>{title}</span>
      {items.length === 0 ? (
        <em>No rows</em>
      ) : items.slice(0, 8).map((item) => (
        <div key={`${title}-${item.value}`} className="cmp-launch-dist-row">
          <strong>{item.label || item.value || 'unknown'}</strong>
          <span>{formatNumber(item.count)}</span>
        </div>
      ))}
    </div>
  )
}

const FieldPickerInline = ({
  categoryFields,
  suggestedKeys,
  onPick,
  onClose,
}: {
  categoryFields: CampaignFieldDefinition[]
  suggestedKeys: string[]
  onPick: (field: CampaignFieldDefinition) => void
  onClose: () => void
}) => {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filtered = categoryFields.filter((f) => {
    if (!search.trim()) return true
    const hay = `${f.label} ${f.key}`.toLowerCase()
    return hay.includes(search.toLowerCase())
  })

  const suggested = filtered.filter((f) => suggestedKeys.includes(f.key))
  const rest = filtered.filter((f) => !suggestedKeys.includes(f.key))
  const sorted = search.trim() ? filtered : [...suggested, ...rest]

  return (
    <div className="cmp-field-picker">
      <div className="cmp-field-picker-header">
        <div className="cmp-field-picker-search-wrap">
          <Icon name="search" size={13} />
          <input
            ref={inputRef}
            className="cmp-field-picker-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search approved fields…"
          />
        </div>
        <button className="cmp-field-picker-close" onClick={onClose} title="Close">
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="cmp-field-picker-list">
        {sorted.length === 0 && (
          <div className="cmp-field-picker-empty">No fields match "{search}"</div>
        )}
        {!search.trim() && suggested.length > 0 && (
          <div className="cmp-field-picker-group-label">Suggested for this category</div>
        )}
        {sorted.map((field, idx) => {
          const isSuggested = !search.trim() && suggestedKeys.includes(field.key)
          const isFirstRest = !search.trim() && !isSuggested && idx === suggested.length
          return (
            <Fragment key={field.key}>
              {isFirstRest && rest.length > 0 && (
                <div key={`divider-${field.key}`} className="cmp-field-picker-group-label">All Fields</div>
              )}
              <button
                className={`cmp-field-picker-item ${isSuggested ? 'is-suggested' : ''}`}
                onClick={() => onPick(field)}
                title={field.description}
              >
                <span className="cmp-field-picker-label">{field.label}</span>
                <span className="cmp-field-picker-badges">
                  {isSuggested && <span className="cmp-fpbadge cmp-fpbadge--suggested">suggested</span>}
                  <span className="cmp-fpbadge cmp-fpbadge--type">{field.type}</span>
                  {field.supported_in_preview && (
                    <span className="cmp-fpbadge cmp-fpbadge--preview">preview</span>
                  )}
                </span>
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

const TargetReachPanel = ({
  preview,
  loading,
  activeDomain,
  previewMeta,
  backendDegraded,
  filterGroups,
  totalDraftCount,
}: {
  preview: CampaignPreviewResult | null
  loading: boolean
  activeDomain: CampaignDomainKey
  previewMeta: PreviewMeta | null
  backendDegraded: boolean
  filterGroups: CampaignFilterGroups
  totalDraftCount: number
}) => {
  const [developerMode, setDeveloperMode] = useState(false)
  const blockedTotal = preview?.blocked_waterfall.reduce((sum, item) => sum + item.count, 0) ?? 0
  const explicitBlockedSteps = preview?.blocked_reason_waterfall ?? []
  const explicitBlockedTotal = explicitBlockedSteps.reduce((sum, item) => sum + item.count, 0)
  const eligibilitySteps = preview?.eligibility_waterfall ?? []
  const rawBlockers = Object.entries(preview?.blocked_counts_by_reason ?? {})
    .filter(([, count]) => Number(count || 0) > 0)
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0) || left[0].localeCompare(right[0]))
  const activeFilterCount = Object.values(filterGroups).reduce((sum, f) => sum + f.length, 0)
  const showZeroMatchWarn = preview !== null && !loading && preview.total_matched === 0 && activeFilterCount > 0
  const unsupportedFilters = [
    ...(preview?.unsupported_in_preview ?? []).map((item) => ({ fieldKey: item.fieldKey, label: item.label, message: 'Filter applied but no graph column mapping found.' })),
    ...((preview?.unsupportedFilters ?? preview?.unsupported_filters ?? []) as Array<Record<string, unknown>>).map((item) => ({
      fieldKey: String(item.field_key ?? item.fieldKey ?? ''),
      label: String(item.label ?? item.field_key ?? item.fieldKey ?? 'Unsupported filter'),
      message: String(item.message ?? 'Filter applied but no graph column mapping found.'),
    })),
  ].filter((item, index, all) => {
    const key = item.fieldKey || item.label
    return Boolean(key) && all.findIndex((other) => (other.fieldKey || other.label) === key) === index
  })
  const unsupportedCount = unsupportedFilters.length
  const missingMappingCount = unsupportedFilters.filter((item) => item.message.includes('no graph column mapping')).length
  const previewWarningMessages = Array.from(new Set((preview?.warnings ?? [])
    .map((warning) => formatPreviewWarning(String(warning ?? '').trim()))
    .filter(Boolean)))
    .slice(0, 3)
  const showMatchedNotReady = preview !== null && !loading && preview.total_matched > 0 && preview.ready_to_queue === 0
  const queueScopeIsSample = preview?.queue_eligibility_scope === 'candidate_window'
  const campaignGraphCount = preview?.matched_properties
    ?? preview?.full_source_reach?.matched_properties
    ?? preview?.total_matched_properties
    ?? preview?.total_matched
    ?? null
  const reachableContacts = preview?.linked_phones
    ?? preview?.full_source_reach?.linked_phones
    ?? preview?.layer_counts?.phones_matched
    ?? null
  const smsEligible = preview?.sms_eligible_phones
    ?? preview?.sms_eligible_phones_count
    ?? preview?.property_sms_eligible_count
    ?? preview?.full_source_reach?.sms_eligible_phones
    ?? null
  const senderCovered = preview?.sender_covered ?? preview?.full_source_reach?.sender_covered ?? null
  const funnelSteps = [
    {
      key: 'addressable',
      label: preview?.addressable_properties_approximate ? 'Total Universe *' : 'Total Universe',
      value: preview?.addressable_properties ?? null,
      hint: 'All properties in the database before any targeting filters.',
    },
    {
      key: 'graph',
      label: 'Matched Properties',
      value: campaignGraphCount,
      hint: 'Properties that match your active targeting filters.',
    },
    {
      key: 'reachable',
      label: 'Reachable Contacts',
      value: reachableContacts,
      hint: 'Matched properties with a contactable phone number.',
    },
    {
      key: 'sms',
      label: 'SMS Eligible',
      value: smsEligible,
      hint: 'Reachable contacts eligible to receive SMS messages.',
    },
    {
      key: 'clean',
      label: 'Compliant Contacts',
      value: preview?.clean_targets ?? null,
      hint: 'After suppression list, opt-outs, and wrong-number checks.',
    },
    {
      key: 'covered',
      label: 'Routable Contacts',
      value: senderCovered,
      hint: 'Compliant contacts with an active sender route assigned.',
    },
    {
      key: 'deliverable',
      label: 'Ready To Schedule',
      value: preview?.ready_to_queue ?? null,
      hint: 'Contacts that will receive messages when you schedule this campaign.',
      accent: true,
    },
    {
      key: 'queueable',
      label: 'Sendable Today',
      value: preview?.queueable_today ?? null,
      hint: "Ready contacts within today's send window and queue policy.",
      accent: true,
    },
  ]
  const hasNoReachableContacts = preview !== null && !loading && Number(reachableContacts ?? 0) === 0 && activeFilterCount > 0
  const hasNoSenderRoute = preview !== null && !loading && Number(senderCovered ?? 0) === 0 && Number(smsEligible ?? reachableContacts ?? 0) > 0

  const graphScope = preview?.graph_refresh_scope ?? null
  const graphRowCount = preview?.graph_row_count ?? null
  const graphIsPartial = graphScope === 'partial'
  const graphRefreshedAt = preview?.graph_freshness?.refresh_finished_at ?? null
  const graphAgeMs = graphRefreshedAt ? Date.now() - new Date(graphRefreshedAt).getTime() : null
  const graphIsStale = graphAgeMs !== null && graphAgeMs > 3_600_000 // >1 hour

  return (
    <aside className="cmp-studio-summary cmp-target-reach">
      <div className="cmp-summary-header">
        <div>
          <div className="cmp-summary-title">Target Reach</div>
          <div className="cmp-summary-subtitle">
            {loading ? 'Updating reach' : previewMeta ? `Updated ${previewMeta.ts}` : preview?.query_ms !== undefined ? `${preview.query_ms}ms query` : 'No data — apply filters to load'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          <span className={`cmp-summary-status ${loading ? 'is-loading' : backendDegraded || preview?.degraded ? 'is-degraded' : preview ? 'is-ready' : ''}`}>
            {loading ? 'Updating' : backendDegraded || preview?.degraded ? 'Degraded' : preview ? 'Updated' : 'Standby'}
          </span>
          {graphIsPartial && (
            <span className="cmp-graph-scope-badge cmp-graph-scope-badge--partial">
              Partial Graph · {graphRowCount?.toLocaleString() ?? '?'} rows
            </span>
          )}
          {graphScope === 'full' && (
            <span className="cmp-graph-scope-badge cmp-graph-scope-badge--full">
              Full Universe
            </span>
          )}
          {graphIsStale && (
            <span className="cmp-graph-scope-badge cmp-graph-scope-badge--stale" title={`Graph last refreshed ${graphRefreshedAt}`}>
              Graph stale — counts may not reflect recent changes
            </span>
          )}
        </div>
      </div>

      <BackendStatusStrip
        activeDomain={activeDomain}
        preview={preview}
        previewMeta={previewMeta}
        backendDegraded={backendDegraded}
        filterGroups={filterGroups}
        totalDraftCount={totalDraftCount}
        developerMode={developerMode}
        onDeveloperModeChange={setDeveloperMode}
      />

      <div className="cmp-summary-body">
        <div className="cmp-reach-funnel" role="list" aria-label="Target reach funnel">
          {funnelSteps.map((step, index) => (
            <ReachFunnelStep
              key={step.key}
              label={step.label}
              value={step.value}
              hint={step.hint}
              accent={step.accent}
              isLast={index === funnelSteps.length - 1}
            />
          ))}
        </div>

        {developerMode && preview && queueScopeIsSample && (
          <div className="cmp-diag-alert cmp-diag-alert--info">
            <Icon name="alert-circle" size={12} />
            <div>
              <div>Queue eligibility is a preview-window check.</div>
              <div style={{ marginTop: 4, fontSize: 10, opacity: 0.8 }}>
                {preview.queue_eligibility_note || 'Matched and linkage counts are full source; clean, ready, and blocker counts use the candidate preview window.'}
              </div>
            </div>
          </div>
        )}

        {!preview && !loading && activeFilterCount === 0 && (
          <div className="cmp-diag-alert cmp-diag-alert--info">
            <Icon name="alert-circle" size={12} />
            Loading the full property universe.
          </div>
        )}

        {!preview && !loading && activeFilterCount > 0 && (
          <div className="cmp-diag-alert cmp-diag-alert--warn">
            <Icon name="alert-circle" size={12} />
            Preview not available — check console for API errors or verify active filters.
          </div>
        )}

        {showZeroMatchWarn && (
          <div className="cmp-diag-alert cmp-diag-alert--warn">
            <Icon name="alert-circle" size={12} />
            <div>
              <div>No reachable contacts match this filter.</div>
            </div>
          </div>
        )}

        {hasNoReachableContacts && !showZeroMatchWarn && (
          <div className="cmp-diag-alert cmp-diag-alert--warn">
            <Icon name="alert-circle" size={12} />
            No reachable contacts match this filter.
          </div>
        )}

        {hasNoSenderRoute && !hasNoReachableContacts && !showZeroMatchWarn && (
          <div className="cmp-diag-alert cmp-diag-alert--warn">
            <Icon name="alert-circle" size={12} />
            No active sender route covers this audience.
          </div>
        )}

        {showMatchedNotReady && !hasNoSenderRoute && !hasNoReachableContacts && !showZeroMatchWarn && (
          <div className="cmp-diag-alert cmp-diag-alert--info">
            <Icon name="alert-circle" size={12} />
            Deliverable target count is zero after suppression and queue checks.
          </div>
        )}

        {developerMode && !showZeroMatchWarn && unsupportedCount > 0 && (
          <div className="cmp-diag-alert cmp-diag-alert--info">
            <Icon name="alert-circle" size={12} />
            {missingMappingCount > 0 ? 'Filter applied but no graph column mapping found.' : 'Some filters are approved but not available in the active preview source.'}
          </div>
        )}

        {!loading && previewMeta?.countUnchanged && activeFilterCount > 0 && unsupportedCount === 0 && (
          <div className="cmp-diag-alert cmp-diag-alert--info">
            <Icon name="alert-circle" size={12} />
            Filter applied, count unchanged.
          </div>
        )}

        {developerMode && !loading && previewWarningMessages.length > 0 && (
          <div className="cmp-preview-warnings-list">
            {previewWarningMessages.map((warning) => (
              <div key={warning} className="cmp-preview-warning">
                <Icon name="alert-circle" size={12} />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        )}

        <DomainFocusSection activeDomain={activeDomain} preview={preview} />

        {eligibilitySteps.length > 0 && (
          <section className="cmp-reach-section">
            <div className="cmp-reach-section-title">
              <span>Eligibility Waterfall</span>
              <strong>{formatScopeLabel(preview?.queue_eligibility_scope)}</strong>
            </div>
            <div className="cmp-eligibility-stack">
              {eligibilitySteps.map((item) => (
                <div key={item.key} className={`cmp-eligibility-row is-${item.kind || 'pass'}`}>
                  <div>
                    <span>{item.label}</span>
                    {item.source && <em>{formatScopeLabel(item.source)}</em>}
                  </div>
                  <strong>{item.kind === 'policy' ? (item.count ? 'On' : 'Off') : formatNumber(item.count)}</strong>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="cmp-reach-section">
          <div className="cmp-reach-section-title">
            <span>Blocked Waterfall</span>
            <strong>{formatNumber(explicitBlockedSteps.length ? explicitBlockedTotal : blockedTotal)}</strong>
          </div>
          <div className="cmp-waterfall">
            {(explicitBlockedSteps.length ? explicitBlockedSteps : preview?.blocked_waterfall ?? []).map((item) => {
              const total = explicitBlockedSteps.length ? explicitBlockedTotal : blockedTotal
              const pct = total ? Math.max(5, Math.round((item.count / total) * 100)) : 0
              return (
                <div key={item.key} className="cmp-waterfall-row">
                  <div>
                    <span>{item.label}</span>
                    <strong>{formatNumber(item.count)}</strong>
                  </div>
                  <div className="cmp-waterfall-track">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {developerMode && rawBlockers.length > 0 && (
          <section className="cmp-reach-section">
            <div className="cmp-reach-section-title">
              <span>Raw Blocker Reasons</span>
              <strong>{formatNumber(rawBlockers.reduce((sum, [, count]) => sum + Number(count || 0), 0))}</strong>
            </div>
            <div className="cmp-reason-list">
              {rawBlockers.map(([reason, count]) => (
                <div key={reason} className="cmp-reason-row">
                  <span>{formatLabel(reason.replace(/[.:]+/g, '_'))}</span>
                  <strong>{formatNumber(count)}</strong>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="cmp-reach-section">
          <div className="cmp-reach-section-title"><span>Distributions</span></div>
          <div className="cmp-distribution-stack">
            {(preview?.distributions ?? []).map((distribution) => (
              <div key={distribution.key} className="cmp-distribution">
                <div className="cmp-distribution-title">{distribution.label}</div>
                {distribution.buckets.map((bucket) => (
                  <div key={`${distribution.key}-${bucket.label}`} className="cmp-distribution-row">
                    <span>{bucket.label}</span>
                    <strong>{formatNumber(bucket.count)}</strong>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="cmp-reach-section">
          <div className="cmp-reach-section-title"><span>Sample Targets</span></div>
          <div className="cmp-sample-stack">
            {(preview?.sample_targets ?? []).map((sample) => (
              <SampleTargetCard key={sample.id} sample={sample} />
            ))}
          </div>
        </section>
      </div>
    </aside>
  )
}

const BackendStatusStrip = ({
  activeDomain,
  preview,
  previewMeta,
  backendDegraded,
  filterGroups,
  totalDraftCount,
  developerMode,
  onDeveloperModeChange,
}: {
  activeDomain: CampaignDomainKey
  preview: CampaignPreviewResult | null
  previewMeta: PreviewMeta | null
  backendDegraded: boolean
  filterGroups: CampaignFilterGroups
  totalDraftCount: number
  developerMode: boolean
  onDeveloperModeChange: (value: boolean) => void
}) => {
  const [expanded, setExpanded] = useState(false)
  const source = DOMAIN_SOURCE_VIEWS[activeDomain] ?? 'unknown'
  const unsupportedFilters = [
    ...(preview?.unsupported_in_preview ?? []).map((item) => ({
      fieldKey: item.fieldKey,
      label: item.label,
      reason: item.reason,
      message: 'Filter applied but no graph column mapping found.',
    })),
    ...asDiagnosticRecords(preview?.unsupportedFilters ?? preview?.unsupported_filters).map((item) => ({
      fieldKey: diagnosticFieldKey(item),
      label: diagnosticLabel(item, 'Unsupported filter'),
      reason: diagnosticReason(item, 'unsupported_in_preview'),
      message: String(item.message ?? 'Filter applied but no graph column mapping found.'),
    })),
  ].filter((item, index, all) => {
    const key = item.fieldKey || item.label
    return Boolean(key) && all.findIndex((other) => (other.fieldKey || other.label) === key) === index
  })
  const skippedFilters = asDiagnosticRecords(preview?.skippedFilters ?? preview?.skipped_filters)
  const sourceColumnsUsed = preview?.sourceColumnsUsed ?? preview?.source_columns_used ?? preview?.graph_columns_used ?? {}
  const sourceColumnRows = Object.entries(sourceColumnsUsed)
    .map(([fieldKey, columns]) => [fieldKey, asStringList(columns)] as const)
    .filter(([, columns]) => columns.length > 0)
  const graphColumnsUsed = Array.from(new Set(sourceColumnRows.flatMap(([, columns]) => columns))).sort()
  const payloadFiltersByDomain = preview?.payloadFiltersByDomain ?? preview?.payload_filters_by_domain ?? {}
  const payloadDomainRows = Object.entries(payloadFiltersByDomain)
    .map(([domain, filters]) => [domain, asDiagnosticRecords(filters)] as const)
    .filter(([, filters]) => filters.length > 0)
  const payloadFilterCount = payloadDomainRows.reduce((sum, [, filters]) => sum + filters.length, 0)
  const resultHash = preview?.result_hash ?? previewMeta?.resultHash ?? null
  const displayHash = shortHash(resultHash)
  const graphSource = preview?.full_source_reach?.graph_source
    ?? (preview?.queue_eligibility_scope === 'campaign_target_graph' ? 'campaign_target_graph' : null)
  const graphCountSource = preview?.full_source_reach?.count_source ?? preview?.queue_eligibility_scope ?? null
  const graphSourceLabel = graphSource
    ? `${graphSource} / ${!graphCountSource || graphCountSource === graphSource ? 'full' : formatScopeLabel(graphCountSource)}`
    : null
  const unsupportedCount = unsupportedFilters.length
  const modeLabel = backendDegraded || preview?.degraded ? 'Fallback' : preview ? 'Backend' : 'Standby'
  const activeFilterCount = Object.values(filterGroups).reduce((s, f) => s + f.length, 0)

  const appliedCount = preview?.applied_filters?.length
    ?? activeFilterCount
  const warningsCount = preview?.warnings?.length ?? 0
  const sourceUsed = graphSourceLabel ?? preview?.source ?? (preview ? 'local_fallback' : null)

  const domainCounts = Object.entries(filterGroups)
    .filter(([, filters]) => filters.length > 0)
    .map(([domain, filters]) => ({ domain, count: filters.length }))

  const layerCounts = preview ? {
    propertiesMatched: preview.layer_counts?.properties_matched,
    prospectsMatched: preview.layer_counts?.prospects_matched,
    masterOwnersMatched: preview.layer_counts?.master_owners_matched,
    phonesMatched: preview.layer_counts?.phones_matched,
    outreachEligible: preview.layer_counts?.outreach_eligible,
    senderCoverageEligible: preview.layer_counts?.sender_coverage_eligible,
  } : null

  return (
    <div className="cmp-backend-strip-wrap">
      <div className="cmp-operator-strip">
        <span className="cmp-operator-strip__item">
          {activeFilterCount > 0 ? `${activeFilterCount} active filter${activeFilterCount !== 1 ? 's' : ''}` : 'Full property universe'}
        </span>
        {totalDraftCount > 0 && (
          <span className="cmp-operator-strip__item is-warn">{totalDraftCount} draft filter{totalDraftCount !== 1 ? 's' : ''}</span>
        )}
        {previewMeta && (
          <span className="cmp-operator-strip__item">Updated {previewMeta.ts}</span>
        )}
        <button
          type="button"
          className={`cmp-developer-toggle ${developerMode ? 'is-active' : ''}`}
          onClick={() => {
            const next = !developerMode
            onDeveloperModeChange(next)
            if (!next) setExpanded(false)
          }}
        >
          Developer Mode
        </button>
      </div>

      {developerMode && (
        <div className="cmp-backend-strip">
        <span className="cmp-backend-item cmp-backend-source" title="Source view">{source}</span>
        <span className={`cmp-backend-item cmp-backend-mode ${backendDegraded || preview?.degraded ? 'is-degraded' : 'is-live'}`}>
          {modeLabel}
        </span>
        {previewMeta && (
          <span className="cmp-backend-item cmp-backend-ms" title="Query time">{previewMeta.ms}ms</span>
        )}
        {activeFilterCount > 0 && (
          <span className="cmp-backend-item cmp-backend-active-notice" title="Active filters applied to this preview">
            {activeFilterCount} active applied
          </span>
        )}
        {unsupportedCount > 0 && (
          <span className="cmp-backend-item cmp-backend-unsupported" title="Filters not reflected in estimate">
            {unsupportedCount} unsupported
          </span>
        )}
        {displayHash && (
          <span className="cmp-backend-item cmp-backend-hash" title={String(resultHash)}>
            hash {displayHash}
          </span>
        )}
        {totalDraftCount > 0 && (
          <span className="cmp-backend-item cmp-backend-draft-notice" title="Draft filters not yet applied to preview">
            {totalDraftCount} draft
          </span>
        )}
        {previewMeta && (
          <span className="cmp-backend-item cmp-backend-ts">{previewMeta.ts}</span>
        )}
        <button
          className={`cmp-backend-item cmp-diag-toggle ${expanded ? 'is-expanded' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Hide diagnostics' : 'Show diagnostics'}
        >
          Diagnostics
          <Icon name="chevron-down" size={10} />
        </button>
        </div>
      )}

      {developerMode && expanded && (
        <div className="cmp-diag-panel">
          <div className="cmp-diag-grid">
            <div className="cmp-diag-row">
              <span>Source</span>
              <strong>{sourceUsed ?? source}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Graph source</span>
              <strong>{graphSourceLabel ?? 'n/a'}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Applied filters</span>
              <strong>{appliedCount}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Active filters</span>
              <strong>{activeFilterCount}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Draft filters</span>
              <strong className={totalDraftCount > 0 ? 'is-warn' : ''}>{totalDraftCount}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Payload filters</span>
              <strong>{payloadFilterCount}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Graph columns</span>
              <strong>{graphColumnsUsed.length}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Unsupported</span>
              <strong className={unsupportedCount > 0 ? 'is-warn' : ''}>{unsupportedCount}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Skipped</span>
              <strong className={skippedFilters.length > 0 ? 'is-warn' : ''}>{skippedFilters.length}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Warnings</span>
              <strong className={warningsCount > 0 ? 'is-warn' : ''}>{warningsCount}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Last preview hash</span>
              <strong title={String(resultHash ?? '')}>{displayHash ?? 'n/a'}</strong>
            </div>
          </div>

          {layerCounts && Object.values(layerCounts).some(v => v !== undefined) && (
            <div className="cmp-diag-layer-counts">
              {Object.entries(layerCounts).map(([key, val]) => val !== undefined ? (
                <div key={key} className="cmp-diag-row">
                  <span>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                  <strong>{formatNumber(val as number)}</strong>
                </div>
              ) : null)}
            </div>
          )}

          {domainCounts.length > 0 && (
            <div className="cmp-diag-domains">
              {domainCounts.map(({ domain, count }) => (
                <span key={domain} className="cmp-diag-domain-chip">
                  {domain.replace('_', ' ')} ×{count}
                </span>
              ))}
            </div>
          )}

          {payloadDomainRows.length > 0 && (
            <div className="cmp-diag-section">
              <div className="cmp-diag-subtitle">Payload Filters By Domain</div>
              <div className="cmp-diag-kv-list">
                {payloadDomainRows.map(([domain, filters]) => (
                  <div key={domain} className="cmp-diag-code-row">
                    <span>{formatLabel(domain.replace(/[.:]+/g, '_'))}</span>
                    <code>{filters.length} filter{filters.length !== 1 ? 's' : ''}</code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {sourceColumnRows.length > 0 && (
            <div className="cmp-diag-section">
              <div className="cmp-diag-subtitle">Graph Columns Used</div>
              <div className="cmp-diag-kv-list">
                {sourceColumnRows.map(([fieldKey, columns]) => (
                  <div key={fieldKey} className="cmp-diag-code-row">
                    <span>{fieldKey}</span>
                    <code>{columns.join(', ')}</code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unsupportedFilters.length > 0 && (
            <div className="cmp-diag-section">
              <div className="cmp-diag-subtitle">Unsupported Filters</div>
              <div className="cmp-diag-kv-list">
                {unsupportedFilters.map((item, index) => (
                  <div key={`${item.fieldKey || item.label}-${index}`} className="cmp-diag-code-row is-warn">
                    <span>{item.fieldKey || item.label}</span>
                    <code>{item.message || item.reason}</code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {skippedFilters.length > 0 && (
            <div className="cmp-diag-section">
              <div className="cmp-diag-subtitle">Skipped Filters</div>
              <div className="cmp-diag-kv-list">
                {skippedFilters.map((item, index) => {
                  const fieldKey = diagnosticFieldKey(item) || diagnosticLabel(item, 'filter')
                  return (
                    <div key={`${fieldKey}-${index}`} className="cmp-diag-code-row is-warn">
                      <span>{fieldKey}</span>
                      <code>{diagnosticReason(item, 'skipped')}</code>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {unsupportedCount > 0 && (
            <div className="cmp-diag-note">
              {unsupportedFilters.some((item) => item.message.includes('no graph column mapping'))
                ? 'Filter applied but no graph column mapping found.'
                : 'Some filters are approved but not available in the active preview source.'}
            </div>
          )}

          {totalDraftCount > 0 && (
            <div className="cmp-diag-note" style={{ marginTop: 4 }}>
              {totalDraftCount} draft filter{totalDraftCount !== 1 ? 's' : ''} not applied — set them to include in preview.
            </div>
          )}

          {activeFilterCount > 0 && (
            <div className="cmp-diag-note" style={{ marginTop: 4 }}>
              Preview is based on active filters only.
            </div>
          )}

          {import.meta.env.DEV && preview?._request && (
            <details className="cmp-diag-raw" style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 10, opacity: 0.7 }}>Preview request</summary>
              <pre style={{ fontSize: 9, maxHeight: 200, overflow: 'auto', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(preview._request, null, 2)}
              </pre>
            </details>
          )}

          {import.meta.env.DEV && preview && preview._raw != null && (
            <details className="cmp-diag-raw" style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 10, opacity: 0.7 }}>Raw API response</summary>
              <pre style={{ fontSize: 9, maxHeight: 200, overflow: 'auto', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(preview._raw, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

const DomainFocusSection = ({
  activeDomain,
  preview,
}: {
  activeDomain: CampaignDomainKey
  preview: CampaignPreviewResult | null
}) => {
  if (!preview) return null

  const getDist = (key: string) => preview.distributions.find((d) => d.key === key)
  const getBlocked = (key: string) => {
    const count = preview.blocked_waterfall.find((b) => b.key === key)?.count
    return count !== undefined ? count : null
  }

  if (activeDomain === 'properties') {
    const dist = getDist('property_state')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Property Breakdown</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Matched" value={preview.matched_properties ?? preview.total_matched ?? null} variant="accent" />
          <DomainKpi label="Compliant Contacts" value={preview.clean_targets ?? null} />
          <DomainKpi label="Missing Phone" value={getBlocked('missing_clean_phone')} variant="warn" />
          <DomainKpi label="No Sender Route" value={getBlocked('missing_sender_route')} variant="warn" />
        </div>
        {dist && <DomainDistList buckets={dist.buckets} />}
      </section>
    )
  }

  if (activeDomain === 'prospects') {
    const langDist = getDist('language_preference')
    const smsEligible = preview.sms_eligible_phones ?? preview.sms_eligible_phones_count ?? preview.property_sms_eligible_count ?? null
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Prospect Breakdown</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Reachable Contacts" value={preview.linked_phones ?? null} variant="accent" />
          <DomainKpi label="SMS Eligible" value={smsEligible} />
        </div>
        {langDist && <DomainDistList buckets={langDist.buckets} />}
      </section>
    )
  }

  if (activeDomain === 'master_owners') {
    const tierDist = getDist('priority_tier')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Owner Breakdown</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Linked Owners" value={preview.linked_master_owners ?? null} variant="accent" />
        </div>
        {tierDist && <DomainDistList buckets={tierDist.buckets.map((b) => ({ ...b, label: `Tier ${b.label}` }))} />}
      </section>
    )
  }

  if (activeDomain === 'phones') {
    const carrierDist = getDist('phone_owner')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Phone Breakdown</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Reachable" value={preview.linked_phones ?? null} variant="accent" />
          <DomainKpi label="Missing Phone" value={getBlocked('missing_clean_phone')} variant="warn" />
        </div>
        {carrierDist && <DomainDistList buckets={carrierDist.buckets} />}
      </section>
    )
  }

  if (activeDomain === 'outreach') {
    const recentWindow = getBlocked('recent_contact')
    const dupQueue = getBlocked('duplicate_queue')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Outreach Eligibility</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Ready To Schedule" value={preview.ready_to_queue ?? null} variant="accent" />
          <DomainKpi label="Recent Window Block" value={recentWindow} variant="warn" />
          <DomainKpi label="Duplicate Queue" value={dupQueue} variant="warn" />
        </div>
        <div className="cmp-domain-focus-note">
          Suppression, opt-out, and queue limits enforced on every outbound message.
        </div>
      </section>
    )
  }

  if (activeDomain === 'sender_coverage') {
    const coverDist = getDist('sender_coverage_status')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Sender Coverage</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Routable Contacts" value={preview.sender_covered ?? null} variant="accent" />
          <DomainKpi label="No Sender Route" value={getBlocked('missing_sender_route')} variant="danger" />
        </div>
        {coverDist && <DomainDistList buckets={coverDist.buckets} />}
      </section>
    )
  }

  return null
}

const DomainKpi = ({
  label,
  value,
  variant,
}: {
  label: string
  value: number | null
  variant?: 'accent' | 'warn' | 'danger'
}) => (
  <div className="cmp-domain-focus-kpi">
    <span>{label}</span>
    <strong className={variant ? `is-${variant}` : ''}>{value === null ? '—' : formatNumber(value)}</strong>
  </div>
)

const DomainDistList = ({ buckets }: { buckets: Array<{ label: string; count: number }> }) => (
  <div className="cmp-domain-focus-dist">
    {buckets.map((b) => (
      <div key={b.label} className="cmp-domain-focus-row">
        <span>{b.label}</span>
        <strong>{formatNumber(b.count)}</strong>
      </div>
    ))}
  </div>
)

const ReachFunnelStep = ({
  label,
  value,
  hint,
  accent,
  isLast,
}: {
  label: string
  value: number | null | undefined
  hint?: string
  accent?: boolean
  isLast?: boolean
}) => (
  <div className={`cmp-reach-funnel-step ${accent ? 'is-accent' : ''}`} role="listitem" title={hint}>
    <div className="cmp-reach-funnel-node" />
    <div className="cmp-reach-funnel-content">
      <span>{label}</span>
      <strong>{value === undefined || value === null ? '—' : formatNumber(value)}</strong>
      {hint ? <em>{hint}</em> : null}
    </div>
    {!isLast ? <div className="cmp-reach-funnel-connector" /> : null}
  </div>
)

const Metric = ({ label, value, variant, hint }: { label: string; value: number | null | undefined; variant?: 'success' | 'accent'; hint?: string }) => (
  <div className="cmp-summary-metric" title={hint ?? undefined}>
    <div className="cmp-summary-metric-label">{label}</div>
    <div className={`cmp-summary-metric-value ${variant === 'success' ? 'is-success' : variant === 'accent' ? 'is-accent' : ''}`}>
      {value === undefined || value === null ? '—' : formatNumber(value)}
    </div>
    {hint ? <div className="cmp-summary-metric-hint">{hint}</div> : null}
  </div>
)

const SampleTargetCard = ({ sample }: { sample: CampaignSampleTarget }) => {
  type SampleSectionKey = Exclude<keyof CampaignSampleTarget, 'id'>
  const sections: SampleSectionKey[] = ['property', 'prospect', 'master_owner', 'phone', 'outreach', 'sender_coverage']
  return (
    <article className="cmp-sample-card">
      {sections.map((section) => {
        const values = sample[section]
        return (
          <div key={section} className="cmp-sample-section">
            <div className="cmp-sample-section-title">{section}</div>
            {Object.entries(values).slice(0, 4).map(([key, value]) => (
              <div key={key} className="cmp-sample-row">
                <span>{formatLabel(key)}</span>
                <strong>{String(value ?? 'None')}</strong>
              </div>
            ))}
          </div>
        )
      })}
    </article>
  )
}
