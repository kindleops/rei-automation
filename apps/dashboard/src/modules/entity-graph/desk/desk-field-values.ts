/**
 * ENTITY GRAPH DESK · "All fields" value pickers — the pure parts (owner P0,
 * 2026-10-10: "All fields → find a field → it adds a filter where you must TYPE
 * a value. I want a DROPDOWN of real values with counts").
 *
 * Every catalog field gets a picker from the field-values endpoint (the header
 * filters' own /entity-graph/header-values, ?field=):
 *   checklist  categorical / list fields: searchable multi-select of the exact
 *              values with counts; "Exclude" (is not any of) and, for flag
 *              lists, all-of / any-of
 *   range      numeric / currency / date: from–to, with the cohort's min / max
 *              and histogram hints
 *   boolean    Yes / No / Not recorded
 *   text       free text ONLY for names, addresses, ids and text search
 * The chip a picker writes is the header filter's chip (desk-header-filter.ts):
 * one ordinary { field_key, operator, value } in the same AST.
 * Tested in desk-field-values.test.ts.
 */
import type { EntityGraphFieldFilter, EntityGraphFilterField } from '../../../domain/entity-graph/entity-graph-field-filters'
import { headerFilterFromSelection, headerSelectionProblem, selectionFromFilter, type HeaderKind, type HeaderSelection } from './desk-header-filter'

export type PickerControl = 'checklist' | 'range' | 'boolean' | 'text'
/** checklist mode: any of (default) · all of (flag lists) · not any of (exclude) */
export type ChecklistMode = 'any' | 'all' | 'not'

/** Same rule as the server's FREE_TEXT_FIELD (entity-graph-header-values.js) — the picker a field gets before its values load. */
export const FREE_TEXT_FIELD = /(^|\.)(property_id|master_owner_id|prospect_id|phone_id|buyer_id|individual_key|owner_name|owner_display_name|owner_1_name|owner_2_name|full_name|display_name|seller_full_name|property_address_full|property_address|property_address_range|owner_address(_[a-z0-9]+)?|owner_location|mailing_address|primary_owner_address|company_name|contact_person|entity_name|legal_description|apn_parcel_id|lot_nbr|first_lender|lienholder_name|email|best_email|best_phone|canonical_e164)$/

const KIND_OF_TYPE: Record<string, HeaderKind> = { boolean: 'boolean', number: 'numeric', date: 'date', flags: 'tokens', array: 'tokens', enum: 'categorical', text: 'categorical' }

export function pickerKindFor(field: Pick<EntityGraphFilterField, 'type'> & { fact_kind?: string | null }): HeaderKind {
  const fk = (field as { fact_kind?: string | null }).fact_kind
  if (fk === 'numeric' || fk === 'date' || fk === 'boolean' || fk === 'tokens' || fk === 'categorical' || fk === 'text') return fk
  return KIND_OF_TYPE[field.type] ?? 'categorical'
}

export function pickerControlFor(field: Pick<EntityGraphFilterField, 'key' | 'type'>, kind: HeaderKind = pickerKindFor(field)): PickerControl {
  if (FREE_TEXT_FIELD.test(field.key)) return 'text'
  if (kind === 'boolean') return 'boolean'
  if (kind === 'numeric' || kind === 'date') return 'range'
  return 'checklist'
}

const allows = (field: { operators: Array<{ key: string }> } | null, op: string) => Boolean(field?.operators.some((o) => o.key === op))

/** The checklist mode an existing chip means. */
export function checklistModeOf(filter: EntityGraphFieldFilter | null): ChecklistMode {
  if (filter?.operator === 'is_not_any_of') return 'not'
  if (filter?.operator === 'is_all_of') return 'all'
  return 'any'
}

/** The modes a field can express (flag lists stack: all of / any of; text lists: any of / exclude). */
export function checklistModes(field: { operators: Array<{ key: string }> } | null): ChecklistMode[] {
  const out: ChecklistMode[] = []
  if (allows(field, 'is_any_of')) out.push('any')
  if (allows(field, 'is_all_of')) out.push('all')
  if (allows(field, 'is_not_any_of')) out.push('not')
  return out.length ? out : ['any']
}

/** The picker's selection for an existing chip (to pre-tick). */
export function pickerSelectionFromFilter(filter: EntityGraphFieldFilter | null, kind: HeaderKind): HeaderSelection {
  if (!filter) return { values: [] }
  if (filter.operator === 'is_not_any_of' || filter.operator === 'is_all_of') {
    const v = filter.value
    return { values: (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined).map(String) }
  }
  return selectionFromFilter(filter, kind)
}

/**
 * The chip a picker selection means, or null (nothing chosen yet). Checklist
 * modes rewrite the header chip's operator (is_any_of → is_all_of / is_not_any_of)
 * only when the field advertises it.
 */
export function pickerFilterFromSelection(
  field: { key: string; operators: Array<{ key: string }> } | null,
  kind: HeaderKind,
  sel: HeaderSelection,
  mode: ChecklistMode = 'any',
): EntityGraphFieldFilter | null {
  if (!field) return null
  if (kind === 'tokens' && !allows(field, 'is_any_of') && allows(field, 'is_all_of')) mode = 'all'
  const base = headerFilterFromSelection(field, kind === 'tokens' ? 'categorical' : kind, sel)
  if (!base) return null
  if (base.operator !== 'is_any_of') return base
  if (mode === 'all' && allows(field, 'is_all_of')) return { ...base, operator: 'is_all_of' }
  if (mode === 'not' && allows(field, 'is_not_any_of')) return { ...base, operator: 'is_not_any_of' }
  return base
}

export function pickerSelectionProblem(field: { operators: Array<{ key: string }> } | null, kind: HeaderKind, sel: HeaderSelection): string | null {
  if (!field) return 'This field is not filterable on this scope'
  if (kind === 'tokens') {
    const real = (sel.values ?? []).filter((v) => v !== null)
    if (real.length && (sel.values ?? []).includes(null)) return '“No value” cannot be combined with values — pick one or the other'
    if (real.length && !allows(field, 'is_any_of') && !allows(field, 'is_all_of')) return 'This field cannot match a list of values'
    if (!real.length && (sel.values ?? []).includes(null) && !allows(field, 'is_empty')) return 'This field cannot filter on “No value”'
    return null
  }
  return headerSelectionProblem(field, kind, sel)
}

/** Free text: a contains (or equals) chip; '' = nothing yet. */
export function textFilterFrom(field: { key: string; operators: Array<{ key: string }> }, text: string): EntityGraphFieldFilter | null {
  const t = text.trim()
  if (!t) return null
  if (allows(field, 'contains')) return { field_key: field.key, operator: 'contains', value: t }
  if (allows(field, 'eq')) return { field_key: field.key, operator: 'eq', value: t }
  if (allows(field, 'is_any_of')) return { field_key: field.key, operator: 'is_any_of', value: [t] }
  return null
}

export type HistogramBar = { lo: number; hi: number; count: number; share: number; tail?: 'below' | 'above' }

/** Histogram bars, height = count / the tallest bucket (tails included). */
export function histogramBars(buckets: Array<{ lo: number; hi: number; count: number; tail?: 'below' | 'above' }> | undefined | null): HistogramBar[] {
  const list = buckets ?? []
  const max = Math.max(1, ...list.map((b) => b.count))
  return list.map((b) => ({ ...b, share: b.count / max }))
}

/** A compact number for range hints: 1,250 · 452K · 1.3M; percentages / small values keep two decimals. */
export function compactNumber(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `${Math.round(n / 1e8) / 10}B`
  if (a >= 1e6) return `${Math.round(n / 1e5) / 10}M`
  if (a >= 1e4) return `${Math.round(n / 1e3)}K`
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  return String(Math.round(n * 100) / 100)
}

/** An option's raw values: its folded spellings (case / spacing variants), else itself. */
export function optionMembers(option: { value: string | null; variants?: string[] }): Array<string | null> {
  return option.variants && option.variants.length ? option.variants : [option.value]
}
/** An option is on when every one of its spellings is selected. */
export function optionSelected(selected: Array<string | null>, members: Array<string | null>): boolean {
  return members.length > 0 && members.every((m) => selected.includes(m))
}
/** Toggle an option's spellings together; "No value" stands alone (picking a real value drops it, and vice versa). */
export function toggleMembers(selected: Array<string | null>, members: Array<string | null>): Array<string | null> {
  if (optionSelected(selected, members)) return selected.filter((x) => !members.includes(x))
  if (members.includes(null)) return [null]
  return [...selected.filter((x) => x !== null && !members.includes(x)), ...members]
}
