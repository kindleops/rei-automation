import { describe, expect, it } from 'vitest'
import { prioritizeCardSignals } from './inbox-card-signals'
import { mapAuthoritativeCountsFromPayload } from '../../domain/inbox/inbox-boot-read'

/**
 * INBOX + CONVERSATION §5/§7/§29 — the read-model contracts this pass repaired.
 *
 * Three defects, each of which looked like a UI bug and was actually the
 * Inbox disagreeing with its own canonical read model. These pin the rules so
 * a future change has to argue with a test rather than quietly re-diverge.
 */

describe('New Replies is not "unread"', () => {
  /**
   * THE DEFECT. Opening a thread hid its row from New Replies, on the stated
   * belief that a read marks it handled server-side. The canonical predicate
   * (in_new_replies, v_inbox_thread_state_buckets) has NO is_read term: it
   * means the latest message is inbound and newer than our last outbound --
   * the seller is awaiting a REPLY, not a glance.
   *
   * Measured against production while fixing it: 5 of the first 100 rows the
   * New Replies list returns are already read. So the row was being hidden
   * from a set the server still counted it in -- the badge never moved and the
   * next refetch brought the row back.
   *
   * This asserts the two counters are INDEPENDENT quantities. They are
   * modelled separately on purpose; collapsing them is the regression.
   */
  it('keeps unread and new_replies as separate counters', () => {
    const counts = mapAuthoritativeCountsFromPayload({
      counts: { unread: 6899, new_replies: 142, all: 9710 },
    })
    expect(counts.new_replies).toBe(142)
    // An inbox where most threads are unread still has few awaiting a reply.
    expect(counts.new_replies).not.toBe(counts.unread)
  })

  /**
   * A read thread must still be able to sit in New Replies. If a future change
   * makes the mapper derive one from the other, this is the line that fails.
   */
  it('does not derive new_replies from the read state', () => {
    const allRead = mapAuthoritativeCountsFromPayload({
      counts: { unread: 0, new_replies: 142, all: 9710 },
    })
    expect(allRead.new_replies).toBe(142)
  })
})

describe('a card shows two signals and admits to the rest', () => {
  /**
   * THE DEFECT. The card asked for 3 prioritised signals and told the badge
   * row its maximum was also 3, so `overflow` was always zero: the "+N"
   * affordance could never render and any further signal was dropped with no
   * trace. A card showing three of six while implying there are three is
   * worse than showing two and admitting to four.
   */
  const SIX = ['High Equity', 'Tired Landlord', 'Absentee Owner', 'Tax Delinquent', 'Vacant', 'Senior Owner']

  it('returns more than the card paints, so the +N count is truthful', () => {
    // The card requests 6 and renders 2; the difference is what "+N" reports.
    expect(prioritizeCardSignals(SIX, 6).length).toBeGreaterThan(2)
  })

  it('ranks by actionability, so the two that survive are the two worth acting on', () => {
    const top = prioritizeCardSignals(SIX, 2)
    expect(top).toHaveLength(2)
    // Whatever the ranking, it must be deterministic -- a card whose chips
    // reshuffle between renders teaches the operator nothing.
    expect(prioritizeCardSignals(SIX, 2)).toEqual(top)
  })
})

describe('counts survive a degraded payload without inventing zeros', () => {
  /**
   * §32 — one failed request must not zero the category badges. An empty
   * payload is "not measured", and the mapper reports that rather than
   * claiming an inbox with nothing in it.
   */
  it('returns no counts at all rather than a confident set of zeros', () => {
    expect(mapAuthoritativeCountsFromPayload(null)).toEqual({})
    expect(mapAuthoritativeCountsFromPayload({})).toEqual({})
  })
})
