import { describe, expect, it } from 'vitest'
import type { PipelineOpportunity } from '../../../domain/pipeline/pipeline-opportunity.types'
import {
  EMPTY_FILTERS,
  activeFilterCount,
  applyFilters,
  applySort,
  needsResponse,
  stageOf,
  statusOf,
  temperatureOf,
} from './pipeline-mobile-filters'

const opp = (over: Record<string, unknown>): PipelineOpportunity =>
  ({ id: String(over.id ?? 'x'), ...over }) as unknown as PipelineOpportunity

const LEADS = [
  opp({
    id: 'a',
    canonical_lifecycle_stage: 'ownership_confirmation',
    canonical_operational_status: 'new_reply',
    canonical_lead_temperature: 'cold',
    last_contact_at: '2026-08-17T21:11:29Z',
    next_follow_up_at: '2026-09-16T21:11:29Z',
  }),
  opp({
    id: 'b',
    canonical_lifecycle_stage: 'offer_interest',
    canonical_operational_status: 'waiting_on_seller',
    canonical_lead_temperature: 'hot',
    last_contact_at: '2026-08-20T10:00:00Z',
  }),
  opp({
    id: 'c',
    canonical_lifecycle_stage: 'ownership_confirmation',
    canonical_operational_status: 'waiting_on_seller',
    canonical_lead_temperature: 'warm',
    last_contact_at: '2026-08-01T10:00:00Z',
    next_follow_up_at: '2026-08-02T10:00:00Z',
  }),
]

describe('canonical field resolution', () => {
  it('prefers canonical columns over the opportunity ones', () => {
    const o = opp({
      canonical_lifecycle_stage: 'offer_interest',
      acquisition_stage: 'ownership_confirmation',
      canonical_operational_status: 'new_reply',
      opportunity_status: 'active',
      canonical_lead_temperature: 'hot',
    })
    expect(stageOf(o)).toBe('offer_interest')
    expect(statusOf(o)).toBe('new_reply')
    expect(temperatureOf(o)).toBe('hot')
  })

  it('falls back to the opportunity column when canonical is absent', () => {
    const o = opp({ acquisition_stage: 'Ownership_Confirmation', opportunity_status: 'Active' })
    expect(stageOf(o)).toBe('ownership_confirmation')
    expect(statusOf(o)).toBe('active')
  })
})

describe('needsResponse', () => {
  it('is true for canonical new_reply', () => {
    expect(needsResponse(opp({ canonical_operational_status: 'new_reply' }))).toBe(true)
  })

  it('is false for awaiting_seller — that is us waiting on them', () => {
    // `resolveReplyAttentionState` returns a label for this case, which is why
    // it is deliberately not the predicate behind the Need-a-reply filter.
    expect(needsResponse(opp({
      canonical_operational_status: 'waiting_on_seller',
      conversation_state: 'awaiting_seller',
    }))).toBe(false)
  })

  it('falls back to conversation_state only when no canonical status exists', () => {
    for (const cs of ['needs_reply', 'new_inbound', 'unread']) {
      expect(needsResponse(opp({ conversation_state: cs }))).toBe(true)
    }
  })

  it('ignores seller_replied, which is set on 254 of the live 258', () => {
    // Treating it as "needs a reply" selected the whole book.
    expect(needsResponse(opp({ conversation_state: 'seller_replied' }))).toBe(false)
  })

  it('a canonical status wins over conversation_state', () => {
    expect(needsResponse(opp({
      canonical_operational_status: 'paused',
      conversation_state: 'needs_reply',
    }))).toBe(false)
  })
})

describe('applyFilters', () => {
  it('returns everything when nothing is selected', () => {
    expect(applyFilters(LEADS, EMPTY_FILTERS)).toHaveLength(3)
  })

  it('filters by stage', () => {
    const out = applyFilters(LEADS, { ...EMPTY_FILTERS, stages: ['offer_interest'] })
    expect(out.map((o) => o.id)).toEqual(['b'])
  })

  it('filters by status and temperature', () => {
    expect(applyFilters(LEADS, { ...EMPTY_FILTERS, statuses: ['waiting_on_seller'] }).map((o) => o.id))
      .toEqual(['b', 'c'])
    expect(applyFilters(LEADS, { ...EMPTY_FILTERS, temperatures: ['hot'] }).map((o) => o.id))
      .toEqual(['b'])
  })

  it('intersects dimensions rather than unioning them', () => {
    const out = applyFilters(LEADS, {
      ...EMPTY_FILTERS,
      stages: ['ownership_confirmation'],
      temperatures: ['warm'],
    })
    expect(out.map((o) => o.id)).toEqual(['c'])
  })

  it('needs-response narrows to the leads that owe us a reply', () => {
    const out = applyFilters(LEADS, { ...EMPTY_FILTERS, needsResponse: true })
    expect(out.map((o) => o.id)).toEqual(['a'])
  })

  it('the filtered length is what a count must report', () => {
    // The count contract: one funnel, so a count is just the array length.
    const f = { ...EMPTY_FILTERS, stages: ['ownership_confirmation'] }
    expect(applyFilters(LEADS, f).length).toBe(2)
  })
})

describe('activeFilterCount', () => {
  it('counts engaged dimensions, not selected values', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0)
    expect(activeFilterCount({ ...EMPTY_FILTERS, stages: ['a', 'b', 'c'] })).toBe(1)
    expect(activeFilterCount({
      ...EMPTY_FILTERS, stages: ['a'], needsResponse: true, followUpDue: true,
    })).toBe(3)
  })
})

describe('applySort', () => {
  it('newest activity first', () => {
    expect(applySort(LEADS, 'recent').map((o) => o.id)).toEqual(['b', 'a', 'c'])
  })

  it('stalest first', () => {
    expect(applySort(LEADS, 'stale').map((o) => o.id)).toEqual(['c', 'a', 'b'])
  })

  it('follow-up due puts leads with no due date last', () => {
    // 'b' has no follow-up date; it must not displace a real due date.
    expect(applySort(LEADS, 'follow_up').map((o) => o.id)).toEqual(['c', 'a', 'b'])
  })

  it('is stable for ties', () => {
    const tied = [
      opp({ id: 'p', last_contact_at: '2026-08-20T10:00:00Z' }),
      opp({ id: 'q', last_contact_at: '2026-08-20T10:00:00Z' }),
    ]
    expect(applySort(tied, 'recent').map((o) => o.id)).toEqual(['p', 'q'])
  })

  it('does not mutate the input array', () => {
    const input = [...LEADS]
    applySort(input, 'stale')
    expect(input.map((o) => o.id)).toEqual(['a', 'b', 'c'])
  })
})
