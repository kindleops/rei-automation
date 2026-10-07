import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { coverageWarning, describeFilterCondition, type FilterEffects } from './filter-effects'
import { FilterEffectsList } from './FilterEffectsPanel'

const fmt = (n: number) => n.toLocaleString('en-US')

const RESULT: FilterEffects = {
  ok: true,
  base_count: 176605,
  universe_count: 12000,
  final_count: 900,
  final_eligible: 410,
  effects: [
    { field_key: 'properties.market', label: 'Market', operator: 'is_any_of', value: ['Dallas, TX'], stage: 'location', count_after: 12000, removed: 164605, eligible_after: 6100, coverage: { with_value: 176597, of: 176605, pct: 100 }, failed: false },
    { field_key: 'properties.building_condition', label: 'Building Condition', operator: 'is_any_of', value: ['Poor', 'Unsound'], stage: 'targeting', count_after: 900, removed: 11100, eligible_after: 410, coverage: { with_value: 3240, of: 12000, pct: 27 }, failed: false },
  ],
  refused: [{ field_key: 'properties.zoning', label: 'Zoning', operator: 'is_any_of', reason: 'not_in_audience', message: 'Not applied: This field isn’t part of the campaign audience data, so it can’t narrow a campaign.' }],
  warnings: [],
}

describe('filter effects', () => {
  it('describes conditions in words', () => {
    expect(describeFilterCondition({ field_key: 'x', operator: 'is_any_of', value: ['Poor', 'Unsound'] })).toBe('is Poor, Unsound')
    expect(describeFilterCondition({ field_key: 'x', operator: 'between', value: ['1950', '1980'] })).toBe('between 1950 – 1980')
    expect(describeFilterCondition({ field_key: 'x', operator: 'within', value: null })).toBe('inside the drawn area')
  })

  it('a low-coverage filter says its cut is missing data', () => {
    const warn = coverageWarning(RESULT.effects[1], fmt)
    expect(warn).toContain('Only 27%')
    expect(warn).toContain('8,760 properties have none')
    expect(coverageWarning(RESULT.effects[0], fmt)).toBeNull()
  })

  it('lists every applied filter with its effect and every refused filter by name', () => {
    const html = renderToStaticMarkup(React.createElement(FilterEffectsList, { result: RESULT, format: fmt }))
    expect(html).toContain('−164,605')
    expect(html).toContain('410 eligible')
    expect(html).toContain('27% of 12,000 have a value')
    expect(html).toContain('<strong>Zoning</strong> can’t be applied')
  })

  it('a failed read says so', () => {
    const html = renderToStaticMarkup(React.createElement(FilterEffectsList, { result: { ok: false, message: 'timeout' }, format: fmt }))
    expect(html).toContain('Per-filter counts unavailable — timeout')
  })
})
