/**
 * EG · the Overview PAGE (owner 2026-10-12). Registry + drill-down + state:
 *   - the page is its own top-level tab, the landing view of a fresh visit
 *     (`egs=overview`), and a scope's address never lands on it
 *   - its global filters persist in the address and the session
 *   - a click opens that scope's grid with global ∧ chip (one chip per field)
 *   - every card is on the page, in order; the as-of is always stated
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DESK_STATE, deskSearch, initialDeskState, readSessionDeskState, writeSessionDeskState } from '../desk-state'
import {
  CARD_SCOPE,
  UNIVERSE_CARD_ORDER,
  UNIVERSE_PAGE_SCOPES,
  asOfText,
  chartMax,
  drillTarget,
  orderCards,
  toggleGlobal,
  universeHeadline,
  universeQuery,
  type UniverseCard,
} from './universe-model'

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }
const card = (over: Partial<UniverseCard> = {}): UniverseCard => ({ id: 'properties', scope: 'properties', label: 'Properties', total: 10, kpis: [], charts: [], applied: [], ignored: [], source: 'facts', as_of: '2026-10-11T04:24:04.500Z', ...over })

describe('the Overview page is a top-level page and the landing view', () => {
  it('a fresh visit (no desk address, no session) lands on it; the session remembers leaving it', () => {
    expect(initialDeskState(new URLSearchParams(''), {}, {}).home).toBe(true)
    expect(initialDeskState(new URLSearchParams(''), { home: false }, {}).home).toBe(false)
    expect(initialDeskState(new URLSearchParams('egs=overview'), { home: false }, {}).home).toBe(true)
  })
  it('a scope address never lands on the page', () => {
    expect(initialDeskState(new URLSearchParams('egs=people'), {}, {}).home).toBe(false)
    expect(initialDeskState(new URLSearchParams('egv=grid'), {}, {}).home).toBe(false)
    expect(initialDeskState(new URLSearchParams('ff=[]'), { home: true }, {}).home).toBe(false)
  })
  it('the page address carries its global filters (JSON — market names carry commas) and round-trips', () => {
    const state = { ...DEFAULT_DESK_STATE, home: true, universe: { markets: ['Miami, FL', 'Dallas, TX'], states: ['FL'] } }
    const qs = deskSearch('?foo=1', state)
    const params = new URLSearchParams(qs.slice(1))
    expect(params.get('egs')).toBe('overview')
    expect(params.get('foo')).toBe('1')
    expect(JSON.parse(params.get('egm')!)).toEqual(['Miami, FL', 'Dallas, TX'])
    const back = initialDeskState(params, {}, {})
    expect(back.home).toBe(true)
    expect(back.universe).toEqual({ markets: ['Miami, FL', 'Dallas, TX'], states: ['FL'] })
    // a scope state written over it drops the page's params
    const scoped = new URLSearchParams(deskSearch(qs, { ...state, home: false, scope: 'people' }).slice(1))
    expect(scoped.get('egs')).toBe('people')
    expect(scoped.has('egm')).toBe(false)
  })
  it('the session keeps home + globals (sanitized)', () => {
    const store = memory()
    writeSessionDeskState({ ...DEFAULT_DESK_STATE, home: true, universe: { markets: ['Miami, FL'], states: ['fl'] } }, store)
    expect(readSessionDeskState(store)).toMatchObject({ home: true, universe: { markets: ['Miami, FL'], states: ['FL'] } })
  })
})

describe('drill-down', () => {
  it('a bucket opens its scope with the global filters AND the bucket chip', () => {
    const c = card({ applied: [{ field_key: 'properties.property_address_state', operator: 'is_any_of', value: ['FL'] }] })
    const t = drillTarget(c, { field_key: 'facts.asset_type', operator: 'is_any_of', value: ['SFR'] })
    expect(t.scope).toBe('properties')
    expect(t.filters).toEqual([
      { field_key: 'properties.property_address_state', operator: 'is_any_of', value: ['FL'] },
      { field_key: 'facts.asset_type', operator: 'is_any_of', value: ['SFR'] },
    ])
  })
  it('a chip on a field the globals already narrow replaces that global (one chip per field, same cohort)', () => {
    const c = card({ applied: [{ field_key: 'properties.market', operator: 'is_any_of', value: ['Miami, FL', 'Dallas, TX'] }] })
    expect(drillTarget(c, { field_key: 'properties.market', operator: 'is_any_of', value: ['Miami, FL'] }).filters).toEqual([{ field_key: 'properties.market', operator: 'is_any_of', value: ['Miami, FL'] }])
  })
  it('no chip (the total / Open grid) is the globals alone; another scope gets only its own applied globals', () => {
    expect(drillTarget(card({ applied: [] }), null).filters).toEqual([])
    const buyers = card({ id: 'buyers', scope: 'buyers', applied: [{ field_key: 'buyers.states', operator: 'is_any_of', value: ['FL'] }] })
    expect(drillTarget(buyers, { field_key: 'buyers.activity_status', operator: 'is_any_of', value: ['active'] })).toEqual({ scope: 'buyers', filters: [{ field_key: 'buyers.states', operator: 'is_any_of', value: ['FL'] }, { field_key: 'buyers.activity_status', operator: 'is_any_of', value: ['active'] }] })
  })
})

describe('registry + request', () => {
  it('every table is on the page, in order; the properties request answers three cards', () => {
    expect(UNIVERSE_PAGE_SCOPES).toEqual(['properties', 'master_owners', 'people', 'contact_methods', 'buyers', 'organizations'])
    expect([...UNIVERSE_CARD_ORDER]).toEqual(['properties', 'pipeline', 'contacts', 'master_owners', 'people', 'contact_methods', 'buyers', 'organizations'])
    expect(UNIVERSE_CARD_ORDER.filter((id) => CARD_SCOPE[id] === 'properties')).toEqual(['properties', 'pipeline', 'contacts'])
    const ordered = orderCards({ properties: [card(), card({ id: 'pipeline' })] })
    expect(ordered.map((o) => o.id)).toEqual([...UNIVERSE_CARD_ORDER])
    expect(ordered.find((o) => o.id === 'contacts')!.card).toBeNull()
    expect(universeHeadline({ properties: [card({ total: 176603 })] })[0]).toEqual({ id: 'properties', label: 'Properties', value: 176603 })
  })
  it('the query carries lists as JSON; toggling adds and removes; states are upper-cased', () => {
    const qs = new URLSearchParams(universeQuery('people', { markets: ['Miami, FL'], states: [] }))
    expect(qs.get('scope')).toBe('people')
    expect(JSON.parse(qs.get('markets')!)).toEqual(['Miami, FL'])
    expect(qs.has('states')).toBe(false)
    const g = toggleGlobal({ markets: [], states: [] }, 'states', 'tx')
    expect(g.states).toEqual(['TX'])
    expect(toggleGlobal(g, 'states', 'TX').states).toEqual([])
  })
  it('the as-of always names its source and time; context buckets never stretch the scale', () => {
    const now = new Date('2026-10-12T04:24:04.500Z').getTime()
    expect(asOfText('facts', '2026-10-11T04:24:04.500Z', now)).toMatch(/As of .*\(24 h ago\) · property facts read model/)
    expect(asOfText('snapshot', '2026-10-12T04:14:04.500Z', now)).toMatch(/10 min ago\) · universe snapshot/)
    expect(asOfText('live', null, now)).toMatch(/time not recorded · computed live/)
    expect(chartMax([{ key: 'a', label: 'a', count: 10, filter: null }, { key: '__none', label: 'n', count: 500, filter: null, tone: 'none' }])).toBe(10)
  })
})
