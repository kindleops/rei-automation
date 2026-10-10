/**
 * P0 2026-10-10 — HOT LEADS: 2,010 Entity Graph pinned ids became 183 on one
 * Composer save. The Composer restored a session snapshot taken after the first
 * stack (183 ids) and its autosave wrote that snapshot's whole target_filters.
 *
 * The pinned selection must round-trip the Composer losslessly at any size,
 * a stale snapshot must never shrink the server's set, only an operator's
 * removal may, and the chip states a count — never thousands of ids.
 */
import { describe, expect, it } from 'vitest'
import {
  clausesFromTargetFilters, compositionKey, compositionPayload, emptyComposition, pinnedIdsOf, reconcilePinned, removedPinnedIds,
  serializeClauses, withFilters, PINNED_FIELD, type Composition, type FilterClause,
} from './composer-model'
import { clauseValueText } from './composer-format'
import { SPEC_URL_MAX, specReadRequest } from './composer-api'

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => String(210000000 + from + i))

/** The exact shape the Entity Graph stacked_explicit hand-off persists. */
const stackedFilters = (list: string[]) => ({
  catalog_version: 'locked_approved_campaign_fields_v1',
  filter_mode: 'grouped_source_of_truth_domains',
  properties: [{ field_key: PINNED_FIELD, operator: 'is_any_of', value: list, domain: 'properties', category: 'Identity' }],
})

const composed = (list: string[], extra: Partial<Composition> = {}): Composition => ({
  ...emptyComposition(),
  name: 'HOT LEADS',
  filters: clausesFromTargetFilters(stackedFilters(list)),
  ...extra,
})

describe('pinned selection round-trips the Composer losslessly', () => {
  for (const n of [183, 2010, 10_000, 25_000]) {
    it(`${n.toLocaleString('en-US')} ids: load → serialize → save payload keeps every id in order`, () => {
      const list = ids(n)
      const c = composed(list)
      expect(pinnedIdsOf(c.filters)).toEqual(list)
      const payload = compositionPayload(c)
      const out = payload.target_filters.properties[0]
      expect(out.field_key).toBe(PINNED_FIELD)
      expect(out.value).toEqual(list)
      // a second load of what was saved is the same set
      expect(pinnedIdsOf(clausesFromTargetFilters(payload.target_filters))).toEqual(list)
      expect(payload).not.toHaveProperty('remove_property_ids')
    })
  }

  it('JSON (the wire and sessionStorage) keeps 10,000 ids', () => {
    const list = ids(10_000)
    const back = JSON.parse(JSON.stringify(compositionPayload(composed(list))))
    expect(back.target_filters.properties[0].value).toHaveLength(10_000)
    expect(serializeClauses(composed(list).filters).properties[0].value).toEqual(list)
  })
})

describe('a stale snapshot never shrinks the server’s pinned set', () => {
  it('the HOT LEADS case: a 183-id session restored over a 2,010-id draft keeps all 2,010', () => {
    const server = composed(ids(2010))
    const stale = composed(ids(183), { daily_cap: '500' })
    const merged = reconcilePinned(stale, server)
    expect(pinnedIdsOf(merged.filters)).toHaveLength(2010)
    expect(new Set(pinnedIdsOf(merged.filters))).toEqual(new Set(ids(2010)))
    expect(merged.daily_cap).toBe('500') // the session's other edits survive
    expect(compositionPayload(merged)).not.toHaveProperty('remove_property_ids')
  })

  it('ids dropped in locally are kept alongside the server set', () => {
    const server = composed(ids(10_000))
    const local = composed([...ids(100), 'dropped-1', 'dropped-2'])
    expect(pinnedIdsOf(reconcilePinned(local, server).filters)).toHaveLength(10_002)
  })

  it('a pinned set only on the server is restored into a local composition that has none', () => {
    const merged = reconcilePinned({ ...emptyComposition(), name: 'x' }, composed(ids(50)))
    expect(pinnedIdsOf(merged.filters)).toEqual(ids(50))
  })

  it('other clauses keep their place', () => {
    const market: FilterClause = { id: 'm', domain: 'properties', category: 'Location & Market', fieldKey: 'properties.market', label: 'Market', operator: 'is_any_of', value: ['Dallas, TX'] }
    const local = { ...composed(ids(3)), filters: [market, ...composed(ids(3)).filters] }
    const merged = reconcilePinned(local, composed(ids(9)))
    expect(merged.filters.map((f) => f.fieldKey)).toEqual(['properties.market', PINNED_FIELD])
  })
})

describe('only the operator removes pinned ids — and the save says so', () => {
  it('removing the pinned chip records every removed id and the payload names them', () => {
    const list = ids(10_000)
    const c = composed(list)
    const next = withFilters(c, [])
    expect(next.removed_property_ids).toHaveLength(10_000)
    expect(removedPinnedIds(c.filters, [])).toEqual(list)
    const payload = compositionPayload(next)
    expect(payload.remove_property_ids).toEqual(list)
  })

  it('a removal is reconciled away from the server set, and is not part of the autosave key', () => {
    const c = withFilters(composed(ids(10)), [])
    const merged = reconcilePinned(c, composed(ids(10)))
    expect(pinnedIdsOf(merged.filters)).toEqual([])
    expect(compositionKey(c)).toBe(compositionKey({ ...c, removed_property_ids: [] }))
  })

  it('re-pinning a removed id cancels its removal', () => {
    const c = withFilters(composed(ids(3)), [])
    const again = withFilters(c, composed(ids(1)).filters)
    expect(again.removed_property_ids).toEqual(ids(3).slice(1))
  })

  it('a non-pinned edit removes nothing', () => {
    const c = composed(ids(2010))
    const market: FilterClause = { id: 'm', domain: 'properties', category: 'Location & Market', fieldKey: 'properties.market', label: 'Market', operator: 'is_any_of', value: ['Dallas, TX'] }
    expect(withFilters(c, [...c.filters, market]).removed_property_ids).toEqual([])
  })
})

describe('the pinned chip is a count', () => {
  it('"N properties pinned from Entity Graph" — never the ids', () => {
    const clause = composed(ids(2010)).filters[0]
    expect(clauseValueText(clause, 'Entity Graph')).toBe('2,010 properties pinned from Entity Graph')
    expect(clauseValueText(composed(ids(1)).filters[0], 'Entity Graph')).toBe('1 property pinned from Entity Graph')
    expect(clauseValueText(clause)).toBe('2,010 properties pinned')
    expect(clauseValueText(clause)).not.toContain(ids(1)[0])
  })
})

describe('a large spec is read by POST, never trimmed into a URL', () => {
  it('small specs stay GET; 10,000 ids go as POST { action: "read" } with every id', () => {
    const small = specReadRequest('audience', { filters: serializeClauses(composed(ids(5)).filters) })
    expect(small.method).toBe('GET')
    const big = specReadRequest('audience', { filters: serializeClauses(composed(ids(10_000)).filters) })
    expect(big.method).toBe('POST')
    if (big.method !== 'POST') throw new Error('expected POST')
    expect(big.path.length).toBeLessThan(SPEC_URL_MAX)
    const body = JSON.parse(big.body)
    expect(body.action).toBe('read')
    expect(body.part).toBe('audience')
    expect(body.spec.filters.properties[0].value).toHaveLength(10_000)
  })
})
