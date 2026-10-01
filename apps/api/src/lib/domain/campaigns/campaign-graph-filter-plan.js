/**
 * ONE PREDICATE SOURCE FOR CAMPAIGN AUDIENCE FILTERS (campaign_target_graph).
 *
 * Reach (preview), Build and the builder's field list all answer the same
 * question — "does this catalog field narrow a campaign, and how?" — and they
 * used to answer it three different ways:
 *
 *   • Seller tags / property flags are ';'-joined lists ("Cash Buyer;High
 *     Equity;Tired Landlord"). "Is any of Tired Landlord, High Equity" compiled
 *     to `podio_tags IN ('Tired Landlord','High Equity')` — whole-string
 *     equality — which matched 0 of 169,797 rows; the tokens match 121,348.
 *     "Is not any of" excluded nothing.
 *   • Four score fields were silently rewritten to another metric:
 *     Structured Motivation, Deal Strength, Tag Distress and Master Owner
 *     Priority all filtered `acquisition_score` (which is Final Acquisition
 *     Score; it equals Deal Strength on 210 of 2,000 sampled rows).
 *   • Fields with no audience column (year built, square feet, loan balance…)
 *     were reported by Reach as "not counted" but dropped without a word by
 *     Build, so the campaign that got built was not the one that was counted.
 *   • Nineteen mapped audience columns are entirely empty (language, gender,
 *     unit count, carrier, last outbound…), so any value selected returned 0
 *     and "is not any of" returned 0 as well.
 *
 * This module is now the only place that maps a catalog field to an audience
 * column and compiles its predicate. A field it cannot apply is reported with
 * the reason — never silently skipped, never substituted.
 */
import { clean } from '@/lib/domain/queue/queue-control-safety.js'
import { getCampaignFieldCatalogResponse, getCampaignFieldDefinition } from '@/lib/domain/campaigns/campaign-field-catalog.js'
import { expandPropertyTypeValues, PROPERTY_TYPE_FAMILIES } from '@/lib/domain/campaigns/campaign-property-type-families.js'
import {
  applySupabaseFilterToColumn,
  filterScalarValues,
  normalizePreviewOperator,
} from '@/lib/domain/campaigns/campaign-field-filter-compiler.js'

export const CAMPAIGN_AUDIENCE_TABLE = 'campaign_target_graph'
export { expandPropertyTypeValues, PROPERTY_TYPE_FAMILIES }

/**
 * Catalog field → audience column, where the column IS that field.
 * Deliberately absent: fields with no audience column, and the former
 * metric substitutions (structured_motivation_score, deal_strength_score,
 * tag_distress_score, master_owners.priority_score → acquisition_score;
 * selected_textgrid_state → the property's state).
 */
export const GRAPH_FILTER_COLUMNS = Object.freeze({
  'properties.property_id': 'property_id',
  'properties.master_owner_id': 'master_owner_id',
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
})

/** Status fields whose values are labels over a boolean column. */
export const GRAPH_STATUS_FIELD_COLUMNS = Object.freeze({
  'sender_coverage.sender_coverage_status': 'sender_covered',
  'outreach.duplicate_queue_status': 'active_queue_item',
})

/** ';'-joined list columns: a value matches a whole TOKEN, never the whole string. */
export const GRAPH_LIST_TEXT_COLUMNS = new Set(['podio_tags', 'property_flags_text', 'matching_flags_text'])

const PROPERTY_TYPE_FIELD_KEYS = new Set(['properties.property_type'])

export const INAPPLICABLE_REASONS = Object.freeze({
  not_in_audience: 'This field isn’t part of the campaign audience data, so it can’t narrow a campaign.',
  no_audience_data: 'No seller in the campaign audience has a value for this field yet, so it can’t narrow a campaign.',
  unknown_field: 'This field isn’t in the approved campaign field list.',
})

function normalizedFieldKey(filterOrKey) {
  if (typeof filterOrKey === 'string') return clean(filterOrKey)
  return clean(filterOrKey?.field_key || filterOrKey?.fieldKey || filterOrKey?.field)
}

/** The audience column a catalog field filters, or null when it has none. */
export function graphColumnForField(filterOrKey) {
  const key = normalizedFieldKey(filterOrKey)
  if (GRAPH_STATUS_FIELD_COLUMNS[key]) return GRAPH_STATUS_FIELD_COLUMNS[key]
  if (GRAPH_FILTER_COLUMNS[key]) return GRAPH_FILTER_COLUMNS[key]
  const field = (typeof filterOrKey === 'object' && filterOrKey?.fieldDefinition) || getCampaignFieldDefinition(key)
  if (!field) return null
  return GRAPH_FILTER_COLUMNS[field.key] || null
}

/**
 * Can this field narrow a campaign? `population` (optional) maps an audience
 * column to whether any row carries a value; unknown columns are assumed
 * populated (the probe is best-effort and never invents a gap).
 */
export function graphFieldApplicability(fieldKey, { population = null } = {}) {
  const field = getCampaignFieldDefinition(fieldKey)
  if (!field) return { applicable: false, column: null, reason: 'unknown_field', message: INAPPLICABLE_REASONS.unknown_field }
  // A drawn area is not a column filter: it chooses the audience read itself
  // (campaign_target_graph_in_area), so it always applies and never narrows a
  // column (applyGraphFilter leaves the query alone when there is no column).
  if (field.type === 'geo_area') return { applicable: true, column: null, reason: null, message: null, source: 'drawn_area' }
  const column = graphColumnForField(field.key)
  if (!column) return { applicable: false, column: null, reason: 'not_in_audience', message: INAPPLICABLE_REASONS.not_in_audience }
  if (population instanceof Map && population.get(column) === false) {
    return { applicable: false, column, reason: 'no_audience_data', message: INAPPLICABLE_REASONS.no_audience_data }
  }
  return { applicable: true, column, reason: null, message: null }
}

/** Every distinct audience column a catalog field can filter. */
export function mappedAudienceColumns() {
  return [...new Set([...Object.values(GRAPH_FILTER_COLUMNS), ...Object.values(GRAPH_STATUS_FIELD_COLUMNS)])]
}

/**
 * Split resolved catalog filters into the ones this audience can apply and the
 * ones it can't (with reasons). Preview and Build both call this, so a filter
 * is either applied by both or refused by both.
 */
export function resolveGraphFilterPlan(supportedFilters = [], { population = null } = {}) {
  const applicable = []
  const inapplicable = []
  for (const filter of supportedFilters || []) {
    const verdict = graphFieldApplicability(filter.field_key, { population })
    if (verdict.applicable) {
      applicable.push({ ...filter, graph_column: verdict.column })
    } else {
      inapplicable.push({
        field_key: filter.field_key,
        label: filter.label || getCampaignFieldDefinition(filter.field_key)?.label || filter.field_key,
        operator: filter.operator,
        value: filter.value,
        graph_column: verdict.column,
        reason: verdict.reason,
        message: verdict.message,
      })
    }
  }
  return { applicable, inapplicable }
}

// ── predicates ────────────────────────────────────────────────────────────

/** A literal inside a POSIX regex: metacharacters become one-char classes. */
function regexLiteral(value) {
  return clean(value)
    .replace(/["\\^]/g, '')
    .replace(/[.*+?$|(){}[\]]/g, (char) => (char === ']' ? '[]]' : `[${char}]`))
    .replace(/\s+/g, '[[:space:]]+')
}

/**
 * Case-insensitive token match inside a ';'-joined list:
 * `(^|;)[[:space:]]*(Tired[[:space:]]+Landlord|High[[:space:]]+Equity)[[:space:]]*(;|$)`
 */
export function listTokenPattern(values = []) {
  const tokens = [...new Set((values || []).map(regexLiteral).filter(Boolean))]
  if (!tokens.length) return null
  return `(^|;)[[:space:]]*(${tokens.join('|')})[[:space:]]*(;|$)`
}

function statusBoolean(value) {
  const text = clean(value).toLowerCase()
  if (['true', '1', 'yes', 'covered', 'active_queue_item'].includes(text)) return true
  if (['false', '0', 'no', 'clear', 'no route', 'no_route'].includes(text)) return false
  return null
}

function applyStatusFilter(query, filter, column) {
  const operator = normalizePreviewOperator(filter.operator || 'eq', filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key))
  const values = filterScalarValues({ ...filter, operator })
  if (operator === 'is_empty') return query.is(column, null)
  if (operator === 'is_not_empty') return query.not(column, 'is', null)
  if (operator === 'is_true') return query.eq(column, true)
  if (operator === 'is_false') return query.eq(column, false)
  const bools = [...new Set(values.map(statusBoolean).filter((value) => value !== null))]
  if (!bools.length) return query
  if (operator === 'is_not_any_of') return query.not(column, 'in', `(${bools.join(',')})`)
  if (bools.length === 1) return query.eq(column, bools[0])
  return query.in(column, bools)
}

function quoteLogicValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function applyListTextFilter(query, filter, column) {
  const field = filter.fieldDefinition || getCampaignFieldDefinition(filter.field_key)
  const operator = normalizePreviewOperator(filter.operator || 'eq', field)
  const values = filterScalarValues({ ...filter, operator }).map(clean).filter(Boolean)
  if (operator === 'is_empty') return query.is(column, null)
  if (operator === 'is_not_empty') return query.not(column, 'is', null)
  if (operator === 'is_any_of' || operator === 'eq') {
    const pattern = listTokenPattern(values)
    return pattern ? query.filter(column, 'imatch', pattern) : query
  }
  if (operator === 'is_not_any_of') {
    const pattern = listTokenPattern(values)
    // A seller with no tags does not carry the excluded tag: keep NULL rows.
    return pattern ? query.or(`${column}.is.null,${column}.not.imatch.${quoteLogicValue(pattern)}`) : query
  }
  // contains / contains_any keep their substring meaning.
  return applySupabaseFilterToColumn(query, filter, column)
}

/** Apply ONE resolved, applicable filter to an audience query. */
export function applyGraphFilter(query, filter = {}) {
  const key = normalizedFieldKey(filter)
  const column = filter.graph_column || graphColumnForField(filter)
  if (!column) return query
  if (GRAPH_STATUS_FIELD_COLUMNS[key]) return applyStatusFilter(query, filter, column)
  if (GRAPH_LIST_TEXT_COLUMNS.has(column)) return applyListTextFilter(query, filter, column)
  if (PROPERTY_TYPE_FIELD_KEYS.has(key)) {
    const field = filter.fieldDefinition || getCampaignFieldDefinition(key)
    const operator = normalizePreviewOperator(filter.operator || 'eq', field)
    if (operator === 'is_any_of' || operator === 'is_not_any_of' || operator === 'eq') {
      const expanded = expandPropertyTypeValues(filterScalarValues({ ...filter, operator }))
      if (!expanded.length) return query
      if (operator === 'is_not_any_of') return query.not(column, 'in', `(${expanded.map(quoteLogicValue).join(',')})`)
      return query.in(column, expanded)
    }
  }
  return applySupabaseFilterToColumn(query, filter, column)
}

/**
 * What a selection silently stood for, said out loud: choosing "Apartment"
 * also selects "Multi-Family" and "Multifamily 5+" (one asset family).
 */
export function describeFilterExpansions(filters = []) {
  const notes = []
  for (const filter of filters || []) {
    const key = normalizedFieldKey(filter)
    if (!PROPERTY_TYPE_FIELD_KEYS.has(key)) continue
    const field = filter.fieldDefinition || getCampaignFieldDefinition(key)
    const operator = normalizePreviewOperator(filter.operator || 'eq', field)
    if (!['is_any_of', 'is_not_any_of', 'eq'].includes(operator)) continue
    const values = filterScalarValues({ ...filter, operator }).map(clean).filter(Boolean)
    const chosen = new Set(values.map((value) => value.toLowerCase()))
    const added = expandPropertyTypeValues(values).filter((value) => !chosen.has(value.toLowerCase()))
    if (!added.length) continue
    notes.push({
      field_key: key,
      message: `Property type ${values.join(', ')} ${operator === 'is_not_any_of' ? 'also excludes' : 'also includes'} ${added.join(', ')} — the same kind of building under another label.`,
    })
  }
  return notes
}

// ── audience column population (best-effort, cached) ───────────────────────

const POPULATION_TTL_MS = 60 * 60 * 1000
const POPULATION_CONCURRENCY = 6
let populationCache = null
let populationInFlight = null

/**
 * Which mapped audience columns carry any value at all — from the planner's
 * estimate, not a scan. `count: planned` with `limit(0)` asks Postgres how
 * many rows it expects to have a value (column statistics) without reading a
 * row; an all-NULL column estimates 1. (A literal `limit(1)` existence check
 * full-scans the 170k-row graph for every empty column — ~3 s each.)
 *
 * At most once an hour per process. A failed or missing estimate leaves the
 * column unknown, which is treated as populated: the probe can only DISABLE a
 * field on evidence.
 */
export async function loadGraphColumnPopulation(supabase, { now = Date.now(), force = false } = {}) {
  if (!supabase) return null
  if (!force && populationCache && now - populationCache.at < POPULATION_TTL_MS) return populationCache.byColumn
  if (populationInFlight) return populationInFlight
  populationInFlight = (async () => {
    const byColumn = new Map()
    const columns = mappedAudienceColumns()
    for (let index = 0; index < columns.length; index += POPULATION_CONCURRENCY) {
      await Promise.all(columns.slice(index, index + POPULATION_CONCURRENCY).map(async (column) => {
        try {
          const { count, error } = await supabase
            .from(CAMPAIGN_AUDIENCE_TABLE)
            .select('graph_id', { count: 'planned', head: true })
            .not(column, 'is', null)
            .limit(0)
          if (!error && Number.isFinite(Number(count))) byColumn.set(column, Number(count) > 1)
        } catch {
          // unknown stays unknown
        }
      }))
    }
    populationCache = { at: now, byColumn }
    return byColumn
  })()
  try {
    return await populationInFlight
  } finally {
    populationInFlight = null
  }
}

/** Test seam: forget the cached probe. */
export function resetGraphColumnPopulationCache() {
  populationCache = null
  populationInFlight = null
}

/**
 * The catalog, annotated with whether each field can narrow a campaign and
 * why not. The builder disables (and explains) the fields that can't.
 */
export function annotateCatalogFieldApplicability(fields = [], { population = null } = {}) {
  return fields.map((field) => {
    const verdict = graphFieldApplicability(field.key, { population })
    return {
      ...field,
      campaign_applicable: verdict.applicable,
      campaign_column: verdict.column,
      campaign_inapplicable_reason: verdict.reason,
      campaign_inapplicable_message: verdict.message,
    }
  })
}

/**
 * The field-catalog response with every field's campaign applicability, for
 * the builder. `population` is the cached audience-column probe; without it
 * only the mapping decides.
 */
export function getCampaignFieldCatalogWithApplicability({ population = null, generated_at } = {}) {
  const response = getCampaignFieldCatalogResponse(generated_at ? { generated_at } : {})
  let inapplicable = 0
  const domains = response.domains.map((domain) => ({
    ...domain,
    categories: domain.categories.map((category) => ({
      ...category,
      fields: annotateCatalogFieldApplicability(category.fields, { population }).map((field) => {
        if (!field.campaign_applicable) inapplicable += 1
        return field
      }),
    })),
  }))
  return {
    ...response,
    domains,
    applicability: {
      source: CAMPAIGN_AUDIENCE_TABLE,
      population_probed: population instanceof Map,
      inapplicable_fields: inapplicable,
    },
  }
}
