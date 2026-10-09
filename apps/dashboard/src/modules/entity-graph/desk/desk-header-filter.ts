/**
 * ENTITY GRAPH DESK · HEADER FILTERS — the pure parts (owner, 2026-10-09:
 * "ALL the columns up top — you should be able to click and sort and filter").
 *
 * A header filter is NOT a second filter system: it writes one ordinary
 * `{ field_key, operator, value }` chip into the same AST the rail edits, on
 * the filter-catalog field for that column (the catalogued field when one
 * exists, else the property fact field) — the server's headerFieldFor applies
 * the same rule and returns the field with the values. Tested in
 * desk-header-filter.test.ts.
 */
import type { EntityGraphFieldFilter, EntityGraphFilterCatalog, EntityGraphFilterField } from '../../../domain/entity-graph/entity-graph-field-filters'
import { COMPANY_STATUS_LABEL, smsBlockLabel } from '../mobile/entity-graph-table-columns'

export type HeaderKind = 'categorical' | 'numeric' | 'date' | 'boolean' | 'text' | 'tokens'

/** The catalog field a header on facts column `col` writes: catalog order, derived + token-flag fields skipped. */
export function headerFieldKeyFor(catalog: EntityGraphFilterCatalog | null, col: string): string | null {
  if (!catalog) return null
  for (const g of catalog.groups) {
    for (const f of g.fields) {
      if ((f as EntityGraphFilterField & { derived?: string }).derived || f.key === 'properties.flags') continue
      if (f.source_column === col) return f.key
    }
  }
  return null
}

/** The column's filter currently in the AST (one per field). */
export function activeHeaderFilter(filters: EntityGraphFieldFilter[], fieldKey: string | null): EntityGraphFieldFilter | null {
  if (!fieldKey) return null
  return filters.find((f) => f.field_key === fieldKey) ?? null
}

/** The AST with this field's filter replaced (null = removed); every other chip untouched, order kept. */
export function replaceFieldFilter(filters: EntityGraphFieldFilter[], fieldKey: string, next: EntityGraphFieldFilter | null): EntityGraphFieldFilter[] {
  const at = filters.findIndex((f) => f.field_key === fieldKey)
  const rest = filters.filter((f) => f.field_key !== fieldKey)
  if (!next) return rest
  if (at < 0) return [...rest, next]
  return [...rest.slice(0, at), next, ...rest.slice(at)]
}

export type HeaderSelection = {
  /** checked values; null = "No value" */
  values?: Array<string | null>
  from?: string
  to?: string
  contains?: string
  /** numeric / date: only rows that have / lack a value */
  presence?: 'has' | 'none' | null
}

const allows = (field: { operators: Array<{ key: string }> } | null, op: string) => Boolean(field?.operators.some((o) => o.key === op))

/**
 * The one chip a header selection means, or null (nothing to filter). Boolean:
 * Yes → is_true, No → is_false, No value → is_empty. Lists: is_any_of; only
 * "No value" → is_empty. Ranges: between (or at least / at most). Contains:
 * the text operator. A selection the field cannot express returns null +
 * the reason via headerSelectionProblem.
 */
export function headerFilterFromSelection(field: { key: string; operators: Array<{ key: string }> } | null, kind: HeaderKind, sel: HeaderSelection): EntityGraphFieldFilter | null {
  if (!field) return null
  if (headerSelectionProblem(field, kind, sel)) return null
  if (kind === 'numeric' || kind === 'date') {
    if (sel.presence === 'has') return { field_key: field.key, operator: 'is_not_empty' }
    if (sel.presence === 'none') return { field_key: field.key, operator: 'is_empty' }
    const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : kind === 'numeric' ? Number(v) : v.trim())
    const lo = num(sel.from)
    const hi = num(sel.to)
    if (lo === null && hi === null) return null
    const gte = kind === 'date' ? 'on_or_after' : 'gte'
    const lte = kind === 'date' ? 'on_or_before' : 'lte'
    if (lo !== null && hi !== null) return { field_key: field.key, operator: 'between', value: [lo, hi] }
    return lo !== null ? { field_key: field.key, operator: gte, value: lo } : { field_key: field.key, operator: lte, value: hi }
  }
  if (sel.contains && sel.contains.trim()) return { field_key: field.key, operator: 'contains', value: sel.contains.trim() }
  const values = sel.values ?? []
  if (!values.length) return null
  const real = values.filter((v): v is string => v !== null)
  if (kind === 'boolean') {
    if (!real.length) return { field_key: field.key, operator: 'is_empty' }
    return { field_key: field.key, operator: real[0] === 'true' ? 'is_true' : 'is_false' }
  }
  if (!real.length) return { field_key: field.key, operator: 'is_empty' }
  return { field_key: field.key, operator: 'is_any_of', value: real }
}

/** Why a selection cannot be one chip (shown under Apply), or null. */
export function headerSelectionProblem(field: { operators: Array<{ key: string }> } | null, kind: HeaderKind, sel: HeaderSelection): string | null {
  if (!field) return 'This column has no filter field'
  if (kind === 'numeric' || kind === 'date') {
    if (sel.presence) return allows(field, sel.presence === 'has' ? 'is_not_empty' : 'is_empty') ? null : 'This field cannot filter on presence'
    const lo = sel.from?.trim() ?? ''
    const hi = sel.to?.trim() ?? ''
    if (kind === 'numeric' && ((lo && !Number.isFinite(Number(lo))) || (hi && !Number.isFinite(Number(hi))))) return 'Enter numbers'
    if (lo && hi && (kind === 'numeric' ? Number(lo) > Number(hi) : lo > hi)) return '“From” is after “To”'
    return null
  }
  if (sel.contains && sel.contains.trim()) return allows(field, 'contains') ? null : 'This field cannot match on text'
  const values = sel.values ?? []
  const real = values.filter((v) => v !== null)
  if (kind === 'boolean') {
    if (real.length > 1 || (real.length && values.includes(null))) return 'Pick one: Yes, No, or No value'
    return null
  }
  if (real.length && values.includes(null)) return '“No value” cannot be combined with values — pick one or the other'
  if (real.length && !allows(field, 'is_any_of')) return 'This field cannot match a list of values'
  if (!real.length && values.includes(null) && !allows(field, 'is_empty')) return 'This field cannot filter on “No value”'
  return null
}

/** The selection an existing chip means (to pre-tick the menu). */
export function selectionFromFilter(filter: EntityGraphFieldFilter | null, kind: HeaderKind): HeaderSelection {
  if (!filter) return { values: [] }
  const v = filter.value
  switch (filter.operator) {
    case 'is_true': return { values: ['true'] }
    case 'is_false': return { values: ['false'] }
    case 'is_empty': return kind === 'numeric' || kind === 'date' ? { presence: 'none' } : { values: [null] }
    case 'is_not_empty': return { presence: 'has' }
    case 'is_any_of': return { values: (Array.isArray(v) ? v : [v]).map((x) => String(x)) }
    case 'contains': return { contains: String(v ?? '') }
    case 'between': return { from: Array.isArray(v) && v[0] !== null && v[0] !== undefined ? String(v[0]) : '', to: Array.isArray(v) && v[1] !== null && v[1] !== undefined ? String(v[1]) : '' }
    case 'gte': case 'on_or_after': return { from: String(v ?? '') }
    case 'lte': case 'on_or_before': return { to: String(v ?? '') }
    default: return { values: [] }
  }
}

/** A stored value in words for the checklist (codes humanised; the raw value is what filters). */
export function headerValueLabel(col: string, value: string | null, kind: HeaderKind): string {
  if (value === null) return 'No value'
  if (kind === 'boolean') return value === 'true' ? 'Yes' : value === 'false' ? 'No' : value
  if (col === 'sms_status') return value === 'eligible' ? 'Eligible' : smsBlockLabel(value)
  if (col === 'company_status_class') return COMPANY_STATUS_LABEL[value] ?? value
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(value)) return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  return value
}

/** "as of 9:31 AM (read model)" / "live · computed 9:31 AM". */
export function headerAsOfText(mode: string | undefined, source: string | undefined, asOf: string | null | undefined): string {
  const t = asOf ? Date.parse(asOf) : NaN
  const at = Number.isFinite(t) ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null
  if (mode === 'table' || mode === 'facts_table') return at ? `as of ${at} · read model` : 'read model'
  if (source === 'memo') return at ? `live · computed ${at}` : 'live'
  return at ? `live · ${at}` : 'live'
}
