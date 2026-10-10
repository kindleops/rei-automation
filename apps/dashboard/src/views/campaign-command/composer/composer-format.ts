/** Plain-word formatters shared by the Composer planes (kept out of component files for fast refresh). */
import type { FilterClause } from './composer-model'

const OP_WORDS: Record<string, string> = { is_any_of: 'is', is_not_any_of: 'is not', contains: 'contains', gte: '≥', lte: '≤', between: 'between', eq: '=', is_true: 'yes', is_false: 'no', is_empty: 'is empty', is_not_empty: 'is set', within: 'within', in: 'in' }

/**
 * A clause in plain words. A pinned selection (properties.property_id) is a
 * count — "2,010 properties pinned from Entity Graph" — never thousands of ids.
 */
export function clauseValueText(f: FilterClause, pinnedFrom?: string | null): string {
  if (f.fieldKey === 'properties.property_id') {
    const n = new Set((Array.isArray(f.value) ? f.value : [f.value]).map((v) => String(v ?? '').trim()).filter(Boolean)).size
    return `${n.toLocaleString('en-US')} ${n === 1 ? 'property' : 'properties'} pinned${pinnedFrom ? ` from ${pinnedFrom}` : ''}`
  }
  if (f.operator === 'is_true') return 'Yes'
  if (f.operator === 'is_false') return 'No'
  if (f.operator === 'is_empty' || f.operator === 'is_not_empty') return OP_WORDS[f.operator]
  if (f.fieldKey === 'properties.drawn_area') return 'Drawn area'
  if (f.operator === 'between' && Array.isArray(f.value)) return `${f.value[0] || '…'} – ${f.value[1] || '…'}`
  const values = Array.isArray(f.value) ? f.value.map(String) : [String(f.value ?? '')]
  const head = values.slice(0, 2).join(', ')
  const prefix = f.operator === 'is_not_any_of' ? 'not ' : f.operator === 'gte' ? '≥ ' : f.operator === 'lte' ? '≤ ' : ''
  return `${prefix}${head}${values.length > 2 ? ` +${values.length - 2}` : ''}`
}

const REASON_WORDS: Record<string, string> = {
  governance_paused: 'Paused by template governance',
  governance_daily_cap_zero: 'Governance cap is 0',
  governance_daily_cap_exhausted: 'Governance cap reached',
  governance_unmeasurable: 'Governance cap unmeasurable',
  blocked_by_operator: 'On the operator blocklist',
  template_inactive: 'Inactive',
  template_quarantined: 'Quarantined',
  TEMPLATE_RENDER_LINT_FAILURE: 'Refused by the render lint (e.g. no first name)',
  NO_TEMPLATE: 'No template fits this seller',
  TEMPLATE_GOVERNANCE_PAUSED: 'Only paused templates fit',
  governance_unreadable: 'Governance unreadable — the plan refuses',
}
export const reasonWords = (r: string | null | undefined) => (r ? REASON_WORDS[r] ?? r.replace(/_/g, ' ').toLowerCase() : '')

/** A datetime-local value in the browser's wall clock (never toISOString().slice — that shifts by the UTC offset). */
export function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
