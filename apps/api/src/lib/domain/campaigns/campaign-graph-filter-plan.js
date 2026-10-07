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
 *   • (2026-10-03) Their sources are 84-100% filled (seller.owner, owner_phone,
 *     properties.units_count); the refresh never projected them, and recency
 *     compared 10-digit graph phones with +1E.164 events. The projection is
 *     PROPOSED_20261003220000_campaign_audience_completeness.sql. Columns that
 *     migration adds are mapped here already; until it lands the population
 *     probe reports them `missing` and they are refused as not_in_audience.
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
  // Legacy Podio-era import (no writer in the repo). Kept so saved campaigns keep
  // meaning what they meant; labelled legacy in the catalog. Owner decision pending.
  'properties.final_acquisition_score': 'acquisition_score',
  // Canonical scores — property_acquisition_scores (the Acquisition Decision
  // Engine), projected by campaign_target_graph_enrich_rows. The ONLY scores
  // offered for new targeting.
  'properties.aos_score': 'aos_score',
  'properties.decision_tier': 'decision_tier',
  'properties.acquisition_confidence': 'acquisition_confidence',
  'properties.transaction_probability_365': 'transaction_probability_365',
  'properties.best_strategy': 'best_strategy',
  // Property facts projected from public.properties (PROPOSED_20261003220000).
  'properties.total_bedrooms': 'beds',
  'properties.total_baths': 'baths',
  'properties.building_square_feet': 'building_sqft',
  'properties.year_built': 'year_built',
  'properties.lot_square_feet': 'lot_sqft',
  'properties.total_loan_balance': 'total_loan_balance',
  'properties.ownership_years': 'ownership_years',
  'properties.tax_delinquent_year': 'tax_delinquent_year',
  'properties.building_quality': 'building_quality',
  'properties.estimated_repair_cost': 'estimated_repair_cost',
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
  'phones.phone_type': 'phone_type',
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
  // Seller Situation v2 (A1) + campaign ranking v2 — projected by
  // PROPOSED_20261007080000_campaign_ranking_v2.sql; PROJECTION_PENDING below,
  // so they are refused as not_in_audience until the population probe sees them.
  'seller_situation.opportunity_tier': 'opportunity_tier',
  'seller_situation.seller_situation': 'seller_situation',
  'seller_situation.forced_sale_pressure': 'forced_sale_pressure',
  'seller_situation.sell_p365': 'sell_p365',
  'seller_situation.market_quality': 'market_quality',
  'seller_situation.campaign_rank_v2_priority': 'campaign_rank_v2_priority',
  'seller_situation.situation_score_version': 'situation_score_version',
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

/**
 * Columns added by PROPOSED_20261003220000 (not yet applied). They apply ONLY
 * when the population probe positively saw values in them — no probe, a failed
 * probe or a missing column refuses them, so a filter can never reference a
 * column the audience table does not have.
 */
export const PROJECTION_PENDING_COLUMNS = new Set([
  'aos_score', 'decision_tier', 'acquisition_confidence', 'transaction_probability_365', 'best_strategy',
  'beds', 'baths', 'building_sqft', 'year_built', 'lot_sqft', 'total_loan_balance', 'ownership_years',
  'tax_delinquent_year', 'building_quality', 'estimated_repair_cost', 'phone_type',
  // PROPOSED_20261007080000_campaign_ranking_v2.sql
  'opportunity_tier', 'seller_situation', 'forced_sale_pressure', 'sell_p365', 'market_quality',
  'campaign_rank_v2_priority', 'situation_score_version',
])

/** Population probe verdict for a column the audience table does not have (yet). */
export const COLUMN_MISSING = 'missing'

function isMissingColumnError(error) {
  const code = clean(error?.code)
  const message = clean(error?.message).toLowerCase()
  return code === '42703' || code === 'PGRST204' || (message.includes('column') && message.includes('does not exist'))
}

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
  if (PROJECTION_PENDING_COLUMNS.has(column) && !(population instanceof Map && population.has(column) && population.get(column) !== COLUMN_MISSING)) {
    return { applicable: false, column, reason: 'not_in_audience', message: INAPPLICABLE_REASONS.not_in_audience }
  }
  if (population instanceof Map && population.get(column) === COLUMN_MISSING) {
    return { applicable: false, column, reason: 'not_in_audience', message: INAPPLICABLE_REASONS.not_in_audience }
  }
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
      if (operator === 'is_not_any_of') return applyExcludeKeepingUnknown(query, column, expanded)
      return query.in(column, expanded)
    }
  }
  const field = filter.fieldDefinition || getCampaignFieldDefinition(key)
  if (field && field.type !== 'number' && field.type !== 'boolean' && normalizePreviewOperator(filter.operator || 'eq', field) === 'is_not_any_of') {
    const values = filterScalarValues({ ...filter, operator: 'is_not_any_of' }).map(clean).filter(Boolean)
    return values.length ? applyExcludeKeepingUnknown(query, column, values) : query
  }
  return applySupabaseFilterToColumn(query, filter, column)
}

/**
 * "Is not any of" on a scalar column. Two defects of the generic compiler
 * (`not.in.(a,b)`, unquoted) on the audience, found 2026-10-07:
 *   • values with a comma split: "Market is not Dallas, TX" excluded "Dallas"
 *     and " TX" — i.e. nothing;
 *   • SQL `NOT IN` drops NULL rows: "Building condition is not Poor" also
 *     dropped every property with no condition on file (~45% of the graph).
 * Values are quoted, and a property with no value is kept — it is not known
 * to be any excluded value (the same rule as the list-token filters).
 */
function applyExcludeKeepingUnknown(query, column, values) {
  return query.or(`${column}.is.null,${column}.not.in.(${values.map(quoteLogicValue).join(',')})`)
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
/** Per-column probe results: column → { at, verdict } (verdict: true | false | COLUMN_MISSING | UNKNOWN). */
const UNKNOWN = Symbol('unknown')
const columnCache = new Map()
const columnInFlight = new Map()

/**
 * One column's planner-estimate probe (see loadGraphColumnPopulation):
 * { verdict, known } — known is the planner's estimate of rows with a value.
 */
async function probeGraphColumn(supabase, column) {
  try {
    const { count, error } = await supabase
      .from(CAMPAIGN_AUDIENCE_TABLE)
      .select('graph_id', { count: 'planned', head: true })
      .not(column, 'is', null)
      .limit(0)
    if (error) {
      // A HEAD probe carries no error body, so ask once more with a body:
      // LIMIT 0 reads no row and fails fast only when the column is absent.
      const confirm = isMissingColumnError(error)
        ? { error }
        : await supabase.from(CAMPAIGN_AUDIENCE_TABLE).select(column).limit(0)
      if (confirm?.error && isMissingColumnError(confirm.error)) return { verdict: COLUMN_MISSING, known: null }
      return { verdict: UNKNOWN, known: null }
    }
    if (Number.isFinite(Number(count))) return { verdict: Number(count) > 1, known: Math.max(0, Number(count)) }
  } catch {
    // unknown stays unknown
  }
  return { verdict: UNKNOWN, known: null }
}

/**
 * The audience columns a set of catalog filters can consult — derived exactly
 * the way graphFieldApplicability derives a filter's column, so a probe of
 * just these columns yields the same verdicts as a probe of every column.
 */
export function graphPlanColumns(filters = []) {
  const columns = new Set()
  for (const filter of filters || []) {
    const field = getCampaignFieldDefinition(filter?.field_key)
    if (!field || field.type === 'geo_area') continue
    const column = graphColumnForField(field.key)
    if (column) columns.add(column)
  }
  return [...columns]
}

/**
 * Which mapped audience columns carry any value at all — from the planner's
 * estimate, not a scan. `count: planned` with `limit(0)` asks Postgres how
 * many rows it expects to have a value (column statistics) without reading a
 * row; an all-NULL column estimates 1. (A literal `limit(1)` existence check
 * full-scans the 170k-row graph for every empty column — ~3 s each.)
 *
 * At most once an hour per process and column. `columns` narrows the probe to
 * the columns a request actually filters on (graphPlanColumns): a market-only
 * audience consults one column, and probing all ~70 cold cost ~9 s (12 waves of
 * HEAD requests) before the audience read could start. The verdict for a
 * column depends only on that column's own probe, so the answer for every
 * consulted column is identical either way.
 *
 * A failed or missing estimate leaves the column unknown, which is treated as
 * populated: the probe can only DISABLE a field on evidence. A column the
 * table does not have (42703) is recorded as COLUMN_MISSING — filtering on it
 * would fail the whole query.
 */
export async function loadGraphColumnPopulation(supabase, { now = Date.now(), force = false, columns = null } = {}) {
  if (!supabase) return null
  const wanted = [...new Set(Array.isArray(columns) ? columns.map(clean).filter(Boolean) : mappedAudienceColumns())]
  const fresh = (column) => {
    const hit = columnCache.get(column)
    return !force && hit && now - hit.at < POPULATION_TTL_MS
  }
  const stale = wanted.filter((column) => !fresh(column))
  for (let index = 0; index < stale.length; index += POPULATION_CONCURRENCY) {
    await Promise.all(stale.slice(index, index + POPULATION_CONCURRENCY).map((column) => {
      let flight = columnInFlight.get(column)
      if (!flight) {
        flight = probeGraphColumn(supabase, column)
          .then(({ verdict, known }) => { columnCache.set(column, { at: now, verdict, known }) })
          .finally(() => columnInFlight.delete(column))
        columnInFlight.set(column, flight)
      }
      return flight
    }))
  }
  const byColumn = new Map()
  for (const column of wanted) {
    const verdict = columnCache.get(column)?.verdict
    if (verdict !== undefined && verdict !== UNKNOWN) byColumn.set(column, verdict)
  }
  return byColumn
}

/** Test seam: forget the cached probe. */
export function resetGraphColumnPopulationCache() {
  columnCache.clear()
  columnInFlight.clear()
  totalCache.at = 0
  totalCache.total = null
}

// ── audience column COVERAGE (share of the audience with a value) ──────────
// A column that is populated on 1% of sellers is "populated" to the probe above,
// so a filter on it applies — and quietly returns ~1% of what the operator
// expected. Coverage says it out loud instead (owner 2026-10-07: every prospect
// field stays a live targeting input; its reach is reported, never hidden).

const totalCache = { at: 0, total: null }

async function loadGraphAudienceTotal(supabase, { now = Date.now(), force = false } = {}) {
  if (!force && totalCache.total !== null && now - totalCache.at < POPULATION_TTL_MS) return totalCache.total
  try {
    const { count, error } = await supabase
      .from(CAMPAIGN_AUDIENCE_TABLE)
      .select('graph_id', { count: 'planned', head: true })
      .limit(0)
    if (!error && Number.isFinite(Number(count)) && Number(count) > 0) {
      totalCache.at = now
      totalCache.total = Number(count)
      return totalCache.total
    }
  } catch {
    // unknown stays unknown
  }
  return null
}

/**
 * column -> { known, total, share } from the same planner estimates (statistics,
 * not a scan; refreshed by ANALYZE, so it can trail a running backfill by minutes).
 * Columns without a usable estimate are absent — unknown coverage is never 0%.
 */
export async function loadGraphColumnCoverage(supabase, { now = Date.now(), force = false, columns = null } = {}) {
  if (!supabase) return null
  const population = await loadGraphColumnPopulation(supabase, { now, force, columns })
  if (!(population instanceof Map)) return null
  const total = await loadGraphAudienceTotal(supabase, { now, force })
  const coverage = new Map()
  if (!total) return coverage
  for (const column of population.keys()) {
    const known = columnCache.get(column)?.known
    if (!Number.isFinite(known)) continue
    const bounded = Math.min(known, total)
    coverage.set(column, { known: bounded, total, share: bounded / total })
  }
  return coverage
}

/** Fields whose reach is always stated (the prospect/demographic family). */
function alwaysStatesCoverage(fieldKey) {
  return clean(fieldKey).startsWith('prospects.')
}

/** Below this share any filtered column gets a coverage note. */
export const LOW_COVERAGE_SHARE = 0.5

export function formatCoverageShare(share) {
  const pct = share * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  if (pct < 10) return `${pct.toFixed(1)}%`
  return `${Math.round(pct)}%`
}

/**
 * One note per applied filter whose column is not known for (nearly) every seller:
 * "Gender is known for 1.1% of the campaign audience (about 1,912 of 176,605
 * sellers) — only those sellers can match this filter."
 */
export function describeFilterCoverage(filters = [], coverage = null) {
  if (!(coverage instanceof Map) || !coverage.size) return []
  const notes = []
  const seen = new Set()
  for (const filter of filters || []) {
    const key = normalizedFieldKey(filter)
    const column = filter.graph_column || graphColumnForField(filter)
    if (!column || seen.has(key)) continue
    const entry = coverage.get(column)
    if (!entry || !Number.isFinite(entry.share)) continue
    const always = alwaysStatesCoverage(key)
    if (!(entry.share < LOW_COVERAGE_SHARE || (always && entry.share < 0.995))) continue
    seen.add(key)
    const label = filter.label || getCampaignFieldDefinition(key)?.label || key
    const known = Math.round(entry.known).toLocaleString('en-US')
    const total = Math.round(entry.total).toLocaleString('en-US')
    notes.push({
      field_key: key,
      kind: 'coverage',
      column,
      known: Math.round(entry.known),
      total: Math.round(entry.total),
      share: Number(entry.share.toFixed(4)),
      low: entry.share < LOW_COVERAGE_SHARE,
      message: `${label} is known for ${formatCoverageShare(entry.share)} of the campaign audience (about ${known} of ${total} sellers) — only those sellers can match this filter.`,
    })
  }
  return notes
}

/**
 * The catalog, annotated with whether each field can narrow a campaign and
 * why not. The builder disables (and explains) the fields that can't.
 */
export function annotateCatalogFieldApplicability(fields = [], { population = null, coverage = null } = {}) {
  return fields.map((field) => {
    const verdict = graphFieldApplicability(field.key, { population })
    const entry = coverage instanceof Map && verdict.column ? coverage.get(verdict.column) : null
    return {
      ...field,
      campaign_applicable: verdict.applicable,
      campaign_column: verdict.column,
      campaign_inapplicable_reason: verdict.reason,
      campaign_inapplicable_message: verdict.message,
      ...(entry && verdict.applicable
        ? {
            campaign_coverage: { known: Math.round(entry.known), total: Math.round(entry.total), share: Number(entry.share.toFixed(4)) },
            campaign_coverage_message: `Known for ${formatCoverageShare(entry.share)} of the campaign audience`,
          }
        : {}),
    }
  })
}

/**
 * The field-catalog response with every field's campaign applicability, for
 * the builder. `population` is the cached audience-column probe; without it
 * only the mapping decides.
 */
export function getCampaignFieldCatalogWithApplicability({ population = null, coverage = null, generated_at } = {}) {
  const response = getCampaignFieldCatalogResponse(generated_at ? { generated_at } : {})
  let inapplicable = 0
  const domains = response.domains.map((domain) => ({
    ...domain,
    categories: domain.categories.map((category) => ({
      ...category,
      fields: annotateCatalogFieldApplicability(category.fields, { population, coverage }).map((field) => {
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
      coverage_probed: coverage instanceof Map && coverage.size > 0,
      inapplicable_fields: inapplicable,
    },
  }
}
