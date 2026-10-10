/**
 * EG 8.6 · the Overview is the landing view of every scope.
 *   - the view is remembered PER SCOPE (localStorage), Overview the first time;
 *     an explicit ?egv= in the address wins
 *   - every scope has its sections; ordered bands chart as histograms
 *   - motion helpers: count-up lands exactly on the value; stagger is capped
 *   - a distress × market cell = that market's chip + that signal's chip
 *   - campaign → EG link: one chip, the exact campaign id, Overview first
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DESK_STATE, deskSearch, initialDeskState, readViewByScope, viewForScope, writeViewByScope } from '../desk-state'
import { chartForm, countUpAt, matrixCellFilters, overviewSectionsForScope, staggerDelay, applyBucketClick } from './overview-model'
import { campaignIdsInFilters, campaignScopeFilter, entityGraphCampaignPath, CAMPAIGN_MEMBERSHIP_KEY } from '../../../../domain/entity-graph/entity-graph-campaign-link'
import { parseFieldFiltersParam } from '../../../../domain/entity-graph/entity-graph-field-filters'

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }
const CID = '9799d345-06c7-46d8-9b4d-db8b8a4e2bdc'

describe('the landing view', () => {
  it('defaults to Overview for every scope, and remembers the last view per scope', () => {
    expect(DEFAULT_DESK_STATE.center).toBe('overview')
    const store = memory()
    expect(viewForScope(readViewByScope('u1', store), 'people')).toBe('overview')
    writeViewByScope('u1', { properties: 'grid', buyers: 'graph' }, store)
    const views = readViewByScope('u1', store)
    expect(viewForScope(views, 'properties')).toBe('grid')
    expect(viewForScope(views, 'buyers')).toBe('graph')
    expect(viewForScope(views, 'master_owners')).toBe('overview')
    // another operator keeps their own
    expect(readViewByScope('u2', store)).toEqual({})
  })
  it('an explicit ?egv= wins; without it the scope’s remembered view; the URL omits the default', () => {
    const views = { properties: 'grid' as const }
    expect(initialDeskState(new URLSearchParams('ff=[]&egv=overview'), {}, views).center).toBe('overview')
    expect(initialDeskState(new URLSearchParams('ff=[]'), {}, views).center).toBe('grid')
    expect(initialDeskState(new URLSearchParams('egs=people'), {}, views).center).toBe('overview')
    expect(initialDeskState(new URLSearchParams(''), {}, views).center).toBe('grid')
    expect(deskSearch('', { ...DEFAULT_DESK_STATE })).toBe('')
    expect(deskSearch('', { ...DEFAULT_DESK_STATE, center: 'grid' })).toBe('?egv=grid')
  })
})

describe('every scope charts', () => {
  it('has sections for properties, owners, people, contacts, buyers and companies', () => {
    for (const scope of ['properties', 'master_owners', 'people', 'contact_methods', 'buyers', 'organizations']) {
      expect(overviewSectionsForScope(scope).length, scope).toBeGreaterThan(0)
    }
    expect(overviewSectionsForScope('people').map((s) => s.id)).toContain('wealth')
  })
  it('ordered bands (numbers, dates, money-range text) are histograms; values are bars', () => {
    const f = (kind: string) => chartForm({ key: 'k', label: 'k', kind: kind as never, section: 's' })
    expect(f('banded_text')).toBe('histogram')
    expect(f('derived_number')).toBe('histogram')
    expect(f('date')).toBe('histogram')
    expect(f('derived_categorical')).toBe('bars')
    expect(f('categorical')).toBe('bars')
    expect(f('boolean')).toBe('split')
  })
})

describe('motion', () => {
  it('a count-up starts at its origin and lands exactly on the value', () => {
    expect(countUpAt(0, 2689, 0)).toBe(0)
    expect(countUpAt(0, 2689, 1)).toBe(2689)
    expect(countUpAt(100, 146, 2)).toBe(146)
    const mid = countUpAt(0, 1000, 0.5)
    expect(mid).toBeGreaterThan(500) // ease-out: past half way at half time
    expect(Number.isInteger(mid)).toBe(true)
  })
  it('the stagger is capped so a long section never lags', () => {
    expect(staggerDelay(0)).toBe(0)
    expect(staggerDelay(3)).toBe(84)
    expect(staggerDelay(400)).toBe(420)
  })
})

describe('distress × market', () => {
  it('a cell replaces the market chip and adds the signal chip; other chips stay', () => {
    const base = [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Dallas, TX'] }, { field_key: 'properties.year_built', operator: 'gte', value: 1950 }]
    const next = matrixCellFilters(base, { field_key: 'properties.market', operator: 'is_any_of', value: ['Houston, TX'] }, { field_key: 'records.has_probate', operator: 'is_true', value: null })
    expect(next).toEqual([
      { field_key: 'properties.year_built', operator: 'gte', value: 1950 },
      { field_key: 'properties.market', operator: 'is_any_of', value: ['Houston, TX'] },
      { field_key: 'records.has_probate', operator: 'is_true', value: null },
    ])
  })
  it('the click → filter round trip: a bar applied twice is the same cohort', () => {
    const chip = { field_key: 'prospects.age_years', operator: 'between', value: [65, 74] }
    const once = applyBucketClick([], chip).filters
    expect(applyBucketClick(once, chip).filters).toEqual(once)
  })
})

describe('campaign → Entity Graph', () => {
  it('opens Overview on exactly that campaign (one chip, the campaign id)', () => {
    const path = entityGraphCampaignPath(CID.toUpperCase())
    const qs = new URLSearchParams(path.split('?')[1])
    expect(path.startsWith('/entity-graph?')).toBe(true)
    expect(qs.get('egv')).toBe('overview')
    const ff = parseFieldFiltersParam(qs.get('ff'))
    expect(ff).toEqual([campaignScopeFilter(CID)])
    expect(ff[0].field_key).toBe(CAMPAIGN_MEMBERSHIP_KEY)
    expect(campaignIdsInFilters(ff)).toEqual([CID])
    // the desk starts on that scope, Overview, with the chip
    const state = initialDeskState(qs, {}, { properties: 'grid' })
    expect(state.center).toBe('overview')
    expect(state.filtersByScope.properties).toEqual(ff)
  })
  it('refuses a non-id', () => {
    expect(() => entityGraphCampaignPath('drop table')).toThrow()
    expect(campaignIdsInFilters([{ field_key: CAMPAIGN_MEMBERSHIP_KEY, operator: 'is_any_of', value: ['nope'] }])).toEqual([])
  })
})
