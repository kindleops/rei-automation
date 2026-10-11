import { describe, expect, it } from 'vitest'
import {
  checklistModeOf,
  checklistModes,
  compactNumber,
  histogramBars,
  optionMembers,
  optionSelected,
  toggleMembers,
  pickerControlFor,
  pickerFilterFromSelection,
  pickerKindFor,
  pickerSelectionFromFilter,
  pickerSelectionProblem,
  textFilterFrom,
} from './desk-field-values'
import { DESK_FACET_GROUPS } from './desk-model'
import { headerValueLabel } from './desk-header-filter'

const TEXT_OPS = [{ key: 'contains' }, { key: 'is_any_of' }, { key: 'is_not_any_of' }, { key: 'is_empty' }, { key: 'is_not_empty' }]
const FLAG_OPS = [{ key: 'is_all_of' }, { key: 'is_any_of' }]
const NUM_OPS = [{ key: 'gte' }, { key: 'lte' }, { key: 'between' }, { key: 'is_empty' }, { key: 'is_not_empty' }]
const BOOL_OPS = [{ key: 'is_true' }, { key: 'is_false' }]

describe('All fields value pickers (owner P0 2026-10-10: a dropdown of real values, never typing)', () => {
  it('picks a control per field; free text only for names / addresses / ids', () => {
    expect(pickerControlFor({ key: 'properties.market', type: 'text' })).toBe('checklist')
    expect(pickerControlFor({ key: 'properties.property_address_city', type: 'text' })).toBe('checklist')
    expect(pickerControlFor({ key: 'properties.property_address_zip', type: 'text' })).toBe('checklist')
    expect(pickerControlFor({ key: 'facts.property_type_class', type: 'enum' })).toBe('checklist')
    expect(pickerControlFor({ key: 'properties.flags', type: 'flags' })).toBe('checklist')
    expect(pickerControlFor({ key: 'properties.estimated_value', type: 'number' })).toBe('range')
    expect(pickerControlFor({ key: 'properties.sale_date', type: 'date' })).toBe('range')
    expect(pickerControlFor({ key: 'properties.tax_delinquent', type: 'boolean' })).toBe('boolean')
    expect(pickerControlFor({ key: 'facts.owner_name', type: 'enum' })).toBe('text')
    expect(pickerControlFor({ key: 'facts.property_address_full', type: 'text' })).toBe('text')
    expect(pickerControlFor({ key: 'properties.property_id', type: 'text' })).toBe('text')
    expect(pickerKindFor({ type: 'enum', fact_kind: 'numeric' } as never)).toBe('numeric')
  })

  it('checklist → is_any_of; exclude → is_not_any_of; flags stack (all of) — only where the field allows', () => {
    const f = { key: 'properties.zoning', operators: TEXT_OPS }
    expect(pickerFilterFromSelection(f, 'categorical', { values: ['R1', 'R2'] })).toEqual({ field_key: 'properties.zoning', operator: 'is_any_of', value: ['R1', 'R2'] })
    expect(pickerFilterFromSelection(f, 'categorical', { values: ['R1'] }, 'not')).toEqual({ field_key: 'properties.zoning', operator: 'is_not_any_of', value: ['R1'] })
    expect(pickerFilterFromSelection(f, 'categorical', { values: [null] })).toEqual({ field_key: 'properties.zoning', operator: 'is_empty' })
    expect(pickerFilterFromSelection(f, 'categorical', { values: [] })).toBeNull()
    const flags = { key: 'properties.flags', operators: FLAG_OPS }
    expect(pickerFilterFromSelection(flags, 'tokens', { values: ['Vacant Home', 'Probate'] }, 'all')).toEqual({ field_key: 'properties.flags', operator: 'is_all_of', value: ['Vacant Home', 'Probate'] })
    expect(pickerFilterFromSelection(flags, 'tokens', { values: ['Vacant Home'] }, 'not')).toEqual({ field_key: 'properties.flags', operator: 'is_any_of', value: ['Vacant Home'] })
    expect(checklistModes(flags)).toEqual(['any', 'all'])
    expect(checklistModes(f)).toEqual(['any', 'not'])
    expect(checklistModeOf({ field_key: 'x', operator: 'is_not_any_of', value: ['a'] })).toBe('not')
    expect(pickerSelectionFromFilter({ field_key: 'x', operator: 'is_all_of', value: ['a', 'b'] }, 'tokens')).toEqual({ values: ['a', 'b'] })
    expect(pickerSelectionFromFilter({ field_key: 'x', operator: 'is_not_any_of', value: ['a'] }, 'categorical')).toEqual({ values: ['a'] })
  })

  it('range → between / gte / lte / presence; booleans → is_true / is_false / is_empty', () => {
    const n = { key: 'properties.estimated_value', operators: NUM_OPS }
    expect(pickerFilterFromSelection(n, 'numeric', { from: '100000', to: '250000' })).toEqual({ field_key: n.key, operator: 'between', value: [100000, 250000] })
    expect(pickerFilterFromSelection(n, 'numeric', { from: '100000' })).toEqual({ field_key: n.key, operator: 'gte', value: 100000 })
    expect(pickerFilterFromSelection(n, 'numeric', { presence: 'none' })).toEqual({ field_key: n.key, operator: 'is_empty' })
    expect(pickerSelectionProblem(n, 'numeric', { from: '9', to: '1' })).toBe('“From” is after “To”')
    const b = { key: 'properties.tax_delinquent', operators: BOOL_OPS }
    expect(pickerFilterFromSelection(b, 'boolean', { values: ['true'] })).toEqual({ field_key: b.key, operator: 'is_true' })
    expect(pickerFilterFromSelection(b, 'boolean', { values: ['false'] })).toEqual({ field_key: b.key, operator: 'is_false' })
  })

  it('free text writes contains (names / addresses / ids only)', () => {
    expect(textFilterFrom({ key: 'facts.owner_name', operators: TEXT_OPS }, '  Smith ')).toEqual({ field_key: 'facts.owner_name', operator: 'contains', value: 'Smith' })
    expect(textFilterFrom({ key: 'facts.owner_name', operators: TEXT_OPS }, '   ')).toBeNull()
  })

  it('a folded option selects / clears all its spellings together; "No value" stands alone', () => {
    const opt = { value: 'Multi-Family', count: 10, variants: ['Multi-Family', 'Multi-family'] }
    expect(optionMembers(opt)).toEqual(['Multi-Family', 'Multi-family'])
    expect(optionMembers({ value: 'Duplex', count: 1 })).toEqual(['Duplex'])
    const on = toggleMembers(['Duplex'], optionMembers(opt))
    expect(on).toEqual(['Duplex', 'Multi-Family', 'Multi-family'])
    expect(optionSelected(on, optionMembers(opt))).toBe(true)
    expect(optionSelected(['Multi-Family'], optionMembers(opt))).toBe(false)
    expect(toggleMembers(on, optionMembers(opt))).toEqual(['Duplex'])
    expect(toggleMembers(['Duplex'], [null])).toEqual([null])
    expect(toggleMembers([null], ['Duplex'])).toEqual(['Duplex'])
  })

  it('vendor line-type codes read as words', () => {
    expect(headerValueLabel('contact_line_type', 'W', 'categorical')).toBe('Wireless')
    expect(headerValueLabel('phone_type', 'L', 'categorical')).toBe('Landline')
    expect(headerValueLabel('zoning', 'W', 'categorical')).toBe('W')
  })

  it('histogram bars scale to the tallest bucket; compact numbers', () => {
    const bars = histogramBars([{ lo: 0, hi: 1, count: 5 }, { lo: 1, hi: 2, count: 10 }, { lo: 2, hi: 9, count: 1, tail: 'above' }])
    expect(bars.map((b) => b.share)).toEqual([0.5, 1, 0.1])
    expect(histogramBars(null)).toEqual([])
    expect(compactNumber(452000)).toBe('452K')
    expect(compactNumber(1250000)).toBe('1.3M')
    expect(compactNumber(1250)).toBe('1,250')
    expect(compactNumber(12.345)).toBe('12.35')
  })

  it('the rail Asset group offers the canonical type first, the vendor raw strings separately', () => {
    const asset = (DESK_FACET_GROUPS.properties ?? []).find((g) => g.id === 'asset')
    expect(asset?.facets.map((f) => f.fieldKey)).toEqual(['facts.property_type_class', 'facts.property_type_group', 'facts.property_use_raw', 'properties.property_type'])
    expect(asset?.facets[0].label).toBe('Property type')
    expect(asset?.facets[3].label).toBe('Property type (vendor raw)')
  })
})
