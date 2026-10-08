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
  buyers: 'eg_buyer_index',
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

/**
 * LEGACY PODIO-ERA SCORES ARE WITHHELD FROM ENTITY GRAPH.
 *
 * The campaign catalog still carries them for saved campaigns, but Entity
 * Graph is the relationship-truth surface and must not offer, filter on, or
 * surface them (operator instruction, 2026-09-27). A request that names one
 * fails closed like any other unsupported field.
 */
export const ENTITY_GRAPH_WITHHELD_FIELDS = Object.freeze(new Set([
  'properties.cash_offer',
  'properties.final_acquisition_score',
  'properties.ai_score',
  'properties.structured_motivation_score',
  'properties.deal_strength_score',
  'properties.tag_distress_score',
]))

const BOOL_OPS = Object.freeze([{ key: 'is_true', label: 'Yes' }, { key: 'is_false', label: 'No' }])
const NUM_OPS = Object.freeze([
  { key: 'gte', label: 'At least' },
  { key: 'lte', label: 'At most' },
  { key: 'between', label: 'Between' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Has a value' },
])
const DATE_OPS = Object.freeze([
  { key: 'on_or_after', label: 'On or after' },
  { key: 'on_or_before', label: 'On or before' },
  { key: 'between', label: 'Between' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Has a date' },
])
const TEXT_OPS = Object.freeze([
  { key: 'contains', label: 'Contains' },
  { key: 'is_any_of', label: 'Is any of' },
  { key: 'is_not_any_of', label: 'Is not any of' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Has a value' },
])
const ARRAY_OPS = Object.freeze([{ key: 'is_any_of', label: 'Includes any of' }])

const FLAG_OPS = Object.freeze([{ key: 'is_any_of', label: 'Has any of' }])

const OPS_BY_TYPE = { boolean: BOOL_OPS, number: NUM_OPS, date: DATE_OPS, text: TEXT_OPS, enum: TEXT_OPS, array: ARRAY_OPS, flags: FLAG_OPS }

function syntheticField(domain, source, category, column, label, type, extra = {}) {
  return Object.freeze({
    key: `${domain}.${column.replace(/^rec_/, '')}`,
    domain,
    category,
    label,
    source_table_or_view: source,
    source_column: column,
    type,
    operators: OPS_BY_TYPE[type],
    filterable: true,
    searchable: type === 'text' || type === 'enum',
    supports_options: type === 'enum' || type === 'array',
    supports_counts: true,
    // Record + buyer fields do not exist in the campaign builder's catalog, so a
    // cohort filtered on them carries into a campaign as EXPLICIT property ids,
    // never as a filter the builder would silently drop.
    supported_in_preview: false,
    entity_graph_only: true,
    ...extra,
  })
}

/**
 * RECORDED DOCUMENTS ON A PROPERTY — mortgages, liens, sales, foreclosures —
 * and the owner's buyer role. Served by public.v_entity_graph_properties (the
 * properties table joined to property_record_summary + eg_property_owner_buyer).
 */
const R = (category, column, label, type, extra) => syntheticField('records', 'properties', category, column, label, type, extra)
export const ENTITY_GRAPH_RECORD_FIELDS = Object.freeze([
  R('Mortgages & Debt', 'rec_mortgage_count', 'Open mortgages', 'number'),
  R('Mortgages & Debt', 'rec_mortgage_balance', 'Mortgage balance (est.)', 'number', { format: 'money' }),
  R('Mortgages & Debt', 'rec_mortgage_payment', 'Mortgage payment (est.)', 'number', { format: 'money' }),
  R('Mortgages & Debt', 'rec_first_rate', 'First mortgage rate', 'number', { format: 'percent' }),
  R('Mortgages & Debt', 'rec_max_rate', 'Highest mortgage rate', 'number', { format: 'percent' }),
  R('Mortgages & Debt', 'rec_first_lender', 'First mortgage lender', 'text'),
  R('Mortgages & Debt', 'rec_first_loan_type', 'First loan type', 'enum'),
  R('Mortgages & Debt', 'rec_first_recording_date', 'First mortgage recorded', 'date'),
  R('Mortgages & Debt', 'rec_first_due_date', 'First mortgage matures', 'date'),
  R('Mortgages & Debt', 'rec_has_private_lender', 'Private lender', 'boolean'),
  R('Mortgages & Debt', 'rec_has_heloc', 'Credit line (HELOC)', 'boolean'),
  R('Mortgages & Debt', 'rec_has_fha', 'FHA loan', 'boolean'),
  R('Mortgages & Debt', 'rec_has_va', 'VA loan', 'boolean'),
  R('Mortgages & Debt', 'rec_has_seller_financing', 'Seller-financed', 'boolean'),
  R('Mortgages & Debt', 'rec_has_adjustable', 'Adjustable / variable rate', 'boolean'),
  R('Liens & Notices', 'rec_lien_count', 'Recorded liens & notices', 'number'),
  R('Liens & Notices', 'rec_lien_amount_due', 'Lien amount due', 'number', { format: 'money' }),
  R('Liens & Notices', 'rec_lien_categories', 'Document category', 'array'),
  R('Liens & Notices', 'rec_has_probate', 'Probate filing', 'boolean'),
  R('Liens & Notices', 'rec_has_lis_pendens', 'Lis pendens', 'boolean'),
  R('Liens & Notices', 'rec_has_death_record', 'Death record / affidavit', 'boolean'),
  R('Liens & Notices', 'rec_has_divorce_record', 'Divorce record', 'boolean'),
  R('Liens & Notices', 'rec_has_judgment', 'Judgment', 'boolean'),
  R('Liens & Notices', 'rec_has_mechanics_lien', "Mechanic's lien", 'boolean'),
  R('Liens & Notices', 'rec_has_tax_lien', 'Tax lien', 'boolean'),
  R('Liens & Notices', 'rec_has_hoa_lien', 'HOA lien', 'boolean'),
  R('Liens & Notices', 'rec_has_default_notice', 'Notice of default', 'boolean'),
  R('Sale History', 'rec_sale_count', 'Recorded sales', 'number'),
  R('Sale History', 'rec_last_sale_date', 'Last sale date', 'date'),
  R('Sale History', 'rec_last_sale_price', 'Last sale price', 'number', { format: 'money' }),
  R('Sale History', 'rec_last_sale_doc_type', 'Last sale document', 'enum'),
  R('Sale History', 'rec_last_sale_distress', 'Last sale was a trustee / sheriff deed', 'boolean'),
  R('Sale History', 'rec_last_sale_intrafamily', 'Last sale was intrafamily / quitclaim', 'boolean'),
  R('Sale History', 'rec_years_owned', 'Years since last sale', 'number'),
  R('Foreclosure', 'rec_foreclosure_count', 'Foreclosure filings', 'number'),
  R('Foreclosure', 'rec_foreclosure_stage', 'Foreclosure stage', 'enum'),
  R('Foreclosure', 'rec_auction_date', 'Auction date', 'date'),
  R('Buyer Crossover', 'rec_owner_buyer_status', 'Owner is a known buyer — activity', 'enum'),
  R('Buyer Crossover', 'rec_owner_buyer_acquisitions', 'Owner’s observed purchases', 'number'),
  R('Buyer Crossover', 'rec_owner_buyer_basis', 'Owner↔buyer match basis', 'enum'),
])

/**
 * DISTRESS & CONDITION — the vendor property flags as WHOLE TOKENS.
 *
 * properties.property_flags_text is "Vacant Home; Tax Delinquent; …". A
 * substring match is wrong ("Foreclosure" is inside "Preforeclosure"), so a
 * flag matches only as a whole "; "-separated token, and several flags are
 * ORed (any of). Owner reference 2026-10-07 (read-only, canaries excluded):
 * Vacant Home 7,814 · Poor/Unsound 8,427 · Vacant AND Poor/Unsound 1,076.
 */
export const ENTITY_GRAPH_FLAG_FIELD = syntheticField('properties', 'properties', 'Distress & Condition', 'property_flags_text', 'Property flags', 'flags', {
  key: 'properties.flags',
  supports_options: true,
  description: 'Vendor property flags (Vacant Home, Tax Delinquent, Tired Landlord, Preforeclosure, Probate, …) matched as whole tokens; several are ORed.',
})

/**
 * Whole-token ilike patterns for one token in a delimited list ("; " by
 * default, ", " for prospects.matching_flags). A token never matches inside
 * another ("Foreclosure" is inside "Preforeclosure").
 */
export function flagTokenPatterns(token, separator = '; ') {
  const t = String(token ?? '').replace(/[^A-Za-z0-9 +\-/&']/g, '').trim()
  if (!t) return []
  const sep = String(separator || '; ')
  const core = sep.trim() || sep
  return [t, `${t}${core}%`, `%${sep}${t}`, `%${sep}${t}${core}%`]
}

/**
 * A value inside a PostgREST `or=(…)` expression. Commas and parentheses are
 * the expression's own syntax, so a value carrying one is double-quoted.
 */
export function orFilterValue(value) {
  const v = String(value ?? '')
  return /[,()"\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v
}

/** Buyer entities (public.eg_buyer_index — service-role read model over comp_private). */
const B = (category, column, label, type, extra) => syntheticField('buyers', 'eg_buyer_index', category, column, label, type, extra)
export const ENTITY_GRAPH_BUYER_FIELDS = Object.freeze([
  B('Activity', 'activity_status', 'Activity status', 'enum'),
  B('Activity', 'days_since_last', 'Days since last purchase', 'number'),
  B('Activity', 'trailing_90d', 'Purchases, last 90 days', 'number'),
  B('Activity', 'trailing_180d', 'Purchases, last 180 days', 'number'),
  B('Activity', 'trailing_365d', 'Purchases, last 12 months', 'number'),
  B('Activity', 'acquisition_count', 'Observed purchases', 'number'),
  B('Activity', 'acquisitions_per_year', 'Purchases per year', 'number'),
  B('Activity', 'last_acquisition', 'Last purchase', 'date'),
  B('Activity', 'first_acquisition', 'First purchase', 'date'),
  B('Behaviour', 'archetype', 'Archetype', 'enum'),
  B('Behaviour', 'hold_flip', 'Hold / flip', 'enum'),
  B('Behaviour', 'cash_share', 'Cash purchase share', 'number', { format: 'share' }),
  B('Behaviour', 'has_buybox', 'Has a derived buy box', 'boolean'),
  B('Geography', 'states', 'States bought in', 'array'),
  B('Geography', 'counties', 'Counties bought in', 'array'),
  B('Geography', 'zips', 'ZIPs bought in', 'array'),
  B('Geography', 'primary_market', 'Primary market', 'text'),
  B('Assets & Price', 'dominant_family', 'Dominant asset class', 'enum'),
  B('Assets & Price', 'asset_families', 'Asset classes bought', 'array'),
  B('Assets & Price', 'price_p50', 'Median purchase price', 'number', { format: 'money' }),
  B('Assets & Price', 'price_p25', 'Low purchase price (p25)', 'number', { format: 'money' }),
  B('Assets & Price', 'price_p75', 'High purchase price (p75)', 'number', { format: 'money' }),
  B('Portfolio & Roles', 'portfolio_count', 'Observed portfolio size', 'number'),
  B('Portfolio & Roles', 'owned_count', 'Owns properties in our universe', 'number'),
  B('Portfolio & Roles', 'sold_count', 'Observed sales (as seller)', 'number'),
  B('Portfolio & Roles', 'is_crossover', 'Both owns and has sold', 'boolean'),
  B('Identity', 'entity_type', 'Company or individual', 'enum'),
  B('Identity', 'confidence', 'Identity confidence', 'number', { format: 'share' }),
])

/**
 * DERIVED FIELDS — a question the raw column answers wrongly, compiled to the
 * predicate that answers it (filter audit, 2026-10-08).
 *
 *   properties.known_equity_percent — equity_known_v1 (entity-graph-truth.js):
 *     the vendor equity_percent reads 100% whenever no loan is on file (96,910
 *     of 176,610 properties), so "equity 60%+" on the raw column returned every
 *     property with no recorded loan. Known = a loan on file and a value (the
 *     vendor percentage), or no loan + the vendor "Free And Clear" flag (100%).
 *   prospects.age_years — prospects has no age column; the catalog's
 *     "Age bucket" compiles to prospects.mob, the month of birth as YYYYMM, so
 *     a bucket value never matched. An age range is a month-of-birth range.
 */
export const ENTITY_GRAPH_DERIVED_FIELDS = Object.freeze([
  syntheticField('properties', 'properties', 'Value & Equity', 'known_equity_percent', 'Known equity %', 'number', {
    key: 'properties.known_equity_percent',
    derived: 'known_equity',
    format: 'percent',
    operators: Object.freeze([{ key: 'gte', label: 'At least' }, { key: 'lte', label: 'At most' }, { key: 'between', label: 'Between' }]),
    description: 'Equity only where it is known: a loan on file and a value, or no loan with the vendor "Free And Clear" flag (100%). Unknown equity never matches.',
  }),
  syntheticField('prospects', 'prospects', 'Demographics', 'age_years', 'Age (years)', 'number', {
    key: 'prospects.age_years',
    derived: 'age_from_mob',
    operators: Object.freeze([{ key: 'gte', label: 'At least' }, { key: 'lte', label: 'At most' }, { key: 'between', label: 'Between' }]),
    description: 'Age from the month of birth on file (prospects.mob, YYYYMM), to the month. People with no month of birth never match.',
  }),
])

const SYNTHETIC_BY_KEY = new Map([...ENTITY_GRAPH_RECORD_FIELDS, ...ENTITY_GRAPH_BUYER_FIELDS, ENTITY_GRAPH_FLAG_FIELD, ...ENTITY_GRAPH_DERIVED_FIELDS].map((field) => [field.key, field]))

/**
 * Catalogued fields Entity Graph CANNOT execute on the table its tab reads
 * (filter audit 2026-10-08, information_schema against prod). They are not
 * offered, and a request naming one fails closed with the reason.
 */
export const ENTITY_GRAPH_UNEXECUTABLE_FIELDS = Object.freeze({
  'properties.aos_score': 'lives on property_acquisition_scores (Decision Engine), not on properties',
  'properties.decision_tier': 'lives on property_acquisition_scores (Decision Engine), not on properties',
  'properties.acquisition_confidence': 'lives on property_acquisition_scores (Decision Engine), not on properties',
  'properties.transaction_probability_365': 'lives on property_acquisition_scores (Decision Engine), not on properties',
  'properties.best_strategy': 'lives on property_acquisition_scores (Decision Engine), not on properties',
  'prospects.age_bucket': 'compiles to prospects.mob (month of birth, YYYYMM) — a bucket never matches; use prospects.age_years',
})

/**
 * Delimited-list text columns. "Is any of" on them compiled to whole-string
 * equality — "Likely Owner" matched only rows whose ENTIRE value was "Likely
 * Owner" (2,511 of 3,638 sampled properties carry several flags). They match
 * as whole tokens, like properties.flags.
 */
export const ENTITY_GRAPH_TOKEN_FIELDS = Object.freeze({
  'properties.property_flags_text': '; ',
  'prospects.person_flags_text': '; ',
  'prospects.matching_flags': ', ',
})
const TOKEN_OPS = Object.freeze([
  { key: 'is_any_of', label: 'Has any of' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Has a value' },
])

/** Raw columns that answer, but not the question their label suggests. Shown with the field. */
export const ENTITY_GRAPH_FIELD_CAUTIONS = Object.freeze({
  'properties.equity_percent': 'Vendor value: reads 100% whenever no loan is on file. Use "Known equity %" to filter on equity that is actually known.',
})

export const ENTITY_GRAPH_FILTERABLE_TABS = Object.freeze(Object.keys(ENTITY_GRAPH_FILTER_SOURCE_BY_TAB))

export function entityGraphFilterSourceForTab(tab) {
  return ENTITY_GRAPH_FILTER_SOURCE_BY_TAB[clean(tab).toLowerCase()] || null
}

function decorate(field) {
  if (!field) return field
  let out = field
  const emptyReason = ENTITY_GRAPH_EMPTY_SOURCE_COLUMNS[field.key]
  if (emptyReason) out = { ...out, data_coverage: 'empty', data_coverage_note: emptyReason }
  const separator = ENTITY_GRAPH_TOKEN_FIELDS[field.key]
  if (separator) out = { ...out, type: 'flags', operators: TOKEN_OPS, token_separator: separator, supports_options: true }
  const caution = ENTITY_GRAPH_FIELD_CAUTIONS[field.key]
  if (caution) out = { ...out, caution }
  return out
}

/** Every catalogued field a tab's own browse query can execute, in catalog order. */
export function getEntityGraphFilterFields(tab) {
  const source = entityGraphFilterSourceForTab(tab)
  if (!source) return []
  if (source === 'eg_buyer_index') return [...ENTITY_GRAPH_BUYER_FIELDS]
  const catalog = CAMPAIGN_FIELD_CATALOG
    .filter((field) => field.source_table_or_view === source && field.filterable
      && !ENTITY_GRAPH_WITHHELD_FIELDS.has(field.key) && !ENTITY_GRAPH_UNEXECUTABLE_FIELDS[field.key])
    .map(decorate)
  const derived = ENTITY_GRAPH_DERIVED_FIELDS.filter((field) => field.source_table_or_view === source)
  return source === 'properties' ? [ENTITY_GRAPH_FLAG_FIELD, ...derived, ...catalog, ...ENTITY_GRAPH_RECORD_FIELDS] : [...derived, ...catalog]
}

function lookupField(fieldKey) {
  return SYNTHETIC_BY_KEY.get(fieldKey) || decorate(getCampaignFieldDefinition(fieldKey))
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
    const fieldKey = SYNTHETIC_BY_KEY.has(requestedKey) ? requestedKey : normalizeCampaignFieldKey(requestedKey)
    if (ENTITY_GRAPH_WITHHELD_FIELDS.has(fieldKey)) {
      unsupported.push({ field_key: fieldKey, reason: 'field_withheld_from_entity_graph' })
      continue
    }
    if (ENTITY_GRAPH_UNEXECUTABLE_FIELDS[fieldKey]) {
      unsupported.push({ field_key: fieldKey, reason: 'field_not_executable_on_entity_graph', note: ENTITY_GRAPH_UNEXECUTABLE_FIELDS[fieldKey] })
      continue
    }
    const field = lookupField(fieldKey)
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
  // Array columns (buyer geography, lien categories) are an OVERLAP test; the
  // shared compiler has no array type, so they are applied here directly.
  const type = (entry) => entry.fieldDefinition?.type
  const isTokenMatch = (entry) => type(entry) === 'flags' && entry.operator === 'is_any_of'
  const arrays = resolved.filter((entry) => type(entry) === 'array')
  const flags = resolved.filter(isTokenMatch)
  const derived = resolved.filter((entry) => entry.fieldDefinition?.derived)
  const scalar = resolved
    .filter((entry) => type(entry) !== 'array' && !isTokenMatch(entry) && !entry.fieldDefinition?.derived)
    // a token field's empty / not-empty test is an ordinary text predicate
    .map((entry) => (type(entry) === 'flags' ? { ...entry, fieldDefinition: { ...entry.fieldDefinition, type: 'text' } } : entry))
  let next = scalar.length ? applySupabaseFilters(query, scalar) : query
  for (const entry of flags) {
    const values = (Array.isArray(entry.value) ? entry.value : [entry.value]).map(clean).filter(Boolean)
    const separator = entry.fieldDefinition?.token_separator || '; '
    const parts = values.flatMap((v) => flagTokenPatterns(v, separator)).map((pattern) => `${entry.source_column}.ilike.${orFilterValue(pattern)}`)
    if (parts.length) next = next.or(parts.join(','))
  }
  for (const entry of derived) {
    if (entry.fieldDefinition.derived === 'known_equity') next = applyKnownEquity(next, entry)
    else if (entry.fieldDefinition.derived === 'age_from_mob') next = applyAgeFromMob(next, entry)
  }
  for (const entry of arrays) {
    const values = (Array.isArray(entry.value) ? entry.value : [entry.value]).map(clean).filter(Boolean)
    if (values.length) next = next.overlaps(entry.source_column, values)
  }
  return next
}

function rangeOf(entry) {
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const v = entry.value
  if (entry.operator === 'gte') return { lo: num(Array.isArray(v) ? v[0] : v), hi: null }
  if (entry.operator === 'lte') return { lo: null, hi: num(Array.isArray(v) ? v[0] : v) }
  if (entry.operator === 'between') return { lo: num(Array.isArray(v) ? v[0] : null), hi: num(Array.isArray(v) ? v[1] : null) }
  return { lo: null, hi: null }
}

/** equity_known_v1 as a predicate — see ENTITY_GRAPH_DERIVED_FIELDS. */
export function applyKnownEquity(query, entry) {
  const { lo, hi } = rangeOf(entry)
  const loanBranch = ['total_loan_balance.gt.0', 'estimated_value.gt.0']
  if (lo !== null) loanBranch.push(`equity_percent.gte.${lo}`)
  if (hi !== null) loanBranch.push(`equity_percent.lte.${hi}`)
  const freeAndClear = (lo === null || lo <= 100) && (hi === null || hi >= 100)
  if (!freeAndClear) {
    let q = query.gt('total_loan_balance', 0).gt('estimated_value', 0)
    if (lo !== null) q = q.gte('equity_percent', lo)
    if (hi !== null) q = q.lte('equity_percent', hi)
    return q
  }
  const flag = flagTokenPatterns('Free And Clear').map((p) => `property_flags_text.ilike.${orFilterValue(p)}`).join(',')
  return query.or(`and(${loanBranch.join(',')}),and(estimated_value.gt.0,or(total_loan_balance.is.null,total_loan_balance.eq.0),or(${flag}))`)
}

const ym = (date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`

/** An age range as a month-of-birth (YYYYMM text) range. `now` is injectable for tests. */
export function ageMobBounds({ lo = null, hi = null } = {}, now = new Date()) {
  const shift = (years, months = 0) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    d.setUTCFullYear(d.getUTCFullYear() - years)
    d.setUTCMonth(d.getUTCMonth() + months)
    return d
  }
  // at least `lo` years old  → born in or before (now − lo years)
  // at most `hi` years old   → born after (now − (hi + 1) years)
  const upper = lo !== null ? ym(shift(lo)) : '209912'
  const lower = hi !== null ? ym(shift(hi + 1, 1)) : '190001'
  return { lower: lower < '190001' ? '190001' : lower, upper }
}

export function applyAgeFromMob(query, entry, now = new Date()) {
  const { lower, upper } = ageMobBounds(rangeOf(entry), now)
  return query.gte('mob', lower).lte('mob', upper)
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
