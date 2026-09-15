import * as backendClient from '../../lib/api/backendClient'

/**
 * THE FILTER FIELDS COME FROM THE BACKEND CATALOG, NOT FROM THIS FILE.
 *
 * Entity Graph had 13 hand-written inputs against a database the campaign
 * builder already describes with 156 catalogued fields. Hard-coding a hundred
 * more inputs here would just create a second catalog to drift from the first:
 * a field renamed in FIELD_GROUPS would keep rendering, keep sending, and fail
 * server-side. So the shape of the filter builder is fetched.
 *
 * GET /api/cockpit/entity-graph/filter-catalog?tab=properties returns only the
 * fields that tab's own query can execute, so anything the operator can pick is
 * something the backend can run -- and anything it cannot run comes back as a
 * 422 naming the field rather than a page of unfiltered rows.
 */

export type EntityGraphFieldType = 'text' | 'number' | 'date' | 'boolean' | 'json' | 'enum'

export type EntityGraphFieldOperator = { key: string; label: string }

export type EntityGraphFilterField = {
  key: string
  domain: string
  category: string
  label: string
  source_table_or_view: string
  source_column: string
  type: EntityGraphFieldType
  operators: EntityGraphFieldOperator[]
  supports_options?: boolean
  supported_in_preview?: boolean
  description?: string
  /** 'empty' when the column was measured to hold no values -- see the backend note. */
  data_coverage?: 'empty'
  data_coverage_note?: string
}

export type EntityGraphFilterGroup = { id: string; label: string; fields: EntityGraphFilterField[] }

export type EntityGraphFilterCatalog = {
  tab: string
  source: string
  groups: EntityGraphFilterGroup[]
  total_fields: number
  filterable_tabs: string[]
}

/** One active filter. Mirrors the backend/campaign payload shape exactly. */
export type EntityGraphFieldFilter = {
  field_key: string
  operator: string
  value?: unknown
}

export type UnsupportedFieldFilter = {
  field_key: string | null
  reason: string
  operator?: string
  supported_operators?: string[]
  field_source?: string
  tab_source?: string
}

const VALUELESS_OPERATORS = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false'])
const RANGE_OPERATORS = new Set(['between'])
const MULTI_VALUE_OPERATORS = new Set(['is_any_of', 'is_not_any_of', 'contains_any'])

export function operatorNeedsValue(operator: string): boolean {
  return !VALUELESS_OPERATORS.has(operator)
}

export function operatorIsRange(operator: string): boolean {
  return RANGE_OPERATORS.has(operator)
}

export function operatorIsMultiValue(operator: string): boolean {
  return MULTI_VALUE_OPERATORS.has(operator)
}

const catalogCache = new Map<string, EntityGraphFilterCatalog>()

/** Tabs whose browse query is an aggregate and cannot take a column filter. */
export const NON_FILTERABLE_TABS = new Set(['markets', 'zips', 'organizations'])

export async function fetchEntityGraphFilterCatalog(
  tab: string,
  signal?: AbortSignal,
): Promise<EntityGraphFilterCatalog | null> {
  if (NON_FILTERABLE_TABS.has(tab)) return null
  const cached = catalogCache.get(tab)
  if (cached) return cached
  const res = await backendClient.callBackend<EntityGraphFilterCatalog>(
    `/api/cockpit/entity-graph/filter-catalog?tab=${encodeURIComponent(tab)}`,
    { signal },
  )
  if (!res.ok || !res.data?.source) return null
  const catalog = res.data
  catalogCache.set(tab, catalog)
  return catalog
}

export function flattenCatalogFields(catalog: EntityGraphFilterCatalog | null): EntityGraphFilterField[] {
  if (!catalog) return []
  return catalog.groups.flatMap((group) => group.fields)
}

export function findCatalogField(
  catalog: EntityGraphFilterCatalog | null,
  fieldKey: string,
): EntityGraphFilterField | null {
  return flattenCatalogFields(catalog).find((field) => field.key === fieldKey) ?? null
}

/**
 * Filters an operator has actually finished specifying.
 *
 * A half-typed row must NOT be sent: the backend rejects a value-less
 * `contains` as `missing_value` (correctly -- it would compile to nothing), and
 * the operator would see a 422 for a row they are still filling in.
 */
export function completeFieldFilters(filters: EntityGraphFieldFilter[]): EntityGraphFieldFilter[] {
  return filters.filter((filter) => {
    if (!filter.field_key || !filter.operator) return false
    if (!operatorNeedsValue(filter.operator)) return true
    if (operatorIsRange(filter.operator)) {
      const pair = Array.isArray(filter.value) ? filter.value : []
      return pair.some((entry) => String(entry ?? '').trim() !== '')
    }
    if (Array.isArray(filter.value)) {
      return filter.value.some((entry) => String(entry ?? '').trim() !== '')
    }
    if (typeof filter.value === 'boolean') return true
    return String(filter.value ?? '').trim() !== ''
  })
}

/** The single query param the browse endpoint reads. Undefined when nothing is set. */
export function fieldFiltersToApiParam(filters: EntityGraphFieldFilter[]): string | undefined {
  const complete = completeFieldFilters(filters)
  if (!complete.length) return undefined
  return JSON.stringify(complete)
}

export function parseFieldFiltersParam(raw: string | null | undefined): EntityGraphFieldFilter[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is EntityGraphFieldFilter => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        field_key: String(entry.field_key ?? ''),
        operator: String(entry.operator ?? ''),
        value: entry.value,
      }))
      .filter((entry) => entry.field_key !== '')
  } catch {
    return []
  }
}

export function defaultOperatorFor(field: EntityGraphFilterField): string {
  return field.operators?.[0]?.key ?? 'eq'
}

export function defaultValueFor(field: EntityGraphFilterField, operator: string): unknown {
  if (!operatorNeedsValue(operator)) return undefined
  if (operatorIsRange(operator)) return ['', '']
  if (operatorIsMultiValue(operator)) return []
  if (field.type === 'boolean') return true
  return ''
}

/** A human-readable one-liner for a chip, so an active filter is legible without opening the drawer. */
export function describeFieldFilter(
  filter: EntityGraphFieldFilter,
  field: EntityGraphFilterField | null,
): string {
  const label = field?.label || filter.field_key
  const operatorLabel = field?.operators?.find((op) => op.key === filter.operator)?.label || filter.operator
  if (!operatorNeedsValue(filter.operator)) return `${label} · ${operatorLabel}`
  if (operatorIsRange(filter.operator)) {
    const [min, max] = Array.isArray(filter.value) ? filter.value : ['', '']
    const minText = String(min ?? '').trim()
    const maxText = String(max ?? '').trim()
    if (minText && maxText) return `${label} ${minText}–${maxText}`
    if (minText) return `${label} ≥ ${minText}`
    if (maxText) return `${label} ≤ ${maxText}`
    return `${label} · ${operatorLabel}`
  }
  const values = Array.isArray(filter.value) ? filter.value : [filter.value]
  const text = values.map((entry) => String(entry ?? '').trim()).filter(Boolean).join(', ')
  return text ? `${label} ${operatorLabel.toLowerCase()} ${text}` : `${label} · ${operatorLabel}`
}

/** Search the whole catalog by label, key or category -- 100+ fields is not a scroll list. */
export function searchCatalogFields(
  catalog: EntityGraphFilterCatalog | null,
  query: string,
): EntityGraphFilterField[] {
  const fields = flattenCatalogFields(catalog)
  const text = query.trim().toLowerCase()
  if (!text) return fields
  return fields.filter((field) =>
    field.label.toLowerCase().includes(text)
    || field.key.toLowerCase().includes(text)
    || field.category.toLowerCase().includes(text),
  )
}
