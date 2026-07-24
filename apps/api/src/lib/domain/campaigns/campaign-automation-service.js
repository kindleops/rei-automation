import crypto from 'node:crypto'

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { buildSendQueueDedupeKey } from '@/lib/supabase/sms-engine.js'
import { getSystemValue } from '@/lib/system-control.js'
import {
  asBoolean,
  asPositiveInteger,
  clean,
  isEmergencyStopActive,
} from '@/lib/domain/queue/queue-control-safety.js'
import {
  chooseTextgridNumber,
  evaluateCandidateEligibility,
  getSupabaseFeederCandidates,
  renderOutboundTemplate,
} from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { evaluatePreSendEligibility } from '@/lib/domain/outbound/presend-eligibility-engine.js'
import { isValidIanaTimezone } from '@/lib/domain/acquisition-brain/shadow-burst-timing.js'
import { resolveTimezone } from '@/lib/sms/latency.js'
import {
  ageBucketFromMob,
  ageFromMob,
  getCampaignCanonicalSourceMapping,
  getCampaignDomainKeys,
  getCampaignFieldDefinition,
  hydrateCampaignCandidateRowsWithCatalogLayers,
  readCampaignFieldValuesFromCandidate,
} from '@/lib/domain/campaigns/campaign-field-catalog.js'
import {
  activateCampaign,
  CAMPAIGN_STATES,
  isLiveCampaignStatus,
  isQueueableStatus,
  loadCampaignForLifecycle,
  normalizeCampaignStatus,
  transitionCampaignStatus,
} from '@/lib/domain/campaigns/campaign-state-machine.js'
import { normalizeCampaignStageCode } from '@/lib/domain/campaigns/campaign-stage-code.js'
import { resolveLanguage } from '@/lib/domain/campaigns/campaign-canonical-language.js'
import { resolvePropertyTypeScope } from '@/lib/sms/property_scope.js'
import {
  acquireCampaignExecutionLock,
  checkpointCampaignHydration,
  newExecutionLockToken,
  releaseCampaignExecutionLock,
  renewCampaignExecutionLock,
} from '@/lib/domain/campaigns/campaign-execution-lock.js'
import {
  countLiveConfirmedQueueRows,
  isCampaignLiveInconsistentWithQueue,
  mergeLaunchWriteModeIntoInput,
  reconcileCampaignLiveState,
} from '@/lib/domain/campaigns/campaign-live-execution.js'

const DEFAULT_CANDIDATE_SOURCE = 'v_feeder_candidates_fast'
const DEFAULT_SCAN_LIMIT = 1000
const DEFAULT_TARGET_LIMIT = 5000
const ACTIVE_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']
const PREFERRED_PREVIEW_CANDIDATE_SOURCE = 'outbound_feeder_candidates'
const FALLBACK_PREVIEW_CANDIDATE_SOURCE = 'v_sms_ready_contacts'
const PREVIEW_CANDIDATE_SOURCES = new Set([
  'outbound_feeder_candidates',
  'v_feeder_candidates_fast',
  'v_outbound_discovery_open_now',
  'v_outbound_discovery_fresh',
  'v_outbound_candidate_freshness',
  'outbound_candidate_snapshot',
  'v_sms_ready_contacts',
  'v_sms_ready_contacts_clean',
  'v_sms_ready_contacts_expanded',
  'v_sms_campaign_queue_candidates',
  'v_launch_sms_tier1',
])
const PREVIEW_DOMAIN_SOURCES = new Set([
  'v_properties',
  'v_prospects',
  'v_master_owners',
  'v_phones',
  'v_outreach',
  'v_outreach_ctx',
  'v_sender_coverage',
  'v_sender_coverage_ctx',
])
const PREVIEW_FIELD_COLUMN_CANDIDATES = Object.freeze({
  'properties.property_state': ['property_state', 'property_address_state', 'state'],
  'properties.property_zip': ['property_zip', 'property_address_zip', 'zip'],
  'properties.market': ['market', 'canonical_market', 'seller_market', 'market_name'],
  'properties.property_address_city': ['property_address_city', 'city'],
  'properties.property_type': ['property_type', 'canonical_property_group', 'property_class'],
  'prospects.language_preference': ['language_preference', 'best_language', 'language', 'preferred_language'],
  'prospects.matching_flags': ['matching_flags', 'prospect_matching_flags', 'person_flags_text'],
  'prospects.person_flags_text': ['person_flags_text', 'matching_flags', 'prospect_matching_flags'],
  'master_owners.priority_score': ['priority_score', 'master_owner_priority_score'],
  'master_owners.priority_tier': ['priority_tier'],
  'master_owners.owner_type_guess': ['owner_type_guess'],
  'master_owners.follow_up_cadence': ['follow_up_cadence'],
  'phones.phone_owner': ['phone_owner'],
  'phones.activity_status': ['activity_status', 'phone_contact_status', 'contact_status'],
  'phones.usage_12_months': ['usage_12_months'],
  'phones.usage_2_months': ['usage_2_months'],
  'sender_coverage.routing_tier': ['routing_tier', 'selected_textgrid_routing_tier'],
})
const PREVIEW_CANONICAL_MARKET_COLUMNS = Object.freeze(['market', 'canonical_market', 'seller_market', 'market_name'])
const PREVIEW_MARKET_DIAGNOSTIC_FALLBACK_COLUMNS = Object.freeze(['selected_textgrid_market'])
const PREVIEW_SOURCE_COLUMN_DENYLIST = new Set(['mob'])

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function optionalInt(value) {
  const parsed = asPositiveInteger(value, null)
  return parsed || null
}

function firstArrayValue(value) {
  return Array.isArray(value) ? clean(value[0]) || null : clean(value) || null
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item)).filter(Boolean)
  if (!clean(value)) return []
  return clean(value).split(',').map((item) => clean(item)).filter(Boolean)
}

function lower(value) {
  return clean(value).toLowerCase()
}

function normalizeMarket(value) {
  return lower(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function normalizeState(value) {
  return clean(value).toUpperCase()
}

function increment(bucket, key, amount = 1) {
  const safeKey = clean(key) || 'unknown'
  bucket[safeKey] = Number(bucket[safeKey] || 0) + amount
}

function metadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function getTargetFilters(input = {}) {
  const metadata = metadataObject(input.metadata)
  return metadataObject(input.target_filters || input.filters || metadata.target_filters || input)
}

function extractMarketFromCatalogFilters(filters = {}) {
  const domains = ['properties', 'prospects', 'master_owners', 'phones', 'outreach', 'sender_coverage']
  for (const domain of domains) {
    for (const filter of Array.isArray(filters[domain]) ? filters[domain] : []) {
      const field = clean(filter.field_key || filter.fieldKey || filter.field).toLowerCase()
      if (field === 'properties.market' || field.endsWith('.market')) {
        const values = asArray(filter.value)
        if (values.length) return values[0]
      }
    }
  }
  return firstArrayValue(filters.markets)
}

function getCampaignFilterValue(filters = {}, key, fallback = null) {
  if (filters[key] !== undefined && filters[key] !== null && clean(filters[key]) !== '') return filters[key]
  return fallback
}

function normalizeCampaignInput(payload = {}, existing = {}) {
  const filters = getTargetFilters(payload)
  const metadata = metadataObject(payload.metadata)
  const name = clean(payload.name || payload.campaign_name || existing.name || existing.campaign_name)
  const objective = clean(payload.objective || payload.template_use_case || existing.objective || metadata.objective)
  const candidateSource = clean(
    payload.candidate_source ||
      payload.source_view ||
      filters.candidate_source ||
      existing.candidate_source ||
      DEFAULT_CANDIDATE_SOURCE
  )

  const row = {
    ...(name ? { name } : {}),
    description: payload.description ?? existing.description ?? null,
    status: clean(payload.status || existing.status || 'draft') || 'draft',
    objective: objective || null,
    candidate_source: candidateSource,
    market: clean(payload.market || extractMarketFromCatalogFilters(filters) || firstArrayValue(filters.markets) || existing.market) || null,
    state: clean(payload.state || firstArrayValue(filters.states) || existing.state) || null,
    language_policy: clean(payload.language_policy || filters.language || existing.language_policy || 'auto') || 'auto',
    agent_persona: clean(payload.agent_persona || filters.agent_persona || existing.agent_persona) || null,
    daily_cap: optionalInt(payload.daily_cap ?? filters.daily_cap ?? existing.daily_cap),
    total_cap: optionalInt(payload.total_cap ?? filters.total_cap ?? existing.total_cap),
    batch_max: optionalInt(payload.batch_max ?? filters.batch_max ?? filters.max_batch_size ?? existing.batch_max),
    market_cap: optionalInt(payload.market_cap ?? filters.market_cap ?? existing.market_cap),
    per_sender_cap: optionalInt(payload.per_sender_cap ?? filters.per_sender_cap ?? filters.per_number_cap ?? existing.per_sender_cap),
    send_interval_seconds: optionalInt(
      payload.send_interval_seconds ?? filters.interval_seconds ?? filters.send_interval_seconds ?? existing.send_interval_seconds
    ),
    contact_window_start: clean(payload.contact_window_start || filters.custom_window_start || existing.contact_window_start) || null,
    contact_window_end: clean(payload.contact_window_end || filters.custom_window_end || existing.contact_window_end) || null,
    auto_queue_enabled: asBoolean(payload.auto_queue_enabled ?? existing.auto_queue_enabled, false),
    auto_send_enabled: false,
    auto_reply_mode: 'disabled',
    emergency_stop_at: payload.emergency_stop_at ?? existing.emergency_stop_at ?? null,
    metadata: {
      ...metadataObject(existing.metadata),
      ...metadata,
      target_filters: filters,
      campaign_type: clean(payload.campaign_type || metadata.campaign_type) || null,
      template_use_case: clean(payload.template_use_case || filters.template_use_case || 'ownership_check') || 'ownership_check',
      stage_code: clean(payload.stage_code || filters.stage_code || 'S1') || 'S1',
      launch_timezone: clean(payload.metadata?.launch_timezone || payload.launch_timezone || metadata.launch_timezone || existing.metadata?.launch_timezone) || null,
      timezone: clean(payload.metadata?.timezone || payload.timezone || metadata.timezone || existing.metadata?.timezone) || null,
    },
  }

  if (!row.name && !existing.id) row.name = `Campaign ${new Date().toISOString().slice(0, 10)}`
  // Lifecycle status is normalized against the canonical state machine. Legacy
  // readiness markers (ready/live_limited) are mapped onto lifecycle states.
  // Actual lifecycle transitions must go through transitionCampaignStatus; this
  // only sanitizes the persisted value on config writes.
  row.status = normalizeCampaignStatus(row.status)
  return row
}

function filterTypeForField(field) {
  if (['states', 'markets', 'counties', 'cities', 'zip_codes', 'timezones'].includes(field)) return 'geography'
  if (field.includes('template') || field.includes('language') || field.includes('agent')) return 'messaging'
  if (field.includes('cap') || field.includes('window') || field.includes('interval')) return 'schedule'
  if (field.includes('owner') || field.includes('bank') || field.includes('government')) return 'audience'
  return 'property'
}

function filterRowsFromPayload(campaignId, filters = {}) {
  const rows = []
  if (hasCatalogFilterGroups(filters)) {
    for (const domain of getCampaignDomainKeys()) {
      for (const filter of Array.isArray(filters[domain]) ? filters[domain] : []) {
        const field = clean(filter.field_key || filter.fieldKey || filter.field)
        const operator = clean(filter.operator || 'eq') || 'eq'
        const value = filter.value ?? filter.values ?? null
        if (!field || !hasMeaningfulFilterValue(value, operator)) continue
        rows.push({
          campaign_id: campaignId,
          filter_type: domain,
          field,
          operator,
          value,
          label: clean(filter.label) || field.replace(/_/g, ' '),
        })
      }
    }
    return rows
  }
  for (const [field, value] of Object.entries(filters || {})) {
    const isEmptyArray = Array.isArray(value) && value.length === 0
    const isEmptyString = typeof value === 'string' && value.trim() === ''
    if (value === null || value === undefined || isEmptyArray || isEmptyString) continue
    rows.push({
      campaign_id: campaignId,
      filter_type: filterTypeForField(field),
      field,
      operator: Array.isArray(value) ? 'in' : typeof value === 'boolean' ? 'eq' : 'gte_or_eq',
      value,
      label: field.replace(/_/g, ' '),
    })
  }
  return rows
}

async function replaceCampaignFilters(campaignId, filters = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  await supabase.from('campaign_filters').delete().eq('campaign_id', campaignId)
  const rows = filterRowsFromPayload(campaignId, filters)
  if (!rows.length) return { inserted: 0 }
  const { error } = await supabase.from('campaign_filters').insert(rows)
  if (error) throw error
  return { inserted: rows.length }
}

async function recordCampaignEvent(fields = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { error } = await supabase.from('campaign_events').insert({
    campaign_id: fields.campaign_id || null,
    run_id: fields.run_id || null,
    target_id: fields.target_id || null,
    send_window_id: fields.send_window_id || null,
    queue_row_id: fields.queue_row_id || null,
    event_type: clean(fields.event_type || 'campaign_event'),
    severity: clean(fields.severity || 'info') || 'info',
    title: clean(fields.title) || null,
    description: clean(fields.description) || null,
    metadata: metadataObject(fields.metadata),
  })
  if (error) throw error
}

async function startCampaignRun(campaignId, fields = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data, error } = await supabase
    .from('campaign_runs')
    .insert({
      campaign_id: campaignId,
      run_type: clean(fields.run_type || 'campaign_run'),
      status: 'started',
      dry_run: fields.dry_run !== false,
      requested_by: clean(fields.requested_by) || null,
      metadata: metadataObject(fields.metadata),
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

async function finishCampaignRun(runId, patch = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { error } = await supabase
    .from('campaign_runs')
    .update({
      ...patch,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId)
  if (error) throw error
}

function parseMaybeJson(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return value
  const text = clean(value)
  if (!text) return []
  try {
    return JSON.parse(text)
  } catch {
    return text.split(/[,\n;|]+/).map((item) => clean(item)).filter(Boolean)
  }
}

function candidateTags(candidate = {}) {
  const raw = candidate.raw || {}
  const values = [
    raw.property_tags,
    raw.podio_tags,
    raw.tags,
    raw.matching_flags,
    candidate.matching_flags,
  ]
  const tags = new Set()
  for (const value of values) {
    const parsed = parseMaybeJson(value)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'string') tags.add(lower(item))
        else if (item && typeof item === 'object') tags.add(lower(item.label || item.value || item.name))
      }
    } else if (typeof parsed === 'string') {
      for (const item of parsed.split(/[,\n;|]+/)) tags.add(lower(item))
    }
  }
  tags.delete('')
  return tags
}

function candidateField(candidate = {}, ...keys) {
  const raw = candidate.raw || {}
  for (const key of keys) {
    const value = candidate[key] ?? raw[key]
    if (value !== undefined && value !== null && clean(value) !== '') return value
  }
  return null
}

function arrayContainsValue(filterValues, value, normalizer = lower) {
  const values = asArray(filterValues).map((item) => normalizer(item))
  if (!values.length) return true
  const target = normalizer(value)
  return values.includes(target)
}

function candidateMatchesFilters(candidate = {}, filters = {}) {
  const reasons = []
  const state = normalizeState(candidate.state || candidate.property_state || candidate.raw?.property_address_state)
  const market = normalizeMarket(candidate.market || candidate.raw?.market)

  if (!arrayContainsValue(filters.states, state, normalizeState)) reasons.push('filter_state')
  if (!arrayContainsValue(filters.markets, market, normalizeMarket)) reasons.push('filter_market')
  if (!arrayContainsValue(filters.timezones, candidate.timezone)) reasons.push('filter_timezone')
  if (!arrayContainsValue(filters.owner_types, candidateField(candidate, 'owner_type', 'owner_type_guess'))) reasons.push('filter_owner_type')
  if (!arrayContainsValue(filters.property_type, candidateField(candidate, 'property_type'))) reasons.push('filter_property_type')
  if (!arrayContainsValue(filters.property_class, candidate.raw?.property_class)) reasons.push('filter_property_class')

  const tags = candidateTags(candidate)
  const includeAny = asArray(filters.tags_include_any).map(lower)
  const includeAll = asArray(filters.tags_include_all).map(lower)
  const exclude = asArray(filters.tags_exclude).map(lower)
  if (includeAny.length && !includeAny.some((tag) => tags.has(tag))) reasons.push('filter_tags_include_any')
  if (includeAll.length && !includeAll.every((tag) => tags.has(tag))) reasons.push('filter_tags_include_all')
  if (exclude.length && exclude.some((tag) => tags.has(tag))) reasons.push('filter_tags_exclude')

  const numericChecks = [
    ['min_final_acquisition_score', 'final_acquisition_score', 'gte'],
    ['min_equity_percent', 'equity_percent', 'gte'],
    ['equity_amount_min', 'equity_amount', 'gte'],
    ['equity_amount_max', 'equity_amount', 'lte'],
    ['estimated_value_min', 'estimated_value', 'gte'],
    ['estimated_value_max', 'estimated_value', 'lte'],
    ['cash_offer_min', 'cash_offer', 'gte'],
    ['cash_offer_max', 'cash_offer', 'lte'],
    ['units_min', 'units_count', 'gte'],
    ['units_max', 'units_count', 'lte'],
    ['beds_min', 'beds', 'gte'],
    ['beds_max', 'beds', 'lte'],
    ['baths_min', 'baths', 'gte'],
    ['baths_max', 'baths', 'lte'],
    ['sqft_min', 'sqft', 'gte'],
    ['sqft_max', 'sqft', 'lte'],
    ['year_built_min', 'year_built', 'gte'],
    ['year_built_max', 'year_built', 'lte'],
  ]
  for (const [filterKey, candidateKey, op] of numericChecks) {
    const threshold = numberOrNull(filters[filterKey])
    if (threshold === null) continue
    const value = numberOrNull(candidateField(candidate, candidateKey))
    if (value === null) continue
    if (op === 'gte' && value < threshold) reasons.push(`filter_${filterKey}`)
    if (op === 'lte' && value > threshold) reasons.push(`filter_${filterKey}`)
  }

  if (asBoolean(filters.sms_eligible_required, false) && candidate.sms_eligible === false) reasons.push('filter_sms_eligible')
  if (asBoolean(filters.valid_e164_required, true) && !candidate.canonical_e164) reasons.push('filter_valid_phone')
  if (asBoolean(filters.require_linked_property, false) && !candidate.property_id) reasons.push('filter_linked_property')
  if (asBoolean(filters.require_linked_master_owner, false) && !candidate.master_owner_id) reasons.push('filter_linked_master_owner')
  if (asBoolean(filters.require_seller_first_name, false) && candidate.seller_name_missing) reasons.push('filter_seller_first_name')
  if (asBoolean(filters.never_contacted_only, false) && candidate.never_contacted !== true) reasons.push('filter_never_contacted')
  if (asBoolean(filters.likely_owner_required, false)) {
    const status = lower(candidate.identity_alignment?.status)
    const likelyOwner = candidate.likely_owner === true || status === 'verified' || status === 'probable'
    if (!likelyOwner) reasons.push('filter_likely_owner')
  }

  const requestedLanguage = lower(filters.language)
  if (requestedLanguage && requestedLanguage !== 'auto' && requestedLanguage !== 'all') {
    const candidateLanguage = lower(candidate.best_language || candidate.language || 'english')
    if (candidateLanguage && candidateLanguage !== requestedLanguage) reasons.push('filter_language')
  }

  return {
    ok: reasons.length === 0,
    reasons,
  }
}

const EMPTY_FILTER_OPERATORS = new Set(['is_empty', 'is_not_empty'])
const SENDER_COVERAGE_FIELDS = new Set([
  'sender_coverage.routing_allowed',
  'sender_coverage.routing_tier',
  'sender_coverage.selected_textgrid_market',
  'sender_coverage.selected_textgrid_state',
  'sender_coverage.sender_coverage_status',
])

function uniqueClean(values = []) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))]
}

function previewSourcePlan(rawSource) {
  const receivedSource = clean(rawSource) || null
  const defaultCandidates = [PREFERRED_PREVIEW_CANDIDATE_SOURCE, FALLBACK_PREVIEW_CANDIDATE_SOURCE]
  if (!receivedSource) {
    return {
      receivedSource,
      normalizedSource: PREFERRED_PREVIEW_CANDIDATE_SOURCE,
      sourceCandidates: defaultCandidates,
      warnings: [],
      reason: 'default_campaign_candidate_source',
    }
  }

  if (PREVIEW_DOMAIN_SOURCES.has(receivedSource)) {
    return {
      receivedSource,
      normalizedSource: PREFERRED_PREVIEW_CANDIDATE_SOURCE,
      sourceCandidates: defaultCandidates,
      warnings: [
        `preview_source_normalized: ${receivedSource} is a catalog domain source; using campaign candidate source.`,
      ],
      reason: 'catalog_domain_source_normalized',
    }
  }

  if (PREVIEW_CANDIDATE_SOURCES.has(receivedSource)) {
    return {
      receivedSource,
      normalizedSource: receivedSource,
      sourceCandidates: uniqueClean([receivedSource, ...defaultCandidates]),
      warnings: [],
      reason: 'explicit_candidate_source',
    }
  }

  return {
    receivedSource,
    normalizedSource: PREFERRED_PREVIEW_CANDIDATE_SOURCE,
    sourceCandidates: defaultCandidates,
    warnings: [
      `preview_source_normalized: unsupported source ${receivedSource}; using campaign candidate source.`,
    ],
    reason: 'unsupported_source_normalized',
  }
}

function normalizePreviewOperator(operator, field) {
  const raw = clean(operator || field?.operators?.[0]?.key || 'eq')
  const mapped = {
    in: 'is_any_of',
    not_in: 'is_not_any_of',
  }[raw] || raw
  const allowed = new Set((field?.operators || []).map((entry) => entry.key))
  if (allowed.has(mapped)) return mapped
  if (['eq', 'is_any_of', 'is_not_any_of', 'contains_any'].includes(mapped)) return mapped
  return allowed.has('eq') ? 'eq' : clean(field?.operators?.[0]?.key || mapped || 'eq')
}

function normalizeFilterArrayInput(value) {
  if (Array.isArray(value)) return value.flatMap(coerceScalarArray)
  if (value && typeof value === 'object') return coerceScalarArray(value)
  const text = clean(value)
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.flatMap(coerceScalarArray) : [parsed]
    } catch {
      return [value]
    }
  }
  return [value]
}

function normalizePreviewFilterValue(value, operator) {
  if (['is_any_of', 'is_not_any_of', 'contains_any'].includes(operator)) {
    return normalizeFilterArrayInput(value)
  }
  if (operator === 'between') {
    return coerceScalarArray(value).slice(0, 2)
  }
  return value
}

function hasMeaningfulFilterValue(value, operator) {
  if (EMPTY_FILTER_OPERATORS.has(operator)) return true
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulFilterValue(item, operator))
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  if (typeof value === 'boolean') return true
  return clean(value) !== ''
}

function hasCatalogFilterGroups(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return getCampaignDomainKeys().some((domain) => Array.isArray(value[domain]))
}

function emptyDomainCounts() {
  return getCampaignDomainKeys().reduce((counts, domain) => {
    counts[domain] = 0
    return counts
  }, {})
}

function countCatalogFilterGroups(groups = {}) {
  const counts = emptyDomainCounts()
  for (const domain of getCampaignDomainKeys()) {
    counts[domain] = Array.isArray(groups?.[domain]) ? groups[domain].length : 0
  }
  return counts
}

function normalizeCatalogPreviewFilters(input = {}, campaign = null) {
  const metadata = metadataObject(input.metadata)
  const campaignMetadata = metadataObject(campaign?.metadata)
  const candidates = [
    input.filters,
    input.target_filters,
    metadata.target_filters,
    campaignMetadata.target_filters,
  ]
  const groups = candidates.find(hasCatalogFilterGroups) || {}
  const applied = []
  const supported = []
  const unsupported = []
  const unknown = []
  const dropped = []

  for (const domain of getCampaignDomainKeys()) {
    for (const filter of Array.isArray(groups[domain]) ? groups[domain] : []) {
      const rawFieldKey = clean(filter.field_key || filter.fieldKey || filter.key || filter.field)
      const fieldKey = rawFieldKey.includes('.') ? rawFieldKey : rawFieldKey ? `${domain}.${rawFieldKey}` : ''
      const field = getCampaignFieldDefinition(fieldKey)
      if (!field) {
        unknown.push({
          domain,
          field_key: fieldKey || rawFieldKey || null,
          fieldKey: fieldKey || rawFieldKey || null,
          operator: clean(filter.operator) || null,
          value: filter.value ?? filter.values ?? null,
          supported_in_preview: false,
          applied_in_preview: false,
          unsupported_reason: 'unknown_campaign_field',
        })
        dropped.push({
          domain,
          field_key: fieldKey || rawFieldKey || null,
          fieldKey: fieldKey || rawFieldKey || null,
          operator: clean(filter.operator) || null,
          value: filter.value ?? filter.values ?? null,
          reason: 'unknown_campaign_field',
        })
        continue
      }
      const operator = normalizePreviewOperator(filter.operator, field)
      const value = normalizePreviewFilterValue(filter.value ?? filter.values ?? null, operator)
      if (!hasMeaningfulFilterValue(value, operator)) {
        dropped.push({
          domain,
          field_key: field.key,
          fieldKey: field.key,
          operator,
          value,
          reason: 'empty_filter_value',
        })
        continue
      }
      const normalized = {
        field_key: field.key,
        field: field.key.split('.').pop(),
        domain: field.domain,
        category: field.category,
        label: field.label,
        operator,
        value,
        source_column: field.source_column,
        supported_in_preview: Boolean(field.supported_in_preview),
      }
      applied.push(normalized)
      if (field.supported_in_preview) supported.push({ ...normalized, fieldDefinition: field })
      else {
        unsupported.push(normalized)
        dropped.push({
          ...normalized,
          reason: 'unsupported_in_preview',
        })
      }
    }
  }

  return {
    has_catalog_filters: hasCatalogFilterGroups(groups),
    received_domain_counts: countCatalogFilterGroups(groups),
    applied_domain_counts: countCatalogFilterGroups(groupPreviewFiltersByDomain(applied)),
    applied,
    supported,
    unsupported,
    unknown,
    dropped,
    dropped_filter_count: dropped.length,
    pre_filters: supported.filter((filter) => !SENDER_COVERAGE_FIELDS.has(filter.field_key)),
    sender_filters: supported.filter((filter) => SENDER_COVERAGE_FIELDS.has(filter.field_key)),
  }
}

function coerceScalarArray(value) {
  if (Array.isArray(value)) return value.flatMap(coerceScalarArray)
  if (value && typeof value === 'object') {
    const resolved = value.value ?? value.label ?? value.key ?? value.name
    return resolved === undefined ? [] : coerceScalarArray(resolved)
  }
  if (value === null || value === undefined) return []
  return [value]
}

function parseCatalogListValue(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return [value]
  const text = clean(value)
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return text.split(/[,\n;|]+/).map((item) => clean(item)).filter(Boolean)
  }
}

function normalizeComparable(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return clean(value).toLowerCase()
}

function normalizeComparableSlug(value) {
  return normalizeComparable(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function comparableVariants(value) {
  const normalized = normalizeComparable(value)
  const slug = normalizeComparableSlug(value)
  return uniqueClean([normalized, slug])
}

function comparableValueList(values = []) {
  return [...new Set(values.flatMap(comparableVariants).filter(Boolean))]
}

function hasCandidateValue(candidate = {}, key) {
  const raw = candidate.raw || {}
  return (
    (candidate[key] !== undefined && candidate[key] !== null && clean(candidate[key]) !== '') ||
    (raw[key] !== undefined && raw[key] !== null && clean(raw[key]) !== '')
  )
}

function pickCandidateValue(candidate = {}, keys = []) {
  const raw = candidate.raw || {}
  for (const key of keys) {
    if (candidate[key] !== undefined && candidate[key] !== null && clean(candidate[key]) !== '') return candidate[key]
    if (raw[key] !== undefined && raw[key] !== null && clean(raw[key]) !== '') return raw[key]
  }
  return null
}

function mappingCandidatesForField(field) {
  if (!field) return []
  if (field.key === 'prospects.age' || field.key === 'prospects.age_bucket') return ['mob']
  const canonicalMapping = getCampaignCanonicalSourceMapping(field.key)
  return uniqueClean([
    ...(canonicalMapping?.sourceColumns || PREVIEW_FIELD_COLUMN_CANDIDATES[field.key] || []),
    field.key.split('.').pop(),
    field.source_column,
  ])
}

function collectPreviewSourceColumns(rows = []) {
  const available = new Set()
  const nonEmpty = new Set()
  const diagnostic = new Set()
  const derivedFields = new Set()
  const sampled = Array.isArray(rows) ? rows.slice(0, 100) : []

  for (const candidate of sampled) {
    const raw = candidate?.raw && typeof candidate.raw === 'object' ? candidate.raw : {}
    const catalogLayers = candidate?.catalog_layers && typeof candidate.catalog_layers === 'object'
      ? candidate.catalog_layers
      : {}
    for (const key of Object.keys(candidate || {})) {
      if (key === 'raw' || key === 'catalog_layers') continue
      available.add(key)
      if (clean(candidate[key]) !== '') nonEmpty.add(key)
      if (!PREVIEW_SOURCE_COLUMN_DENYLIST.has(key)) diagnostic.add(key)
    }
    for (const key of Object.keys(raw)) {
      available.add(key)
      if (clean(raw[key]) !== '') nonEmpty.add(key)
      if (PREVIEW_SOURCE_COLUMN_DENYLIST.has(key)) {
        derivedFields.add('prospects.age')
        derivedFields.add('prospects.age_bucket')
      } else {
        diagnostic.add(key)
      }
    }
    for (const layer of Object.values(catalogLayers)) {
      const rows = Array.isArray(layer) ? layer : [layer]
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        for (const key of Object.keys(row)) {
          available.add(key)
          if (clean(row[key]) !== '') nonEmpty.add(key)
          if (PREVIEW_SOURCE_COLUMN_DENYLIST.has(key)) {
            derivedFields.add('prospects.age')
            derivedFields.add('prospects.age_bucket')
          } else {
            diagnostic.add(key)
          }
        }
      }
    }
  }

  return {
    available,
    nonEmpty,
    previewSourceColumns: [...diagnostic].sort(),
    previewSourceDerivedFields: [...derivedFields].sort(),
    sampledRowCount: sampled.length,
    catalogLayersHydrated: sampled.some((candidate) => Boolean(candidate?.catalog_layers)),
  }
}

function resolvePreviewFieldMapping(filter, sourceColumns) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  const candidates = mappingCandidatesForField(field)
  const available = sourceColumns?.available || new Set()
  const sampledRowCount = Number(sourceColumns?.sampledRowCount || 0)

  if (!field) {
    return {
      ok: false,
      reason: 'unknown_campaign_field',
      preview_columns: [],
      missing_preview_columns: candidates,
    }
  }

  if (field.key === 'prospects.age' || field.key === 'prospects.age_bucket') {
    if (!sampledRowCount || available.has('mob')) {
      return {
        ok: true,
        preview_column: field.key,
        preview_columns: [field.key],
        derived_from: 'mob',
        column_unverified: !sampledRowCount,
      }
    }
    return {
      ok: false,
      reason: 'unsupported_in_preview',
      message: `${field.label} requires prospect birth-month data that is not present in the preview candidate source.`,
      preview_columns: [],
      missing_preview_columns: ['mob'],
      derived_from: 'mob',
    }
  }

  if (field.key === 'properties.market') {
    const canonicalMatches = PREVIEW_CANONICAL_MARKET_COLUMNS.filter((column) => available.has(column))
    if (canonicalMatches.length || !sampledRowCount) {
      return {
        ok: true,
        preview_column: canonicalMatches[0] || PREVIEW_CANONICAL_MARKET_COLUMNS[0],
        preview_columns: canonicalMatches.length ? canonicalMatches : [...PREVIEW_CANONICAL_MARKET_COLUMNS],
        column_unverified: !sampledRowCount,
      }
    }
    const diagnosticFallbackColumns = PREVIEW_MARKET_DIAGNOSTIC_FALLBACK_COLUMNS.filter((column) => available.has(column))
    return {
      ok: false,
      reason: 'unsupported_in_preview',
      message: 'properties.market requires a canonical market column; city, county, owner_location, and locality columns are not allowed.',
      preview_columns: [],
      missing_preview_columns: [...PREVIEW_CANONICAL_MARKET_COLUMNS],
      diagnostic_fallback_columns: diagnosticFallbackColumns,
      warning: 'canonical_market_unavailable',
    }
  }

  if (SENDER_COVERAGE_FIELDS.has(field.key)) {
    const matched = candidates.filter((column) => available.has(column))
    return {
      ok: true,
      preview_column: matched[0] || candidates[0] || field.key.split('.').pop(),
      preview_columns: matched.length ? matched : candidates,
      runtime_derived: true,
      column_unverified: !sampledRowCount,
    }
  }

  const matched = candidates.filter((column) => available.has(column))
  if (matched.length || !sampledRowCount) {
    return {
      ok: true,
      preview_column: matched[0] || candidates[0] || field.key.split('.').pop(),
      preview_columns: matched.length ? matched : candidates,
      column_unverified: !sampledRowCount,
    }
  }

  return {
    ok: false,
    reason: 'unsupported_in_preview',
    preview_columns: [],
    missing_preview_columns: candidates,
  }
}

function catalogFieldValue(candidate = {}, filter, runtime = {}) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  if (!field) return null
  const column = field.key.split('.').pop()
  const raw = candidate.raw || {}

  if (field.key === 'prospects.age') {
    return ageFromMob(candidate.mob ?? raw.mob)
  }
  if (field.key === 'prospects.age_bucket') {
    return ageBucketFromMob(candidate.mob ?? raw.mob)
  }
  if (field.key === 'sender_coverage.routing_allowed') {
    if (runtime.routing) return Boolean(runtime.routing.ok || runtime.routing.routing_allowed)
    return candidate.routing_allowed ?? raw.routing_allowed ?? null
  }
  if (field.key === 'sender_coverage.routing_tier') {
    return runtime.routing?.routing_tier ?? candidate.routing_tier ?? raw.routing_tier ?? candidate.selected_textgrid_routing_tier ?? raw.selected_textgrid_routing_tier ?? null
  }
  if (field.key === 'sender_coverage.selected_textgrid_market') {
    return runtime.routing?.selected_textgrid_market ?? runtime.routing?.selected?.market ?? candidate.selected_textgrid_market ?? raw.selected_textgrid_market ?? null
  }
  if (field.key === 'sender_coverage.selected_textgrid_state') {
    return runtime.routing?.selected_textgrid_state ?? runtime.routing?.seller_state ?? candidate.selected_textgrid_state ?? raw.selected_textgrid_state ?? candidate.state ?? raw.property_state ?? null
  }
  if (field.key === 'sender_coverage.sender_coverage_status') {
    if (runtime.routing) return runtime.routing.ok ? 'Covered' : 'No Route'
    return candidate.sender_coverage_status ?? raw.sender_coverage_status ?? null
  }
  if (field.key === 'outreach.duplicate_queue_status') {
    return candidate.duplicate_queue_status ?? raw.duplicate_queue_status ?? null
  }

  const linkedValues = readCampaignFieldValuesFromCandidate(candidate, field)
  if (linkedValues.length) return linkedValues.length === 1 ? linkedValues[0] : linkedValues

  return pickCandidateValue(candidate, mappingCandidatesForField(field)) ?? candidate[column] ?? raw[column] ?? candidate[field.source_column] ?? raw[field.source_column] ?? null
}

function parseCatalogActualValues(actualValue, filter) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  if (
    field?.type === 'json' ||
    field?.key?.includes('tags_text') ||
    field?.key?.includes('flags_text') ||
    field?.key?.endsWith('.matching_flags')
  ) {
    return parseCatalogListValue(actualValue).flatMap(coerceScalarArray)
  }
  if (Array.isArray(actualValue) || (actualValue && typeof actualValue === 'object')) {
    return parseCatalogListValue(actualValue).flatMap(coerceScalarArray)
  }
  return coerceScalarArray(actualValue)
}

function matchCatalogFilterValue(actualValue, filter) {
  const operator = normalizePreviewOperator(filter.operator || 'eq', filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key))
  const expectedValues = ['is_any_of', 'is_not_any_of', 'contains_any'].includes(operator)
    ? normalizeFilterArrayInput(filter.value)
    : coerceScalarArray(filter.value)
  const actualValues = parseCatalogActualValues(actualValue, filter)
  const hasActual = actualValues.some((value) => clean(value) !== '')

  if (operator === 'is_empty') return !hasActual
  if (operator === 'is_not_empty') return hasActual

  if (filter.fieldDefinition?.type === 'boolean' || operator === 'is_true' || operator === 'is_false') {
    const actual = asBoolean(actualValue, false)
    if (operator === 'is_true') return actual === true
    if (operator === 'is_false') return actual === false
    return expectedValues.some((value) => actual === asBoolean(value, false))
  }

  if (['gte', 'lte', 'between', 'eq'].includes(operator) && filter.fieldDefinition?.type === 'number') {
    const actual = numberOrNull(actualValue)
    if (actual === null) return false
    if (operator === 'gte') {
      const min = numberOrNull(expectedValues[0])
      return min !== null && actual >= min
    }
    if (operator === 'lte') {
      const max = numberOrNull(expectedValues[0])
      return max !== null && actual <= max
    }
    if (operator === 'between') {
      const min = numberOrNull(expectedValues[0])
      const max = numberOrNull(expectedValues[1])
      if (min === null || max === null) return false
      return actual >= min && actual <= max
    }
    if (operator === 'eq' && expectedValues.length > 1) {
      return expectedValues.map(numberOrNull).filter((value) => value !== null).includes(actual)
    }
    return actual === numberOrNull(expectedValues[0])
  }

  if (['on_or_after', 'on_or_before', 'between'].includes(operator)) {
    const actual = new Date(clean(actualValue)).getTime()
    if (!Number.isFinite(actual)) return false
    const first = new Date(clean(expectedValues[0])).getTime()
    const second = new Date(clean(expectedValues[1])).getTime()
    if (operator === 'on_or_after') return Number.isFinite(first) && actual >= first
    if (operator === 'on_or_before') return Number.isFinite(first) && actual <= first
    if (!Number.isFinite(first) || !Number.isFinite(second)) return false
    return actual >= first && actual <= second
  }

  const actualComparable = comparableValueList(actualValues)
  const expectedComparable = comparableValueList(expectedValues)

  if (operator === 'contains' || operator === 'contains_any') {
    const lowerHaystack = actualValues.map(normalizeComparable).join(' ')
    const slugHaystack = actualValues.map(normalizeComparableSlug).join(' ')
    return expectedValues
      .flatMap((value) => [normalizeComparable(value), normalizeComparableSlug(value)])
      .filter(Boolean)
      .some((value) => lowerHaystack.includes(value) || slugHaystack.includes(value) || actualComparable.includes(value))
  }
  if (operator === 'is_not_any_of') {
    return expectedComparable.length > 0 && !actualComparable.some((value) => expectedComparable.includes(value))
  }
  if (operator === 'is_any_of' || (operator === 'eq' && expectedComparable.length > 1)) {
    return expectedComparable.length > 0 && actualComparable.some((value) => expectedComparable.includes(value))
  }

  return expectedComparable.length > 0 && actualComparable.includes(expectedComparable[0])
}

function candidateMatchesCatalogFilters(candidate = {}, filters = [], runtime = {}) {
  const reasons = []
  for (const filter of filters) {
    const actual = catalogFieldValue(candidate, filter, runtime)
    if (!matchCatalogFilterValue(actual, filter)) {
      reasons.push(`filter_${filter.field_key}`)
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
  }
}

function publicFilter(filter = {}) {
  const { fieldDefinition, ...rest } = filter
  return rest
}

function resolveCatalogFiltersForPreview(catalogFilters = {}, sourceColumns = {}) {
  const supported = []
  const mappingUnsupported = []

  for (const filter of catalogFilters.supported || []) {
    const mapping = resolvePreviewFieldMapping(filter, sourceColumns)
    const normalized = {
      ...filter,
      preview_column: mapping.preview_column || null,
      preview_columns: mapping.preview_columns || [],
      preview_mapping: {
        field_key: filter.field_key,
        preview_column: mapping.preview_column || null,
        preview_columns: mapping.preview_columns || [],
        derived_from: mapping.derived_from || null,
        runtime_derived: Boolean(mapping.runtime_derived),
        column_unverified: Boolean(mapping.column_unverified),
      },
    }
    if (mapping.ok) {
      supported.push({
        ...normalized,
        applied_in_preview: true,
      })
    } else {
      mappingUnsupported.push({
        ...publicFilter(normalized),
        supported_in_preview: false,
        applied_in_preview: false,
        unsupported_reason: mapping.reason || 'unsupported_in_preview',
        missing_preview_columns: mapping.missing_preview_columns || [],
        diagnostic_fallback_columns: mapping.diagnostic_fallback_columns || [],
        warning: mapping.warning || null,
        message: mapping.message || null,
      })
    }
  }

  const unsupported = [
    ...(catalogFilters.unsupported || []).map((filter) => ({
      ...publicFilter(filter),
      supported_in_preview: false,
      applied_in_preview: false,
      unsupported_reason: 'unsupported_in_preview',
    })),
    ...mappingUnsupported,
  ]
  const unknown = (catalogFilters.unknown || []).map((filter) => ({
    ...publicFilter(filter),
    supported_in_preview: false,
    applied_in_preview: false,
    unsupported_reason: 'unknown_campaign_field',
  }))

  return {
    ...catalogFilters,
    unknown,
    applied: [
      ...supported.map(publicFilter),
      ...unsupported,
      ...unknown,
    ],
    supported,
    unsupported,
    pre_filters: supported.filter((filter) => !SENDER_COVERAGE_FIELDS.has(filter.field_key)),
    sender_filters: supported.filter((filter) => SENDER_COVERAGE_FIELDS.has(filter.field_key)),
  }
}

function shouldRetryFallbackSourceForMappings(source, sourceColumns = {}, catalogFilters = {}, options = {}) {
  if (source?.source !== PREFERRED_PREVIEW_CANDIDATE_SOURCE) return false
  if (!options.candidate_source_candidates?.includes(FALLBACK_PREVIEW_CANDIDATE_SOURCE)) return false
  if (!catalogFilters.supported?.length) return false

  const nonEmpty = sourceColumns.nonEmpty || new Set()
  const needsAny = (columns) => !columns.some((column) => nonEmpty.has(column))

  return catalogFilters.supported.some((filter) => {
    if (filter.field_key === 'properties.property_type') return needsAny(['property_type', 'property_class'])
    if (filter.field_key === 'prospects.age_bucket') return needsAny(['mob'])
    if (filter.field_key === 'prospects.age') return needsAny(['mob'])
    if (filter.field_key === 'prospects.matching_flags') return needsAny(['matching_flags', 'prospect_matching_flags'])
    if (filter.field_key === 'properties.market') return needsAny(['market', 'canonical_market', 'seller_market', 'market_name'])
    if (filter.field_key === 'properties.property_address_city') return needsAny(['property_address_city', 'city'])
    if (filter.field_key === 'properties.property_state') return needsAny(['property_state', 'property_address_state', 'state'])
    if (filter.field_key === 'properties.property_zip') return needsAny(['property_zip', 'property_address_zip', 'zip'])
    if (filter.field_key === 'prospects.language_preference') return needsAny(['language_preference', 'best_language', 'language', 'preferred_language'])
    if (filter.field_key === 'prospects.person_flags_text') return needsAny(['person_flags_text', 'matching_flags', 'prospect_matching_flags'])
    if (filter.field_key === 'master_owners.priority_tier') return needsAny(['priority_tier'])
    if (filter.field_key === 'master_owners.owner_type_guess') return needsAny(['owner_type_guess'])
    if (filter.field_key === 'master_owners.follow_up_cadence') return needsAny(['follow_up_cadence'])
    if (filter.field_key === 'phones.phone_owner') return needsAny(['phone_owner'])
    if (filter.field_key === 'phones.activity_status') return needsAny(['activity_status', 'phone_contact_status', 'contact_status'])
    if (filter.field_key === 'phones.usage_12_months') return needsAny(['usage_12_months'])
    if (filter.field_key === 'phones.usage_2_months') return needsAny(['usage_2_months'])
    return false
  })
}

function previewOptionsFromInput(input = {}, campaign = null) {
  const filters = getTargetFilters(input)
  const metadata = metadataObject(campaign?.metadata)
  const campaignFilters = metadataObject(metadata.target_filters)
  const catalogFilters = normalizeCatalogPreviewFilters(input, campaign)
  const sourcePlan = previewSourcePlan(input.source || input.candidate_source || campaign?.candidate_source || filters.candidate_source || campaignFilters.candidate_source)
  const mergedFilters = {
    ...campaignFilters,
    ...filters,
    ...(catalogFilters.has_catalog_filters ? { require_linked_property: true, valid_e164_required: false } : {}),
  }
  const scanLimit = asPositiveInteger(input.scan_limit ?? input.candidate_fetch_limit ?? mergedFilters.scan_limit, DEFAULT_SCAN_LIMIT)
  const targetLimit = asPositiveInteger(
    input.limitPreview ?? input.limit_preview ?? input.limit ?? input.target_limit ?? campaign?.total_cap ?? campaign?.daily_cap ?? mergedFilters.total_cap,
    DEFAULT_TARGET_LIMIT
  )
  const catalogScanFloor = Math.max(targetLimit, 1)
  const effectiveScanLimit = catalogFilters.supported.length ? Math.max(scanLimit, catalogScanFloor) : scanLimit
  return {
    filters: mergedFilters,
    catalog_filters: catalogFilters,
    candidate_source: sourcePlan.normalizedSource || DEFAULT_CANDIDATE_SOURCE,
    candidate_source_candidates: sourcePlan.sourceCandidates,
    received_source: sourcePlan.receivedSource,
    source_normalization_reason: sourcePlan.reason,
    source_warnings: sourcePlan.warnings,
    market: clean(input.market || campaign?.market || firstArrayValue(mergedFilters.markets)) || null,
    state: clean(input.state || campaign?.state || firstArrayValue(mergedFilters.states)) || null,
    scan_limit: Math.max(1, Math.min(effectiveScanLimit, 5000)),
    target_limit: Math.max(1, Math.min(targetLimit, 5000)),
    template_use_case: clean(input.template_use_case || metadata.template_use_case || campaign?.objective || mergedFilters.template_use_case || 'ownership_check') || 'ownership_check',
    stage_code: normalizeCampaignStageCode(input.stage_code || metadata.stage_code || mergedFilters.stage_code, 'S1'),
    touch_number: asPositiveInteger(input.touch_number || mergedFilters.touch_number, 1),
    within_contact_window_now: asBoolean(input.within_contact_window_now ?? input.respect_contact_window ?? mergedFilters.within_contact_window_now, false),
    routing_safe_only: asBoolean(input.routing_safe_only ?? mergedFilters.routing_safe_only, true),
    allow_phone_fallback: asBoolean(input.allow_phone_fallback ?? mergedFilters.allow_phone_fallback, false),
    debug_templates: input.debug_templates !== false,
    campaign_session_id: clean(input.campaign_session_id || campaign?.id) || `campaign-preview-${Date.now()}`,
    now: input.now || new Date().toISOString(),
    frontend_payload_domain_counts: metadataObject(input.frontend_payload_domain_counts),
    frontend_dropped_filter_count: Number(input.frontend_dropped_filter_count || 0),
    frontend_dropped_filters: Array.isArray(input.frontend_dropped_filters) ? input.frontend_dropped_filters : [],
    request_id: clean(input.request_id || input.requestId) || null,
    include_diagnostics: asBoolean(
      input.proof ?? input.debug ?? input.dev ?? input.include_diagnostics ?? process.env.NODE_ENV !== 'production',
      false
    ),
    catalog_preview_defaults_added: catalogFilters.has_catalog_filters,
  }
}

function buildTargetSnapshot(campaign, candidate, routing, rendered, index) {
  const templateId = clean(rendered?.selected_template_id || rendered?.template?.template_id || rendered?.template?.id)
  const identityStatus = clean(candidate.identity_alignment?.status) || 'unknown'
  return {
    campaign_id: campaign?.id || null,
    campaign_key: `ct:${campaign?.id || 'preview'}:${crypto
      .createHash('sha1')
      .update([candidate.master_owner_id, candidate.property_id, candidate.phone_id, candidate.canonical_e164, index].join('|'))
      .digest('hex')
      .slice(0, 24)}`,
    campaign_name: campaign?.name || null,
    market: clean(candidate.market) || clean(campaign?.market) || 'unknown',
    asset_type: clean(candidate.canonical_property_group || candidate.property_type || 'campaign_automation'),
    strategy: clean(campaign?.objective || rendered?.template_use_case || 'ownership_check') || 'ownership_check',
    language: clean(rendered?.language || candidate.best_language || candidate.language || campaign?.language_policy || 'auto') || 'auto',
    source_view_name: clean(campaign?.candidate_source || DEFAULT_CANDIDATE_SOURCE),
    daily_cap: campaign?.daily_cap || null,
    status: 'ready',
    master_owner_id: clean(candidate.master_owner_id) || null,
    property_id: clean(candidate.property_id) || null,
    phone_id: clean(candidate.phone_id || candidate.best_phone_id) || null,
    to_phone_number: clean(candidate.canonical_e164) || null,
    owner_name: clean(candidate.owner_display_name || candidate.seller_full_name || candidate.seller_name) || null,
    property_address: clean(candidate.property_address || candidate.property_address_full) || null,
    state: normalizeState(candidate.state || candidate.property_state) || null,
    timezone: clean(candidate.timezone) || null,
    priority_score: numberOrNull(candidate.final_acquisition_score),
    identity_status: identityStatus,
    routing_status: routing?.ok ? 'ready' : 'blocked',
    suppression_status: 'clear',
    template_status: rendered?.ok ? 'ready' : 'blocked',
    target_status: 'ready',
    block_reason: null,
    metadata: {
      source: 'campaign_automation_phase_1',
      candidate_source: campaign?.candidate_source || DEFAULT_CANDIDATE_SOURCE,
      selected_textgrid_number_id: routing?.selected?.id || null,
      selected_textgrid_market: routing?.selected?.market || null,
      routing_tier: routing?.routing_tier || null,
      routing_rule_name: routing?.routing_rule_name || null,
      template_id: templateId || null,
      template_use_case: rendered?.template_use_case || null,
      template_name: rendered?.template?.template_name || null,
      rendered_message_preview: clean(rendered?.rendered_message_body).slice(0, 180),
      identity_alignment: candidate.identity_alignment || null,
      candidate_snapshot: {
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        phone_id: candidate.phone_id || candidate.best_phone_id,
        market: candidate.market,
        state: candidate.state,
        language: candidate.best_language || candidate.language || null,
        final_acquisition_score: candidate.final_acquisition_score,
      },
    },
  }
}

function readinessScore({ matched, ready, blockers }) {
  if (!matched) return 0
  const base = Math.round((ready / matched) * 100)
  const hardPenalty = Math.min(30, Number(blockers.routing_blocked || 0) + Number(blockers.template_blocked || 0))
  return Math.max(0, Math.min(100, base - hardPenalty))
}

function incrementListValues(bucket, value) {
  for (const item of parseCatalogListValue(value)) {
    if (item && typeof item === 'object') {
      increment(bucket, item.label || item.value || item.name || item.key || 'unknown')
    } else {
      increment(bucket, item || 'unknown')
    }
  }
}

function bucketArray(bucket = {}) {
  return Object.entries(bucket)
    .map(([value, count]) => ({ value, label: value, count: Number(count || 0) }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

function legacyDistributionArray(distributions = {}) {
  return [
    { key: 'markets', label: 'Markets', buckets: bucketArray(distributions.markets).map(({ label, count }) => ({ label, count })) },
    { key: 'languages', label: 'Languages', buckets: bucketArray(distributions.languages).map(({ label, count }) => ({ label, count })) },
    { key: 'propertyTypes', label: 'Property Types', buckets: bucketArray(distributions.propertyTypes).map(({ label, count }) => ({ label, count })) },
    { key: 'matchingFlags', label: 'Matching Flags', buckets: bucketArray(distributions.matchingFlags).map(({ label, count }) => ({ label, count })) },
    { key: 'routingTiers', label: 'Routing Tiers', buckets: bucketArray(distributions.routingTiers).map(({ label, count }) => ({ label, count })) },
  ]
}

function sumBlockedReasons(blocked = {}, reasonKeys = []) {
  const normalized = new Set(reasonKeys.map((reason) => lower(reason)))
  return Object.entries(blocked).reduce((sum, [reason, count]) => {
    return normalized.has(lower(reason)) ? sum + Number(count || 0) : sum
  }, 0)
}

const ELIGIBILITY_REASON_GROUPS = Object.freeze([
  {
    key: 'missing_master_owner',
    label: 'Missing master owner',
    reasons: ['NO_MASTER_OWNER', 'filter_linked_master_owner'],
  },
  {
    key: 'missing_prospect',
    label: 'Missing prospect',
    reasons: ['NO_PROSPECT', 'filter_linked_prospect'],
  },
  {
    key: 'missing_phone',
    label: 'Missing phone',
    reasons: ['NO_BEST_PHONE', 'NO_VALID_PHONE', 'NO_PHONE', 'missing_phone', 'filter_valid_phone'],
  },
  {
    key: 'phone_sms_ineligible',
    label: 'Phone SMS ineligible',
    reasons: ['SMS_INELIGIBLE', 'filter_sms_eligible', 'INTERNAL_TEST_PHONE', 'PHONE_WRONG_NUMBER', 'wrong_number', 'WRONG_NUMBER'],
  },
  {
    key: 'dnc_or_opt_out',
    label: 'DNC / opt-out',
    reasons: ['TRUE_OPT_OUT', 'DNC', 'OPT_OUT'],
  },
  {
    key: 'suppressed',
    label: 'Suppressed',
    reasons: ['SUPPRESSED', 'suppression_blocked'],
  },
  {
    key: 'prior_touch',
    label: 'Already contacted / prior touch',
    reasons: ['PENDING_PRIOR_TOUCH', 'RECENTLY_CONTACTED', 'PHONE_LEVEL_COOLDOWN', 'PRIOR_TOUCH_COOLDOWN', 'COLD_OUTBOUND_TOUCH_CAP'],
  },
  {
    key: 'pending_queue_rows',
    label: 'Pending queue rows',
    reasons: ['ACTIVE_QUEUE_ITEM', 'DUPLICATE_QUEUE_ITEM', 'duplicate_phone', 'duplicate_owner'],
  },
  {
    key: 'sender_coverage',
    label: 'Sender coverage',
    reasons: ['routing_blocked', 'ROUTING_BLOCKED', 'NO_VALID_TEXTGRID_NUMBER', 'filter_sender_coverage'],
  },
  {
    key: 'template_availability',
    label: 'Campaign stage / template',
    reasons: ['NO_TEMPLATE', 'TEMPLATE_RENDER_FAILED', 'template_blocked'],
  },
  {
    key: 'local_contact_window',
    label: 'Local contact window now',
    reasons: ['OUTSIDE_CONTACT_WINDOW'],
  },
  {
    key: 'identity_hold',
    label: 'Identity hold',
    reasons: ['IDENTITY_MISMATCH', 'IDENTITY_NOT_VERIFIED', 'MARKET_IDENTITY_QUARANTINE'],
  },
  {
    key: 'campaign_target_limit',
    label: 'Campaign target limit',
    reasons: ['campaign_target_limit_reached'],
  },
])

function buildBlockedSummary(blocked = {}) {
  return {
    suppressed: sumBlockedReasons(blocked, ['SUPPRESSED', 'suppression_blocked']),
    dnc: sumBlockedReasons(blocked, ['TRUE_OPT_OUT', 'DNC', 'OPT_OUT']),
    wrongNumber: sumBlockedReasons(blocked, ['wrong_number', 'WRONG_NUMBER', 'PHONE_WRONG_NUMBER']),
    noPhone: sumBlockedReasons(blocked, ['NO_VALID_PHONE', 'NO_BEST_PHONE', 'NO_PHONE', 'missing_phone', 'filter_valid_phone']),
    noSenderCoverage: sumBlockedReasons(blocked, ['routing_blocked', 'ROUTING_BLOCKED', 'NO_VALID_TEXTGRID_NUMBER']),
    cooldown: sumBlockedReasons(blocked, [
      'OUTSIDE_CONTACT_WINDOW',
      'RECENTLY_CONTACTED',
      'PHONE_LEVEL_COOLDOWN',
      'PRIOR_TOUCH_COOLDOWN',
      'COLD_OUTBOUND_TOUCH_CAP',
    ]),
    identityHold: sumBlockedReasons(blocked, ['IDENTITY_MISMATCH', 'IDENTITY_NOT_VERIFIED', 'MARKET_IDENTITY_QUARANTINE']),
    noTemplate: sumBlockedReasons(blocked, ['NO_TEMPLATE', 'TEMPLATE_RENDER_FAILED', 'template_blocked']),
    pendingPriorTouch: sumBlockedReasons(blocked, ['PENDING_PRIOR_TOUCH']),
    duplicateQueue: sumBlockedReasons(blocked, ['ACTIVE_QUEUE_ITEM', 'DUPLICATE_QUEUE_ITEM', 'duplicate_phone', 'duplicate_owner']),
  }
}

function buildBlockedWaterfall(blocked = {}) {
  const summary = buildBlockedSummary(blocked)
  return [
    { key: 'suppressed', label: 'Suppressed', count: summary.suppressed },
    { key: 'dnc', label: 'DNC / opt-out', count: summary.dnc },
    { key: 'wrongNumber', label: 'Wrong number', count: summary.wrongNumber },
    { key: 'noPhone', label: 'No clean phone', count: summary.noPhone },
    { key: 'noSenderCoverage', label: 'No sender coverage', count: summary.noSenderCoverage },
    { key: 'cooldown', label: 'Cooldown / contact window', count: summary.cooldown },
    { key: 'identityHold', label: 'Identity hold', count: summary.identityHold },
    { key: 'noTemplate', label: 'No template', count: summary.noTemplate },
    { key: 'pendingPriorTouch', label: 'Pending prior touch', count: summary.pendingPriorTouch },
    { key: 'duplicateQueue', label: 'Duplicate queue', count: summary.duplicateQueue },
  ].filter((item) => Number(item.count || 0) > 0)
}

function buildExplicitBlockedWaterfall(blocked = {}) {
  const grouped = ELIGIBILITY_REASON_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    count: sumBlockedReasons(blocked, group.reasons),
    source: 'candidate_window',
    reason_codes: group.reasons,
  }))
  const knownReasons = new Set(ELIGIBILITY_REASON_GROUPS.flatMap((group) => group.reasons.map((reason) => lower(reason))))
  const otherCount = Object.entries(blocked).reduce((sum, [reason, count]) => {
    return knownReasons.has(lower(reason)) ? sum : sum + Number(count || 0)
  }, 0)
  return [
    ...grouped,
    {
      key: 'other',
      label: 'Other blockers',
      count: otherCount,
      source: 'candidate_window',
      reason_codes: Object.keys(blocked).filter((reason) => !knownReasons.has(lower(reason))),
    },
  ]
}

function compactNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function layerCountValue(fullReach = {}, field, sampleValue = null) {
  const fullValue = compactNumber(fullReach[field])
  if (fullValue !== null) {
    return {
      count: fullValue,
      source: 'full_source',
    }
  }
  return {
    count: compactNumber(sampleValue) || 0,
    source: 'candidate_window',
  }
}

function buildEligibilityWaterfall({
  totalReachMatched = 0,
  fullReach = {},
  summary = {},
  blocked = {},
  cleanTargetCount = 0,
  cleanTargetsSource = 'candidate_window',
  candidateWindowCleanTargets = 0,
  queueableToday = 0,
  effectiveOptions = {},
}) {
  const layerCounts = summary.layerCounts || emptyLayerCounts()
  const linkedMasterOwners = layerCountValue(fullReach, 'linked_master_owners_count', layerCounts.masterOwnersMatched)
  const linkedProspects = layerCountValue(fullReach, 'linked_prospects_count', layerCounts.prospectsMatched)
  const linkedPhones = layerCountValue(fullReach, 'linked_phones_count', layerCounts.phonesMatched)
  const smsEligiblePhones = layerCountValue(fullReach, 'sms_eligible_phones_count', null)
  const senderCovered = layerCountValue(fullReach, 'sender_covered_count', null)
  const readyToQueue = layerCountValue(fullReach, 'ready_to_queue_count', summary.ready_to_queue)
  const validPhone = layerCountValue(fullReach, 'property_best_phone_count', null)
  const candidateWindowMatched = Number(summary.filter_matched || 0)
  const explicitBlocks = buildExplicitBlockedWaterfall(blocked)

  return [
    {
      key: 'matched_properties',
      label: 'Matched properties',
      count: Number(totalReachMatched || 0),
      kind: 'pass',
      source: fullReach.countSource || 'public.properties',
      description: 'Full source-table count anchored on public.properties.',
    },
    {
      key: 'linked_master_owner',
      label: 'Linked master owner',
      count: linkedMasterOwners.count,
      kind: 'pass',
      source: linkedMasterOwners.source,
      description: 'Properties with a master_owners join through master_owner_id.',
    },
    {
      key: 'linked_prospect',
      label: 'Linked prospect',
      count: linkedProspects.count,
      kind: 'pass',
      source: linkedProspects.source,
      description: 'Properties whose master owner joins to at least one prospect.',
    },
    {
      key: 'linked_phone',
      label: 'Linked phone',
      count: linkedPhones.count,
      kind: 'pass',
      source: linkedPhones.source,
      description: 'Properties whose master owner joins to at least one phone.',
    },
    {
      key: 'property_best_phone',
      label: 'Best phone on property',
      count: validPhone.count,
      kind: 'pass',
      source: validPhone.source,
      description: 'Properties with a denormalized best_phone_id on public.properties.',
    },
    {
      key: 'phone_sms_eligible',
      label: 'SMS eligible phones',
      count: smsEligiblePhones.count,
      kind: 'pass',
      source: smsEligiblePhones.source,
      description: 'Full source graph count of linked phones with a valid SMS-capable phone and no wrong-number flag.',
    },
    {
      key: 'candidate_window_matched',
      label: 'Candidate window matched',
      count: candidateWindowMatched,
      kind: 'sample',
      source: 'candidate_window',
      description: 'Preview candidate rows that matched the active filters before queue checks.',
    },
    ...explicitBlocks.map((block) => ({
      key: `blocked_${block.key}`,
      label: block.label,
      count: Number(block.count || 0),
      kind: 'block',
      source: block.source,
      reason_codes: block.reason_codes,
    })),
    {
      key: 'clean_targets',
      label: 'Clean targets',
      count: Number(cleanTargetCount || 0),
      kind: cleanTargetsSource === 'candidate_window' ? 'sample' : 'pass',
      source: cleanTargetsSource,
      description: cleanTargetsSource === 'candidate_window'
        ? 'Candidate-window estimate after compliance, phone, and identity blockers.'
        : 'Full source graph count after phone quality and outreach suppression.',
    },
    {
      key: 'sender_covered',
      label: 'Sender covered',
      count: senderCovered.count,
      kind: 'pass',
      source: senderCovered.source,
      description: 'Full source graph count with an active sender route for the target market.',
    },
    {
      key: 'candidate_window_clean_targets',
      label: 'Candidate window clean targets',
      count: Number(candidateWindowCleanTargets || 0),
      kind: 'sample',
      source: 'candidate_window',
      description: 'Preview-window clean target estimate after compliance, phone, and identity blockers.',
    },
    {
      key: 'ready_to_queue',
      label: 'Ready to queue',
      count: readyToQueue.count,
      kind: readyToQueue.source === 'full_source' ? 'pass' : 'sample',
      source: readyToQueue.source,
      description: 'Full source graph queue eligibility count; falls back to the candidate window only when full graph counts are unavailable.',
    },
    {
      key: 'queueable_today',
      label: 'Queueable today',
      count: Number(queueableToday || 0),
      kind: readyToQueue.source === 'full_source' ? 'pass' : 'sample',
      source: readyToQueue.source,
      description: 'Full source ready count capped by the campaign daily cap.',
    },
    {
      key: 'contact_window_policy',
      label: 'Current contact window blocks preview',
      count: effectiveOptions.within_contact_window_now ? 1 : 0,
      kind: 'policy',
      source: 'preview_options',
      description: effectiveOptions.within_contact_window_now
        ? 'Preview eligibility is respecting the local send window right now.'
        : 'Preview queue eligibility ignores the current clock; launch still enforces local send windows.',
    },
  ]
}

function compactSampleObject(entries = {}) {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined)
  )
}

function buildNestedSampleTarget(candidate = {}, targetRow = {}, routing = {}, rendered = {}, index = 0) {
  const raw = candidate.raw || {}
  const id = targetRow.campaign_key || `preview-${index + 1}`
  return {
    id,
    property: compactSampleObject({
      property_id: candidate.property_id || null,
      address: candidate.property_address || candidate.property_address_full || null,
      city: candidate.property_city || raw.property_address_city || null,
      state: candidate.state || candidate.property_state || null,
      zip: candidate.property_zip || raw.property_address_zip || null,
      market: candidate.market || null,
      property_type: candidate.property_type || raw.property_type || null,
      estimated_value: candidate.estimated_value ?? raw.estimated_value ?? null,
      equity_percent: candidate.equity_percent ?? raw.equity_percent ?? null,
      final_acquisition_score: candidate.final_acquisition_score ?? raw.final_acquisition_score ?? null,
    }),
    prospect: compactSampleObject({
      prospect_id: candidate.canonical_prospect_id || candidate.primary_prospect_id || null,
      display_name: candidate.prospect_display_name || candidate.prospect_full_name || candidate.seller_full_name || null,
      language_preference: candidate.best_language || candidate.language || raw.language_preference || null,
      matching_flags: candidate.matching_flags || raw.matching_flags || null,
      person_flags_text: candidate.person_flags_text || raw.person_flags_text || null,
      sms_eligible: candidate.sms_eligible ?? raw.sms_eligible ?? null,
      email_eligible: raw.email_eligible ?? null,
      timezone: candidate.timezone || null,
      contact_window: candidate.contact_window || null,
    }),
    master_owner: compactSampleObject({
      master_owner_id: candidate.master_owner_id || null,
      display_name: candidate.owner_display_name || candidate.master_owner_display_name || null,
      owner_type_guess: candidate.owner_type_guess || raw.owner_type_guess || null,
      priority_tier: candidate.priority_tier || raw.priority_tier || null,
      follow_up_cadence: candidate.follow_up_cadence || raw.follow_up_cadence || null,
      contactability_score: raw.contactability_score ?? null,
      priority_score: raw.priority_score ?? candidate.final_acquisition_score ?? null,
      property_count: raw.property_count ?? null,
    }),
    phone: compactSampleObject({
      phone_id: candidate.phone_id || candidate.best_phone_id || null,
      canonical_e164: candidate.canonical_e164 || null,
      phone_owner: candidate.phone_owner || raw.phone_owner || null,
      activity_status: candidate.activity_status || raw.activity_status || null,
      usage_12_months: raw.usage_12_months ?? null,
      usage_2_months: raw.usage_2_months ?? null,
    }),
    outreach: compactSampleObject({
      never_contacted: candidate.never_contacted ?? raw.never_contacted ?? null,
      last_sms_at: candidate.last_sms_at || raw.last_sms_at || null,
      last_outbound_at: candidate.last_outbound_at || raw.last_outbound_at || null,
      next_allowed_sms_at: raw.next_allowed_sms_at || candidate.next_eligible_at || null,
      last_touch_at: raw.last_touch_at || candidate.latest_contact_at || null,
      touch_count: raw.touch_count ?? candidate.last_touch_number ?? null,
      current_touch_number: candidate.touch_number || raw.current_touch_number || null,
      true_post_contact_suppression: candidate.true_post_contact_suppression ?? raw.true_post_contact_suppression ?? null,
      pending_prior_touch: candidate.pending_prior_touch ?? raw.pending_prior_touch ?? null,
      duplicate_queue_status: raw.duplicate_queue_status || null,
    }),
    sender_coverage: compactSampleObject({
      routing_allowed: Boolean(routing.ok || routing.routing_allowed),
      routing_tier: routing.routing_tier || null,
      selected_textgrid_market: routing.selected_textgrid_market || routing.selected?.market || null,
      selected_textgrid_state: routing.selected_textgrid_state || routing.seller_state || candidate.state || null,
      sender_coverage_status: routing.ok ? 'Covered' : 'No Route',
      template_id: rendered.selected_template_id || rendered.template?.template_id || rendered.template?.id || null,
    }),
  }
}

function buildPreviewWarnings(catalogFilters = {}) {
  const warnings = []
  for (const filter of catalogFilters.unsupported || []) {
    if (filter.warning) warnings.push(filter.warning)
    if (filter.message) warnings.push(`${filter.field_key || filter.fieldKey || filter.label}: ${filter.message}`)
    warnings.push(`unsupported_in_preview: ${filter.label} is approved but unsupported in preview.`)
  }
  for (const field of catalogFilters.unknown || []) {
    const key = field.field_key || field.fieldKey || field.domain
    warnings.push(`Unknown campaign filter ignored: ${key}`)
    warnings.push(`active_filter_not_in_preview_mapping:${key}`)
  }
  return warnings
}

function summarizeFilterValue(value) {
  const values = coerceScalarArray(value).map((item) => clean(item)).filter(Boolean)
  if (!values.length) return { count: 0, sample: [] }
  return {
    count: values.length,
    sample: values.slice(0, 5),
  }
}

function buildAppliedFilterSummary({ source, options, catalogFilters }) {
  const summary = [
    {
      phase: 'candidate_fetch',
      field: 'source',
      operator: 'from',
      value: source?.source || options.candidate_source,
    },
    {
      phase: 'candidate_fetch',
      field: 'range',
      operator: 'scan_limit',
      value: options.scan_limit,
    },
  ]
  if (options.market) {
    summary.push({
      phase: 'candidate_fetch',
      field: 'market',
      operator: 'normalized_eq',
      value: options.market,
    })
  }
  if (options.state) {
    summary.push({
      phase: 'candidate_fetch',
      field: 'state',
      operator: 'normalized_eq',
      value: options.state,
    })
  }
  for (const filter of catalogFilters.supported || []) {
    summary.push({
      phase: SENDER_COVERAGE_FIELDS.has(filter.field_key) ? 'sender_coverage_filter' : 'preview_filter',
      field_key: filter.field_key,
      preview_column: filter.preview_column || null,
      preview_columns: filter.preview_columns || [],
      operator: filter.operator,
      value: summarizeFilterValue(filter.value),
    })
  }
  return summary
}

function buildPreviewSourceColumnsUsed(catalogFilters = {}) {
  const used = {}
  for (const filter of catalogFilters.supported || []) {
    used[filter.field_key] = uniqueClean([
      filter.preview_column,
      ...(Array.isArray(filter.preview_columns) ? filter.preview_columns : []),
    ])
  }
  return used
}

function buildSkippedPreviewFilters(catalogFilters = {}) {
  return [
    ...(catalogFilters.unsupported || []),
    ...(catalogFilters.unknown || []).map((field) => ({
      domain: field.domain,
      field_key: field.field_key || field.fieldKey || null,
      unsupported_reason: 'unknown_campaign_field',
    })),
  ].map(publicFilter)
}

function emptyLayerCounts() {
  return {
    propertiesMatched: 0,
    prospectsMatched: 0,
    masterOwnersMatched: 0,
    phonesMatched: 0,
    outreachEligible: 0,
    senderCoverageEligible: 0,
  }
}

function groupPreviewFiltersByDomain(filters = []) {
  return getCampaignDomainKeys().reduce((groups, domain) => {
    groups[domain] = filters.filter((filter) => filter.domain === domain)
    return groups
  }, {})
}

function hasLayerValue(candidate = {}, keys = []) {
  const raw = candidate.raw || {}
  if (keys.some((key) => clean(candidate[key] ?? raw[key]) !== '')) return true
  const layers = candidate.catalog_layers || {}
  for (const layer of Object.values(layers)) {
    const rows = Array.isArray(layer) ? layer : [layer]
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      if (keys.some((key) => clean(row[key]) !== '')) return true
    }
  }
  return false
}

function hasPropertyLayer(candidate = {}) {
  return hasLayerValue(candidate, [
    'property_id',
    'property_export_id',
    'property_address',
    'property_address_full',
    'property_state',
    'property_zip',
  ])
}

function hasProspectLayer(candidate = {}) {
  return hasLayerValue(candidate, [
    'canonical_prospect_id',
    'primary_prospect_id',
    'prospect_id',
    'master_owner_id',
    'prospect_display_name',
    'prospect_full_name',
    'phone_full_name',
    'seller_full_name',
    'matching_flags',
  ])
}

function hasMasterOwnerLayer(candidate = {}) {
  return hasLayerValue(candidate, [
    'master_owner_id',
    'owner_display_name',
    'master_owner_display_name',
    'owner_type_guess',
    'priority_tier',
  ])
}

function hasPhoneLayer(candidate = {}) {
  return hasLayerValue(candidate, [
    'canonical_e164',
    'phone_id',
    'best_phone_id',
    'master_owner_id',
    'phone_owner',
    'activity_status',
  ])
}

function layerCountsMayBePartial(sourceColumns = {}, options = {}) {
  const available = sourceColumns.available || new Set()
  const sampledRowCount = Number(sourceColumns.sampledRowCount || 0)
  if (!sampledRowCount) return true
  if (sourceColumns.catalogLayersHydrated) return false
  const keyColumns = ['property_id', 'master_owner_id', 'canonical_e164']
  if (keyColumns.some((column) => !available.has(column))) return true
  const filters = options.filters || {}
  const legacyFilterKeys = Object.keys(filters).filter((key) => ![
    'candidate_source',
    'scan_limit',
    'target_limit',
    'limit',
    'limitPreview',
  ].includes(key))
  return legacyFilterKeys.length > 0 && !options.catalog_filters?.has_catalog_filters
}

async function fetchPreviewCandidateSource(options, deps = {}) {
  const attempts = []
  let lastSource = null
  const sourceCandidates = uniqueClean(options.candidate_source_candidates?.length
    ? options.candidate_source_candidates
    : [options.candidate_source || DEFAULT_CANDIDATE_SOURCE])

  for (const candidateSource of sourceCandidates) {
    const source = await getSupabaseFeederCandidates({
      limit: options.target_limit,
      scan_limit: options.scan_limit,
      candidate_source: candidateSource,
      market: options.market,
      state: options.state,
      template_use_case: options.template_use_case,
      touch_number: options.touch_number,
      campaign_session_id: options.campaign_session_id,
      timezone_filter: options.filters.timezone_filter,
    }, deps)
    attempts.push({
      source: candidateSource,
      ok: source?.ok !== false,
      scanned_count: Number(source?.scanned_count || 0),
      error: source?.ok === false ? source.error || source.candidate_source_error || null : null,
    })
    lastSource = source
    if (source?.ok !== false) return { source, attempts }
  }

  return {
    source: lastSource || {
      ok: false,
      error: 'CANDIDATE_SOURCE_UNAVAILABLE',
      source: options.candidate_source || DEFAULT_CANDIDATE_SOURCE,
      rows: [],
      scanned_count: 0,
    },
    attempts,
  }
}

function buildPreviewDiagnostics({
  options,
  source,
  sourceAttempts,
  catalogFilters,
  sourceColumns,
  warnings,
  queryMs,
}) {
  const skippedFilters = buildSkippedPreviewFilters(catalogFilters)
  const payloadFiltersByDomain = groupPreviewFiltersByDomain(catalogFilters.applied || [])
  return {
    requestId: options.request_id || null,
    receivedSource: options.received_source,
    normalizedSource: options.candidate_source,
    sourceUsed: source?.source || null,
    sourceFallbackUsed: source?.source && source?.source !== options.candidate_source ? source.source : null,
    sourceNormalizationReason: options.source_normalization_reason,
    sourceAttempts,
    normalizedFilters: (catalogFilters.applied || []).map(publicFilter),
    supportedFilters: (catalogFilters.supported || []).map(publicFilter),
    unsupportedFilters: skippedFilters,
    appliedFilters: (catalogFilters.supported || []).map(publicFilter),
    skippedFilters,
    frontendPayloadDomainCounts: options.frontend_payload_domain_counts || {},
    backendReceivedDomainCounts: catalogFilters.received_domain_counts || emptyDomainCounts(),
    backendAppliedDomainCounts: catalogFilters.applied_domain_counts || emptyDomainCounts(),
    droppedFilterCount: Number(catalogFilters.dropped_filter_count || 0),
    droppedFilters: (catalogFilters.dropped || []).map(publicFilter),
    appliedSqlFilters: buildAppliedFilterSummary({ source, options, catalogFilters }),
    sourceColumnsUsed: buildPreviewSourceColumnsUsed(catalogFilters),
    payloadFiltersByDomain,
    previewSourceColumns: sourceColumns.previewSourceColumns || [],
    previewSourceDerivedFields: sourceColumns.previewSourceDerivedFields || [],
    sourceRowsSampledForColumns: sourceColumns.sampledRowCount || 0,
    warnings,
    queryMs: Number(queryMs || 0),
  }
}

function previewResultHash(response = {}, diagnostics = {}) {
  const payload = {
    request_id: response.request_id || diagnostics.requestId || null,
    source: diagnostics.sourceUsed || response.candidate_source || response.source || null,
    total_matched: response.total_matched ?? response.total_matched_properties ?? response.reach?.totalMatched ?? null,
    clean_targets: response.clean_targets ?? response.reach?.cleanTargets ?? null,
    ready_to_queue: response.ready_to_queue ?? response.reach?.readyToQueue ?? null,
    queueable_today: response.queueable_today ?? response.reach?.queueableToday ?? null,
    applied_filters: diagnostics.appliedFilters || response.appliedFilters || response.applied_filters || [],
    unsupported_filters: diagnostics.unsupportedFilters || response.unsupported_in_preview || [],
    graph_columns_used: diagnostics.sourceColumnsUsed || {},
  }
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 16)
}

function withPreviewDiagnostics(response, diagnostics, includeDiagnostics) {
  const base = {
    ...response,
    request_id: diagnostics.requestId || response.request_id || null,
    result_hash: response.result_hash || previewResultHash(response, diagnostics),
  }
  if (!includeDiagnostics) return base
  return {
    ...base,
    diagnostics,
    receivedSource: diagnostics.receivedSource,
    normalizedFilters: diagnostics.normalizedFilters,
    supportedFilters: diagnostics.supportedFilters,
    unsupportedFilters: diagnostics.unsupportedFilters,
    unsupported_filters: diagnostics.unsupportedFilters,
    appliedSqlFilters: diagnostics.appliedSqlFilters,
    applied_sql_filters: diagnostics.appliedSqlFilters,
    sourceFallbackUsed: diagnostics.sourceFallbackUsed,
    sourceColumnsUsed: diagnostics.sourceColumnsUsed,
    source_columns_used: diagnostics.sourceColumnsUsed,
    graph_columns_used: diagnostics.sourceColumnsUsed,
    skippedFilters: diagnostics.skippedFilters,
    skipped_filters: diagnostics.skippedFilters,
    payloadFiltersByDomain: diagnostics.payloadFiltersByDomain,
    payload_filters_by_domain: diagnostics.payloadFiltersByDomain,
    frontend_payload_domain_counts: diagnostics.frontendPayloadDomainCounts,
    backend_received_domain_counts: diagnostics.backendReceivedDomainCounts,
    backend_applied_domain_counts: diagnostics.backendAppliedDomainCounts,
    dropped_filter_count: diagnostics.droppedFilterCount,
    dropped_filters: diagnostics.droppedFilters,
    previewSourceColumns: diagnostics.previewSourceColumns,
    sourceUsed: diagnostics.sourceUsed,
    graphRefreshStatus: diagnostics.graphRefreshStatus,
    graph_refresh_scope: diagnostics.graphRefreshStatus?.graph_refresh_scope || null,
    graph_row_count: diagnostics.graphRefreshStatus?.graph_row_count ?? null,
  }
}

const FULL_REACH_PAGE_SIZE = 1000
const FULL_REACH_ID_CHUNK_SIZE = 500
const FULL_REACH_ID_SCAN_CAP = 50000
const FULL_REACH_GRAPH_TABLE = 'deal_context_index'
const FULL_REACH_GRAPH_ID_COLUMN = 'deal_context_id'
const FULL_REACH_MASTER_OWNER_SELECT = [
  'master_owner_id',
  'master_key',
  'owner_type_guess',
  'priority_tier',
  'follow_up_cadence',
  'contactability_score',
  'financial_pressure_score',
  'urgency_score',
  'priority_score',
  'portfolio_total_value',
  'portfolio_total_equity',
  'portfolio_total_loan_balance',
  'portfolio_total_loan_payment',
  'portfolio_total_tax_amount',
  'portfolio_total_units',
  'property_count',
  'tax_delinquent_count',
  'oldest_tax_delinquent_year',
  'active_lien_count',
  'max_ownership_years',
  'joined_phone_ids_json',
].join(',')
const FULL_REACH_PROSPECT_SELECT = [
  'prospect_id',
  'canonical_prospect_id',
  'master_owner_id',
  'master_key',
  'linked_property_ids_json',
  'linked_property_ids_text',
  'primary_market',
  'language_preference',
  'gender',
  'marital_status',
  'education_model',
  'occupation_group',
  'est_household_income',
  'net_asset_value',
  'buying_power',
  'mob',
  'timezone',
  'contact_window',
  'matching_flags',
  'person_flags_text',
  'seller_tags_text',
  'sms_eligible',
  'email_eligible',
  'best_phone',
].join(',')
const FULL_REACH_PHONE_SELECT = [
  'phone_id',
  'canonical_e164',
  'master_owner_id',
  'master_key',
  'primary_prospect_id',
  'canonical_prospect_id',
  'primary_market',
  'phone_owner',
  'activity_status',
  'usage_12_months',
  'usage_2_months',
  'wrong_number_at',
].join(',')
const FULL_REACH_GRAPH_FILTER_COLUMNS = Object.freeze({
  'properties.property_id': 'property_id',
  'properties.property_address_city': 'property_address_city',
  'properties.property_state': 'property_state',
  'properties.property_address_state': 'property_state',
  'properties.property_zip': 'property_zip',
  'properties.property_address_zip': 'property_zip',
  'properties.property_county_name': 'property_county_name',
  'properties.property_address_county_name': 'property_county_name',
  'properties.market': 'market',
  'properties.property_type': 'property_type',
  'properties.property_class': 'property_class',
  'properties.units': 'units_count',
  'properties.units_count': 'units_count',
  'properties.tax_delinquent': 'tax_delinquent',
  'properties.active_lien': 'active_lien',
  'properties.property_flags_text': 'property_flags_text',
  'properties.building_condition': 'building_condition',
  'properties.rehab_level': 'rehab_level',
  'properties.owner_type': 'owner_type',
  'properties.owner_type_guess': 'owner_type_guess',
  'properties.is_corporate_owner': 'is_corporate_owner',
  'properties.out_of_state_owner': 'out_of_state_owner',
  'properties.estimated_value': 'estimated_value',
  'properties.equity_percent': 'equity_percent',
  'properties.cash_offer': 'cash_offer',
  'properties.final_acquisition_score': 'final_acquisition_score',
  'master_owners.priority_score': 'priority_score',
})

function errorMessage(error) {
  if (!error) return 'unknown_error'
  if (typeof error === 'string') return error
  if (error.message) return error.message
  try {
    const json = JSON.stringify(error)
    if (json && json !== '{}') return json
  } catch {
    // best effort below
  }
  return String(error)
}

function isSafeIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(clean(value))
}

function filterScalarValues(filter = {}) {
  return ['is_any_of', 'is_not_any_of', 'contains_any'].includes(filter.operator)
    ? normalizeFilterArrayInput(filter.value)
    : coerceScalarArray(filter.value)
}

function filterColumn(filter = {}) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  const column = field?.source_column || filter.source_column || filter.field || filter.field_key?.split('.').pop()
  return isSafeIdentifier(column) ? column : null
}

function applySupabaseFilterToColumn(query, filter = {}, columnOverride = null) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  const column = columnOverride || filterColumn(filter)
  if (!column || !field) return query
  const operator = normalizePreviewOperator(filter.operator || 'eq', field)
  const values = filterScalarValues({ ...filter, operator })
  const first = values[0]

  if (operator === 'is_empty') return query.is(column, null)
  if (operator === 'is_not_empty') return query.not(column, 'is', null)

  if (field.type === 'boolean' || operator === 'is_true' || operator === 'is_false') {
    if (operator === 'is_true') return query.eq(column, true)
    if (operator === 'is_false') return query.eq(column, false)
    if (first !== undefined) return query.eq(column, asBoolean(first, false))
    return query
  }

  if (field.type === 'number') {
    if (operator === 'gte') {
      const min = numberOrNull(first)
      return min === null ? query : query.gte(column, min)
    }
    if (operator === 'lte') {
      const max = numberOrNull(first)
      return max === null ? query : query.lte(column, max)
    }
    if (operator === 'between') {
      const min = numberOrNull(values[0])
      const max = numberOrNull(values[1])
      if (min !== null) query = query.gte(column, min)
      if (max !== null) query = query.lte(column, max)
      return query
    }
    if (operator === 'is_any_of' && values.length) {
      const numbers = values.map(numberOrNull).filter((value) => value !== null)
      return numbers.length ? query.in(column, numbers) : query
    }
    const exact = numberOrNull(first)
    return exact === null ? query : query.eq(column, exact)
  }

  if (['on_or_after', 'on_or_before', 'between'].includes(operator)) {
    if (operator === 'on_or_after') return clean(first) ? query.gte(column, clean(first)) : query
    if (operator === 'on_or_before') return clean(first) ? query.lte(column, clean(first)) : query
    if (clean(values[0])) query = query.gte(column, clean(values[0]))
    if (clean(values[1])) query = query.lte(column, clean(values[1]))
    return query
  }

  if (operator === 'contains' || operator === 'contains_any') {
    const terms = values.map(clean).filter(Boolean)
    if (!terms.length) return query
    if (terms.length === 1) return query.ilike(column, `%${terms[0]}%`)
    return query.or(terms.map((term) => `${column}.ilike.%${term.replace(/[,%]/g, '')}%`).join(','))
  }

  if (operator === 'is_not_any_of' && values.length) return query.not(column, 'in', `(${values.map(clean).join(',')})`)
  if (operator === 'is_any_of' && values.length) return query.in(column, values.map(clean).filter(Boolean))
  if (clean(first)) return query.eq(column, clean(first))
  return query
}

function applySupabaseFilter(query, filter = {}) {
  return applySupabaseFilterToColumn(query, filter)
}

function applySupabaseFilters(query, filters = []) {
  return filters.reduce((current, filter) => applySupabaseFilter(current, filter), query)
}

function chunk(values = [], size = FULL_REACH_ID_CHUNK_SIZE) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

async function fetchFilteredMasterOwnerIds({ supabase, table, idColumn = 'master_owner_id', filters = [] }) {
  const ids = new Set()
  const warnings = []
  for (let offset = 0; ; offset += FULL_REACH_PAGE_SIZE) {
    let query = supabase
      .from(table)
      .select(idColumn)
      .range(offset, offset + FULL_REACH_PAGE_SIZE - 1)
      .order(idColumn, { ascending: true, nullsFirst: false })
    query = applySupabaseFilters(query, filters)
    const { data, error } = await query
    if (error) {
      return {
        ok: false,
        ids,
        warnings: [`full_reach_filter_unavailable:${table}:${errorMessage(error)}`],
      }
    }
    const rows = Array.isArray(data) ? data : []
    for (const row of rows) {
      const id = clean(row?.[idColumn])
      if (id) ids.add(id)
    }
    if (rows.length < FULL_REACH_PAGE_SIZE) break
    if (ids.size > 250000) {
      warnings.push(`full_reach_id_scan_capped:${table}`)
      break
    }
  }
  return {
    ok: true,
    ids,
    warnings,
  }
}

function intersectIdSets(sets = []) {
  const realSets = sets.filter((set) => set instanceof Set)
  if (!realSets.length) return null
  const [smallest, ...rest] = realSets.sort((left, right) => left.size - right.size)
  const out = new Set()
  for (const value of smallest) {
    if (rest.every((set) => set.has(value))) out.add(value)
  }
  return out
}

async function countSourceRows({
  supabase,
  table,
  filters = [],
  select = '*',
  apply = null,
  warningKey = 'full_reach_count_unavailable',
}) {
  let query = supabase.from(table).select(select, { count: 'exact', head: true })
  query = applySupabaseFilters(query, filters)
  if (typeof apply === 'function') query = apply(query)
  const { count, error } = await query
  if (error) return { ok: false, count: 0, warnings: [`${warningKey}:${errorMessage(error)}`] }
  return { ok: true, count: Number(count || 0), warnings: [] }
}

async function fetchFilteredGraphRows({
  supabase,
  table,
  select,
  filters = [],
  orderColumn = null,
  warningKey = 'full_reach_graph_id_scan_unavailable',
  cap = FULL_REACH_ID_SCAN_CAP,
}) {
  const rows = []
  const warnings = []
  for (let offset = 0; ; offset += FULL_REACH_PAGE_SIZE) {
    let query = supabase
      .from(table)
      .select(select)
      .range(offset, offset + FULL_REACH_PAGE_SIZE - 1)
    if (orderColumn) query = query.order(orderColumn, { ascending: true, nullsFirst: false })
    query = applySupabaseFilters(query, filters)
    const { data, error } = await query
    if (error) {
      return {
        ok: false,
        rows,
        warnings: [`${warningKey}:${table}:${errorMessage(error)}`],
      }
    }
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < FULL_REACH_PAGE_SIZE) break
    if (rows.length >= cap) {
      warnings.push(`full_reach_id_scan_capped:${table}:${cap}`)
      break
    }
  }
  return { ok: true, rows, warnings }
}

function setFromRows(rows = [], column) {
  const ids = new Set()
  for (const row of rows) {
    const id = clean(row?.[column])
    if (id) ids.add(id)
  }
  return ids
}

function setIsEmpty(set) {
  return set instanceof Set && set.size === 0
}

function dciColumnForFilter(filter = {}) {
  const fieldKey = clean(filter.field_key)
  if (FULL_REACH_GRAPH_FILTER_COLUMNS[fieldKey]) return FULL_REACH_GRAPH_FILTER_COLUMNS[fieldKey]
  const field = filter.fieldDefinition || getCampaignFieldDefinition(fieldKey)
  if (!field) return null
  const column = field.source_column || field.key?.split('.').pop()
  if (!isSafeIdentifier(column)) return null
  if (field.domain === 'properties') {
    if (['property_state', 'property_address_state', 'state'].includes(column)) return 'property_state'
    if (['property_zip', 'property_address_zip', 'zip'].includes(column)) return 'property_zip'
    if (['property_address_city', 'city'].includes(column)) return 'property_address_city'
    if (['property_county_name', 'property_address_county_name'].includes(column)) return 'property_county_name'
    if (['market', 'canonical_market', 'seller_market', 'market_name'].includes(column)) return 'market'
    if ([
      'property_type',
      'property_class',
      'estimated_value',
      'equity_percent',
      'cash_offer',
      'final_acquisition_score',
    ].includes(column)) return column
  }
  if (field.domain === 'master_owners' && column === 'priority_score') return 'priority_score'
  return null
}

function applyGraphFilters(query, filters = [], warnings = [], sourceCoveredDomains = new Set()) {
  for (const filter of filters) {
    if (sourceCoveredDomains.has(filter.domain)) continue
    const column = dciColumnForFilter(filter)
    if (!column) {
      warnings.push(`full_source_filter_not_materialized:${filter.field_key}`)
      continue
    }
    query = applySupabaseFilterToColumn(query, filter, column)
  }
  return query
}

function setConstraint(column, values) {
  if (!(values instanceof Set)) return null
  return { column, values: [...values].map(clean).filter(Boolean) }
}

async function countGraphRows({
  supabase,
  filters = [],
  scope = {},
  apply = null,
  warningKey = 'full_reach_graph_count_unavailable',
}) {
  const warnings = []
  const constraints = [
    setConstraint('property_id', scope.propertyIds),
    setConstraint('master_owner_id', scope.ownerIds),
    setConstraint('prospect_id', scope.prospectIds),
    scope.prospectIds instanceof Set ? null : setConstraint('canonical_prospect_id', scope.canonicalProspectIds),
    setConstraint('phone_id', scope.phoneIds),
    setConstraint('canonical_e164', scope.phoneNumbers),
  ].filter(Boolean)

  if (constraints.some((constraint) => constraint.values.length === 0)) {
    return { ok: true, count: 0, warnings: [], source: FULL_REACH_GRAPH_TABLE }
  }

  const chunkedConstraint = constraints.find((constraint) => constraint.values.length > FULL_REACH_ID_CHUNK_SIZE)
  const buildQuery = (chunkValues = null) => {
    let query = supabase
      .from(FULL_REACH_GRAPH_TABLE)
      .select(FULL_REACH_GRAPH_ID_COLUMN, { count: 'exact', head: true })
    query = applyGraphFilters(query, filters, warnings, scope.sourceCoveredDomains || new Set())
    for (const constraint of constraints) {
      if (chunkedConstraint && constraint.column === chunkedConstraint.column) continue
      if (constraint.values.length > FULL_REACH_ID_CHUNK_SIZE) {
        warnings.push(`full_reach_graph_constraint_not_chunked:${constraint.column}`)
        continue
      }
      query = query.in(constraint.column, constraint.values)
    }
    if (chunkedConstraint) query = query.in(chunkedConstraint.column, chunkValues)
    if (typeof apply === 'function') query = apply(query)
    return query
  }

  if (!chunkedConstraint) {
    const { count, error } = await buildQuery()
    if (error) return { ok: false, count: 0, warnings: [`${warningKey}:${errorMessage(error)}`, ...warnings], source: FULL_REACH_GRAPH_TABLE }
    return { ok: true, count: Number(count || 0), warnings, source: FULL_REACH_GRAPH_TABLE }
  }

  let total = 0
  let ok = true
  for (const values of chunk(chunkedConstraint.values)) {
    const { count, error } = await buildQuery(values)
    if (error) {
      ok = false
      warnings.push(`${warningKey}:${errorMessage(error)}`)
      continue
    }
    total += Number(count || 0)
  }
  return { ok, count: total, warnings, source: FULL_REACH_GRAPH_TABLE }
}

async function countPropertiesForOwnerIds({ supabase, propertyFilters = [], ownerIds = null }) {
  if (ownerIds instanceof Set && ownerIds.size === 0) return { ok: true, count: 0, warnings: [] }
  if (!(ownerIds instanceof Set)) {
    let query = supabase.from('properties').select('*', { count: 'exact', head: true })
    query = applySupabaseFilters(query, propertyFilters)
    const { count, error } = await query
    if (error) {
      return { ok: false, count: 0, warnings: [`full_reach_property_count_unavailable:${errorMessage(error)}`] }
    }
    return { ok: true, count: Number(count || 0), warnings: [] }
  }

  let total = 0
  const warnings = []
  for (const ownerChunk of chunk([...ownerIds])) {
    let query = supabase
      .from('properties')
      .select('*', { count: 'exact', head: true })
      .in('master_owner_id', ownerChunk)
    query = applySupabaseFilters(query, propertyFilters)
    const { count, error } = await query
    if (error) {
      warnings.push(`full_reach_property_owner_count_unavailable:${errorMessage(error)}`)
      continue
    }
    total += Number(count || 0)
  }
  return { ok: warnings.length === 0, count: total, warnings }
}

async function countPropertiesWithSelect({ supabase, propertyFilters = [], ownerIds = null, select = '*', apply = null, warningKey = 'full_reach_count_unavailable' }) {
  const buildQuery = (ownerChunk = null) => {
    let query = supabase
      .from('properties')
      .select(select, { count: 'exact', head: true })
    if (ownerChunk) query = query.in('master_owner_id', ownerChunk)
    query = applySupabaseFilters(query, propertyFilters)
    if (typeof apply === 'function') query = apply(query)
    return query
  }

  if (ownerIds instanceof Set && ownerIds.size === 0) {
    return { ok: true, count: 0, warnings: [] }
  }

  if (!(ownerIds instanceof Set)) {
    const { count, error } = await buildQuery()
    if (error) {
      return { ok: false, count: null, warnings: [`${warningKey}:${errorMessage(error)}`] }
    }
    return { ok: true, count: Number(count || 0), warnings: [] }
  }

  let total = 0
  const warnings = []
  for (const ownerChunk of chunk([...ownerIds])) {
    const { count, error } = await buildQuery(ownerChunk)
    if (error) {
      warnings.push(`${warningKey}:${errorMessage(error)}`)
      continue
    }
    total += Number(count || 0)
  }
  return { ok: warnings.length === 0, count: total, warnings }
}

async function computeFullCatalogLayerCounts({ supabase, propertyFilters = [], ownerIds = null }) {
  const [masterOwners, prospects, phones, propertyBestPhone, propertySmsEligible] = await Promise.all([
    countPropertiesWithSelect({
      supabase,
      propertyFilters,
      ownerIds,
      select: 'property_id, master_owners!inner(master_owner_id)',
      warningKey: 'full_reach_linked_master_owners_unavailable',
    }),
    countPropertiesWithSelect({
      supabase,
      propertyFilters,
      ownerIds,
      select: 'property_id, master_owners!inner(master_owner_id, prospects!inner(master_owner_id))',
      warningKey: 'full_reach_linked_prospects_unavailable',
    }),
    countPropertiesWithSelect({
      supabase,
      propertyFilters,
      ownerIds,
      select: 'property_id, master_owners!inner(master_owner_id, phones!inner(master_owner_id,canonical_e164,wrong_number_at))',
      warningKey: 'full_reach_linked_phones_unavailable',
    }),
    countPropertiesWithSelect({
      supabase,
      propertyFilters,
      ownerIds,
      apply: (query) => query.not('best_phone_id', 'is', null),
      warningKey: 'full_reach_property_best_phone_unavailable',
    }),
    countPropertiesWithSelect({
      supabase,
      propertyFilters,
      ownerIds,
      apply: (query) => query.eq('sms_eligible', true),
      warningKey: 'full_reach_property_sms_eligible_unavailable',
    }),
  ])

  const results = [masterOwners, prospects, phones, propertyBestPhone, propertySmsEligible]
  return {
    ok: results.every((result) => result.ok),
    warnings: results.flatMap((result) => result.warnings || []),
    linked_master_owners_count: masterOwners.count,
    linked_prospects_count: prospects.count,
    linked_phones_count: phones.count,
    property_best_phone_count: propertyBestPhone.count,
    property_sms_eligible_count: propertySmsEligible.count,
  }
}

function setSize(set) {
  return set instanceof Set ? set.size : 0
}

function addClean(set, value) {
  const cleaned = clean(value)
  if (cleaned) set.add(cleaned)
}

function addArrayValues(set, values = []) {
  if (!Array.isArray(values)) return
  for (const value of values) addClean(set, value)
}

function unionSets(...sets) {
  const out = new Set()
  for (const set of sets) {
    if (!(set instanceof Set)) continue
    for (const value of set) addClean(out, value)
  }
  return out
}

function rowIdentifier(row = {}, columns = []) {
  for (const column of columns) {
    const value = clean(row?.[column])
    if (value) return value
  }
  return ''
}

function dedupeRows(rows = [], columns = []) {
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const id = rowIdentifier(row, columns)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(row)
  }
  return out
}

function rowIdentitySet(rows = [], columns = []) {
  const ids = new Set()
  for (const row of rows) addClean(ids, rowIdentifier(row, columns))
  return ids
}

function filterValuesForField(filters = [], fieldKey) {
  return uniqueClean(filters
    .filter((filter) => clean(filter.field_key) === fieldKey)
    .flatMap((filter) => filterScalarValues(filter)))
}

function sourceRowValueForFilter(row = {}, filter = {}) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  if (!field) return null
  if (field.key === 'prospects.age') return ageFromMob(row.mob)
  if (field.key === 'prospects.age_bucket') return ageBucketFromMob(row.mob)
  const sourceColumn = field.source_column || field.key.split('.').pop()
  const fallbackColumn = field.key.split('.').pop()
  return row[sourceColumn] ?? row[fallbackColumn] ?? row[field.key] ?? null
}

function rowMatchesSourceFilters(row = {}, filters = []) {
  for (const filter of filters) {
    if (!matchCatalogFilterValue(sourceRowValueForFilter(row, filter), filter)) return false
  }
  return true
}

async function fetchRowsByIn({
  supabase,
  table,
  select = '*',
  column,
  values = [],
  pageSize = FULL_REACH_PAGE_SIZE,
  chunkSize = FULL_REACH_ID_CHUNK_SIZE,
  cap = FULL_REACH_ID_SCAN_CAP,
  warningKey = 'full_reach_fetch_unavailable',
}) {
  const rows = []
  const warnings = []
  const cleanedValues = uniqueClean(values)
  if (!cleanedValues.length) return { ok: true, rows, warnings }

  for (const valueChunk of chunk(cleanedValues, chunkSize)) {
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .in(column, valueChunk)
        .range(offset, offset + pageSize - 1)
      if (error) {
        warnings.push(`${warningKey}:${table}.${column}:${errorMessage(error)}`)
        return { ok: false, rows, warnings }
      }
      const page = Array.isArray(data) ? data : []
      rows.push(...page)
      if (page.length < pageSize) break
      if (rows.length >= cap) {
        warnings.push(`full_reach_row_scan_capped:${table}.${column}:${cap}`)
        return { ok: true, rows: rows.slice(0, cap), warnings }
      }
    }
  }
  return { ok: true, rows, warnings }
}

async function countRowsByIn({
  supabase,
  table,
  column,
  values = [],
  select = '*',
  chunkSize = FULL_REACH_ID_CHUNK_SIZE,
  warningKey = 'full_reach_count_unavailable',
}) {
  let total = 0
  const warnings = []
  const cleanedValues = uniqueClean(values)
  if (!cleanedValues.length) return { ok: true, count: 0, warnings }

  for (const valueChunk of chunk(cleanedValues, chunkSize)) {
    const { count, error } = await supabase
      .from(table)
      .select(select, { count: 'exact', head: true })
      .in(column, valueChunk)
    if (error) {
      warnings.push(`${warningKey}:${table}.${column}:${errorMessage(error)}`)
      continue
    }
    total += Number(count || 0)
  }
  return { ok: warnings.length === 0, count: total, warnings }
}

function jsonContainsAnyOrClause(column, values = []) {
  return uniqueClean(values)
    .map((value) => `${column}.cs.${JSON.stringify([value])}`)
    .join(',')
}

async function fetchRowsByJsonContainsAny({
  supabase,
  table,
  select = '*',
  column,
  values = [],
  pageSize = FULL_REACH_PAGE_SIZE,
  chunkSize = 50,
  cap = FULL_REACH_ID_SCAN_CAP,
  warningKey = 'full_reach_json_fetch_unavailable',
}) {
  const rows = []
  const warnings = []
  const cleanedValues = uniqueClean(values)
  if (!cleanedValues.length) return { ok: true, rows, warnings }

  for (const valueChunk of chunk(cleanedValues, chunkSize)) {
    const orClause = jsonContainsAnyOrClause(column, valueChunk)
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .or(orClause)
        .range(offset, offset + pageSize - 1)
      if (error) {
        warnings.push(`${warningKey}:${table}.${column}:${errorMessage(error)}`)
        return { ok: false, rows, warnings }
      }
      const page = Array.isArray(data) ? data : []
      rows.push(...page)
      if (page.length < pageSize) break
      if (rows.length >= cap) {
        warnings.push(`full_reach_row_scan_capped:${table}.${column}:${cap}`)
        return { ok: true, rows: rows.slice(0, cap), warnings }
      }
    }
  }
  return { ok: true, rows, warnings }
}

async function fetchPropertyScopeRows({ supabase, propertyFilters = [], count = 0 }) {
  const rows = []
  const warnings = []
  if (Number(count || 0) > FULL_REACH_ID_SCAN_CAP) {
    warnings.push(`full_reach_property_scope_capped:matched_properties=${count}:cap=${FULL_REACH_ID_SCAN_CAP}`)
  }
  for (let offset = 0; rows.length < FULL_REACH_ID_SCAN_CAP; offset += FULL_REACH_PAGE_SIZE) {
    let query = supabase
      .from('properties')
      .select('property_id,property_export_id,master_owner_id,market,property_state,property_address_state')
      .range(offset, offset + FULL_REACH_PAGE_SIZE - 1)
    query = applySupabaseFilters(query, propertyFilters)
    const { data, error } = await query
    if (error) {
      return {
        ok: false,
        rows,
        warnings: [`full_reach_property_scope_unavailable:${errorMessage(error)}`, ...warnings],
      }
    }
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < FULL_REACH_PAGE_SIZE) break
  }
  return { ok: true, rows, warnings }
}

function buildPropertyScopeSets(propertyRows = []) {
  const propertyIds = new Set()
  const propertyExportIds = new Set()
  const ownerIds = new Set()
  const markets = new Set()
  let propertiesWithMasterOwnerId = 0
  for (const row of propertyRows) {
    addClean(propertyIds, row.property_id)
    addClean(propertyExportIds, row.property_export_id)
    if (clean(row.master_owner_id)) {
      propertiesWithMasterOwnerId += 1
      addClean(ownerIds, row.master_owner_id)
    }
    addClean(markets, row.market)
  }
  return { propertyIds, propertyExportIds, ownerIds, markets, propertiesWithMasterOwnerId }
}

function rowLinksToPropertyScope(row = {}, propertyScope = {}) {
  const values = [
    ...(Array.isArray(row.linked_property_ids_json) ? row.linked_property_ids_json : []),
    ...clean(row.linked_property_ids_text).split(/[;\n,|]+/),
  ].map(clean).filter(Boolean)
  if (!values.length) return false
  return values.some((value) => propertyScope.propertyIds.has(value) || propertyScope.propertyExportIds.has(value))
}

async function fetchLinkedProspectRows({ supabase, propertyScope, propertyFilters = [], prospectFilters = [], warnings = [] }) {
  const rows = []
  const marketValues = filterValuesForField(propertyFilters, 'properties.market')
  const propertyLinkValues = uniqueClean([...propertyScope.propertyIds, ...propertyScope.propertyExportIds])
  const ownerIds = [...propertyScope.ownerIds]

  if (marketValues.length) {
    const byMarket = await fetchRowsByIn({
      supabase,
      table: 'prospects',
      select: FULL_REACH_PROSPECT_SELECT,
      column: 'primary_market',
      values: marketValues,
      warningKey: 'full_reach_prospect_market_fetch_unavailable',
    })
    warnings.push(...(byMarket.warnings || []))
    rows.push(...(byMarket.rows || []).filter((row) => (
      rowLinksToPropertyScope(row, propertyScope) || propertyScope.ownerIds.has(clean(row.master_owner_id))
    )))
  }

  if (ownerIds.length) {
    const byOwner = await fetchRowsByIn({
      supabase,
      table: 'prospects',
      select: FULL_REACH_PROSPECT_SELECT,
      column: 'master_owner_id',
      values: ownerIds,
      warningKey: 'full_reach_prospect_owner_fetch_unavailable',
    })
    warnings.push(...(byOwner.warnings || []))
    rows.push(...(byOwner.rows || []))
  }

  if (!marketValues.length && propertyLinkValues.length) {
    const byPropertyJson = await fetchRowsByJsonContainsAny({
      supabase,
      table: 'prospects',
      select: FULL_REACH_PROSPECT_SELECT,
      column: 'linked_property_ids_json',
      values: propertyLinkValues,
      warningKey: 'full_reach_prospect_property_link_fetch_unavailable',
    })
    warnings.push(...(byPropertyJson.warnings || []))
    rows.push(...(byPropertyJson.rows || []))
  }

  return dedupeRows(rows, ['prospect_id', 'canonical_prospect_id'])
    .filter((row) => rowLinksToPropertyScope(row, propertyScope) || propertyScope.ownerIds.has(clean(row.master_owner_id)))
    .filter((row) => rowMatchesSourceFilters(row, prospectFilters))
}

async function fetchLinkedMasterOwnerRows({ supabase, ownerIds = [], masterOwnerFilters = [], warnings = [] }) {
  if (!ownerIds.length) return []
  const result = await fetchRowsByIn({
    supabase,
    table: 'master_owners',
    select: FULL_REACH_MASTER_OWNER_SELECT,
    column: 'master_owner_id',
    values: ownerIds,
    chunkSize: 100,
    warningKey: 'full_reach_master_owner_fetch_unavailable',
  })
  warnings.push(...(result.warnings || []))
  return dedupeRows(result.rows || [], ['master_owner_id'])
    .filter((row) => rowMatchesSourceFilters(row, masterOwnerFilters))
}

async function fetchLinkedPhoneRows({
  supabase,
  ownerIds = [],
  prospectRows = [],
  ownerRows = [],
  phoneFilters = [],
  prospectFilters = [],
  warnings = [],
}) {
  const rows = []
  const prospectIds = uniqueClean(prospectRows.map((row) => row.prospect_id))
  const canonicalProspectIds = uniqueClean(prospectRows.map((row) => row.canonical_prospect_id))
  const bestPhones = uniqueClean(prospectRows.map((row) => row.best_phone))
  const ownerPhoneIds = uniqueClean(ownerRows.flatMap((row) => Array.isArray(row.joined_phone_ids_json) ? row.joined_phone_ids_json : []))
  const ownerLookupAllowed = !prospectFilters.length

  if (ownerLookupAllowed && ownerIds.length) {
    const byOwner = await fetchRowsByIn({
      supabase,
      table: 'phones',
      select: FULL_REACH_PHONE_SELECT,
      column: 'master_owner_id',
      values: ownerIds,
      warningKey: 'full_reach_phone_owner_fetch_unavailable',
    })
    warnings.push(...(byOwner.warnings || []))
    rows.push(...(byOwner.rows || []))
  }

  const needsProspectPhoneLookup = !ownerLookupAllowed || !ownerIds.length

  if (needsProspectPhoneLookup && prospectIds.length) {
    const byPrimaryProspect = await fetchRowsByIn({
      supabase,
      table: 'phones',
      select: FULL_REACH_PHONE_SELECT,
      column: 'primary_prospect_id',
      values: prospectIds,
      chunkSize: 100,
      warningKey: 'full_reach_phone_primary_prospect_fetch_unavailable',
    })
    warnings.push(...(byPrimaryProspect.warnings || []))
    rows.push(...(byPrimaryProspect.rows || []))
  }

  if (needsProspectPhoneLookup && canonicalProspectIds.length) {
    const byCanonicalProspect = await fetchRowsByIn({
      supabase,
      table: 'phones',
      select: FULL_REACH_PHONE_SELECT,
      column: 'canonical_prospect_id',
      values: canonicalProspectIds,
      chunkSize: 100,
      warningKey: 'full_reach_phone_canonical_prospect_fetch_unavailable',
    })
    warnings.push(...(byCanonicalProspect.warnings || []))
    rows.push(...(byCanonicalProspect.rows || []))
  }

  if (needsProspectPhoneLookup && bestPhones.length) {
    const byBestPhone = await fetchRowsByIn({
      supabase,
      table: 'phones',
      select: FULL_REACH_PHONE_SELECT,
      column: 'canonical_e164',
      values: bestPhones,
      chunkSize: 100,
      warningKey: 'full_reach_phone_best_phone_fetch_unavailable',
    })
    warnings.push(...(byBestPhone.warnings || []))
    rows.push(...(byBestPhone.rows || []))
  }

  if (ownerPhoneIds.length) {
    const byPhoneId = await fetchRowsByIn({
      supabase,
      table: 'phones',
      select: FULL_REACH_PHONE_SELECT,
      column: 'phone_id',
      values: ownerPhoneIds,
      warningKey: 'full_reach_phone_id_fetch_unavailable',
    })
    warnings.push(...(byPhoneId.warnings || []))
    rows.push(...(byPhoneId.rows || []))
  }

  return dedupeRows(rows, ['phone_id', 'canonical_e164'])
    .filter((row) => clean(row.canonical_e164))
    .filter((row) => rowMatchesSourceFilters(row, phoneFilters))
}

async function fetchSuppressedPhoneNumbers({ supabase, phoneNumbers = [], warnings = [] }) {
  const suppressed = new Set()
  const wanted = new Set(uniqueClean(phoneNumbers))
  if (!wanted.size) return suppressed
  const select = 'phone_e164,phone_number,is_active'
  for (let offset = 0; ; offset += FULL_REACH_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sms_suppression_list')
      .select(select)
      .range(offset, offset + FULL_REACH_PAGE_SIZE - 1)
    if (error) {
      warnings.push(`full_reach_suppression_fetch_unavailable:${errorMessage(error)}`)
      return suppressed
    }
    const rows = Array.isArray(data) ? data : []
    for (const row of rows) {
      if (row.is_active === false) continue
      const phoneE164 = clean(row.phone_e164)
      const phoneNumber = clean(row.phone_number)
      if (wanted.has(phoneE164)) suppressed.add(phoneE164)
      if (wanted.has(phoneNumber)) suppressed.add(phoneNumber)
    }
    if (rows.length < FULL_REACH_PAGE_SIZE) break
  }
  return suppressed
}

function phoneIsWrongNumber(row = {}) {
  return Boolean(row.wrong_number) || clean(row.wrong_number_at) !== ''
}

function phoneMarket(row = {}, prospectByCanonical = new Map(), prospectById = new Map()) {
  return clean(row.primary_market)
    || clean(prospectByCanonical.get(clean(row.canonical_prospect_id))?.primary_market)
    || clean(prospectById.get(clean(row.primary_prospect_id))?.primary_market)
}

async function computeGraphSourceCoverage({
  supabase,
  matchedProperties,
  propertyFilters,
  propertyScope,
  prospectRows,
}) {
  const warnings = []
  const propertyIds = [...propertyScope.propertyIds]
  const ownerIds = [...propertyScope.ownerIds]
  const prospectIds = uniqueClean(prospectRows.map((row) => row.prospect_id))
  const propertyIdCoverageCapped = propertyIds.length > 5000
  if (propertyIdCoverageCapped) {
    warnings.push(`graph_coverage_dci_property_id_capped:property_ids=${propertyIds.length}:cap=5000`)
    warnings.push(`graph_coverage_owner_key_counts_capped:property_ids=${propertyIds.length}:cap=5000`)
    warnings.push('graph_coverage_dci_property_export_id_unavailable:deal_context_index.property_export_id_absent')
    return {
      warnings,
      coverage: {
        public_properties_count: matchedProperties.count,
        'public.properties count': matchedProperties.count,
        properties_with_master_owner_id: Number(propertyScope.propertiesWithMasterOwnerId || 0),
        matching_graph_rows_by_property_id: null,
        matching_graph_rows_by_property_export_id: 0,
        matching_graph_rows_by_master_owner_id: null,
        matching_prospects_by_master_owner_id: null,
        matching_phones_by_master_owner_id: null,
        matching_phones_by_prospect_id: null,
      },
    }
  }
  warnings.push('graph_coverage_dci_property_export_id_unavailable:deal_context_index.property_export_id_absent')

  const [
    propertiesWithMasterOwnerId,
    matchingGraphRowsByPropertyId,
    matchingGraphRowsByMasterOwnerId,
    matchingProspectsByMasterOwnerId,
    matchingPhonesByMasterOwnerId,
    matchingPhonesByProspectId,
  ] = await Promise.all([
    countSourceRows({
      supabase,
      table: 'properties',
      filters: propertyFilters,
      select: 'property_id',
      apply: (query) => query.not('master_owner_id', 'is', null),
      warningKey: 'graph_coverage_properties_with_owner_unavailable',
    }),
    countRowsByIn({
      supabase,
      table: FULL_REACH_GRAPH_TABLE,
      column: 'property_id',
      values: propertyIdCoverageCapped ? [] : propertyIds,
      select: FULL_REACH_GRAPH_ID_COLUMN,
      warningKey: 'graph_coverage_dci_property_id_unavailable',
    }),
    countRowsByIn({
      supabase,
      table: FULL_REACH_GRAPH_TABLE,
      column: 'master_owner_id',
      values: ownerIds,
      select: FULL_REACH_GRAPH_ID_COLUMN,
      warningKey: 'graph_coverage_dci_master_owner_id_unavailable',
    }),
    countRowsByIn({
      supabase,
      table: 'prospects',
      column: 'master_owner_id',
      values: ownerIds,
      select: 'prospect_id',
      warningKey: 'graph_coverage_prospects_owner_unavailable',
    }),
    countRowsByIn({
      supabase,
      table: 'phones',
      column: 'master_owner_id',
      values: ownerIds,
      select: 'phone_id',
      warningKey: 'graph_coverage_phones_owner_unavailable',
    }),
    countRowsByIn({
      supabase,
      table: 'phones',
      column: 'primary_prospect_id',
      values: prospectIds,
      select: 'phone_id',
      warningKey: 'graph_coverage_phones_prospect_unavailable',
    }),
  ])

  for (const result of [
    propertiesWithMasterOwnerId,
    matchingGraphRowsByPropertyId,
    matchingGraphRowsByMasterOwnerId,
    matchingProspectsByMasterOwnerId,
    matchingPhonesByMasterOwnerId,
    matchingPhonesByProspectId,
  ]) {
    warnings.push(...(result.warnings || []))
  }

  return {
    warnings,
    coverage: {
      public_properties_count: matchedProperties.count,
      'public.properties count': matchedProperties.count,
      properties_with_master_owner_id: propertiesWithMasterOwnerId.count,
      matching_graph_rows_by_property_id: propertyIdCoverageCapped ? null : matchingGraphRowsByPropertyId.count,
      matching_graph_rows_by_property_export_id: 0,
      matching_graph_rows_by_master_owner_id: matchingGraphRowsByMasterOwnerId.count,
      matching_prospects_by_master_owner_id: matchingProspectsByMasterOwnerId.count,
      matching_phones_by_master_owner_id: matchingPhonesByMasterOwnerId.count,
      matching_phones_by_prospect_id: matchingPhonesByProspectId.count,
    },
  }
}

async function buildFullReachGraphScope({ supabase, grouped = {}, propertyCount = null }) {
  const warnings = []
  const sourceCoveredDomains = new Set()
  let propertyRows = null
  let propertyIds = null
  let propertyOwnerIds = null
  let masterOwnerIds = null
  let prospectOwnerIds = null
  let prospectIds = null
  let canonicalProspectIds = null
  let phoneOwnerIds = null
  let phoneIds = null
  let phoneNumbers = null
  const propertyFilters = grouped.properties || []
  const masterOwnerFilters = grouped.master_owners || []
  const prospectFilters = grouped.prospects || []
  const phoneFilters = grouped.phones || []

  const propertyScopeRequired = propertyFilters.some((filter) => !dciColumnForFilter(filter))
  const shouldFetchPropertyScope = propertyScopeRequired && propertyFilters.length > 0 && Number(propertyCount) <= FULL_REACH_ID_SCAN_CAP
  if (shouldFetchPropertyScope) {
    const result = await fetchFilteredGraphRows({
      supabase,
      table: 'properties',
      select: 'property_id,master_owner_id',
      filters: propertyFilters,
      orderColumn: 'property_id',
      warningKey: 'full_reach_property_scope_unavailable',
    })
    warnings.push(...(result.warnings || []))
    if (result.ok) {
      propertyRows = result.rows || []
      propertyIds = setFromRows(propertyRows, 'property_id')
      propertyOwnerIds = setFromRows(propertyRows, 'master_owner_id')
      sourceCoveredDomains.add('properties')
    }
  } else if (propertyScopeRequired && propertyFilters.length > 0) {
    warnings.push(`full_reach_property_scope_not_fetched:matched_properties=${propertyCount}`)
  }

  if (masterOwnerFilters.length) {
    const result = await fetchFilteredGraphRows({
      supabase,
      table: 'master_owners',
      select: 'master_owner_id',
      filters: masterOwnerFilters,
      orderColumn: 'master_owner_id',
      warningKey: 'full_reach_master_owner_filter_unavailable',
    })
    warnings.push(...(result.warnings || []))
    if (result.ok) {
      masterOwnerIds = setFromRows(result.rows || [], 'master_owner_id')
      sourceCoveredDomains.add('master_owners')
    }
  }

  if (prospectFilters.length) {
    const result = await fetchFilteredGraphRows({
      supabase,
      table: 'prospects',
      select: 'master_owner_id,prospect_id,canonical_prospect_id,best_phone',
      filters: prospectFilters,
      orderColumn: 'master_owner_id',
      warningKey: 'full_reach_prospect_filter_unavailable',
    })
    warnings.push(...(result.warnings || []))
    if (result.ok) {
      const rows = result.rows || []
      prospectOwnerIds = setFromRows(rows, 'master_owner_id')
      prospectIds = setFromRows(rows, 'prospect_id')
      canonicalProspectIds = setFromRows(rows, 'canonical_prospect_id')
      sourceCoveredDomains.add('prospects')
    }
  }

  if (phoneFilters.length) {
    const result = await fetchFilteredGraphRows({
      supabase,
      table: 'phones',
      select: 'master_owner_id,phone_id,canonical_e164,primary_prospect_id,canonical_prospect_id',
      filters: phoneFilters,
      orderColumn: 'master_owner_id',
      warningKey: 'full_reach_phone_filter_unavailable',
    })
    warnings.push(...(result.warnings || []))
    if (result.ok) {
      let rows = result.rows || []
      if ((prospectIds instanceof Set && prospectIds.size > 0) || (canonicalProspectIds instanceof Set && canonicalProspectIds.size > 0)) {
        rows = rows.filter((row) => (
          prospectIds?.has(clean(row.primary_prospect_id)) ||
          prospectIds?.has(clean(row.canonical_prospect_id)) ||
          canonicalProspectIds?.has(clean(row.canonical_prospect_id))
        ))
      }
      phoneOwnerIds = setFromRows(rows, 'master_owner_id')
      phoneIds = setFromRows(rows, 'phone_id')
      phoneNumbers = setFromRows(rows, 'canonical_e164')
      sourceCoveredDomains.add('phones')
    }
  }

  const ownerIds = intersectIdSets([
    masterOwnerIds,
    prospectOwnerIds,
    phoneOwnerIds,
  ].filter((set) => set instanceof Set))

  return {
    warnings,
    propertyRows,
    propertyIds,
    ownerIds,
    prospectIds,
    canonicalProspectIds,
    phoneIds,
    phoneNumbers,
    sourceCoveredDomains,
    ownerFilterCount: ownerIds instanceof Set ? ownerIds.size : null,
  }
}

async function fetchActiveTextgridMarkets({ supabase }) {
  const { data, error } = await supabase
    .from('textgrid_numbers')
    .select('market,status')
    .limit(200)
  if (error) {
    return { ok: false, markets: [], warnings: [`full_reach_sender_coverage_unavailable:${errorMessage(error)}`] }
  }
  const markets = uniqueClean((Array.isArray(data) ? data : [])
    .filter((row) => !clean(row.status) || lower(row.status) === 'active')
    .map((row) => row.market))
  return { ok: true, markets, warnings: [] }
}

async function computeFullCatalogReachCount(catalogFilters = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!supabase) {
    return { ok: false, count: 0, warnings: ['full_reach_supabase_unavailable'] }
  }
  const graphStartedAt = Date.now()
  const graphTimings = []
  const markGraphTiming = (phase) => {
    const at = Date.now()
    graphTimings.push({ phase, ms: at - graphStartedAt })
    if (process.env.CAMPAIGN_PREVIEW_GRAPH_DEBUG === '1') {
      console.warn('campaign_preview.full_graph_timing', { phase, ms: at - graphStartedAt })
    }
  }

  const filtersToGroup = catalogFilters.pre_filters || catalogFilters.supported || []
  const grouped = groupPreviewFiltersByDomain(filtersToGroup)
  const propertyFilters = grouped.properties || []
  const prospectFilters = grouped.prospects || []
  const masterOwnerFilters = grouped.master_owners || []
  const phoneFilters = grouped.phones || []
  const warnings = []

  const matchedProperties = await countSourceRows({
    supabase,
    table: 'properties',
    filters: propertyFilters,
    select: 'property_id',
    warningKey: 'full_reach_property_count_unavailable',
  })
  markGraphTiming('matched_properties_count')

  const propertyScopeResult = await fetchPropertyScopeRows({
    supabase,
    propertyFilters,
    count: matchedProperties.count,
  })
  markGraphTiming('property_scope_rows')
  warnings.push(...(matchedProperties.warnings || []), ...(propertyScopeResult.warnings || []))

  if (!matchedProperties.ok || !propertyScopeResult.ok) {
    return {
      ok: false,
      count: matchedProperties.count,
      warnings: uniqueClean(warnings),
      countSource: 'public.properties',
      graphSource: 'direct_table_graph',
      joinStrategy: 'direct_table_property_scope_unavailable',
      ownerFilterCount: null,
      linked_master_owners_count: 0,
      linked_prospects_count: 0,
      linked_phones_count: 0,
      sms_eligible_phones_count: 0,
      clean_targets_count: 0,
      sender_covered_count: 0,
      ready_to_queue_count: 0,
      property_best_phone_count: null,
      property_sms_eligible_count: null,
      graph_join_key_report: {},
      graph_source_coverage: {
        public_properties_count: matchedProperties.count,
        'public.properties count': matchedProperties.count,
      },
    }
  }

  const propertyRows = propertyScopeResult.rows || []
  const propertyScope = buildPropertyScopeSets(propertyRows)
  const prospectRowsUnfiltered = await fetchLinkedProspectRows({
    supabase,
    propertyScope,
    propertyFilters,
    prospectFilters: [],
    warnings,
  })
  markGraphTiming('linked_prospects_fetch')
  const candidateOwnerIds = unionSets(
    propertyScope.ownerIds,
    setFromRows(prospectRowsUnfiltered, 'master_owner_id'),
  )
  const ownerFilterActive = masterOwnerFilters.length > 0
  const ownerRows = ownerFilterActive
    ? await fetchLinkedMasterOwnerRows({
        supabase,
        ownerIds: [...candidateOwnerIds],
        masterOwnerFilters,
        warnings,
      })
    : []
  markGraphTiming('linked_master_owners_fetch')
  const filteredOwnerIds = setFromRows(ownerRows, 'master_owner_id')
  const ownerScopeIds = ownerFilterActive ? filteredOwnerIds : candidateOwnerIds
  const prospectRows = prospectRowsUnfiltered
    .filter((row) => !ownerFilterActive || ownerScopeIds.has(clean(row.master_owner_id)))
    .filter((row) => rowMatchesSourceFilters(row, prospectFilters))
  const prospectOwnerIds = setFromRows(prospectRows, 'master_owner_id')
  const graphOwnerIds = unionSets(
    ownerScopeIds,
    ownerFilterActive ? new Set() : prospectOwnerIds,
  )
  const ownerRowsForPhones = ownerRows
  markGraphTiming('phone_owner_scope')
  const phoneRows = await fetchLinkedPhoneRows({
    supabase,
    ownerIds: [...graphOwnerIds],
    prospectRows,
    ownerRows: ownerRowsForPhones,
    phoneFilters,
    prospectFilters,
    warnings,
  })
  markGraphTiming('linked_phones_fetch')
  const phoneNumbers = uniqueClean(phoneRows.map((row) => row.canonical_e164))
  const smsEligiblePhoneRows = phoneRows.filter((row) => !phoneIsWrongNumber(row))
  const smsEligiblePhoneNumbers = uniqueClean(smsEligiblePhoneRows.map((row) => row.canonical_e164))
  const suppressedPhoneNumbers = await fetchSuppressedPhoneNumbers({
    supabase,
    phoneNumbers: smsEligiblePhoneNumbers,
    warnings,
  })
  markGraphTiming('suppression_fetch')
  const activeMarkets = await fetchActiveTextgridMarkets({ supabase })
  markGraphTiming('sender_market_fetch')
  warnings.push(...(activeMarkets.warnings || []))
  const activeMarketSet = new Set(activeMarkets.markets || [])
  const prospectByCanonical = new Map(prospectRows.map((row) => [clean(row.canonical_prospect_id), row]).filter(([key]) => key))
  const prospectById = new Map(prospectRows.map((row) => [clean(row.prospect_id), row]).filter(([key]) => key))
  const cleanPhoneRows = smsEligiblePhoneRows.filter((row) => !suppressedPhoneNumbers.has(clean(row.canonical_e164)))
  const senderCoveredRows = activeMarketSet.size
    ? cleanPhoneRows.filter((row) => activeMarketSet.has(phoneMarket(row, prospectByCanonical, prospectById)))
    : []
  const coverage = await computeGraphSourceCoverage({
    supabase,
    matchedProperties,
    propertyFilters,
    propertyScope,
    prospectRows,
  })
  markGraphTiming('graph_source_coverage')
  warnings.push(...(coverage.warnings || []))

  const linkedMasterOwnerIds = ownerFilterActive
    ? unionSets(ownerScopeIds, prospectOwnerIds)
    : unionSets(propertyScope.ownerIds, prospectOwnerIds)
  const linkedProspectIds = rowIdentitySet(prospectRows, ['prospect_id', 'canonical_prospect_id'])
  const linkedPhoneIds = rowIdentitySet(phoneRows, ['phone_id', 'canonical_e164'])
  const smsEligiblePhoneIds = rowIdentitySet(smsEligiblePhoneRows, ['phone_id', 'canonical_e164'])
  const cleanPhoneIds = rowIdentitySet(cleanPhoneRows, ['phone_id', 'canonical_e164'])
  const senderCoveredIds = rowIdentitySet(senderCoveredRows, ['phone_id', 'canonical_e164'])
  const graphJoinKeyReport = {
    graph_source: 'direct_table_graph',
    property_scope_rows_scanned: propertyRows.length,
    property_id_values: setSize(propertyScope.propertyIds),
    property_export_id_values: setSize(propertyScope.propertyExportIds),
    property_master_owner_id_values: setSize(propertyScope.ownerIds),
    prospect_link_strategy: 'prospects.linked_property_ids_json OR prospects.master_owner_id',
    prospect_id_values: uniqueClean(prospectRows.map((row) => row.prospect_id)).length,
    canonical_prospect_id_values: uniqueClean(prospectRows.map((row) => row.canonical_prospect_id)).length,
    prospect_master_owner_id_values: setSize(prospectOwnerIds),
    phone_link_strategy: prospectFilters.length
      ? 'phones.primary_prospect_id OR phones.canonical_prospect_id OR prospects.best_phone'
      : 'phones.master_owner_id OR phones.primary_prospect_id OR phones.canonical_prospect_id OR master_owners.joined_phone_ids_json',
    phone_id_values: uniqueClean(phoneRows.map((row) => row.phone_id)).length,
    canonical_e164_values: phoneNumbers.length,
    owner_filter_count: ownerFilterActive ? setSize(filteredOwnerIds) : null,
    property_id_vs_property_export_id: 'properties.property_id is matched against prospect linked_property_ids_json; property_export_id is retained for owner/import diagnostics.',
    master_owner_id_vs_master_key: 'master_owner_id is preferred; master_key is diagnostic only when ids are stale or unpopulated.',
    prospect_id_vs_canonical_prospect_id: 'phones are expanded with primary_prospect_id and canonical_prospect_id.',
    phone_id_vs_best_phone_id: 'phone_id is preferred; prospects.best_phone/canonical_e164 bridges older best-phone references.',
    timings_ms: graphTimings,
  }

  return {
    ok: true,
    count: matchedProperties.count,
    warnings: uniqueClean(warnings),
    countSource: 'public.properties',
    graphSource: 'direct_table_graph',
    joinStrategy: 'direct_property_owner_prospect_phone_expansion',
    ownerFilterCount: ownerFilterActive ? setSize(filteredOwnerIds) : null,
    linked_master_owners_count: setSize(linkedMasterOwnerIds),
    linked_prospects_count: setSize(linkedProspectIds),
    linked_phones_count: setSize(linkedPhoneIds),
    sms_eligible_phones_count: setSize(smsEligiblePhoneIds),
    clean_targets_count: setSize(cleanPhoneIds),
    sender_covered_count: setSize(senderCoveredIds),
    ready_to_queue_count: setSize(senderCoveredIds),
    property_best_phone_count: null,
    property_sms_eligible_count: null,
    graph_join_key_report: graphJoinKeyReport,
    graph_source_coverage: coverage.coverage,
  }
}

async function hydratePreviewSourceForCatalogFilters(source = {}, catalogFilters = {}, deps = {}) {
  if (source?.ok === false || !catalogFilters?.applied?.length || !Array.isArray(source.rows) || !source.rows.length) {
    return { source, warnings: [] }
  }

  const hydrateDomains = uniqueClean((catalogFilters.supported || catalogFilters.applied || [])
    .map((filter) => filter.domain)
    .filter((domain) => ['properties', 'prospects', 'master_owners', 'phones'].includes(domain)))
  const hydration = await hydrateCampaignCandidateRowsWithCatalogLayers(source.rows, {
    supabase: deps.supabase || defaultSupabase,
    domains: hydrateDomains,
  })

  return {
    source: {
      ...source,
      rows: hydration.rows,
      catalog_hydration_counts: hydration.counts || {},
    },
    warnings: hydration.warnings || [],
  }
}

const CAMPAIGN_TARGET_GRAPH_TABLE = 'campaign_target_graph'
const CAMPAIGN_TARGET_GRAPH_FACET_TABLE = 'campaign_target_graph_facets'
const CAMPAIGN_TARGET_GRAPH_REFRESH_RUN_TABLE = 'campaign_target_graph_refresh_runs'
const CAMPAIGN_TARGET_GRAPH_SELECT = [
  'graph_id',
  'property_id',
  'property_export_id',
  'master_owner_id',
  'prospect_id',
  'canonical_prospect_id',
  'phone_id',
  'canonical_e164',
  'market',
  'state',
  'property_city',
  'property_zip',
  'property_county_name',
  'property_type',
  'property_class',
  'units_count',
  'tax_delinquent',
  'active_lien',
  'property_flags_text',
  'building_condition',
  'owner_type',
  'is_corporate_owner',
  'out_of_state_owner',
  'canonical_property_group',
  'language',
  'gender',
  'marital_status',
  'age_bucket',
  'occupation_group',
  'education_model',
  'income',
  'net_asset_value',
  'buying_power',
  'email_eligible',
  'owner_type_guess',
  'priority_tier',
  'follow_up_cadence',
  'rehab_level',
  'sms_eligible',
  'true_post_contact_suppression',
  'wrong_number',
  'pending_prior_touch',
  'active_queue_item',
  'sender_covered',
  'sender_market',
  'timezone',
  'best_phone_score',
  'phone_owner',
  'phone_activity_status',
  'usage_12_months',
  'usage_2_months',
  'template_use_case',
  'contact_window',
  'latest_contact_at',
  'last_outbound_at',
  'last_inbound_at',
  'routing_tier',
  'identity_alignment',
  'acquisition_score',
  'podio_tags',
  'matching_flags',
  'matching_flags_text',
  'owner_name',
  'seller_first_name',
  'seller_full_name',
  'property_address_full',
  'estimated_value',
  'equity_amount',
  'equity_percent',
  'cash_offer',
  'touch_count',
  'current_touch_number',
  'never_contacted',
  'queue_eligible',
  'queue_block_reason',
  'graph_source',
  'linkage_counts',
  'blocker_flags',
  'source_updated_at',
  'generated_at',
].join(',')
const CAMPAIGN_TARGET_GRAPH_OPTIONAL_FILTER_COLUMNS = new Set([
  'units_count',
  'tax_delinquent',
  'active_lien',
  'property_flags_text',
  'building_condition',
  'owner_type',
  'is_corporate_owner',
  'out_of_state_owner',
  'gender',
  'marital_status',
  'net_asset_value',
  'buying_power',
  'email_eligible',
])
const CAMPAIGN_TARGET_GRAPH_COMPAT_SELECT = CAMPAIGN_TARGET_GRAPH_SELECT
  .split(',')
  .filter((column) => !CAMPAIGN_TARGET_GRAPH_OPTIONAL_FILTER_COLUMNS.has(column))
  .join(',')
const CAMPAIGN_TARGET_GRAPH_PAGE_SIZE = 1000
const CAMPAIGN_TARGET_GRAPH_PREVIEW_LIMIT = 5000
const CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT = 100000
const CAMPAIGN_TARGET_GRAPH_FILTER_COLUMNS = Object.freeze({
  'properties.property_id': 'property_id',
  'properties.market': 'market',
  'properties.property_state': 'state',
  'properties.property_address_state': 'state',
  'properties.property_zip': 'property_zip',
  'properties.property_address_zip': 'property_zip',
  'properties.property_address_city': 'property_city',
  'properties.property_county_name': 'property_county_name',
  'properties.property_address_county_name': 'property_county_name',
  'properties.property_type': 'property_type',
  'properties.property_class': 'property_class',
  'properties.units': 'units_count',
  'properties.units_count': 'units_count',
  'properties.tax_delinquent': 'tax_delinquent',
  'properties.active_lien': 'active_lien',
  'properties.property_flags_text': 'property_flags_text',
  'properties.building_condition': 'building_condition',
  'properties.rehab_level': 'rehab_level',
  'properties.owner_type': 'owner_type',
  'properties.owner_type_guess': 'owner_type_guess',
  'properties.is_corporate_owner': 'is_corporate_owner',
  'properties.out_of_state_owner': 'out_of_state_owner',
  'properties.estimated_value': 'estimated_value',
  'properties.equity_amount': 'equity_amount',
  'properties.equity_percent': 'equity_percent',
  'properties.cash_offer': 'cash_offer',
  'properties.final_acquisition_score': 'acquisition_score',
  'properties.structured_motivation_score': 'acquisition_score',
  'properties.deal_strength_score': 'acquisition_score',
  'properties.tag_distress_score': 'acquisition_score',
  'properties.seller_tags_text': 'podio_tags',
  'properties.podio_tags': 'podio_tags',
  'prospects.language_preference': 'language',
  'prospects.age_bucket': 'age_bucket',
  'prospects.education_model': 'education_model',
  'prospects.occupation_group': 'occupation_group',
  'prospects.est_household_income': 'income',
  'prospects.gender': 'gender',
  'prospects.marital_status': 'marital_status',
  'prospects.net_asset_value': 'net_asset_value',
  'prospects.buying_power': 'buying_power',
  'prospects.timezone': 'timezone',
  'prospects.contact_window': 'contact_window',
  'prospects.sms_eligible': 'sms_eligible',
  'prospects.email_eligible': 'email_eligible',
  'prospects.matching_flags': 'matching_flags_text',
  'prospects.person_flags_text': 'matching_flags_text',
  'prospects.seller_tags_text': 'podio_tags',
  'master_owners.owner_type_guess': 'owner_type_guess',
  'master_owners.priority_tier': 'priority_tier',
  'master_owners.follow_up_cadence': 'follow_up_cadence',
  'master_owners.priority_score': 'acquisition_score',
  'phones.phone_owner': 'phone_owner',
  'phones.activity_status': 'phone_activity_status',
  'phones.usage_12_months': 'usage_12_months',
  'phones.usage_2_months': 'usage_2_months',
  'outreach.never_contacted': 'never_contacted',
  'outreach.last_outbound_at': 'last_outbound_at',
  'outreach.last_sms_at': 'last_outbound_at',
  'outreach.last_touch_at': 'latest_contact_at',
  'outreach.touch_count': 'touch_count',
  'outreach.current_touch_number': 'current_touch_number',
  'outreach.true_post_contact_suppression': 'true_post_contact_suppression',
  'outreach.pending_prior_touch': 'pending_prior_touch',
  'sender_coverage.routing_allowed': 'sender_covered',
  'sender_coverage.routing_tier': 'routing_tier',
  'sender_coverage.selected_textgrid_market': 'sender_market',
  'sender_coverage.selected_textgrid_state': 'state',
})

async function readCampaignGraphRefreshStatus(supabase) {
  if (!supabase) {
    return {
      graph_refresh_scope: 'unknown',
      graph_row_count: null,
      facet_count: null,
      latest_generated_at: null,
      latest_facet_updated_at: null,
      refresh_run_id: null,
      refresh_status: null,
      refresh_finished_at: null,
      warnings: ['campaign_target_graph_supabase_unavailable'],
    }
  }

  const warnings = []
  const [graphResult, facetResult, runResult] = await Promise.all([
    supabase
      .from(CAMPAIGN_TARGET_GRAPH_TABLE)
      .select('generated_at', { count: 'exact' })
      .order('generated_at', { ascending: false, nullsFirst: false })
      .limit(1),
    supabase
      .from(CAMPAIGN_TARGET_GRAPH_FACET_TABLE)
      .select('updated_at', { count: 'exact' })
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1),
    supabase
      .from(CAMPAIGN_TARGET_GRAPH_REFRESH_RUN_TABLE)
      .select('id,status,graph_rows,facet_rows,started_at,finished_at,metadata')
      .order('started_at', { ascending: false })
      .limit(1),
  ])

  if (graphResult.error) warnings.push(`campaign_target_graph_status_unavailable:${errorMessage(graphResult.error)}`)
  if (facetResult.error) warnings.push(`campaign_target_graph_facet_status_unavailable:${errorMessage(facetResult.error)}`)
  if (runResult.error) warnings.push(`campaign_target_graph_refresh_run_unavailable:${errorMessage(runResult.error)}`)

  const run = Array.isArray(runResult.data) ? runResult.data[0] : null
  const metadata = run?.metadata && typeof run.metadata === 'object' ? run.metadata : {}
  const graphRowCount = Number(graphResult.count || 0)
  const facetCount = Number(facetResult.count || 0)
  const graphRefreshScope = clean(metadata.graph_refresh_scope) || (graphRowCount > 0 ? 'unknown' : 'empty')

  return {
    graph_refresh_scope: graphRefreshScope,
    graph_row_count: graphRowCount,
    facet_count: facetCount,
    latest_generated_at: Array.isArray(graphResult.data) ? graphResult.data[0]?.generated_at || null : null,
    latest_facet_updated_at: Array.isArray(facetResult.data) ? facetResult.data[0]?.updated_at || null : null,
    refresh_run_id: run?.id || null,
    refresh_status: run?.status || null,
    refresh_started_at: run?.started_at || null,
    refresh_finished_at: run?.finished_at || null,
    refresh_graph_rows: Number(run?.graph_rows || 0),
    refresh_facet_rows: Number(run?.facet_rows || 0),
    warnings,
  }
}

function graphFilterColumn(filter = {}) {
  const fieldKey = clean(filter.field_key || filter.fieldKey || filter.field)
  if (CAMPAIGN_TARGET_GRAPH_FILTER_COLUMNS[fieldKey]) return CAMPAIGN_TARGET_GRAPH_FILTER_COLUMNS[fieldKey]
  const field = filter.fieldDefinition || getCampaignFieldDefinition(fieldKey)
  if (!field) return null
  const column = field.key?.split('.').pop()
  return CAMPAIGN_TARGET_GRAPH_FILTER_COLUMNS[`${field.domain}.${column}`] || null
}

function graphApplicationColumn(filter = {}) {
  const fieldKey = clean(filter.field_key || filter.fieldKey || filter.field)
  if (fieldKey === 'sender_coverage.sender_coverage_status') return 'sender_covered'
  if (fieldKey === 'outreach.duplicate_queue_status') return 'active_queue_item'
  return graphFilterColumn(filter)
}

function resolveCatalogFiltersForTargetGraph(catalogFilters = {}) {
  const supported = []
  const mappingUnsupported = []

  for (const filter of catalogFilters.supported || []) {
    const graphColumn = graphApplicationColumn(filter)
    const normalized = {
      ...filter,
      graph_column: graphColumn || null,
      preview_column: graphColumn || null,
      preview_columns: graphColumn ? [graphColumn] : [],
      preview_mapping: {
        field_key: filter.field_key,
        graph_column: graphColumn || null,
        preview_column: graphColumn || null,
        preview_columns: graphColumn ? [graphColumn] : [],
      },
    }
    if (graphColumn) {
      supported.push({
        ...normalized,
        applied_in_preview: true,
      })
    } else {
      mappingUnsupported.push({
        ...publicFilter(normalized),
        supported_in_preview: false,
        applied_in_preview: false,
        unsupported_reason: 'missing_campaign_target_graph_column_mapping',
        message: 'Filter applied but no graph column mapping found.',
      })
    }
  }

  const unsupported = [
    ...(catalogFilters.unsupported || []).map((filter) => ({
      ...publicFilter(filter),
      supported_in_preview: false,
      applied_in_preview: false,
      unsupported_reason: filter.unsupported_reason || 'unsupported_in_target_graph',
      message: filter.message || 'Filter applied but no graph column mapping found.',
    })),
    ...mappingUnsupported,
  ]
  const unknown = (catalogFilters.unknown || []).map((filter) => ({
    ...publicFilter(filter),
    supported_in_preview: false,
    applied_in_preview: false,
    unsupported_reason: 'unknown_campaign_field',
    message: 'Filter applied but no graph column mapping found.',
  }))

  return {
    ...catalogFilters,
    unknown,
    supported,
    unsupported,
    applied: [
      ...supported.map(publicFilter),
      ...unsupported,
      ...unknown,
    ],
    pre_filters: supported.filter((filter) => !SENDER_COVERAGE_FIELDS.has(filter.field_key)),
    sender_filters: supported.filter((filter) => SENDER_COVERAGE_FIELDS.has(filter.field_key)),
  }
}

function graphBooleanValue(value) {
  const text = lower(value)
  if (['true', '1', 'yes', 'covered', 'active_queue_item'].includes(text)) return true
  if (['false', '0', 'no', 'clear', 'no route', 'no_route'].includes(text)) return false
  return null
}

function applyGraphStatusFilter(query, filter = {}, column) {
  const operator = normalizePreviewOperator(filter.operator || 'eq', filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key))
  const values = filterScalarValues({ ...filter, operator })
  if (operator === 'is_empty') return query.is(column, null)
  if (operator === 'is_not_empty') return query.not(column, 'is', null)
  if (operator === 'is_true') return query.eq(column, true)
  if (operator === 'is_false') return query.eq(column, false)
  const bools = values.map(graphBooleanValue).filter((value) => value !== null)
  if (!bools.length) return query
  if (operator === 'is_not_any_of') return query.not(column, 'in', `(${bools.join(',')})`)
  if (bools.length === 1) return query.eq(column, bools[0])
  return query.in(column, [...new Set(bools)])
}

function applyCampaignGraphCatalogFilter(query, filter = {}, warnings = []) {
  const fieldKey = clean(filter.field_key)
  if (fieldKey === 'sender_coverage.sender_coverage_status') {
    return applyGraphStatusFilter(query, filter, 'sender_covered')
  }
  if (fieldKey === 'outreach.duplicate_queue_status') {
    return applyGraphStatusFilter(query, filter, 'active_queue_item')
  }

  const column = graphFilterColumn(filter)
  if (!column) {
    warnings.push(`campaign_target_graph_filter_not_materialized:${fieldKey || 'unknown'}`)
    return query
  }
  return applySupabaseFilterToColumn(query, filter, column)
}

function applyInFilter(query, column, values, normalizer = clean) {
  const safeValues = asArray(values).map(normalizer).filter(Boolean)
  if (!safeValues.length) return query
  return query.in(column, [...new Set(safeValues)])
}

function applyGraphTextIncludes(query, column, values, mode = 'any') {
  const terms = asArray(values).map((value) => clean(value).replace(/[,%]/g, '')).filter(Boolean)
  if (!terms.length) return query
  if (mode === 'all') {
    return terms.reduce((current, term) => current.ilike(column, `%${term}%`), query)
  }
  if (mode === 'exclude') {
    return terms.reduce((current, term) => current.not(column, 'ilike', `%${term}%`), query)
  }
  return terms.length === 1
    ? query.ilike(column, `%${terms[0]}%`)
    : query.or(terms.map((term) => `${column}.ilike.%${term}%`).join(','))
}

function applyCampaignGraphLegacyFilters(query, filters = {}) {
  query = applyInFilter(query, 'state', filters.states, normalizeState)
  query = applyInFilter(query, 'market', filters.markets)
  query = applyInFilter(query, 'timezone', filters.timezones)
  query = applyInFilter(query, 'owner_type_guess', filters.owner_types)
  query = applyInFilter(query, 'property_type', filters.property_type || filters.property_types)
  query = applyInFilter(query, 'property_class', filters.property_class || filters.property_classes)

  const requestedLanguage = lower(filters.language)
  if (requestedLanguage && requestedLanguage !== 'auto' && requestedLanguage !== 'all') {
    query = query.ilike('language', requestedLanguage)
  }

  query = applyGraphTextIncludes(query, 'podio_tags', filters.tags_include_any, 'any')
  query = applyGraphTextIncludes(query, 'podio_tags', filters.tags_include_all, 'all')
  query = applyGraphTextIncludes(query, 'podio_tags', filters.tags_exclude, 'exclude')

  const numericChecks = [
    ['min_final_acquisition_score', 'acquisition_score', 'gte'],
    ['min_equity_percent', 'equity_percent', 'gte'],
    ['equity_amount_min', 'equity_amount', 'gte'],
    ['equity_amount_max', 'equity_amount', 'lte'],
    ['estimated_value_min', 'estimated_value', 'gte'],
    ['estimated_value_max', 'estimated_value', 'lte'],
    ['cash_offer_min', 'cash_offer', 'gte'],
    ['cash_offer_max', 'cash_offer', 'lte'],
  ]
  for (const [filterKey, column, op] of numericChecks) {
    const threshold = numberOrNull(filters[filterKey])
    if (threshold === null) continue
    query = op === 'gte' ? query.gte(column, threshold) : query.lte(column, threshold)
  }

  if (asBoolean(filters.sms_eligible_required, false)) query = query.eq('sms_eligible', true)
  if (asBoolean(filters.valid_e164_required, true)) query = query.not('canonical_e164', 'is', null)
  if (asBoolean(filters.require_linked_property, false)) query = query.not('property_id', 'is', null)
  if (asBoolean(filters.require_linked_master_owner, false)) query = query.not('master_owner_id', 'is', null)
  if (asBoolean(filters.require_seller_first_name, false)) query = query.not('seller_first_name', 'is', null)
  if (asBoolean(filters.never_contacted_only, false)) query = query.eq('never_contacted', true)
  if (asBoolean(filters.likely_owner_required, false)) query = query.in('identity_alignment', ['verified', 'probable'])

  return query
}

function applyCampaignGraphFilters(query, options = {}, warnings = [], { requireQueueEligible = false } = {}) {
  if (options.market) query = query.eq('market', options.market)
  if (options.state) query = query.eq('state', normalizeState(options.state))
  query = applyCampaignGraphLegacyFilters(query, options.filters || {})
  for (const filter of options.catalog_filters?.supported || []) {
    query = applyCampaignGraphCatalogFilter(query, filter, warnings)
  }
  if (requireQueueEligible) query = query.eq('queue_eligible', true)
  return query
}

function missingOptionalGraphColumn(error) {
  const message = errorMessage(error).toLowerCase()
  for (const column of CAMPAIGN_TARGET_GRAPH_OPTIONAL_FILTER_COLUMNS) {
    if (
      message.includes(`.${column} does not exist`) ||
      message.includes(` ${column} does not exist`) ||
      message.includes(`"${column}"`)
    ) {
      return column
    }
  }
  return null
}

async function countCampaignGraphRows({ supabase, options, extra = null, requireQueueEligible = false }) {
  const warnings = []
  let query = supabase
    .from(CAMPAIGN_TARGET_GRAPH_TABLE)
    .select('graph_id', { count: 'exact', head: true })
  query = applyCampaignGraphFilters(query, options, warnings, { requireQueueEligible })
  if (typeof extra === 'function') query = extra(query)
  const { count, error } = await query
  if (error) {
    return {
      ok: false,
      count: 0,
      warnings: [`campaign_target_graph_count_unavailable:${errorMessage(error)}`, ...warnings],
    }
  }
  return { ok: true, count: Number(count || 0), warnings }
}

async function fetchCampaignGraphRows({ supabase, options, limit, requireQueueEligible = false, selectColumns = CAMPAIGN_TARGET_GRAPH_SELECT, didCompatRetry = false }) {
  const rows = []
  const warnings = []
  const cappedLimit = Math.max(1, Math.min(Number(limit || CAMPAIGN_TARGET_GRAPH_PREVIEW_LIMIT), CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT))
  for (let offset = 0; offset < cappedLimit; offset += CAMPAIGN_TARGET_GRAPH_PAGE_SIZE) {
    let query = supabase
      .from(CAMPAIGN_TARGET_GRAPH_TABLE)
      .select(selectColumns)
      .order('queue_eligible', { ascending: false, nullsFirst: false })
      .order('acquisition_score', { ascending: false, nullsFirst: false })
      .order('best_phone_score', { ascending: false, nullsFirst: false })
      .range(offset, Math.min(offset + CAMPAIGN_TARGET_GRAPH_PAGE_SIZE - 1, cappedLimit - 1))
    query = applyCampaignGraphFilters(query, options, warnings, { requireQueueEligible })
    const { data, error } = await query
    if (error) {
      const missingColumn = missingOptionalGraphColumn(error)
      if (!didCompatRetry && missingColumn) {
        const compat = await fetchCampaignGraphRows({
          supabase,
          options,
          limit,
          requireQueueEligible,
          selectColumns: CAMPAIGN_TARGET_GRAPH_COMPAT_SELECT,
          didCompatRetry: true,
        })
        return {
          ...compat,
          warnings: uniqueClean([
            `campaign_target_graph_select_compat_fallback:${missingColumn}`,
            ...(compat.warnings || []),
            ...warnings,
          ]),
        }
      }
      return {
        ok: false,
        rows,
        warnings: [`campaign_target_graph_rows_unavailable:${errorMessage(error)}`, ...warnings],
      }
    }
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < CAMPAIGN_TARGET_GRAPH_PAGE_SIZE || rows.length >= cappedLimit) break
  }
  return { ok: true, rows, warnings }
}

const PROPERTY_UNIVERSE_FILTER_COLUMNS = Object.freeze({
  'properties.market': 'market',
  'properties.property_address_city': 'property_address_city',
  'properties.property_address_state': 'property_address_state',
  'properties.property_address_zip': 'property_address_zip',
  'properties.property_address_county_name': 'property_address_county_name',
  // Canonical redirects: the bare property_* columns are sparse partial mirrors
  // (property_address_* is 100% populated), so the addressable universe always
  // resolves geography through the canonical address columns.
  'properties.property_state': 'property_address_state',
  'properties.property_zip': 'property_address_zip',
  'properties.property_county_name': 'property_address_county_name',
  'properties.property_type': 'property_type',
  'properties.property_class': 'property_class',
})

// Top of the funnel: how many rows in public.properties (the canonical source of
// truth) match the audience's property-level criteria BEFORE any contact /
// SMS-eligibility / sender-coverage narrowing. This is the "addressable" number the
// operator expects to see; the graph total below it is the campaign property
// universe once the property-universe refresh phase has completed.
// Non-property filters (prospects/phones/outreach/sender_coverage) intentionally do
// not constrain the universe -- they narrow the funnel further down. Any property
// attribute we cannot resolve to a concrete properties column flags the result
// approximate rather than silently overcounting. Failures are non-fatal (count=null)
// so a universe hiccup never degrades the rest of the preview.
async function countAddressableProperties({ supabase, options }) {
  let query = supabase
    .from('properties')
    .select('property_id', { count: 'exact', head: true })
  if (options.market) query = query.eq('market', options.market)
  if (options.state) query = query.eq('property_address_state', normalizeState(options.state))

  let approximate = false
  for (const filter of options.catalog_filters?.supported || []) {
    const key = clean(filter.field_key || filter.fieldKey)
    if (!key.startsWith('properties.')) continue
    const column = PROPERTY_UNIVERSE_FILTER_COLUMNS[key]
    if (!column) {
      approximate = true
      continue
    }
    query = applySupabaseFilterToColumn(query, filter, column)
  }

  const { count, error } = await query
  if (error) {
    return { ok: false, count: null, approximate, warnings: [`addressable_universe_unavailable:${errorMessage(error)}`] }
  }
  return { ok: true, count: Number(count || 0), approximate, warnings: [] }
}

async function summarizeCampaignGraph({ supabase, options, rowLimit, requireQueueEligibleRows = false }) {
  const [
    total,
    linkedMasterOwners,
    linkedProspects,
    reachableContacts,
    smsEligible,
    cleanTargets,
    senderCovered,
    readyToQueue,
    smsBlocked,
    missingPhone,
    suppressed,
    wrongNumber,
    pendingPriorTouch,
    activeQueue,
    noSenderCoverage,
    rows,
    addressable,
  ] = await Promise.all([
    countCampaignGraphRows({ supabase, options }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.not('master_owner_id', 'is', null) }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.not('prospect_id', 'is', null) }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.not('canonical_e164', 'is', null) }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.eq('sms_eligible', true) }),
    countCampaignGraphRows({
      supabase,
      options,
      extra: (query) => query.eq('sms_eligible', true).eq('true_post_contact_suppression', false).eq('wrong_number', false),
    }),
    countCampaignGraphRows({
      supabase,
      options,
      extra: (query) => query.eq('sms_eligible', true).eq('true_post_contact_suppression', false).eq('wrong_number', false).eq('sender_covered', true),
    }),
    countCampaignGraphRows({ supabase, options, requireQueueEligible: true }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.eq('sms_eligible', false).not('canonical_e164', 'is', null) }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.is('canonical_e164', null) }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.eq('true_post_contact_suppression', true) }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.eq('wrong_number', true) }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.eq('pending_prior_touch', true) }),
    countCampaignGraphRows({ supabase, options, extra: (query) => query.eq('active_queue_item', true) }),
    countCampaignGraphRows({
      supabase,
      options,
      extra: (query) => query.eq('sms_eligible', true).eq('true_post_contact_suppression', false).eq('wrong_number', false).eq('sender_covered', false),
    }),
    fetchCampaignGraphRows({
      supabase,
      options,
      limit: rowLimit,
      requireQueueEligible: requireQueueEligibleRows,
    }),
    countAddressableProperties({ supabase, options }),
  ])

  const allResults = [
    total,
    linkedMasterOwners,
    linkedProspects,
    reachableContacts,
    smsEligible,
    cleanTargets,
    senderCovered,
    readyToQueue,
    smsBlocked,
    missingPhone,
    suppressed,
    wrongNumber,
    pendingPriorTouch,
    activeQueue,
    noSenderCoverage,
    rows,
  ]
  const graphRefreshStatus = await readCampaignGraphRefreshStatus(supabase)

  // --- Addressable-universe invariant ----------------------------------------
  // "Addressable" is the property universe BEFORE contact / SMS / sender-coverage
  // narrowing, so it must never be smaller than the graph's matched property set. The
  // properties-table count (countAddressableProperties) can legitimately diverge
  // from the campaign_target_graph projection because the two stores normalize
  // values differently (metro vs city `market`, raw vs normalized `property_type`,
  // sparse vs canonical geo columns). That divergence previously produced the
  // impossible funnel state "Addressable 0 / Deliverable > 0". We clamp to the
  // matched-property floor and emit a developer-only diagnostic; operators never see a
  // funnel that goes back up.
  const matchedPropertyCount = Number(total.count || 0)
  const rawAddressable = addressable.ok === false ? null : Number(addressable.count || 0)
  const addressableInvariantWarnings = []
  let addressableProperties = rawAddressable
  let addressableSource = 'properties_universe'
  if (rawAddressable === null) {
    addressableProperties = matchedPropertyCount
    addressableSource = 'graph_matched_property_fallback'
    addressableInvariantWarnings.push('addressable_universe_fallback:source_unavailable_using_graph_matched_properties')
  } else if (rawAddressable < matchedPropertyCount) {
    addressableInvariantWarnings.push(
      `addressable_universe_clamped:properties_count=${rawAddressable}:matched_property_floor=${matchedPropertyCount}:reason=source_normalization_mismatch`,
    )
    addressableProperties = matchedPropertyCount
    addressableSource = 'graph_matched_property_floor'
  }
  // When we fall back / clamp to the matched-property floor the true universe is unknown
  // (>= matched properties), so the figure is approximate. When the properties count stands
  // on its own, preserve its own approximate flag.
  const addressableApproximate = addressableSource === 'properties_universe'
    ? Boolean(addressable.approximate)
    : true

  // Developer-mode funnel monotonicity invariants. The funnel must be
  // non-increasing: addressable >= matched >= reachable >= sms_eligible >= clean >=
  // sender_covered. ready_to_queue uses an independent queue-eligibility rule so
  // it is reported, not asserted. Violations are surfaced as diagnostics only.
  const invariantWarnings = []
  const checkMonotonic = (upperLabel, upper, lowerLabel, lower) => {
    const u = Number(upper)
    const l = Number(lower)
    if (Number.isFinite(u) && Number.isFinite(l) && l > u) {
      invariantWarnings.push(`funnel_invariant_violation:${lowerLabel}(${l})>${upperLabel}(${u})`)
    }
  }
  checkMonotonic('addressable', addressableProperties, 'matched_properties', matchedPropertyCount)
  checkMonotonic('matched_properties', matchedPropertyCount, 'reachable_phones', reachableContacts.count)
  checkMonotonic('reachable_phones', reachableContacts.count, 'sms_eligible', smsEligible.count)
  checkMonotonic('sms_eligible', smsEligible.count, 'clean', cleanTargets.count)
  checkMonotonic('clean', cleanTargets.count, 'sender_covered', senderCovered.count)

  return {
    ok: allResults.every((result) => result.ok !== false),
    warnings: uniqueClean([
      ...allResults.flatMap((result) => result.warnings || []),
      ...(addressable.warnings || []),
      ...addressableInvariantWarnings,
      ...invariantWarnings,
      ...(graphRefreshStatus.warnings || []),
    ]),
    graphRefreshStatus,
    totalMatched: total.count,
    addressableProperties,
    addressableApproximate,
    addressableSource,
    linkedMasterOwners: linkedMasterOwners.count,
    linkedProspects: linkedProspects.count,
    reachableContacts: reachableContacts.count,
    smsEligible: smsEligible.count,
    cleanTargets: cleanTargets.count,
    senderCovered: senderCovered.count,
    readyToQueue: readyToQueue.count,
    blockedCounts: {
      NO_PHONE: missingPhone.count,
      SMS_INELIGIBLE: smsBlocked.count,
      suppression_blocked: suppressed.count,
      wrong_number: wrongNumber.count,
      PENDING_PRIOR_TOUCH: pendingPriorTouch.count,
      ACTIVE_QUEUE_ITEM: activeQueue.count,
      routing_blocked: noSenderCoverage.count,
    },
    rows: rows.rows || [],
  }
}

function graphDistributionCounts(rows = []) {
  const counts = {
    markets: {},
    languages: {},
    propertyTypes: {},
    matchingFlags: {},
    routingTiers: {},
  }
  for (const row of rows) {
    increment(counts.markets, row.market || 'unknown')
    increment(counts.languages, row.language || 'unknown')
    increment(counts.propertyTypes, row.canonical_property_group || row.property_type || 'unknown')
    incrementListValues(counts.matchingFlags, row.matching_flags_text || 'unknown')
    increment(counts.routingTiers, row.routing_tier || 'unknown')
  }
  return counts
}

// campaign_target_graph.queue_eligible is a purely mechanical messaging-
// mechanics flag (sms_eligible/suppression/wrong_number/pending_touch/
// active_queue/sender_covered) — it carries no owner-identity, timezone, or
// phone-ownership-ambiguity signal. buildCampaignTargets only ever receives
// queue_eligible=true rows, so status/target_status must not be derived from
// queue_eligible alone or every graph-sourced target is marked 'ready'
// regardless of identity/timezone/ambiguity. Reuses the same canonical,
// fail-closed identity policy createCampaignQueuePlan already gates on
// (evaluatePreSendEligibility -> isIdentityEligibleForLiveOutbound) so the
// two layers cannot silently drift apart.
function resolveCampaignTargetReadiness(row = {}) {
  const hasLinkage = Boolean(
    clean(row.master_owner_id) && clean(row.prospect_id || row.canonical_prospect_id) &&
    clean(row.phone_id) && clean(row.canonical_e164)
  )
  const hasTimezone = Boolean(clean(row.timezone))
  const ambiguousPhone = Boolean(row.ambiguous_phone_ownership)
  const eligibility = evaluatePreSendEligibility(
    { identity_alignment: { status: clean(row.identity_alignment) || 'unknown' } },
    {}
  )

  const blockReason = !row.queue_eligible
    ? clean(row.queue_block_reason || 'graph_not_queue_eligible')
    : !hasLinkage
      ? 'missing_identity_linkage'
      : !eligibility.eligible
        ? clean(eligibility.reason) || 'identity_not_verified'
        : !hasTimezone
          ? 'missing_timezone'
          : ambiguousPhone
            ? 'ambiguous_phone_ownership'
            : null

  return { ready: blockReason === null, blockReason }
}

function buildTargetSnapshotFromGraphRow(campaign, row = {}, index = 0, options = {}) {
  const campaignId = campaign?.id || null
  const prospectId = clean(row.prospect_id || row.canonical_prospect_id) || null
  const readiness = resolveCampaignTargetReadiness(row)
  return {
    campaign_id: campaignId,
    campaign_key: `ct:${campaignId || 'preview'}:${clean(row.graph_id) || crypto
      .createHash('sha1')
      .update([row.master_owner_id, row.property_id, row.phone_id, row.canonical_e164, index].join('|'))
      .digest('hex')
      .slice(0, 24)}`,
    campaign_name: campaign?.name || null,
    market: clean(row.market) || clean(campaign?.market) || 'unknown',
    asset_type: clean(row.canonical_property_group || row.property_type || 'campaign_automation'),
    strategy: clean(campaign?.objective || options.template_use_case || row.template_use_case || 'ownership_check') || 'ownership_check',
    language: clean(row.language || campaign?.language_policy || 'auto') || 'auto',
    source_view_name: CAMPAIGN_TARGET_GRAPH_TABLE,
    daily_cap: campaign?.daily_cap || null,
    status: readiness.ready ? 'ready' : 'blocked',
    master_owner_id: clean(row.master_owner_id) || null,
    prospect_id: prospectId,
    property_id: clean(row.property_id) || null,
    phone_id: clean(row.phone_id) || null,
    to_phone_number: clean(row.canonical_e164) || null,
    owner_name: clean(row.owner_name || row.seller_full_name) || null,
    property_address: clean(row.property_address_full) || null,
    state: normalizeState(row.state) || null,
    timezone: clean(row.timezone) || null,
    priority_score: numberOrNull(row.acquisition_score),
    identity_status: clean(row.identity_alignment) || 'unknown',
    routing_status: row.sender_covered ? 'ready' : 'blocked',
    suppression_status: row.true_post_contact_suppression ? 'blocked' : 'clear',
    template_status: readiness.ready ? 'pending' : 'blocked',
    target_status: readiness.ready ? 'ready' : 'blocked',
    block_reason: readiness.blockReason,
    metadata: {
      source: CAMPAIGN_TARGET_GRAPH_TABLE,
      graph_id: row.graph_id || null,
      graph_source: row.graph_source || CAMPAIGN_TARGET_GRAPH_TABLE,
      property_export_id: row.property_export_id || null,
      prospect_id: row.prospect_id || null,
      canonical_prospect_id: row.canonical_prospect_id || null,
      sender_covered: Boolean(row.sender_covered),
      selected_textgrid_market: row.sender_market || null,
      routing_tier: row.routing_tier || null,
      template_use_case: options.template_use_case || row.template_use_case || null,
      identity_alignment: row.identity_alignment || null,
      linkage_counts: row.linkage_counts || {},
      blocker_flags: row.blocker_flags || {},
      candidate_snapshot: {
        master_owner_id: row.master_owner_id,
        prospect_id: row.prospect_id,
        canonical_prospect_id: row.canonical_prospect_id,
        property_id: row.property_id,
        phone_id: row.phone_id,
        to_phone_number: row.canonical_e164,
        market: row.market,
        state: row.state,
        language: row.language,
        timezone: row.timezone,
        contact_window: row.contact_window,
        owner_name: row.owner_name,
        seller_first_name: row.seller_first_name,
        seller_full_name: row.seller_full_name,
        property_address_full: row.property_address_full,
        property_city: row.property_city,
        property_zip: row.property_zip,
        property_type: row.property_type,
        property_class: row.property_class,
        canonical_property_group: row.canonical_property_group,
        phone_owner: row.phone_owner,
        phone_activity_status: row.phone_activity_status,
        usage_12_months: row.usage_12_months,
        usage_2_months: row.usage_2_months,
        acquisition_score: row.acquisition_score,
      },
      outreach_snapshot: {
        never_contacted: row.never_contacted,
        latest_contact_at: row.latest_contact_at || null,
        last_outbound_at: row.last_outbound_at || null,
        last_inbound_at: row.last_inbound_at || null,
        touch_count: row.touch_count ?? null,
        current_touch_number: row.current_touch_number ?? null,
        true_post_contact_suppression: row.true_post_contact_suppression,
        wrong_number: row.wrong_number,
        pending_prior_touch: row.pending_prior_touch,
        active_queue_item: row.active_queue_item,
        queue_eligible: row.queue_eligible,
        queue_block_reason: row.queue_block_reason || null,
      },
    },
  }
}

function buildNestedGraphSampleTarget(row = {}, targetRow = {}, index = 0) {
  return {
    id: targetRow.campaign_key || row.graph_id || `preview-${index + 1}`,
    graph_id: row.graph_id || null,
    property: compactSampleObject({
      property_id: row.property_id || null,
      property_export_id: row.property_export_id || null,
      address: row.property_address_full || null,
      city: row.property_city || null,
      state: row.state || null,
      zip: row.property_zip || null,
      market: row.market || null,
      property_type: row.property_type || null,
      canonical_property_group: row.canonical_property_group || null,
      estimated_value: row.estimated_value ?? null,
      equity_percent: row.equity_percent ?? null,
      acquisition_score: row.acquisition_score ?? null,
    }),
    prospect: compactSampleObject({
      prospect_id: row.prospect_id || null,
      canonical_prospect_id: row.canonical_prospect_id || null,
      display_name: row.seller_full_name || null,
      language_preference: row.language || null,
      matching_flags: row.matching_flags_text || null,
      sms_eligible: row.sms_eligible ?? null,
      timezone: row.timezone || null,
      contact_window: row.contact_window || null,
    }),
    master_owner: compactSampleObject({
      master_owner_id: row.master_owner_id || null,
      display_name: row.owner_name || null,
      owner_type_guess: row.owner_type_guess || null,
      priority_tier: row.priority_tier || null,
      follow_up_cadence: row.follow_up_cadence || null,
      priority_score: row.acquisition_score ?? null,
    }),
    phone: compactSampleObject({
      phone_id: row.phone_id || null,
      canonical_e164: row.canonical_e164 || null,
      phone_owner: row.phone_owner || null,
      activity_status: row.phone_activity_status || null,
      usage_12_months: row.usage_12_months ?? null,
      usage_2_months: row.usage_2_months ?? null,
      best_phone_score: row.best_phone_score ?? null,
    }),
    outreach: compactSampleObject({
      never_contacted: row.never_contacted ?? null,
      latest_contact_at: row.latest_contact_at || null,
      last_outbound_at: row.last_outbound_at || null,
      last_inbound_at: row.last_inbound_at || null,
      touch_count: row.touch_count ?? null,
      current_touch_number: row.current_touch_number ?? null,
      true_post_contact_suppression: row.true_post_contact_suppression ?? null,
      pending_prior_touch: row.pending_prior_touch ?? null,
      active_queue_item: row.active_queue_item ?? null,
    }),
    sender_coverage: compactSampleObject({
      routing_allowed: Boolean(row.sender_covered),
      routing_tier: row.routing_tier || null,
      selected_textgrid_market: row.sender_market || null,
      selected_textgrid_state: row.state || null,
      sender_coverage_status: row.sender_covered ? 'Covered' : 'No Route',
    }),
    queue: compactSampleObject({
      queue_eligible: row.queue_eligible ?? null,
      queue_block_reason: row.queue_block_reason || null,
    }),
  }
}

function graphAppliedFilterSummary(options = {}) {
  return [
    {
      phase: 'target_graph',
      field: 'source',
      operator: 'from',
      value: CAMPAIGN_TARGET_GRAPH_TABLE,
    },
    ...(options.market ? [{
      phase: 'target_graph',
      field: 'market',
      operator: 'eq',
      value: options.market,
    }] : []),
    ...(options.state ? [{
      phase: 'target_graph',
      field: 'state',
      operator: 'eq',
      value: normalizeState(options.state),
    }] : []),
    ...(options.catalog_filters?.supported || []).map((filter) => ({
      phase: SENDER_COVERAGE_FIELDS.has(filter.field_key) ? 'sender_coverage_filter' : 'target_graph_filter',
      field_key: filter.field_key,
      graph_column: graphApplicationColumn(filter) || null,
      operator: filter.operator,
      value: summarizeFilterValue(filter.value),
    })),
  ]
}

async function previewCampaignTargetsFromGraph(input = {}, deps = {}) {
  const startedAt = Date.now()
  const supabase = deps.supabase || defaultSupabase
  const campaign = input.campaign || null
  const baseOptions = previewOptionsFromInput(input, campaign)
  const options = {
    ...baseOptions,
    catalog_filters: resolveCatalogFiltersForTargetGraph(baseOptions.catalog_filters),
  }
  options.target_limit = Math.max(1, Math.min(options.target_limit || CAMPAIGN_TARGET_GRAPH_PREVIEW_LIMIT, CAMPAIGN_TARGET_GRAPH_PREVIEW_LIMIT))

  if (!supabase) {
    return {
      ok: false,
      error: 'CAMPAIGN_TARGET_GRAPH_UNAVAILABLE',
      warnings: ['campaign_target_graph_supabase_unavailable'],
      queryMs: Date.now() - startedAt,
    }
  }

  const graph = await summarizeCampaignGraph({
    supabase,
    options,
    rowLimit: options.target_limit,
    requireQueueEligibleRows: false,
  })
  const warnings = uniqueClean([
    ...(options.source_warnings || []),
    ...buildPreviewWarnings(options.catalog_filters),
    ...(graph.warnings || []),
  ])
  const graphRefreshStatus = graph.graphRefreshStatus || {}
  if (!graph.ok) {
    const diagnostics = {
      receivedSource: options.received_source,
      normalizedSource: CAMPAIGN_TARGET_GRAPH_TABLE,
      sourceUsed: CAMPAIGN_TARGET_GRAPH_TABLE,
      sourceFallbackUsed: null,
      sourceNormalizationReason: 'canonical_target_graph_unavailable',
      sourceAttempts: [{ source: CAMPAIGN_TARGET_GRAPH_TABLE, ok: false, error: warnings[0] || 'graph_unavailable' }],
      normalizedFilters: (options.catalog_filters.applied || []).map(publicFilter),
      supportedFilters: (options.catalog_filters.supported || []).map(publicFilter),
      unsupportedFilters: buildSkippedPreviewFilters(options.catalog_filters),
      appliedFilters: (options.catalog_filters.supported || []).map(publicFilter),
      skippedFilters: buildSkippedPreviewFilters(options.catalog_filters),
      frontendPayloadDomainCounts: options.frontend_payload_domain_counts || {},
      backendReceivedDomainCounts: options.catalog_filters.received_domain_counts || emptyDomainCounts(),
      backendAppliedDomainCounts: options.catalog_filters.applied_domain_counts || emptyDomainCounts(),
      droppedFilterCount: Number(options.catalog_filters.dropped_filter_count || 0),
      droppedFilters: (options.catalog_filters.dropped || []).map(publicFilter),
      appliedSqlFilters: graphAppliedFilterSummary(options),
      sourceColumnsUsed: {},
      previewSourceColumns: CAMPAIGN_TARGET_GRAPH_SELECT.split(','),
      previewSourceDerivedFields: [],
      sourceRowsSampledForColumns: 0,
      warnings,
      graphRefreshStatus,
      queryMs: Date.now() - startedAt,
    }
    return withPreviewDiagnostics({
      ok: true,
      dry_run: true,
      graph_unavailable: true,
      candidate_source: CAMPAIGN_TARGET_GRAPH_TABLE,
      requested_source: options.received_source || CAMPAIGN_TARGET_GRAPH_TABLE,
      total_scanned: 0,
      filter_matched: 0,
      clean_targets: 0,
      ready_to_queue: 0,
      queueable_today: 0,
      blocked_counts_by_reason: {},
      sender_coverage_counts: {},
      sender_number_counts: {},
      identity_counts: {},
      language_counts: {},
      template_readiness_counts: { ready: 0, blocked: 0, missing: 0, render_failed: 0 },
      template_id_counts: {},
      routing_tier_counts: {},
      layerCounts: emptyLayerCounts(),
      distribution_counts: { markets: {}, languages: {}, propertyTypes: {}, matchingFlags: {}, routingTiers: {} },
      distributions: { markets: [], languages: [], propertyTypes: [], matchingFlags: [], routingTiers: [] },
      sample_targets: [],
      sampleTargets: [],
      sample_blocks: [],
      target_rows: [],
      reach: { addressableProperties: null, addressableApproximate: false, totalMatched: 0, cleanTargets: 0, readyToQueue: 0, queueableToday: 0 },
      addressable_properties: null,
      addressable_properties_approximate: false,
      funnel: [],
      headline_metric: 'ready_to_queue',
      headline_count: 0,
      blocked: buildBlockedSummary({}),
      appliedFilters: options.catalog_filters.applied,
      graph_join_key_report: { graph_source: CAMPAIGN_TARGET_GRAPH_TABLE, unavailable: true },
      graph_source_coverage: { graph_source: CAMPAIGN_TARGET_GRAPH_TABLE, unavailable: true },
      graph_refresh_scope: graphRefreshStatus.graph_refresh_scope || 'unknown',
      graph_row_count: graphRefreshStatus.graph_row_count ?? null,
      graph_freshness: {
        latest_generated_at: graphRefreshStatus.latest_generated_at || null,
        refresh_finished_at: graphRefreshStatus.refresh_finished_at || null,
        refresh_status: graphRefreshStatus.refresh_status || null,
      },
      warnings,
      queryMs: Date.now() - startedAt,
      readiness_score: 0,
      total_matched_properties: 0,
      total_matched: 0,
      total_matching_properties: 0,
      owners_matched: 0,
      phones_matched: 0,
      linked_prospects: 0,
      linked_master_owners: 0,
      linked_phones: 0,
      sms_eligible_phones: 0,
      sender_covered: 0,
      clean_ready_targets: 0,
      blocked_waterfall: [],
      blocked_reason_waterfall: [],
      eligibility_waterfall: [],
      candidate_window: { scanned: 0, matched: 0, clean_targets: 0, ready_to_queue: 0, queueable_today: 0 },
      full_source_reach: { graph_source: CAMPAIGN_TARGET_GRAPH_TABLE, unavailable: true },
      unsupported_in_preview: [],
      blockers: [],
      by_market: [],
      by_state: [],
      by_tag: [],
      by_owner_type: [],
      by_language: [],
      distribution_groups: legacyDistributionArray({ markets: {}, languages: {}, propertyTypes: {}, matchingFlags: {}, routingTiers: {} }),
    }, diagnostics, options.include_diagnostics)
  }

  const queueableRows = (graph.rows || []).filter((row) => row.queue_eligible)
  const targetRows = queueableRows
    .slice(0, options.target_limit)
    .map((row, index) => buildTargetSnapshotFromGraphRow(campaign, row, index, options))
  const sampleTargets = (graph.rows || [])
    .slice(0, 25)
    .map((row, index) => buildNestedGraphSampleTarget(row, buildTargetSnapshotFromGraphRow(campaign, row, index, options), index))
  const sampleBlocks = (graph.rows || [])
    .filter((row) => !row.queue_eligible)
    .slice(0, 25)
    .map((row) => ({
      reason: row.queue_block_reason || 'graph_not_queue_eligible',
      master_owner_id: row.master_owner_id,
      property_id: row.property_id,
      phone_id: row.phone_id,
      market: row.market,
      state: row.state,
    }))
  const blocked = graph.blockedCounts || {}
  const blockedSummary = buildBlockedSummary(blocked)
  const dailyCap = asPositiveInteger(input.daily_cap ?? campaign?.daily_cap ?? options.filters.daily_cap, null)
  const queueableToday = dailyCap ? Math.min(graph.readyToQueue, dailyCap) : graph.readyToQueue
  const audienceFunnel = [
    { key: 'addressable', label: 'Addressable properties', count: graph.addressableProperties, approximate: Boolean(graph.addressableApproximate) },
    { key: 'matched_properties', label: 'Matched properties', count: graph.totalMatched },
    { key: 'reachable', label: 'With reachable phone', count: graph.reachableContacts },
    { key: 'sms_eligible', label: 'SMS-eligible', count: graph.smsEligible },
    { key: 'clean', label: 'Clean (not suppressed / wrong number)', count: graph.cleanTargets },
    { key: 'sender_covered', label: 'Sender-covered', count: graph.senderCovered },
    { key: 'ready_to_queue', label: 'Ready to queue', count: graph.readyToQueue },
    { key: 'queueable_today', label: 'Queueable today', count: queueableToday },
  ]
  const distributionsCounts = graphDistributionCounts(graph.rows || [])
  const distributions = {
    markets: bucketArray(distributionsCounts.markets),
    languages: bucketArray(distributionsCounts.languages),
    propertyTypes: bucketArray(distributionsCounts.propertyTypes),
    matchingFlags: bucketArray(distributionsCounts.matchingFlags),
    routingTiers: bucketArray(distributionsCounts.routingTiers),
  }
  const diagnostics = {
    receivedSource: options.received_source,
    normalizedSource: CAMPAIGN_TARGET_GRAPH_TABLE,
    sourceUsed: CAMPAIGN_TARGET_GRAPH_TABLE,
    sourceFallbackUsed: null,
    sourceNormalizationReason: 'canonical_target_graph',
    sourceAttempts: [{ source: CAMPAIGN_TARGET_GRAPH_TABLE, ok: true, scanned_count: graph.rows.length }],
    normalizedFilters: (options.catalog_filters.applied || []).map(publicFilter),
    supportedFilters: (options.catalog_filters.supported || []).map(publicFilter),
    unsupportedFilters: buildSkippedPreviewFilters(options.catalog_filters),
    appliedFilters: (options.catalog_filters.supported || []).map(publicFilter),
    skippedFilters: buildSkippedPreviewFilters(options.catalog_filters),
    frontendPayloadDomainCounts: options.frontend_payload_domain_counts || {},
    backendReceivedDomainCounts: options.catalog_filters.received_domain_counts || emptyDomainCounts(),
    backendAppliedDomainCounts: options.catalog_filters.applied_domain_counts || emptyDomainCounts(),
    droppedFilterCount: Number(options.catalog_filters.dropped_filter_count || 0),
    droppedFilters: (options.catalog_filters.dropped || []).map(publicFilter),
    appliedSqlFilters: graphAppliedFilterSummary(options),
    sourceColumnsUsed: Object.fromEntries((options.catalog_filters.supported || []).map((filter) => [filter.field_key, [graphApplicationColumn(filter)].filter(Boolean)])),
    previewSourceColumns: CAMPAIGN_TARGET_GRAPH_SELECT.split(','),
    previewSourceDerivedFields: [],
    sourceRowsSampledForColumns: graph.rows.length,
    warnings,
    graphRefreshStatus,
    queryMs: Date.now() - startedAt,
  }
  const eligibilityWaterfall = buildEligibilityWaterfall({
    totalReachMatched: graph.totalMatched,
    fullReach: {
      countSource: CAMPAIGN_TARGET_GRAPH_TABLE,
      linked_master_owners_count: graph.linkedMasterOwners,
      linked_prospects_count: graph.linkedProspects,
      linked_phones_count: graph.reachableContacts,
      sms_eligible_phones_count: graph.smsEligible,
      clean_targets_count: graph.cleanTargets,
      sender_covered_count: graph.senderCovered,
      ready_to_queue_count: graph.readyToQueue,
    },
    summary: {
      ready_to_queue: graph.readyToQueue,
      filter_matched: graph.totalMatched,
      layerCounts: {
        propertiesMatched: graph.totalMatched,
        prospectsMatched: graph.linkedProspects,
        masterOwnersMatched: graph.linkedMasterOwners,
        phonesMatched: graph.reachableContacts,
        outreachEligible: graph.cleanTargets,
        senderCoverageEligible: graph.senderCovered,
      },
    },
    blocked,
    cleanTargetCount: graph.cleanTargets,
    cleanTargetsSource: 'campaign_target_graph',
    candidateWindowCleanTargets: graph.cleanTargets,
    queueableToday,
    effectiveOptions: options,
  })

  return withPreviewDiagnostics({
    ok: true,
    dry_run: true,
    candidate_source: CAMPAIGN_TARGET_GRAPH_TABLE,
    requested_source: options.received_source || CAMPAIGN_TARGET_GRAPH_TABLE,
    total_scanned: graph.totalMatched,
    filter_matched: graph.totalMatched,
    clean_targets: graph.cleanTargets,
    ready_to_queue: graph.readyToQueue,
    queueable_today: queueableToday,
    blocked_counts_by_reason: blocked,
    sender_coverage_counts: distributionsCounts.markets,
    sender_number_counts: {},
    identity_counts: {},
    language_counts: distributionsCounts.languages,
    template_readiness_counts: {
      ready: graph.readyToQueue,
      blocked: Math.max(0, graph.totalMatched - graph.readyToQueue),
      missing: 0,
      render_failed: 0,
    },
    template_id_counts: {},
    routing_tier_counts: distributionsCounts.routingTiers,
    layerCounts: {
      propertiesMatched: graph.totalMatched,
      prospectsMatched: graph.linkedProspects,
      masterOwnersMatched: graph.linkedMasterOwners,
      phonesMatched: graph.reachableContacts,
      outreachEligible: graph.cleanTargets,
      senderCoverageEligible: graph.senderCovered,
    },
    distribution_counts: distributionsCounts,
    sample_targets: sampleTargets,
    sample_blocks: sampleBlocks,
    target_rows: targetRows,
    reach: {
      addressableProperties: graph.addressableProperties,
      addressableApproximate: Boolean(graph.addressableApproximate),
      totalMatched: graph.totalMatched,
      linkedMasterOwners: graph.linkedMasterOwners,
      linkedProspects: graph.linkedProspects,
      reachableContacts: graph.reachableContacts,
      cleanTargets: graph.cleanTargets,
      readyToQueue: graph.readyToQueue,
      queueableToday,
    },
    addressable_properties: graph.addressableProperties,
    addressable_properties_approximate: Boolean(graph.addressableApproximate),
    addressable_source: graph.addressableSource || 'properties_universe',
    funnel: audienceFunnel,
    headline_metric: 'ready_to_queue',
    headline_count: graph.readyToQueue,
    blocked: blockedSummary,
    distributions,
    sampleTargets,
    appliedFilters: options.catalog_filters.applied,
    graph_refresh_scope: graphRefreshStatus.graph_refresh_scope || 'unknown',
    graph_row_count: graphRefreshStatus.graph_row_count ?? null,
    graph_freshness: {
      latest_generated_at: graphRefreshStatus.latest_generated_at || null,
      latest_facet_updated_at: graphRefreshStatus.latest_facet_updated_at || null,
      refresh_finished_at: graphRefreshStatus.refresh_finished_at || null,
      refresh_status: graphRefreshStatus.refresh_status || null,
      refresh_run_id: graphRefreshStatus.refresh_run_id || null,
    },
    frontend_payload_domain_counts: options.frontend_payload_domain_counts || {},
    backend_received_domain_counts: options.catalog_filters.received_domain_counts || emptyDomainCounts(),
    backend_applied_domain_counts: options.catalog_filters.applied_domain_counts || emptyDomainCounts(),
    dropped_filter_count: Number(options.catalog_filters.dropped_filter_count || 0),
    dropped_filters: (options.catalog_filters.dropped || []).map(publicFilter),
    graph_join_key_report: {
      graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
      row_rule: '1 row = 1 campaign property; seller/phone fields may be null until reachable',
      property_id_values: graph.totalMatched,
      master_owner_id_values: graph.linkedMasterOwners,
      prospect_id_values: graph.linkedProspects,
      phone_id_values: graph.reachableContacts,
      canonical_e164_values: graph.reachableContacts,
      filter_compiler: 'campaign_target_graph_shared_filter_compiler',
    },
    graph_source_coverage: {
      graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
      total_properties: graph.totalMatched,
      total_paths: graph.totalMatched,
      linked_master_owners: graph.linkedMasterOwners,
      linked_prospects: graph.linkedProspects,
      linked_phones: graph.reachableContacts,
      reachable_contacts: graph.reachableContacts,
      sms_eligible_phones: graph.smsEligible,
      sender_covered: graph.senderCovered,
      queue_eligible: graph.readyToQueue,
    },
    warnings,
    queryMs: Date.now() - startedAt,
    readiness_score: readinessScore({ matched: graph.totalMatched, ready: graph.readyToQueue, blockers: blocked }),
    total_matched_properties: graph.totalMatched,
    total_matched: graph.totalMatched,
    candidate_window_matched: graph.totalMatched,
    full_reach_count: graph.totalMatched,
    full_reach_count_source: CAMPAIGN_TARGET_GRAPH_TABLE,
    full_reach_join_strategy: 'precomputed_property_universe_target_graph',
    full_reach_owner_filter_count: null,
    queue_eligibility_scope: CAMPAIGN_TARGET_GRAPH_TABLE,
    queue_eligibility_note: 'Preview reads only the precomputed campaign target graph. Graph refresh is asynchronous and outside the request path.',
    current_contact_window_blocks_preview: options.within_contact_window_now,
    clean_targets_source: CAMPAIGN_TARGET_GRAPH_TABLE,
    candidate_window_clean_targets: graph.cleanTargets,
    ready_to_queue_source: CAMPAIGN_TARGET_GRAPH_TABLE,
    queueable_today_source: CAMPAIGN_TARGET_GRAPH_TABLE,
    total_matching_properties: graph.totalMatched,
    owners_matched: graph.linkedMasterOwners,
    phones_matched: graph.reachableContacts,
    linked_prospects: graph.linkedProspects,
    linked_master_owners: graph.linkedMasterOwners,
    linked_phones: graph.reachableContacts,
    sms_eligible_phones: graph.smsEligible,
    sender_covered: graph.senderCovered,
    suppressed_count: blockedSummary.suppressed,
    opt_out_count: blockedSummary.dnc,
    wrong_number_count: blockedSummary.wrongNumber,
    active_queue_duplicate_count: blockedSummary.duplicateQueue,
    missing_phone_count: blockedSummary.noPhone,
    missing_sender_route_count: blockedSummary.noSenderCoverage,
    clean_ready_targets: graph.readyToQueue,
    blocked_waterfall: buildBlockedWaterfall(blocked),
    blocked_reason_waterfall: buildExplicitBlockedWaterfall(blocked),
    eligibility_waterfall: eligibilityWaterfall,
    candidate_window: {
      scanned: graph.totalMatched,
      matched: graph.totalMatched,
      clean_targets: graph.cleanTargets,
      ready_to_queue: graph.readyToQueue,
      queueable_today: queueableToday,
      blocked_counts_by_reason: blocked,
      blocked_waterfall: buildBlockedWaterfall(blocked),
      explicit_blocked_waterfall: buildExplicitBlockedWaterfall(blocked),
    },
    full_source_reach: {
      matched_properties: graph.totalMatched,
      count_source: CAMPAIGN_TARGET_GRAPH_TABLE,
      graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
      join_strategy: 'precomputed_property_universe_target_graph',
      graph_join_key_report: {
        graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
        row_rule: '1 row = 1 campaign property; seller/phone fields may be null until reachable',
      },
      graph_source_coverage: {
        total_properties: graph.totalMatched,
        total_paths: graph.totalMatched,
        reachable_contacts: graph.reachableContacts,
        queue_eligible: graph.readyToQueue,
      },
      linked_master_owners: graph.linkedMasterOwners,
      linked_prospects: graph.linkedProspects,
      linked_phones: graph.reachableContacts,
      sms_eligible_phones: graph.smsEligible,
      clean_targets: graph.cleanTargets,
      sender_covered: graph.senderCovered,
      ready_to_queue: graph.readyToQueue,
      queueable_today: queueableToday,
    },
    unsupported_in_preview: (options.catalog_filters.unsupported || []).map((filter) => ({
      fieldKey: filter.field_key,
      label: filter.label,
      reason: 'unsupported_in_target_graph',
    })),
    blockers: Object.entries(blocked).filter(([, count]) => Number(count) > 0).map(([reason, count]) => `${reason}:${count}`),
    by_market: Object.entries(distributionsCounts.markets).map(([label, count]) => ({ label, count })),
    by_state: [],
    by_tag: [],
    by_owner_type: [],
    by_language: Object.entries(distributionsCounts.languages).map(([label, count]) => ({ label, count })),
    distribution_groups: legacyDistributionArray(distributionsCounts),
  }, diagnostics, options.include_diagnostics)
}

export async function previewCampaignTargets(input = {}, deps = {}) {
  if (process.env.CAMPAIGN_PREVIEW_ALLOW_RUNTIME_EXPANSION !== '1') {
    return previewCampaignTargetsFromGraph(input, deps)
  }

  const startedAt = Date.now()
  const options = previewOptionsFromInput(input, input.campaign || null)
  let { source, attempts: sourceAttempts } = await fetchPreviewCandidateSource(options, deps)
  let hydrationWarnings = []
  const hydrated = await hydratePreviewSourceForCatalogFilters(source, options.catalog_filters, deps)
  source = hydrated.source
  hydrationWarnings = [...hydrationWarnings, ...hydrated.warnings]
  let sourceColumns = collectPreviewSourceColumns(source?.rows || [])
  let effectiveCatalogFilters = resolveCatalogFiltersForPreview(options.catalog_filters, sourceColumns)

  if (shouldRetryFallbackSourceForMappings(source, sourceColumns, effectiveCatalogFilters, options)) {
    const fallback = await fetchPreviewCandidateSource({
      ...options,
      candidate_source: FALLBACK_PREVIEW_CANDIDATE_SOURCE,
      candidate_source_candidates: [FALLBACK_PREVIEW_CANDIDATE_SOURCE],
    }, deps)
    sourceAttempts = [...sourceAttempts, ...fallback.attempts.map((attempt) => ({
      ...attempt,
      reason: 'fallback_for_preview_filter_mapping',
    }))]
    if (fallback.source?.ok !== false) {
      const hydratedFallback = await hydratePreviewSourceForCatalogFilters(fallback.source, options.catalog_filters, deps)
      source = hydratedFallback.source
      hydrationWarnings = [...hydrationWarnings, ...hydratedFallback.warnings]
      sourceColumns = collectPreviewSourceColumns(source?.rows || [])
      effectiveCatalogFilters = resolveCatalogFiltersForPreview(options.catalog_filters, sourceColumns)
    }
  }

  const effectiveOptions = {
    ...options,
    catalog_filters: effectiveCatalogFilters,
    filters: {
      ...options.filters,
      ...(options.catalog_preview_defaults_added && !effectiveCatalogFilters.supported.length
        ? { require_linked_property: false, valid_e164_required: false }
        : {}),
    },
  }
  const warnings = [
    ...(options.source_warnings || []),
    ...(sourceAttempts.length > 1 && sourceAttempts[0]?.ok === false
      ? [`preview_source_fallback: ${sourceAttempts[0].source} unavailable; using ${source?.source || FALLBACK_PREVIEW_CANDIDATE_SOURCE}.`]
      : []),
    ...(sourceAttempts.some((attempt) => attempt.reason === 'fallback_for_preview_filter_mapping')
      ? [`preview_source_fallback: ${PREFERRED_PREVIEW_CANDIDATE_SOURCE} lacked required preview filter columns; using ${source?.source || FALLBACK_PREVIEW_CANDIDATE_SOURCE}.`]
      : []),
    ...hydrationWarnings,
    ...buildPreviewWarnings(effectiveCatalogFilters),
  ]
  if (layerCountsMayBePartial(sourceColumns, effectiveOptions)) {
    warnings.push('layer_count_partial')
  }

  if (source?.ok === false) {
    const diagnostics = buildPreviewDiagnostics({
      options: effectiveOptions,
      source,
      sourceAttempts,
      catalogFilters: effectiveCatalogFilters,
      sourceColumns,
      warnings,
      queryMs: Date.now() - startedAt,
    })
    return withPreviewDiagnostics({
      ok: false,
      error: source.error || 'CANDIDATE_SOURCE_UNAVAILABLE',
      candidate_source_error: source.candidate_source_error || null,
      reach: {
        totalMatched: 0,
        cleanTargets: 0,
        readyToQueue: 0,
        queueableToday: 0,
      },
      blocked: buildBlockedSummary({}),
      layerCounts: emptyLayerCounts(),
      distributions: {
        markets: [],
        languages: [],
        propertyTypes: [],
        matchingFlags: [],
        routingTiers: [],
      },
      sampleTargets: [],
      appliedFilters: effectiveCatalogFilters.applied,
      warnings,
      queryMs: Date.now() - startedAt,
      total_scanned: 0,
      total_matched: 0,
      clean_targets: 0,
      ready_to_queue: 0,
      queueable_today: 0,
      blocked_counts_by_reason: {},
      sender_coverage_counts: {},
      identity_counts: {},
      language_counts: {},
      template_readiness_counts: {},
      sample_targets: [],
      sample_blocks: [],
      unsupported_in_preview: effectiveCatalogFilters.unsupported,
    }, diagnostics, effectiveOptions.include_diagnostics)
  }

  const summary = {
    ok: true,
    dry_run: true,
    candidate_source: source.source,
    requested_source: source.requested_source,
    total_scanned: Number(source.scanned_count || 0),
    filter_matched: 0,
    clean_targets: 0,
    ready_to_queue: 0,
    blocked_counts_by_reason: {},
    sender_coverage_counts: {},
    sender_number_counts: {},
    identity_counts: {},
    language_counts: {},
    template_readiness_counts: {
      ready: 0,
      blocked: 0,
      missing: 0,
      render_failed: 0,
    },
    template_id_counts: {},
    routing_tier_counts: {},
    layerCounts: emptyLayerCounts(),
    distribution_counts: {
      markets: {},
      languages: {},
      propertyTypes: {},
      matchingFlags: {},
      routingTiers: {},
    },
    sample_targets: [],
    sample_blocks: [],
    target_rows: [],
  }

  const fullReachPromise = computeFullCatalogReachCount(options.catalog_filters, deps)
  const seenPhones = new Set()
  const seenOwners = new Set()
  const layerFilters = groupPreviewFiltersByDomain(effectiveOptions.catalog_filters.pre_filters || [])
  let index = 0

  for (const candidate of source.rows || []) {
    increment(summary.identity_counts, candidate.identity_alignment?.status || 'unknown')
    increment(summary.language_counts, candidate.best_language || candidate.language || 'unknown')

    const filterCheck = candidateMatchesFilters(candidate, effectiveOptions.filters)
    const propertyLayerCheck = candidateMatchesCatalogFilters(candidate, layerFilters.properties || [])
    const prospectLayerCheck = candidateMatchesCatalogFilters(candidate, layerFilters.prospects || [])
    const masterOwnerLayerCheck = candidateMatchesCatalogFilters(candidate, layerFilters.master_owners || [])
    const phoneLayerCheck = candidateMatchesCatalogFilters(candidate, layerFilters.phones || [])
    const outreachLayerCheck = candidateMatchesCatalogFilters(candidate, layerFilters.outreach || [])
    const catalogFilterCheck = {
      ok: [
        propertyLayerCheck,
        prospectLayerCheck,
        masterOwnerLayerCheck,
        phoneLayerCheck,
        outreachLayerCheck,
      ].every((check) => check.ok),
      reasons: [
        ...(propertyLayerCheck.reasons || []),
        ...(prospectLayerCheck.reasons || []),
        ...(masterOwnerLayerCheck.reasons || []),
        ...(phoneLayerCheck.reasons || []),
        ...(outreachLayerCheck.reasons || []),
      ],
    }

    const propertyLayerMatched = propertyLayerCheck.ok && hasPropertyLayer(candidate)
    const prospectLayerMatched = propertyLayerMatched && prospectLayerCheck.ok && hasProspectLayer(candidate)
    const masterOwnerLayerMatched = prospectLayerMatched && masterOwnerLayerCheck.ok && hasMasterOwnerLayer(candidate)
    const phoneLayerMatched = masterOwnerLayerMatched && phoneLayerCheck.ok && hasPhoneLayer(candidate)
    if (propertyLayerMatched) summary.layerCounts.propertiesMatched += 1
    if (prospectLayerMatched) summary.layerCounts.prospectsMatched += 1
    if (masterOwnerLayerMatched) summary.layerCounts.masterOwnersMatched += 1
    if (phoneLayerMatched) summary.layerCounts.phonesMatched += 1

    if (!filterCheck.ok || !catalogFilterCheck.ok) {
      const reasons = [...(filterCheck.reasons || []), ...(catalogFilterCheck.reasons || [])]
      increment(summary.blocked_counts_by_reason, reasons[0] || 'filter_mismatch')
      if (summary.sample_blocks.length < 25) {
        summary.sample_blocks.push({
          reason: reasons[0] || 'filter_mismatch',
          reasons,
          master_owner_id: candidate.master_owner_id,
          property_id: candidate.property_id,
          market: candidate.market,
          state: candidate.state,
        })
      }
      continue
    }

    summary.filter_matched += 1
    increment(summary.distribution_counts.markets, candidate.market || candidate.raw?.market || 'unknown')
    increment(summary.distribution_counts.languages, candidate.best_language || candidate.language || candidate.raw?.language_preference || 'unknown')
    increment(summary.distribution_counts.propertyTypes, candidate.property_type || candidate.raw?.property_type || candidate.canonical_property_group || 'unknown')
    incrementListValues(summary.distribution_counts.matchingFlags, candidate.matching_flags || candidate.raw?.matching_flags || candidate.raw?.person_flags_text || 'unknown')

    if (asBoolean(effectiveOptions.filters.dedupe_same_phone, true) && candidate.canonical_e164 && seenPhones.has(candidate.canonical_e164)) {
      increment(summary.blocked_counts_by_reason, 'duplicate_phone')
      continue
    }
    if (asBoolean(effectiveOptions.filters.dedupe_same_owner, true) && candidate.master_owner_id && seenOwners.has(candidate.master_owner_id)) {
      increment(summary.blocked_counts_by_reason, 'duplicate_owner')
      continue
    }

    candidate.touch_number = effectiveOptions.touch_number
    candidate.template_use_case = effectiveOptions.template_use_case
    candidate.campaign_session_id = effectiveOptions.campaign_session_id

    const eligibility = await evaluateCandidateEligibility(candidate, {
      ...effectiveOptions,
      dry_run: true,
      allow_internal_test_phones: false,
    }, deps)
    if (!eligibility.ok) {
      const reason = clean(eligibility.reason_code || eligibility.reason || 'eligibility_blocked')
      increment(summary.blocked_counts_by_reason, reason)
      if (reason.includes('SUPPRESSED') || reason.includes('OPT_OUT')) increment(summary.blocked_counts_by_reason, 'suppression_blocked', 0)
      if (summary.sample_blocks.length < 25) {
        summary.sample_blocks.push({
          reason,
          detail: eligibility.reason || null,
          master_owner_id: candidate.master_owner_id,
          property_id: candidate.property_id,
          market: candidate.market,
          state: candidate.state,
          identity_status: candidate.identity_alignment?.status || null,
        })
      }
      continue
    }
    if (phoneLayerMatched && outreachLayerCheck.ok) summary.layerCounts.outreachEligible += 1

    const routing = await chooseTextgridNumber(candidate, effectiveOptions, deps)
    if (!routing.ok) {
      increment(summary.blocked_counts_by_reason, routing.reason_code || routing.routing_block_reason || 'routing_blocked')
      increment(summary.distribution_counts.routingTiers, routing.routing_tier || 'blocked')
      if (summary.sample_blocks.length < 25) {
        summary.sample_blocks.push({
          reason: routing.routing_block_reason || routing.reason_code || 'routing_blocked',
          master_owner_id: candidate.master_owner_id,
          property_id: candidate.property_id,
          market: candidate.market,
          state: candidate.state,
        })
      }
      continue
    }

    const senderFilterCheck = candidateMatchesCatalogFilters(candidate, effectiveOptions.catalog_filters.sender_filters, { routing })
    if (!senderFilterCheck.ok) {
      increment(summary.blocked_counts_by_reason, senderFilterCheck.reasons[0] || 'filter_sender_coverage')
      if (summary.sample_blocks.length < 25) {
        summary.sample_blocks.push({
          reason: senderFilterCheck.reasons[0] || 'filter_sender_coverage',
          reasons: senderFilterCheck.reasons,
          master_owner_id: candidate.master_owner_id,
          property_id: candidate.property_id,
          market: candidate.market,
          state: candidate.state,
        })
      }
      continue
    }
    summary.layerCounts.senderCoverageEligible += 1
    increment(summary.distribution_counts.routingTiers, routing.routing_tier || 'unknown')

    const rendered = await renderOutboundTemplate(candidate, effectiveOptions, deps)
    if (!rendered.ok) {
      increment(summary.blocked_counts_by_reason, rendered.reason_code || rendered.reason || 'template_blocked')
      summary.template_readiness_counts.blocked += 1
      if (rendered.reason_code === 'NO_TEMPLATE') summary.template_readiness_counts.missing += 1
      else summary.template_readiness_counts.render_failed += 1
      if (summary.sample_blocks.length < 25) {
        summary.sample_blocks.push({
          reason: rendered.reason || rendered.reason_code || 'template_blocked',
          master_owner_id: candidate.master_owner_id,
          property_id: candidate.property_id,
          template_routing_reason: rendered.template_routing_reason || null,
        })
      }
      continue
    }

    seenPhones.add(candidate.canonical_e164)
    seenOwners.add(candidate.master_owner_id)
    summary.clean_targets += 1
    summary.ready_to_queue += 1
    summary.template_readiness_counts.ready += 1
    increment(summary.sender_coverage_counts, routing.selected_textgrid_market || routing.selected?.market || 'unknown')
    increment(summary.sender_number_counts, routing.selected_textgrid_number || routing.selected?.phone_number || 'unknown')
    increment(summary.routing_tier_counts, routing.routing_tier || 'unknown')
    increment(summary.template_id_counts, rendered.selected_template_id || rendered.template?.template_id || rendered.template?.id || 'unknown')

    const targetRow = buildTargetSnapshot(input.campaign || null, candidate, routing, rendered, index)
    if (summary.target_rows.length < effectiveOptions.target_limit) summary.target_rows.push(targetRow)
    if (summary.sample_targets.length < 25) {
      summary.sample_targets.push(buildNestedSampleTarget(candidate, targetRow, routing, rendered, index))
    }
    index += 1
  }

  const blocked = summary.blocked_counts_by_reason
  const blockedSummary = buildBlockedSummary(blocked)
  // Pass options.catalog_filters (original, pre candidate-source-column resolution) so
  // properties-domain columns that exist in public.properties but not in the candidate
  // view (e.g. tax_delinquent, active_lien) are correctly applied to the reach count.
  const fullReach = await fullReachPromise
  if (fullReach.warnings?.length) warnings.push(...fullReach.warnings)
  const totalReachMatched = fullReach.ok ? fullReach.count : summary.filter_matched
  const candidateWindowCleanTargets = Math.max(
    0,
    summary.filter_matched -
      blockedSummary.suppressed -
      blockedSummary.dnc -
      blockedSummary.wrongNumber -
      blockedSummary.noPhone -
      blockedSummary.identityHold
  )
  const fullSourceCleanTargets = compactNumber(fullReach.clean_targets_count)
  const cleanTargetCount = fullSourceCleanTargets ?? candidateWindowCleanTargets
  const cleanTargetsSource = fullSourceCleanTargets !== null ? 'full_source_graph' : 'candidate_window'
  const fullSourceReadyToQueue = compactNumber(fullReach.ready_to_queue_count)
  const readyToQueueCount = fullSourceReadyToQueue ?? summary.ready_to_queue
  const dailyCap = asPositiveInteger(input.daily_cap ?? input.campaign?.daily_cap ?? effectiveOptions.filters.daily_cap, null)
  const queueableToday = dailyCap ? Math.min(readyToQueueCount, dailyCap) : readyToQueueCount
  const candidateWindowQueueableToday = dailyCap ? Math.min(summary.ready_to_queue, dailyCap) : summary.ready_to_queue
  const score = readinessScore({ matched: totalReachMatched, ready: readyToQueueCount, blockers: blocked })
  const explicitBlockedWaterfall = buildExplicitBlockedWaterfall(blocked)
  const eligibilityWaterfall = buildEligibilityWaterfall({
    totalReachMatched,
    fullReach,
    summary,
    blocked,
    cleanTargetCount,
    cleanTargetsSource,
    candidateWindowCleanTargets,
    queueableToday,
    effectiveOptions,
  })
  const distributions = {
    markets: bucketArray(summary.distribution_counts.markets),
    languages: bucketArray(summary.distribution_counts.languages),
    propertyTypes: bucketArray(summary.distribution_counts.propertyTypes),
    matchingFlags: bucketArray(summary.distribution_counts.matchingFlags),
    routingTiers: bucketArray(summary.distribution_counts.routingTiers),
  }
  const diagnostics = buildPreviewDiagnostics({
    options: effectiveOptions,
    source,
    sourceAttempts,
    catalogFilters: effectiveCatalogFilters,
    sourceColumns,
    warnings,
    queryMs: Date.now() - startedAt,
  })

  return withPreviewDiagnostics({
    ...summary,
    reach: {
      totalMatched: totalReachMatched,
      cleanTargets: cleanTargetCount,
      readyToQueue: readyToQueueCount,
      queueableToday,
    },
    blocked: blockedSummary,
    distributions,
    sampleTargets: summary.sample_targets,
    appliedFilters: effectiveCatalogFilters.applied,
    frontend_payload_domain_counts: effectiveOptions.frontend_payload_domain_counts || {},
    backend_received_domain_counts: effectiveOptions.catalog_filters.received_domain_counts || emptyDomainCounts(),
    backend_applied_domain_counts: effectiveOptions.catalog_filters.applied_domain_counts || emptyDomainCounts(),
    dropped_filter_count: Number(effectiveOptions.catalog_filters.dropped_filter_count || 0),
    dropped_filters: (effectiveOptions.catalog_filters.dropped || []).map(publicFilter),
    graph_join_key_report: fullReach.graph_join_key_report || {},
    graph_source_coverage: fullReach.graph_source_coverage || {},
    warnings,
    queryMs: Date.now() - startedAt,
    readiness_score: score,
    total_matched_properties: totalReachMatched,
    total_matched: totalReachMatched,
    candidate_window_matched: summary.filter_matched,
    full_reach_count: fullReach.ok ? fullReach.count : null,
    full_reach_count_source: fullReach.countSource || null,
    full_reach_join_strategy: fullReach.joinStrategy || null,
    full_reach_owner_filter_count: fullReach.ownerFilterCount ?? null,
    queue_eligibility_scope: 'full_source_reach',
    queue_eligibility_note: 'Matched, linkage, clean target, sender coverage, ready, and queueable counts come from the full source graph; candidate_window is retained only for samples and blocker diagnostics.',
    current_contact_window_blocks_preview: effectiveOptions.within_contact_window_now,
    clean_targets: cleanTargetCount,
    clean_targets_source: cleanTargetsSource,
    candidate_window_clean_targets: candidateWindowCleanTargets,
    queueable_today: queueableToday,
    ready_to_queue: readyToQueueCount,
    ready_to_queue_source: fullSourceReadyToQueue !== null ? 'full_source_graph' : 'candidate_window',
    queueable_today_source: fullSourceReadyToQueue !== null ? 'full_source_graph' : 'candidate_window',
    total_matching_properties: totalReachMatched,
    owners_matched: totalReachMatched,
    phones_matched: totalReachMatched,
    linked_prospects: fullReach.linked_prospects_count ?? null,
    linked_master_owners: fullReach.linked_master_owners_count ?? null,
    linked_phones: fullReach.linked_phones_count ?? null,
    sms_eligible_phones: fullReach.sms_eligible_phones_count ?? null,
    sender_covered: fullReach.sender_covered_count ?? null,
    property_best_phone_count: fullReach.property_best_phone_count ?? null,
    property_sms_eligible_count: fullReach.property_sms_eligible_count ?? null,
    suppressed_count: blockedSummary.suppressed,
    opt_out_count: blockedSummary.dnc,
    wrong_number_count: blockedSummary.wrongNumber,
    blacklist_pair_count: Number(blocked.blacklist_pair || 0),
    not_interested_count: Number(blocked.not_interested || 0),
    duplicate_phone_count: Number(blocked.duplicate_phone || 0),
    duplicate_owner_count: Number(blocked.duplicate_owner || 0),
    active_queue_duplicate_count: blockedSummary.duplicateQueue,
    missing_property_count: Number(blocked.NO_PROPERTY || 0) + Number(blocked.filter_linked_property || 0),
    missing_phone_count: blockedSummary.noPhone,
    missing_sender_route_count: blockedSummary.noSenderCoverage,
    missing_template_count: blockedSummary.noTemplate,
    clean_ready_targets: readyToQueueCount,
    blocked_waterfall: buildBlockedWaterfall(blocked),
    blocked_reason_waterfall: explicitBlockedWaterfall,
    eligibility_waterfall: eligibilityWaterfall,
    candidate_window: {
      scanned: summary.total_scanned,
      matched: summary.filter_matched,
      clean_targets: candidateWindowCleanTargets,
      ready_to_queue: summary.ready_to_queue,
      queueable_today: candidateWindowQueueableToday,
      blocked_counts_by_reason: blocked,
      blocked_waterfall: buildBlockedWaterfall(blocked),
      explicit_blocked_waterfall: explicitBlockedWaterfall,
    },
    full_source_reach: {
      matched_properties: totalReachMatched,
      count_source: fullReach.countSource || null,
      graph_source: fullReach.graphSource || null,
      join_strategy: fullReach.joinStrategy || null,
      graph_join_key_report: fullReach.graph_join_key_report || {},
      graph_source_coverage: fullReach.graph_source_coverage || {},
      linked_master_owners: fullReach.linked_master_owners_count ?? null,
      linked_prospects: fullReach.linked_prospects_count ?? null,
      linked_phones: fullReach.linked_phones_count ?? null,
      sms_eligible_phones: fullReach.sms_eligible_phones_count ?? null,
      clean_targets: fullReach.clean_targets_count ?? null,
      sender_covered: fullReach.sender_covered_count ?? null,
      ready_to_queue: fullReach.ready_to_queue_count ?? null,
      queueable_today: queueableToday,
      property_best_phone_count: fullReach.property_best_phone_count ?? null,
      property_sms_eligible_count: fullReach.property_sms_eligible_count ?? null,
    },
    unsupported_in_preview: effectiveCatalogFilters.unsupported.map((filter) => ({
      fieldKey: filter.field_key,
      label: filter.label,
      reason: 'unsupported_in_preview',
    })),
    blockers: Object.entries(blocked).filter(([, count]) => Number(count) > 0).map(([reason, count]) => `${reason}:${count}`),
    by_market: Object.entries(summary.sender_coverage_counts).map(([label, count]) => ({ label, count })),
    by_state: [],
    by_tag: [],
    by_owner_type: [],
    by_language: Object.entries(summary.language_counts).map(([label, count]) => ({ label, count })),
    distribution_groups: legacyDistributionArray(summary.distribution_counts),
  }, diagnostics, effectiveOptions.include_diagnostics)
}

async function fetchCampaignExecutionProof(supabase, campaignId, campaign = {}) {
  const campaignStatus = campaign?.status || 'draft'
  const [{ data: activeRows, error: activeError }, { data: proofRows, error: proofError }] = await Promise.all([
    supabase
      .from('send_queue')
      .select('id,queue_status,sms_eligible,routing_allowed,scheduled_for,metadata')
      .eq('campaign_id', campaignId)
      .in('queue_status', ACTIVE_QUEUE_STATUSES),
    supabase
      .from('send_queue')
      .select('id,queue_status,sms_eligible,routing_allowed,scheduled_for,metadata,created_at')
      .eq('campaign_id', campaignId)
      .filter('metadata->>launch_mode', 'eq', 'proof_hydration_no_send')
      .order('created_at', { ascending: false })
      .limit(50),
  ])
  if (activeError) throw activeError
  if (proofError) throw proofError

  let proofNoSendRows = 0
  let liveSendRows = 0
  let smsEligible = 0
  let routingAllowed = 0
  let queuedRows = 0
  let scheduledQueueRows = 0
  let nextScheduledProofRow = null
  let nextScheduledLiveRow = null

  for (const row of activeRows || []) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const noSend = asBoolean(metadata.no_send ?? metadata.proof_no_send, false)
    const proofHydration = clean(metadata.launch_mode) === 'proof_hydration_no_send' || noSend
    const status = clean(row.queue_status).toLowerCase()
    if (proofHydration) {
      proofNoSendRows += 1
      if (row.scheduled_for && (!nextScheduledProofRow || row.scheduled_for < nextScheduledProofRow)) {
        nextScheduledProofRow = row.scheduled_for
      }
    } else {
      liveSendRows += 1
      if (row.sms_eligible) smsEligible += 1
      if (row.routing_allowed) routingAllowed += 1
      if (status === 'queued') queuedRows += 1
      if (status === 'scheduled') {
        scheduledQueueRows += 1
        if (row.scheduled_for && (!nextScheduledLiveRow || row.scheduled_for < nextScheduledLiveRow)) {
          nextScheduledLiveRow = row.scheduled_for
        }
      }
    }
  }

  let hydratedRows = (activeRows || []).length
  const canonicalQueued = Number(campaign?.queued_count || 0)
  const canonicalSent = Number(campaign?.sent_count || 0)
  if (hydratedRows === 0 && normalizeCampaignStatus(campaignStatus) === 'active' && canonicalQueued > 0) {
    hydratedRows = canonicalQueued
  }

  if (proofNoSendRows === 0 && (proofRows || []).length > 0) {
    const latestBatchAt = proofRows[0]?.created_at || null
    const latestBatch = latestBatchAt
      ? (proofRows || []).filter((row) => row.created_at === latestBatchAt)
      : (proofRows || []).slice(0, 5)
    proofNoSendRows = latestBatch.length
    for (const row of latestBatch) {
      if (row.scheduled_for && (!nextScheduledProofRow || row.scheduled_for < nextScheduledProofRow)) {
        nextScheduledProofRow = row.scheduled_for
      }
    }
  }

  const proofMode =
    (proofNoSendRows > 0 && liveSendRows === 0) ||
    (
      normalizeCampaignStatus(campaignStatus) === 'active' &&
      !asBoolean(campaign?.auto_send_enabled, false) &&
      canonicalQueued > 0 &&
      canonicalSent === 0 &&
      liveSendRows === 0
    )

  if (proofMode && proofNoSendRows === 0 && canonicalQueued > 0) {
    proofNoSendRows = canonicalQueued
  }
  if (proofMode && hydratedRows < proofNoSendRows) {
    hydratedRows = proofNoSendRows
  }

  const transmissionEnabled =
    liveSendRows > 0 &&
    routingAllowed > 0 &&
    asBoolean(campaign?.auto_send_enabled, false)

  return {
    campaign_state: normalizeCampaignStatus(campaignStatus),
    hydrated_rows: hydratedRows,
    live_send_rows: liveSendRows,
    proof_no_send_rows: proofNoSendRows,
    queued_rows: queuedRows,
    scheduled_queue_rows: scheduledQueueRows,
    sms_eligible: smsEligible,
    routing_allowed: routingAllowed,
    transmission_enabled: transmissionEnabled,
    next_scheduled_proof_row: nextScheduledProofRow,
    next_scheduled_at: nextScheduledLiveRow || nextScheduledProofRow,
    no_messages_will_transmit: proofMode,
    proof_mode: proofMode,
  }
}

async function reloadCampaignRow(supabase, campaignId) {
  const { data, error } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
  if (error) throw error
  return data || null
}

async function cancelPendingCampaignQueueRows(supabase, campaignId) {
  const { data, error } = await supabase
    .from('send_queue')
    .update({ queue_status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('campaign_id', campaignId)
    .in('queue_status', ['queued', 'scheduled', 'ready', 'pending', 'approved', 'processing'])
    .select('id')
  if (error) throw error
  return data?.length || 0
}

function mapCampaignSummary(campaign = {}, targets = [], windows = [], countBucket = null, executionProof = null) {
  const status = clean(campaign.status || 'draft')
  const counts = countBucket?.statuses ? { ...countBucket.statuses } : {}
  const blockedByReason = countBucket?.blocked ? { ...countBucket.blocked } : {}
  if (!countBucket) {
    for (const target of targets) {
      increment(counts, target.target_status || 'unknown')
      if (target.block_reason) increment(blockedByReason, target.block_reason)
    }
  }
  const totalFromBucket = countBucket?.total
  const ready = Number(counts.ready || 0)
  const planned = Number(counts.planned || 0)
  const queued = Number(counts.queued || 0)
  const sent = Number(counts.sent || 0) + Number(counts.delivered || 0)
  const delivered = Number(counts.delivered || 0)
  const failedTarget = Number(counts.failed || 0)
  const proof = executionProof || {}
  const liveQueued = Number(proof.queued_rows ?? queued)
  const liveScheduled = Number(proof.scheduled_queue_rows ?? 0)
  const scopedFailed = Number(proof.failed_execution_rows ?? failedTarget)
  const failed = scopedFailed
  const nextWindow = windows
    .filter((window) => ['planned', 'open'].includes(clean(window.status)))
    .sort((left, right) => new Date(left.window_start_utc).getTime() - new Date(right.window_start_utc).getTime())[0] || null
  return {
    id: campaign.id,
    campaign_name: campaign.name,
    name: campaign.name,
    description: campaign.description,
    status,
    objective: campaign.objective,
    daily_cap: campaign.daily_cap,
    total_cap: campaign.total_cap,
    batch_max: campaign.batch_max,
    market_cap: campaign.market_cap,
    per_sender_cap: campaign.per_sender_cap,
    total_targets: totalFromBucket ?? targets.length,
    ready_targets: ready,
    planned_targets: planned,
    scheduled_targets: liveScheduled,
    scheduled_queue_rows: liveScheduled,
    queued_targets: liveQueued,
    canonical_queued_count: liveQueued + liveScheduled,
    sent_count: sent,
    delivered_count: delivered,
    failed_count: failed,
    failed_target_rows: failedTarget,
    failed_execution_rows: scopedFailed,
    reply_count: Number(counts.replied || 0) + Number(counts.replied_positive || 0) + Number(counts.replied_negative || 0),
    positive_reply_count: Number(counts.replied_positive || 0),
    negative_reply_count: Number(counts.replied_negative || 0),
    opt_out_count: Number(counts.opt_out || 0),
    delivery_rate: sent > 0 ? Math.round((delivered / sent) * 1000) / 10 : 0,
    reply_rate: sent > 0 ? Math.round((Number(counts.replied || 0) / sent) * 1000) / 10 : 0,
    positive_rate: sent > 0 ? Math.round((Number(counts.replied_positive || 0) / sent) * 1000) / 10 : 0,
    opt_out_rate: sent > 0 ? Math.round((Number(counts.opt_out || 0) / sent) * 1000) / 10 : 0,
    failure_rate: sent > 0 ? Math.round((failed / sent) * 1000) / 10 : 0,
    next_send_at: proof.next_scheduled_at || nextWindow?.window_start_utc || campaign.scheduled_for || null,
    next_send_window: nextWindow,
    last_send_at: null,
    send_interval_seconds: campaign.send_interval_seconds || 0,
    send_window_start: campaign.contact_window_start,
    send_window_end: campaign.contact_window_end,
    auto_queue_enabled: Boolean(campaign.auto_queue_enabled),
    auto_send_enabled: Boolean(campaign.auto_send_enabled),
    auto_reply_mode: campaign.auto_reply_mode,
    health_score: ready > 0 ? 90 : targets.length > 0 ? 70 : 40,
    health_status: ready > 0 ? 'healthy' : targets.length > 0 ? 'caution' : 'dangerous',
    blocked_reason_counts: blockedByReason,
    execution_proof: executionProof || null,
  }
}

async function fetchExecutionProofByCampaign(supabase, campaigns = []) {
  const proofByCampaign = new Map()
  const campaignIds = (campaigns || []).map((campaign) => campaign.id).filter(Boolean)
  if (!campaignIds.length) return proofByCampaign

  for (const campaign of campaigns) {
    proofByCampaign.set(campaign.id, await fetchCampaignExecutionProof(supabase, campaign.id, campaign))
  }
  return proofByCampaign
}

export async function listCampaigns(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  const ids = (campaigns || []).map((campaign) => campaign.id)
  let windows = []
  let countMap = new Map()
  let proofByCampaign = new Map()
  if (ids.length) {
    const { fetchCampaignTargetStatusCounts } = await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')
    countMap = await fetchCampaignTargetStatusCounts(ids, deps)
    proofByCampaign = await fetchExecutionProofByCampaign(supabase, campaigns || [])
    const windowRes = await supabase
      .from('campaign_send_windows')
      .select('*')
      .in('campaign_id', ids)
      .order('window_start_utc', { ascending: true })
      .limit(1000)
    if (!windowRes.error) windows = windowRes.data || []
  }
  const { deriveOperatorState, operatorStateLabel, operatorModeLabel } = await import('@/lib/domain/campaigns/campaign-operator-state.js')
  const summaries = (campaigns || []).map((campaign) => {
    const proofBase = proofByCampaign.get(campaign.id) || null
    const executionProof = proofBase
      ? { campaign_state: normalizeCampaignStatus(campaign.status), ...proofBase }
      : null
    const summary = mapCampaignSummary(
      campaign,
      [],
      windows.filter((window) => window.campaign_id === campaign.id),
      countMap.get(campaign.id) || null,
      executionProof,
    )
    const operatorState = deriveOperatorState(campaign, executionProof || {}, {})
    summary.operator_state = operatorState
    summary.operator_state_label = operatorStateLabel(operatorState)
    summary.mode = operatorModeLabel(executionProof || {})
    summary.mode_label = summary.mode === 'live' ? 'Live' : 'Test Mode'
    if (executionProof?.proof_mode && operatorState === 'test_mode') {
      summary.status = summary.status === 'active' ? summary.status : summary.status
    }
    return summary
  })

  let activeCampaigns = 0
  let totalSent = 0
  let totalFailed = 0
  let totalOptOut = 0
  let totalReplied = 0
  let deliveredTotal = 0
  for (const campaign of summaries) {
    const status = normalizeCampaignStatus(campaign.status)
    const operator = campaign.operator_state
    if (
      isLiveCampaignStatus(status) ||
      status === 'scheduled' ||
      (status === 'paused' && campaign.ready_targets > 0) ||
      operator === 'test_mode' ||
      operator === 'live'
    ) {
      activeCampaigns += 1
    }
    totalSent += Number(campaign.sent_count || 0)
    totalFailed += Number(campaign.failed_count || 0)
    totalOptOut += Number(campaign.opt_out_count || 0)
    totalReplied += Number(campaign.reply_count || 0)
    deliveredTotal += Number(campaign.delivered_count || 0)
  }

  return {
    ok: true,
    campaigns: summaries,
    kpis: {
      activeCampaigns,
      totalTargets: summaries.reduce((sum, campaign) => sum + campaign.total_targets, 0),
      readyTargets: summaries.reduce((sum, campaign) => sum + campaign.ready_targets, 0),
      scheduledQueueRows: summaries.reduce((sum, campaign) => sum + Number(campaign.scheduled_queue_rows || 0), 0),
      plannedTargets: summaries.reduce((sum, campaign) => sum + Number(campaign.planned_targets || 0), 0),
      sentToday: summaries.reduce((sum, campaign) => sum + Number(campaign.sent_count || 0), 0),
      deliveredToday: deliveredTotal,
      replyRate: deliveredTotal > 0 ? Math.round((totalReplied / deliveredTotal) * 1000) / 10 : 0,
      positiveReplies: summaries.reduce((sum, campaign) => sum + campaign.positive_reply_count, 0),
      optOutRate: totalSent > 0 ? Math.round((totalOptOut / totalSent) * 1000) / 10 : 0,
      failureRate: totalSent > 0 ? Math.round((totalFailed / totalSent) * 1000) / 10 : 0,
    },
  }
}

export async function createCampaign(payload = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (asBoolean(payload.auto_send_enabled, false)) {
    return { ok: false, status: 423, error: 'auto_send_live_disabled', message: 'Phase 1 does not enable live auto-send.' }
  }
  if (clean(payload.auto_reply_mode) && clean(payload.auto_reply_mode) !== 'disabled') {
    return { ok: false, status: 423, error: 'auto_reply_live_disabled', message: 'Phase 1 does not enable live auto-reply.' }
  }
  const row = normalizeCampaignInput(payload)
  const { data, error } = await supabase.from('campaigns').insert(row).select('*').single()
  if (error) throw error
  await replaceCampaignFilters(data.id, row.metadata?.target_filters || {}, deps)
  await recordCampaignEvent({
    campaign_id: data.id,
    event_type: 'campaign.created',
    severity: 'success',
    title: 'Campaign draft saved',
    metadata: { name: data.name, candidate_source: data.candidate_source },
  }, deps)
  return { ok: true, campaign: data, campaign_id: data.id }
}

export async function getCampaign(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: campaign, error } = await supabase.from('campaigns').select('*').eq('id', campaignId).single()
  if (error) throw error
  const { fetchCampaignTargetStatusCounts } = await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')
  const { computeCampaignRecipientMetrics } = await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')
  const { evaluateCampaignLaunchReadiness } = await import('@/lib/domain/campaigns/campaign-launch-readiness.js')
  const countMap = await fetchCampaignTargetStatusCounts([campaignId], deps)
  const [{ data: filters }, { data: windows }, { data: events }, recipientMetrics, launchReadiness] = await Promise.all([
    supabase.from('campaign_filters').select('*').eq('campaign_id', campaignId).order('created_at', { ascending: true }),
    supabase.from('campaign_send_windows').select('*').eq('campaign_id', campaignId).order('window_start_utc', { ascending: true }).limit(200),
    supabase.from('campaign_events').select('*').eq('campaign_id', campaignId).order('created_at', { ascending: false }).limit(100),
    computeCampaignRecipientMetrics(campaignId, deps),
    evaluateCampaignLaunchReadiness(campaignId, deps),
  ])
  const executionProof = await fetchCampaignExecutionProof(supabase, campaignId, campaign)
  const summary = mapCampaignSummary(campaign, [], windows || [], countMap.get(campaignId) || null, executionProof)
  summary.recipient_metrics = recipientMetrics.ok ? recipientMetrics : null
  summary.launch_readiness = launchReadiness.ok ? launchReadiness.launch_readiness : 'unknown'
  summary.launch_blockers = launchReadiness.blockers || []
  summary.launch_blocker_codes = launchReadiness.blocker_codes || []

  let commandSummary = null
  try {
    const { buildCampaignCommandSummary } = await import('@/lib/domain/campaigns/campaign-command-summary.js')
    commandSummary = await buildCampaignCommandSummary(campaignId, deps)
    if (commandSummary.ok) {
      summary.operator_state = commandSummary.state
      summary.operator_state_label = commandSummary.state_label
      summary.mode = commandSummary.mode
      summary.mode_label = commandSummary.mode_label
      const c = commandSummary.counts
      summary.total_targets = c.total_targets ?? summary.total_targets
      summary.ready_targets = c.ready_targets ?? summary.ready_targets
      summary.planned_targets = c.planned_targets ?? summary.planned_targets
      summary.scheduled_queue_rows = c.scheduled_queue_rows ?? summary.scheduled_queue_rows
      summary.scheduled_targets = c.scheduled_queue_rows ?? summary.scheduled_targets
      summary.queued_targets = c.queued_rows ?? summary.queued_targets
      summary.failed_count = (c.failed_target_rows ?? 0) + (c.failed_execution_rows ?? 0)
      summary.failed_target_rows = c.failed_target_rows ?? 0
      summary.failed_execution_rows = c.failed_execution_rows ?? 0
      summary.readiness_label = commandSummary.readiness_label
      summary.execution_proof = {
        ...executionProof,
        hydrated_rows: commandSummary.execution.hydrated_queue_rows,
        live_send_rows: commandSummary.execution.live_send_rows,
        proof_no_send_rows: commandSummary.execution.proof_no_send_rows,
        sms_eligible: commandSummary.execution.sms_eligible,
        routing_allowed: commandSummary.execution.routing_allowed,
        transmission_enabled: commandSummary.execution.transmission_enabled,
        proof_mode: commandSummary.execution.proof_mode,
        no_messages_will_transmit: commandSummary.execution.no_messages_will_transmit,
        scheduled_queue_rows: commandSummary.execution.scheduled_queue_rows,
      }
    }
  } catch (summaryError) {
    console.warn('campaign.command_summary_degraded', { campaignId, message: summaryError?.message })
  }

  return {
    ok: true,
    campaign,
    filters: filters || [],
    summary,
    command_summary: commandSummary?.ok ? commandSummary : null,
    recipient_metrics: recipientMetrics.ok ? recipientMetrics : null,
    launch_readiness: launchReadiness,
    targets: [],
    send_windows: windows || [],
    events: events || [],
  }
}

export async function updateCampaign(campaignId, payload = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (asBoolean(payload.auto_send_enabled, false)) {
    return { ok: false, status: 423, error: 'auto_send_live_disabled', message: 'Phase 1 does not enable live auto-send.' }
  }
  if (clean(payload.auto_reply_mode) && clean(payload.auto_reply_mode) !== 'disabled') {
    return { ok: false, status: 423, error: 'auto_reply_live_disabled', message: 'Phase 1 does not enable live auto-reply.' }
  }
  const current = await getCampaign(campaignId, deps)
  const patch = normalizeCampaignInput(payload, current.campaign)
  delete patch.created_at
  const { data, error } = await supabase.from('campaigns').update(patch).eq('id', campaignId).select('*').single()
  if (error) throw error
  if (payload.target_filters || payload.filters || payload.metadata?.target_filters) {
    await replaceCampaignFilters(campaignId, patch.metadata?.target_filters || {}, deps)
  }
  await recordCampaignEvent({
    campaign_id: campaignId,
    event_type: 'campaign.updated',
    severity: 'info',
    title: 'Campaign updated',
    metadata: { patch_keys: Object.keys(payload || {}) },
  }, deps)
  return { ok: true, campaign: data, campaign_id: data.id }
}

/**
 * Clone a campaign into a fresh DRAFT. Copies configuration + saved filters,
 * but never copies targets, queue rows, lifecycle timestamps, or live flags.
 */
export async function cloneCampaign(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const { data: source, error } = await supabase.from('campaigns').select('*').eq('id', campaignId).single()
  if (error) throw error
  if (!source) return { ok: false, error: 'campaign_not_found' }

  const {
    id: _id, created_at: _createdAt, updated_at: _updatedAt,
    last_transition_from: _ltf, last_transition_reason: _ltr, last_transition_at: _lta,
    built_at: _builtAt, queued_at: _queuedAt, scheduled_at: _scheduledAt, scheduled_for: _scheduledFor,
    activating_at: _activatingAt, activated_at: _activatedAt, paused_at: _pausedAt,
    completed_at: _completedAt, failed_at: _failedAt, failure_reason: _failureReason,
    archived_at: _archivedAt, emergency_stop_at: _emergencyStopAt,
    ...rest
  } = source

  const newRow = {
    ...rest,
    name: clean(input.name) || `${source.name} (copy)`,
    status: 'draft',
    auto_send_enabled: false,
    auto_queue_enabled: false,
  }
  const { data: created, error: insertError } = await supabase.from('campaigns').insert(newRow).select('*').single()
  if (insertError) throw insertError

  const { data: filters } = await supabase.from('campaign_filters').select('*').eq('campaign_id', campaignId)
  if (filters?.length) {
    const cloned = filters.map(({ id: _fid, campaign_id: _fcid, created_at: _fc, updated_at: _fu, ...filter }) => ({
      ...filter,
      campaign_id: created.id,
    }))
    await supabase.from('campaign_filters').insert(cloned)
  }

  await recordCampaignEvent({
    campaign_id: created.id,
    event_type: 'campaign.cloned',
    severity: 'info',
    title: 'Campaign cloned',
    description: `Cloned from "${source.name}".`,
    metadata: { source_campaign_id: campaignId },
  }, deps)
  return { ok: true, campaign: created, campaign_id: created.id, source_campaign_id: campaignId }
}

/**
 * Delete a campaign. Hard-deletes (purging targets/windows/filters/events) only
 * when no send_queue rows reference it. Otherwise cancels its active queue rows
 * and archives the campaign so historical sends are never destroyed.
 */
export async function deleteCampaign(campaignId, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const forceDelete = asBoolean(deps.force_delete ?? deps.forceDelete, false)
  const { data: campaign, error } = await supabase
    .from('campaigns').select('id,status,name,metadata,sent_count').eq('id', campaignId).maybeSingle()
  if (error) throw error
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const { isTestOrMockCampaign } = await import('@/lib/domain/campaigns/campaign-sync-metrics.js')
  const allowForcePurge = forceDelete || isTestOrMockCampaign(campaign)

  const { count: linkedCount } = await supabase
    .from('send_queue').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId)

  if ((linkedCount || 0) > 0 && !allowForcePurge) {
    const { data: cancelled } = await supabase
      .from('send_queue')
      .update({ queue_status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('campaign_id', campaignId)
      .in('queue_status', ['queued', 'scheduled', 'ready', 'pending', 'approved', 'processing'])
      .select('id')
    await transitionCampaignStatus(supabase, campaignId, 'archived', { reason: 'delete_requested_history_preserved' })
    await recordCampaignEvent({
      campaign_id: campaignId,
      event_type: 'campaign.archived',
      severity: 'warning',
      title: 'Campaign archived (delete requested; send history preserved)',
      metadata: { linked_queue_rows: linkedCount, queue_rows_cancelled: cancelled?.length || 0 },
    }, deps)
    return {
      ok: true, campaign_id: campaignId, deleted: false, archived: true,
      queue_rows_cancelled: cancelled?.length || 0, reason: 'send_history_preserved',
    }
  }

  if (allowForcePurge && (linkedCount || 0) > 0) {
    await supabase.from('send_queue').delete().eq('campaign_id', campaignId)
  }

  const { data: targets } = await supabase.from('campaign_targets').delete().eq('campaign_id', campaignId).select('id')
  const { data: windows } = await supabase.from('campaign_send_windows').delete().eq('campaign_id', campaignId).select('id')
  await supabase.from('campaign_filters').delete().eq('campaign_id', campaignId)
  await supabase.from('campaign_events').delete().eq('campaign_id', campaignId)
  await supabase.from('campaign_runs').delete().eq('campaign_id', campaignId)
  const { error: delError } = await supabase.from('campaigns').delete().eq('id', campaignId)
  if (delError) throw delError
  return {
    ok: true, campaign_id: campaignId, deleted: true, archived: false, force_purged: allowForcePurge,
    targets_removed: targets?.length || 0, windows_removed: windows?.length || 0,
    queue_rows_cancelled: allowForcePurge ? (linkedCount || 0) : 0,
  }
}

export async function buildCampaignTargets(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const detail = await getCampaign(campaignId, deps)
  const campaign = detail.campaign
  const run = await startCampaignRun(campaignId, {
    run_type: 'build_targets',
    dry_run: false,
    metadata: { input },
  }, deps)
  try {
    const requestedLimit = asPositiveInteger(
      input.limit || campaign.total_cap || campaign.batch_max || CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT,
      CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT
    )
    const targetLimit = Math.max(1, Math.min(requestedLimit || CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT, CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT))
    const options = previewOptionsFromInput({
      ...input,
      campaign,
      target_filters: campaign.metadata?.target_filters || {},
      limit: targetLimit,
    }, campaign)
    options.target_limit = targetLimit

    const graph = await summarizeCampaignGraph({
      supabase,
      options,
      rowLimit: targetLimit,
      requireQueueEligibleRows: true,
    })
    if (graph.ok === false) {
      await finishCampaignRun(run.id, {
        status: 'completed',
        total_scanned: 0,
        targets_clean: 0,
        ready_to_queue: 0,
        blocked_counts: {},
        metadata: {
          graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
          graph_unavailable: true,
          graph_warnings: graph.warnings || [],
        },
      }, deps)
      await recordCampaignEvent({
        campaign_id: campaignId,
        run_id: run.id,
        event_type: 'campaign.targets_build_skipped',
        severity: 'warning',
        title: 'Campaign target graph unavailable',
        description: 'Target snapshots were not rebuilt because campaign_target_graph is unavailable. No send_queue rows created.',
        metadata: {
          graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
          warnings: graph.warnings || [],
        },
      }, deps)
      return {
        ok: true,
        success: true,
        graph_unavailable: true,
        campaign_id: campaignId,
        built_count: 0,
        no_send_queue_rows_created: true,
        preview: {
          total_scanned: 0,
          clean_targets: 0,
          ready_to_queue: 0,
          blocked_counts_by_reason: {},
          readiness_score: 0,
          graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
          warnings: graph.warnings || [],
        },
      }
    }

    await supabase.from('campaign_targets').delete().eq('campaign_id', campaignId)
    const { collapseGraphRowsToRecipients } = await import('@/lib/domain/campaigns/campaign-recipient-dedup.js')
    const touchNumber = asPositiveInteger(options.stage_touch ?? options.touch_number ?? campaign.metadata?.stage_touch, 1) || 1
    const eligibleRows = (graph.rows || []).filter((row) => row.queue_eligible)
    const { recipients, stats: dedupStats } = collapseGraphRowsToRecipients(eligibleRows, { touch_number: touchNumber })
    const rows = recipients
      .slice(0, targetLimit)
      .map((row, index) => {
        const snapshot = buildTargetSnapshotFromGraphRow(campaign, row, index, options)
        return {
          ...snapshot,
          campaign_id: campaignId,
          campaign_name: campaign.name,
          source_view_name: CAMPAIGN_TARGET_GRAPH_TABLE,
          daily_cap: campaign.daily_cap,
          touch_number: row.touch_number || touchNumber,
          matched_property_count: row.matched_property_count || 1,
          portfolio_property_ids: row.portfolio_property_ids || [],
          primary_property_id: row.primary_property_id || row.property_id || null,
          recipient_dedup_key: row.recipient_dedup_key || null,
          property_id: row.primary_property_id || snapshot.property_id,
          metadata: {
            ...metadataObject(snapshot.metadata),
            recipient_dedup: {
              matched_property_count: row.matched_property_count || 1,
              portfolio_property_ids: row.portfolio_property_ids || [],
              primary_property_id: row.primary_property_id || null,
              ambiguous_phone_ownership: Boolean(row.ambiguous_phone_ownership),
            },
            dedup_stats: index === 0 ? dedupStats : undefined,
          },
        }
      })

    let inserted = 0
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const { error } = await supabase.from('campaign_targets').insert(chunk)
      if (error) throw error
      inserted += chunk.length
    }

    // Build Targets drives the campaign into the canonical BUILT state (via the
    // concurrency-safe state machine). Only from pre-queue states — re-building an
    // already live/active campaign must not yank it back. normalizeCampaignStatus
    // folds legacy 'ready'/'previewed' onto 'built'.
    if (inserted > 0) {
      const fromStatus = normalizeCampaignStatus(campaign.status)
      if (['draft', 'built', 'queued'].includes(fromStatus)) {
        await transitionCampaignStatus(supabase, campaignId, 'built', { reason: 'build_targets' })
      }
    }
    await finishCampaignRun(run.id, {
      status: 'completed',
      total_scanned: graph.totalMatched,
      targets_clean: graph.cleanTargets,
      ready_to_queue: graph.readyToQueue,
      blocked_counts: graph.blockedCounts,
      metadata: {
        readiness_score: readinessScore({ matched: graph.totalMatched, ready: graph.readyToQueue, blockers: graph.blockedCounts }),
        graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
        graph_warnings: graph.warnings || [],
      },
    }, deps)
    await recordCampaignEvent({
      campaign_id: campaignId,
      run_id: run.id,
      event_type: 'campaign.targets_built',
      severity: 'success',
      title: 'Campaign targets built',
      description: `${inserted} target snapshots written. No send_queue rows created.`,
      metadata: {
        inserted,
        readiness_score: readinessScore({ matched: graph.totalMatched, ready: graph.readyToQueue, blockers: graph.blockedCounts }),
        graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
      },
    }, deps)
    return {
      ok: true,
      success: true,
      campaign_id: campaignId,
      built_count: inserted,
      no_send_queue_rows_created: true,
      preview: {
        total_scanned: graph.totalMatched,
        clean_targets: graph.cleanTargets,
        ready_to_queue: graph.readyToQueue,
        blocked_counts_by_reason: graph.blockedCounts,
        readiness_score: readinessScore({ matched: graph.totalMatched, ready: graph.readyToQueue, blockers: graph.blockedCounts }),
        graph_source: CAMPAIGN_TARGET_GRAPH_TABLE,
      },
    }
  } catch (error) {
    await finishCampaignRun(run.id, { status: 'failed', metadata: { error: error?.message || String(error) } }, deps)
    throw error
  }
}

function parseTimeMinutes(value, fallback) {
  const text = clean(value)
  const matched = text.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)?$/i)
  if (!matched) return fallback
  let hours = Number(matched[1])
  const minutes = Number(matched[2] || 0)
  const period = clean(matched[3]).toUpperCase()
  if (period === 'AM' && hours === 12) hours = 0
  if (period === 'PM' && hours !== 12) hours += 12
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback
  return hours * 60 + minutes
}

function getLocalParts(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const value = (type) => Number(parts.find((part) => part.type === type)?.value)
    const result = {
      year: value('year'),
      month: value('month'),
      day: value('day'),
      hour: value('hour'),
      minute: value('minute'),
      second: value('second'),
    }
    return Object.values(result).every(Number.isFinite) ? result : null
  } catch {
    return null
  }
}

function timezoneOffsetMs(date, timezone) {
  const parts = getLocalParts(date, timezone)
  if (!parts) return 0
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return localAsUtc - date.getTime()
}

function localPartsToUtc(parts, timezone) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)
  for (let i = 0; i < 3; i += 1) {
    const offset = timezoneOffsetMs(new Date(guess), timezone)
    const next = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0) - offset
    if (Math.abs(next - guess) < 1000) return next
    guess = next
  }
  return guess
}

function computeWindowForTimezone(timezone, campaign, now = new Date()) {
  const startMinutes = parseTimeMinutes(campaign.contact_window_start, 9 * 60)
  const endMinutes = parseTimeMinutes(campaign.contact_window_end, 20 * 60)
  const localNow = getLocalParts(now, timezone) || getLocalParts(now, 'America/Chicago')
  const currentMinutes = localNow.hour * 60 + localNow.minute
  let dayOffset = currentMinutes >= endMinutes ? 1 : 0

  const buildWindow = (offset) => {
    const startUtc = localPartsToUtc({
      year: localNow.year,
      month: localNow.month,
      day: localNow.day + offset,
      hour: Math.floor(startMinutes / 60),
      minute: startMinutes % 60,
      second: 0,
    }, timezone)
    const rawEndUtc = localPartsToUtc({
      year: localNow.year,
      month: localNow.month,
      day: localNow.day + offset,
      hour: Math.floor(endMinutes / 60),
      minute: endMinutes % 60,
      second: 0,
    }, timezone)
    return {
      startUtc,
      endUtc: rawEndUtc <= startUtc ? rawEndUtc + 24 * 60 * 60 * 1000 : rawEndUtc,
    }
  }

  let window = buildWindow(dayOffset)
  let start = Math.max(window.startUtc, now.getTime() + 10 * 60 * 1000)
  if (start >= window.endUtc) {
    dayOffset += 1
    window = buildWindow(dayOffset)
    start = window.startUtc
  }
  return {
    window_start_utc: new Date(start).toISOString(),
    window_end_utc: new Date(window.endUtc).toISOString(),
  }
}

function campaignCaps(campaign = {}) {
  return {
    daily_cap: asPositiveInteger(campaign.daily_cap, null),
    total_cap: asPositiveInteger(campaign.total_cap, null),
    batch_max: asPositiveInteger(campaign.batch_max, null),
    market_cap: asPositiveInteger(campaign.market_cap, null),
    per_sender_cap: asPositiveInteger(campaign.per_sender_cap, null),
  }
}

function missingCaps(campaign = {}) {
  return Object.entries(campaignCaps(campaign))
    .filter(([, value]) => !value)
    .map(([key]) => key)
}

async function globalEmergencyStopActive(deps = {}) {
  const value = await getSystemValue('queue_emergency_stop_at', deps)
  return isEmergencyStopActive(value)
}

function groupTargetsByWindow(targets = []) {
  const groups = new Map()
  for (const target of targets) {
    const key = [
      clean(target.timezone || 'America/Chicago'),
      clean(target.market || 'unknown'),
      clean(target.state || 'unknown'),
    ].join('|')
    if (!groups.has(key)) {
      groups.set(key, {
        timezone: clean(target.timezone || 'America/Chicago') || 'America/Chicago',
        market: clean(target.market) || null,
        state: clean(target.state) || null,
        targets: [],
      })
    }
    groups.get(key).targets.push(target)
  }
  return [...groups.values()]
}

function minPositive(values = [], fallback = null) {
  const positive = values
    .map((value) => asPositiveInteger(value, null))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (!positive.length) return fallback
  return Math.min(...positive)
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const resolved = clean(value)
    if (resolved) return resolved
  }
  return null
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function localScheduleSnapshot(date, timezone) {
  const parts = getLocalParts(date, timezone) || getLocalParts(date, 'America/Chicago')
  if (!parts) {
    return {
      local_send_date: null,
      local_send_hour: null,
      scheduled_for_local: date.toISOString(),
    }
  }
  return {
    local_send_date: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
    local_send_hour: parts.hour,
    scheduled_for_local: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)} ${timezone || 'America/Chicago'}`,
  }
}

function distributionFromCounts(counts = {}) {
  return Object.entries(counts)
    .map(([value, count]) => ({ value, label: value, count: Number(count || 0) }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

function resolveLaunchCaps(campaign = {}, input = {}, readyTargetCount = 0) {
  const batchMax = asPositiveInteger(input.batch_max ?? input.batchMax ?? campaign.batch_max, null)
  const maxTargets = asPositiveInteger(
    input.max_targets ?? input.maxTargets ?? input.limit ?? input.target_limit ?? batchMax,
    null
  )
  const capFallback = batchMax || maxTargets || 500
  const dailyCap = asPositiveInteger(input.daily_cap ?? input.dailyCap ?? campaign.daily_cap, capFallback)
  const perSenderCap = asPositiveInteger(input.per_sender_cap ?? input.perSenderCap ?? campaign.per_sender_cap, capFallback)
  const perMarketCap = asPositiveInteger(
    input.per_market_cap ?? input.perMarketCap ?? input.market_cap ?? campaign.market_cap,
    capFallback
  )
  const totalCap = asPositiveInteger(input.total_cap ?? input.totalCap ?? campaign.total_cap, null)
  const requestedMax = maxTargets || batchMax || dailyCap || readyTargetCount
  const effectiveLimit = Math.max(0, Math.min(
    readyTargetCount,
    minPositive([requestedMax, dailyCap, batchMax, totalCap], readyTargetCount)
  ))
  return {
    max_targets: maxTargets || effectiveLimit || capFallback,
    daily_cap: dailyCap,
    per_sender_cap: perSenderCap,
    per_market_cap: perMarketCap,
    batch_max: batchMax || capFallback,
    total_cap: totalCap,
    effective_limit: effectiveLimit || capFallback,
  }
}

function missingLaunchCaps(caps = {}) {
  const missing = []
  if (!caps.max_targets && !caps.effective_limit) missing.push('max_targets')
  if (!caps.daily_cap) missing.push('daily_cap')
  if (!caps.per_sender_cap) missing.push('per_sender_cap')
  if (!caps.per_market_cap) missing.push('per_market_cap')
  return missing
}

export function launchCandidateFromTarget(target = {}, campaign = {}) {
  const metadata = metadataObject(target.metadata)
  const snapshot = metadataObject(metadata.candidate_snapshot)
  const outreach = metadataObject(metadata.outreach_snapshot)
  const phone = firstNonEmpty(target.to_phone_number, snapshot.to_phone_number, snapshot.canonical_e164)
  const prospectId = firstNonEmpty(target.prospect_id, metadata.prospect_id, snapshot.prospect_id, snapshot.canonical_prospect_id)
  const phoneId = firstNonEmpty(target.phone_id, snapshot.phone_id, snapshot.best_phone_id)
  const market = firstNonEmpty(target.market, snapshot.market, campaign.market)
  const state = normalizeState(firstNonEmpty(target.state, snapshot.state, campaign.state))
  // Campaign queue eligibility (createCampaignQueuePlan) fails closed on a
  // missing/invalid timezone rather than silently defaulting — see
  // timezone_eligibility_reason below. `timezone`/`source_timezone`
  // themselves keep their existing fallback-to-America/Chicago behavior so
  // non-queue callers of this function (e.g. evaluateCampaignLaunchReadiness's
  // template-preview sampling) are unaffected.
  const rawTimezone = firstNonEmpty(target.timezone, snapshot.timezone)
  const timezoneEligibilityReason = !rawTimezone
    ? 'missing_timezone'
    : !isValidIanaTimezone(rawTimezone)
      ? 'invalid_timezone'
      : null
  const sourceTimezone = rawTimezone || 'America/Chicago'
  const timezone = resolveTimezone(sourceTimezone)
  const sellerName = firstNonEmpty(
    snapshot.seller_full_name,
    target.owner_name,
    snapshot.owner_name,
    metadata.owner_name
  )
  const languageRaw = firstNonEmpty(target.language, snapshot.language, campaign.language_policy, 'English')
  const languageResolved = resolveLanguage(languageRaw)
  const canonicalLanguage = languageResolved.canonical || languageRaw || 'English'
  const stageCode = normalizeCampaignStageCode(campaign.metadata?.stage_code, 'S1')
  const propertyType = firstNonEmpty(snapshot.property_type, target.asset_type)
  return {
    master_owner_id: firstNonEmpty(target.master_owner_id, snapshot.master_owner_id),
    prospect_id: prospectId,
    canonical_prospect_id: firstNonEmpty(snapshot.canonical_prospect_id, prospectId),
    property_id: firstNonEmpty(target.property_id, snapshot.property_id),
    best_phone_id: phoneId,
    phone_id: phoneId,
    canonical_e164: phone,
    to_phone_number: phone,
    market,
    state,
    timezone,
    source_timezone: sourceTimezone,
    timezone_eligibility_reason: timezoneEligibilityReason,
    contact_window: firstNonEmpty(snapshot.contact_window, target.contact_window),
    language: canonicalLanguage,
    best_language: canonicalLanguage,
    stage_code: stageCode,
    template_use_case: firstNonEmpty(metadata.template_use_case, campaign.metadata?.template_use_case, campaign.objective, 'ownership_check'),
    template_lookup_use_case: firstNonEmpty(metadata.template_use_case, campaign.metadata?.template_use_case, campaign.objective, 'ownership_check'),
    touch_number: asPositiveInteger(metadata.touch_number ?? snapshot.current_touch_number, 1),
    owner_display_name: sellerName,
    seller_full_name: sellerName,
    seller_first_name: firstNonEmpty(snapshot.seller_first_name),
    owner_first_name: firstNonEmpty(snapshot.seller_first_name),
    property_address: firstNonEmpty(target.property_address, snapshot.property_address_full),
    property_address_full: firstNonEmpty(target.property_address, snapshot.property_address_full),
    property_city: firstNonEmpty(snapshot.property_city),
    property_zip: firstNonEmpty(snapshot.property_zip),
    property_type: firstNonEmpty(snapshot.property_type, target.asset_type),
    property_class: firstNonEmpty(snapshot.property_class),
    canonical_property_group: firstNonEmpty(snapshot.canonical_property_group, target.asset_type),
    final_acquisition_score: target.priority_score ?? snapshot.acquisition_score ?? null,
    acquisition_score: target.priority_score ?? snapshot.acquisition_score ?? null,
    identity_alignment: { status: target.identity_status || metadata.identity_alignment || 'unknown' },
    // Raw ownership signals, when the upstream graph/candidate snapshot
    // carries them — same fields evaluatePreSendEligibility's renter-not-
    // owner rule already consumes for every other outbound path
    // (supabase-candidate-feeder.js's normalizeCandidateRow). Absent here
    // today for graph-sourced targets (campaign_target_graph pre-computes
    // identity_alignment.status instead), so this is null/null for those
    // rows and the identity_alignment status check below is the operative
    // gate; kept so a future raw-signal source is honored automatically.
    likely_owner: snapshot.likely_owner ?? metadata.likely_owner ?? target.likely_owner ?? null,
    likely_renting: snapshot.likely_renting ?? metadata.likely_renting ?? target.likely_renting ?? null,
    never_contacted: outreach.never_contacted ?? true,
    latest_contact_at: outreach.latest_contact_at || null,
    last_outbound_at: outreach.last_outbound_at || null,
    last_inbound_at: outreach.last_inbound_at || null,
    touch_count: outreach.touch_count ?? null,
    current_touch_number: outreach.current_touch_number ?? null,
    true_post_contact_suppression: outreach.true_post_contact_suppression === true,
    wrong_number: outreach.wrong_number === true,
    pending_prior_touch: outreach.pending_prior_touch === true,
    active_queue_item: outreach.active_queue_item === true,
    raw: {
      ...snapshot,
      language: canonicalLanguage,
      language_preference: canonicalLanguage,
      property_type_scope: resolvePropertyTypeScope({
        use_case: firstNonEmpty(metadata.template_use_case, campaign.metadata?.template_use_case, campaign.objective, 'ownership_check'),
        property_type: propertyType,
        unit_count: snapshot.unit_count ?? snapshot.units ?? null,
        owner_type: snapshot.owner_type_guess || snapshot.phone_owner || null,
      }),
    },
  }
}

function targetSnapshotForMetadata(target = {}, candidate = {}) {
  return {
    campaign_target_id: target.id || null,
    master_owner_id: candidate.master_owner_id || null,
    prospect_id: candidate.prospect_id || null,
    property_id: candidate.property_id || null,
    phone_id: candidate.phone_id || null,
    to_phone_number: candidate.canonical_e164 || null,
    market: target.market || candidate.market || null,
    state: target.state || candidate.state || null,
    timezone: candidate.timezone || target.timezone || null,
    source_timezone: candidate.source_timezone || target.timezone || null,
    owner_name: target.owner_name || candidate.owner_display_name || null,
    property_address: target.property_address || candidate.property_address_full || null,
    priority_score: target.priority_score ?? candidate.acquisition_score ?? null,
    identity_status: target.identity_status || candidate.identity_alignment?.status || null,
    routing_status: target.routing_status || null,
    suppression_status: target.suppression_status || null,
    template_status: target.template_status || null,
    target_status: target.target_status || null,
  }
}

export function candidateSnapshotForMetadata(candidate = {}) {
  return {
    master_owner_id: candidate.master_owner_id || null,
    prospect_id: candidate.prospect_id || null,
    canonical_prospect_id: candidate.canonical_prospect_id || null,
    property_id: candidate.property_id || null,
    phone_id: candidate.phone_id || candidate.best_phone_id || null,
    best_phone_id: candidate.best_phone_id || candidate.phone_id || null,
    to_phone_number: candidate.canonical_e164 || candidate.to_phone_number || null,
    market: candidate.market || null,
    state: candidate.state || null,
    language: candidate.language || candidate.best_language || null,
    timezone: candidate.timezone || null,
    contact_window: candidate.contact_window || null,
    seller_first_name: candidate.seller_first_name || candidate.owner_first_name || null,
    seller_full_name: candidate.seller_full_name || candidate.owner_display_name || null,
    owner_display_name: candidate.owner_display_name || null,
    property_address_full: candidate.property_address_full || candidate.property_address || null,
    property_city: candidate.property_city || null,
    property_zip: candidate.property_zip || null,
    property_type: candidate.property_type || null,
    property_class: candidate.property_class || null,
    canonical_property_group: candidate.canonical_property_group || null,
    touch_number: candidate.touch_number || 1,
    acquisition_score: candidate.acquisition_score ?? candidate.final_acquisition_score ?? null,
  }
}

function renderedTemplateId(rendered = {}) {
  return clean(
    rendered.selected_template_id ||
      rendered.template_rotation?.selected_template_id ||
      rendered.template?.template_id ||
      rendered.template?.id
  ) || null
}

function renderedMessageBody(rendered = {}) {
  return clean(rendered.rendered_message_body || rendered.rendered_message_text || rendered.text)
}

function routeSenderNumber(routing = {}) {
  return clean(routing.selected_textgrid_number || routing.selected?.phone_number) || null
}

function routeSenderId(routing = {}) {
  return clean(routing.selected_textgrid_number_id || routing.selected?.id) || null
}

async function fetchActiveQueueRowsByPhone(supabase, phones = []) {
  const rows = []
  const phoneValues = uniqueClean(phones)
  for (const phoneChunk of chunk(phoneValues, 200)) {
    const { data, error } = await supabase
      .from('send_queue')
      .select('id,campaign_id,campaign_target_id,to_phone_number,queue_status,dedupe_key,scheduled_for,scheduled_for_utc,created_at')
      .in('to_phone_number', phoneChunk)
      .in('queue_status', ACTIVE_QUEUE_STATUSES)
      .limit(5000)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

async function fetchPriorContactRowsByPhone(supabase, phones = []) {
  const rows = []
  const phoneValues = uniqueClean(phones)
  for (const phoneChunk of chunk(phoneValues, 200)) {
    const [queueResult, eventResult] = await Promise.all([
      supabase
        .from('send_queue')
        .select('id,to_phone_number,queue_status,sent_at,created_at,campaign_id,campaign_target_id')
        .in('to_phone_number', phoneChunk)
        .in('queue_status', ['sent', 'delivered'])
        .limit(5000),
      supabase
        .from('message_events')
        .select('id,to_phone_number,direction,event_type,sent_at,event_timestamp,created_at,queue_id')
        .in('to_phone_number', phoneChunk)
        .limit(5000),
    ])
    if (queueResult.error) throw queueResult.error
    if (eventResult.error) throw eventResult.error
    rows.push(...(queueResult.data || []).map((row) => ({ ...row, source: 'send_queue' })))
    rows.push(...(eventResult.data || [])
      .filter((row) => lower(row.direction || row.event_type).includes('out'))
      .map((row) => ({ ...row, source: 'message_events' })))
  }
  return rows
}

function groupLaunchItemsByWindow(items = []) {
  const groups = new Map()
  for (const item of items) {
    const target = item.target || {}
    const candidate = item.candidate || {}
    const key = [
      clean(candidate.timezone || target.timezone || 'America/Chicago'),
      clean(candidate.market || target.market || 'unknown'),
      clean(candidate.state || target.state || 'unknown'),
    ].join('|')
    if (!groups.has(key)) {
      groups.set(key, {
        timezone: clean(candidate.timezone || target.timezone || 'America/Chicago') || 'America/Chicago',
        market: clean(candidate.market || target.market) || null,
        state: clean(candidate.state || target.state) || null,
        items: [],
      })
    }
    groups.get(key).items.push(item)
  }
  return [...groups.values()]
}

export function buildQueueRowForLaunch({ campaign, target, candidate, routing, rendered, scheduledFor, window, caps, input, noSend = false }) {
  const scheduledDate = new Date(scheduledFor)
  const scheduledIso = scheduledDate.toISOString()
  const local = localScheduleSnapshot(scheduledDate, candidate.timezone || window.timezone)
  const templateId = renderedTemplateId(rendered)
  const messageBody = renderedMessageBody(rendered)
  const senderNumber = routeSenderNumber(routing)
  const senderId = routeSenderId(routing)
  const campaignSessionId = clean(input.campaign_session_id || campaign.id)
  const dedupeKey = buildSendQueueDedupeKey({
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    to_phone_number: candidate.canonical_e164,
    template_use_case: candidate.template_use_case || campaign.objective || 'ownership_check',
    touch_number: candidate.touch_number || 1,
    campaign_session_id: campaignSessionId,
  })
  const queueKey = `campaign:${crypto.createHash('sha1').update([
    campaign.id,
    target.id,
    candidate.canonical_e164,
    templateId,
    scheduledIso,
  ].join('|')).digest('hex')}`
  const metadata = {
    source: 'campaign_launch_execution',
    campaign_id: campaign.id,
    campaign_target_id: target.id,
    campaign_send_window_id: window.id || null,
    campaign_session_id: campaignSessionId,
    launch_mode: noSend ? 'proof_hydration_no_send' : 'guarded_live_queue_creation',
    dry_run: false,
    no_send: noSend,
    confirm_live: !noSend,
    proof_hydration: noSend,
    candidate_snapshot: candidateSnapshotForMetadata(candidate),
    target_snapshot: targetSnapshotForMetadata(target, candidate),
    campaign_target_metadata: metadataObject(target.metadata),
    routing_snapshot: {
      selected_textgrid_number_id: senderId,
      selected_textgrid_number: senderNumber,
      selected_textgrid_market: routing.selected_textgrid_market || routing.selected?.market || null,
      seller_market: routing.seller_market || candidate.market || null,
      seller_state: routing.seller_state || candidate.state || null,
      routing_tier: routing.routing_tier || null,
      routing_rule_name: routing.routing_rule_name || null,
      selection_reason: routing.selection_reason || null,
    },
    template_snapshot: {
      template_id: templateId,
      selected_template_id: templateId,
      template_name: rendered.template?.template_name || null,
      template_source: rendered.template?.source || 'sms_templates',
      template_use_case: rendered.template_use_case || candidate.template_use_case || campaign.objective || null,
      stage_code: rendered.template?.stage_code || rendered.template_rotation?.selected_template_stage_code || null,
      language: rendered.template?.language || candidate.language || null,
      rendered_message_preview: messageBody.slice(0, 180),
      character_count: messageBody.length,
    },
    schedule_snapshot: {
      timezone: candidate.timezone || window.timezone || null,
      scheduled_for_utc: scheduledIso,
      scheduled_for_local: local.scheduled_for_local,
      local_send_date: local.local_send_date,
      local_send_hour: local.local_send_hour,
      window_start_utc: window.window_start_utc,
      window_end_utc: window.window_end_utc,
      spread_interval_seconds: window.spread_interval_seconds,
    },
    cap_snapshot: caps,
    dedupe_key: dedupeKey,
    safety_diagnostics: {
      status: 'passed',
      duplicate_phone_checked: true,
      active_queue_checked: true,
      prior_contact_checked: true,
      suppression_checked: true,
      routing_checked: true,
      template_checked: true,
      local_window_checked: true,
      confirm_live: !noSend,
      no_send: noSend,
    },
  }
  return {
    queue_key: queueKey,
    queue_id: queueKey,
    queue_status: noSend ? 'scheduled' : 'scheduled',
    scheduled_for: scheduledIso,
    scheduled_for_utc: scheduledIso,
    scheduled_for_local: scheduledIso,
    local_send_date: local.local_send_date,
    local_send_hour: local.local_send_hour,
    message_body: messageBody,
    message_text: messageBody,
    rendered_message: messageBody,
    to_phone_number: candidate.canonical_e164,
    from_phone_number: senderNumber,
    textgrid_number_id: senderId,
    textgrid_number: senderNumber,
    master_owner_id: candidate.master_owner_id,
    prospect_id: candidate.prospect_id,
    property_id: candidate.property_id,
    phone_id: candidate.phone_id,
    market: candidate.market,
    property_address_state: candidate.state,
    property_address_city: candidate.property_city || null,
    property_address_zip: candidate.property_zip || null,
    property_type: candidate.property_type || candidate.canonical_property_group || null,
    timezone: candidate.timezone || window.timezone || null,
    contact_window: candidate.contact_window || null,
    template_id: templateId,
    selected_template_id: templateId,
    template_key: templateId,
    template_source: rendered.template?.source || 'sms_templates',
    use_case_template: candidate.template_use_case || campaign.objective || 'ownership_check',
    touch_number: candidate.touch_number || 1,
    dedupe_key: dedupeKey,
    sms_eligible: noSend ? false : true,
    routing_allowed: noSend ? false : true,
    safety_status: noSend ? 'blocked' : 'passed',
    guard_status: 'passed',
    guard_reason: null,
    type: 'campaign_launch',
    source: 'campaign_launch_execution',
    thread_key: candidate.canonical_e164,
    seller_first_name: candidate.seller_first_name || null,
    seller_display_name: candidate.seller_full_name || candidate.owner_display_name || null,
    agent_name: clean(campaign.agent_persona) || null,
    language: candidate.language || null,
    routing_reason: routing.selection_reason || routing.routing_rule_name || null,
    campaign_id: campaign.id,
    campaign_target_id: target.id,
    campaign_send_window_id: window.id || null,
    metadata,
  }
}

export function resolveCampaignQueueWriteMode(input = {}, campaign = null) {
  const dryRun = input.dry_run === true || input.dryRun === true
  const createRows = input.create_send_queue_rows === false || input.createSendQueueRows === false ? false : true

  let noSend
  let confirmLive
  let productionLiveWrite = false
  if (campaign) {
    const derived = mergeLaunchWriteModeIntoInput(campaign, input)
    noSend = derived.no_send === true
    confirmLive = derived.confirm_live === true
    productionLiveWrite = derived.production_live_write === true
  } else {
    noSend = input.no_send === true || input.noSend === true
    confirmLive = asBoolean(input.confirm_live ?? input.confirmLive, input.no_send === false || input.noSend === false)
    productionLiveWrite = input.production_live_write === true || input.productionLiveWrite === true
  }

  const hydrateNoSend = !dryRun && noSend && createRows && asBoolean(input.hydrate_canonical_queue ?? input.hydrateCanonicalQueue, noSend)
  const isLiveSendWrite = !dryRun && !noSend && confirmLive && createRows
  return {
    dryRun,
    noSend,
    confirmLive,
    createRows,
    hydrateNoSend,
    isLiveSendWrite,
    isProofHydrationWrite: hydrateNoSend,
    productionLiveWrite,
  }
}

export async function createCampaignQueuePlan(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const explicitOperatorAction = asBoolean(input.explicit_operator_action || input.operator_action, false)
  const suppressPreviouslyContacted = asBoolean(
    input.suppress_previously_contacted ??
      input.suppression_applies ??
      input.suppressionApplies ??
      input.suppressPriorContacted,
    true
  )
  const blockOnGlobalEmergencyStop = asBoolean(
    input.block_on_global_emergency_stop ??
      input.respect_global_emergency_stop_for_creation ??
      input.respectGlobalEmergencyStopForCreation,
    false
  )
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single()
  if (campaignError) throw campaignError
  if (!campaign) return { ok: false, error: 'campaign_not_found', campaign_id: campaignId, blockers: ['campaign_not_found'] }

  const writeMode = resolveCampaignQueueWriteMode(input, campaign)
  const dryRun = writeMode.dryRun
  const noSend = writeMode.noSend
  const confirmLive = writeMode.confirmLive
  const createRows = writeMode.createRows
  const globalStop = await globalEmergencyStopActive(deps)
  const campaignStop = isEmergencyStopActive(campaign.emergency_stop_at)

  const { data: targets, error: targetError } = await supabase
    .from('campaign_targets')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('target_status', 'ready')
    .order('priority_score', { ascending: false, nullsFirst: false })
    .limit(10000)
  if (targetError) throw targetError

  const readyTargets = targets || []
  const caps = resolveLaunchCaps(campaign, input, readyTargets.length)
  const hydrateNoSend = writeMode.hydrateNoSend
  const isLiveSendWrite = writeMode.isLiveSendWrite
  const productionLiveWrite = writeMode.productionLiveWrite === true
  const blockers = []
  for (const cap of missingLaunchCaps(caps)) blockers.push(`missing_cap:${cap}`)
  if (!isQueueableStatus(campaign.status)) blockers.push(`campaign_status_not_queueable:${campaign.status}`)
  if (!campaign.auto_queue_enabled && !explicitOperatorAction) blockers.push('auto_queue_disabled_without_operator_action')
  if (campaignStop) blockers.push('campaign_emergency_stop_active')
  if (globalStop && isLiveSendWrite && blockOnGlobalEmergencyStop) blockers.push('global_emergency_stop_active')
  if (campaign.auto_send_enabled && !productionLiveWrite) blockers.push('auto_send_must_remain_disabled')
  if (clean(campaign.auto_reply_mode || 'disabled') !== 'disabled' && !productionLiveWrite) {
    blockers.push('auto_reply_must_remain_disabled')
  }
  if (isLiveSendWrite && !confirmLive) blockers.push('confirm_live_required')
  if (isLiveSendWrite && productionLiveWrite && !explicitOperatorAction && !asBoolean(campaign.auto_queue_enabled, false)) {
    blockers.push('auto_queue_disabled_without_operator_action')
  }

  const isProofHydrationWrite = hydrateNoSend && blockers.length === 0

  // Execution lock (Phase 2B). For a live write request, acquire the campaign
  // execution lease BEFORE snapshotting active-queue/prior-contact state, so the
  // entire plan+write runs under the mutex and two concurrent activations cannot
  // both pass dedup and double-insert. If the lease is held by another worker,
  // record a blocker so the live write is skipped. Released in `finally`.
  const isLiveWriteRequest = (isLiveSendWrite || isProofHydrationWrite) && blockers.length === 0
  const executionLock = {
    requested: isLiveWriteRequest,
    acquired: false,
    enforced: false,
    token: null,
    owner: null,
  }
  if (isLiveWriteRequest && blockers.length === 0) {
    const lockToken = newExecutionLockToken()
    const lease = await acquireCampaignExecutionLock(supabase, campaignId, {
      token: lockToken,
      owner: `queue_plan:${clean(input.campaign_session_id || campaignId)}`,
    })
    executionLock.acquired = lease.acquired
    executionLock.enforced = lease.enforced
    executionLock.token = lease.acquired ? lease.token : null
    executionLock.owner = lease.owner
    if (!lease.acquired) blockers.push('campaign_execution_locked')
  }

  const now = new Date(input.now || Date.now())
  const phones = readyTargets.map((target) => firstNonEmpty(target.to_phone_number, target.metadata?.candidate_snapshot?.to_phone_number))
  const [activeQueueRows, priorContactRows] = await Promise.all([
    phones.length ? fetchActiveQueueRowsByPhone(supabase, phones) : Promise.resolve([]),
    suppressPreviouslyContacted && phones.length ? fetchPriorContactRowsByPhone(supabase, phones) : Promise.resolve([]),
  ])
  const activeByPhone = new Map()
  const priorByPhone = new Map()
  for (const row of activeQueueRows) {
    const phone = clean(row.to_phone_number)
    if (!phone) continue
    if (!activeByPhone.has(phone)) activeByPhone.set(phone, [])
    activeByPhone.get(phone).push(row)
  }
  for (const row of priorContactRows) {
    const phone = clean(row.to_phone_number)
    if (!phone) continue
    if (!priorByPhone.has(phone)) priorByPhone.set(phone, [])
    priorByPhone.get(phone).push(row)
  }

  const intervalSeconds = asPositiveInteger(
    input.spread_interval_seconds ?? input.interval_seconds ?? input.send_interval_seconds ?? campaign.send_interval_seconds,
    60
  )
  const launchOptions = {
    ...input,
    now: now.toISOString(),
    dry_run: true,
    campaign_session_id: clean(input.campaign_session_id || campaignId),
    template_use_case: clean(input.template_use_case || campaign.metadata?.template_use_case || campaign.objective || 'ownership_check') || 'ownership_check',
    stage_code: normalizeCampaignStageCode(input.stage_code || campaign.metadata?.stage_code, 'S1'),
    routing_safe_only: input.routing_safe_only !== false,
    allow_phone_fallback: false,
    first_touch: input.first_touch ?? true,
    campaign_template_assignment: true,
    allow_identity_unknown: true,
  }
  const plannedItems = []
  const sampleSkips = []
  const skippedCounts = {}
  const senderCounts = {}
  const senderMarketCounts = {}
  const templateCounts = {}
  const routingCounts = {}
  const marketCounts = {}
  const seenPhones = new Set()
  const senderUseCounts = {}
  const marketUseCounts = {}

  const recordSkip = (reason, target = {}, extra = {}) => {
    increment(skippedCounts, reason)
    if (sampleSkips.length < 50) {
      sampleSkips.push({
        reason,
        campaign_target_id: target.id || null,
        master_owner_id: target.master_owner_id || null,
        prospect_id: target.prospect_id || target.metadata?.prospect_id || target.metadata?.candidate_snapshot?.prospect_id || null,
        property_id: target.property_id || null,
        phone_id: target.phone_id || target.metadata?.candidate_snapshot?.phone_id || null,
        to_phone_number: target.to_phone_number || null,
        market: target.market || null,
        state: target.state || null,
        ...extra,
      })
    }
  }

  let planLoopCounter = 0
  for (const target of readyTargets) {
    if (plannedItems.length >= caps.effective_limit) break
    // Keep the execution lease alive across long planning passes (per-target
    // routing + template render are async and can exceed the lease TTL).
    if (executionLock.token && (planLoopCounter++ % 250) === 0) {
      await renewCampaignExecutionLock(supabase, campaignId, executionLock.token)
    }
    const candidate = launchCandidateFromTarget(target, campaign)
    const phone = clean(candidate.canonical_e164)
    if (!phone) {
      recordSkip('missing_to_phone_number', target)
      continue
    }
    if (!candidate.master_owner_id) {
      recordSkip('missing_master_owner_id', target)
      continue
    }
    if (!candidate.prospect_id) {
      recordSkip('missing_prospect_id', target)
      continue
    }
    if (!candidate.phone_id) {
      recordSkip('missing_phone_id', target)
      continue
    }
    // Canonical owner/identity verification — the same deterministic,
    // fail-closed pre-send gate every other outbound path (feeder,
    // manual-send, next-best-contact selection) runs before a cold message
    // can be sent. Strict mode always: this is a queue-build-time ownership
    // check, independent of the template-routing "allow identity unknown"
    // policy used later in this same function for template selection.
    // Blocks renter (RENTER_NOT_OWNER), explicit non-owner / former-owner /
    // wrong-party (IDENTITY_MISMATCH), and unverified/ambiguous identity
    // (OWNERSHIP_NOT_CONFIRMED) — never inferred merely from the presence of
    // master_owner_id/prospect_id/phone_id.
    const ownerEligibility = evaluatePreSendEligibility(candidate, {})
    if (!ownerEligibility.eligible) {
      recordSkip(ownerEligibility.block_reason || ownerEligibility.reason || 'owner_identity_not_verified', target, {
        identity_alignment_status: candidate.identity_alignment?.status || null,
        ownership_confidence: ownerEligibility.ownership_confidence,
        likely_owner: candidate.likely_owner,
        likely_renting: candidate.likely_renting,
      })
      continue
    }
    if (candidate.timezone_eligibility_reason) {
      recordSkip(candidate.timezone_eligibility_reason, target, {
        supplied_timezone: candidate.source_timezone || null,
      })
      continue
    }
    if (seenPhones.has(phone)) {
      recordSkip('duplicate_phone_in_launch_batch', target)
      continue
    }
    if (activeByPhone.has(phone)) {
      recordSkip('active_queue_row_exists', target, {
        active_queue_row_ids: activeByPhone.get(phone).slice(0, 5).map((row) => row.id),
      })
      continue
    }
    if (candidate.true_post_contact_suppression || candidate.wrong_number || candidate.pending_prior_touch || candidate.active_queue_item) {
      recordSkip('graph_suppression_or_queue_block', target, {
        true_post_contact_suppression: candidate.true_post_contact_suppression,
        wrong_number: candidate.wrong_number,
        pending_prior_touch: candidate.pending_prior_touch,
        active_queue_item: candidate.active_queue_item,
      })
      continue
    }
    if (suppressPreviouslyContacted) {
	      const outreachTouched =
	        candidate.never_contacted === false ||
	        Boolean(candidate.last_outbound_at || candidate.latest_contact_at) ||
	        Number(candidate.touch_count || 0) > 0
      if (outreachTouched || priorByPhone.has(phone)) {
        recordSkip('prior_contacted_suppression', target, {
          prior_contact_row_ids: (priorByPhone.get(phone) || []).slice(0, 5).map((row) => row.id),
        })
        continue
      }
    }

    const routing = await chooseTextgridNumber(candidate, launchOptions, deps)
    if (!routing.ok) {
      recordSkip(routing.reason_code || routing.routing_block_reason || 'routing_blocked', target, {
        routing_block_reason: routing.routing_block_reason || null,
      })
      continue
    }
    const senderNumber = routeSenderNumber(routing)
    const senderKey = senderNumber || 'unknown_sender'
    if (!senderNumber) {
      recordSkip('missing_selected_sender_number', target)
      continue
    }
    if (caps.per_sender_cap && Number(senderUseCounts[senderKey] || 0) >= caps.per_sender_cap) {
      recordSkip('per_sender_cap_reached', target, { sender: senderNumber })
      continue
    }
    const marketKey = clean(candidate.market || target.market || 'unknown')
    if (caps.per_market_cap && Number(marketUseCounts[marketKey] || 0) >= caps.per_market_cap) {
      recordSkip('per_market_cap_reached', target, { market: marketKey })
      continue
    }

    const rendered = await renderOutboundTemplate(candidate, launchOptions, deps)
    const templateId = renderedTemplateId(rendered)
    const messageBody = renderedMessageBody(rendered)
    if (!rendered.ok || !templateId || !messageBody) {
      recordSkip(rendered.reason_code || rendered.reason || 'template_render_failed', target, {
        template_id: templateId,
        render_error_message: rendered.render_error_message || rendered.reason || null,
      })
      continue
    }

    seenPhones.add(phone)
    senderUseCounts[senderKey] = Number(senderUseCounts[senderKey] || 0) + 1
    marketUseCounts[marketKey] = Number(marketUseCounts[marketKey] || 0) + 1
    increment(senderCounts, senderNumber)
    increment(senderMarketCounts, routing.selected_textgrid_market || routing.selected?.market || 'unknown')
    increment(templateCounts, templateId)
    increment(routingCounts, routing.routing_tier || 'unknown')
    increment(marketCounts, marketKey)
    plannedItems.push({ target, candidate, routing, rendered })
  }

  const scheduleCampaign = {
    ...campaign,
    contact_window_start: clean(input.contact_window_start || input.window_start || campaign.contact_window_start) || campaign.contact_window_start,
    contact_window_end: clean(input.contact_window_end || input.window_end || campaign.contact_window_end) || campaign.contact_window_end,
  }
  const scheduleBase = new Date(input.first_scheduled_at || input.first_scheduled_at_utc || input.now || Date.now())
  const grouped = groupLaunchItemsByWindow(plannedItems)
  const plannedWindows = []
  const scheduledItems = []
  for (const group of grouped) {
    const window = computeWindowForTimezone(group.timezone, scheduleCampaign, scheduleBase)
    const windowRecord = {
      campaign_id: campaignId,
      market: group.market,
      state: group.state,
      timezone: group.timezone,
      status: 'planned',
      max_sends: group.items.length,
      sends_attempted: 0,
      sends_successful: 0,
      sends_failed: 0,
      metadata: {
        dry_run: dryRun,
        no_send: noSend,
        confirm_live: confirmLive,
        target_count: group.items.length,
        spread_interval_seconds: intervalSeconds,
        launch_cap_snapshot: caps,
      },
      ...window,
      spread_interval_seconds: intervalSeconds,
      items: [],
    }
    let cursor = new Date(window.window_start_utc).getTime()
    const endMs = new Date(window.window_end_utc).getTime()
    for (const item of group.items) {
      if (cursor >= endMs) {
        recordSkip('schedule_window_full', item.target, {
          timezone: group.timezone,
          window_start_utc: window.window_start_utc,
          window_end_utc: window.window_end_utc,
        })
        continue
      }
      const scheduledFor = new Date(cursor).toISOString()
      const scheduledItem = { ...item, scheduled_for_utc: scheduledFor, window: windowRecord }
      scheduledItems.push(scheduledItem)
      windowRecord.items.push(scheduledItem)
      cursor += intervalSeconds * 1000
    }
    if (windowRecord.items.length) {
      windowRecord.first_scheduled_at = windowRecord.items[0].scheduled_for_utc
      windowRecord.last_scheduled_at = windowRecord.items[windowRecord.items.length - 1].scheduled_for_utc
    } else {
      windowRecord.first_scheduled_at = null
      windowRecord.last_scheduled_at = null
    }
    plannedWindows.push(windowRecord)
  }

  const shouldWriteQueueRows = (isLiveSendWrite || isProofHydrationWrite) && blockers.length === 0
  let insertedWindows = []
  let insertedQueueRows = []
  let run = null

  try {
    if (!dryRun) {
      run = await startCampaignRun(campaignId, {
        run_type: 'launch_queue_plan',
        dry_run: dryRun,
        metadata: {
          input,
          no_send: noSend,
          confirm_live: confirmLive,
          create_send_queue_rows: createRows,
          live_gate_passed: shouldWriteQueueRows,
          global_emergency_stop_active: globalStop,
          block_on_global_emergency_stop: blockOnGlobalEmergencyStop,
          caps,
        },
      }, deps)
    }

    if (shouldWriteQueueRows && plannedWindows.length) {
      const rows = plannedWindows.map(({ items: _items, spread_interval_seconds: _spread, first_scheduled_at, last_scheduled_at, ...row }) => ({
        ...row,
        metadata: {
          ...metadataObject(row.metadata),
          first_scheduled_at,
          last_scheduled_at,
        },
      }))
      const { data, error } = await supabase.from('campaign_send_windows').insert(rows).select('*')
      if (error) throw error
      insertedWindows = data || []
    }

    if (shouldWriteQueueRows && scheduledItems.length) {
      const queueRows = []
      const targetUpdates = []
      const windowIdByKey = new Map()
      for (const [index, plannedWindow] of plannedWindows.entries()) {
        const insertedWindow = insertedWindows[index] || {}
        windowIdByKey.set([
          plannedWindow.timezone,
          plannedWindow.market,
          plannedWindow.state,
          plannedWindow.window_start_utc,
        ].join('|'), insertedWindow.id || null)
      }
      for (const item of scheduledItems) {
        const windowKey = [
          item.window.timezone,
          item.window.market,
          item.window.state,
          item.window.window_start_utc,
        ].join('|')
        const window = {
          ...item.window,
          id: windowIdByKey.get(windowKey) || null,
        }
        queueRows.push(buildQueueRowForLaunch({
          campaign,
          target: item.target,
          candidate: item.candidate,
          routing: item.routing,
          rendered: item.rendered,
          scheduledFor: item.scheduled_for_utc,
          window,
          caps,
          input,
          noSend: hydrateNoSend,
        }))
        targetUpdates.push(item.target.id)
      }
      const hydrationTotal = queueRows.length
      for (let i = 0; i < queueRows.length; i += 500) {
        const rowChunk = queueRows.slice(i, i + 500)
        const { data, error } = await supabase
          .from('send_queue')
          .insert(rowChunk)
          .select('id,campaign_target_id,from_phone_number,textgrid_number_id,to_phone_number,template_id,queue_status,scheduled_for_utc,metadata')
        if (error) throw error
        insertedQueueRows.push(...(data || []))
        // Resumable checkpoint + lease heartbeat after each committed chunk.
        if (executionLock.token) {
          await renewCampaignExecutionLock(supabase, campaignId, executionLock.token)
          await checkpointCampaignHydration(supabase, campaignId, {
            run_id: run?.id || null,
            phase: 'hydrating',
            inserted: insertedQueueRows.length,
            total: hydrationTotal,
            next_offset: Math.min(i + 500, hydrationTotal),
            updated_at: new Date().toISOString(),
          })
        }
      }
      if (executionLock.token) {
        // Hydration complete — clear the resumable cursor.
        await checkpointCampaignHydration(supabase, campaignId, {
          run_id: run?.id || null,
          phase: 'complete',
          inserted: insertedQueueRows.length,
          total: hydrationTotal,
          completed_at: new Date().toISOString(),
        })
      }
      if (targetUpdates.length) {
        await supabase
          .from('campaign_targets')
          .update({ target_status: 'planned', last_launched_at: new Date().toISOString() })
          .in('id', targetUpdates)
      }
      // Live send writes stage BUILT -> QUEUED -> SCHEDULED.
      // Proof hydration (no_send) inserts canonical rows but does not advance lifecycle;
      // activation service owns the transition to ACTIVE.
      const campaignStatus = normalizeCampaignStatus(campaign.status)
      const shouldAdvanceLifecycle = !hydrateNoSend && ['built', 'queued', 'draft'].includes(campaignStatus)
      if (shouldAdvanceLifecycle) {
        const earliestScheduledFor = scheduledItems
          .map((item) => item.scheduled_for_utc)
          .filter(Boolean)
          .sort()[0] || null
        const queued = await transitionCampaignStatus(supabase, campaignId, 'queued', { reason: 'queue_plan_live_write' })
        if (!queued.ok) blockers.push(queued.error || 'lifecycle_transition_failed')
        const scheduled = await transitionCampaignStatus(supabase, campaignId, 'scheduled', {
          reason: 'queue_plan_live_write',
          scheduledFor: earliestScheduledFor,
        })
        if (!scheduled.ok) blockers.push(scheduled.error || 'lifecycle_transition_failed')
      }
    }

    if (run) {
      await finishCampaignRun(run.id, {
        status: blockers.length ? 'blocked' : 'completed',
        queue_rows_planned: scheduledItems.length,
        queue_rows_created: insertedQueueRows.length,
        ready_to_queue: readyTargets.length,
        blocked_counts: skippedCounts,
        metadata: {
          blockers,
          dry_run: dryRun,
          no_send: noSend,
          confirm_live: confirmLive,
          create_send_queue_rows: createRows,
          live_gate_passed: shouldWriteQueueRows,
          caps,
          sender_distribution: distributionFromCounts(senderCounts),
          template_distribution: distributionFromCounts(templateCounts),
        },
      }, deps)
      await recordCampaignEvent({
        campaign_id: campaignId,
        run_id: run.id,
        event_type: blockers.length
          ? 'campaign.launch_blocked'
          : shouldWriteQueueRows
            ? 'campaign.launch_scheduled'
            : noSend
              ? 'campaign.launch_no_send_planned'
              : 'campaign.launch_planned',
        severity: blockers.length ? 'warning' : 'success',
        title: blockers.length ? 'Campaign launch blocked' : 'Campaign launch planned',
        description: blockers.length
          ? `Blocked by ${blockers.join(', ')}`
          : `${scheduledItems.length} targets planned; ${insertedQueueRows.length} queue rows created.`,
        metadata: {
          blockers,
          dry_run: dryRun,
          no_send: noSend,
          confirm_live: confirmLive,
          create_send_queue_rows: createRows,
          send_queue_rows_created: insertedQueueRows.length,
          global_emergency_stop_active: globalStop,
          block_on_global_emergency_stop: blockOnGlobalEmergencyStop,
          caps,
        },
      }, deps)
    }
  } catch (error) {
    if (run) {
      await finishCampaignRun(run.id, {
        status: 'failed',
        metadata: { error: error?.message || String(error), blockers, caps },
      }, deps)
    }
    throw error
  } finally {
    if (executionLock.token) {
      await releaseCampaignExecutionLock(supabase, campaignId, executionLock.token)
    }
  }

  const firstScheduledAt = scheduledItems
    .map((item) => item.scheduled_for_utc)
    .filter(Boolean)
    .sort()[0] || null
  const lastScheduledAt = scheduledItems
    .map((item) => item.scheduled_for_utc)
    .filter(Boolean)
    .sort()
    .at(-1) || null
  const status = blockers.length
    ? 'blocked'
    : shouldWriteQueueRows
      ? 'live_scheduled'
      : dryRun
        ? 'dry_run'
        : noSend
          ? 'no_send'
          : 'planned'
  const liveGate = {
    dry_run: dryRun,
    no_send: noSend,
    confirm_live: confirmLive,
    create_send_queue_rows: createRows,
    hydrate_canonical_queue: hydrateNoSend,
    may_create_send_queue_rows: shouldWriteQueueRows,
    proof_hydration: isProofHydrationWrite,
    global_emergency_stop_active: globalStop,
    block_on_global_emergency_stop: blockOnGlobalEmergencyStop,
    required_conditions: {
      dry_run_false: dryRun === false,
      live_send: isLiveSendWrite,
      proof_hydration: isProofHydrationWrite,
    },
  }
  const hydrationResult = {
    scanned: readyTargets.length,
    inserted: insertedQueueRows.length,
    already_queued: Number(skippedCounts.active_queue_row_exists || 0),
    duplicate_phone: Number(skippedCounts.duplicate_phone_in_launch_batch || 0),
    duplicate_owner: 0,
    suppressed: Number(skippedCounts.graph_suppression_or_queue_block || 0) + Number(skippedCounts.prior_contacted_suppression || 0),
    wrong_number: 0,
    opted_out: 0,
    template_missing: Number(skippedCounts.template_render_failed || 0),
    sender_missing: Number(skippedCounts.missing_selected_sender_number || 0) + Number(skippedCounts.routing_blocked || 0),
    outside_contact_window: Number(skippedCounts.schedule_window_full || 0),
    blocked_identity: Number(skippedCounts.missing_master_owner_id || 0) + Number(skippedCounts.missing_prospect_id || 0),
    other_failed: Object.entries(skippedCounts)
      .filter(([key]) => ![
        'active_queue_row_exists', 'duplicate_phone_in_launch_batch', 'graph_suppression_or_queue_block',
        'prior_contacted_suppression', 'template_render_failed', 'missing_selected_sender_number',
        'routing_blocked', 'schedule_window_full', 'missing_master_owner_id', 'missing_prospect_id',
      ].includes(key))
      .reduce((sum, [, count]) => sum + Number(count || 0), 0),
  }
  const duplicateProtection = {
    no_duplicate_phone_queue_rows: true,
    no_duplicate_active_queue_rows: Number(skippedCounts.active_queue_row_exists || 0) === 0,
    no_prior_contacted_rows_if_suppression_applies: !suppressPreviouslyContacted || Number(skippedCounts.prior_contacted_suppression || 0) === 0,
    batch_duplicate_phone_skipped: Number(skippedCounts.duplicate_phone_in_launch_batch || 0),
    active_queue_duplicate_skipped: Number(skippedCounts.active_queue_row_exists || 0),
    prior_contacted_skipped: Number(skippedCounts.prior_contacted_suppression || 0),
    existing_active_queue_rows_found: activeQueueRows.length,
    existing_prior_contact_rows_found: priorContactRows.length,
    suppression_applies: suppressPreviouslyContacted,
  }
  const launchSummary = {
    targets_created: scheduledItems.length,
    queue_rows_created: insertedQueueRows.length,
    skipped_count: Object.values(skippedCounts).reduce((sum, count) => sum + Number(count || 0), 0),
    blocked_count: blockers.length + Object.values(skippedCounts).reduce((sum, count) => sum + Number(count || 0), 0),
    sender_distribution: distributionFromCounts(senderCounts),
    sender_market_distribution: distributionFromCounts(senderMarketCounts),
    template_distribution: distributionFromCounts(templateCounts),
    routing_distribution: distributionFromCounts(routingCounts),
    market_distribution: distributionFromCounts(marketCounts),
    first_scheduled_at: firstScheduledAt,
    last_scheduled_at: lastScheduledAt,
    status,
  }

  return {
    ok: blockers.length === 0,
    success: blockers.length === 0,
    dry_run: dryRun,
    no_send: noSend,
    campaign_id: campaignId,
    blockers,
    exact_blockers: blockers,
    caps,
    launch_caps: caps,
    live_gate: liveGate,
    execution_lock: {
      requested: executionLock.requested,
      acquired: executionLock.acquired,
      enforced: executionLock.enforced,
      owner: executionLock.owner,
    },
    duplicate_protection: duplicateProtection,
    total_ready_targets: readyTargets.length,
    planned_target_count: scheduledItems.length,
    targets_created: launchSummary.targets_created,
    planned_windows: plannedWindows.map(({ items: windowItems, ...window }) => ({
      ...window,
      targets_planned: windowItems.length,
      target_ids: windowItems.slice(0, 25).map((item) => item.target.id),
    })),
    send_windows_created: insertedWindows.length,
    send_queue_rows_created: insertedQueueRows.length,
    queue_rows_created: insertedQueueRows.length,
    skipped_count: launchSummary.skipped_count,
    skipped_counts_by_reason: skippedCounts,
    sample_skips: sampleSkips,
    blocked_count: launchSummary.blocked_count,
    sender_distribution: launchSummary.sender_distribution,
    sender_market_distribution: launchSummary.sender_market_distribution,
    template_distribution: launchSummary.template_distribution,
    routing_distribution: launchSummary.routing_distribution,
    first_scheduled_at: firstScheduledAt,
    last_scheduled_at: lastScheduledAt,
    spread_interval_seconds: intervalSeconds,
    status,
    launch_summary: launchSummary,
    hydration_result: hydrationResult,
    inserted_queue_rows: insertedQueueRows.slice(0, 25),
    global_emergency_stop_active: globalStop,
    campaign_emergency_stop_active: campaignStop,
  }
}

const ACTIVATION_BLOCKER_MESSAGES = Object.freeze({
  auto_queue_disabled_without_operator_action: 'Auto-queue is disabled. Enable it or pass explicit_operator_action.',
  campaign_emergency_stop_active: 'Campaign emergency stop is active.',
  global_emergency_stop_active: 'Global emergency stop is active.',
  confirm_live_required: 'confirm_live is required for live queue writes.',
  auto_send_must_remain_disabled: 'auto_send_enabled must remain disabled for guarded launch.',
  auto_reply_must_remain_disabled: 'auto_reply must remain disabled for guarded launch.',
  campaign_execution_locked: 'Another worker holds the campaign execution lock.',
})

function formatActivationBlocker(blocker = '') {
  const raw = clean(blocker)
  if (!raw) return ''
  if (ACTIVATION_BLOCKER_MESSAGES[raw]) return ACTIVATION_BLOCKER_MESSAGES[raw]

  const normalized = raw.toLowerCase()
  if (normalized.startsWith('missing_cap:')) {
    const cap = raw.split(':').slice(1).join(':') || 'launch cap'
    return `Campaign is missing required launch cap: ${cap.replace(/_/g, ' ')}.`
  }
  if (normalized.startsWith('campaign_status_not_queueable:')) {
    const status = raw.split(':').slice(1).join(':') || 'unknown'
    if (status === 'draft') return 'Build targets and move the campaign out of draft before activating.'
    return `Campaign status "${status}" is not queueable for activation.`
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
    return 'No reachable contacts match this campaign audience.'
  }
  return raw.replace(/_/g, ' ')
}

function formatActivationBlockers(blockers = []) {
  return [...new Set((blockers || []).map(formatActivationBlocker).filter(Boolean))]
}

async function countCampaignTargets(supabase, campaignId, { readyOnly = false } = {}) {
  let query = supabase
    .from('campaign_targets')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  if (readyOnly) query = query.eq('target_status', 'ready')
  const { count, error } = await query
  if (error) throw error
  return Number(count || 0)
}

const ACTIVE_CAMPAIGN_QUEUE_STATUSES = ['queued', 'scheduled', 'pending', 'ready', 'approved', 'processing', 'sending']

async function countCampaignQueueRows(supabase, campaignId, { activeOnly = false } = {}) {
  let query = supabase
    .from('send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  if (activeOnly) query = query.in('queue_status', ACTIVE_CAMPAIGN_QUEUE_STATUSES)
  const { count, error } = await query
  if (error) throw error
  return Number(count || 0)
}

/**
 * Activation with initial queue hydration: validates audience, writes the first
 * live batch via createCampaignQueuePlan, then walks lifecycle to active.
 */
export async function activateCampaignWithHydration(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }

  const reason = clean(input.reason) || 'operator:activate'
  const scheduledFor = input.scheduled_for || input.scheduledFor || input.first_scheduled_at || null
  const idempotencyKey = clean(input.activation_idempotency_key || input.activationIdempotencyKey)

  const detail = await getCampaign(campaignId, deps)
  const campaign = detail.campaign
  if (!campaign) return { ok: false, error: 'campaign_not_found' }

  const totalTargets = await countCampaignTargets(supabase, campaignId)
  if (!totalTargets) {
    return {
      ok: false,
      error: 'no_targets',
      blockers: ['No campaign targets exist. Build targets before activating.'],
      inserted: 0,
      skipped: 0,
    }
  }

  const readyTargets = await countCampaignTargets(supabase, campaignId, { readyOnly: true })
  const existingQueueRows = await countCampaignQueueRows(supabase, campaignId, { activeOnly: true })
  const status = normalizeCampaignStatus(campaign.status)

  if (!isQueueableStatus(campaign.status)) {
    const blockers = formatActivationBlockers([`campaign_status_not_queueable:${status}`])
    return { ok: false, error: 'campaign_not_queueable', blockers, inserted: 0, skipped: 0 }
  }

  const forceLive = input.force_live === true || input.forceLive === true
  if (
    status === 'active' &&
    !forceLive &&
    (campaign.activated_at || existingQueueRows > 0 || Number(campaign.queued_count || 0) > 0)
  ) {
    // Reconcile split-brain (active + live rows + proof/disabled flags) instead of
    // returning a stale idempotent "already active" that leaves execution broken.
    const liveQueueRows = await countLiveConfirmedQueueRows(supabase, campaignId)
    if (isCampaignLiveInconsistentWithQueue(campaign, { liveQueueRows })) {
      const repair = await reconcileCampaignLiveState(campaignId, deps)
      const { data: repairedCampaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle()
      return {
        ok: true,
        idempotent: true,
        reconciled: true,
        campaign_id: campaignId,
        queue_result: null,
        lifecycle_result: { ok: true, campaign: repairedCampaign || repair.campaign || campaign, from: status, to: status },
        inserted: 0,
        skipped: 0,
        blockers: [],
        from: status,
        to: status,
        outcome: repair.outcome,
        campaign: repairedCampaign || repair.campaign || campaign,
      }
    }
    return {
      ok: true,
      idempotent: true,
      campaign_id: campaignId,
      queue_result: null,
      lifecycle_result: { ok: true, campaign, from: status, to: status },
      inserted: 0,
      skipped: 0,
      blockers: [],
      from: status,
      to: status,
      campaign,
    }
  }

  const storedIdempotencyKey = clean(campaign.last_activation_idempotency_key)
  const activationStatuses = new Set(['queued', 'scheduled', 'activating', 'active'])
  if (
    idempotencyKey &&
    storedIdempotencyKey === idempotencyKey &&
    activationStatuses.has(status) &&
    (existingQueueRows > 0 || status === 'active')
  ) {
    return {
      ok: true,
      idempotent: true,
      campaign_id: campaignId,
      queue_result: null,
      lifecycle_result: { ok: true, campaign, from: status, to: status },
      inserted: 0,
      skipped: 0,
      blockers: [],
      from: status,
      to: status,
      campaign,
    }
  }

  const batchLimit = asPositiveInteger(
    input.batch_max ?? input.batchMax ?? input.limit ?? input.max_targets ?? campaign.batch_max,
    null
  )

  let queueResult = null
  let inserted = 0
  let skipped = 0

  if (!existingQueueRows) {
    if (!readyTargets) {
      return {
        ok: false,
        error: 'no_ready_targets',
        blockers: ['No ready targets are available for the initial activation batch.'],
        inserted: 0,
        skipped: 0,
      }
    }

    const launchInput = mergeLaunchWriteModeIntoInput(campaign, {
      ...input,
      dry_run: false,
      create_send_queue_rows: true,
      explicit_operator_action: true,
      batch_max: batchLimit,
      max_targets: batchLimit,
      limit: batchLimit,
      daily_cap: input.daily_cap ?? campaign.daily_cap ?? batchLimit,
      per_sender_cap: input.per_sender_cap ?? campaign.per_sender_cap ?? batchLimit,
      per_market_cap: input.per_market_cap ?? campaign.market_cap ?? batchLimit,
      block_on_global_emergency_stop: false,
    })
    const proofNoSend = launchInput.no_send === true
    queueResult = await createCampaignQueuePlan(campaignId, launchInput, deps)

    inserted = Number(queueResult?.send_queue_rows_created || queueResult?.queue_rows_created || 0)
    skipped = Number(queueResult?.skipped_count || 0)
    const rawBlockers = queueResult?.blockers || queueResult?.exact_blockers || []
    const queueRowsAfterPlan = await countCampaignQueueRows(supabase, campaignId, { activeOnly: true })

    if (rawBlockers.length && queueRowsAfterPlan === 0) {
      return {
        ok: false,
        error: 'activation_blocked',
        blockers: formatActivationBlockers(rawBlockers),
        queue_result: queueResult,
        lifecycle_result: null,
        inserted,
        skipped,
      }
    }
  }

  const queueRowsBeforeActivate = await countCampaignQueueRows(supabase, campaignId, { activeOnly: true })
  if (!queueRowsBeforeActivate) {
    return {
      ok: false,
      error: 'activation_no_queue_rows',
      blockers: ['Activation requires at least one send_queue row, but none were created.'],
      queue_result: queueResult,
      lifecycle_result: null,
      inserted,
      skipped,
    }
  }

  const lifecycleResult = await activateCampaign(supabase, campaignId, { reason, scheduledFor })
  if (!lifecycleResult.ok) {
    return {
      ok: false,
      error: lifecycleResult.error || 'activation_lifecycle_failed',
      blockers: [],
      queue_result: queueResult,
      lifecycle_result: lifecycleResult,
      inserted,
      skipped,
      from: lifecycleResult.from || null,
      to: lifecycleResult.to || 'active',
    }
  }

  if (idempotencyKey) {
    await supabase
      .from('campaigns')
      .update({
        last_activation_idempotency_key: idempotencyKey,
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId)
  }

  await recordCampaignEvent({
    campaign_id: campaignId,
    event_type: 'campaign.activated',
    severity: 'success',
    title: 'Campaign activated',
    description: `Activated with ${inserted} queue rows inserted; ${skipped} targets skipped; ${queueRowsBeforeActivate} total queue rows.`,
    metadata: {
      activation_idempotency_key: idempotencyKey || null,
      inserted,
      skipped,
      queue_row_count: queueRowsBeforeActivate,
      blockers: queueResult?.blockers || [],
      from: lifecycleResult.from || null,
      to: lifecycleResult.to || 'active',
    },
  }, deps)

  return {
    ok: true,
    campaign_id: campaignId,
    queue_result: queueResult,
    lifecycle_result: lifecycleResult,
    inserted,
    skipped,
    blockers: [],
    from: lifecycleResult.from || null,
    to: lifecycleResult.to || 'active',
    campaign: lifecycleResult.campaign || null,
  }
}

/**
 * Operator lifecycle controls. Maps a human action to a canonical state
 * transition and routes it through the concurrency-safe state machine.
 * `activate` also hydrates the initial queue batch; other actions are STATE only.
 */
const CAMPAIGN_LIFECYCLE_ACTIONS = {
  preview: 'built',
  mark_previewed: 'built',
  mark_built: 'built',
  build: 'built',
  queue: 'queued',
  mark_queued: 'queued',
  schedule: 'scheduled',
  unschedule: 'draft',
  begin_activation: 'activating',
  pause: 'paused',
  resume: 'active',
  complete: 'completed',
  fail: 'failed',
  archive: 'archived',
  restore: 'draft',
}

export async function applyCampaignLifecycleAction(campaignId, input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  if (!campaignId) return { ok: false, error: 'campaign_id_required' }
  const action = clean(input.action || input.lifecycle_action)
  const reason = clean(input.reason) || `operator:${action || 'lifecycle'}`
  const scheduledFor = input.scheduled_for || input.scheduledFor || input.first_scheduled_at || null

  if (action === 'convert_to_live' || action === 'convert-to-live') {
    const { convertTestCampaignToLive } = await import('@/lib/domain/campaigns/campaign-convert-to-live.js')
    const result = await convertTestCampaignToLive(campaignId, input, deps)
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        code: result.error,
        campaign_id: campaignId,
        blockers: result.blockers || [],
        from: result.from || null,
        to: result.to || null,
        state: result.state || 'test_mode',
        message: result.message || null,
      }
    }
    return {
      ok: true,
      campaign_id: campaignId,
      action: 'convert_to_live',
      outcome: result.outcome || 'successfully_converted',
      from: result.from,
      to: result.to,
      state: result.state,
      state_label: result.state_label,
      mode: result.mode,
      campaign: result.campaign,
      counts: result.counts,
      schedule: result.schedule,
      purged: result.purged,
      blockers: result.blockers || [],
      warnings: result.warnings || [],
      activation_mode: 'live',
      proof_hydration: false,
      inserted: result.inserted ?? result.activation?.inserted ?? 0,
      auto_send_enabled: result.auto_send_enabled,
      auto_reply_mode: result.auto_reply_mode,
    }
  }

  if (action === 'repair_readiness' || action === 'repair-readiness') {
    const { repairCampaignLaunchPrerequisites } = await import('@/lib/domain/campaigns/campaign-target-template-assignment.js')
    const repair = await repairCampaignLaunchPrerequisites(campaignId, deps)
    if (!repair.ok) return { ok: false, error: repair.error, campaign_id: campaignId }
    const { evaluateCampaignLaunchReadiness } = await import('@/lib/domain/campaigns/campaign-launch-readiness.js')
    const readiness = await evaluateCampaignLaunchReadiness(campaignId, deps, {
      guarded_live_launch: true,
      explicit_operator_action: true,
    })
    return {
      ok: true,
      campaign_id: campaignId,
      action: 'repair_readiness',
      repair,
      readiness,
      activate_now_enabled: readiness.launch_readiness !== 'blocked' && (readiness.launch_ready_recipient_count ?? 0) > 0,
    }
  }

  if (action === 'sync_metrics' || action === 'sync-metrics') {
    const { syncCampaignMetrics } = await import('@/lib/domain/campaigns/campaign-sync-metrics.js')
    const result = await syncCampaignMetrics(campaignId, deps)
    if (!result.ok) return { ok: false, error: result.error, campaign_id: campaignId }
    return {
      ok: true,
      campaign_id: campaignId,
      action: 'sync_metrics',
      counts: result.counts,
      summary: result.summary,
      campaign: result.campaign,
      recomputed: result.recomputed,
    }
  }

  if (action === 'activate') {
    const { runCanonicalCampaignActivation } = await import('@/lib/domain/campaigns/campaign-activation-orchestrator.js')
    const result = await runCanonicalCampaignActivation(campaignId, input, deps)
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        blockers: result.blockers || [],
        queue_result: result.queue_result || null,
        lifecycle_result: result.lifecycle_result || null,
        inserted: result.inserted ?? 0,
        skipped: result.skipped ?? 0,
        from: result.from || null,
        to: result.to || null,
      }
    }
    const campaign = result.campaign || await reloadCampaignRow(supabase, campaignId)
    return {
      ok: true,
      campaign_id: campaignId,
      action,
      from: result.from || result.lifecycle_result?.from || campaign?.status || null,
      to: result.to || result.lifecycle_result?.to || campaign?.status || 'active',
      campaign,
      queue_result: result.queue_result,
      lifecycle_result: result.lifecycle_result,
      inserted: result.inserted,
      skipped: result.skipped,
      blockers: result.blockers || [],
      idempotent: Boolean(result.idempotent),
      degraded: Boolean(result.lifecycle_result?.degraded),
      proof_hydration: Boolean(result.proof_hydration),
      activation_mode: result.activation_mode || (result.proof_hydration ? 'test' : 'live'),
      processor_kickoff: result.processor_kickoff || null,
      sent_count: result.sent_count ?? result.processor_kickoff?.sent_count ?? 0,
    }
  }

  const loaded = await loadCampaignForLifecycle(supabase, campaignId)
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      campaign_id: campaignId,
      diagnostics: loaded.diagnostics || null,
      from: loaded.campaign?.status ?? null,
      to: null,
    }
  }
  const fromStatus = loaded.status

  const target = CAMPAIGN_LIFECYCLE_ACTIONS[action] || (CAMPAIGN_STATES.includes(clean(input.to_status)) ? clean(input.to_status) : null)
  if (!target) return { ok: false, error: `unknown_lifecycle_action:${action || input.to_status || ''}`, from: fromStatus }

  if (action === 'restore') {
    if (fromStatus !== 'archived') {
      return { ok: false, error: 'restore_requires_archived', from: fromStatus, to: 'draft' }
    }
    const result = await transitionCampaignStatus(supabase, campaignId, 'draft', { reason })
    if (!result.ok) return { ok: false, error: result.error, from: result.from || fromStatus, to: 'draft' }
    const campaign = result.campaign || await reloadCampaignRow(supabase, campaignId)
    await recordCampaignEvent({
      campaign_id: campaignId,
      event_type: 'campaign.restored',
      severity: 'info',
      title: 'Campaign restored',
      description: 'Archived campaign restored to draft for editing.',
      metadata: { from: fromStatus, to: 'draft' },
    }, deps)
    return {
      ok: true,
      campaign_id: campaignId,
      action,
      from: fromStatus,
      to: campaign?.status || 'draft',
      campaign,
      degraded: Boolean(result.degraded),
    }
  }

  const isReschedule = action === 'reschedule' || asBoolean(input.reschedule, false)
  if ((action === 'schedule' && isReschedule) || action === 'reschedule') {
    if (['active', 'activating'].includes(fromStatus)) {
      return {
        ok: false,
        error: 'reschedule_requires_pause',
        from: fromStatus,
        to: 'scheduled',
        message: 'Pause the campaign before rescheduling an active launch.',
      }
    }
  }

  if (action === 'schedule' && fromStatus === 'scheduled' && scheduledFor && loaded.campaign?.scheduled_for) {
    const existingMs = new Date(loaded.campaign.scheduled_for).getTime()
    const nextMs = new Date(scheduledFor).getTime()
    if (Number.isFinite(existingMs) && Number.isFinite(nextMs) && existingMs === nextMs) {
      return {
        ok: true,
        idempotent: true,
        campaign_id: campaignId,
        action,
        from: fromStatus,
        to: 'scheduled',
        campaign: loaded.campaign,
      }
    }
  }

  if (action === 'pause' && fromStatus === 'paused') {
    return {
      ok: true,
      idempotent: true,
      campaign_id: campaignId,
      action,
      from: 'paused',
      to: 'paused',
      campaign: loaded.campaign,
    }
  }

  if (action === 'resume' && fromStatus === 'active') {
    return {
      ok: true,
      idempotent: true,
      campaign_id: campaignId,
      action,
      from: 'active',
      to: 'active',
      previous_state: 'active',
      state: 'active',
      campaign: loaded.campaign,
      message: 'Campaign is already active.',
    }
  }

  if (action === 'resume' && fromStatus === 'paused') {
    const { evaluateCampaignLaunchReadiness } = await import('@/lib/domain/campaigns/campaign-launch-readiness.js')
    const { buildCampaignCommandSummary } = await import('@/lib/domain/campaigns/campaign-command-summary.js')
    const readiness = await evaluateCampaignLaunchReadiness(campaignId, deps)
    if (readiness.launch_readiness === 'blocked') {
      const summary = await buildCampaignCommandSummary(campaignId, deps)
      return {
        ok: false,
        error: 'CAMPAIGN_BLOCKED',
        code: 'CAMPAIGN_BLOCKED',
        campaign_id: campaignId,
        action,
        from: fromStatus,
        to: 'paused',
        previous_state: summary.state || 'paused',
        state: summary.state || 'blocked',
        blockers: readiness.blockers || [],
        warnings: readiness.warnings || [],
        counts: summary.counts || {},
        message: 'Resume blocked — resolve readiness gates before going live.',
      }
    }
  }

  if (action === 'archive' && fromStatus === 'archived') {
    return {
      ok: true,
      idempotent: true,
      campaign_id: campaignId,
      action,
      from: 'archived',
      to: 'archived',
      campaign: loaded.campaign,
      queue_rows_cancelled: 0,
    }
  }

  let queueRowsCancelled = 0
  if (action === 'archive' && fromStatus !== 'archived') {
    queueRowsCancelled = await cancelPendingCampaignQueueRows(supabase, campaignId)
  }

  const result = await transitionCampaignStatus(supabase, campaignId, target, { reason, scheduledFor })
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      from: result.from || fromStatus,
      to: result.to || target,
      message: result.message || null,
      diagnostics: result.diagnostics || null,
    }
  }

  const campaign = result.campaign || await reloadCampaignRow(supabase, campaignId)
  if (action === 'archive' && queueRowsCancelled > 0) {
    await recordCampaignEvent({
      campaign_id: campaignId,
      event_type: 'campaign.archived',
      severity: 'warning',
      title: 'Campaign archived',
      description: `Archived with ${queueRowsCancelled} pending queue rows cancelled.`,
      metadata: { queue_rows_cancelled: queueRowsCancelled, from: fromStatus },
    }, deps)
  }

  return {
    ok: true,
    campaign_id: campaignId,
    action: action || null,
    from: result.from || fromStatus,
    to: campaign?.status || result.to || target,
    campaign,
    idempotent: Boolean(result.idempotent),
    degraded: Boolean(result.degraded),
    queue_rows_cancelled: queueRowsCancelled || undefined,
  }
}

export async function getCampaignAwareQueueDiagnostics(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const list = await listCampaigns(deps)
  const activeCampaign = list.campaigns.find((campaign) => isLiveCampaignStatus(campaign.status)) || null
  const campaignIds = list.campaigns.map((campaign) => campaign.id)
  let queueRows = []
  let targetRows = []
  if (campaignIds.length) {
    const [{ data }, { data: targetData }] = await Promise.all([
      supabase
      .from('send_queue')
      .select('id,campaign_id,queue_status,guard_reason,blocked_reason,failed_reason,scheduled_for,metadata')
      .in('campaign_id', campaignIds)
      .in('queue_status', ACTIVE_QUEUE_STATUSES)
      .limit(10000),
      supabase
        .from('campaign_targets')
        .select('id,campaign_id,target_status,block_reason,identity_status,routing_status,suppression_status,template_status')
        .in('campaign_id', campaignIds)
        .limit(20000),
    ])
    queueRows = data || []
    targetRows = targetData || []
  }
  const queueDepthByCampaign = {}
  const blockedReasonCounts = {}
  const targetDepthByCampaign = {}
  const targetStatusCounts = {}
  for (const row of queueRows) {
    increment(queueDepthByCampaign, row.campaign_id)
    const reason = clean(row.guard_reason || row.blocked_reason || row.failed_reason || row.metadata?.routing_block_reason)
    if (reason) increment(blockedReasonCounts, reason)
  }
  for (const target of targetRows) {
    increment(targetDepthByCampaign, target.campaign_id)
    increment(targetStatusCounts, target.target_status || 'unknown')
    if (target.block_reason) increment(blockedReasonCounts, target.block_reason)
    if (target.identity_status === 'blocked') increment(blockedReasonCounts, 'identity_blocked')
    if (target.routing_status === 'blocked') increment(blockedReasonCounts, 'routing_blocked')
    if (target.suppression_status === 'blocked') increment(blockedReasonCounts, 'suppression_blocked')
    if (target.template_status === 'blocked') increment(blockedReasonCounts, 'template_blocked')
  }
  return {
    active_campaign: activeCampaign,
    campaign_queue_depth: queueRows.length,
    campaign_queue_depth_detail: {
      active_queue_rows: queueRows.length,
      total_targets: targetRows.length,
      ready_targets: Number(targetStatusCounts.ready || 0),
      planned_targets: Number(targetStatusCounts.planned || 0),
      queued_targets: Number(targetStatusCounts.queued || 0),
      blocked_targets: Number(targetStatusCounts.blocked || 0),
      by_target_status: targetStatusCounts,
    },
    queue_depth_by_campaign: queueDepthByCampaign,
    target_depth_by_campaign: targetDepthByCampaign,
    next_send_window: activeCampaign?.next_send_window || null,
    blocked_reason_counts: blockedReasonCounts,
    campaigns: list.campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.campaign_name,
      status: campaign.status,
      ready_targets: campaign.ready_targets,
      scheduled_targets: campaign.scheduled_targets,
      next_send_at: campaign.next_send_at,
    })),
  }
}

export { computeWindowForTimezone }
