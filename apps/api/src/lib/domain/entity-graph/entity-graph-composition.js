/**
 * COMPOSITION — "what is this cohort made of", for ANY dimension, under ANY filter.
 *
 * The old lens could only group by six columns and only honoured six simple
 * filters, because it was one fixed GROUP BY RPC. The operator's ask is to
 * pick any dimension (type, market, equity, rate, years owned, lien category…)
 * and see it for exactly the cohort on screen — record and buyer filters
 * included.
 *
 * PostgREST aggregates are disabled on this project and a dynamic-SQL RPC is
 * off the table, so every bucket is an EXACT `count` query built by the same
 * query builder the list uses. A cohort's composition therefore cannot
 * disagree with the cohort's list.
 *
 *   banded    numeric ranges, fixed edges, one count per band
 *   signals   boolean facts, one count per signal (shares do NOT add up — said so)
 *   top       categorical: candidate values are DISCOVERED from a bounded
 *             sample of the cohort, then each is counted exactly; the rest is
 *             "Everything else" = total − Σ. The sample only chooses which
 *             buckets to show; every number shown is exact.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import {
  applyEntityGraphFieldFilters,
  resolveEntityGraphFieldFiltersOrThrow,
} from './entity-graph-field-filters.js'
import { applyBuyerFilters, applyPropertyFilters, parseBrowseFilters } from './entity-graph-service.js'
import { FacetUntranslatable, facetsAvailable, groupedFacetCounts } from './entity-graph-facet-sql.js'

const clean = (value) => String(value ?? '').trim()
const SAMPLE_ROWS = 1500
const TOP_BUCKETS = 9
const CONCURRENCY = 4

const money = (n) => (n >= 1e6 ? `$${n / 1e6}M` : n >= 1e3 ? `$${n / 1e3}K` : `$${n}`)
const bands = (edges, fmt = (n) => String(n), { under = true, over = true } = {}) => {
  const out = []
  if (under) out.push({ key: `lt_${edges[0]}`, label: `Under ${fmt(edges[0])}`, lt: edges[0] })
  for (let i = 0; i < edges.length - 1; i += 1) {
    out.push({ key: `${edges[i]}_${edges[i + 1]}`, label: `${fmt(edges[i])}–${fmt(edges[i + 1])}`, gte: edges[i], lt: edges[i + 1] })
  }
  if (over) out.push({ key: `gte_${edges[edges.length - 1]}`, label: `${fmt(edges[edges.length - 1])}+`, gte: edges[edges.length - 1] })
  return out
}

const PROPERTY_DIMENSIONS = [
  { key: 'property_type', label: 'Property type', group: 'Asset', kind: 'top', column: 'property_type', filterKey: 'properties.property_type' },
  { key: 'state', label: 'State', group: 'Geography', kind: 'top', column: 'property_address_state', filterKey: 'properties.property_address_state' },
  { key: 'market', label: 'Market', group: 'Geography', kind: 'top', column: 'market', filterKey: 'properties.market' },
  { key: 'county', label: 'County', group: 'Geography', kind: 'top', column: 'property_address_county_name', filterKey: 'properties.property_address_county_name' },
  { key: 'city', label: 'City', group: 'Geography', kind: 'top', column: 'property_address_city', filterKey: 'properties.property_address_city' },
  { key: 'value', label: 'Estimated value', group: 'Value', kind: 'banded', column: 'estimated_value', format: 'money', buckets: bands([100000, 250000, 500000, 1000000, 5000000], money) },
  { key: 'equity', label: 'Equity', group: 'Value', kind: 'banded', column: 'equity_percent', format: 'percent', buckets: bands([0, 20, 40, 60, 80], (n) => `${n}%`) },
  { key: 'year_built', label: 'Year built', group: 'Asset', kind: 'banded', column: 'year_built', buckets: bands([1940, 1960, 1980, 2000, 2010], String) },
  { key: 'units', label: 'Units', group: 'Asset', kind: 'banded', column: 'units_count', buckets: [
    { key: '1', label: '1', gte: 0, lt: 2 }, { key: '2', label: '2', gte: 2, lt: 3 }, { key: '3_4', label: '3–4', gte: 3, lt: 5 },
    { key: '5_9', label: '5–9', gte: 5, lt: 10 }, { key: '10_49', label: '10–49', gte: 10, lt: 50 }, { key: '50', label: '50+', gte: 50 },
  ] },
  { key: 'beds', label: 'Bedrooms', group: 'Asset', kind: 'banded', column: 'total_bedrooms', buckets: [
    { key: '1', label: '1', gte: 0, lt: 2 }, { key: '2', label: '2', gte: 2, lt: 3 }, { key: '3', label: '3', gte: 3, lt: 4 },
    { key: '4', label: '4', gte: 4, lt: 5 }, { key: '5', label: '5+', gte: 5 },
  ] },
  { key: 'owner', label: 'Ownership', group: 'Owner', kind: 'signals', buckets: [
    { key: 'corporate', label: 'Company-owned', column: 'is_corporate_owner', eq: true },
    { key: 'absentee', label: 'Out-of-state owner', column: 'out_of_state_owner', eq: true },
    // "Known buyer" alone is trivially true (every owner bought once); the
    // signal is a REPEAT buyer, or one still buying.
    { key: 'owner_buyer', label: 'Owner is a repeat buyer', column: 'rec_owner_buyer_acquisitions', gte: 2 },
    { key: 'owner_buyer_active', label: 'Owner is an active buyer', column: 'rec_owner_buyer_status', eq: 'active' },
  ] },
  { key: 'distress', label: 'Distress signals', group: 'Records', kind: 'signals', buckets: [
    { key: 'tax_delinquent', label: 'Tax delinquent', column: 'tax_delinquent', eq: true },
    { key: 'probate', label: 'Probate', column: 'rec_has_probate', eq: true },
    { key: 'death', label: 'Death record', column: 'rec_has_death_record', eq: true },
    { key: 'lis_pendens', label: 'Lis pendens', column: 'rec_has_lis_pendens', eq: true },
    { key: 'default', label: 'Notice of default', column: 'rec_has_default_notice', eq: true },
    { key: 'foreclosure', label: 'Foreclosure filing', column: 'rec_foreclosure_count', gte: 1 },
    { key: 'judgment', label: 'Judgment', column: 'rec_has_judgment', eq: true },
    { key: 'tax_lien', label: 'Tax lien', column: 'rec_has_tax_lien', eq: true },
  ] },
  { key: 'debt', label: 'Debt', group: 'Records', kind: 'signals', buckets: [
    { key: 'no_mortgage', label: 'No open mortgage', column: 'rec_mortgage_count', eq: 0 },
    { key: 'one', label: '1 open mortgage', column: 'rec_mortgage_count', eq: 1 },
    { key: 'two_plus', label: '2+ open mortgages', column: 'rec_mortgage_count', gte: 2 },
    { key: 'private', label: 'Private lender', column: 'rec_has_private_lender', eq: true },
    { key: 'heloc', label: 'Credit line', column: 'rec_has_heloc', eq: true },
    { key: 'arm', label: 'Adjustable rate', column: 'rec_has_adjustable', eq: true },
  ] },
  { key: 'rate', label: 'First mortgage rate', group: 'Records', kind: 'banded', column: 'rec_first_rate', format: 'percent', buckets: bands([3, 4, 5, 6, 7, 8], (n) => `${n}%`) },
  { key: 'balance', label: 'Mortgage balance', group: 'Records', kind: 'banded', column: 'rec_mortgage_balance', format: 'money', buckets: bands([50000, 150000, 300000, 600000, 1000000], money) },
  { key: 'loan_type', label: 'Loan type', group: 'Records', kind: 'top', column: 'rec_first_loan_type', filterKey: 'records.first_loan_type' },
  { key: 'years_owned', label: 'Years since last sale', group: 'Records', kind: 'banded', column: 'rec_years_owned', buckets: [
    { key: '0_2', label: '0–2', gte: 0, lt: 3 }, { key: '3_5', label: '3–5', gte: 3, lt: 6 }, { key: '6_10', label: '6–10', gte: 6, lt: 11 },
    { key: '11_20', label: '11–20', gte: 11, lt: 21 }, { key: '21', label: '21+', gte: 21 },
  ] },
  { key: 'last_deed', label: 'Last sale document', group: 'Records', kind: 'top', column: 'rec_last_sale_doc_type', filterKey: 'records.last_sale_doc_type' },
]

const BUYER_DIMENSIONS = [
  { key: 'activity', label: 'Activity', group: 'Activity', kind: 'top', column: 'activity_status', filterKey: 'buyers.activity_status' },
  { key: 'archetype', label: 'Archetype', group: 'Behaviour', kind: 'top', column: 'archetype', filterKey: 'buyers.archetype' },
  { key: 'state', label: 'Top state', group: 'Geography', kind: 'top', column: 'top_state', filterKey: 'buyers.states' },
  { key: 'market', label: 'Primary market', group: 'Geography', kind: 'top', column: 'primary_market', filterKey: 'buyers.primary_market' },
  { key: 'asset', label: 'Dominant asset', group: 'Assets', kind: 'top', column: 'dominant_family', filterKey: 'buyers.dominant_family' },
  { key: 'hold_flip', label: 'Hold vs flip', group: 'Behaviour', kind: 'top', column: 'hold_flip', filterKey: 'buyers.hold_flip' },
  { key: 'kind', label: 'Company vs individual', group: 'Identity', kind: 'top', column: 'entity_type', filterKey: 'buyers.entity_type' },
  { key: 'purchases', label: 'Observed purchases', group: 'Activity', kind: 'banded', column: 'acquisition_count', buckets: [
    { key: '1', label: '1', gte: 0, lt: 2 }, { key: '2_4', label: '2–4', gte: 2, lt: 5 }, { key: '5_9', label: '5–9', gte: 5, lt: 10 },
    { key: '10_24', label: '10–24', gte: 10, lt: 25 }, { key: '25', label: '25+', gte: 25 },
  ] },
  { key: 'recency', label: 'Last purchase', group: 'Activity', kind: 'banded', column: 'days_since_last', buckets: [
    { key: '30', label: '≤ 30 days', gte: 0, lt: 31 }, { key: '90', label: '31–90 days', gte: 31, lt: 91 },
    { key: '180', label: '91–180 days', gte: 91, lt: 181 }, { key: '365', label: '181–365 days', gte: 181, lt: 366 },
    { key: 'older', label: 'Over a year', gte: 366 },
  ] },
  { key: 'price', label: 'Median purchase price', group: 'Price', kind: 'banded', column: 'price_p50', format: 'money', buckets: bands([100000, 250000, 500000, 1000000, 5000000], money) },
  { key: 'roles', label: 'Roles', group: 'Roles', kind: 'signals', buckets: [
    { key: 'owns', label: 'Owns in our universe', column: 'owned_count', gte: 1 },
    { key: 'sold', label: 'Has sold', column: 'sold_count', gte: 1 },
    { key: 'crossover', label: 'Owns and has sold', column: 'is_crossover', eq: true },
    { key: 'buybox', label: 'Has a buy box', column: 'has_buybox', eq: true },
  ] },
]

const TAB_CONFIG = {
  properties: { table: 'v_entity_graph_properties', countColumn: 'property_id', dimensions: PROPERTY_DIMENSIONS, applyBase: applyPropertyFilters },
  buyers: { table: 'eg_buyer_index', countColumn: 'buyer_id', dimensions: BUYER_DIMENSIONS, applyBase: applyBuyerFilters },
}

export function getCompositionCatalog(tab = 'properties') {
  const config = TAB_CONFIG[clean(tab).toLowerCase()]
  if (!config) return { tab, dimensions: [] }
  return {
    tab,
    dimensions: config.dimensions.map(({ key, label, group, kind, format }) => ({ key, label, group, kind, format: format || null })),
  }
}

async function pooled(tasks, limit = CONCURRENCY) {
  const results = new Array(tasks.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next
      next += 1
      results[index] = await tasks[index]()
    }
  }))
  return results
}

function applyBucket(query, column, bucket) {
  const col = bucket.column || column
  if (bucket.notNull) return query.not(col, 'is', null)
  if (bucket.eq !== undefined) return query.eq(col, bucket.eq)
  if (bucket.value !== undefined) return bucket.value === null ? query.is(col, null) : query.eq(col, bucket.value)
  let q = query
  if (bucket.gte !== undefined) q = q.gte(col, bucket.gte)
  if (bucket.lt !== undefined) q = q.lt(col, bucket.lt)
  return q
}

export async function buildEntityGraphComposition(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const tab = clean(params.tab || 'properties').toLowerCase()
  const config = TAB_CONFIG[tab]
  if (!config) return { tab, supported: false, dimension: null, total: null, buckets: [] }
  const dimension = config.dimensions.find((entry) => entry.key === clean(params.dimension)) || config.dimensions[0]

  const filters = parseBrowseFilters(params)
  const { resolved: fieldFilters } = resolveEntityGraphFieldFiltersOrThrow(tab, params)
  const base = (select, options) => applyEntityGraphFieldFilters(
    config.applyBase(supabase.from(config.table).select(select, options), filters),
    fieldFilters,
  )
  const count = async (bucket) => {
    let query = base(config.countColumn, { count: 'exact', head: true })
    if (bucket) query = applyBucket(query, dimension.column, bucket)
    const { count: n, error } = await query
    return error ? null : (n ?? null)
  }

  // Categorical facets: one exact GROUP BY over the same WHERE as the list —
  // every value, no sample, no cap (see entity-graph-facet-sql.js).
  if (dimension.kind === 'top') {
    const exhaustive = await exhaustiveTopComposition({ deps, config, dimension, filters, fieldFilters, all: isTruthy(params.all) })
    if (exhaustive) return { tab, ...exhaustive }
  }

  const total = await count(null)

  let bucketDefs = dimension.buckets || []
  if (dimension.kind === 'top') {
    // Discover candidates from SLICES spread across the cohort (physical order
    // clusters by import batch, so one slice from the top would see one
    // market). Small cohorts are read whole.
    const slices = total !== null && total > SAMPLE_ROWS ? 5 : 1
    const per = Math.ceil(SAMPLE_ROWS / slices)
    const offsets = Array.from({ length: slices }, (_, i) => (slices === 1 ? 0 : Math.floor(((total - per) * i) / (slices - 1))))
    const sampled = await Promise.all(offsets.map((offset) => base(`${config.countColumn},${dimension.column}`)
      .not(dimension.column, 'is', null)
      .order(config.countColumn)
      .range(offset, offset + per - 1)))
    const failed = sampled.find((entry) => entry.error)
    if (failed) throw failed.error
    const tally = new Map()
    for (const row of sampled.flatMap((entry) => entry.data || [])) {
      const value = clean(row[dimension.column])
      if (value) tally.set(value, (tally.get(value) || 0) + 1)
    }
    bucketDefs = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_BUCKETS)
      .map(([value]) => ({ key: value, label: value, value }))
  }

  const counts = await pooled(bucketDefs.map((bucket) => () => count(bucket)))

  const order = bucketDefs.map((bucket, index) => index)
  if (dimension.kind === 'top') order.sort((a, b) => (counts[b] ?? -1) - (counts[a] ?? -1))
  const buckets = order.map((index) => ({ bucket: bucketDefs[index], index })).map(({ bucket, index }) => ({
    key: bucket.key,
    label: bucket.label,
    value: counts[index],
    share: total && counts[index] !== null ? counts[index] / total : null,
    filter: bucketFilter(dimension, bucket),
  }))

  if (dimension.kind === 'top' && total !== null) {
    const shown = buckets.reduce((sum, bucket) => sum + (bucket.value || 0), 0)
    const blank = await count({ value: null })
    const other = Math.max(0, total - shown - (blank || 0))
    if (other > 0) buckets.push({ key: '__other', label: 'Everything else', value: other, share: other / total, filter: null })
    if (blank) buckets.push({ key: '__blank', label: 'Not recorded', value: blank, share: blank / total, filter: null })
  }
  if (dimension.kind === 'banded' && total !== null) {
    const shown = buckets.reduce((sum, bucket) => sum + (bucket.value || 0), 0)
    const missing = total - shown
    if (missing > 0) buckets.push({ key: '__blank', label: 'Not recorded', value: missing, share: missing / total, filter: null })
  }

  return {
    tab,
    supported: true,
    dimension: { key: dimension.key, label: dimension.label, group: dimension.group, kind: dimension.kind, format: dimension.format || null },
    total,
    additive: dimension.kind !== 'signals',
    // 'top' only reaches here when the grouped count was unavailable: the
    // values shown were discovered from a sample, so the list is not complete.
    exhaustive: dimension.kind !== 'top',
    note: dimension.kind === 'signals' ? 'A record can carry several signals, so these shares do not add up to 100%.' : null,
    buckets,
  }
}

const isTruthy = (value) => ['1', 'true', 'yes'].includes(clean(value).toLowerCase())

/**
 * Every value of a categorical dimension with its exact count, from one
 * GROUP BY. `all` returns every value (the desktop facet list is searchable);
 * otherwise the nine largest plus an EXACT "Everything else" remainder —
 * exact because every value was counted, not sampled. Returns null when the
 * grouped path is unavailable (no direct database url, a filter the SQL
 * recorder cannot translate, or the query failed) so the caller can fall back.
 */
async function exhaustiveTopComposition({ deps, config, dimension, filters, fieldFilters, all }) {
  const grouped = deps.groupedFacetCounts || groupedFacetCounts
  const available = deps.facetsAvailable || facetsAvailable
  if (!available()) return null
  let rows
  try {
    rows = await grouped({
      source: config.table,
      column: dimension.column,
      applyFilters: (builder) => applyEntityGraphFieldFilters(config.applyBase(builder, filters), fieldFilters),
    })
  } catch (error) {
    if (!(error instanceof FacetUntranslatable)) {
      console.warn('[entity-graph] grouped facet failed, falling back to sampled discovery:', error?.message || error)
    }
    return null
  }
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  const blank = rows.filter((row) => row.value === null).reduce((sum, row) => sum + row.count, 0)
  const valued = rows.filter((row) => row.value !== null)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  const shown = all ? valued : valued.slice(0, TOP_BUCKETS)
  const buckets = shown.map((row) => ({
    key: row.value,
    label: row.value,
    value: row.count,
    share: total ? row.count / total : null,
    filter: bucketFilter(dimension, { key: row.value, label: row.value, value: row.value }),
  }))
  const other = valued.slice(shown.length).reduce((sum, row) => sum + row.count, 0)
  if (other > 0) buckets.push({ key: '__other', label: 'Everything else', value: other, share: total ? other / total : null, filter: null })
  if (blank > 0) buckets.push({ key: '__blank', label: 'Not recorded', value: blank, share: total ? blank / total : null, filter: null })
  return {
    supported: true,
    dimension: { key: dimension.key, label: dimension.label, group: dimension.group, kind: dimension.kind, format: dimension.format || null },
    total,
    additive: true,
    exhaustive: true,
    distinct: valued.length,
    note: null,
    buckets,
  }
}

/**
 * The field filter a bucket tap applies, in the SAME vocabulary as the filter
 * builder, so drilling from the chart is indistinguishable from filtering.
 */
function bucketFilter(dimension, bucket) {
  const synthetic = (column) => (column.startsWith('rec_') ? `records.${column.slice(4)}` : null)
  const colKey = (column) => synthetic(column)
    || (TAB_CONFIG.buyers.dimensions.includes(dimension) ? `buyers.${column}` : `properties.${column}`)
  if (dimension.kind === 'top') {
    return dimension.filterKey ? { field_key: dimension.filterKey, operator: 'is_any_of', value: [bucket.value] } : null
  }
  const column = bucket.column || dimension.column
  if (bucket.notNull) return { field_key: colKey(column), operator: 'is_not_empty', value: null }
  if (bucket.eq === true) return { field_key: colKey(column), operator: 'is_true', value: null }
  if (bucket.eq !== undefined) {
    return typeof bucket.eq === 'number'
      ? { field_key: colKey(column), operator: 'between', value: [bucket.eq, bucket.eq] }
      : { field_key: colKey(column), operator: 'is_any_of', value: [bucket.eq] }
  }
  if (bucket.gte !== undefined && bucket.lt !== undefined) {
    // `between` is inclusive on both ends, the band is [gte, lt): close it just
    // under lt — a whole unit for whole-number columns, a hair for percentages.
    const upper = dimension.format === 'percent' ? bucket.lt - 0.0001 : bucket.lt - 1
    return { field_key: colKey(column), operator: 'between', value: [bucket.gte, upper] }
  }
  if (bucket.gte !== undefined) return { field_key: colKey(column), operator: 'gte', value: bucket.gte }
  if (bucket.lt !== undefined) return { field_key: colKey(column), operator: 'lte', value: dimension.format === 'percent' ? bucket.lt - 0.0001 : bucket.lt - 1 }
  return null
}

export default buildEntityGraphComposition
