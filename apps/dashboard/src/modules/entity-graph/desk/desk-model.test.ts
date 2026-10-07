import { describe, expect, it } from 'vitest'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'
import {
  anchorForResult,
  facetValues,
  filtersExcept,
  headerSortIsLocal,
  kpiTiles,
  makeView,
  matchingTagTone,
  nodeAnchor,
  readViews,
  serverSortFor,
  toggleFacetValue,
  writeViews,
} from './desk-model'
import { IDENTITY_COLUMN_KEY } from '../mobile/entity-graph-table-layout'
import { PROPERTY_CLUSTER_ID } from '../console/network-layout'
import { equityLabel, sortLoadedRows, SCOPE_TABLE_COLUMNS } from '../mobile/entity-graph-table-columns'

const row = (over: Partial<EntitySearchResult>): EntitySearchResult => ({ entityType: 'property', entityId: '1', title: 't', badges: [], linkedCounts: {}, ...over })

describe('anchorForResult — the network a row opens', () => {
  it('maps the three anchor types and resolves companies / contacts through their owner', () => {
    expect(anchorForResult(row({ entityType: 'property', entityId: '239234454' }))).toEqual({ type: 'property', id: '239234454' })
    expect(anchorForResult(row({ entityType: 'master_owner', entityId: 'mo_1' }))).toEqual({ type: 'owner', id: 'mo_1' })
    expect(anchorForResult(row({ entityType: 'prospect', entityId: 'pros_1' }))).toEqual({ type: 'person', id: 'pros_1' })
    expect(anchorForResult(row({ entityType: 'organization', entityId: 'sub_1', contextIds: { masterOwnerId: 'mo_9' } }))).toEqual({ type: 'owner', id: 'mo_9' })
    expect(anchorForResult(row({ entityType: 'phone', entityId: 'ph_1', contextIds: { prospectId: 'pros_2' } }))).toEqual({ type: 'person', id: 'pros_2' })
    expect(anchorForResult(row({ entityType: 'organization', entityId: 'sub_2', contextIds: {} }))).toBeNull()
  })
})

describe('serverSortFor — whole-cohort order only where the server can give it', () => {
  it('a header column with a backend sort column orders the cohort', () => {
    expect(serverSortFor('properties', { key: 'value', dir: 'desc' }, false)).toEqual({ sortBy: 'estimated_value', ascending: false, source: 'header' })
    expect(serverSortFor('properties', { key: IDENTITY_COLUMN_KEY, dir: 'asc' }, false)).toEqual({ sortBy: 'property_address_full', ascending: true, source: 'header' })
    expect(headerSortIsLocal('properties', { key: 'value', dir: 'desc' }, false)).toBe(false)
  })
  it('a display-only column, or any column while searching, sorts the loaded rows over the default order', () => {
    expect(serverSortFor('properties', { key: 'lender', dir: 'asc' }, false).source).toBe('default')
    expect(headerSortIsLocal('properties', { key: 'lender', dir: 'asc' }, false)).toBe(true)
    expect(headerSortIsLocal('properties', { key: 'value', dir: 'asc' }, true)).toBe(true)
    expect(serverSortFor('properties', null, false)).toEqual({ sortBy: 'estimated_value', ascending: false, source: 'default' })
  })
})

describe('kpiTiles — honest header numbers', () => {
  it('states coverage as a share of the universe and never invents a missing count', () => {
    const t = kpiTiles({ properties: 176610, linkedProperties: 41533, owners: 102252, portfolioOwners: 11363, entities: 96103, ownersWithPhone: 83521 })
    expect(t.map((x) => x.key)).toEqual(['universe', 'owners', 'entities', 'stacks', 'contactable', 'coverage'])
    expect(t.find((x) => x.key === 'coverage')!.value).toBe(23.5)
    expect(t.find((x) => x.key === 'contactable')!.basis).toMatch(/81\.7%/)
    const partial = kpiTiles({ properties: 176610, owners: 102252, entities: 96103, linkedProperties: null, portfolioOwners: null, ownersWithPhone: null })
    expect(partial.find((x) => x.key === 'stacks')!.value).toBeNull()
    expect(partial.find((x) => x.key === 'coverage')!.value).toBeNull()
    expect(kpiTiles(null).every((x) => x.value === null)).toBe(true)
  })
})

describe('facets', () => {
  it('toggle values into one is_any_of per field and count without their own selection', () => {
    let f = toggleFacetValue([], 'properties.market', 'Atlanta, GA')
    f = toggleFacetValue(f, 'properties.market', 'Miami, FL')
    f = [...f, { field_key: 'records.has_probate', operator: 'is_true' }]
    expect(facetValues(f, 'properties.market')).toEqual(['Atlanta, GA', 'Miami, FL'])
    expect(filtersExcept(f, 'properties.market')).toEqual([{ field_key: 'records.has_probate', operator: 'is_true' }])
    f = toggleFacetValue(toggleFacetValue(f, 'properties.market', 'Atlanta, GA'), 'properties.market', 'Miami, FL')
    expect(f).toEqual([{ field_key: 'records.has_probate', operator: 'is_true' }])
  })
})

describe('saved views', () => {
  it('store the definition per operator and drop malformed entries', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) } }
    const v = makeView({ name: '  Atlanta probate ', scope: 'properties', query: '', fieldFilters: [{ field_key: 'records.has_probate', operator: 'is_true' }], sort: { key: 'value', dir: 'desc' }, columns: null }, 1_700_000_000_000)
    expect(v.name).toBe('Atlanta probate')
    writeViews('u1', [v, { id: 'x', name: 'bad', scope: 'nope' } as never], storage)
    expect(readViews('u1', storage).map((x) => x.id)).toEqual([v.id])
    expect(readViews('u2', storage)).toEqual([])
  })
})

describe('graph + tags', () => {
  it('only owners, properties and people open a network; the cluster does not', () => {
    expect(nodeAnchor({ id: 'related:mo_5', type: 'related_owner', label: '', meta: {} })).toEqual({ type: 'owner', id: 'mo_5' })
    expect(nodeAnchor({ id: 'phone:9', type: 'phone', label: '', meta: {} })).toBeNull()
    expect(nodeAnchor({ id: PROPERTY_CLUSTER_ID, type: 'property', label: '+4', meta: {} })).toBeNull()
  })
  it('matching tags colour as evidence, a renter tag as attention', () => {
    expect(matchingTagTone('Likely Owner')).toBe('ok')
    expect(matchingTagTone('Likely Renting')).toBe('attn')
    expect(matchingTagTone('Family')).toBe('neutral')
  })
})

describe('equity column — equity_known_v1', () => {
  const r = (details: EntitySearchResult['details']) => row({ entityId: String(Math.random()), details })
  it('never shows a vendor 100% for a property with no loan on file', () => {
    expect(equityLabel(r({ equity: null, equityRule: 'unknown' }))).toBe('Unknown')
    expect(equityLabel(r({ equity: 100 }))).toBe('Unknown')
    expect(equityLabel(r({ equity: 100, equityRule: 'free_and_clear' }))).toBe('Free & clear')
    expect(equityLabel(r({ equity: null, equityRule: 'vendor_high_equity_flag', equityClass: 'high' }))).toBe('High (flag)')
    expect(equityLabel(r({ equity: 62.4, equityRule: 'loan_and_value' }))).toBe('62%')
  })
  it('has no server sort (equity_percent orders unknowns first) and sorts unknown last', () => {
    const col = SCOPE_TABLE_COLUMNS.properties.find((c) => c.key === 'equity')!
    expect(col.sortBy).toBeUndefined()
    expect(serverSortFor('properties', { key: 'equity', dir: 'desc' }, false).source).toBe('default')
    const rows = [r({ equity: null, equityRule: 'unknown' }), r({ equity: 20, equityRule: 'loan_and_value' }), r({ equity: 100, equityRule: 'free_and_clear' })]
    const desc = sortLoadedRows('properties', rows, col, 'desc').map((x) => equityLabel(x))
    expect(desc).toEqual(['Free & clear', '20%', 'Unknown'])
    const asc = sortLoadedRows('properties', rows, col, 'asc').map((x) => equityLabel(x))
    expect(asc).toEqual(['20%', 'Free & clear', 'Unknown'])
  })
})
