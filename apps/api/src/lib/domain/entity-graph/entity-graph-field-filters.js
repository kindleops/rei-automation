/**
 * ENTITY GRAPH FILTERS COME FROM THE CAMPAIGN FIELD CATALOG.
 *
 * Entity Graph shipped 13 hand-written inputs (market, city, state, zip, asset
 * type, units min/max, score min/max, owner type, priority tier, coverage,
 * language) against a database the campaign builder already describes with 156
 * catalogued fields. An operator could not ask for tax-delinquent owners, or
 * equity above a number, or a flood zone -- and the two surfaces disagreed
 * about what "market" even meant, because each wrote its own predicate.
 *
 * Nothing new is defined here. This module answers two questions ABOUT the
 * existing catalog:
 *
 *   which catalogued fields can Entity Graph's own browse queries execute?
 *   -> exactly the ones whose source_table_or_view is the table that tab reads
 *
 *   what happens to a field key it cannot execute?
 *   -> it FAILS CLOSED. Never narrow-by-nothing.
 *
 * That second rule is not theoretical. On 2026-09-14 the campaign target
 * builder treated a field key it did not recognise as "no narrowing requested"
 * and expanded a five-property selection into 64,878 rows against a live
 * campaign. A filter the backend cannot execute must be an error the operator
 * sees, not a silent full-table scan.
 *
 * The compiler is shared with the campaign builder
 * (campaign-field-filter-compiler.js), so a field filtered here and the same
 * field filtered in a campaign resolve to the same column and the same
 * predicate -- which is what makes "select this cohort, then campaign it"
 * arithmetic hold.
 */
import {
  CAMPAIGN_FIELD_CATALOG,
  getCampaignFieldDefinition,
  normalizeCampaignFieldKey,
} from '@/lib/domain/campaigns/campaign-field-catalog.js'
import {
  applySupabaseFilters,
  EMPTY_FILTER_OPERATORS,
  filterColumn,
  hasMeaningfulFilterValue,
  normalizePreviewFilterValue,
} from '@/lib/domain/campaigns/campaign-field-filter-compiler.js'

const clean = (value) => (value === null || value === undefined ? '' : String(value).trim())

/**
 * Operators that carry their whole meaning in the operator. Asking for a value
 * alongside them is meaningless, and demanding one rejected `is_true` --
 * caught by the "compiles against the catalog's source column" test before any
 * of this reached an operator.
 */
const VALUELESS_OPERATORS = new Set([...EMPTY_FILTER_OPERATORS, 'is_true', 'is_false'])

/** The aliases the campaign builder accepts, so a saved cohort keeps working. */
const OPERATOR_ALIASES = Object.freeze({ in: 'is_any_of', not_in: 'is_not_any_of' })

/**
 * Resolve the requested operator WITHOUT the builder's coercion.
 *
 * normalizePreviewOperator falls back to `eq` for anything a field does not
 * advertise, which is right for a saved campaign that must keep running but
 * wrong here: asking for `contains` on a numeric column and silently getting
 * `eq` answers a different question than the operator asked. An operator the
 * field does not advertise is an error, not a substitution.
 */
function resolveRequestedOperator(requested, field) {
  const allowed = new Set((field.operators || []).map((entry) => entry.key))
  const raw = clean(requested)
  if (!raw) return { operator: clean(field.operators?.[0]?.key) || 'eq', allowed }
  const mapped = OPERATOR_ALIASES[raw] || raw
  return { operator: mapped, allowed }
}

/**
 * The table each tab's browse query actually reads. A catalogued field is
 * executable on a tab only when the catalog's source_table_or_view matches --
 * otherwise the column is simply not there, and PostgREST fails the WHOLE
 * query on one unknown column rather than ignoring it.
 *
 * The `outreach` and `sender_coverage` domains (16 fields) live on
 * v_feeder_candidates_fast, which no Entity Graph tab reads. They are
 * deliberately absent: exposing an operator the backend cannot execute is the
 * defect, not the omission.
 */
export const ENTITY_GRAPH_FILTER_SOURCE_BY_TAB = Object.freeze({
  properties: 'properties',
  master_owners: 'master_owners',
  people: 'prospects',
  contact_methods: 'phones',
  // `zips` and `markets` are deliberately absent. Both are per-zip/per-market
  // AGGREGATES built by an RPC over properties, so a property column filter
  // cannot be pushed into them -- and accepting one only to ignore it is the
  // silent-everything shape this module exists to prevent. Requesting a field
  // filter on those tabs fails closed.
})

/**
 * Columns the catalog exposes that hold NO DATA.
 *
 * Measured 2026-09-14 on a 2% system sample of properties (3,318 rows): zero
 * non-null values. A filter on one of these is executable and honest -- it
 * returns 0 rows -- but an operator who picks it has no way to tell an empty
 * column from an empty cohort. Flagged so the UI can say so, NOT hidden: the
 * campaign builder still offers them, and quietly disagreeing with it would
 * recreate the divergence this module exists to remove.
 */
export const ENTITY_GRAPH_EMPTY_SOURCE_COLUMNS = Object.freeze({
  'properties.stories': 'no values in a 3,318-row sample (2026-09-14)',
  'properties.document_type': 'no values in a 3,318-row sample (2026-09-14)',
  'properties.recording_date': 'no values in a 3,318-row sample (2026-09-14)',
  'properties.default_date': 'no values in a 3,318-row sample (2026-09-14)',
  'properties.past_due_amount': 'no values in a 3,318-row sample (2026-09-14)',
  'properties.other_rooms': 'no values in a 3,318-row sample (2026-09-14)',
})

export const ENTITY_GRAPH_FILTERABLE_TABS = Object.freeze(Object.keys(ENTITY_GRAPH_FILTER_SOURCE_BY_TAB))

export function entityGraphFilterSourceForTab(tab) {
  return ENTITY_GRAPH_FILTER_SOURCE_BY_TAB[clean(tab).toLowerCase()] || null
}

function decorate(field) {
  const emptyReason = ENTITY_GRAPH_EMPTY_SOURCE_COLUMNS[field.key]
  return emptyReason ? { ...field, data_coverage: 'empty', data_coverage_note: emptyReason } : field
}

/** Every catalogued field a tab's own browse query can execute, in catalog order. */
export function getEntityGraphFilterFields(tab) {
  const source = entityGraphFilterSourceForTab(tab)
  if (!source) return []
  return CAMPAIGN_FIELD_CATALOG
    .filter((field) => field.source_table_or_view === source && field.filterable)
    .map(decorate)
}

/** The same fields grouped for the filter builder, one group per catalog category. */
export function getEntityGraphFilterCatalog(tab) {
  const source = entityGraphFilterSourceForTab(tab)
  const fields = getEntityGraphFilterFields(tab)
  const groups = []
  const byCategory = new Map()
  for (const field of fields) {
    if (!byCategory.has(field.category)) {
      const group = { id: `${field.domain}.${field.category}`, label: field.category, fields: [] }
      byCategory.set(field.category, group)
      groups.push(group)
    }
    byCategory.get(field.category).fields.push(field)
  }
  return {
    tab: clean(tab).toLowerCase(),
    source,
    groups,
    total_fields: fields.length,
  }
}

/**
 * Read the requested field filters off a query string or a JSON body.
 *
 * Accepts `field_filters` as a JSON array (the form the campaign builder
 * already speaks) so a cohort can be handed between the two surfaces without
 * a translation step:
 *   [{"field_key":"properties.tax_delinquent","operator":"is_true"}]
 */
export function parseEntityGraphFieldFilters(params = {}) {
  const raw = params.field_filters ?? params.fieldFilters ?? params.filters_json
  if (!raw) return []
  let parsed = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return []
    try {
      parsed = JSON.parse(text)
    } catch {
      // A malformed payload is NOT "no filters". Surfaced as one unsupported
      // entry so the caller fails closed instead of browsing the whole table.
      return [{ field_key: '', operator: '', value: null, parse_error: 'field_filters_not_json' }]
    }
  }
  if (!Array.isArray(parsed)) return [{ field_key: '', operator: '', value: null, parse_error: 'field_filters_not_an_array' }]
  return parsed.filter((entry) => entry && typeof entry === 'object')
}

/**
 * Split requested filters into ones this tab can execute and ones it cannot.
 * Callers must treat a non-empty `unsupported` as a hard error.
 */
export function resolveEntityGraphFieldFilters(tab, requested = []) {
  const source = entityGraphFilterSourceForTab(tab)
  const resolved = []
  const unsupported = []

  if (!source && requested.length) {
    return {
      source: null,
      resolved,
      unsupported: requested.map((entry) => ({
        field_key: clean(entry?.field_key || entry?.field) || null,
        reason: 'tab_does_not_support_field_filters',
      })),
    }
  }

  for (const entry of requested) {
    if (entry.parse_error) {
      unsupported.push({ field_key: null, reason: entry.parse_error })
      continue
    }
    const requestedKey = clean(entry.field_key || entry.field || entry.key)
    if (!requestedKey) {
      unsupported.push({ field_key: null, reason: 'missing_field_key' })
      continue
    }
    const fieldKey = normalizeCampaignFieldKey(requestedKey)
    const field = getCampaignFieldDefinition(fieldKey)
    if (!field) {
      unsupported.push({ field_key: requestedKey, reason: 'unknown_campaign_field' })
      continue
    }
    if (field.source_table_or_view !== source) {
      unsupported.push({
        field_key: field.key,
        reason: 'field_not_on_entity_graph_source',
        field_source: field.source_table_or_view,
        tab_source: source,
      })
      continue
    }
    const column = filterColumn({ field_key: field.key, fieldDefinition: field })
    if (!column) {
      unsupported.push({ field_key: field.key, reason: 'unsafe_source_column' })
      continue
    }
    const requestedOperator = clean(entry.operator || entry.op)
    const { operator, allowed } = resolveRequestedOperator(requestedOperator, field)
    if (!allowed.has(operator)) {
      unsupported.push({
        field_key: field.key,
        reason: 'unsupported_operator',
        operator: requestedOperator || operator,
        supported_operators: [...allowed],
      })
      continue
    }
    const value = normalizePreviewFilterValue(entry.value, operator)
    if (!VALUELESS_OPERATORS.has(operator) && !hasMeaningfulFilterValue(value, operator)) {
      // An operator that needs a value and did not get one would compile to
      // nothing at all, which is the silent-everything shape.
      unsupported.push({ field_key: field.key, reason: 'missing_value', operator })
      continue
    }
    resolved.push({ field_key: field.key, fieldDefinition: field, operator, value, source_column: column })
  }

  return { source, resolved, unsupported }
}

/** Thrown when any requested filter cannot be executed. Never degrade to unfiltered. */
export class EntityGraphUnsupportedFilterError extends Error {
  constructor(unsupported = []) {
    const keys = unsupported.map((entry) => entry.field_key || entry.reason).join(', ')
    super(`unsupported_entity_graph_filters: ${keys}`)
    this.name = 'EntityGraphUnsupportedFilterError'
    this.code = 'unsupported_entity_graph_filters'
    this.status = 422
    this.unsupported_filters = unsupported
  }
}

export function applyEntityGraphFieldFilters(query, resolved = []) {
  if (!resolved.length) return query
  return applySupabaseFilters(query, resolved)
}

/**
 * Parse, resolve and fail closed in one step. Returns the resolved filters
 * ready for applyEntityGraphFieldFilters, or throws.
 */
export function resolveEntityGraphFieldFiltersOrThrow(tab, params = {}) {
  const requested = parseEntityGraphFieldFilters(params)
  if (!requested.length) return { resolved: [], requested_count: 0 }
  const { resolved, unsupported } = resolveEntityGraphFieldFilters(tab, requested)
  if (unsupported.length) throw new EntityGraphUnsupportedFilterError(unsupported)
  return { resolved, requested_count: requested.length }
}
