import { describe, expect, it } from 'vitest'
import {
  buildPropertySignalTileModel,
  formatCardDateTime,
  formatPropertyTypeLine,
  formatTileEquity,
  prioritizeCardSignals,
  resolveInboxMessageState,
  resolveInboxStageBadge,
} from './inbox-card-signals'

/**
 * INBOX-CARD-PREMIUM-1 — the card must not claim things the data does not say.
 *
 * Every fixture below is a shape taken from the live /api/cockpit/inbox/threads
 * payload on 2026-09-14, not invented: the stage vocabulary really does mix
 * canonical lifecycle codes with statuses, `latest_delivery_status` really is
 * absent on compact rows, and `equity_percent: -3` and `units_count: 0` are
 * real values.
 */

describe('stage badge', () => {
  it('maps every canonical lifecycle code to its S-number', () => {
    const expected: Array<[string, string]> = [
      ['ownership_confirmation', 'S1'],
      ['offer_interest', 'S2'],
      ['asking_price', 'S3'],
      ['property_condition', 'S4'],
      ['offer', 'S5'],
      ['formal_contract', 'S6'],
      ['disposition', 'S7'],
      ['under_contract', 'S8'],
      ['prepared_to_close', 'S9'],
      ['closed', 'S10'],
    ]
    for (const [code, short] of expected) {
      expect(resolveInboxStageBadge({ acquisition_stage: code })?.short, code).toBe(short)
    }
  })

  it('does NOT fabricate a stage from a status', () => {
    // These are the real values `acquisition_stage` carries when no canonical
    // lifecycle stage exists. The registry's normalizeLifecycleStage would
    // coerce each of them to ownership_confirmation, i.e. claim an S1 ownership
    // check that never happened. 3,811 of 9,778 threads are in this state.
    for (const status of ['seller_replied', 'awaiting_response', 'not_contacted', 'needs_response', 'dead', 'new_reply', 'waiting', 'interested']) {
      expect(resolveInboxStageBadge({ acquisition_stage: status }), status).toBeNull()
    }
  })

  it('returns null rather than a badge when there is no stage at all', () => {
    expect(resolveInboxStageBadge({})).toBeNull()
    expect(resolveInboxStageBadge({ acquisition_stage: '' })).toBeNull()
    expect(resolveInboxStageBadge(null)).toBeNull()
  })

  it('never reads the legacy stage column', () => {
    // inbox_threads_hydrated.stage holds buckets and statuses. Reading it is
    // what made the badge untrustworthy in the first place.
    expect(resolveInboxStageBadge({ stage: 'ownership_check', legacy_stage: 'S1' })).toBeNull()
  })

  it('accepts an explicit alias of the same stage', () => {
    expect(resolveInboxStageBadge({ acquisition_stage: 'interest_probe' })?.short).toBe('S2')
    expect(resolveInboxStageBadge({ acquisition_stage: 'ownership_check' })?.short).toBe('S1')
  })

  it('bands the funnel without a rainbow', () => {
    expect(resolveInboxStageBadge({ acquisition_stage: 'asking_price' })?.band).toBe('early')
    expect(resolveInboxStageBadge({ acquisition_stage: 'property_condition' })?.band).toBe('mid')
    expect(resolveInboxStageBadge({ acquisition_stage: 'closed' })?.band).toBe('execution')
  })
})

describe('message state', () => {
  it('never says Delivered without provider evidence', () => {
    const state = resolveInboxMessageState({ latest_delivery_status: null }, 'outbound')
    expect(state?.label).toBe('Outbound')
    expect(state?.label).not.toContain('Delivered')
  })

  it('says only the direction when the compact row carries no delivery field', () => {
    // canonical-inbox-row-contract.js omits latest_delivery_status to stay
    // inside a 50-key budget. 64 of 200 threads are failed_transport, so
    // falling through to "Sent" here would mislabel every one of them.
    expect(resolveInboxMessageState({}, 'outbound')?.label).toBe('Outbound')
  })

  it('claims Delivered on a delivered_at or a deliver status', () => {
    expect(resolveInboxMessageState({ latest_delivered_at: '2026-09-12T18:00:00Z' }, 'outbound')?.label)
      .toBe('Outbound · Delivered')
    expect(resolveInboxMessageState({ queue_status: 'delivered' }, 'outbound')?.label)
      .toBe('Outbound · Delivered')
  })

  it('reports the real failure state', () => {
    expect(resolveInboxMessageState({ latest_delivery_status: 'failed_transport' }, 'outbound')?.label)
      .toBe('Outbound · Failed')
    expect(resolveInboxMessageState({ latest_failure_reason: 'carrier rejected' }, 'outbound')?.label)
      .toBe('Outbound · Failed')
  })

  it('puts failure ahead of delivery when both are present', () => {
    // An accepted-then-failed message has both a sent receipt and a failure.
    const state = resolveInboxMessageState(
      { latest_sent_at: '2026-09-12T18:00:00Z', latest_delivery_status: 'failed_transport' },
      'outbound',
    )
    expect(state?.label).toBe('Outbound · Failed')
  })

  it('distinguishes scheduled from queued', () => {
    expect(resolveInboxMessageState({ next_scheduled_for: '2026-09-16T15:00:00Z' }, 'outbound')?.label)
      .toBe('Outbound · Scheduled')
    expect(resolveInboxMessageState({ queue_status: 'manual_review' }, 'outbound')?.label)
      .toBe('Outbound · Queued')
  })

  it('marks an unread inbound as a new reply', () => {
    expect(resolveInboxMessageState({}, 'inbound', { unread: true })?.label).toBe('Inbound · New reply')
    expect(resolveInboxMessageState({}, 'inbound', { unread: false })?.label).toBe('Inbound')
  })
})

describe('date + time', () => {
  it('shows both, not one or the other', () => {
    expect(formatCardDateTime({ dayLabel: 'Sep 12', timeLabel: '10:42 AM' })).toBe('Sep 12 · 10:42 AM')
    expect(formatCardDateTime({ dayLabel: 'Today', timeLabel: '2:34 PM' })).toBe('Today · 2:34 PM')
  })

  it('degrades without inventing a value', () => {
    expect(formatCardDateTime({ dayLabel: '—', timeLabel: '' })).toBe('—')
    expect(formatCardDateTime(null)).toBe('—')
  })
})

describe('property signal tile', () => {
  it('names the asset class the same way from a raw column or a label', () => {
    expect(formatPropertyTypeLine('Multi-Family', 2)).toBe('Multifamily · 2 units')
    expect(formatPropertyTypeLine('Multifamily', 2)).toBe('Multifamily · 2 units')
    expect(formatPropertyTypeLine('Single Family', 1)).toBe('SFR')
  })

  it('does not print a unit count that would read as nonsense', () => {
    // units_count is 1 on most SFR rows and 0 on some.
    expect(formatPropertyTypeLine('Single Family', 1)).toBe('SFR')
    expect(formatPropertyTypeLine('Multi-Family', 0)).toBe('Multifamily')
    expect(formatPropertyTypeLine('Multi-Family', 1)).toBe('Multifamily')
    expect(formatPropertyTypeLine('Duplex', 2)).toBe('Duplex')
  })

  it('omits a missing value instead of showing a placeholder', () => {
    const model = buildPropertySignalTileModel({ propertyType: 'Single Family', market: 'Miami, FL' })
    expect(model.valueLine).toBeNull()
    expect(model.equityLine).toBeNull()
    expect(model.typeLine).toBe('SFR')
    expect(model.marketLine).toBe('MIAMI, FL')
  })

  it('drops a meaningless 0% but keeps negative equity', () => {
    expect(formatTileEquity(0)).toBeNull()
    expect(formatTileEquity(null)).toBeNull()
    // equity_percent: -3 is real, and underwater is exactly what an operator
    // needs to see.
    expect(formatTileEquity(-3)).toBe('-3% EQ')
    expect(formatTileEquity(100)).toBe('100% EQ')
  })

  it('formats value compactly from real amounts', () => {
    expect(buildPropertySignalTileModel({ estimatedValue: 494000 }).valueLine).toBe('$494K')
    expect(buildPropertySignalTileModel({ estimatedValue: 1_800_000 }).valueLine).toBe('$1.8M')
    expect(buildPropertySignalTileModel({ estimatedValue: 0 }).valueLine).toBeNull()
  })

  it('falls back to city and state when there is no market', () => {
    expect(buildPropertySignalTileModel({ city: 'Saint Paul', state: 'MN' }).marketLine).toBe('SAINT PAUL, MN')
    expect(buildPropertySignalTileModel({ market: 'Unknown Market', city: 'Riverdale' }).marketLine).toBe('RIVERDALE')
  })
})

describe('signal chips', () => {
  it('orders by actionability, not by input order', () => {
    const signals = prioritizeCardSignals(['Long Term Owner', 'Absentee', 'Tax Delinquent'], 3)
    expect(signals).toEqual(['Tax Delinquent', 'Absentee', 'Long Term Owner'])
  })

  it('never repeats the asset class the tile already states', () => {
    expect(prioritizeCardSignals(['SFR', 'High Equity'], 3)).toEqual(['High Equity'])
    expect(prioritizeCardSignals(['Multifamily', 'Vacant'], 3)).toEqual(['Vacant'])
  })

  it('stays within the limit and dedupes', () => {
    const signals = prioritizeCardSignals(['Absentee', 'Absentee', 'Vacant', 'Senior Owner', 'Probate'], 2)
    expect(signals).toHaveLength(2)
    expect(signals).toEqual(['Probate', 'Vacant'])
  })
})

describe('a suppressed contact never presents as a live reply', () => {
  /**
   * THE DEFECT. The suppression test lived INSIDE the outbound branch, below
   * an inbound branch that returned early, so a suppressed thread whose last
   * message was inbound could never reach it.
   *
   * Measured on the live list: "Bertha A Daniels", inbox_bucket=suppressed,
   * rendered "Inbound · New reply" in actionable cyan. The card was inviting
   * an operator to reply to someone who had opted out, and the suppression
   * state was unreachable for exactly the threads where the seller spoke last.
   *
   * Every one of the 24 existing tests passed throughout, because none of them
   * combined suppression with an inbound direction.
   */
  it('labels an inbound suppressed thread as suppressed, not as a new reply', () => {
    const state = resolveInboxMessageState(
      { is_suppressed: true, latest_message_body: 'stop' },
      'inbound',
      { unread: true },
    )
    expect(state?.tone).toBe('suppressed')
    expect(state?.label).not.toMatch(/new reply/i)
  })

  it('still labels an outbound suppressed thread as suppressed', () => {
    const state = resolveInboxMessageState({ is_suppressed: true }, 'outbound')
    expect(state?.tone).toBe('suppressed')
  })

  it('leaves an ordinary inbound reply alone', () => {
    const state = resolveInboxMessageState({}, 'inbound', { unread: true })
    expect(state?.tone).toBe('inbound-new')
    expect(state?.label).toMatch(/new reply/i)
  })
})
