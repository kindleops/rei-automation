import crypto from 'node:crypto'
import { isTemplateHoldReason } from '@/lib/domain/campaigns/campaign-template-hold.js'
import { cappedSendableTemplateIds, governanceApplies, governanceExcludedTemplateIds, loadGovernance, loadTemplateUsedToday, UNGOVERNED_POLICY } from '@/lib/domain/campaigns/template-governance.js'
import { effectivePerSenderCap, loadConfiguredPerSenderCap } from '@/lib/domain/campaigns/sender-capacity.js'
import { isSenderDispatchBlocked, isTemplateDispatchBlocked, loadDispatchBlockedSets } from '@/lib/domain/delivery/sms-health-guard.js'
import { evaluateRecontactOverride } from '@/lib/domain/campaigns/recontact-override-authority.js'
import { evaluateCampaignResumeReadiness } from '@/lib/domain/campaigns/campaign-resume-readiness.js'
import { isInternalTestPhone } from '@/lib/config/internal-phones.js'
import {
  INTERNAL_CANARY_SOURCE,
  isInternalCanaryAudienceRequested,
  resolveInternalCanaryAudience,
} from '@/lib/domain/campaigns/canary-audience-source.js'

import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { buildSendQueueDedupeKey } from '@/lib/supabase/sms-engine.js'
import { observeCampaignBatchInsert } from '@/lib/domain/intelligence/runtime/observation.js'
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
  countSendableSendersByMarket,
  getSupabaseFeederCandidates,
  loadTextgridNumberFleet,
  prefetchRecentTemplateHistory,
  recentTemplateIdsFromHistory,
  renderOutboundTemplate,
} from '@/lib/domain/outbound/supabase-candidate-feeder.js'
import { readGraphFunnelCounts } from '@/lib/domain/campaigns/campaign-graph-funnel.js'
import {
  applyGraphFilter,
  describeFilterExpansions,
  graphColumnForField,
  INAPPLICABLE_REASONS,
  loadGraphColumnPopulation,
  graphPlanColumns,
  resolveGraphFilterPlan,
} from '@/lib/domain/campaigns/campaign-graph-filter-plan.js'
import {
  campaignGraphQuery,
  drawnAreaFromFilters,
  drawnAreaReasonMessage,
  DRAWN_AREA_FIELD_KEY,
  DRAWN_AREA_PROPERTY_COUNT_RPC,
  normalizeDrawnArea,
} from '@/lib/domain/campaigns/campaign-drawn-area.js'
import { evaluatePreSendEligibility } from '@/lib/domain/outbound/presend-eligibility-engine.js'
import { evaluateOpenerReplyExclusion, loadOpenerReplyFacts, phoneKey, phoneLookupVariants } from '@/lib/domain/campaigns/opener-reply-exclusion.js'
import { isValidIanaTimezone } from '@/lib/domain/acquisition-brain/shadow-burst-timing.js'
import { resolveTimezone } from '@/lib/sms/latency.js'
import { campaignMarketIdentityPatch, summarizeCampaignMarketIdentity } from '@/lib/domain/campaigns/campaign-market-identity.js'
import { deriveTimezoneFromGeography } from '@/lib/domain/campaigns/contact-window-timezone.js'
import { resolveRecipientTimezone } from '@/lib/domain/queue/recipient-timezone.js'
import { loadCanonicalMarketDirectory, resolveMarketLabel } from '@/lib/domain/geography/canonical-market.js'
import { targetLanguageHold } from '@/lib/sms/language_aliases.js'
import { greetingPersonalization, isUniverseFilter, sendableAfterLanguageHolds, sendableAfterPersonalization, summarizeLanguageHolds, summarizePersonalization } from '@/lib/domain/campaigns/campaign-audience-funnel.js'
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
  applySupabaseFilter,
  applySupabaseFilters,
  applySupabaseFilterToColumn,
  coerceScalarArray,
  EMPTY_FILTER_OPERATORS,
  filterColumn,
  filterScalarValues,
  hasMeaningfulFilterValue,
  isSafeIdentifier,
  normalizeFilterArrayInput,
  normalizePreviewFilterValue,
  normalizePreviewOperator,
  numberOrNull,
} from '@/lib/domain/campaigns/campaign-field-filter-compiler.js'
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
import { CAMPAIGN_CAP_COLUMNS, isValidCampaignCapInput, parseCampaignCap, zeroCampaignCaps } from '@/lib/domain/campaigns/campaign-caps.js'
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
  /**
   * §3 — the internal proof audience is a FIRST-CLASS SOURCE, not a special
   * case bolted onto the graph path. It has to be listed here or
   * `previewSourcePlan` normalizes it away to the production default, which is
   * precisely the silent fallback that would have targeted real sellers while
   * reporting that a canary cohort had been requested.
   *
   * Listing it grants nothing on its own: resolution still requires internal
   * authorization and explicit proof intent, and every destination is
   * re-checked against the approved registry.
   */
  INTERNAL_CANARY_SOURCE,
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

export function normalizeCampaignInput(payload = {}, existing = {}) {
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

  // A payload that carries the targeting decides the market: it is the first
  // market filter, or none. Falling back to the stored value kept a market the
  // operator had removed (label/timezone only — it no longer narrows a build).
  const carriesTargeting = hasCatalogFilterGroups(filters)
  const row = {
    ...(name ? { name } : {}),
    description: payload.description ?? existing.description ?? null,
    status: clean(payload.status || existing.status || 'draft') || 'draft',
    objective: objective || null,
    candidate_source: candidateSource,
    market: clean(payload.market || extractMarketFromCatalogFilters(filters) || firstArrayValue(filters.markets) || (carriesTargeting ? '' : existing.market)) || null,
    state: clean(payload.state || firstArrayValue(filters.states) || (carriesTargeting ? '' : existing.state)) || null,
    language_policy: clean(payload.language_policy || filters.language || existing.language_policy || 'auto') || 'auto',
    agent_persona: clean(payload.agent_persona || filters.agent_persona || existing.agent_persona) || null,
    daily_cap: parseCampaignCap(payload.daily_cap ?? filters.daily_cap ?? existing.daily_cap),
    // campaign_size 'all' (Composer's explicit "All eligible") clears the cap;
    // otherwise an absent/null total_cap keeps the existing one, as before.
    total_cap: payload.campaign_size === 'all' ? null : parseCampaignCap(payload.total_cap ?? filters.total_cap ?? existing.total_cap),
    batch_max: optionalInt(payload.batch_max ?? filters.batch_max ?? filters.max_batch_size ?? existing.batch_max),
    market_cap: parseCampaignCap(payload.market_cap ?? filters.market_cap ?? existing.market_cap),
    per_sender_cap: parseCampaignCap(payload.per_sender_cap ?? filters.per_sender_cap ?? filters.per_number_cap ?? existing.per_sender_cap),
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
      /**
       * Canonical stage codes only (S1, S2…). The builder sends its own
       * vocabulary ('first_touch'), which was saved verbatim; every reader
       * then had to re-normalize it, and any that didn't matched no template.
       * An update that doesn't mention the stage keeps the existing one
       * instead of silently resetting it to S1.
       */
      stage_code: normalizeCampaignStageCode(
        payload.stage_code || metadata.stage_code || filters.stage_code || existing.metadata?.stage_code,
        'S1'
      ),
      launch_timezone: clean(payload.metadata?.launch_timezone || payload.launch_timezone || metadata.launch_timezone || existing.metadata?.launch_timezone) || null,
      timezone: clean(payload.metadata?.timezone || payload.timezone || metadata.timezone || existing.metadata?.timezone) || null,
    },
  }
  // Once a build has derived the cohort's zone(s) (campaign-market-identity),
  // a config save does not overwrite them with the builder's guess; the next
  // build re-derives from the new cohort.
  const existingIdentity = metadataObject(existing.metadata).market_identity
  if (existingIdentity && typeof existingIdentity === 'object') {
    row.metadata.market_identity = existingIdentity
    row.metadata.timezone = clean(existing.metadata?.timezone) || null
    row.metadata.launch_timezone = clean(existing.metadata?.launch_timezone) || null
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

export async function recordCampaignEvent(fields = {}, deps = {}) {
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
  let drawnAreaSeen = false

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
      // A drawn map area is a polygon, not a value list: validate it as one,
      // and never let a broken or second area pass silently (dropped with a
      // reason other than empty_filter_value, so Build refuses it by name).
      if (field.type === 'geo_area') {
        const area = normalizeDrawnArea(filter.value ?? filter.values ?? null)
        const reason = !area.ok ? area.reason : drawnAreaSeen ? 'multiple_drawn_areas' : null
        if (reason) {
          dropped.push({
            domain,
            field_key: field.key,
            fieldKey: field.key,
            label: field.label,
            operator: 'within',
            value: null,
            reason,
            message: `Not applied: ${drawnAreaReasonMessage(reason)}`,
          })
          continue
        }
        drawnAreaSeen = true
        const normalizedArea = {
          field_key: field.key,
          field: 'drawn_area',
          domain: field.domain,
          category: field.category,
          label: field.label,
          operator: 'within',
          value: area.area,
          source_column: null,
          supported_in_preview: true,
        }
        applied.push(normalizedArea)
        supported.push({ ...normalizedArea, fieldDefinition: field })
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

/**
 * A market/state the BUILD derived from its own cohort (campaign-market-identity)
 * describes the campaign; it is not targeting. Only an operator-set value may
 * narrow a later build — otherwise a derived "Dallas, TX" would quietly turn an
 * unfiltered campaign into a Dallas campaign instead of refusing it.
 */
function derivedIdentityMarket(campaign) {
  const identity = metadataObject(campaign?.metadata).market_identity
  return identity && identity.kind === 'single_market' ? clean(identity.markets?.[0]?.market_name) : ''
}
function storedTargetingMarket(campaign) {
  const stored = clean(campaign?.market)
  return stored && stored === derivedIdentityMarket(campaign) ? '' : stored
}
function storedTargetingState(campaign) {
  const stored = clean(campaign?.state)
  const identity = metadataObject(campaign?.metadata).market_identity
  const derivedState = identity && identity.kind === 'single_market' ? clean(identity.markets?.[0]?.state) : ''
  return stored && derivedIdentityMarket(campaign) && clean(campaign?.market) === derivedIdentityMarket(campaign) && stored === derivedState ? '' : stored
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
    // Proof intent must reach the resolver; it is one half of the canary gate.
    internal_proof_intent: input.internal_proof_intent === true,
    canary_phones: Array.isArray(input.canary_phones) ? input.canary_phones : null,
    received_source: sourcePlan.receivedSource,
    source_normalization_reason: sourcePlan.reason,
    source_warnings: sourcePlan.warnings,
    /**
     * THE FILTERS THE OPERATOR SEES ARE THE ONLY NARROWING.
     *
     * A single top-level market/state (the first market chip, or whatever the
     * campaign row last held) used to be applied ON TOP of the catalog filters
     * as `market = X`. So "Miami, Chicago, Dallas, LA, Phoenix, Houston" built
     * 854 targets, all Miami; and "75+ ACQ SCORE" — no market filter at all —
     * built Miami only, because the campaign row still carried Miami from an
     * earlier edit. Catalog campaigns narrow by their catalog filters alone
     * (a market filter is one of them); the top-level value only narrows a
     * campaign with no applicable catalog filter. Without that, a campaign
     * whose filter groups are all empty ("LA - TEST") would build every seller
     * in every market; with no market either, the build refuses.
     */
    market: catalogFilters.has_catalog_filters && catalogFilters.supported.length
      ? null
      : clean(input.market || storedTargetingMarket(campaign) || firstArrayValue(mergedFilters.markets)) || null,
    state: catalogFilters.has_catalog_filters && catalogFilters.supported.length
      ? null
      : clean(input.state || storedTargetingState(campaign) || firstArrayValue(mergedFilters.states)) || null,
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
    daily_cap: parseCampaignCap(campaign?.daily_cap),
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
  // Canonical person identity. The graph populates this
  // (seller.property_owner_resolution_v1) while prospect_id/phone_id are
  // retired provenance and always NULL, so omitting it from the projection is
  // what left every graph-sourced target without a person.
  'seller_person_key',
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
/**
 * Field → audience column mapping and every audience predicate live in
 * campaign-graph-filter-plan.js — the one place Reach, Build and the builder's
 * field list read. (This file kept its own copy, with metric substitutions and
 * whole-string equality on ';'-joined tag lists.)
 */

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

function graphApplicationColumn(filter = {}) {
  return graphColumnForField(filter)
}

/**
 * Resolve catalog filters against the audience: applicable ones carry their
 * column; the rest are reported with the reason they can't narrow a campaign
 * (no audience column, or no audience data). Preview reports them; Build
 * refuses them — neither ever applies a different predicate than the other.
 */
function resolveCatalogFiltersForTargetGraph(catalogFilters = {}, { population = null } = {}) {
  const plan = resolveGraphFilterPlan(catalogFilters.supported || [], { population })
  const supported = plan.applicable.map((filter) => ({
    ...filter,
    preview_column: filter.graph_column,
    preview_columns: [filter.graph_column],
    preview_mapping: {
      field_key: filter.field_key,
      graph_column: filter.graph_column,
      preview_column: filter.graph_column,
      preview_columns: [filter.graph_column],
    },
    applied_in_preview: true,
  }))
  const inapplicable = plan.inapplicable.map((filter) => ({
    ...publicFilter(filter),
    label: filter.label,
    supported_in_preview: false,
    applied_in_preview: false,
    campaign_applicable: false,
    unsupported_reason: filter.reason,
    reason: filter.reason,
    message: `Not applied: ${filter.message}`,
  }))

  const unsupported = [
    ...(catalogFilters.unsupported || []).map((filter) => ({
      ...publicFilter(filter),
      supported_in_preview: false,
      applied_in_preview: false,
      unsupported_reason: filter.unsupported_reason || 'unsupported_in_target_graph',
      message: filter.message || `Not applied: ${INAPPLICABLE_REASONS.not_in_audience}`,
    })),
    ...inapplicable,
  ]
  const unknown = (catalogFilters.unknown || []).map((filter) => ({
    ...publicFilter(filter),
    supported_in_preview: false,
    applied_in_preview: false,
    unsupported_reason: 'unknown_campaign_field',
    message: `Not applied: ${INAPPLICABLE_REASONS.unknown_field}`,
  }))

  return {
    ...catalogFilters,
    unknown,
    supported,
    unsupported,
    inapplicable,
    applied: [
      ...supported.map(publicFilter),
      ...unsupported,
      ...unknown,
    ],
    pre_filters: supported.filter((filter) => !SENDER_COVERAGE_FIELDS.has(filter.field_key)),
    sender_filters: supported.filter((filter) => SENDER_COVERAGE_FIELDS.has(filter.field_key)),
  }
}

/**
 * Which audience columns carry any data (cached probe). Only against the
 * production client: a caller that injects its own client (tests, scripts)
 * passes `graphColumnPopulation` itself or gets mapping-only answers.
 */
async function resolveGraphColumnPopulation(deps = {}, catalogFilters = null) {
  if (deps.graphColumnPopulation instanceof Map) return deps.graphColumnPopulation
  if (deps.supabase) return null
  // Only the columns this request's filters consult (the plan reads nothing else).
  const columns = catalogFilters ? graphPlanColumns(catalogFilters.supported || []) : null
  return loadGraphColumnPopulation(defaultSupabase, columns ? { columns } : {}).catch(() => null)
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
  // Only filters the plan resolved as applicable reach here (see
  // resolveCatalogFiltersForTargetGraph); one predicate for Reach and Build.
  for (const filter of options.catalog_filters?.supported || []) {
    query = applyGraphFilter(query, filter)
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
  let query = campaignGraphQuery(supabase, {
    area: drawnAreaFromFilters(options.catalog_filters?.supported),
    table: CAMPAIGN_TARGET_GRAPH_TABLE,
    columns: 'graph_id',
    selectOptions: { count: 'exact', head: true },
  })
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
  // With a drawn area the audience is the exact polygon cohort, resolved in the
  // database; the same order and paging apply on top, so Reach and Build agree.
  const area = drawnAreaFromFilters(options.catalog_filters?.supported)
  for (let offset = 0; offset < cappedLimit; offset += CAMPAIGN_TARGET_GRAPH_PAGE_SIZE) {
    let query = campaignGraphQuery(supabase, { area, table: CAMPAIGN_TARGET_GRAPH_TABLE, columns: selectColumns })
      .order('queue_eligible', { ascending: false, nullsFirst: false })
      .order('acquisition_score', { ascending: false, nullsFirst: false })
      .order('best_phone_score', { ascending: false, nullsFirst: false })
      // A total order: without the key, ~65k rows tie on a NULL score, so
      // range pages could repeat or skip rows and two reads of the same
      // audience (Reach, then Build) could pick different sellers.
      .order('graph_id', { ascending: true })
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
  // A drawn area's universe is every property inside it. Other property
  // filters would narrow it further, which this count can't apply on top of
  // the area, so it is then an upper bound and says so.
  const area = drawnAreaFromFilters(options.catalog_filters?.supported)
  if (area) {
    const otherPropertyFilters = (options.catalog_filters?.supported || [])
      .filter((filter) => clean(filter.field_key || filter.fieldKey).startsWith('properties.') && clean(filter.field_key || filter.fieldKey) !== DRAWN_AREA_FIELD_KEY)
    const { data, error } = await supabase.rpc(DRAWN_AREA_PROPERTY_COUNT_RPC, { p_area: area })
    if (error) {
      return { ok: false, count: null, approximate: true, warnings: [`addressable_universe_unavailable:${errorMessage(error)}`] }
    }
    return { ok: true, count: Number(data || 0), approximate: otherPropertyFilters.length > 0, warnings: [] }
  }
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
    // Same predicate as the audience (property-type families included), so
    // the addressable universe and the matched audience count one thing.
    query = key === 'properties.property_type'
      ? applyGraphFilter(query, { ...filter, graph_column: column })
      : applySupabaseFilterToColumn(query, filter, column)
  }

  const { count, error } = await query
  if (error) {
    return { ok: false, count: null, approximate, warnings: [`addressable_universe_unavailable:${errorMessage(error)}`] }
  }
  return { ok: true, count: Number(count || 0), approximate, warnings: [] }
}

/**
 * Reach's funnel buckets: each is the audience predicate AND its own extra.
 * Counted in one statement when the funnel rpc is available (campaign-graph-
 * funnel.js records these exact builder calls), else one count per bucket.
 */
const NOT_SUPPRESSED_SMS = (query) => query.eq('sms_eligible', true).eq('true_post_contact_suppression', false).eq('wrong_number', false)
const GRAPH_FUNNEL_BUCKETS = Object.freeze([
  { key: 'total' },
  { key: 'linkedMasterOwners', extra: (query) => query.not('master_owner_id', 'is', null) },
  { key: 'linkedProspects', extra: (query) => query.not('prospect_id', 'is', null) },
  { key: 'reachableContacts', extra: (query) => query.not('canonical_e164', 'is', null) },
  { key: 'smsEligible', extra: (query) => query.eq('sms_eligible', true) },
  { key: 'cleanTargets', extra: NOT_SUPPRESSED_SMS },
  { key: 'senderCovered', extra: (query) => NOT_SUPPRESSED_SMS(query).eq('sender_covered', true) },
  { key: 'readyToQueue', requireQueueEligible: true },
  { key: 'smsBlocked', extra: (query) => query.eq('sms_eligible', false).not('canonical_e164', 'is', null) },
  { key: 'missingPhone', extra: (query) => query.is('canonical_e164', null) },
  { key: 'suppressed', extra: (query) => query.eq('true_post_contact_suppression', true) },
  { key: 'wrongNumber', extra: (query) => query.eq('wrong_number', true) },
  { key: 'pendingPriorTouch', extra: (query) => query.eq('pending_prior_touch', true) },
  { key: 'activeQueue', extra: (query) => query.eq('active_queue_item', true) },
  { key: 'noSenderCoverage', extra: (query) => NOT_SUPPRESSED_SMS(query).eq('sender_covered', false) },
])

async function countCampaignGraphFunnel({ supabase, options }) {
  // A drawn area resolves its rows through its own rpc: per-bucket counts.
  const area = drawnAreaFromFilters(options.catalog_filters?.supported)
  const fast = area ? null : await readGraphFunnelCounts({
    supabase,
    base: (query) => applyCampaignGraphFilters(query, options, []),
    buckets: GRAPH_FUNNEL_BUCKETS.map((bucket) => ({
      key: bucket.key,
      apply: (query) => {
        let q = typeof bucket.extra === 'function' ? bucket.extra(query) : query
        if (bucket.requireQueueEligible) q = q.eq('queue_eligible', true)
        return q
      },
    })),
  }).catch(() => null)
  if (fast) {
    return Object.fromEntries(GRAPH_FUNNEL_BUCKETS.map((bucket) => [bucket.key, { ok: true, count: fast[bucket.key], warnings: [] }]))
  }
  const results = await Promise.all(GRAPH_FUNNEL_BUCKETS.map((bucket) => countCampaignGraphRows({
    supabase,
    options,
    ...(bucket.extra ? { extra: bucket.extra } : {}),
    ...(bucket.requireQueueEligible ? { requireQueueEligible: true } : {}),
  })))
  return Object.fromEntries(GRAPH_FUNNEL_BUCKETS.map((bucket, index) => [bucket.key, results[index]]))
}

async function summarizeCampaignGraph({ supabase, options, rowLimit, requireQueueEligibleRows = false }) {
  // Independent reads started together. The refresh status (an exact count of
  // the WHOLE graph — ~1 s, and it times out at 8 s when it competes with the
  // funnel counts during a reconcile) starts once the funnel is done, beside
  // the page read, instead of after everything.
  const funnelRead = countCampaignGraphFunnel({ supabase, options })
  const [funnel, rows, addressable, graphRefreshStatus] = await Promise.all([
    funnelRead,
    fetchCampaignGraphRows({
      supabase,
      options,
      limit: rowLimit,
      requireQueueEligible: requireQueueEligibleRows,
    }),
    countAddressableProperties({ supabase, options }),
    funnelRead.then(() => readCampaignGraphRefreshStatus(supabase), () => readCampaignGraphRefreshStatus(supabase)),
  ])
  const {
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
  } = funnel

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

export function graphDistributionCounts(rows = []) {
  const counts = {
    markets: {},
    languages: {},
    propertyTypes: {},
    matchingFlags: {},
    routingTiers: {},
    recipientZones: {},
    zips: {},
  }
  for (const row of rows) {
    increment(counts.markets, row.market || 'unknown')
    increment(counts.languages, row.language || 'unknown')
    increment(counts.propertyTypes, row.canonical_property_group || row.property_type || 'unknown')
    incrementListValues(counts.matchingFlags, row.matching_flags_text || 'unknown')
    increment(counts.routingTiers, row.routing_tier || 'unknown')
    // The dispatch resolver's own answer (property geography first, a valid
    // stored zone second, else unresolved = held) — never a default zone.
    const zone = resolveRecipientTimezone({ timezone: row.timezone, property_address_state: row.state, property_address_zip: row.property_zip })
    increment(counts.recipientZones, zone.ok ? zone.iana : 'unresolved')
    if (row.property_zip) increment(counts.zips, String(row.property_zip).slice(0, 5))
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
  /**
   * IDENTITY LINKAGE, READ FROM THE CANONICAL SCHEMA.
   *
   * This required `master_owner_id` AND `prospect_id` AND `phone_id` AND
   * `canonical_e164` together. Three of those four are legacy identifiers from
   * the retired `public.phones` export, and the canonical graph builder
   * deliberately leaves them NULL — its own comment says
   * "prospect_id / phone_id do not exist anywhere in the seller schema, so they
   * stay NULL provenance rather than being manufactured from the stale
   * public.phones export (which covers only 37.7% of the modern corpus)".
   *
   * Measured 2026-09-15 across all 169,797 graph rows:
   *   prospect_id       0
   *   phone_id          0
   *   master_owner_id   41,532  (26% of Individual, 12.5% of Corporate — legacy, not entity-only)
   *   seller_person_key 138,680
   *   canonical_e164    136,127
   *
   * So the gate was not strict, it was BROKEN CLOSED: no graph-sourced target
   * could ever be campaign-ready, which is exactly what production showed.
   *
   * Person identity is now `seller_person_key`
   * (seller.property_owner_resolution_v1.individual_key, via
   * COALESCE(sel_person_key, individual_key)), with the legacy prospect ids
   * still accepted so older rows that do carry them keep working. The phone is
   * `canonical_e164`, which the builder joins from seller.owner_phone ON THE
   * SAME individual_key — so the number provably belongs to the resolved
   * person rather than being the property's first available phone.
   *
   * `master_owner_id` is provenance "where applicable", not a gate: it is
   * absent on three quarters of rows across every ownership shape, and its
   * absence says nothing about whether a real person is reachable.
   *
   * Nothing else is relaxed. queue_eligible still carries sms_eligible /
   * suppression / wrong_number / pending_prior_touch / active_queue_item /
   * sender_covered, and identity_alignment, timezone and phone-ownership
   * ambiguity are all still enforced below.
   */
  const personKey = clean(row.seller_person_key)
    || clean(row.prospect_id)
    || clean(row.canonical_prospect_id)
  const phoneKey = clean(row.canonical_e164) || clean(row.phone_id)
  const hasLinkage = Boolean(personKey && phoneKey)
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
      /**
       * An entity-owned property whose person link the canonical source flags
       * for review has no defensible contact, so it stays blocked however well
       * the rest of the linkage resolves. seller.property_entity_contact_v1
       * raises this via ENT_ROLE_UNCORROBORATED / ENT_NO_REGISTRY_LINK, and
       * 19,346 queue-eligible entity contacts carry it.
       */
      : row.entity_contact_requires_review === true
        ? 'entity_contact_requires_review'
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
  /**
   * The person the target refers to, in canonical terms first.
   *
   * `prospect_id` is a retired identifier the graph no longer populates, so a
   * target built today carried a NULL person and the downstream queue plan had
   * nothing to identify the recipient by. `seller_person_key` is the canonical
   * person (seller.property_owner_resolution_v1), and the legacy ids are kept
   * as a fallback so rows that still have them are unchanged.
   */
  const prospectId = clean(row.prospect_id)
    || clean(row.canonical_prospect_id)
    || clean(row.seller_person_key)
    || null
  const readiness = resolveCampaignTargetReadiness(row)
  return {
    campaign_id: campaignId,
    campaign_key: `ct:${campaignId || 'preview'}:${clean(row.graph_id) || crypto
      .createHash('sha1')
      // phone_id is always NULL on the modern graph, so it contributes nothing
      // to this hash; the canonical person key is what distinguishes two
      // recipients on the same property.
      .update([
        row.master_owner_id,
        row.property_id,
        clean(row.seller_person_key) || row.phone_id,
        row.canonical_e164,
        index,
      ].join('|'))
      .digest('hex')
      .slice(0, 24)}`,
    campaign_name: campaign?.name || null,
    market: clean(row.market) || clean(campaign?.market) || 'unknown',
    asset_type: clean(row.canonical_property_group || row.property_type || 'campaign_automation'),
    strategy: clean(campaign?.objective || options.template_use_case || row.template_use_case || 'ownership_check') || 'ownership_check',
    /**
     * The seller's language, or nothing.
     *
     * This used to fall back to `campaign.language_policy`, which is 'auto' on
     * every campaign — a policy token meaning "decide automatically", not a
     * language. It was then applied as a literal template filter
     * (`.ilike("language","auto")`), matching none of the 8,784 templates, so
     * 997 of 2,587 existing targets are untemplatable for that reason alone.
     *
     * A known language now comes from the canonical sources; when it is
     * genuinely unknown the field stays NULL and the resolver's documented
     * English default applies. Storing 'auto' as if it were a language is what
     * broke template selection.
     */
    language: clean(row.resolved_language || row.language) || null,
    source_view_name: CAMPAIGN_TARGET_GRAPH_TABLE,
    daily_cap: parseCampaignCap(campaign?.daily_cap),
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
      /**
       * §6 — how the language was decided, so a rendered message can be
       * explained without guessing: 'prospect' and 'master_owner' are canonical
       * seller data; 'unknown' means the resolver's documented default applies.
       */
      language_source: clean(row.resolved_language_source) || (clean(row.language) ? 'graph' : 'unknown'),
      language_known: Boolean(clean(row.resolved_language || row.language)),
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
        seller_name_source: row.seller_name_source || (clean(row.seller_first_name) ? 'graph' : null),
        seller_person_key: clean(row.seller_person_key) || null,
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

/** The send limit a build would use, as Reach must simulate it. */
export const DEFAULT_PREVIEW_BUILD_LIMIT = 1000

export function resolvePreviewBuildLimit(input = {}, campaign = null) {
  const requested = asPositiveInteger(
    input.build_limit ?? input.max_targets ?? input.total_cap ?? campaign?.total_cap,
    DEFAULT_PREVIEW_BUILD_LIMIT
  ) || DEFAULT_PREVIEW_BUILD_LIMIT
  const simulated = Math.max(1, Math.min(requested, CAMPAIGN_TARGET_GRAPH_PREVIEW_LIMIT))
  return { requested, simulated, capped_by_preview: simulated < requested }
}

/**
 * Reach's answer, computed the way Build computes it (planCampaignTargetRows)
 * plus whether a sender can carry each ready seller's first text today (the
 * planner's own router). Read-only.
 */
async function simulateCampaignBuild({ campaign, options, graph, buildLimit, deps }) {
  try {
    const planned = await planCampaignTargetRows({
      campaign,
      options,
      graph,
      targetLimit: buildLimit.simulated,
      deps,
      resolveLanguages: false,
    })
    const readyRows = planned.rows.filter((row) => row.target_status === 'ready')
    const { evaluateAudienceSenderCoverage } = await import('@/lib/domain/campaigns/campaign-launch-readiness.js')
    const senders = await evaluateAudienceSenderCoverage(readyRows, deps).catch(() => null)
    const languageHolds = summarizeLanguageHolds(readyRows)
    return {
      ok: true,
      source: 'build_simulation',
      eligible_in_audience: Number(graph.readyToQueue || 0),
      requested_limit: buildLimit.requested,
      simulated_limit: buildLimit.simulated,
      capped_by_preview: buildLimit.capped_by_preview,
      ...planned.summary,
      sendable_now: senders ? senders.sendable_now : null,
      no_sendable_number: senders ? senders.no_sendable_number : null,
      sender_markets: senders ? senders.markets : [],
      // ready sellers the renderer refuses for language (same predicate)
      language_holds: languageHolds,
      sendable_after_language: senders ? sendableAfterLanguageHolds(senders.sendable_now, senders.markets, languageHolds) : null,
    }
  } catch (error) {
    return { ok: false, source: 'build_simulation', error: errorMessage(error) }
  }
}

async function previewCampaignTargetsFromGraph(input = {}, deps = {}) {
  const startedAt = Date.now()
  const supabase = deps.supabase || defaultSupabase
  const campaign = input.campaign || null
  const baseOptions = previewOptionsFromInput(input, campaign)
  const population = await resolveGraphColumnPopulation(deps, baseOptions.catalog_filters)
  const options = {
    ...baseOptions,
    catalog_filters: resolveCatalogFiltersForTargetGraph(baseOptions.catalog_filters, { population }),
  }
  options.target_limit = Math.max(1, Math.min(options.target_limit || CAMPAIGN_TARGET_GRAPH_PREVIEW_LIMIT, CAMPAIGN_TARGET_GRAPH_PREVIEW_LIMIT))
  const buildLimit = resolvePreviewBuildLimit(input, campaign)

  if (!supabase) {
    return {
      ok: false,
      error: 'CAMPAIGN_TARGET_GRAPH_UNAVAILABLE',
      warnings: ['campaign_target_graph_supabase_unavailable'],
      queryMs: Date.now() - startedAt,
    }
  }

  // The same rows Build reads: queue-eligible, same order, same limit.
  const graph = await summarizeCampaignGraph({
    supabase,
    options,
    rowLimit: buildLimit.simulated,
    requireQueueEligibleRows: true,
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

  const buildSimulation = await simulateCampaignBuild({ campaign, options, graph, buildLimit, deps })
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
  // 0 = send nothing, null = no daily cap (campaign-caps.js).
  const dailyCap = parseCampaignCap(input.daily_cap ?? campaign?.daily_cap ?? options.filters.daily_cap)
  const queueableToday = dailyCap !== null ? Math.min(graph.readyToQueue, dailyCap) : graph.readyToQueue
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
    recipientZones: bucketArray(distributionsCounts.recipientZones),
    zips: bucketArray(distributionsCounts.zips),
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
    headline_metric: buildSimulation.ok ? 'build_simulation.ready' : 'ready_to_queue',
    headline_count: buildSimulation.ok ? buildSimulation.ready : graph.readyToQueue,
    /**
     * What Build will produce with these filters and this send limit — the
     * number Reach leads with. ready_to_queue stays the graph's
     * queue-eligible count (the audience before the limit, the one-per-phone
     * collapse and the review/identity holds).
     */
    build_simulation: buildSimulation,
    filter_notes: describeFilterExpansions(options.catalog_filters.supported || []),
    inapplicable_filters: (options.catalog_filters.inapplicable || []).map((filter) => ({
      field_key: filter.field_key,
      label: filter.label,
      reason: filter.reason,
      message: filter.message,
    })),
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
  // 0 = send nothing, null = no daily cap (campaign-caps.js).
  const dailyCap = parseCampaignCap(input.daily_cap ?? input.campaign?.daily_cap ?? effectiveOptions.filters.daily_cap)
  const queueableToday = dailyCap !== null ? Math.min(readyToQueueCount, dailyCap) : readyToQueueCount
  const candidateWindowQueueableToday = dailyCap !== null ? Math.min(summary.ready_to_queue, dailyCap) : summary.ready_to_queue
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

const EXECUTION_PROOF_PROOF_ROW_LIMIT = 50

async function fetchCampaignExecutionProof(supabase, campaignId, campaign = {}) {
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
      .limit(EXECUTION_PROOF_PROOF_ROW_LIMIT),
  ])
  if (activeError) throw activeError
  if (proofError) throw proofError
  return reduceCampaignExecutionProof(campaign, activeRows || [], proofRows || [])
}

/**
 * The pure reduction, extracted so the LIST can batch its reads instead of
 * issuing two send_queue queries per campaign in a serial loop — 80 sequential
 * round trips for 40 campaigns, which was the dominant cost of a ~7s response.
 * Half of them could never return anything: there are 0 active-status queue
 * rows book-wide.
 */
export function reduceCampaignExecutionProof(campaign = {}, activeRows = [], proofRows = []) {
  const campaignStatus = campaign?.status || 'draft'

  let proofNoSendRows = 0
  let liveSendRows = 0
  let smsEligible = 0
  let routingAllowed = 0
  let queuedRows = 0
  let scheduledQueueRows = 0
  let nextScheduledProofRow = null
  let nextScheduledLiveRow = null
  let scheduledRowsAll = 0
  let scheduledProofRows = 0

  for (const row of activeRows || []) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const noSend = asBoolean(metadata.no_send ?? metadata.proof_no_send, false)
    const proofHydration = clean(metadata.launch_mode) === 'proof_hydration_no_send' || noSend
    const status = clean(row.queue_status).toLowerCase()
    /**
     * Every scheduled row, live or proof.
     *
     * `scheduledQueueRows` below deliberately counts only LIVE-executable
     * work, which is the right number for "what will transmit". But the Inbox
     * Scheduled predicate counts any scheduled queue row, so the two surfaces
     * described the same durable rows differently: a 3-row no-send batch read
     * as Scheduled 3 in Inbox and 0 in Campaign Command, while the campaign's
     * own next_send_at showed the first of those three. Counting the total
     * separately is what lets the campaign reconcile with the queue AND still
     * say that none of it will transmit.
     */
    if (status === 'scheduled') scheduledRowsAll += 1
    if (proofHydration) {
      proofNoSendRows += 1
      if (status === 'scheduled') scheduledProofRows += 1
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
    /** Live-executable scheduled work — what will actually transmit. */
    scheduled_queue_rows: scheduledQueueRows,
    /** Scheduled proof rows, which are durable but will never transmit. */
    scheduled_proof_rows: scheduledProofRows,
    /** Every scheduled queue row. Reconciles with send_queue and Inbox Scheduled. */
    scheduled_rows_all: scheduledRowsAll,
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

/**
 * EXPLICIT TARGETS vs DYNAMIC COHORT — §3.
 *
 * These are different promises and must never be confused. An explicit
 * selection is a PINNED SET: the ids the operator picked, and no others, ever.
 * A dynamic cohort is a saved query that Campaigns re-resolves at build time,
 * so records added later can join it.
 *
 * Read from the same `metadata.target_filters` the build uses, so the badge
 * cannot drift from the thing that actually targets. Identity keys
 * (`properties.property_id`, `properties.master_owner_id`) are the anchor for a
 * pinned list — see the "Identity & IDs" category in campaign-field-catalog.js,
 * which exists precisely because an id is not a browsable targeting dimension.
 */
const EXPLICIT_IDENTITY_FIELDS = new Set([
  'properties.property_id',
  'properties.master_owner_id',
])

export function resolveCampaignTargetMode(metadata = {}) {
  const filters = metadataObject(metadata?.target_filters)
  const clauses = []
  for (const value of Object.values(filters)) {
    if (Array.isArray(value)) clauses.push(...value)
  }
  if (clauses.length === 0) return { target_mode: 'none', explicit_target_count: null }

  let explicitCount = 0
  let sawExplicit = false
  for (const clause of clauses) {
    const key = clean(clause?.field_key)
    if (!EXPLICIT_IDENTITY_FIELDS.has(key)) continue
    sawExplicit = true
    const value = clause?.value
    explicitCount += Array.isArray(value) ? value.length : (value === undefined || value === null ? 0 : 1)
  }

  // A pinned list plus browsable dimensions is neither promise cleanly, so it
  // is reported as its own thing rather than mislabelled as one of them.
  if (sawExplicit) {
    const onlyExplicit = clauses.every((c) => EXPLICIT_IDENTITY_FIELDS.has(clean(c?.field_key)))
    return {
      target_mode: onlyExplicit ? 'explicit' : 'explicit_filtered',
      explicit_target_count: explicitCount,
    }
  }
  return { target_mode: 'dynamic', explicit_target_count: null }
}

/**
 * Sent / delivered / failed from PROVIDER TRUTH.
 *
 * These used to be derived from campaign_targets statuses, which are
 * build-time readiness values that never become sent or delivered — so
 * "Miami - Test Campaign" reported 0 sent / 0 delivered / 0 failed while
 * send_queue held 3 sent, 351 delivered and 30 failed. Under-reporting is
 * still a count lie, and the mobile detail showed "No sends yet" for a
 * campaign that had delivered 351 messages.
 *
 * `sent` is a dispatched SUPERSET of `delivered`: a delivered message was
 * necessarily sent, so it counts in both. Delivery is only ever claimed from a
 * provider-confirmed `delivered` row — never inferred from a queued or sent
 * one.
 */
function resolveSendStateCounts(sendBucket = null) {
  if (!sendBucket) return null
  const n = (key) => Number(sendBucket[key] || 0)
  const delivered = n('delivered')
  return {
    delivered,
    sent: n('sent') + delivered,
    failed: n('failed') + n('failed_transport'),
  }
}

function mapCampaignSummary(campaign = {}, targets = [], windows = [], countBucket = null, executionProof = null, sendBucket = null) {
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
  // send_queue is authoritative where available; the target-status derivation
  // remains only as a fallback for an environment without the aggregate.
  const sendState = resolveSendStateCounts(sendBucket)
  const sent = sendState ? sendState.sent : Number(counts.sent || 0) + Number(counts.delivered || 0)
  const delivered = sendState ? sendState.delivered : Number(counts.delivered || 0)
  const failedTarget = sendState ? sendState.failed : Number(counts.failed || 0)
  const proof = executionProof || {}
  const liveQueued = Number(proof.queued_rows ?? queued)
  const liveScheduled = Number(proof.scheduled_queue_rows ?? 0)
  // Total scheduled work in the canonical queue, which is the figure that has
  // to agree with send_queue and Inbox Scheduled. Falls back to the live count
  // when the proof does not report a total.
  const allScheduled = Number(proof.scheduled_rows_all ?? liveScheduled)
  const proofScheduled = Number(proof.scheduled_proof_rows ?? 0)
  const scopedFailed = Number(proof.failed_execution_rows ?? failedTarget)
  // `failed` is provider truth where available; `scopedFailed` stays the
  // execution-scoped figure the proof reports, which answers a different
  // question and must not be conflated with it.
  const failed = sendState ? sendState.failed : scopedFailed
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
    /**
     * Whether a TARGET DEFINITION exists, independent of whether a build has
     * resolved it into rows.
     *
     * Without this the list could only see `total_targets: 0` and had to guess,
     * so the mobile row said "no targeting" for every unbuilt campaign — including
     * "Entity Graph · 5 properties", which carried five explicit property ids the
     * whole time. Those are materially different states to an operator: one needs
     * targeting configured, the other needs a build.
     */
    has_target_definition: Object.keys(metadataObject(campaign.metadata?.target_filters)).length > 0,
    ...resolveCampaignTargetMode(campaign.metadata),
    /**
     * Persisted quarantine, read straight from metadata so the LIST costs no
     * extra queries. Runtime enforcement is the queue-plan guard; this is what
     * lets a row say BLOCKED instead of looking ready.
     */
    quarantined: metadataObject(campaign.metadata?.quarantine).active === true,
    quarantine_reason: clean(metadataObject(campaign.metadata?.quarantine).reason) || null,
    ready_targets: ready,
    planned_targets: planned,
    /**
     * Campaign accounting, never conflated: audience = total_targets, held =
     * targets legitimately blocked (review / identity), eligible = the rest,
     * remaining = eligible targets not yet handed to the queue. A campaign with
     * 50 rows scheduled and 453 remaining must SAY 453 remaining.
     */
    held_targets: Number(counts.blocked || 0),
    eligible_targets: Math.max(0, Number(totalFromBucket ?? targets.length) - Number(counts.blocked || 0)),
    remaining_targets: ready,
    held_by_reason: blockedByReason,
    feeder_last: metadataObject(campaign.metadata?.feeder_last).at ? metadataObject(campaign.metadata?.feeder_last) : null,
    schedule_missed_for: clean(campaign.metadata?.schedule_missed_for) || null,
    // `scheduled_targets` is the reconciliation-facing number: all scheduled
    // queue rows, matching send_queue and Inbox Scheduled.
    scheduled_targets: allScheduled,
    scheduled_queue_rows: liveScheduled,
    scheduled_proof_rows: proofScheduled,
    scheduled_rows_all: allScheduled,
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

/**
 * Execution proof for MANY campaigns, in a bounded number of queries.
 *
 * Two batched, paged reads replace 2N serial ones. Paged explicitly because
 * PostgREST silently caps a response at its own max-rows — the same trap that
 * made campaign target counts report exactly 1000 of 2,578 rows — so a single
 * unpaged `in(...)` read would quietly under-report proof rows on a large book.
 *
 * Per-campaign semantics are preserved exactly: rows are grouped by campaign
 * and each group is truncated to the newest EXECUTION_PROOF_PROOF_ROW_LIMIT,
 * which is what the per-campaign query's own `.limit()` did.
 */
async function fetchExecutionProofByCampaign(supabase, campaigns = []) {
  const proofByCampaign = new Map()
  const campaignIds = (campaigns || []).map((campaign) => campaign.id).filter(Boolean)
  if (!campaignIds.length) return proofByCampaign

  const PAGE = 1000
  /**
   * PROJECT THE THREE SCALARS, NOT THE BLOB.
   *
   * The reducer reads exactly three things out of `metadata` — launch_mode,
   * no_send and proof_no_send — and everything else it needs is a plain
   * column. Selecting the whole jsonb shipped 4.9 MB across 1,766 proof rows
   * (avg 2.8 KB each) through PostgREST and back through JSON.parse on every
   * campaign list request, which was ~5s of a ~5.5s response while the SQL
   * itself measured 233ms. The cost was never the database.
   *
   * The projected fields are rebuilt into a `metadata` shape so the reducer
   * stays untouched and the per-campaign path keeps using the same logic.
   */
  const SELECT = [
    'id', 'campaign_id', 'queue_status', 'sms_eligible', 'routing_allowed', 'scheduled_for', 'created_at',
    'launch_mode:metadata->>launch_mode',
    'no_send:metadata->>no_send',
    'proof_no_send:metadata->>proof_no_send',
    // Why/when the processor last picked up or released the row (read-only;
    // for live_queue below).
    'skip_reason:metadata->>skip_reason',
    'processing_started_at:metadata->>processing_started_at',
    'finalized_at:metadata->>finalized_at',
  ].join(',')

  const rehydrate = (row) => ({
    ...row,
    metadata: {
      launch_mode: row.launch_mode ?? null,
      no_send: row.no_send ?? null,
      proof_no_send: row.proof_no_send ?? null,
    },
  })

  const readAll = async (build) => {
    const rows = []
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await build(supabase.from('send_queue').select(SELECT))
        .in('campaign_id', campaignIds)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) throw error
      const page = data || []
      rows.push(...page.map(rehydrate))
      if (page.length < PAGE) break
    }
    return rows
  }

  const [activeRows, proofRows] = await Promise.all([
    readAll((q) => q.in('queue_status', ACTIVE_QUEUE_STATUSES)),
    readAll((q) => q.filter('metadata->>launch_mode', 'eq', 'proof_hydration_no_send')),
  ])

  const activeByCampaign = new Map()
  for (const row of activeRows) {
    if (!activeByCampaign.has(row.campaign_id)) activeByCampaign.set(row.campaign_id, [])
    activeByCampaign.get(row.campaign_id).push(row)
  }
  const proofsByCampaign = new Map()
  for (const row of proofRows) {
    const bucket = proofsByCampaign.get(row.campaign_id)
    if (!bucket) {
      proofsByCampaign.set(row.campaign_id, [row])
      continue
    }
    // Already ordered newest-first, so keeping the first N reproduces the
    // per-campaign `.limit()`.
    if (bucket.length < EXECUTION_PROOF_PROOF_ROW_LIMIT) bucket.push(row)
  }

  const { compactLiveQueue } = await import('@/lib/domain/campaigns/campaign-live-queue.js')
  const nowMs = Date.now()
  for (const campaign of campaigns) {
    const active = activeByCampaign.get(campaign.id) || []
    proofByCampaign.set(
      campaign.id,
      {
        ...reduceCampaignExecutionProof(campaign, active, proofsByCampaign.get(campaign.id) || []),
        // Is the queued work moving? Due / overdue live rows from the rows
        // already read above — no extra query. Read by listCampaigns.
        live_queue: compactLiveQueue(active, nowMs),
      },
    )
  }
  return proofByCampaign
}

/**
 * Hard ceiling on one campaign list response. The route's `limit` param is not
 * read — every caller gets the same page — so this is the ONLY bound, and the
 * mobile surface searches over whatever it received. At 40 campaigns that is
 * the whole corpus; past this cap it silently would not be, so the response
 * reports whether it hit the ceiling instead of leaving callers to guess.
 */
const CAMPAIGN_LIST_CAP = 200

export async function listCampaigns(deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  /**
   * Phase timings, reported on the response.
   *
   * Measuring this from the outside is unreliable — the dev server recompiles
   * between requests, which swamped the signal at the 5-10s scale this surface
   * operates at. The breakdown names which phase actually costs, so an
   * optimisation can be aimed rather than guessed at.
   */
  const timings = {}
  const phase = async (name, fn) => {
    const started = Date.now()
    try { return await fn() } finally { timings[name] = Date.now() - started }
  }

  const { data: campaigns, error } = await phase('campaigns_select', () => supabase
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(CAMPAIGN_LIST_CAP))
  if (error) throw error
  const ids = (campaigns || []).map((campaign) => campaign.id)
  let windows = []
  let countMap = new Map()
  let proofByCampaign = new Map()
  let sendStateMap = null
  if (ids.length) {
    const { fetchCampaignTargetStatusCounts, fetchCampaignSendStateCounts } =
      await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')
    // Independent reads, so they run concurrently rather than in sequence.
    const [counts, sendStates, proofs, windowRes] = await Promise.all([
      phase('target_counts', () => fetchCampaignTargetStatusCounts(ids, deps)),
      phase('send_state_counts', () => fetchCampaignSendStateCounts(ids, deps)),
      phase('execution_proof', () => fetchExecutionProofByCampaign(supabase, campaigns || [])),
      phase('send_windows', () => supabase
        .from('campaign_send_windows')
        .select('*')
        .in('campaign_id', ids)
        .order('window_start_utc', { ascending: true })
        .limit(1000)),
    ])
    countMap = counts
    sendStateMap = sendStates
    proofByCampaign = proofs
    if (!windowRes.error) windows = windowRes.data || []
  }
  const { deriveOperatorState, operatorStateLabel, operatorModeLabel } = await import('@/lib/domain/campaigns/campaign-operator-state.js')
  const { describeCampaignLineage } = await import('@/lib/domain/campaigns/campaign-lineage.js')
  const summaries = (campaigns || []).map((campaign) => {
    // live_queue rides along with the proof read but is reported on its own.
    const { live_queue: liveQueue = null, ...proofBase } = proofByCampaign.get(campaign.id) || {}
    const executionProof = proofByCampaign.has(campaign.id)
      ? { campaign_state: normalizeCampaignStatus(campaign.status), ...proofBase }
      : null
    const summary = mapCampaignSummary(
      campaign,
      [],
      windows.filter((window) => window.campaign_id === campaign.id),
      countMap.get(campaign.id) || null,
      executionProof,
      sendStateMap ? (sendStateMap.get(campaign.id) || {}) : null,
    )
    const operatorState = deriveOperatorState(campaign, executionProof || {}, {})
    summary.operator_state = operatorState
    summary.operator_state_label = operatorStateLabel(operatorState)
    summary.mode = operatorModeLabel(executionProof || {})
    summary.mode_label = summary.mode === 'live' ? 'Live' : 'Test Mode'
    // Where the audience came from (source, area, filters, zone), read off the
    // row already loaded here — no query, and never inferred from the name.
    summary.lineage = describeCampaignLineage(campaign)
    summary.live_queue = liveQueue
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
  // Archived campaigns stay in the list (their history is kept) but never feed
  // the portfolio KPIs: archiving is how an operator clears a stray or retired
  // campaign out of the numbers. Same rule as syncPortfolioMetrics and the
  // market index (.neq('status','archived')).
  const kpiCampaigns = summaries.filter((campaign) => normalizeCampaignStatus(campaign.status) !== 'archived')
  for (const campaign of kpiCampaigns) {
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
    list_cap: CAMPAIGN_LIST_CAP,
    timings_ms: timings,
    /** True when the response is a prefix of the corpus, not the corpus. */
    truncated: (campaigns || []).length >= CAMPAIGN_LIST_CAP,
    kpis: {
      activeCampaigns,
      totalTargets: kpiCampaigns.reduce((sum, campaign) => sum + campaign.total_targets, 0),
      readyTargets: kpiCampaigns.reduce((sum, campaign) => sum + campaign.ready_targets, 0),
      scheduledQueueRows: kpiCampaigns.reduce((sum, campaign) => sum + Number(campaign.scheduled_queue_rows || 0), 0),
      plannedTargets: kpiCampaigns.reduce((sum, campaign) => sum + Number(campaign.planned_targets || 0), 0),
      sentToday: kpiCampaigns.reduce((sum, campaign) => sum + Number(campaign.sent_count || 0), 0),
      deliveredToday: deliveredTotal,
      replyRate: deliveredTotal > 0 ? Math.round((totalReplied / deliveredTotal) * 1000) / 10 : 0,
      positiveReplies: kpiCampaigns.reduce((sum, campaign) => sum + campaign.positive_reply_count, 0),
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
  /**
   * §4 — the operator-facing reason.
   *
   * Enforcement lives in createCampaignQueuePlan, but the launch path can
   * refuse first for an incidental reason: the quarantined campaign is blocked
   * as "No ready recipients in target snapshot" because all 984 of its rows
   * are `blocked`, which tells the operator nothing about WHY the campaign is
   * unsafe. Computed here (two exact count queries for one campaign) so the
   * detail surface can state the integrity failure plainly.
   */
  summary.target_integrity = await checkExplicitTargetContainment(campaign, deps)
    .catch((error) => ({
      applies: null,
      contained: null,
      // Never report "fine" because the check itself failed.
      error: 'target_integrity_check_failed',
      message: error?.message || String(error),
    }))
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

const hasOwn = (object, key) => Boolean(object) && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)

/** The targeting a PATCH states explicitly, or null — never the payload itself. */
function explicitPatchFilters(payload = {}) {
  const metadata = metadataObject(payload.metadata)
  if (hasOwn(payload, 'target_filters')) return metadataObject(payload.target_filters)
  if (hasOwn(payload, 'filters')) return metadataObject(payload.filters)
  if (hasOwn(metadata, 'target_filters')) return metadataObject(metadata.target_filters)
  return null
}

/**
 * Which `campaigns` columns (and metadata keys) a PATCH actually states
 * (rc-7.1 D9). normalizeCampaignInput builds a WHOLE row — right for create,
 * wrong for an edit: every save re-wrote auto_send_enabled / auto_reply_mode,
 * reset metadata.template_use_case and campaign_type, and (getTargetFilters
 * falls back to the payload itself) replaced metadata.target_filters with the
 * patch body. An update now writes only what the request contains, through
 * the same normalisation.
 */
export function campaignPatchScope(payload = {}) {
  const filters = explicitPatchFilters(payload)
  const carries = filters !== null
  const viaFilter = (...keys) => carries && keys.some((key) => hasOwn(filters, key))
  const has = (...keys) => keys.some((key) => hasOwn(payload, key))
  const columns = new Set()
  const add = (column, condition) => { if (condition) columns.add(column) }
  add('name', has('name', 'campaign_name'))
  add('description', has('description'))
  add('objective', has('objective', 'template_use_case'))
  add('candidate_source', has('candidate_source', 'source_view') || viaFilter('candidate_source'))
  add('market', has('market') || carries)
  add('state', has('state') || carries)
  add('language_policy', has('language_policy') || viaFilter('language'))
  add('agent_persona', has('agent_persona') || viaFilter('agent_persona'))
  add('daily_cap', has('daily_cap') || viaFilter('daily_cap'))
  add('total_cap', has('total_cap') || viaFilter('total_cap'))
  add('batch_max', has('batch_max') || viaFilter('batch_max', 'max_batch_size'))
  add('market_cap', has('market_cap') || viaFilter('market_cap'))
  add('per_sender_cap', has('per_sender_cap') || viaFilter('per_sender_cap', 'per_number_cap'))
  add('send_interval_seconds', has('send_interval_seconds') || viaFilter('interval_seconds', 'send_interval_seconds'))
  add('contact_window_start', has('contact_window_start') || viaFilter('custom_window_start'))
  add('contact_window_end', has('contact_window_end') || viaFilter('custom_window_end'))
  add('auto_queue_enabled', has('auto_queue_enabled'))
  add('auto_send_enabled', has('auto_send_enabled'))
  add('auto_reply_mode', has('auto_reply_mode'))
  add('emergency_stop_at', has('emergency_stop_at'))

  const metadataKeys = new Set(Object.keys(metadataObject(payload.metadata)))
  if (carries) metadataKeys.add('target_filters')
  if (has('campaign_type')) metadataKeys.add('campaign_type')
  if (has('template_use_case') || viaFilter('template_use_case')) metadataKeys.add('template_use_case')
  if (has('stage_code') || viaFilter('stage_code')) metadataKeys.add('stage_code')
  if (has('launch_timezone')) metadataKeys.add('launch_timezone')
  if (has('timezone')) metadataKeys.add('timezone')
  if (metadataKeys.size) columns.add('metadata')
  return { columns, metadataKeys, carriesFilters: carries }
}

const AUDIT_SECRET_KEY = /secret|token|password|api[_-]?key|authorization|credential/i
const AUDIT_VALUE_MAX = 300

function auditValue(key, value) {
  if (AUDIT_SECRET_KEY.test(String(key))) return '[redacted]'
  if (value === undefined) return null
  const json = JSON.stringify(value)
  if (json && json.length > AUDIT_VALUE_MAX) {
    return { summary: `${Array.isArray(value) ? 'list' : typeof value} (${json.length} chars)`, preview: json.slice(0, AUDIT_VALUE_MAX) }
  }
  return value
}

const sameValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

const CHANGE_WORDS = {
  'metadata.target_filters': 'audience filters',
  'metadata.template_use_case': 'message type',
  'metadata.stage_code': 'stage',
  'metadata.timezone': 'time zone',
  'metadata.launch_timezone': 'time zone',
  'metadata.planned_first_scheduled_at': 'planned start',
  contact_window_start: 'texting hours',
  contact_window_end: 'texting hours',
  send_interval_seconds: 'pace',
}

/** Plain words for an activity line ("Changed: name, daily cap, audience filters"). */
export function describeCampaignChanges(changes = {}) {
  const words = Object.keys(changes).map((key) => CHANGE_WORDS[key] || key.replace(/^metadata\./, '').replace(/_/g, ' '))
  return [...new Set(words)].join(', ')
}

/** Old → new for every changed column (metadata per key); values truncated, secrets redacted. */
export function campaignPatchChanges(existing = {}, patch = {}) {
  const changes = {}
  for (const [column, next] of Object.entries(patch)) {
    if (column === 'metadata') {
      const before = metadataObject(existing.metadata)
      const after = metadataObject(next)
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (sameValue(before[key], after[key])) continue
        changes[`metadata.${key}`] = { from: auditValue(key, before[key]), to: auditValue(key, after[key]) }
      }
      continue
    }
    if (sameValue(existing[column], next)) continue
    changes[column] = { from: auditValue(column, existing[column]), to: auditValue(column, next) }
  }
  return changes
}

export const CAMPAIGN_LIFECYCLE_ROUTE_HINT = '/api/cockpit/campaigns/{id}/lifecycle'

export async function updateCampaign(campaignId, payload = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  // Lifecycle state is owned by the state machine (validated edges, advisory
  // lock, lifecycle timestamps). A config PATCH that carried `status` wrote it
  // straight to the row — e.g. 'active' with no activation, lock or targets.
  if (hasOwn(payload, 'status')) {
    return {
      ok: false,
      status: 400,
      error: 'status_not_patchable',
      message: `Campaign status can't be changed by an edit. Use POST ${CAMPAIGN_LIFECYCLE_ROUTE_HINT.replace('{id}', campaignId)} with an action (schedule, activate, pause, resume, archive, …) so the state machine validates it.`,
      lifecycle_route: CAMPAIGN_LIFECYCLE_ROUTE_HINT.replace('{id}', campaignId),
    }
  }
  if (asBoolean(payload.auto_send_enabled, false)) {
    return { ok: false, status: 423, error: 'auto_send_live_disabled', message: 'Phase 1 does not enable live auto-send.' }
  }
  if (clean(payload.auto_reply_mode) && clean(payload.auto_reply_mode) !== 'disabled') {
    return { ok: false, status: 423, error: 'auto_reply_live_disabled', message: 'Phase 1 does not enable live auto-reply.' }
  }
  // Caps: 0 is stored as 0 ("send nothing"), never coerced to null — null
  // means "no cap" to every reader, so 0 -> null uncapped a throttled campaign.
  // A value that is not a non-negative number is refused for the same reason.
  const capSources = [payload, explicitPatchFilters(payload) || {}]
  const invalidCaps = CAMPAIGN_CAP_COLUMNS.concat(['per_number_cap'])
    .filter((key) => capSources.some((source) => hasOwn(source, key) && !isValidCampaignCapInput(source[key])))
  if (invalidCaps.length) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_cap',
      fields: invalidCaps,
      message: `${invalidCaps.join(', ')} must be a whole number of 0 or more (0 = send nothing).`,
    }
  }
  const current = await getCampaign(campaignId, deps)
  const existing = current.campaign || {}
  const full = normalizeCampaignInput(payload, existing)
  const scope = campaignPatchScope(payload)
  const patch = {}
  for (const column of scope.columns) {
    if (column === 'metadata') continue
    if (hasOwn(full, column)) patch[column] = full[column]
  }
  if (scope.columns.has('metadata')) {
    const metadata = { ...metadataObject(existing.metadata) }
    for (const key of scope.metadataKeys) metadata[key] = full.metadata?.[key]
    patch.metadata = metadata
  }
  const changes = campaignPatchChanges(existing, patch)
  const changedColumns = Object.keys(patch).filter((column) => column === 'metadata'
    ? Object.keys(changes).some((key) => key.startsWith('metadata.'))
    : hasOwn(changes, column))
  const write = Object.fromEntries(changedColumns.map((column) => [column, patch[column]]))
  if (!changedColumns.length) {
    return { ok: true, campaign: existing, campaign_id: existing.id || campaignId, changed_fields: [], unchanged: true }
  }
  const { data, error } = await supabase.from('campaigns').update(write).eq('id', campaignId).select('*').single()
  if (error) throw error
  if (scope.carriesFilters) {
    await replaceCampaignFilters(campaignId, write.metadata?.target_filters || patch.metadata?.target_filters || {}, deps)
  }
  await recordCampaignEvent({
    campaign_id: campaignId,
    event_type: 'campaign.updated',
    severity: 'info',
    title: 'Campaign updated',
    description: `Changed: ${describeCampaignChanges(changes)}`,
    metadata: { changes, patch_keys: Object.keys(payload || {}) },
  }, deps)
  return { ok: true, campaign: data, campaign_id: data.id, changed_fields: Object.keys(changes) }
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

/**
 * THE ROWS A BUILD WRITES — computed without writing.
 *
 * Build and Reach both call this, so "ready to message" on the Reach step is
 * the number Build will actually produce: the same queue-eligible graph rows
 * (same filters, same order, same limit), the same entity-contact review
 * holds, the same one-recipient-per-phone collapse and the same readiness
 * rules. Reach used to show the graph's queue-eligible count (4,771) while the
 * build capped at the campaign limit (1,000), collapsed to 949 recipients and
 * held 410 for review/identity — 539 ready.
 */
/**
 * Fill the graph's empty seller name from the messaged person's canonical
 * record (prospects keyed by seller_person_key). Only fills a blank — a name
 * the graph already carries is never overwritten — and never uses the deed
 * owner / entity name, which is what left entity-owned targets greeting-less.
 */
export function applyCanonicalSellerName(row = {}, lookup = null) {
  if (!row || typeof lookup?.resolveName !== 'function') return row
  if (clean(row.seller_first_name) && clean(row.seller_full_name)) return row
  const name = lookup.resolveName(row)
  if (!name) return row
  if (!clean(row.seller_first_name) && name.first_name) row.seller_first_name = name.first_name
  if (!clean(row.seller_full_name) && name.full_name) row.seller_full_name = name.full_name
  row.seller_name_source = 'prospect'
  return row
}

export async function planCampaignTargetRows({ campaign = null, options = {}, graph = {}, targetLimit, deps = {}, resolveLanguages = true } = {}) {
  const limit = Math.max(1, Number(targetLimit) || CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT)
  const touchNumber = asPositiveInteger(options.stage_touch ?? options.touch_number ?? campaign?.metadata?.stage_touch, 1) || 1
  const eligibleRows = (graph.rows || []).filter((row) => row.queue_eligible).map((row) => ({ ...row }))

  /**
   * Entity-contact review flags, in ONE set-based call for the whole
   * candidate set. The graph does not project `requires_review`, and without
   * it an entity contact the canonical source says needs review becomes
   * campaign-ready.
   */
  const { fetchEntityContactReviewBlocks, fetchCanonicalLanguages } =
    await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')
  const [entityReview, languages] = await Promise.all([
    fetchEntityContactReviewBlocks(eligibleRows.map((row) => row.property_id), deps),
    /**
     * The graph has no language at all, but the seller's language IS
     * canonical on prospects/master_owners under keys the graph carries.
     * Resolved here, set-based, so a Spanish-speaking owner is not handed an
     * English template by default. Unknown stays unknown — nothing is
     * written back to the graph. (Reach skips it: language never changes
     * whether a target is ready.)
     */
    resolveLanguages ? fetchCanonicalLanguages(eligibleRows, deps) : Promise.resolve(null),
  ])
  for (const row of eligibleRows) {
    row.entity_contact_requires_review = entityReview.blocked.has(clean(row.property_id))
    if (languages) {
      const resolvedLanguage = languages.resolve(row)
      row.resolved_language = resolvedLanguage.language
      row.resolved_language_source = resolvedLanguage.source
      applyCanonicalSellerName(row, languages)
    }
  }
  const { collapseGraphRowsToRecipients } = await import('@/lib/domain/campaigns/campaign-recipient-dedup.js')
  const { recipients, stats: dedupStats } = collapseGraphRowsToRecipients(eligibleRows, { touch_number: touchNumber })
  /**
   * THE SEND LIMIT COUNTS SENDABLE SELLERS FIRST (owner, 2026-10-07). The limit
   * used to slice the ranked recipients before anyone asked whether a sender
   * could carry them, so sellers in markets with no route (Baltimore, Tulsa…)
   * took limit slots: 4,345 eligible -> 783 ready -> 159 sendable today. The
   * planner's own router (the same per-market chooseTextgridNumber the Composer
   * cohort, readiness and the launch plan call; exact-market today, approved
   * regional pools once Sender Routing 2.0 is on) now answers per market BEFORE
   * the slice: sendable recipients keep their order and fill the limit first;
   * recipients with no sender route follow (they are built only if the limit
   * still has room, and are counted either way). A market the router did not
   * answer (budget, error) is never treated as unsendable.
   */
  const sendability = await planRecipientSendability(recipients, deps)
  const orderedRecipients = sendability.evaluated
    ? [...recipients.filter((row) => sendability.of(row) !== false), ...recipients.filter((row) => sendability.of(row) === false)]
    : recipients
  const rows = orderedRecipients
    .slice(0, limit)
    .map((row, index) => {
      const snapshot = buildTargetSnapshotFromGraphRow(campaign, row, index, options)
      return {
        ...snapshot,
        campaign_id: campaign?.id || null,
        campaign_name: campaign?.name || null,
        source_view_name: CAMPAIGN_TARGET_GRAPH_TABLE,
        daily_cap: campaign?.daily_cap,
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

  const heldByReason = {}
  let ready = 0
  for (const row of rows) {
    if (row.target_status === 'ready') ready += 1
    else increment(heldByReason, clean(row.block_reason) || 'blocked')
  }
  return {
    rows,
    summary: {
      queue_eligible_rows_read: eligibleRows.length,
      recipients: recipients.length,
      duplicate_phones_collapsed: Math.max(0, eligibleRows.length - recipients.length),
      built: rows.length,
      ready,
      held: rows.length - ready,
      held_by_reason: heldByReason,
      limit,
      limited: recipients.length > rows.length,
      entity_review_held: Number(heldByReason.entity_contact_requires_review || 0),
      ...sendabilitySummary(sendability, recipients, rows),
    },
  }
}

const SENDABILITY_MARKET_KEY = (row = {}) => clean(row.market) || 'Unknown market'

/**
 * Per market of the recipients: can the planner's router place a first touch
 * there today? { evaluated, of(row) -> true | false | null, markets }.
 * Injectable (deps.evaluateRecipientSendability) for tests; an unreadable
 * router leaves the order untouched (evaluated: false).
 */
export async function planRecipientSendability(recipients = [], deps = {}) {
  const none = { evaluated: false, of: () => null, markets: [] }
  if (!recipients.length) return none
  try {
    const evaluate = typeof deps.evaluateRecipientSendability === 'function'
      ? deps.evaluateRecipientSendability
      : (await import('@/lib/domain/campaigns/campaign-launch-readiness.js')).evaluateAudienceSenderCoverage
    const result = await evaluate(recipients.map((row) => ({ market: row.market, state: row.state })), deps)
    const markets = Array.isArray(result?.markets) ? result.markets : null
    if (!markets) return none
    const byMarket = new Map(markets.map((entry) => [clean(entry.market) || 'Unknown market', entry.sendable === true ? true : entry.sendable === false ? false : null]))
    return { evaluated: true, of: (row) => (byMarket.has(SENDABILITY_MARKET_KEY(row)) ? byMarket.get(SENDABILITY_MARKET_KEY(row)) : null), markets }
  } catch {
    return none
  }
}

function sendabilitySummary(sendability, recipients = [], rows = []) {
  if (!sendability?.evaluated) return { sender_routing_evaluated: false }
  const byMarket = {}
  let sendable = 0
  let noRoute = 0
  for (const row of recipients) {
    const verdict = sendability.of(row)
    if (verdict === false) {
      noRoute += 1
      increment(byMarket, SENDABILITY_MARKET_KEY(row))
    } else if (verdict === true) sendable += 1
  }
  const built = { sendable: 0, no_route: 0 }
  for (const row of rows) {
    const verdict = sendability.of(row)
    if (verdict === true && row.target_status === 'ready') built.sendable += 1
    if (verdict === false) built.no_route += 1
  }
  return {
    sender_routing_evaluated: true,
    // every recipient (before the limit): the router's answer per market
    sendable_recipients: sendable,
    no_sender_route_recipients: noRoute,
    no_sender_route_by_market: byMarket,
    // inside the build: ready AND a sender can carry them (the headline), and
    // no-route rows that only entered because the limit had room left
    ready_sendable: built.sendable,
    no_sender_route_in_build: built.no_route,
  }
}

/**
 * THE WHOLE COHORT, COUNTED THE WAY BUILD COUNTS IT (Campaign Composer 2.0).
 *
 * Reach's build simulation reads at most CAMPAIGN_TARGET_GRAPH_PREVIEW_LIMIT
 * rows, so its "ready" is a sample of a large audience. This runs the SAME
 * pipeline Build runs — the queue-eligible graph rows under the same filters
 * and total order, planCampaignTargetRows (entity-review holds, phone dedupe,
 * resolveCampaignTargetReadiness) — over every row Build could read
 * (CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT), then the planner's router per market and
 * the recipient-timezone resolver per ready seller. One predicate, no SQL copy
 * to drift. Returns aggregates only; no target row leaves the server.
 * Read-only: keyset pages over disjoint graph_id partitions; nothing is written.
 */
export async function countCampaignAudienceCohort(input = {}, deps = {}) {
  const startedAt = Date.now()
  const supabase = deps.supabase || defaultSupabase
  const baseOptions = previewOptionsFromInput(input, null)
  const population = await resolveGraphColumnPopulation(deps, baseOptions.catalog_filters)
  const options = { ...baseOptions, catalog_filters: resolveCatalogFiltersForTargetGraph(baseOptions.catalog_filters, { population }) }
  // The eligible count and the row reads are independent: both start now.
  // Reads stop at the build limit (the most Build could read); the count then
  // slices to min(count, limit), exactly as when the count came first.
  const eligibleCountRead = countCampaignGraphRows({ supabase, options, requireQueueEligible: true })
  const readable = CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT
  const area = drawnAreaFromFilters(options.catalog_filters?.supported)
  // Keyset pages over 16 disjoint graph_id partitions (graph_id is the primary
  // key, a hex digest): no deep OFFSET sort, so a 100K cohort reads in bounded
  // statements. Order is irrelevant to a whole-cohort count (nothing is
  // sliced; the dedupe picks a primary by comparator, not by position).
  const HEX = '0123456789abcdef'
  const partitions = [...HEX].map((ch, i) => ({ lo: ch, hi: HEX[i + 1] ?? null }))
  const pages = []
  const warnings = []
  let failure = null
  let fetched = 0
  let next = 0
  const worker = async () => {
    while (next < partitions.length && !failure) {
      const part = partitions[next++]
      let last = null
      for (;;) {
        if (failure || fetched >= readable) return
        let query = campaignGraphQuery(supabase, { area, table: CAMPAIGN_TARGET_GRAPH_TABLE, columns: CAMPAIGN_TARGET_GRAPH_SELECT })
          .gte('graph_id', part.lo)
        if (part.hi) query = query.lt('graph_id', part.hi)
        if (last) query = query.gt('graph_id', last)
        query = applyCampaignGraphFilters(query.order('graph_id', { ascending: true }).limit(CAMPAIGN_TARGET_GRAPH_PAGE_SIZE), options, warnings, { requireQueueEligible: true })
        const { data, error } = await query
        if (error) { failure = errorMessage(error); return }
        const page = Array.isArray(data) ? data : []
        if (!page.length) break
        pages.push(page)
        fetched += page.length
        last = page[page.length - 1].graph_id
        if (page.length < CAMPAIGN_TARGET_GRAPH_PAGE_SIZE) break
      }
    }
  }
  const [eligibleCount] = await Promise.all([
    eligibleCountRead,
    ...Array.from({ length: Math.min(Number(deps.cohortConcurrency) || 6, partitions.length) }, worker),
  ])
  if (!eligibleCount.ok) return { ok: false, error: 'cohort_count_unavailable', warnings: eligibleCount.warnings }
  const total = eligibleCount.count
  if (failure) return { ok: false, error: 'cohort_rows_unavailable', message: failure }
  const rows = pages.flat().slice(0, Math.min(total, readable))
  const readMs = Date.now() - startedAt
  const planned = await planCampaignTargetRows({ campaign: null, options, graph: { rows }, targetLimit: CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT, deps, resolveLanguages: false })
  const readyRows = planned.rows.filter((row) => row.target_status === 'ready')
  const { evaluateAudienceSenderCoverage } = await import('@/lib/domain/campaigns/campaign-launch-readiness.js')
  const senders = await evaluateAudienceSenderCoverage(readyRows, deps).catch(() => null)
  const zones = {}
  const markets = {}
  for (const row of readyRows) {
    const snapshot = metadataObject(metadataObject(row.metadata).candidate_snapshot)
    const zone = resolveRecipientTimezone({ timezone: row.timezone, property_address_state: row.state, property_address_zip: snapshot.property_zip })
    increment(zones, zone.ok ? zone.iana : 'unresolved')
    increment(markets, clean(row.market) || 'unknown')
  }
  // [campaign map preview] per-ready-row greeting kinds, in readyRows order (only when members are asked for)
  const greetingKinds = []
  const personalization = await summarizeCohortPersonalization(readyRows, rows, deps, greetingKinds).catch(() => null)
  // the renderer's language hold over the ready set; greeting kinds (post-hydration) avoid double-counting lint refusals
  const languageHolds = summarizeLanguageHolds(readyRows, personalization ? greetingKinds : null)
  const members = input.include_members === true
    ? readyRows.map((row, i) => ({
      property_id: clean(row.property_id) || null,
      market: clean(row.market) || null,
      // null when names were unreadable — the caller must not guess a kind
      greeting: personalization && greetingKinds.length === readyRows.length ? greetingKinds[i] : null,
      // the renderer's language hold (Farsi/Thai/Pashto…), null when a template language exists
      language_hold: targetLanguageHold(row),
    }))
    : undefined
  return {
    ok: true,
    queue_eligible_in_audience: total,
    rows_read: rows.length,
    capped_by_build_limit: total > CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT,
    build_limit: CAMPAIGN_TARGET_GRAPH_BUILD_LIMIT,
    ...planned.summary,
    sendable_now: senders ? senders.sendable_now : null,
    no_sendable_number: senders ? senders.no_sendable_number : null,
    sender_markets: senders ? senders.markets : [],
    // Greeting personalization of the ready set (render lint): first name on
    // file, deed-name greeting, or none (refused). Null when names were unreadable.
    personalization,
    language_holds: languageHolds,
    sendable_after_personalization: senders
      ? sendableAfterPersonalization(senders.sendable_now, senders.markets, personalization, languageHolds)
      : null,
    ready_by_zone: zones,
    ready_by_market: markets,
    timings_ms: { read: readMs, total: Date.now() - startedAt },
    warnings: uniqueClean(warnings),
    // [campaign map preview] the ready set's identities (server-internal; the Composer route never returns these rows)
    ...(members ? { members } : {}),
  }
}

/**
 * Ready rows' greeting personalization. The cohort plans with
 * resolveLanguages:false, so names are hydrated here the way Build hydrates
 * them (canonical prospect by seller_person_key, applyCanonicalSellerName), for
 * the rows still missing a first name only. Corporate ownership comes from the
 * graph row (the snapshot does not carry it).
 */
async function summarizeCohortPersonalization(readyRows = [], graphRows = [], deps = {}, kindsOut = null) {
  if (!readyRows.length) return summarizePersonalization([])
  const corporateByProperty = new Map()
  for (const row of graphRows) if (row?.property_id) corporateByProperty.set(clean(row.property_id), row.is_corporate_owner === true)
  const probes = []
  for (const row of readyRows) {
    const snapshot = metadataObject(metadataObject(row.metadata).candidate_snapshot)
    if (!clean(snapshot.seller_first_name) && clean(snapshot.seller_person_key)) probes.push({ seller_person_key: clean(snapshot.seller_person_key) })
  }
  const { fetchCanonicalLanguages } = await import('@/lib/domain/campaigns/campaign-recipient-metrics.js')
  const lookup = probes.length ? await (deps.fetchCanonicalLanguages || fetchCanonicalLanguages)(probes, deps) : null
  const classified = readyRows.map((row) => {
    const snapshot = { ...metadataObject(metadataObject(row.metadata).candidate_snapshot) }
    if (lookup) applyCanonicalSellerName(snapshot, lookup)
    return {
      market: row.market,
      seller_first_name: snapshot.seller_first_name,
      owner_name: snapshot.owner_name,
      is_corporate_owner: corporateByProperty.get(clean(row.property_id || snapshot.property_id)) === true,
    }
  })
  if (Array.isArray(kindsOut)) for (const row of classified) kindsOut.push(greetingPersonalization(row))
  return summarizePersonalization(classified)
}

/**
 * THE LOCATION UNIVERSE an audience's targeting filters narrow (the funnel's
 * first stage): the same graph count as Reach with only the location filters
 * (market, ZIP, county, drawn area, pinned ids) applied. One indexed count.
 */
export async function countCampaignAudienceUniverse(input = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const baseOptions = previewOptionsFromInput(input, null)
  const population = await resolveGraphColumnPopulation(deps, baseOptions.catalog_filters)
  const resolved = resolveCatalogFiltersForTargetGraph(baseOptions.catalog_filters, { population })
  const all = resolved.supported || []
  const location = all.filter((filter) => isUniverseFilter(filter, getCampaignFieldDefinition(filter.field_key)))
  const result = await countCampaignGraphRows({ supabase, options: { ...baseOptions, catalog_filters: { ...resolved, supported: location } } })
  return {
    ok: result.ok,
    count: result.ok ? result.count : null,
    location_filters: location.map((filter) => filter.field_key),
    targeting_filters: all.filter((filter) => !location.includes(filter)).map((filter) => filter.field_key),
    warnings: result.warnings,
  }
}

/**
 * WHAT EACH FILTER DID (Reach's "why"): the audience counted step by step —
 * location filters first (the universe), then each targeting filter in the
 * operator's order — so every applied filter shows the rows it removed, the
 * queue-eligible rows left after it, and how much of the universe even has a
 * value in its column (coverage). A filter on a 27%-filled column that
 * "removes" 73% of the market is a data gap, not a seller trait; Reach says so.
 * Every filter that could NOT be applied is listed with its reason (never
 * silently dropped). Exact head counts, at most 4 at a time.
 */
export async function measureCampaignFilterEffects(input = {}, deps = {}) {
  const startedAt = Date.now()
  const supabase = deps.supabase || defaultSupabase
  const baseOptions = previewOptionsFromInput(input, null)
  const population = await resolveGraphColumnPopulation(deps, baseOptions.catalog_filters)
  const resolved = resolveCatalogFiltersForTargetGraph(baseOptions.catalog_filters, { population })
  const applied = resolved.supported || []
  const isLocation = (filter) => isUniverseFilter(filter, getCampaignFieldDefinition(filter.field_key))
  const location = applied.filter(isLocation)
  const targeting = applied.filter((filter) => !isLocation(filter))
  const steps = [...location, ...targeting]
  const optionsWith = (supported) => ({ ...baseOptions, catalog_filters: { ...resolved, supported } })
  const jobs = []
  const count = (supported, { eligible = false, extra = null } = {}) => {
    const job = () => countCampaignGraphRows({ supabase, options: optionsWith(supported), requireQueueEligible: eligible, extra })
    jobs.push(job)
    return jobs.length - 1
  }
  const baseIndex = count([])
  const plan = steps.map((filter, index) => {
    const prefix = steps.slice(0, index + 1)
    const column = filter.graph_column || null
    return {
      filter,
      after: count(prefix),
      eligibleAfter: count(prefix, { eligible: true }),
      // Coverage inside the universe this filter acts on (location filters:
      // the whole audience table; targeting filters: the location universe).
      coverage: column ? count(isLocation(filter) ? [] : location, { extra: (q) => q.not(column, 'is', null) }) : null,
      coverageOf: isLocation(filter) ? baseIndex : null,
    }
  })
  const universeIndex = location.length ? plan[location.length - 1].after : baseIndex
  const results = new Array(jobs.length)
  let cursor = 0
  const concurrency = Math.max(1, Number(deps.filterEffectConcurrency) || 4)
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++
      results[index] = await jobs[index]().catch((error) => ({ ok: false, count: 0, warnings: [errorMessage(error)] }))
    }
  }))
  const value = (index) => (index === null || index === undefined || !results[index]?.ok ? null : results[index].count)
  const warnings = uniqueClean(results.flatMap((result) => result?.warnings || []))
  let previous = value(baseIndex)
  const effects = plan.map(({ filter, after, eligibleAfter, coverage, coverageOf }) => {
    const countAfter = value(after)
    const withValue = coverage === null ? null : value(coverage)
    const of = value(coverageOf ?? universeIndex)
    const removed = previous !== null && countAfter !== null ? Math.max(0, previous - countAfter) : null
    previous = countAfter
    return {
      field_key: filter.field_key,
      label: filter.label || getCampaignFieldDefinition(filter.field_key)?.label || filter.field_key,
      operator: filter.operator,
      value: filter.field_key === DRAWN_AREA_FIELD_KEY ? null : filter.value,
      stage: isLocation(filter) ? 'location' : 'targeting',
      graph_column: filter.graph_column || null,
      count_after: countAfter,
      removed,
      eligible_after: value(eligibleAfter),
      coverage: withValue === null || !of ? null : {
        with_value: withValue,
        of,
        pct: Math.round((withValue / of) * 1000) / 10,
      },
      failed: countAfter === null,
    }
  })
  const refused = [
    ...(resolved.unsupported || []),
    ...(resolved.unknown || []),
    ...((baseOptions.catalog_filters.dropped || []).filter((filter) => filter.reason === 'empty_filter_value')),
  ].map((filter) => ({
    field_key: filter.field_key,
    label: filter.label || getCampaignFieldDefinition(filter.field_key)?.label || filter.field_key,
    operator: filter.operator || null,
    reason: filter.unsupported_reason || filter.reason || 'not_applied',
    message: filter.message || (filter.reason === 'empty_filter_value' ? 'Not applied: no value chosen.' : `Not applied: ${INAPPLICABLE_REASONS.not_in_audience}`),
  }))
  return {
    // Per-filter failures are flagged on the filter; the read fails only without a base count.
    ok: value(baseIndex) !== null,
    audience_table: CAMPAIGN_TARGET_GRAPH_TABLE,
    count_unit: 'properties',
    base_count: value(baseIndex),
    universe_count: value(universeIndex),
    final_count: steps.length ? value(plan[plan.length - 1].after) : value(baseIndex),
    final_eligible: steps.length ? value(plan[plan.length - 1].eligibleAfter) : null,
    effects,
    refused,
    warnings,
    timings_ms: { total: Date.now() - startedAt, counts: jobs.length },
  }
}

/**
 * Record the built cohort's canonical market identity on the campaign
 * (campaign-market-identity.js). Re-reads the row so the metadata merge is
 * against the latest state (the status transition above just wrote it).
 */
export async function persistCampaignMarketIdentity(campaignId, rows = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  let directory = null
  try {
    directory = await (deps.loadCanonicalMarketDirectory || loadCanonicalMarketDirectory)({ supabase })
  } catch {
    directory = null // ids stay null; the canonical display names still stand
  }
  const identity = summarizeCampaignMarketIdentity(rows, {
    resolveMarket: directory ? (label) => resolveMarketLabel(directory, label, null) : null,
  })
  const { data: current, error: readError } = await supabase.from('campaigns').select('id,market,state,metadata').eq('id', campaignId).maybeSingle()
  if (readError) throw readError
  if (!current) return { identity, written: false }
  const patch = campaignMarketIdentityPatch(identity, current)
  const { error } = await supabase
    .from('campaigns')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', campaignId)
  if (error) throw error
  return { identity, written: true }
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
    options.catalog_filters = resolveCatalogFiltersForTargetGraph(options.catalog_filters, {
      population: await resolveGraphColumnPopulation(deps, options.catalog_filters),
    })

    /**
     * A DROPPED FILTER MUST NOT BUILD THE WHOLE UNIVERSE.
     *
     * previewOptionsFromInput resolves the campaign's saved target_filters
     * against the field catalog and reports anything it could not resolve in
     * `catalog_filters.dropped`. The preview path surfaces that honestly. This
     * WRITE path did not look at it: a filter the catalog rejected simply left
     * the option set empty, and an empty option set means "no narrowing", so
     * the builder targeted every reachable row.
     *
     * Reproduced 2026-09-14 on the operator's own draft. "Entity Graph · 5
     * properties" carried five real property_ids, and properties.property_id
     * was not yet a declared catalog field:
     *
     *   preview  -> dropped_filters: [{field_key: "properties.property_id",
     *                                  reason: "unknown_campaign_field"}]
     *   build    -> 61,500 campaign_targets rows for a 5-property selection
     *
     * (That campaign has been restored to 0 rows and no send_queue row was ever
     * created -- the builder's own no_send_queue_rows_created contract held.)
     *
     * The read-side rule is that an unsupported filter fails closed. A builder
     * that writes targets has strictly more reason to obey it: refusing costs
     * the operator one error message, and not refusing silently points a
     * campaign at the entire corpus.
     */
    /**
     * A filter row with no value narrows nothing in Reach and nothing here —
     * refusing on it made "Schedule" fail for a blank row Reach had ignored.
     * Every filter that WOULD narrow but can't be applied (unknown field, no
     * audience column, no audience data) is refused, by name and reason.
     */
    const droppedFilters = [
      ...(options.catalog_filters?.dropped || []).filter((filter) => filter.reason !== 'empty_filter_value'),
      ...(options.catalog_filters?.inapplicable || [])
        .filter((filter) => !(options.catalog_filters?.dropped || []).some((dropped) => dropped.field_key === filter.field_key)),
    ]
    if (droppedFilters.length > 0) {
      const detailLines = droppedFilters
        .map((filter) => `${filter.label || filter.field_key || filter.fieldKey} (${filter.message ? filter.message.replace(/^Not applied: /, '') : filter.reason || 'unsupported'})`)
      await finishCampaignRun(run.id, {
        status: 'failed',
        total_scanned: 0,
        targets_clean: 0,
        ready_to_queue: 0,
        blocked_counts: {},
        metadata: { unresolved_target_filters: droppedFilters },
      }, deps)
      await recordCampaignEvent({
        campaign_id: campaignId,
        run_id: run.id,
        event_type: 'campaign.targets_build_refused',
        payload: { reason: 'unresolved_target_filters', dropped_filters: droppedFilters },
      }, deps)
      return {
        ok: false,
        status: 422,
        error: 'unresolved_target_filters',
        message: `Refusing to build targets: ${detailLines.join('; ')}. `
          + 'Remove these filters (or choose fields the campaign audience carries) — building without them would target more sellers than you chose.',
        campaign_id: campaignId,
        dropped_filters: droppedFilters,
        built_count: 0,
        no_send_queue_rows_created: true,
      }
    }

    // No applicable filter and no market or state: the build would target
    // every seller in every market. Refused by name, like a dropped filter.
    if (
      !isInternalCanaryAudienceRequested(options)
      && options.catalog_filters?.has_catalog_filters
      && !(options.catalog_filters?.supported || []).length
      && !clean(options.market)
      && !clean(options.state)
    ) {
      await finishCampaignRun(run.id, {
        status: 'failed',
        total_scanned: 0,
        targets_clean: 0,
        ready_to_queue: 0,
        blocked_counts: {},
        metadata: { refused: 'campaign_has_no_targeting' },
      }, deps)
      await recordCampaignEvent({
        campaign_id: campaignId,
        run_id: run.id,
        event_type: 'campaign.targets_build_refused',
        payload: { reason: 'campaign_has_no_targeting' },
      }, deps)
      return {
        ok: false,
        status: 422,
        error: 'campaign_has_no_targeting',
        message: 'This campaign has no filters and no market, so it would target every seller in every market. '
          + 'Add at least one filter (Market, for example) and schedule again.',
        campaign_id: campaignId,
        built_count: 0,
        no_send_queue_rows_created: true,
      }
    }

    /**
     * §3 — AUDIENCE SOURCE, THEN ONE PIPELINE.
     *
     * Production cohorts resolve from `campaign_target_graph`; internal proof
     * cohorts resolve from the approved canary registry. They converge HERE,
     * as graph-shaped rows, so everything below this line — dedup, entity
     * review, language resolution, target persistence, queue materialization —
     * is identical for both and there is no such thing as a canary campaign
     * object downstream.
     */
    const graph = isInternalCanaryAudienceRequested(options)
      ? await resolveInternalCanaryAudience({
          supabase,
          options,
          context: { internal_authorized: input.internal_authorized === true },
        })
      : await summarizeCampaignGraph({
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

    const planned = await planCampaignTargetRows({ campaign, options, graph, targetLimit, deps })
    const rows = planned.rows.map((row) => ({ ...row, campaign_id: campaignId }))
    await supabase.from('campaign_targets').delete().eq('campaign_id', campaignId)

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
    // The campaign's market + schedule zone(s) come from the cohort it just
    // built — never from its name and never from the operator's clock.
    const marketIdentity = inserted > 0
      ? await persistCampaignMarketIdentity(campaignId, rows, deps).catch((error) => ({ error: error?.message || String(error) }))
      : null
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
      market_identity: marketIdentity?.identity || null,
      // Ready / held by reason, exactly as written — the preflight shows it.
      build_summary: planned.summary,
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
    daily_cap: parseCampaignCap(campaign.daily_cap),
    total_cap: parseCampaignCap(campaign.total_cap),
    batch_max: asPositiveInteger(campaign.batch_max, null),
    market_cap: parseCampaignCap(campaign.market_cap),
    per_sender_cap: parseCampaignCap(campaign.per_sender_cap),
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
  // Override (input/campaign) else the configured per-number limit; never a literal.
  const perSenderCap = effectivePerSenderCap({ input, campaign, configured: input.per_sender_cap_default })
  const perMarketCap = asPositiveInteger(
    input.per_market_cap ?? input.perMarketCap ?? input.market_cap ?? campaign.market_cap,
    capFallback
  )
  const totalCap = asPositiveInteger(input.total_cap ?? input.totalCap ?? campaign.total_cap, null)
  // A cap of 0 is "send nothing" (campaign-caps.js). The positive-int reads
  // above turned 0 into a fallback (batch_max / 500), so a campaign throttled
  // to zero planned a full batch. The campaign row's 0 always wins; an input
  // 0 (an operator's explicit throttle for this run) does too.
  const zeroCaps = [...new Set([
    ...zeroCampaignCaps(campaign),
    ...zeroCampaignCaps({
      daily_cap: input.daily_cap ?? input.dailyCap,
      total_cap: input.total_cap ?? input.totalCap,
      market_cap: input.per_market_cap ?? input.perMarketCap ?? input.market_cap,
      per_sender_cap: input.per_sender_cap ?? input.perSenderCap,
    }),
  ])]
  if (zeroCaps.length) {
    return {
      max_targets: 0,
      daily_cap: zeroCaps.includes('daily_cap') ? 0 : dailyCap,
      per_sender_cap: zeroCaps.includes('per_sender_cap') ? 0 : perSenderCap,
      per_market_cap: zeroCaps.includes('market_cap') ? 0 : perMarketCap,
      batch_max: batchMax || capFallback,
      total_cap: zeroCaps.includes('total_cap') ? 0 : totalCap,
      effective_limit: 0,
      zero_caps: zeroCaps,
    }
  }
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
    zero_caps: [],
  }
}

function missingLaunchCaps(caps = {}) {
  const missing = []
  // A zero cap is set (to "send nothing"), not missing; it blocks on its own.
  if (caps.zero_caps?.length) return missing
  if (!caps.max_targets && !caps.effective_limit) missing.push('max_targets')
  if (!caps.daily_cap) missing.push('daily_cap')
  if (!caps.per_market_cap) missing.push('per_market_cap')
  return missing
}

function toE164(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return raw.startsWith('+') ? raw : raw
}

/**
 * SENDER PERSONA. Each owner record carries the agent persona the operator
 * assigned (master_owners.agent_persona, e.g. "Michael Hargrove"); a campaign
 * target does not. Without this lookup every campaign text rendered the
 * feeder's literal fallback, so 652 texts said "this is Alex" (2026-09-19..30),
 * including owners whose record names someone else.
 *
 * Fail-soft by design: a read error leaves the map empty and rendering behaves
 * exactly as before, rather than holding the whole plan.
 */
export async function loadOwnerPersonas(supabase, ownerIds = [], { chunkSize = 200 } = {}) {
  const ids = [...new Set(ownerIds.map((id) => clean(id)).filter(Boolean))]
  const personas = new Map()
  try {
    for (let i = 0; i < ids.length; i += chunkSize) {
      const { data, error } = await supabase
        .from('master_owners')
        .select('master_owner_id,agent_persona')
        .in('master_owner_id', ids.slice(i, i + chunkSize))
      if (error) throw error
      for (const row of data || []) {
        const persona = clean(row.agent_persona)
        if (persona) personas.set(clean(row.master_owner_id), persona)
      }
    }
  } catch (error) {
    console.warn('[CAMPAIGN_OWNER_PERSONA_READ_FAILED]', error?.message || error)
    return new Map()
  }
  return personas
}

/** The owner's persona, unless the candidate already names one. */
export function applyOwnerPersona(candidate = {}, personas = new Map()) {
  if (!candidate || clean(candidate.agent_persona)) return candidate
  const persona = personas.get(clean(candidate.master_owner_id))
  if (persona) candidate.agent_persona = persona
  return candidate
}

export function launchCandidateFromTarget(target = {}, campaign = {}) {
  const metadata = metadataObject(target.metadata)
  const snapshot = metadataObject(metadata.candidate_snapshot)
  const outreach = metadataObject(metadata.outreach_snapshot)
  // Always E.164. Targets can carry a bare 10-digit number ("6125589879"); a
  // queue row written that way is invisible to every lookup keyed on the E.164
  // thread — reply context, dedupe, prior contact (2026-09-28 Minneapolis).
  const phone = toE164(firstNonEmpty(snapshot.canonical_e164, target.to_phone_number, snapshot.to_phone_number))
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
  const storedTimezone = firstNonEmpty(target.timezone, snapshot.timezone)
  /**
   * THE PROPERTY'S ZONE, NOT THE OWNER'S PHONE.
   *
   * Older targets stored a LABEL inherited from master_owners.routing_timezone
   * (owner phone area code). Measured 2026-10-01 on non-archived campaigns:
   * "LA - TEST" has a CA property stored "Central" (08:00 CT = 06:00 PT, a
   * pre-dawn text); "Miami - Test Campaign" has 8 FL properties stored
   * "Central" and 6 stored "Pacific". When a target HAS a usable stored zone
   * and the property's own state (+ ZIP for split-zone states) resolves
   * confidently to a different one, geography wins. A missing or invalid stored
   * zone still fails closed (missing_timezone / invalid_timezone) exactly as
   * before — the correction never turns a broken target into a sendable one.
   */
  const storedIsUsable = Boolean(storedTimezone) && isValidIanaTimezone(resolveTimezone(storedTimezone))
  const geo = storedIsUsable
    ? deriveTimezoneFromGeography(
      firstNonEmpty(target.state, snapshot.state, snapshot.property_state, snapshot.property_address_state),
      firstNonEmpty(snapshot.property_zip, snapshot.property_address_zip, snapshot.zip),
    )
    : { confident: false, iana: null }
  const rawTimezone = geo.confident && geo.iana ? geo.iana : storedTimezone
  const sourceTimezone = rawTimezone || 'America/Chicago'
  const timezone = resolveTimezone(sourceTimezone)
  /**
   * Validate the RESOLVED zone, not the raw label.
   *
   * campaign_targets.timezone stores human labels, never IANA — across the live
   * campaigns it holds Eastern 938, Central 228, Pacific 53, Mountain 4 and zero
   * IANA strings. This used to test rawTimezone with isValidIanaTimezone, which
   * rejects "Eastern", one line BEFORE resolveTimezone turned that same "Eastern"
   * into America/New_York. Result: 1,029 ready recipients discarded as
   * invalid_timezone on every 5-minute run (Tax Delinquent 363 of 373, Miami 666
   * of 789) over a value the code resolves correctly by itself.
   *
   * This does NOT weaken the fail-closed intent. resolveTimezone maps known
   * labels and passes anything unrecognised straight through, so real garbage
   * ("Narnia") still resolves to "Narnia", still fails isValidIanaTimezone and is
   * still blocked. A missing timezone is still caught first, separately.
   */
  const timezoneEligibilityReason = !rawTimezone
    ? 'missing_timezone'
    : !isValidIanaTimezone(timezone)
      ? 'invalid_timezone'
      : null
  const sellerName = firstNonEmpty(
    snapshot.seller_full_name,
    target.owner_name,
    snapshot.owner_name,
    metadata.owner_name
  )
  // campaign.language_policy is deliberately NOT in this chain: it is a policy
  // token ('auto'), and treating it as a language is what starved the template
  // fetch. Unknown falls through to the resolver's documented English default.
  const languageRaw = firstNonEmpty(target.language, snapshot.language, 'English')
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
    timezone_basis: geo.confident && geo.iana ? 'property_geography' : (storedTimezone ? 'stored_target' : 'missing'),
    ...(geo.confident && geo.iana && storedTimezone && resolveTimezone(storedTimezone) !== geo.iana ? { timezone_corrected_from: storedTimezone } : {}),
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

function neverDelivered(row = {}) {
  if (row.is_final_failure === true) return true
  const status = lower(row.raw_carrier_status || row.delivery_status)
  return status === 'failed' || status === 'undelivered'
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
        .select('id,to_phone_number,direction,event_type,sent_at,event_timestamp,created_at,queue_id,raw_carrier_status,delivery_status,is_final_failure')
        .in('to_phone_number', phoneChunk)
        .limit(5000),
    ])
    if (queueResult.error) throw queueResult.error
    if (eventResult.error) throw eventResult.error
    rows.push(...(queueResult.data || []).map((row) => ({ ...row, source: 'send_queue' })))
    rows.push(...(eventResult.data || [])
      .filter((row) => lower(row.direction || row.event_type).includes('out'))
      // A message the carrier refused never reached the seller: it is not
      // contact. Counting it made a spam-filtered seller unreachable forever.
      .filter((row) => !neverDelivered(row))
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
  // A carrier-filtered touch retried on a different template is a SECOND action
  // for this target+touch; the dispatch identity keys it by this generation.
  const spamRetryGeneration = Math.max(0, Math.trunc(Number(target?.metadata?.spam_retry_count) || 0))
  const metadata = {
    source: 'campaign_launch_execution',
    campaign_id: campaign.id,
    campaign_target_id: target.id,
    ...(spamRetryGeneration > 0 ? { spam_retry_generation: spamRetryGeneration } : {}),
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
    agent_name: clean(campaign.agent_persona) || clean(candidate.agent_persona) || null,
    language: candidate.language || null,
    routing_reason: routing.selection_reason || routing.routing_rule_name || null,
    campaign_id: campaign.id,
    campaign_target_id: target.id,
    campaign_send_window_id: window.id || null,
    metadata,
  }
}

/**
 * TARGET INTEGRITY — an explicit selection is a PINNED SET.
 *
 * A campaign built from explicitly selected identities may only ever reach the
 * identities that were selected. Not a superset, not "the valid subset plus
 * whatever else resolved".
 *
 * This guard exists because the builder fix alone is not enough. Before
 * 2026-09-14 an unresolved target filter meant "no narrowing", so a build
 * targeted every reachable row; the builder now refuses on dropped filters,
 * but campaigns CONTAMINATED BY THAT BUG ALREADY EXIST and their rows are
 * still sitting in campaign_targets. Campaign df0671fa holds 984 target rows
 * for a 186-property selection, only 106 of them inside it.
 *
 * So containment is enforced HERE, at the pre-queue authority every execution
 * path funnels through, rather than at the point of building. A fixed builder
 * protects future campaigns; this protects outbound.
 *
 * Deliberately all-or-nothing: enqueuing the contained subset and dropping the
 * rest would turn a detectable integrity failure into a silent partial send,
 * and would leave the operator believing the campaign is fine.
 */
/** Selected property ids from a campaign's persisted target definition. */
export function explicitSelectedPropertyIds(campaign = {}) {
  const filters = metadataObject(campaign.metadata?.target_filters)
  const selected = new Set()
  for (const value of Object.values(filters)) {
    if (!Array.isArray(value)) continue
    for (const clause of value) {
      if (clean(clause?.field_key) !== 'properties.property_id') continue
      const raw = clause?.value
      const list = Array.isArray(raw) ? raw : [raw]
      for (const entry of list) {
        const id = clean(entry)
        if (id) selected.add(id)
      }
    }
  }
  return selected
}

/**
 * TARGET INTEGRITY — an explicit selection is a PINNED SET.
 *
 * A campaign built from explicitly selected identities may only ever reach
 * those identities. Not a superset, and not "the contained subset plus
 * whatever else resolved".
 *
 * Checked against the campaign's ENTIRE target set, not the rows that happen
 * to be queueable right now. That distinction is the whole guard: every one of
 * the 984 contaminated rows on campaign df0671fa carries
 * `target_status = 'blocked'`, so a check over ready candidates alone inspects
 * nothing and reports "contained" for a campaign holding 878 unselected
 * properties. Readiness is transient; a widened target set is a property of
 * the campaign.
 *
 * Counted in the database rather than fetched, so it stays exact and cheap on
 * a large campaign — and so it cannot repeat the mistake of paginating rows
 * into application code to count them.
 *
 * Deliberately all-or-nothing: enqueuing the contained subset would turn a
 * detectable integrity failure into a silent partial send and leave the
 * operator believing the campaign is sound.
 */
export async function checkExplicitTargetContainment(campaign = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const mode = resolveCampaignTargetMode(campaign.metadata)
  if (mode.target_mode !== 'explicit' && mode.target_mode !== 'explicit_filtered') {
    return { applies: false, contained: true }
  }

  const selected = [...explicitSelectedPropertyIds(campaign)]
  const countTargets = async (build) => {
    const query = build(
      supabase.from('campaign_targets').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id),
    )
    const { count, error } = await query
    if (error) throw error
    return count ?? 0
  }

  const total = await countTargets((q) => q)

  // An explicit definition with no resolvable ids has nothing to contain
  // against, so nothing may be enqueued.
  if (selected.length === 0) {
    return {
      applies: true,
      contained: total === 0,
      reason: total === 0 ? null : 'explicit_selection_empty',
      selected_property_count: 0,
      candidate_target_count: total,
      inside_selection_count: 0,
      outside_selection_count: total,
    }
  }

  // Chunked so a large pinned list cannot overflow one PostgREST `in` list.
  const CHUNK = 150
  let inside = 0
  for (let i = 0; i < selected.length; i += CHUNK) {
    const chunk = selected.slice(i, i + CHUNK)
    inside += await countTargets((q) => q.in('property_id', chunk))
  }

  const outside = Math.max(0, total - inside)
  return {
    applies: true,
    contained: outside === 0,
    reason: outside === 0 ? null : 'targets_outside_explicit_selection',
    selected_property_count: selected.length,
    candidate_target_count: total,
    inside_selection_count: inside,
    outside_selection_count: outside,
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

/** How many skipped targets a launch event carries as examples. */
const PLAN_EVENT_SKIP_SAMPLE = 10

/** Skip reasons that all mean "no sender could carry this seller". */
const SENDER_SKIP_REASONS = Object.freeze([
  'sender_blocked_by_operator',
  'local_senders_unavailable',
  'no_local_sender_number',
  'missing_selected_sender_number',
  'routing_blocked',
  'ROUTING_BLOCKED',
  'NO_VALID_TEXTGRID_NUMBER',
])

const PLAN_SKIP_LABELS = Object.freeze({
  sender_blocked_by_operator: 'sender blocked by operator',
  local_senders_unavailable: 'no local sender available',
  no_local_sender_number: 'no sender number in their market',
  ROUTING_BLOCKED: 'no approved sender route',
  NO_VALID_TEXTGRID_NUMBER: 'no active sender number',
  TEMPLATE_RENDER_LINT_FAILURE: 'message failed the template check',
  NO_TEMPLATE: 'no approved message',
  TEMPLATE_GOVERNANCE_PAUSED: 'every fitting message is paused by template governance',
  TEMPLATE_DAILY_CAP_EXHAUSTED: 'every fitting message reached today\'s cap',
  template_blocked_by_operator: 'message blocked by operator',
  active_queue_row_exists: 'already queued',
  prior_contacted_suppression: 'already contacted',
  prior_reply_not_owner: 'replied not the owner',
  graph_suppression_or_queue_block: 'suppressed',
  duplicate_phone_in_launch_batch: 'duplicate phone',
  per_sender_cap_reached: 'sender daily cap reached',
  per_market_cap_reached: 'market cap reached',
  schedule_window_full: 'contact window full today',
  missing_prospect_id: 'no resolved person',
  missing_to_phone_number: 'no phone',
})

const SENDER_STATE_LABELS = Object.freeze({
  blocked_by_operator: 'blocked by operator',
  status_paused: 'paused',
  health_cooling: 'cooling',
  cooling_until: 'cooling',
  daily_limit_reached: 'at its daily limit',
})

/**
 * Routing failures, named by what fixes them. The router reports a bare
 * ROUTING_BLOCKED; the plan says whether the local numbers are blocked by an
 * operator, unavailable (paused / cooling / capped), or absent.
 */
function routingSkipReason(routing = {}) {
  switch (routing.routing_block_reason) {
    case 'LOCAL_NUMBERS_BLOCKED_BY_OPERATOR': return 'sender_blocked_by_operator'
    case 'LOCAL_NUMBERS_UNAVAILABLE': return 'local_senders_unavailable'
    case 'NO_VALID_LOCAL_TEXTGRID_NUMBER': return 'no_local_sender_number'
    default: return routing.reason_code || routing.routing_block_reason || 'routing_blocked'
  }
}

function summarizeLocalSenders(inventory = []) {
  return (Array.isArray(inventory) ? inventory : []).slice(0, 10).map((entry) => ({
    phone_number: entry.phone_number || null,
    state: entry.unavailable_reason || 'available',
  }))
}

function noteRoutingBlock(byMarket, market, reason, routing = {}) {
  const key = clean(market) || 'Unknown market'
  if (!byMarket[key] && Object.keys(byMarket).length >= 25) return
  const entry = byMarket[key] || (byMarket[key] = { targets: 0, reason, senders: summarizeLocalSenders(routing.local_sender_inventory) })
  entry.targets += 1
}

/** "84 sender blocked by operator (Miami, FL: +1305… blocked by operator; +1786… cooling)" */
export function describePlanSkips(skippedCounts = {}, routingBlocksByMarket = {}) {
  const top = Object.entries(skippedCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 3)
  if (!top.length) return ''
  return top.map(([reason, count]) => {
    const label = PLAN_SKIP_LABELS[reason] || reason.replace(/_/g, ' ').toLowerCase()
    const markets = Object.entries(routingBlocksByMarket || {})
      .filter(([, entry]) => entry.reason === reason)
      .slice(0, 3)
      .map(([market, entry]) => {
        const senders = (entry.senders || [])
          .map((sender) => `${sender.phone_number} ${SENDER_STATE_LABELS[sender.state] || String(sender.state || '').replace(/_/g, ' ')}`)
          .join('; ')
        return senders ? `${market}: ${senders}` : market
      })
    return `${count} ${label}${markets.length ? ` (${markets.join(' | ')})` : ''}`
  }).join(', ')
}

/**
 * Reads a plan would otherwise repeat for every target, done once: the sender
 * fleet, the template pool per (use case, language) and the cohort's recent
 * template history. A dry-run plan of 539 targets made ~2,000 round trips and
 * outlived the dashboard's two-minute request ("Couldn't verify messages").
 * Test doubles supplied through deps always win.
 */
async function buildQueuePlanReadDeps(readyTargets = [], caps = {}, deps = {}, { fullCohort = false } = {}) {
  const planDeps = { ...deps }
  if (!Array.isArray(deps.textgridNumberRows) && typeof deps.chooseTextgridNumber !== 'function') {
    const fleet = await loadTextgridNumberFleet(deps).catch(() => null)
    if (Array.isArray(fleet)) planDeps.textgridNumberRows = fleet
  }
  if (!(deps.templateFetchCache instanceof Map)) planDeps.templateFetchCache = new Map()
  if (typeof deps.getRecentTemplateIds !== 'function') {
    // The loop stops once the plan is full, so read ahead only as far as it is likely to go.
    const reach = fullCohort
      ? readyTargets.length
      : Math.min(readyTargets.length, Math.max(300, Number(caps.effective_limit || 0) * 2))
    const owners = readyTargets.slice(0, reach)
      .map((target) => clean(target.master_owner_id || target.metadata?.candidate_snapshot?.master_owner_id))
      .filter(Boolean)
    const history = owners.length ? await prefetchRecentTemplateHistory(owners, deps).catch(() => null) : null
    if (history) planDeps.getRecentTemplateIds = recentTemplateIdsFromHistory(history, deps)
  }
  return planDeps
}

/**
 * THE ROLLING PLAN — how a campaign actually goes out.
 *
 * The worker places rows in batches (queue_run_limit, batch_max) and the
 * feeder keeps refilling, so a campaign is not "sending to 50": every
 * schedulable seller is messaged, at the pace the campaign allows. A day's
 * sends are bounded by the daily cap, by how many spaced messages fit in the
 * contact window (per timezone), and by how many texts the available sender
 * numbers may carry (per_sender_cap each). The smallest bound is the pace.
 */
export function buildRollingPlan({
  ready = 0,
  schedulable = 0,
  caps = {},
  intervalSeconds = 60,
  scheduleCampaign = {},
  timezoneGroups = 1,
  sendableSendersByMarket = null,
  firstScheduledAt = null,
  scheduledToday = 0,
  pacedToLaterDays = 0,
  fullCohort = false,
} = {}) {
  const startMin = parseTimeMinutes(scheduleCampaign.contact_window_start, 8 * 60)
  const endMin = parseTimeMinutes(scheduleCampaign.contact_window_end, 21 * 60)
  const windowMinutes = endMin > startMin ? endMin - startMin : (24 * 60 - startMin) + endMin
  const spacing = Math.max(1, Number(intervalSeconds) || 60)
  const windowCapacity = Math.max(1, Math.floor((windowMinutes * 60) / spacing)) * Math.max(1, Number(timezoneGroups) || 1)
  const dailyCap = parseCampaignCap(caps.daily_cap)
  const perSenderCap = Number(caps.per_sender_cap) > 0 ? Number(caps.per_sender_cap) : null
  const sendableSenders = sendableSendersByMarket
    ? Object.values(sendableSendersByMarket).reduce((sum, count) => sum + Number(count || 0), 0)
    : null
  const senderCapacity = perSenderCap && sendableSenders ? perSenderCap * sendableSenders : null
  const bounds = [
    ['daily_cap', dailyCap],
    ['contact_window', windowCapacity],
    ['sender_capacity', senderCapacity],
  ].filter(([, value]) => Number.isFinite(value) && value > 0)
  // daily_cap 0 = send nothing: the projection says so instead of dropping the bound.
  const [binding, sendsPerDay] = dailyCap === 0
    ? ['daily_cap', 0]
    : bounds.reduce((min, bound) => (bound[1] < min[1] ? bound : min), bounds[0] || ['contact_window', windowCapacity])
  const count = Math.max(0, Number(schedulable) || 0)
  return {
    ready: Number(ready) || 0,
    schedulable: count,
    not_schedulable: Math.max(0, (Number(ready) || 0) - count),
    daily_cap: dailyCap,
    spread_interval_seconds: spacing,
    contact_window: {
      start: scheduleCampaign.contact_window_start || null,
      end: scheduleCampaign.contact_window_end || null,
      minutes: windowMinutes,
    },
    window_capacity_per_day: windowCapacity,
    per_sender_cap: perSenderCap,
    sendable_senders: sendableSenders,
    sendable_senders_by_market: sendableSendersByMarket,
    sender_capacity_per_day: senderCapacity,
    sends_per_day: sendsPerDay,
    binding,
    days_to_complete: count > 0 ? (sendsPerDay > 0 ? Math.ceil(count / sendsPerDay) : null) : 0,
    first_send_at: firstScheduledAt,
    first_day_scheduled: Number(scheduledToday) || 0,
    after_first_day: Number(pacedToLaterDays) || 0,
    full_cohort: Boolean(fullCohort),
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
  /**
   * §7 — a canary campaign may only lift prior-contact suppression with the
   * same internal authorization its AUDIENCE required. Otherwise "this is a
   * proof" would be enough to disable a safety rule. Production keeps its
   * existing operator control unchanged.
   */
  if (suppressPreviouslyContacted === false) {
    const campaignForOverride = await getCampaign(campaignId, deps).catch(() => null)
    const overrideVerdict = evaluateRecontactOverride({
      suppress_previously_contacted: false,
      candidate_source: campaignForOverride?.campaign?.candidate_source
        || input.candidate_source
        || null,
      internal_authorized: input.internal_authorized === true,
      destinations: Array.isArray(input.recontact_destinations) ? input.recontact_destinations : [],
    })
    if (!overrideVerdict.ok) {
      return {
        ok: false,
        success: false,
        campaign_id: campaignId,
        blockers: [overrideVerdict.reason],
        exact_blockers: [overrideVerdict.reason],
        recontact_override_scope: overrideVerdict.scope,
        queue_rows_created: 0,
        no_send_queue_rows_created: true,
      }
    }
  }

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

  /**
   * Containment is checked BEFORE the execution lock, before any run row and
   * before any write, so a violation costs nothing and leaves no trace beyond
   * the refusal itself.
   */
  const containment = await checkExplicitTargetContainment(campaign, deps)
  if (containment.applies && !containment.contained) {
    await recordCampaignEvent({
      campaign_id: campaignId,
      event_type: 'campaign.queue_plan_refused_target_integrity',
      severity: 'error',
      title: 'Queue plan refused: targets outside the explicit selection',
      description: `${containment.outside_selection_count} candidate target(s) fall outside the `
        + `${containment.selected_property_count} explicitly selected propert(ies). No queue rows created.`,
      metadata: containment,
    }, deps).catch(() => { /* refusal must not depend on the audit write */ })

    return {
      ok: false,
      status: 409,
      error: 'TARGET_INTEGRITY_VIOLATION',
      message: 'Refusing to queue: this campaign targets explicitly selected properties, and '
        + `${containment.outside_selection_count} of ${containment.candidate_target_count} candidate targets are `
        + 'outside that selection. Rebuild targeting from the stored definition before launching.',
      campaign_id: campaignId,
      blockers: ['target_integrity_violation'],
      exact_blockers: ['target_integrity_violation'],
      target_integrity: containment,
      // Explicit zeroes: nothing was planned, created, or enqueued.
      planned_target_count: 0,
      targets_created: 0,
      send_queue_rows_created: 0,
      queue_rows_created: 0,
      inserted_queue_rows: [],
    }
  }

  const perSenderCapDefault = await (deps.loadConfiguredPerSenderCap || loadConfiguredPerSenderCap)(deps)
  const caps = resolveLaunchCaps(campaign, { ...input, per_sender_cap_default: perSenderCapDefault }, readyTargets.length)
  const hydrateNoSend = writeMode.hydrateNoSend
  const isLiveSendWrite = writeMode.isLiveSendWrite
  const productionLiveWrite = writeMode.productionLiveWrite === true
  const blockers = []
  for (const cap of missingLaunchCaps(caps)) blockers.push(`missing_cap:${cap}`)
  for (const cap of caps.zero_caps || []) blockers.push(`campaign_cap_zero:${cap}`)
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
  /**
   * PHONE SHAPE. campaign_targets.to_phone_number is stored as 10 digits;
   * send_queue / message_events store E.164. Looking rows up by the raw target
   * phone matched nothing, so "already queued" and "already contacted" never
   * fired for a 10-digit target (2026-10-08: a seller who replied "gave it to
   * my daughter" on 9-28 got a new campaign's touch-1 on 10-06 while a nurture
   * was scheduled for them). Look up both shapes; key every map by phoneKey().
   */
  const lookupPhones = phoneLookupVariants(phones)
  const [activeQueueRows, priorContactRows, openerReplyFacts] = await Promise.all([
    lookupPhones.length ? fetchActiveQueueRowsByPhone(supabase, lookupPhones) : Promise.resolve([]),
    suppressPreviouslyContacted && lookupPhones.length ? fetchPriorContactRowsByPhone(supabase, lookupPhones) : Promise.resolve([]),
    lookupPhones.length ? loadOpenerReplyFacts(supabase, lookupPhones) : Promise.resolve(new Map()),
  ])
  const activeByPhone = new Map()
  const priorByPhone = new Map()
  for (const row of activeQueueRows) {
    const phone = phoneKey(row.to_phone_number)
    if (!phone) continue
    if (!activeByPhone.has(phone)) activeByPhone.set(phone, [])
    activeByPhone.get(phone).push(row)
  }
  for (const row of priorContactRows) {
    const phone = phoneKey(row.to_phone_number)
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
  // Every target whose template check failed (not a sample): the feeder holds
  // them instead of re-rendering them every cycle (campaign-template-hold.js).
  const templateHolds = []
  const skippedCounts = {}
  const senderCounts = {}
  const senderMarketCounts = {}
  const templateCounts = {}
  const routingCounts = {}
  const marketCounts = {}
  const seenPhones = new Set()
  /**
   * per_sender_cap is a PER-DAY limit per sender number. These counters were
   * per plan call, which was only right while one call planned the whole day;
   * a rolling refill plans in chunks, so the feeder seeds what each sender
   * already carries today for this campaign (sender_use_seed).
   */
  const senderUseCounts = { ...(input.sender_use_seed && typeof input.sender_use_seed === 'object' ? input.sender_use_seed : {}) }
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

  // Same operator blocklists the send-time health guard enforces. A read
  // failure leaves the sets empty; the send-time guard still refuses the row.
  const dispatchBlocked = await (deps.loadDispatchBlockedSets || loadDispatchBlockedSets)()
    .catch(() => ({ template_ids: new Set(), sender_numbers: new Set() }))
  launchOptions.blocked_template_ids = dispatchBlocked.template_ids
  // The router skips operator-blocked senders itself, so a market with one
  // blocked and one usable number routes to the usable one (see
  // chooseTextgridNumber) instead of every target dead-ending on the block.
  launchOptions.blocked_sender_numbers = dispatchBlocked.sender_numbers
  /**
   * TEMPLATE GOVERNANCE (rc-7.1 D8). Target assignment and target-one enqueue
   * consulted ownership_template_rotation_control; this bulk path did not, and
   * 151 campaign sends (09-28→09-30) used templates governance paused in May.
   * Governed-but-not-sendable templates now leave the render pool, so rotation
   * lands on a sendable sibling; a seller with nothing sendable left is held
   * (TEMPLATE_GOVERNANCE_PAUSED → campaign-template-hold.js), not dropped.
   * Ungoverned (never reviewed) templates stay usable here — see
   * governanceExcludedTemplateIds. An unreadable governance table writes no
   * rows (blocker), because no send-time check backs this one up.
   */
  let governanceExcluded = new Set()
  let governanceApplied = false
  // Template sends placed today, by template_id, for every template whose
  // daily cap binds. Seeded from send_queue and advanced as this pass places
  // rows, so a cap is honoured within one plan as well as across runs.
  let templateUsedToday = null
  let ungovernedPolicy = UNGOVERNED_POLICY.ALLOW
  if (governanceApplies(launchOptions.template_use_case)) {
    try {
      const governanceById = await (deps.loadGovernance || loadGovernance)(supabase)
      governanceExcluded = governanceExcludedTemplateIds(governanceById)
      /**
       * ONE eligibility verdict (evaluateRotationEligibility) for this path
       * and target-one enqueue. The render pool now also drops templates
       * whose DAILY cap is reached (211393, cap 30, was placed 152 times on
       * 2026-10-07 because no path counted today's sends) and rotation is
       * weighted by traffic_weight. Never-reviewed templates stay usable here
       * (UNGOVERNED_POLICY.ALLOW) until system_control
       * template_governance_fail_closed = 'true' — flip it once the
       * ungoverned catalogue has rotation rows, or fail-closed would shrink
       * the English first-touch pool to the handful already governed.
       */
      const failClosed = String(await (deps.getSystemValue || getSystemValue)('template_governance_fail_closed', deps).catch(() => '') ?? '').trim().toLowerCase() === 'true'
      ungovernedPolicy = failClosed ? UNGOVERNED_POLICY.DENY : UNGOVERNED_POLICY.ALLOW
      try {
        templateUsedToday = await (deps.loadTemplateUsedToday || loadTemplateUsedToday)(supabase, cappedSendableTemplateIds(governanceById), now.toISOString())
      } catch (usageError) {
        blockers.push('template_daily_usage_unreadable')
        console.warn('campaign_plan.template_daily_usage_unreadable', { campaign_id: campaignId, error: usageError?.message || String(usageError) })
      }
      launchOptions.rotation_governance = governanceById
      launchOptions.template_used_today = templateUsedToday || new Map()
      launchOptions.ungoverned_policy = ungovernedPolicy
      governanceApplied = true
    } catch (governanceError) {
      blockers.push('template_governance_unreadable')
      console.warn('campaign_plan.template_governance_unreadable', { campaign_id: campaignId, error: governanceError?.message || String(governanceError) })
    }
  }
  launchOptions.governance_excluded_template_ids = governanceExcluded
  /**
   * FULL-COHORT PREFLIGHT (dry run only). The Launch screen asks "will every
   * ready seller get a message, and how long will it take?" — not "what fits
   * in one worker batch". It evaluated one batch (batch_max 50/100) and then
   * presented that batch as the launch ("sending to 50", "a system limit of 50
   * per run applies"). Here every ready target is routed and rendered; the
   * per-day caps (sender, market, window) decide WHEN a seller is messaged,
   * not WHETHER, so they shape the rolling plan instead of skipping anyone.
   */
  const fullCohort = dryRun && asBoolean(input.full_cohort ?? input.evaluate_full_cohort, false)
  const planDeps = await buildQueuePlanReadDeps(readyTargets, caps, deps, { fullCohort })
  const routingBlocksByMarket = {}
  // An explicit campaign persona wins; otherwise each owner's own (see loadOwnerPersonas).
  const ownerPersonas = clean(campaign.agent_persona)
    ? new Map()
    : await (deps.loadOwnerPersonas || loadOwnerPersonas)(supabase, readyTargets.map((target) => target.master_owner_id))
  let planLoopCounter = 0
  for (const target of readyTargets) {
    if (!fullCohort && plannedItems.length >= caps.effective_limit) break
    // Keep the execution lease alive across long planning passes (per-target
    // routing + template render are async and can exceed the lease TTL).
    if (executionLock.token && (planLoopCounter++ % 250) === 0) {
      await renewCampaignExecutionLock(supabase, campaignId, executionLock.token)
    }
    const candidate = applyOwnerPersona(launchCandidateFromTarget(target, campaign), ownerPersonas)
    const phone = clean(candidate.canonical_e164)
    if (!phone) {
      recordSkip('missing_to_phone_number', target)
      continue
    }
    /**
     * Identity at queue time: a resolved PERSON and a reachable PHONE.
     *
     * This gate independently repeated the build-time linkage check against
     * the same three retired `public.phones` identifiers, so repairing
     * readiness alone was not enough — a target could be `target_status:
     * ready` and still be skipped here as `missing_master_owner_id` /
     * `missing_phone_id`. Measured on a real six-property graph cohort: 6
     * ready targets, 0 planned, skipped 2 + 4 on exactly those two fields.
     *
     * `phone_id` needs no check at all: `canonical_e164` is verified directly
     * above, and it is the reachability fact. `master_owner_id` is provenance
     * "where applicable" — absent on ~74% of graph rows across every ownership
     * shape — so it cannot gate outreach.
     *
     * The person check stays, and the canonical owner/identity verification
     * below is untouched.
     */
    if (!candidate.prospect_id) {
      recordSkip('missing_prospect_id', target)
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
    const phoneLookupKey = phoneKey(phone)
    if (activeByPhone.has(phoneLookupKey)) {
      recordSkip('active_queue_row_exists', target, {
        active_queue_row_ids: activeByPhone.get(phoneLookupKey).slice(0, 5).map((row) => row.id),
      })
      continue
    }
    // A not-owner / former-owner / wrong-number reply ends openers for that
    // person × property (wrong number: for the phone). Never lifted by the
    // previously-contacted override — it is a statement, not a contact count.
    const notOwner = evaluateOpenerReplyExclusion({
      property_id: candidate.property_id || target.property_id || null,
      ...(openerReplyFacts.get(phoneLookupKey) || {}),
    })
    if (notOwner.excluded) {
      recordSkip('prior_reply_not_owner', target, { scope: notOwner.scope, signal: notOwner.signal, source: notOwner.source })
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
      if (outreachTouched || priorByPhone.has(phoneLookupKey)) {
        recordSkip('prior_contacted_suppression', target, {
          prior_contact_row_ids: (priorByPhone.get(phoneLookupKey) || []).slice(0, 5).map((row) => row.id),
        })
        continue
      }
    }

    const routing = await chooseTextgridNumber(candidate, launchOptions, planDeps)
    if (!routing.ok) {
      const routingSkip = routingSkipReason(routing)
      recordSkip(routingSkip, target, {
        routing_block_reason: routing.routing_block_reason || null,
        local_senders: summarizeLocalSenders(routing.local_sender_inventory),
      })
      noteRoutingBlock(routingBlocksByMarket, candidate.market || target.market, routingSkip, routing)
      continue
    }
    const senderNumber = routeSenderNumber(routing)
    const senderKey = senderNumber || 'unknown_sender'
    if (!senderNumber) {
      recordSkip('missing_selected_sender_number', target)
      continue
    }
    /**
     * The operator blocklists (system_control.sms_blocked_sender_numbers /
     * sms_blocked_template_ids) were enforced only at SEND time by the health
     * guard; planning never read them, so a campaign queued rows onto a blocked
     * number or template and each one was burned as blocked_by_health_guard
     * (Minneapolis 2026-09-28: its only number, then 47 rows on 5 blocked
     * templates). Honour the same lists when planning: the target stays
     * `ready` and the campaign reports why it could not place it.
     */
    if (isSenderDispatchBlocked(senderNumber, dispatchBlocked)) {
      recordSkip('sender_blocked_by_operator', target, { sender: senderNumber })
      continue
    }
    if (!fullCohort && caps.per_sender_cap && Number(senderUseCounts[senderKey] || 0) >= caps.per_sender_cap) {
      recordSkip('per_sender_cap_reached', target, { sender: senderNumber })
      continue
    }
    const marketKey = clean(candidate.market || target.market || 'unknown')
    if (!fullCohort && caps.per_market_cap && Number(marketUseCounts[marketKey] || 0) >= caps.per_market_cap) {
      recordSkip('per_market_cap_reached', target, { market: marketKey })
      continue
    }

    // A seller whose earlier text was carrier-filtered never gets that template again.
    const targetExcluded = Array.isArray(target.metadata?.excluded_template_ids) ? target.metadata.excluded_template_ids.map(String) : []
    const renderOptions = targetExcluded.length
      ? { ...launchOptions, blocked_template_ids: new Set([...(launchOptions.blocked_template_ids || []), ...targetExcluded]) }
      : launchOptions
    const rendered = await renderOutboundTemplate(candidate, renderOptions, planDeps)
    const templateId = renderedTemplateId(rendered)
    const messageBody = renderedMessageBody(rendered)
    if (templateId && (isTemplateDispatchBlocked(templateId, dispatchBlocked) || targetExcluded.includes(String(templateId)))) {
      recordSkip('template_blocked_by_operator', target, { template_id: templateId })
      continue
    }
    // Backstop: a renderer that ignored the exclusion (an injected one) must
    // still never place a governance-paused template.
    if (templateId && governanceExcluded.has(String(templateId))) {
      templateHolds.push({ target, reason: 'TEMPLATE_GOVERNANCE_PAUSED', detail: 'rendered_governance_paused_template', template_id: templateId })
      recordSkip('TEMPLATE_GOVERNANCE_PAUSED', target, { template_id: templateId })
      continue
    }
    if (!rendered.ok || !templateId || !messageBody) {
      if (isTemplateHoldReason(rendered.reason_code)) {
        templateHolds.push({
          target,
          reason: rendered.reason_code,
          detail: rendered.reason || rendered.render_error_message || null,
          template_id: templateId || null,
        })
      }
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
    if (launchOptions.template_used_today instanceof Map && launchOptions.template_used_today.has(String(templateId))) {
      launchOptions.template_used_today.set(String(templateId), Number(launchOptions.template_used_today.get(String(templateId)) || 0) + 1)
    }
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
  let pacedToLaterDays = 0
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
    /**
     * A refill continues the campaign's cadence after its last queued row
     * (the feeder passes schedule_not_before). Without it every refill restarted
     * at the window start and overlapped rows already queued, doubling the send
     * rate. Rows that no longer fit today stay `ready` for the next window.
     */
    const notBeforeMs = Date.parse(clean(input.schedule_not_before))
    if (Number.isFinite(notBeforeMs)) cursor = Math.max(cursor, notBeforeMs)
    const endMs = new Date(window.window_end_utc).getTime()
    for (const item of group.items) {
      if (cursor >= endMs && fullCohort) {
        // Sends on a later day of the rolling plan — not a skip.
        pacedToLaterDays += 1
        continue
      }
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
      /**
       * INTERNAL-CANARY QUARANTINE, AT THE ONE REGISTERED EXCEPTION.
       *
       * This is the single module allowed to insert `send_queue` rows without
       * `insertSupabaseSendQueueRow`, and that helper is where the canary stamp
       * normally comes from. So a campaign row addressed to a REGISTERED
       * internal test handset was reaching the queue with no
       * `internal_canary` marker at all — which meant it would be counted in
       * production KPIs (`excludeInternalCanaryRows` looks for exactly this
       * flag) and would not be recognised as proof traffic by the operator
       * controls.
       *
       * Applying the same rule the canonical writer applies keeps the one
       * exception honest. It reads the approved registry, so it cannot mark
       * an ordinary seller as a canary.
       */
      for (const queueRow of queueRows) {
        if (!isInternalTestPhone(queueRow?.to_phone_number)) continue
        queueRow.metadata = {
          ...(queueRow.metadata && typeof queueRow.metadata === 'object' ? queueRow.metadata : {}),
          internal_canary: true,
          internal_canary_stamped_by: 'campaign_launch_internal_phone_registry',
          exclude_from_kpis: true,
          /**
           * The ORIGIN the internal-proof contact-window exemption reads.
           *
           * `evaluateInternalProofContactWindowBypass` requires the pinned
           * canary row to declare an internal-canary origin, on top of every
           * other conjunct (scoped canary, validated single-row authorization,
           * active pinned session, recipient/sender/campaign match). Without it
           * a campaign-created canary row carries `source:
           * campaign_launch_execution` and is denied as
           * `origin_surface_not_internal_canary` — which would be correct for
           * an ordinary campaign row and wrong for this one, because the row
           * genuinely originates from the internal canary audience.
           *
           * It grants nothing by itself: this line only runs for destinations
           * already in the approved registry, and the exemption still requires
           * all eleven other conditions.
           */
          origin_surface: 'internal_canary',
        }
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
        // IC8 H2 (observation only): this batch bypasses insertSupabaseSendQueueRow.
        observeCampaignBatchInsert(rowChunk, data)
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
          routing_blocks_by_market: routingBlocksByMarket,
          skip_sample: sampleSkips.slice(0, PLAN_EVENT_SKIP_SAMPLE),
        },
      }, deps)
      /**
       * "0 targets planned; 0 queue rows created." was the whole record of a
       * plan that placed nothing — the reasons lived only in campaign_runs.
       * The event (which is what the activity feed reads) now carries the
       * counts by reason, the per-market sender picture and a small sample.
       */
      const skipTotal = Object.values(skippedCounts).reduce((sum, count) => sum + Number(count || 0), 0)
      const skipSummary = describePlanSkips(skippedCounts, routingBlocksByMarket)
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
        severity: blockers.length ? 'warning' : scheduledItems.length === 0 && skipTotal > 0 ? 'warning' : 'success',
        title: blockers.length ? 'Campaign launch blocked' : 'Campaign launch planned',
        description: (blockers.length
          ? `Blocked by ${blockers.join(', ')}`
          : `${scheduledItems.length} targets planned; ${insertedQueueRows.length} queue rows created.`)
          + (skipSummary ? ` ${scheduledItems.length === 0 ? 'Nothing placed' : 'Held back'}: ${skipSummary}.` : ''),
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
          ready_target_count: readyTargets.length,
          planned_target_count: scheduledItems.length,
          skipped_count: skipTotal,
          skipped_counts_by_reason: skippedCounts,
          routing_blocks_by_market: routingBlocksByMarket,
          skip_sample: sampleSkips.slice(0, PLAN_EVENT_SKIP_SAMPLE),
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
  const plannedSenderMarkets = [...new Set(plannedItems
    .map((item) => clean(item.routing?.selected_textgrid_market || item.routing?.selected?.market))
    .filter(Boolean))]
  const rollingPlan = buildRollingPlan({
    ready: readyTargets.length,
    schedulable: plannedItems.length,
    caps,
    intervalSeconds,
    scheduleCampaign,
    timezoneGroups: grouped.length,
    sendableSendersByMarket: Array.isArray(planDeps.textgridNumberRows)
      ? countSendableSendersByMarket(planDeps.textgridNumberRows, plannedSenderMarkets, { blocked_sender_numbers: dispatchBlocked.sender_numbers })
      : null,
    firstScheduledAt,
    scheduledToday: scheduledItems.length,
    pacedToLaterDays,
    fullCohort,
  })
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
    suppressed: Number(skippedCounts.graph_suppression_or_queue_block || 0) + Number(skippedCounts.prior_contacted_suppression || 0) + Number(skippedCounts.prior_reply_not_owner || 0),
    wrong_number: 0,
    opted_out: 0,
    template_missing: Number(skippedCounts.template_render_failed || 0),
    sender_missing: SENDER_SKIP_REASONS.reduce((sum, key) => sum + Number(skippedCounts[key] || 0), 0),
    outside_contact_window: Number(skippedCounts.schedule_window_full || 0),
    blocked_identity: Number(skippedCounts.missing_master_owner_id || 0) + Number(skippedCounts.missing_prospect_id || 0),
    other_failed: Object.entries(skippedCounts)
      .filter(([key]) => ![
        'active_queue_row_exists', 'duplicate_phone_in_launch_batch', 'graph_suppression_or_queue_block',
        'prior_contacted_suppression', 'prior_reply_not_owner', 'template_render_failed', ...SENDER_SKIP_REASONS,
        'schedule_window_full', 'missing_master_owner_id', 'missing_prospect_id',
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
    /**
     * Reported on SUCCESS as well as refusal, so "the containment guard ran
     * and found nothing outside the selection" is a positive fact rather than
     * something inferred from the absence of an error.
     */
    target_integrity: containment,
    total_ready_targets: readyTargets.length,
    // Full-cohort preflight: every seller that can be messaged (paced over
    // days by rolling_plan); otherwise what this pass scheduled.
    planned_target_count: fullCohort ? plannedItems.length : scheduledItems.length,
    schedulable_target_count: plannedItems.length,
    scheduled_this_pass: scheduledItems.length,
    full_cohort: fullCohort,
    rolling_plan: rollingPlan,
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
    template_governance: {
      applied: governanceApplied,
      excluded_template_ids: [...governanceExcluded],
      ungoverned_templates_allowed: ungovernedPolicy === UNGOVERNED_POLICY.ALLOW,
      ungoverned_policy: ungovernedPolicy,
      daily_cap_used_today: templateUsedToday ? Object.fromEntries(templateUsedToday) : null,
    },
    template_holds: templateHolds.map((hold) => ({
      campaign_target_id: hold.target.id || null,
      reason: hold.reason,
      detail: hold.detail,
      template_id: hold.template_id,
    })),
    // Internal hand-off to the feeder (full target rows for a merge-safe hold).
    template_hold_targets: templateHolds,
    // Per market: why no sender could carry these sellers, number by number.
    routing_blocks_by_market: routingBlocksByMarket,
    skip_summary: describePlanSkips(skippedCounts, routingBlocksByMarket),
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
      per_sender_cap: input.per_sender_cap ?? campaign.per_sender_cap ?? undefined,
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
    // Say why the plan placed nothing — a scheduled launch retried this every
    // five minutes for two hours with only this sentence to show for it.
    const skipSummary = clean(queueResult?.skip_summary)
    return {
      ok: false,
      error: 'activation_no_queue_rows',
      blockers: [skipSummary
        ? `No message could be queued: ${skipSummary}.`
        : 'Activation requires at least one send_queue row, but none were created.'],
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
    // RESUME IS AN EXPLICIT OPERATOR ACTION, and was being gated strictly HARDER
    // than activation. Called with no options it took the uncontrolled branch of
    // evaluateCampaignLaunchReadiness, which blocks on global_auto_enqueue,
    // campaign_auto_queue_enabled and auto_send_enabled - none of which the
    // activation path applies, and none of which the dashboard exposes a control
    // to flip. The operator got CAMPAIGN_BLOCKED on a campaign that the Activate
    // button would have accepted, with no way forward.
    //
    // A human pressing Resume is exactly the "controlled hydration" this flag
    // describes. It does NOT weaken the send rails: the emergency stop and a
    // paused processor become warnings on hydration rather than silent blocks,
    // transmission itself is still governed by queue_processor_mode, and an
    // auto_send_enabled campaign is still blocked as unrestricted_auto_send
    // unless it carries a guarded live launch.
    const readiness = await evaluateCampaignLaunchReadiness(campaignId, deps, {
      explicit_operator_action: true,
    })
    /**
     * RESUMING IS NOT LAUNCHING.
     *
     * The readiness call above is the ACTIVATION validator, and it requires a
     * target at `target_status = 'ready'`. Materializing a target into the
     * queue moves it to `planned` — so a campaign whose recipients had all been
     * queued had zero "ready" targets by construction and could never resume.
     * Pause held the work correctly and nothing could release it; pause became
     * one-way for exactly the campaigns most likely to be paused.
     *
     * Resume asks a different question: not "is there new work to start" but
     * "is there work to continue". Existing non-terminal queue rows answer it.
     * Every OTHER launch blocker still blocks — see the resume evaluator, which
     * relaxes only the missing-recipients code and only when real pending work
     * exists.
     */
    const resumeVerdict = await evaluateCampaignResumeReadiness(campaignId, readiness, deps)
    if (!resumeVerdict.ok) {
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
        resume_reason: resumeVerdict.reason,
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
