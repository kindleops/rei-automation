import { describe, expect, it } from 'vitest'
import type { EntityGraphFilterCatalog } from '../../../domain/entity-graph/entity-graph-field-filters'
import { SCOPE_TABLE_COLUMNS, PROPERTY_COLUMN_FACTS, factColumnForField } from '../mobile/entity-graph-table-columns'
import { serverSortFor } from './desk-model'
import {
  activeHeaderFilter,
  headerFieldKeyFor,
  headerFilterFromSelection,
  headerSelectionProblem,
  headerValueLabel,
  replaceFieldFilter,
  selectionFromFilter,
} from './desk-header-filter'

const ops = (...keys: string[]) => keys.map((key) => ({ key, label: key }))
const field = (key: string, source_column: string, operators: string[], extra: Record<string, unknown> = {}) => ({
  key, source_column, operators: ops(...operators), domain: key.split('.')[0], category: 'x', label: key, source_table_or_view: 'properties', type: 'text', ...extra,
})
const catalog = {
  tab: 'properties', source: 'properties', total_fields: 6, filterable_tabs: [],
  groups: [
    { id: 'a', label: 'A', fields: [
      field('properties.flags', 'property_flags_text', ['is_any_of']),
      field('properties.known_equity_percent', 'known_equity_percent', ['gte'], { derived: 'known_equity' }),
      field('properties.year_built', 'year_built', ['gte', 'lte', 'between', 'is_empty', 'is_not_empty']),
      field('records.mortgage_count', 'rec_mortgage_count', ['gte', 'lte', 'between']),
      field('facts.sms_status', 'sms_status', ['contains', 'is_any_of', 'is_not_any_of', 'is_empty', 'is_not_empty']),
      field('facts.year_built', 'year_built', ['gte']),
    ] },
  ],
} as unknown as EntityGraphFilterCatalog

describe('header filter field — the same rule as the server (catalog first, derived / token fields skipped)', () => {
  it('resolves the catalogued field for a plain column, the fact field for a computed one', () => {
    expect(headerFieldKeyFor(catalog, 'year_built')).toBe('properties.year_built')
    expect(headerFieldKeyFor(catalog, 'rec_mortgage_count')).toBe('records.mortgage_count')
    expect(headerFieldKeyFor(catalog, 'sms_status')).toBe('facts.sms_status')
    expect(headerFieldKeyFor(catalog, 'property_flags_text')).toBeNull()
    expect(headerFieldKeyFor(null, 'year_built')).toBeNull()
  })
})

describe('header selection → ONE chip in the rail AST', () => {
  const sms = { key: 'facts.sms_status', operators: ops('is_any_of', 'is_empty', 'contains') }
  it('a checklist is is_any_of; only "No value" is is_empty; mixing them is refused', () => {
    expect(headerFilterFromSelection(sms, 'categorical', { values: ['eligible', 'missing_phone'] })).toEqual({ field_key: 'facts.sms_status', operator: 'is_any_of', value: ['eligible', 'missing_phone'] })
    expect(headerFilterFromSelection(sms, 'categorical', { values: [null] })).toEqual({ field_key: 'facts.sms_status', operator: 'is_empty' })
    expect(headerSelectionProblem(sms, 'categorical', { values: ['eligible', null] })).toMatch(/cannot be combined/)
    expect(headerFilterFromSelection(sms, 'categorical', { values: ['eligible', null] })).toBeNull()
    expect(headerFilterFromSelection(sms, 'categorical', { values: [], contains: ' phone ' })).toEqual({ field_key: 'facts.sms_status', operator: 'contains', value: 'phone' })
  })
  it('booleans: Yes / No / No value, one at a time', () => {
    const b = { key: 'facts.sms_eligible', operators: ops('is_true', 'is_false') }
    expect(headerFilterFromSelection(b, 'boolean', { values: ['true'] })).toEqual({ field_key: 'facts.sms_eligible', operator: 'is_true' })
    expect(headerFilterFromSelection(b, 'boolean', { values: ['false'] })).toEqual({ field_key: 'facts.sms_eligible', operator: 'is_false' })
    expect(headerSelectionProblem(b, 'boolean', { values: ['true', 'false'] })).toMatch(/Pick one/)
  })
  it('ranges: between, at least / at most (dates: on or after / before), presence', () => {
    const n = { key: 'properties.year_built', operators: ops('gte', 'lte', 'between', 'is_empty', 'is_not_empty') }
    expect(headerFilterFromSelection(n, 'numeric', { from: '1950', to: '1980' })).toEqual({ field_key: 'properties.year_built', operator: 'between', value: [1950, 1980] })
    expect(headerFilterFromSelection(n, 'numeric', { from: '1950' })).toEqual({ field_key: 'properties.year_built', operator: 'gte', value: 1950 })
    expect(headerFilterFromSelection(n, 'numeric', { to: '1980' })).toEqual({ field_key: 'properties.year_built', operator: 'lte', value: 1980 })
    expect(headerFilterFromSelection(n, 'numeric', { presence: 'none' })).toEqual({ field_key: 'properties.year_built', operator: 'is_empty' })
    expect(headerSelectionProblem(n, 'numeric', { from: '1990', to: '1980' })).toMatch(/after/)
    const d = { key: 'facts.last_contact_at', operators: ops('on_or_after', 'on_or_before', 'between') }
    expect(headerFilterFromSelection(d, 'date', { from: '2026-09-01' })).toEqual({ field_key: 'facts.last_contact_at', operator: 'on_or_after', value: '2026-09-01' })
  })
  it('round trip: an applied chip pre-ticks the menu, and replacing keeps every other chip in place', () => {
    const filters = [
      { field_key: 'properties.market', operator: 'is_any_of', value: ['Atlanta, GA'] },
      { field_key: 'facts.sms_status', operator: 'is_any_of', value: ['eligible'] },
      { field_key: 'records.has_lien', operator: 'is_true' },
    ]
    const chip = activeHeaderFilter(filters, 'facts.sms_status')
    expect(selectionFromFilter(chip, 'categorical')).toEqual({ values: ['eligible'] })
    const next = headerFilterFromSelection(sms, 'categorical', { values: ['eligible', 'pending_prior_touch'] })
    expect(replaceFieldFilter(filters, 'facts.sms_status', next)).toEqual([
      filters[0],
      { field_key: 'facts.sms_status', operator: 'is_any_of', value: ['eligible', 'pending_prior_touch'] },
      filters[2],
    ])
    expect(replaceFieldFilter(filters, 'facts.sms_status', null)).toEqual([filters[0], filters[2]])
    expect(selectionFromFilter({ field_key: 'x', operator: 'between', value: [1, 2] }, 'numeric')).toEqual({ from: '1', to: '2' })
  })
  it('labels codes in words, keeps the raw value for the filter', () => {
    expect(headerValueLabel('sms_status', 'eligible', 'categorical')).toBe('Eligible')
    expect(headerValueLabel('sms_status', 'missing_phone', 'categorical')).toBe('No phone')
    expect(headerValueLabel('company_status_class', 'terminated_cancelled', 'categorical')).toBe('Terminated / cancelled')
    expect(headerValueLabel('sms_eligible', 'true', 'boolean')).toBe('Yes')
    expect(headerValueLabel('market', null, 'categorical')).toBe('No value')
  })
})

describe('every property column sorts the whole cohort on its facts column — never "not sortable"', () => {
  it('each property column has a server sort key', () => {
    const missing = SCOPE_TABLE_COLUMNS.properties.filter((c) => !c.sortBy).map((c) => c.key)
    expect(missing).toEqual([])
  })
  it('the computed columns sort / filter where the owner expects', () => {
    const col = (k: string) => SCOPE_TABLE_COLUMNS.properties.find((c) => c.key === k)!
    expect(col('smsEligible').sortBy).toBe('sms_sort')
    expect(col('smsEligible').filterColumn).toBe('sms_status')
    expect(col('lastContact').sortBy).toBe('last_contact_at')
    expect(col('flags').filterColumn).toBe('signal_labels')
    expect(col('companyStatus').sortBy).toBe('company_status_class')
    expect(col('rec.first_loan_type').sortBy).toBe('rec_first_loan_type')
    expect(col('owner.priority_score').sortBy).toBe('owner_priority_score')
    expect(col('fact.company_jurisdiction').sortBy).toBe('company_jurisdiction')
    expect(col('equity_percent').sortBy).toBe('equity_known_pct')
    expect(factColumnForField('zip.median_price')).toBe('zip_median_price')
    expect(Object.keys(PROPERTY_COLUMN_FACTS)).toContain('smsEligible')
  })
  it('a header sort on SMS eligible reaches the server as a whole-cohort sort', () => {
    expect(serverSortFor('properties', { key: 'smsEligible', dir: 'asc' }, false)).toEqual({ sortBy: 'sms_sort', ascending: true, source: 'header' })
    expect(serverSortFor('properties', { key: 'smsEligible', dir: 'asc' }, true).source).toBe('default')
  })
})
