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
import { factsColumnSupported, factsHeaderValues } from './entity-graph-facts-query.js'

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
