import { describe, expect, it } from 'vitest'
import demo from '../mobile/closing-demo.generated.json'
import type { Closing } from '../mobile/closing-execution-api'
import { groupRows, links, matchesFilter, matchesQuery, reasonFacts, relativeMoment, resolveCaseParam, sortRows, stateWord, toRow, whenFact } from './desk-model'

const file = demo as unknown as { now: string; portfolio: { items: Closing[] } }
const NOW = Date.parse(file.now)
const rows = file.portfolio.items.map(toRow)
const byAddress = (line: string) => rows.find((r) => r.property.line === line)!

describe('closing desk — desktop arrangement over the server derivation', () => {
  it('groups follow the server group, in the canonical order, only when non-empty', () => {
    const groups = groupRows(sortRows(rows, 'most_urgent'))
    expect(groups.map((g) => g.key)).toEqual(['needs_you', 'closing_today', 'closing_soon', 'waiting_seller', 'waiting_buyer', 'waiting_title', 'system_handling', 'closed', 'cancelled'])
    for (const g of groups) for (const r of g.rows) expect(r.group).toBe(g.key)
  })

  it('rows read like the brief: ready vs blocked', () => {
    const ready = byAddress('1204 Penn Ave N')
    expect(stateWord(ready)).toBe('READY TO CLOSE')
    expect(whenFact(ready, NOW)).toMatch(/^Today · 2:00 PM CT · 2h 14m$/)
    expect(reasonFacts(ready, NOW)).toEqual(['Title clear to close'])
    const blocked = byAddress('3847 Bloomington Ave')
    expect(stateWord(blocked)).toBe('BLOCKED')
    expect(whenFact(blocked, NOW)).toBe('Closing tomorrow')
    expect(reasonFacts(blocked, NOW)).toEqual(['Buyer EMD overdue · $5,000', 'Title commitment late'])
  })

  it('system handling names the follow-up, its moment and nothing else', () => {
    const sys = byAddress('2718 Emerson Ave S')
    expect(stateWord(sys)).toBe('SYSTEM HANDLING')
    expect(reasonFacts(sys, NOW)[0]).toBe('Title commitment follow-up #2 · tonight 10:47 PM CT')
  })

  it('closed and cancelled rows carry their history, never execution chrome', () => {
    const settled = byAddress('5021 34th Ave S')
    expect(stateWord(settled)).toBe('CLOSED')
    expect(reasonFacts(settled, NOW)).toEqual(['Net $17,480'])
    const bare = byAddress('4127 Upton Ave S')
    expect(stateWord(bare)).toBe('CLOSED · NO SETTLEMENT RECORD')
    expect(reasonFacts(bare, NOW)).toEqual(['Settlement record unavailable'])
    const cancelled = byAddress('1719 E 38th St')
    expect(stateWord(cancelled)).toBe('CANCELLED')
    expect(reasonFacts(cancelled, NOW)[0]).toMatch(/probate/)
  })

  it('search covers address, seller, buyer, title company, file number, closing id and market', () => {
    const r = byAddress('2718 Emerson Ave S')
    for (const q of ['emerson', 'loretta', 'cobalt', 'westline', 'WT-26-11842', r.id, 'minneapolis']) expect(matchesQuery(r, q)).toBe(true)
    expect(matchesQuery(r, 'lyndale')).toBe(false)
  })

  it('filters are the server groups — never a client re-derivation', () => {
    expect(rows.filter((r) => matchesFilter(r, 'needs_you')).length).toBe(rows.filter((r) => r.group === 'needs_you').length)
    expect(rows.filter((r) => matchesFilter(r, 'system')).every((r) => r.ball?.owner === 'system')).toBe(true)
    expect(rows.filter((r) => matchesFilter(r, 'cancelled')).every((r) => r.terminal)).toBe(true)
  })

  it('date-only moments read as days; instants keep their clock time in the property zone', () => {
    expect(relativeMoment('2026-09-29T00:00:00.000Z', 'America/Chicago', NOW, true)).toBe('yesterday')
    expect(relativeMoment('2026-10-01T00:00:00.000Z', 'America/Chicago', NOW, false)).toBe('tonight 7:00 PM CT')
    expect(relativeMoment('2026-10-01T19:00:00.000Z', 'America/Chicago', NOW)).toBe('tomorrow 2:00 PM CT')
  })

  it('deep links resolve to the canonical closing id — from ?case=, an opportunity id, ?opp= or ?property_id=', () => {
    const r = byAddress('1204 Penn Ave N')
    expect(resolveCaseParam(new URLSearchParams(`case=${encodeURIComponent(r.id)}`), rows)).toBe(r.id)
    expect(resolveCaseParam(new URLSearchParams(`case=${r.opportunityId}`), rows)).toBe(r.id)
    expect(resolveCaseParam(new URLSearchParams(`opp=${r.opportunityId}`), rows)).toBe(r.id)
    expect(resolveCaseParam(new URLSearchParams(`property_id=${r.propertyId}`), rows)).toBe(r.id)
    // An id outside the loaded window still opens by id (the room loads it).
    expect(resolveCaseParam(new URLSearchParams('case=closing:11111111-1111-4111-8111-111111111111'), rows)).toBe('closing:11111111-1111-4111-8111-111111111111')
    expect(resolveCaseParam(new URLSearchParams('case=11111111-1111-4111-8111-111111111111'), rows)).toBe('closing:11111111-1111-4111-8111-111111111111')
    expect(resolveCaseParam(new URLSearchParams(''), rows)).toBeNull()
    expect(links.room(r.id, 'automation')).toBe(`/closing-desk?case=${encodeURIComponent(r.id)}&section=automation`)
    expect(links.workflowRun(r.id)).toBe(`/workflow-studio?wf=closing_execution&run=${encodeURIComponent(r.id)}`)
  })
})
