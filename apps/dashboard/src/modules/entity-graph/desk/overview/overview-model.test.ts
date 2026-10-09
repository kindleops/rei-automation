import { describe, expect, it } from 'vitest'
import { applyBucketClick, barScale, bucketActive, bucketExcluded, bucketsCsv, chartForm, clickModeFromEvent, fmtShare, fmtValue } from './overview-model'
import { fieldFiltersToApiParams } from '../../../../domain/entity-graph/entity-graph-workspace-state'
import { overviewQuery } from './overview-api'
import type { OverviewField } from './overview-types'

const market = (v: string) => ({ field_key: 'properties.market', operator: 'is_any_of', value: [v] })
const flag = (v: string) => ({ field_key: 'properties.flags', operator: 'is_all_of', value: [v] })
const band = { field_key: 'properties.estimated_value', operator: 'between', value: [100000, 249999.99] }

describe('Overview click → the rail filter AST', () => {
  it('click makes the bucket the field chip, keeping every other field', () => {
    const start = [market('Dallas, TX'), band]
    const r = applyBucketClick(start, market('Atlanta, GA'))
    expect(r.applied).toBe(true)
    expect(r.filters).toEqual([band, market('Atlanta, GA')])
  })
  it('shift-click adds to the same field set; a flag stays "has all of"', () => {
    const r1 = applyBucketClick([market('Dallas, TX')], market('Atlanta, GA'), 'add')
    expect(r1.filters).toEqual([{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX', 'Atlanta, GA'] }])
    const r2 = applyBucketClick([flag('Vacant Home')], flag('Tax Delinquent'), 'add')
    expect(r2.filters).toEqual([{ field_key: 'properties.flags', operator: 'is_all_of', value: ['Vacant Home', 'Tax Delinquent'] }])
  })
  it('alt-click excludes a categorical value and drops the matching include', () => {
    const r = applyBucketClick([market('Dallas, TX')], market('Dallas, TX'), 'exclude')
    expect(r.filters).toEqual([{ field_key: 'properties.market', operator: 'is_not_any_of', value: ['Dallas, TX'] }])
    expect(bucketExcluded(r.filters, market('Dallas, TX'))).toBe(true)
    expect(applyBucketClick([], band, 'exclude').applied).toBe(false)
  })
  it('a range never unions: shift-click on a band replaces the band', () => {
    const other = { ...band, value: [250000, 349999.99] }
    expect(applyBucketClick([band], other, 'add').filters).toEqual([other])
  })
  it('a bucket without its own filter never edits the cohort', () => {
    const start = [market('Dallas, TX')]
    expect(applyBucketClick(start, null)).toEqual({ filters: start, applied: false, reason: expect.any(String) })
  })
  it('active state reads the chip back (value inside a set chip counts)', () => {
    const f = [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX', 'Atlanta, GA'] }, band]
    expect(bucketActive(f, market('Atlanta, GA'))).toBe(true)
    expect(bucketActive(f, market('Miami, FL'))).toBe(false)
    expect(bucketActive(f, band)).toBe(true)
  })
  it('round trip: the request the Overview sends carries exactly the filter list the grid sends', () => {
    const r = applyBucketClick([market('Dallas, TX')], flag('Vacant Home'))
    const qs = new URLSearchParams(overviewQuery(r.filters, ['pinned', 'headline']))
    expect(qs.get('field_filters')).toBe(fieldFiltersToApiParams(r.filters).field_filters)
    expect(JSON.parse(qs.get('field_filters') || '[]')).toEqual(r.filters)
    expect(qs.get('sections')).toBe('pinned,headline')
  })
  it('modifier keys pick the mode', () => {
    expect(clickModeFromEvent({})).toBe('replace')
    expect(clickModeFromEvent({ shiftKey: true })).toBe('add')
    expect(clickModeFromEvent({ altKey: true, shiftKey: true })).toBe('exclude')
  })
})

describe('Overview formatting & geometry', () => {
  const field: OverviewField = {
    key: 'properties.property_type', label: 'Property type', kind: 'categorical', section: 'property',
    coverage: { known: 90, total: 100, share: 0.9 },
    buckets: [
      { key: 'SFR', label: 'Single Family', count: 60, filter: null, tone: 'value' },
      { key: '__other', label: 'Everything else', count: 30, filter: null, tone: 'other' },
      { key: '__none', label: 'Not recorded', count: 10, filter: null, tone: 'none' },
    ],
  }
  it('"Not recorded" and the remainder never set the bar scale', () => {
    expect(barScale(field.buckets!)).toBe(60)
  })
  it('chart form follows the field kind', () => {
    expect(chartForm(field)).toBe('bars')
    expect(chartForm({ ...field, kind: 'numeric' })).toBe('histogram')
    expect(chartForm({ ...field, kind: 'derived_boolean' })).toBe('split')
    expect(chartForm({ ...field, kind: 'coverage' })).toBe('coverage')
  })
  it('CSV carries bucket, exact count and share', () => {
    expect(bucketsCsv(field).split('\n')).toEqual(['bucket,count,share', 'Single Family,60,0.600000', 'Everything else,30,0.300000', 'Not recorded,10,0.100000'])
  })
  it('formats', () => {
    expect(fmtValue(235000, 'money')).toBe('$235K')
    expect(fmtValue(1250000, 'money')).toBe('$1.25M')
    expect(fmtValue(5.87, 'percent')).toBe('5.9%')
    expect(fmtShare(1, 300)).toBe('0.33%')
    expect(fmtShare(0, 300)).toBe('0%')
  })
})
