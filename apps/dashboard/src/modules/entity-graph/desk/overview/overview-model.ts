/**
 * Overview → filter AST (spec 9 §4.1 cross-filtering). A bucket carries the
 * rail's own chip (`{ field_key, operator, value }`); clicking it edits the
 * SAME filter list the rail, the header filters and the grid read, so the
 * grid, Board, Map and Overview all refetch the one cohort.
 *
 *   click        the field's chip becomes this bucket (replaces that field's chips)
 *   shift-click  adds the value to the field's set (is_any_of / is_all_of)
 *   alt-click    excludes the value (is_not_any_of) — categorical values only
 */
import type { EntityGraphFieldFilter } from '../../../../domain/entity-graph/entity-graph-field-filters'
import type { OverviewBucket, OverviewField } from './overview-types'

export type ClickMode = 'replace' | 'add' | 'exclude'
export type ClickResult = { filters: EntityGraphFieldFilter[]; applied: boolean; reason?: string }

const SET_OPS = new Set(['is_any_of', 'is_all_of', 'is_not_any_of'])
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === null || v === undefined ? [] : [String(v)])
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function clickModeFromEvent(e: { shiftKey?: boolean; altKey?: boolean }): ClickMode {
  if (e.altKey) return 'exclude'
  if (e.shiftKey) return 'add'
  return 'replace'
}

export function applyBucketClick(filters: EntityGraphFieldFilter[], filter: EntityGraphFieldFilter | null | undefined, mode: ClickMode = 'replace'): ClickResult {
  if (!filter) return { filters, applied: false, reason: 'This bucket has no filter of its own.' }
  const key = filter.field_key
  const others = filters.filter((f) => f.field_key !== key)
  const mine = filters.filter((f) => f.field_key === key)
  if (mode === 'exclude') {
    if (filter.operator !== 'is_any_of') return { filters, applied: false, reason: 'Only a single value can be excluded — not a range, a flag or a yes/no.' }
    const existing = mine.find((f) => f.operator === 'is_not_any_of')
    const values = [...new Set([...asList(existing?.value), ...asList(filter.value)])]
    const rest = mine.filter((f) => f !== existing && !(f.operator === 'is_any_of' && asList(f.value).every((v) => asList(filter.value).includes(v))))
    return { filters: [...others, ...rest, { field_key: key, operator: 'is_not_any_of', value: values }], applied: true }
  }
  if (mode === 'add' && SET_OPS.has(filter.operator)) {
    const existing = mine.find((f) => f.operator === filter.operator)
    if (existing) {
      const values = [...new Set([...asList(existing.value), ...asList(filter.value)])]
      return { filters: filters.map((f) => (f === existing ? { ...f, value: values } : f)), applied: true }
    }
    return { filters: [...filters, { ...filter }], applied: true }
  }
  // replace (and shift-click on a range: ranges do not union — the band becomes the chip)
  return { filters: [...others, { ...filter }], applied: true }
}

/** Is this bucket's chip (or its value inside a set chip) already applied? */
export function bucketActive(filters: EntityGraphFieldFilter[], filter: EntityGraphFieldFilter | null | undefined): boolean {
  if (!filter) return false
  return filters.some((f) => {
    if (f.field_key !== filter.field_key) return false
    if (SET_OPS.has(f.operator) && f.operator === filter.operator) return asList(filter.value).every((v) => asList(f.value).includes(v))
    return f.operator === filter.operator && sameValue(f.value, filter.value)
  })
}

export function bucketExcluded(filters: EntityGraphFieldFilter[], filter: EntityGraphFieldFilter | null | undefined): boolean {
  if (!filter || filter.operator !== 'is_any_of') return false
  return filters.some((f) => f.field_key === filter.field_key && f.operator === 'is_not_any_of' && asList(filter.value).every((v) => asList(f.value).includes(v)))
}

export const fieldFiltered = (filters: EntityGraphFieldFilter[], key: string) => filters.some((f) => f.field_key === key)

/* ── formatting ─────────────────────────────────────────────────────────── */

export const fmtInt = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—')
export function fmtShare(n: number | null | undefined, d: number | null | undefined): string {
  if (typeof n !== 'number' || !d) return '—'
  const p = (n / d) * 100
  return p >= 10 || p === 0 ? `${p.toFixed(0)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`
}
export function fmtValue(v: number | string | null | undefined, format = 'number'): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string') return v
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (format === 'money') return `${v < 0 ? '−' : ''}$${a >= 1e6 ? `${+(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${+(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K` : Math.round(a).toLocaleString('en-US')}`
  if (format === 'percent') return `${+v.toFixed(a >= 10 ? 0 : 1)}%`
  if (format === 'year') return String(Math.round(v))
  if (format === 'sqft') return `${Math.round(v).toLocaleString('en-US')} sqft`
  return a >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : v.toLocaleString('en-US', { maximumFractionDigits: a < 10 ? 2 : 0 })
}

/* ── chart geometry ─────────────────────────────────────────────────────── */

/** Bars are scaled to the largest VALUE bucket; "Not recorded" / remainder bars never set the scale. */
export function barScale(buckets: OverviewBucket[]): number {
  const values = buckets.filter((b) => b.tone !== 'none' && b.tone !== 'other').map((b) => b.count)
  const max = Math.max(0, ...values, ...(values.length ? [] : buckets.map((b) => b.count)))
  return max > 0 ? max : 1
}

export type ChartForm = 'bars' | 'histogram' | 'split' | 'coverage'
export function chartForm(f: OverviewField): ChartForm {
  if (f.kind === 'numeric' || f.kind === 'derived_number' || f.kind === 'date') return 'histogram'
  if (f.kind === 'boolean' || f.kind === 'derived_boolean') return 'split'
  if (f.kind === 'coverage') return 'coverage'
  return 'bars'
}

/** The accessible table / CSV of one card (aggregates only — never a seller field value beyond the bucket labels). */
export function bucketsCsv(f: OverviewField): string {
  const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  const total = f.coverage?.total ?? 0
  const lines = [['bucket', 'count', 'share'].join(',')]
  for (const b of f.buckets || []) lines.push([esc(b.label), b.count, total ? (b.count / total).toFixed(6) : ''].join(','))
  return lines.join('\n')
}

/** Stable section order and the band's pinned subset. */
export const OVERVIEW_SECTION_ORDER = ['outreach', 'geography', 'property', 'distress', 'value', 'debt', 'ownership', 'company', 'owner', 'people', 'contacts', 'decision', 'zip'] as const
