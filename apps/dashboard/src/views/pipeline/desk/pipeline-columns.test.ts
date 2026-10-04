import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/api/backendClient', () => ({ callBackend: vi.fn() }))

import { COLUMN_BY_ID, COLUMN_GROUPS, DEFAULT_COLUMNS, DESK_COLUMNS, formatValue, matchesColumn, moveColumn, neededFields, normalizeLayout, sortKey, toggleColumn, words, type RowContext } from './pipeline-columns'
import { __enrichmentTest, plan } from './use-pipeline-enrichment'
import type { DeskCard } from './pipeline-desk-api'

const card = (over: Partial<DeskCard> = {}) => ({ id: 'O1', propertyId: 'P1', masterOwnerId: 'M1', threadKey: 'T1', money: {}, lane: { label: 'x' }, owner: 'seller', ...over } as unknown as DeskCard)
const ctx = (c: DeskCard, x: RowContext['x'] = {}): RowContext => ({ card: c, x, offer: null, now: Date.parse('2026-10-04T12:00:00Z') })

describe('column catalog', () => {
  it('ids are unique, every group is used, every enrichment field is source.column', () => {
    expect(new Set(DESK_COLUMNS.map((c) => c.id)).size).toBe(DESK_COLUMNS.length)
    for (const g of COLUMN_GROUPS) expect(DESK_COLUMNS.some((c) => c.group === g.id)).toBe(true)
    for (const c of DESK_COLUMNS) if (c.needs) expect(c.needs).toMatch(/^(property|owner|scores)\.[a-z0-9_]+$/)
  })
  it('the owner asked for: last message, last seller intent, next scheduled, property type, property fields', () => {
    for (const id of ['last_msg', 'intent', 'next_send', 'ptype', 'p_beds', 'p_year', 's_tier', 'o_language', 'p_phone_type']) expect(COLUMN_BY_ID.has(id)).toBe(true)
  })
  it('defaults are the table it replaced', () => {
    expect(DEFAULT_COLUMNS).toEqual(['deal', 'stage', 'owner', 'why', 'age', 'value', 'ask'])
  })
})

describe('layout', () => {
  it('drops unknown ids and duplicates, keeps Deal first', () => {
    expect(normalizeLayout({ visible: ['stage', 'nope', 'stage', 'p_year'] }).visible).toEqual(['deal', 'stage', 'p_year'])
    expect(normalizeLayout(null).visible).toEqual([...DEFAULT_COLUMNS])
  })
  it('toggle and move; Deal never hides or moves', () => {
    let l = normalizeLayout({ visible: ['deal', 'stage', 'owner'] })
    l = toggleColumn(l, 'p_year')
    expect(l.visible).toEqual(['deal', 'stage', 'owner', 'p_year'])
    expect(toggleColumn(l, 'deal')).toBe(l)
    expect(moveColumn(l, 'p_year', -1).visible).toEqual(['deal', 'stage', 'p_year', 'owner'])
    expect(moveColumn(l, 'stage', -1)).toBe(l)
  })
  it('only visible columns ask for enrichment', () => {
    expect(neededFields(['deal', 'p_year', 'p_beds', 's_tier', 'o_language', 'last_msg'])).toEqual({ property: ['year_built', 'total_bedrooms'], owner: ['best_language'], scores: ['decision_tier'] })
    expect(neededFields(DEFAULT_COLUMNS)).toEqual({ property: [], owner: [], scores: [] })
  })
  it('search matches header, group and source', () => {
    expect(matchesColumn(COLUMN_BY_ID.get('p_year')!, 'year')).toBe(true)
    expect(matchesColumn(COLUMN_BY_ID.get('p_year')!, 'property record')).toBe(true)
    expect(matchesColumn(COLUMN_BY_ID.get('p_year')!, 'intent')).toBe(false)
  })
})

describe('values are never fabricated', () => {
  it('absent is null, not 0', () => {
    for (const k of ['money', 'int', 'num', 'pct', 'score', 'bool', 'rel', 'date', 'enum', 'text'] as const) expect(formatValue(k, null, 0)).toBeNull()
    expect(formatValue('int', '', 0)).toBeNull()
    expect(formatValue('int', 0, 0)).toBe('0') // a recorded 0 is shown as recorded
    expect(formatValue('pct', '71.00', 0)).toBe('71%')
    expect(formatValue('bool', false, 0)).toBe('No')
  })
  it('enumerations read as words', () => {
    expect(words('NEEDS_REPLY')).toBe('Needs reply')
  })
  it('an extended column on an older API build is empty', () => {
    expect(COLUMN_BY_ID.get('unread')!.value(ctx(card()))).toBeNull()
  })
  it('phone type and language: Unknown when absent, decoded when present', () => {
    expect(COLUMN_BY_ID.get('p_phone_type')!.emptyText).toBe('Unknown')
    expect(COLUMN_BY_ID.get('o_language')!.emptyText).toBe('Unknown')
    expect(COLUMN_BY_ID.get('p_phone_type')!.value(ctx(card(), { property: { phone_type: 'W' } }))).toBe('Wireless')
  })
  it('empty sorts as null', () => {
    expect(sortKey('money', null)).toBeNull()
    expect(sortKey('date', '2026-10-01T00:00:00Z')).toBe(Date.parse('2026-10-01T00:00:00Z'))
  })
})

describe('enrichment plan', () => {
  it('requests only uncached (id, column) pairs, de-duplicated', () => {
    __enrichmentTest.reset()
    const rows = [card(), card({ id: 'O2' }), card({ id: 'O3', propertyId: 'P3', masterOwnerId: null })]
    const need = { property: ['year_built'], owner: [], scores: ['decision_tier'] }
    let p = plan(rows, need, 1000)
    expect(p.property.ids).toEqual(['P1', 'P3'])
    expect(p.owner.ids).toEqual([])
    __enrichmentTest.store('property', ['P1', 'P3'], ['year_built'], { P1: { year_built: 1950 } }, 1000)
    p = plan(rows, need, 2000)
    expect(p.property.ids).toEqual([])
    expect(p.scores.ids).toEqual(['P1', 'P3'])
    // a new column re-requests
    expect(plan(rows, { ...need, property: ['year_built', 'total_baths'] }, 2000).property.ids).toEqual(['P1', 'P3'])
  })
})
