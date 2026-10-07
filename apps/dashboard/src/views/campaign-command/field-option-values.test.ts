import { describe, expect, it } from 'vitest'
import { describeOptionCounts, normalizeFieldOptionValues } from './field-option-values'

const fmt = (n: number) => n.toLocaleString('en-US')

describe('normalizeFieldOptionValues', () => {
  it('keeps both counts on every option', () => {
    const result = normalizeFieldOptionValues({
      options: [{ value: 'Vacant Home', label: 'Vacant Home', count: 7814, queueable_count: 3740 }],
      values_state: 'ok',
      values_source: 'facet_snapshot',
    })
    expect(result.state).toBe('ok')
    expect(result.options).toEqual([{ value: 'Vacant Home', label: 'Vacant Home', count: 7814, eligibleCount: 3740 }])
    expect(result.source).toBe('facet_snapshot')
    expect(result.message).toBeNull()
  })

  it('a field the audience never counted says so instead of "No values found"', () => {
    const result = normalizeFieldOptionValues({ options: [], values_state: 'not_counted', values_message: 'Not counted yet.' })
    expect(result.state).toBe('not_counted')
    expect(result.message).toBe('Not counted yet.')
  })

  it('an older API with an empty list reads as not counted; an empty search as no match', () => {
    expect(normalizeFieldOptionValues({ ok: true, options: [] }).state).toBe('not_counted')
    expect(normalizeFieldOptionValues({ ok: true, options: [] }, 'zzz').state).toBe('no_match')
  })

  it('options win over a stale state flag', () => {
    expect(normalizeFieldOptionValues({ options: [{ value: 'Good' }], values_state: 'not_counted' }).state).toBe('ok')
  })
})

describe('describeOptionCounts', () => {
  it('names both numbers', () => {
    expect(describeOptionCounts({ count: 7814, eligibleCount: 3740 }, fmt)).toBe('7,814 properties · 3,740 eligible')
    expect(describeOptionCounts({ count: 1 }, fmt)).toBe('1 property')
    expect(describeOptionCounts({}, fmt)).toBeNull()
  })
})

describe('FieldValuePicker', () => {
  it('two picked values read "2 selected" with their counts, each checked', async () => {
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { FieldValuePicker } = await import('./FieldValuePicker')
    const { toggleOptionValue } = await import('./field-option-values')
    const options = [
      { value: 'Structural', label: 'Structural', count: 66033, eligibleCount: 30000 },
      { value: 'Full Rehab', label: 'Full Rehab', count: 50207, eligibleCount: 25000 },
      { value: 'Moderate', label: 'Moderate', count: 5490 },
    ]
    let selected: string[] = []
    selected = toggleOptionValue(selected, 'Structural')
    selected = toggleOptionValue(selected, 'Full Rehab')
    expect(selected).toEqual(['Structural', 'Full Rehab'])
    const html = renderToStaticMarkup(React.createElement(FieldValuePicker, {
      fieldLabel: 'Rehab Level', options, selected, search: '', onSearch: () => {}, onChange: () => {}, format: fmt,
    }))
    expect(html).toContain('2 selected · up to 116,240 properties · 55,000 eligible')
    expect(html.match(/aria-checked="true"/g)?.length).toBe(2)
    expect(html).toContain('66,033 properties · 30,000 eligible')
    expect(html).not.toContain('<select')
    expect(toggleOptionValue(selected, 'Structural')).toEqual(['Full Rehab'])
  })

  it('an uncounted field explains itself and offers typed entry', async () => {
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { FieldValuePicker } = await import('./FieldValuePicker')
    const html = renderToStaticMarkup(React.createElement(FieldValuePicker, {
      fieldLabel: 'Building Condition', options: [], selected: ['Poor'], state: 'not_counted',
      message: 'Values for this field haven’t been counted for the campaign audience yet. You can still type a value.',
      search: '', onSearch: () => {}, onChange: () => {}, format: fmt,
    }))
    expect(html).toContain('haven’t been counted')
    expect(html).not.toContain('No values found')
    expect(html).toContain('Type an exact value')
    expect(html).toContain('aria-checked="true"') // the typed "Poor" stays visible and removable
  })
})
