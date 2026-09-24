import { describe, expect, it } from 'vitest'
import { describeIntent, intentRows, replyRatePct, stopRatePct } from './campaign-responses'

describe('describeIntent', () => {
  it('says what the seller said without upgrading it', () => {
    expect(describeIntent('ownership_confirmed').label).toBe('Confirmed they own it')
    expect(describeIntent('asks_offer')).toEqual({ label: 'Asked for an offer', tone: 'good' })
    expect(describeIntent('opt_out')).toEqual({ label: 'Asked to stop', tone: 'bad' })
  })
  it('keeps an unknown intent as words, and an empty one as unread', () => {
    expect(describeIntent('brand_new_intent')).toEqual({ label: 'Brand new intent', tone: 'neutral' })
    expect(describeIntent(null).label).toBe('Not read yet')
  })
})

describe('intentRows — Miami, 2026-09-24', () => {
  const miami = {
    not_interested: 10, unclear: 10, opt_out: 6, who_is_this: 2, wrong_number: 4, ownership_confirmed: 3,
    executor_heir_respondent: 1, tenant_respondent: 1, former_owner_respondent: 1, hostile_or_legal: 1,
    non_owner_referral: 1, asks_offer: 1,
  }
  it('lists every seller once, largest first', () => {
    const rows = intentRows(miami)
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(41)
    expect(rows[0].count).toBe(10)
    expect(rows.map((r) => r.label)).toContain('Asked to stop')
  })
  it('merges codes that mean the same thing', () => {
    expect(intentRows({ opt_out: 2, stop: 1 })).toEqual([{ key: 'opt_out', label: 'Asked to stop', tone: 'bad', count: 3 }])
  })
})

describe('rates', () => {
  it('are shares of sellers messaged, and null with nobody messaged', () => {
    expect(replyRatePct({ sellers_messaged: 350, sellers_replied: 41 })).toBeCloseTo(11.71, 1)
    expect(stopRatePct({ sellers_messaged: 350, sellers_asked_to_stop: 6 })).toBeCloseTo(1.71, 1)
    expect(replyRatePct({ sellers_messaged: 0, sellers_replied: 0 })).toBeNull()
    expect(replyRatePct(null)).toBeNull()
  })
})
