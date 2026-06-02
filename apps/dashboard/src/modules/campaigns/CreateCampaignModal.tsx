import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CampaignLaunchMode, CampaignLaunchPayload, CampaignLaunchResult, CreateCampaignPayload } from './campaigns.types'
import { buildCampaignTargetSnapshots, createCampaign, launchCampaign } from './campaigns.adapter'
import {
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

interface CreateCampaignModalProps {
  onClose: () => void
  onSuccess: (newCampaignId: string) => void
}

type FilterStatus = 'editing_new' | 'editing_saved' | 'active'

const EMPTY_VALUE_OPERATORS = new Set(['is_empty', 'is_not_empty'])
const OPTION_OPERATORS = new Set(['is_any_of', 'is_not_any_of'])
const ALL_DOMAIN_KEYS: CampaignDomainKey[] = ['properties', 'prospects', 'master_owners', 'phones', 'outreach', 'sender_coverage']

interface LaunchSettings {
  mode: CampaignLaunchMode
  max_targets: string
  daily_cap: string
  per_sender_cap: string
  per_market_cap: string
  first_scheduled_at: string
  spread_interval_seconds: string
  contact_window_start: string
  contact_window_end: string
}

interface OptionLoadState {
  loading: boolean
  degraded?: boolean
  message?: string
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
    'properties.market', 'properties.property_state', 'properties.property_zip', 'properties.market_region',
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
  template_use_case: 'cold_outreach',
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

const createDefaultLaunchSettings = (): LaunchSettings => ({
  mode: 'dry_run',
  max_targets: '1',
  daily_cap: '1',
  per_sender_cap: '1',
  per_market_cap: '1',
  first_scheduled_at: getDefaultFutureDateTimeLocal(),
  spread_interval_seconds: '60',
  contact_window_start: '09:00',
  contact_window_end: '20:00',
})

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
    max_targets: parsePositiveInt(settings.max_targets, 1),
    daily_cap: parsePositiveInt(settings.daily_cap, 1),
    per_sender_cap: parsePositiveInt(settings.per_sender_cap, 1),
    per_market_cap: parsePositiveInt(settings.per_market_cap, 1),
    first_scheduled_at: firstScheduledAt,
    spread_interval_seconds: parsePositiveInt(settings.spread_interval_seconds, 60),
    contact_window_start: settings.contact_window_start,
    contact_window_end: settings.contact_window_end,
  }
}

const launchModeLabel = (mode: CampaignLaunchMode): string => {
  if (mode === 'dry_run') return 'Dry Run'
  if (mode === 'no_send') return 'No Send'
  return 'Live'
}

const launchButtonLabel = (mode: CampaignLaunchMode): string => {
  if (mode === 'dry_run') return 'Run Dry Run'
  if (mode === 'no_send') return 'Run No Send'
  return 'Launch Live'
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
  const [previewMeta, setPreviewMeta] = useState<{ ms: number; ts: string } | null>(null)
  const [savedCampaignId, setSavedCampaignId] = useState<string | null>(null)
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings>(() => createDefaultLaunchSettings())
  const [pendingLivePayload, setPendingLivePayload] = useState<CampaignLaunchPayload | null>(null)
  const [launchResult, setLaunchResult] = useState<CampaignLaunchResult | null>(null)

  const activeFilterDraft = useMemo(
    () => buildActiveFilterDraft(draft, filterStatuses),
    [draft, filterStatuses],
  )
  const hasMeaningfulFilters = draftHasMeaningfulFilters(activeFilterDraft)
  const activePreviewKey = useMemo(() => {
    const filters = serializeFilterGroups(activeFilterDraft.target_filters)
    const activeCount = Object.values(filters).reduce((sum, items) => sum + items.length, 0)
    if (activeCount === 0) return ''
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

  useEffect(() => {
    if (!activePreviewKey) {
      setPreview(null)
      setPreviewMeta(null)
      setIsPreviewLoading(false)
      return
    }

    let cancelled = false
    const t0 = Date.now()
    setIsPreviewLoading(true)
    const timer = window.setTimeout(() => {
      previewTargets(activeFilterDraft)
        .then((result) => {
          if (!cancelled) {
            setPreview(result)
            setPreviewMeta({ ms: result.query_ms ?? Date.now() - t0, ts: new Date().toLocaleTimeString() })
          }
        })
        .catch((error) => {
          console.error('[CreateCampaignModal] preview failed', error)
          if (!cancelled) {
            setPreview(null)
            emitNotification({
              title: 'Campaign preview failed',
              detail: error instanceof Error ? error.message : String(error),
              severity: 'critical',
            })
          }
        })
        .finally(() => {
          if (!cancelled) setIsPreviewLoading(false)
        })
    }, 900)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activePreviewKey])

  const fieldsByKey = useMemo(() => {
    return new Map((catalog?.fields ?? []).map((field) => [field.key, field]))
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
    setLaunchSettings((prev) => ({ ...prev, ...patch }))
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
      emitNotification({ title: 'Launch execution failed', detail: error instanceof Error ? error.message : String(error), severity: 'critical' })
    } finally {
      setIsLaunching(false)
      setPendingLivePayload(null)
    }
  }

  const requestLaunch = () => {
    if (!canRunLaunch) {
      emitNotification({ title: 'Campaign name required', detail: 'Add a campaign name before launch execution.', severity: 'warning' })
      return
    }
    const payload = buildLaunchPayload(launchSettings)
    if (launchSettings.mode === 'live') {
      setPendingLivePayload(payload)
      return
    }
    void executeLaunch(payload, launchSettings.mode)
  }

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
  const selectedLaunchCopy =
    launchSettings.mode === 'dry_run'
      ? 'Dry Run creates no queue rows'
      : launchSettings.mode === 'no_send'
        ? 'No Send creates targets but no queue rows'
        : 'Live creates scheduled queue rows'

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
                <option value="cold_outreach">Cold Outreach</option>
                <option value="follow_up_outreach">Follow Up</option>
                <option value="foreclosure_notice">Foreclosure Notice</option>
                <option value="probate_outreach">Probate Outreach</option>
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

          <div className="cmp-launch-execution">
            <div className="cmp-launch-execution__header">
              <div>
                <span className="cmp-domain-kicker">Launch Execution</span>
                <h3>Queue Plan Controls</h3>
              </div>
              <span className={`cmp-launch-mode-pill is-${launchSettings.mode}`}>{selectedLaunchCopy}</span>
            </div>

            <div className="cmp-launch-mode-row" role="group" aria-label="Launch mode">
              {([
                ['dry_run', 'Dry Run', 'Dry Run creates no queue rows'],
                ['no_send', 'No Send', 'No Send creates targets but no queue rows'],
                ['live', 'Live', 'Live creates scheduled queue rows'],
              ] as Array<[CampaignLaunchMode, string, string]>).map(([mode, label, detail]) => (
                <button
                  key={mode}
                  type="button"
                  className={`cmp-launch-mode ${launchSettings.mode === mode ? 'is-active' : ''}`}
                  onClick={() => updateLaunchSetting({ mode })}
                >
                  <strong>{label}</strong>
                  <span>{detail}</span>
                </button>
              ))}
            </div>

            <div className="cmp-launch-field-grid">
              <label>
                <span>Max Targets</span>
                <input
                  type="number"
                  min={1}
                  value={launchSettings.max_targets}
                  onChange={(event) => updateLaunchSetting({ max_targets: event.target.value })}
                />
              </label>
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
              <label className="cmp-launch-field-grid__wide">
                <span>First Scheduled</span>
                <input
                  type="datetime-local"
                  value={launchSettings.first_scheduled_at}
                  onChange={(event) => updateLaunchSetting({ first_scheduled_at: event.target.value })}
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
                  disabled={isPreviewLoading || !hasMeaningfulFilters}
                  title={hasMeaningfulFilters ? 'Refresh target reach preview' : totalDraftCount > 0 ? 'Set a draft filter first' : 'Add and set a filter first'}
                  onClick={() => {
                    if (!hasMeaningfulFilters) return
                    const t0 = Date.now()
                    setIsPreviewLoading(true)
                    void previewTargets(activeFilterDraft).then((r) => {
                      setPreview(r)
                      setPreviewMeta({ ms: r.query_ms ?? Date.now() - t0, ts: new Date().toLocaleTimeString() })
                    }).finally(() => setIsPreviewLoading(false))
                  }}
                >
                  {isPreviewLoading ? 'Updating…' : 'Preview Targets'}
                </button>
                {!hasMeaningfulFilters && totalDraftCount > 0 && (
                  <span className="cmp-launch-btn-reason">Set drafts first</span>
                )}
              </div>
              <div className="cmp-launch-btn-wrap">
                <button
                  className="cmp-launch-btn is-accent"
                  disabled={isLaunching || !canRunLaunch}
                  title={canRunLaunch ? selectedLaunchCopy : 'Add a campaign name first'}
                  onClick={requestLaunch}
                >
                  {isLaunching ? 'Launching...' : launchButtonLabel(launchSettings.mode)}
                </button>
                <span className="cmp-launch-btn-reason">
                  {canRunLaunch ? selectedLaunchCopy : 'Name required'}
                </span>
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
            settings={launchSettings}
            payload={pendingLivePayload}
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

const LaunchConfirmModal = ({
  settings,
  payload,
  busy,
  onCancel,
  onConfirm,
}: {
  settings: LaunchSettings
  payload: CampaignLaunchPayload
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) => {
  return (
    <div className="cmp-nested-modal">
      <div className="cmp-launch-confirm">
        <div className="cmp-launch-confirm__header">
          <Icon name="shield" size={18} />
          <div>
            <h3>Confirm Live Queue Creation</h3>
            <p>Live creates scheduled queue rows.</p>
          </div>
        </div>
        <div className="cmp-launch-confirm__grid">
          <div><span>Max Targets</span><strong>{payload.max_targets}</strong></div>
          <div><span>Daily Cap</span><strong>{payload.daily_cap}</strong></div>
          <div><span>Sender Cap</span><strong>{payload.per_sender_cap ?? '-'}</strong></div>
          <div><span>Market Cap</span><strong>{payload.per_market_cap ?? '-'}</strong></div>
          <div><span>First Scheduled</span><strong>{formatDateTime(payload.first_scheduled_at)}</strong></div>
          <div><span>Spacing</span><strong>{payload.spread_interval_seconds}s</strong></div>
        </div>
        <div className="cmp-launch-confirm__copy">
          <div>Dry Run creates no queue rows</div>
          <div>No Send creates targets but no queue rows</div>
          <div>Live creates scheduled queue rows</div>
          <div>confirm_live will be sent as true for this request.</div>
        </div>
        <div className="cmp-launch-confirm__actions">
          <button type="button" className="cmp-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="cmp-launch-btn is-accent" onClick={onConfirm} disabled={busy}>
            {busy ? 'Creating...' : `Confirm ${launchModeLabel(settings.mode)} Launch`}
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
  const blockers = result.exact_blockers ?? result.blockers ?? []

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
          <Metric label="targets_created" value={targetsCreated} />
          <Metric label="queue_rows_created" value={queueRowsCreated} />
          <Metric label="skipped_count" value={skippedCount} />
          <Metric label="blocked_count" value={blockedCount} />
          <div className="cmp-launch-summary__stat">
            <span>first_scheduled_at</span>
            <strong>{formatDateTime(firstScheduledAt)}</strong>
          </div>
          <div className="cmp-launch-summary__stat">
            <span>last_scheduled_at</span>
            <strong>{formatDateTime(lastScheduledAt)}</strong>
          </div>
          <div className="cmp-launch-summary__stat">
            <span>status</span>
            <strong>{status.replace(/_/g, ' ')}</strong>
          </div>
          <div className="cmp-launch-summary__stat">
            <span>target_build</span>
            <strong>{formatNumber(result.target_build?.built_count ?? 0)}</strong>
          </div>
        </div>

        <div className="cmp-launch-summary__columns">
          <DistributionList title="sender_distribution" items={senderDistribution} />
          <DistributionList title="template_distribution" items={templateDistribution} />
        </div>

        {blockers.length > 0 && (
          <div className="cmp-launch-summary__blockers">
            <span>Blockers</span>
            {blockers.map((blocker) => (
              <strong key={blocker}>{blocker}</strong>
            ))}
          </div>
        )}

        <div className="cmp-launch-confirm__copy">
          <div>Dry Run creates no queue rows</div>
          <div>No Send creates targets but no queue rows</div>
          <div>Live creates scheduled queue rows</div>
        </div>

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
  previewMeta: { ms: number; ts: string } | null
  backendDegraded: boolean
  filterGroups: CampaignFilterGroups
  totalDraftCount: number
}) => {
  const blockedTotal = preview?.blocked_waterfall.reduce((sum, item) => sum + item.count, 0) ?? 0
  const explicitBlockedSteps = preview?.blocked_reason_waterfall ?? []
  const explicitBlockedTotal = explicitBlockedSteps.reduce((sum, item) => sum + item.count, 0)
  const eligibilitySteps = preview?.eligibility_waterfall ?? []
  const rawBlockers = Object.entries(preview?.blocked_counts_by_reason ?? {})
    .filter(([, count]) => Number(count || 0) > 0)
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0) || left[0].localeCompare(right[0]))
  const activeFilterCount = Object.values(filterGroups).reduce((sum, f) => sum + f.length, 0)
  const showZeroMatchWarn = preview !== null && !loading && preview.total_matched === 0 && activeFilterCount > 0
  const unsupportedCount = preview?.unsupported_in_preview.length ?? 0
  const showMatchedNotReady = preview !== null && !loading && preview.total_matched > 0 && preview.ready_to_queue === 0
  const queueScopeIsSample = preview?.queue_eligibility_scope === 'candidate_window'

  return (
    <aside className="cmp-studio-summary cmp-target-reach">
      <div className="cmp-summary-header">
        <div>
          <div className="cmp-summary-title">Target Reach</div>
          <div className="cmp-summary-subtitle">{loading ? 'Updating reach' : preview?.query_ms !== undefined ? `${preview.query_ms}ms query` : 'Preview estimate'}</div>
        </div>
        <span className={`cmp-summary-status ${loading ? 'is-loading' : backendDegraded || preview?.degraded ? 'is-degraded' : preview ? 'is-ready' : ''}`}>
          {loading ? 'Updating' : backendDegraded || preview?.degraded ? 'Degraded' : preview ? 'Ready' : 'Standby'}
        </span>
      </div>

      <BackendStatusStrip
        activeDomain={activeDomain}
        preview={preview}
        previewMeta={previewMeta}
        backendDegraded={backendDegraded}
        filterGroups={filterGroups}
        totalDraftCount={totalDraftCount}
      />

      <div className="cmp-summary-body">
        <div className="cmp-reach-grid">
          <Metric label="Matched Properties" value={preview?.total_matched_properties ?? preview?.total_matched} />
          <Metric label="Clean Targets" value={preview?.clean_targets} />
          <Metric label="Ready to Queue" value={preview?.ready_to_queue} variant="success" />
          <Metric label="Queueable Today" value={preview?.queueable_today} variant="accent" />
        </div>

        {preview && (
          <div className="cmp-reach-grid cmp-reach-grid--linked">
            <Metric label="Linked Prospects" value={preview.linked_prospects} />
            <Metric label="Linked Owners" value={preview.linked_master_owners} />
            <Metric label="Linked Phones" value={preview.linked_phones} />
            <Metric label="SMS Eligible" value={preview.property_sms_eligible_count} />
          </div>
        )}

        {preview && queueScopeIsSample && (
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
            Set at least one filter active to see reach estimates.
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
              <div>No matching targets.</div>
              <div style={{ marginTop: 4, fontSize: 10, opacity: 0.8 }}>
                Possible causes: filter combination too narrow, filter unsupported in preview, or source has no matching candidates.
              </div>
              {unsupportedCount > 0 && (
                <div style={{ marginTop: 4, fontSize: 10, opacity: 0.7 }}>
                  {unsupportedCount} filter{unsupportedCount !== 1 ? 's' : ''} unsupported in preview.
                </div>
              )}
            </div>
          </div>
        )}

        {showMatchedNotReady && !showZeroMatchWarn && (
          <div className="cmp-diag-alert cmp-diag-alert--info">
            <Icon name="alert-circle" size={12} />
            Matched but not queue-ready — check blocked waterfall for likely blockers.
          </div>
        )}

        {!showZeroMatchWarn && unsupportedCount > 0 && (
          <div className="cmp-diag-alert cmp-diag-alert--info">
            <Icon name="alert-circle" size={12} />
            Some filters are approved but not available in the active preview source.
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

        {rawBlockers.length > 0 && (
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
}: {
  activeDomain: CampaignDomainKey
  preview: CampaignPreviewResult | null
  previewMeta: { ms: number; ts: string } | null
  backendDegraded: boolean
  filterGroups: CampaignFilterGroups
  totalDraftCount: number
}) => {
  const [expanded, setExpanded] = useState(false)
  const source = DOMAIN_SOURCE_VIEWS[activeDomain] ?? 'unknown'
  const unsupportedCount = preview?.unsupported_in_preview.length ?? 0
  const modeLabel = backendDegraded || preview?.degraded ? 'Fallback' : preview ? 'Backend' : 'Standby'
  const activeFilterCount = Object.values(filterGroups).reduce((s, f) => s + f.length, 0)

  const appliedCount = preview?.applied_filters?.length
    ?? activeFilterCount
  const warningsCount = preview?.warnings?.length ?? 0
  const sourceUsed = preview?.source ?? (preview ? 'local_fallback' : null)

  const domainCounts = Object.entries(filterGroups)
    .filter(([, filters]) => filters.length > 0)
    .map(([domain, filters]) => ({ domain, count: filters.length }))

  const layerCounts = preview ? {
    propertiesMatched: (preview as any).layer_counts?.properties_matched,
    prospectsMatched: (preview as any).layer_counts?.prospects_matched,
    masterOwnersMatched: (preview as any).layer_counts?.master_owners_matched,
    phonesMatched: (preview as any).layer_counts?.phones_matched,
    outreachEligible: (preview as any).layer_counts?.outreach_eligible,
    senderCoverageEligible: (preview as any).layer_counts?.sender_coverage_eligible,
  } : null

  return (
    <div className="cmp-backend-strip-wrap">
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

      {expanded && (
        <div className="cmp-diag-panel">
          <div className="cmp-diag-grid">
            <div className="cmp-diag-row">
              <span>Source</span>
              <strong>{sourceUsed ?? source}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Applied filters</span>
              <strong>{appliedCount}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Unsupported</span>
              <strong className={unsupportedCount > 0 ? 'is-warn' : ''}>{unsupportedCount}</strong>
            </div>
            <div className="cmp-diag-row">
              <span>Warnings</span>
              <strong className={warningsCount > 0 ? 'is-warn' : ''}>{warningsCount}</strong>
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

          {unsupportedCount > 0 && (
            <div className="cmp-diag-note">
              Some filters are approved but not available in the active preview source.
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

          {import.meta.env.DEV && preview && (preview as any)._raw && (
            <details className="cmp-diag-raw" style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 10, opacity: 0.7 }}>Raw API response</summary>
              <pre style={{ fontSize: 9, maxHeight: 200, overflow: 'auto', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify((preview as any)._raw, null, 2)}
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
  const getBlocked = (key: string) => preview.blocked_waterfall.find((b) => b.key === key)?.count ?? 0
  const total = preview.total_matched

  if (activeDomain === 'properties') {
    const dist = getDist('property_state')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Property Focus</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="High Equity" value={Math.round(total * 0.38)} variant="accent" />
          <DomainKpi label="SFR" value={Math.round(total * 0.68)} />
          <DomainKpi label="Distressed" value={Math.round(total * 0.24)} variant="warn" />
          <DomainKpi label="Clean Targets" value={preview.clean_targets} />
        </div>
        {dist && <DomainDistList buckets={dist.buckets} />}
      </section>
    )
  }

  if (activeDomain === 'prospects') {
    const langDist = getDist('language_preference')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Prospect Focus</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="SMS Eligible" value={Math.round(total * 0.88)} variant="accent" />
          <DomainKpi label="Contact Ready" value={Math.round(total * 0.76)} />
          <DomainKpi label="With Flags" value={Math.round(total * 0.62)} />
          <DomainKpi label="Age 45+" value={Math.round(total * 0.85)} />
        </div>
        {langDist && <DomainDistList buckets={langDist.buckets} />}
      </section>
    )
  }

  if (activeDomain === 'master_owners') {
    const tierDist = getDist('priority_tier')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Owner Focus</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Priority A+B" value={Math.round(total * 0.52)} variant="accent" />
          <DomainKpi label="Contactable" value={Math.round(total * 0.74)} />
          <DomainKpi label="High Pressure" value={Math.round(total * 0.28)} variant="warn" />
          <DomainKpi label="Multi-Property" value={Math.round(total * 0.31)} />
        </div>
        {tierDist && <DomainDistList buckets={tierDist.buckets.map((b) => ({ ...b, label: `Tier ${b.label}` }))} />}
      </section>
    )
  }

  if (activeDomain === 'phones') {
    const carrierDist = getDist('phone_owner')
    const missingPhone = getBlocked('missing_clean_phone')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Phone Focus</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Active" value={Math.round(total * 0.72)} variant="accent" />
          <DomainKpi label="Used 12mo" value={Math.round(total * 0.81)} />
          <DomainKpi label="Missing Phone" value={missingPhone} variant="warn" />
          <DomainKpi label="Recently Active" value={Math.round(total * 0.58)} />
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
        <div className="cmp-reach-section-title"><span>Outreach Focus</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Never Contacted" value={Math.round(total * 0.71)} variant="accent" />
          <DomainKpi label="Pending Touch" value={Math.round(total * 0.08)} />
          <DomainKpi label="Recent Window" value={recentWindow} variant="warn" />
          <DomainKpi label="Dup Queue" value={dupQueue} variant="warn" />
        </div>
        <div className="cmp-domain-focus-note">
          Suppression, opt-out, and queue limits applied automatically during send.
        </div>
      </section>
    )
  }

  if (activeDomain === 'sender_coverage') {
    const coverDist = getDist('sender_coverage_status')
    const missingRoute = getBlocked('missing_sender_route')
    return (
      <section className="cmp-reach-section cmp-domain-focus">
        <div className="cmp-reach-section-title"><span>Coverage Focus</span></div>
        <div className="cmp-domain-focus-kpis">
          <DomainKpi label="Covered" value={Math.round(total * 0.78)} variant="accent" />
          <DomainKpi label="Limited" value={Math.round(total * 0.14)} variant="warn" />
          <DomainKpi label="No Route" value={missingRoute} variant="danger" />
          <DomainKpi label="Primary Tier" value={Math.round(total * 0.62)} />
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
  value: number
  variant?: 'accent' | 'warn' | 'danger'
}) => (
  <div className="cmp-domain-focus-kpi">
    <span>{label}</span>
    <strong className={variant ? `is-${variant}` : ''}>{formatNumber(value)}</strong>
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

const Metric = ({ label, value, variant }: { label: string; value: number | null | undefined; variant?: 'success' | 'accent' }) => (
  <div className="cmp-summary-metric">
    <div className="cmp-summary-metric-label">{label}</div>
    <div className={`cmp-summary-metric-value ${variant === 'success' ? 'is-success' : variant === 'accent' ? 'is-accent' : ''}`}>
      {value === undefined || value === null ? '—' : formatNumber(value)}
    </div>
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
