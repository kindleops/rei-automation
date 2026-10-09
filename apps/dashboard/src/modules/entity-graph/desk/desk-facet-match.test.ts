import { describe, expect, it } from 'vitest'
import { fieldFiltersToApiParams } from '../../../domain/entity-graph/entity-graph-workspace-state'
import { DESK_DISTRESS_FACETS, facetCountFilters, facetMatch, facetValues, setFacetMatch, toggleFacetValue } from './desk-model'

/**
 * P0 2026-10-09 — property flags STACK (owner: "when I click multiple property
 * flags it doesn't add them … it's all the same amount"). The flags facet
 * defaults to "all of"; an all/any toggle switches it.
 */
const F = 'properties.flags'
const market = { field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX'] }

describe('flags facet: match all (default) / any', () => {
  it('the property flags facet stacks by default', () => {
    expect(DESK_DISTRESS_FACETS.find((f) => f.fieldKey === F)?.match).toBe('all')
  })

  it('clicking several flags builds ONE is_all_of filter carrying every flag', () => {
    let filters = toggleFacetValue([market], F, 'Tax Delinquent', 'all')
    filters = toggleFacetValue(filters, F, 'Absentee Owner', 'all')
    expect(filters).toEqual([market, { field_key: F, operator: 'is_all_of', value: ['Tax Delinquent', 'Absentee Owner'] }])
    expect(facetValues(filters, F)).toEqual(['Tax Delinquent', 'Absentee Owner'])
    expect(JSON.parse(fieldFiltersToApiParams(filters).field_filters!)).toEqual(filters)
  })

  it('switching to any of keeps the values and changes only the operator; toggling keeps the mode', () => {
    const all = toggleFacetValue(toggleFacetValue([], F, 'Vacant Home', 'all'), F, 'Probate', 'all')
    const any = setFacetMatch(all, F, 'any')
    expect(any).toEqual([{ field_key: F, operator: 'is_any_of', value: ['Vacant Home', 'Probate'] }])
    expect(facetMatch(any, F, 'all')).toBe('any')
    // an active filter's operator wins over the facet default
    expect(toggleFacetValue(any, F, 'Tax Delinquent', 'all')[0].operator).toBe('is_any_of')
    // removing the last value removes the filter
    expect(toggleFacetValue(toggleFacetValue(any, F, 'Vacant Home'), F, 'Probate')).toEqual([])
  })

  it('all-of counts are computed WITH the selection (each = the cohort if added); any-of without it', () => {
    const all = [market, { field_key: F, operator: 'is_all_of', value: ['Tax Delinquent'] }]
    expect(facetCountFilters(all, F, 'all')).toEqual(all)
    const any = setFacetMatch(all, F, 'any')
    expect(facetCountFilters(any, F, 'all')).toEqual([market])
  })

  it('other facets keep any-of', () => {
    const f = toggleFacetValue(toggleFacetValue([], 'properties.building_condition', 'Poor'), 'properties.building_condition', 'Unsound')
    expect(f).toEqual([{ field_key: 'properties.building_condition', operator: 'is_any_of', value: ['Poor', 'Unsound'] }])
  })
})
