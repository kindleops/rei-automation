/**
 * ENTITY GRAPH · HEADER FILTER VALUES (owner, 2026-10-09: "you should be able
 * to click and sort and filter" every column).
 *
 * GET /api/cockpit/entity-graph/header-values?tab=properties&column=<col>&<the browse's own filter params>
 *   → { field, column, kind, total, known, values?: [{ value, count }], range?: { min, max }, mode, asOf }
 *
 * `field` is the filter-catalog field a header filter writes into the SAME
 * filter AST the rail edits: the catalogued field for that source column when
 * one exists (properties.year_built, records.mortgage_count…), else the
 * property fact field (facts.sms_status, facts.company_status_class…). The
 * column's own current filter is left out of the counts, so the other values
 * stay pickable (the rail's facet rule). Counts are exact over the whole
 * filtered cohort — never a sample.
 */
import {
  applyEntityGraphFieldFilters,
  getEntityGraphFilterFields,
  resolveEntityGraphFieldFiltersOrThrow,
} from './entity-graph-field-filters.js'
import { applyPropertyFilters, parseBrowseFilters } from './entity-graph-service.js'
import { factsCohortRelation, factsColumnSupported, factsHeaderValues } from './entity-graph-facts-query.js'
import { compositionTabConfig } from './entity-graph-composition.js'
import { compileFacetWhere, groupedFacetCounts, groupedRangeStats, groupedTokenCounts } from './entity-graph-facet-sql.js'
import { queryWithTimeout } from '@/lib/postgres/client.js'

const clean = (v) => String(v ?? '').trim()

let fieldBySource = null
/** The filter field a header on `column` writes (catalog first, then the fact field). */
export function headerFieldFor(column) {
  if (!fieldBySource) {
    fieldBySource = new Map()
    for (const f of getEntityGraphFilterFields('properties')) {
      // derived fields (known equity, has lien…) and the token flag field answer a different question than the raw column
      if (f.derived || f.key === 'properties.flags') continue
      // catalog order: catalogued fields, then record fields, then fact fields — the first one wins
      if (!fieldBySource.has(f.source_column)) fieldBySource.set(f.source_column, f)
    }
  }
  const f = fieldBySource.get(column)
  if (!f) return null
  return { key: f.key, label: f.label, type: f.type, operators: f.operators, kind: f.fact_kind || null }
}

export async function getEntityGraphHeaderValues(params = {}, deps = {}) {
  // ?field=<field_key> — any tab: the rail's value pickers on this same endpoint
  if (clean(params.field)) return getEntityGraphFieldValues(params, deps)
  const tab = clean(params.tab || 'properties').toLowerCase()
  const column = clean(params.column)
  if (tab !== 'properties') return { supported: false, column, reason: 'header_values_properties_only' }
  if (!factsColumnSupported(column)) return { supported: false, column, reason: 'unknown_column' }
  const field = headerFieldFor(column)
  const filters = parseBrowseFilters(params)
  const { resolved } = resolveEntityGraphFieldFiltersOrThrow('properties', params, { allowComputedFacts: true })
  // the column's own filter is not applied to its own value counts
  const others = resolved.filter((f) => f.source_column !== column && (!field || f.field_key !== field.key))
  const out = await factsHeaderValues({
    column,
    applyFilters: (b) => applyEntityGraphFieldFilters(applyPropertyFilters(b, filters), others),
    deps: deps.factsDeps || {},
  })
  return { supported: true, field, ...out }
}

/* ── FIELD VALUES: the rail's "All fields" pickers on the SAME path ─────────────────
 * Owner P0 2026-10-10: "All fields → find a field → it adds a filter where you
 * must TYPE a value". Every catalog field now answers with its real values:
 *   checklist  categorical / list fields — every value with its exact count over
 *              the filtered cohort (the field's own filter left out), searchable
 *              server-side (search=), never a sample
 *   range      numeric / currency / date — exact min / max + histogram hints
 *   boolean    Yes / No / Not recorded with counts
 *   text       free text only for names, addresses, ids and search fields
 * Properties read the property facts relation (the header filters' own
 * factsHeaderValues); people / owners / phones / buyers read their tab's
 * table with the composition's exact GROUP BY.
 *
 *   GET /api/cockpit/entity-graph/header-values?tab=<tab>&field=<field_key>[&search=…]&<filters>
 */

const FIELD_VALUES_MAX = 300

/**
 * Case / spacing variants of one value ("Multi-Family" · "Multi-family",
 * "INDIVIDUAL" · "Individual") become ONE option whose filter selects every
 * variant — the data is not rewritten, the filter stays an exact is_any_of.
 * Exclusive (one value per record) lists only: a token list could hold two
 * variants on one record, so its counts are left per raw token.
 */
// conservative: case, whitespace, spacing around / & , and periods only — "C" vs "C-" (a grade) and "R3" vs "R3-" stay apart
export const variantKey = (v) => String(v ?? '').toLowerCase().replace(/\s*([/&,])\s*/g, '$1').replace(/\./g, '').replace(/\s+/g, ' ').trim()
export function foldValueVariants(values = []) {
  const groups = new Map()
  for (const row of values) {
    if (row.value === null) { groups.set(null, { value: null, count: (groups.get(null)?.count || 0) + row.count }); continue }
    const k = variantKey(row.value)
    const g = groups.get(k)
    if (!g) groups.set(k, { value: row.value, count: row.count, variants: [{ value: row.value, count: row.count }] })
    else {
      g.count += row.count
      g.variants.push({ value: row.value, count: row.count })
      // the most common spelling labels the option
      g.variants.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      g.value = g.variants[0].value
    }
  }
  return [...groups.values()].map((g) => (g.variants && g.variants.length > 1 ? { value: g.value, count: g.count, variants: g.variants.map((x) => x.value) } : { value: g.value, count: g.count }))
    .sort((a, b) => b.count - a.count || (a.value === null ? 1 : b.value === null ? -1 : a.value.localeCompare(b.value)))
}
const folded = (out) => (out && Array.isArray(out.values) && out.kind !== 'tokens' ? { ...out, values: foldValueVariants(out.values) } : out)

/** Free typing is kept ONLY for names, addresses, ids and text search — everything else is picked. */
export const FREE_TEXT_FIELD = /(^|\.)(property_id|master_owner_id|prospect_id|phone_id|buyer_id|individual_key|owner_name|owner_display_name|owner_1_name|owner_2_name|full_name|display_name|seller_full_name|property_address_full|property_address|property_address_range|owner_address(_[a-z0-9]+)?|owner_location|mailing_address|primary_owner_address|company_name|contact_person|entity_name|legal_description|apn_parcel_id|lot_nbr|first_lender|lienholder_name|email|best_email|best_phone|canonical_e164)$/

const KIND_OF_TYPE = { boolean: 'boolean', number: 'numeric', date: 'date', flags: 'tokens', array: 'tokens', enum: 'categorical', text: 'categorical' }

/** The picker a field gets. */
export function fieldControl(field, kind = null) {
  if (!field) return null
  if (FREE_TEXT_FIELD.test(field.key)) return 'text'
  const k = kind || KIND_OF_TYPE[field.type] || 'categorical'
  if (k === 'boolean') return 'boolean'
  if (k === 'numeric' || k === 'date') return 'range'
  return 'checklist'
}

const fieldSummary = (f) => ({ key: f.key, label: f.label, type: f.type, operators: f.operators, kind: f.fact_kind || null, ...(f.token_separator ? { token_separator: f.token_separator } : {}), ...(f.sensitive ? { sensitive: f.sensitive, sensitive_note: f.sensitive_note } : {}) })

/** Facts column a derived property field is counted on (same truth the filter applies). */
const DERIVED_VALUE_COLUMN = { known_equity: 'equity_known_pct' }

export async function getEntityGraphFieldValues(params = {}, deps = {}) {
  const tab = clean(params.tab || 'properties').toLowerCase()
  const fieldKey = clean(params.field)
  const field = getEntityGraphFilterFields(tab).find((f) => f.key === fieldKey) || null
  if (!field) return { supported: false, field: null, reason: 'unknown_field', field_key: fieldKey }
  const search = clean(params.search).slice(0, 80)
  const filters = parseBrowseFilters(params)
  const { resolved } = resolveEntityGraphFieldFiltersOrThrow(tab, params, { allowComputedFacts: tab === 'properties' })
  // the field's own filter is left out of its own counts (the rail's facet rule)
  const others = resolved.filter((f) => f.field_key !== field.key)
  const declaredKind = field.type === 'flags' ? 'tokens' : (field.fact_kind || KIND_OF_TYPE[field.type] || 'categorical')
  const control = fieldControl(field, declaredKind)
  const summary = fieldSummary(field)
  if (control === 'text') return { supported: true, field: summary, control, kind: 'text' }

  if (tab === 'properties') {
    const applyFilters = (b) => applyEntityGraphFieldFilters(applyPropertyFilters(b, filters), others)
    if (field.derived) {
      if (declaredKind === 'boolean') return { supported: true, field: summary, control, kind: 'boolean', ...(await derivedBooleanCounts({ field, applyFilters, deps })) }
      const col = DERIVED_VALUE_COLUMN[field.derived]
      if (!col) return { supported: true, field: summary, control, kind: declaredKind }
      const out = await factsHeaderValues({ column: col, applyFilters, histogram: true, deps: deps.factsDeps || {} })
      return { supported: true, field: summary, control, ...out }
    }
    const column = field.source_column
    if (!factsColumnSupported(column)) return { supported: false, field: summary, control, reason: 'unknown_column' }
    const split = field.type === 'flags' ? (field.token_separator || '; ') : null
    const out = await factsHeaderValues({ column, applyFilters, search, split, histogram: control === 'range', deps: deps.factsDeps || {} })
    return { supported: true, field: summary, control: fieldControl(field, out.kind), ...folded(out) }
  }

  const config = compositionTabConfig(tab)
  if (!config) return { supported: false, field: summary, reason: 'tab_has_no_values' }
  const applyFilters = (b) => applyEntityGraphFieldFilters(config.applyBase(b, filters), others)
  const query = deps.query || queryWithTimeout
  if (field.derived) return { supported: true, field: summary, control, kind: declaredKind, note: 'derived field: no value list' }
  const column = field.source_column
  const mode = 'live'
  const asOf = new Date().toISOString()
  if (control === 'range') {
    const stats = await (deps.groupedRangeStats || groupedRangeStats)({ source: config.table, column, kind: declaredKind, applyFilters, query })
    return { supported: true, field: summary, control, kind: declaredKind, mode, source: 'live', asOf, ...stats }
  }
  if (declaredKind === 'tokens') {
    const split = field.type === 'flags' ? (field.token_separator || '; ') : null
    const r = await (deps.groupedTokenCounts || groupedTokenCounts)({ source: config.table, column, split, array: !split && field.type === 'array', applyFilters, query })
    const term = search.toLowerCase()
    const rows = r.tokens.filter((t) => !term || t.value.toLowerCase().includes(term)).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    return { supported: true, field: summary, control, kind: 'tokens', mode, source: 'live', asOf, total: r.total, known: null, values: rows.slice(0, FIELD_VALUES_MAX), truncated: rows.length > FIELD_VALUES_MAX, ...(search ? { search } : {}) }
  }
  const rows = await (deps.groupedFacetCounts || groupedFacetCounts)({ source: config.table, column, search, applyFilters, query })
  const total = search ? null : rows.reduce((n, r) => n + r.count, 0)
  const known = search ? null : rows.filter((r) => r.value !== null).reduce((n, r) => n + r.count, 0)
  const sorted = [...rows].sort((a, b) => b.count - a.count || (a.value === null ? 1 : b.value === null ? -1 : a.value.localeCompare(b.value)))
  const values = foldValueVariants(sorted)
  return { supported: true, field: summary, control, kind: declaredKind === 'boolean' ? 'boolean' : 'categorical', mode, source: 'live', asOf, total, known, values: values.slice(0, FIELD_VALUES_MAX), truncated: values.length > FIELD_VALUES_MAX, ...(search ? { search } : {}) }
}

/** Yes / Not yes counts of a derived boolean (tax delinquent either source, has a recorded lien…) — the filter's own compiler. */
async function derivedBooleanCounts({ field, applyFilters, deps }) {
  const query = deps.factsDeps?.query || deps.query || queryWithTimeout
  const { resolved: yes } = resolveEntityGraphFieldFiltersOrThrow('properties', { field_filters: JSON.stringify([{ field_key: field.key, operator: 'is_true' }]) }, { allowComputedFacts: true })
  const yesWhere = compileFacetWhere((b) => applyEntityGraphFieldFilters(b, yes))
  const yesCols = [...new Set(yesWhere.clauseColumns.flatMap((set) => [...set]))]
  const rel = await factsCohortRelation({ applyFilters, columns: yesCols, deps: deps.factsDeps || {} })
  const params = [...rel.params]
  const shifted = yesWhere.clauses.map((clause) => clause.replace(/\$(\d+)/g, (_, n) => `$${params.length + Number(n)}`)).join(' and ')
  params.push(...yesWhere.params)
  const res = await query(`select count(*)::bigint as total, count(*) filter (where ${shifted || 'false'})::bigint as yes from ${rel.from} ${rel.where}`, params, 25_000)
  const r = res?.rows?.[0] || {}
  const total = Number(r.total || 0); const y = Number(r.yes || 0)
  return { total, known: total, values: [{ value: 'true', count: y }, { value: 'false', count: total - y }], mode: rel.mode, source: rel.source || rel.mode, asOf: rel.asOf }
}
