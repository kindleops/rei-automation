import { describe, expect, it } from 'vitest'
import { DEFAULT_DESK_STATE, deskSearch, initialDeskState, readSessionDeskState, withViewFilters, writeSessionDeskState, type DeskState } from './desk-state'
import { reorderColumnIds } from '../../../shared/lc/DataGrid'
import { deskFacetFields, deskPresets, DESK_DISTRESS_TOGGLES, DESK_FACET_GROUPS } from './desk-model'
import { PRESETS } from '../mobile/entity-graph-presets'
import { lastContactLabel, smsLabel, smsReasonLabel } from './desk-outreach'
import { SCOPE_TABLE_COLUMNS, smsBlockLabel } from '../mobile/entity-graph-table-columns'
import type { EntitySearchResult } from '../../../domain/entity-graph/entity-graph.types'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
}
const ff = [{ field_key: 'properties.flags', operator: 'is_any_of', value: ['Vacant Home'] }]

describe('desk state persistence (filters survive a property click, Graph, fullscreen, reload)', () => {
  it('round-trips through the URL, keeping every other param', () => {
    const state: DeskState = { ...DEFAULT_DESK_STATE, filtersByScope: { properties: ff }, center: 'graph', graphFull: true, query: '' }
    const search = deskSearch('?buyer=b1', state)
    const params = new URLSearchParams(search.slice(1))
    expect(params.get('buyer')).toBe('b1')
    expect(params.get('egv')).toBe('graph')
    expect(params.get('egfs')).toBe('1')
    const back = initialDeskState(params, {})
    expect(back.filtersByScope.properties).toEqual(ff)
    expect(back.center).toBe('graph')
    expect(back.graphFull).toBe(true)
  })

  it('a path change (property click) keeps the search, so the remount reads the same filters', () => {
    const search = deskSearch('', { ...DEFAULT_DESK_STATE, filtersByScope: { properties: ff } })
    // /entity-graph → /entity-graph/property/123 preserves search params
    expect(initialDeskState(new URLSearchParams(search.slice(1)), {}).filtersByScope.properties).toEqual(ff)
  })

  it('without desk params the session restores every scope’s filters', () => {
    const store = memory()
    const people = [{ field_key: 'prospects.age_years', operator: 'gte', value: 65 }]
    writeSessionDeskState({ ...DEFAULT_DESK_STATE, scope: 'people', filtersByScope: { properties: ff, people } }, store)
    const restored = initialDeskState(new URLSearchParams(''), readSessionDeskState(store))
    expect(restored.scope).toBe('people')
    expect(restored.filtersByScope.properties).toEqual(ff)
    expect(restored.filtersByScope.people).toEqual(people)
  })

  it('the URL wins for its scope, the session supplies the others', () => {
    const store = memory()
    writeSessionDeskState({ ...DEFAULT_DESK_STATE, filtersByScope: { people: [{ field_key: 'prospects.gender', operator: 'is_any_of', value: ['F'] }] } }, store)
    const s = initialDeskState(new URLSearchParams(`ff=${encodeURIComponent(JSON.stringify(ff))}`), readSessionDeskState(store))
    expect(s.filtersByScope.properties).toEqual(ff)
    expect(s.filtersByScope.people?.[0].field_key).toBe('prospects.gender')
  })

  it('a corrupt session is ignored, never thrown', () => {
    expect(readSessionDeskState({ getItem: () => '{not json' })).toEqual({})
  })
})

describe('column reorder', () => {
  it('moves a column before a left target and after a right one', () => {
    expect(reorderColumnIds(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(reorderColumnIds(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderColumnIds(['a', 'b'], 'x', 'a')).toEqual(['a', 'b'])
  })
})

describe('rail groups', () => {
  it('People, Owners and Contacts have facet groups and quick filters', () => {
    expect(deskFacetFields('people').length).toBeGreaterThanOrEqual(10)
    expect(deskFacetFields('master_owners').length).toBeGreaterThanOrEqual(3)
    expect(deskFacetFields('contact_methods').length).toBeGreaterThanOrEqual(3)
    expect(deskPresets('people').flatMap((g) => g.presets).some((p) => p.filter.field_key === 'prospects.age_years')).toBe(true)
    expect(deskPresets('master_owners').length).toBeGreaterThan(0)
  })
  it('every facet field belongs to its scope’s domain', () => {
    const prefix: Record<string, RegExp> = { properties: /^(properties|records)\./, people: /^prospects\./, master_owners: /^master_owners\./, contact_methods: /^phones\./, buyers: /^buyers\./ }
    for (const [scope, groups] of Object.entries(DESK_FACET_GROUPS)) {
      for (const f of (groups ?? []).flatMap((g) => g.facets)) expect(f.fieldKey).toMatch(prefix[scope])
    }
  })
  it('the Equity 60%+ preset filters KNOWN equity, not the vendor 100%', () => {
    const preset = deskPresets('properties').flatMap((g) => g.presets).find((p) => p.key === 'equity60')
    expect(preset?.filter.field_key).toBe('properties.known_equity_percent')
  })
})

describe('outreach wording', () => {
  const row = (outreach: unknown) => ({ entityType: 'property', entityId: '1', title: 'x', linkedCounts: {}, contextIds: {}, details: { outreach } }) as unknown as EntitySearchResult
  it('SMS eligible says yes, or no + the builder’s reason', () => {
    expect(smsLabel({ eligible: true, reason: null, rows: 1, ready: 1, source: 'g', reviewChecked: true })).toBe('Yes')
    expect(smsReasonLabel('entity_contact_requires_review')).toBe('Entity contact needs review')
    expect(smsBlockLabel('non_sms_capable')).toBe('No SMS line')
    const col = SCOPE_TABLE_COLUMNS.properties.find((c) => c.key === 'smsEligible')!
    expect(col.render(row({ sms: { eligible: false, reason: 'missing_phone' } }))).toBe('No · No phone')
    expect(col.render(row(undefined))).toBeNull()
  })
  it('last contact is date · direction · channel', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')
    expect(lastContactLabel({ at: '2026-10-08T09:00:00Z', direction: 'inbound', channel: 'sms', source: 'inbox' }, now)).toBe('Today · In · SMS')
    expect(lastContactLabel(null)).toBeNull()
  })
})

describe('contact discovery wording', () => {
  it('a graph gap with linked-prospect phones is not shown as plain "No phone"', () => {
    const col = SCOPE_TABLE_COLUMNS.properties.find((c) => c.key === 'smsEligible')!
    const r = { entityType: 'property', entityId: '1', title: 'x', linkedCounts: {}, contextIds: {}, details: { outreach: { sms: { eligible: false, reason: 'missing_phone' }, contactCandidates: { people: 1, phones: 2, unresolved: 1, candidates: [] } } } } as unknown as EntitySearchResult
    expect(col.render(r)).toBe('No · 2 phone candidates, not in graph · unresolved')
  })
})

describe('saved views land on their own scope', () => {
  it('a Properties view opened from People puts its filters on Properties and leaves People alone', () => {
    const people = [{ field_key: 'prospects.age_years', operator: 'gte', value: 65 }]
    const view = { scope: 'properties' as const, fieldFilters: [{ field_key: 'records.has_probate', operator: 'is_true' }] }
    const next = withViewFilters({ people }, view)
    expect(next.properties).toEqual(view.fieldFilters)
    expect(next.people).toEqual(people)
  })
})

describe('rail presets read the corrected fields', () => {
  it('tax delinquent reads either vendor source; a recorded lien is its own toggle', () => {
    const tax = PRESETS.properties!.flatMap((g) => g.presets).find((p) => p.key === 'taxdel')!
    expect(tax.filter.field_key).toBe('properties.tax_delinquent_any')
    expect(DESK_DISTRESS_TOGGLES.map((t) => t.filter.field_key)).toEqual(expect.arrayContaining(['properties.tax_delinquent_any', 'records.has_lien', 'properties.active_lien']))
    expect(DESK_DISTRESS_TOGGLES.find((t) => t.filter.field_key === 'properties.active_lien')!.label).toMatch(/vendor/i)
  })
})
