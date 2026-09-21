import { describe, expect, it } from 'vitest'
import {
  NO_CALENDAR_SUBJECT,
  describeCalendarSubject,
  describeCalendarSubjectEmpty,
  hasCalendarSubject,
  resolveCalendarSubject,
  sameCalendarSubject,
} from './calendar-subject'
import { shouldOfferReturnToToday } from '../../lib/calendar/calendar-date-engine'

/**
 * CALENDAR-MOBILE-LOCK-1 §44. Each case pins a defect found on 2026-09-16.
 */

describe('the calendar subject is exact, and A never leaks into B', () => {
  /**
   * THE DEFECT. Calendar scoped only from the Inbox's selectedThread and only
   * when scopeMode was 'selected', so arriving from Pipeline, Deal
   * Intelligence or the mobile dock always showed the global schedule, and a
   * ?property_id= deep link was ignored entirely.
   */
  it('reads an explicit property from the URL', () => {
    const s = resolveCalendarSubject('?property_id=25115350')
    expect(s.propertyId).toBe('25115350')
    expect(s.source).toBe('url')
    expect(hasCalendarSubject(s)).toBe(true)
  })

  it('reads an opportunity subject, including the pipeline opp alias', () => {
    expect(resolveCalendarSubject('?opportunity_id=opp-1').opportunityId).toBe('opp-1')
    expect(resolveCalendarSubject('?opp=opp-2').opportunityId).toBe('opp-2')
  })

  it('treats a blank or malformed query as no subject', () => {
    for (const q of ['', '?', '?property_id=', '?property_id=%20%20', '?%%%']) {
      expect(hasCalendarSubject(resolveCalendarSubject(q)), `"${q}"`).toBe(false)
    }
  })

  /**
   * §6 — two subjects are the same only when EVERY identifier agrees, so a
   * switch always refetches. Anything looser risks showing A's schedule under
   * B's header.
   */
  it('never treats two different subjects as the same', () => {
    const a = resolveCalendarSubject('?property_id=25115350')
    const b = resolveCalendarSubject('?property_id=24589344')
    expect(sameCalendarSubject(a, b)).toBe(false)
    expect(sameCalendarSubject(a, a)).toBe(true)
    expect(sameCalendarSubject(a, NO_CALENDAR_SUBJECT)).toBe(false)
  })

  it('distinguishes the same property under different owners', () => {
    const a = resolveCalendarSubject('?property_id=1&master_owner_id=mo_a')
    const b = resolveCalendarSubject('?property_id=1&master_owner_id=mo_b')
    expect(sameCalendarSubject(a, b)).toBe(false)
  })

  /**
   * A scoped empty view reports a fact about THAT subject. A global "no
   * scheduled work" would invite falling back to the whole schedule, which is
   * how A's items end up under B.
   */
  it('an empty scoped calendar blames the subject, not the system', () => {
    const scoped = describeCalendarSubjectEmpty(resolveCalendarSubject('?property_id=25115350'))
    const global = describeCalendarSubjectEmpty(NO_CALENDAR_SUBJECT)
    expect(scoped).toContain('25115350')
    expect(global).not.toContain('25115350')
    expect(scoped).not.toBe(global)
  })

  it('describes an unscoped calendar as all scheduled work', () => {
    expect(describeCalendarSubject(NO_CALENDAR_SUBJECT)).toBe('All scheduled work')
  })
})

/**
 * §25 — a way back to Today.
 *
 * THE DEFECT (2026-09-20). The mobile header carried a date, a count and a
 * `Month` button, and nothing else. The day strip spans only the week around
 * the anchor while the month sheet can jump to any date, so an operator who
 * opened next month and tapped a day had no route home: the strip had
 * re-anchored around that week, and today sat several month-pages back behind
 * the Month control. `todayKey` already existed to MARK today in the strip —
 * the marker was there, the way back was not.
 */
describe('returning to today', () => {
  it('offers no Today control while already on today', () => {
    const now = new Date(2026, 8, 20, 9, 0, 0)
    expect(shouldOfferReturnToToday(new Date(2026, 8, 20, 23, 59, 0), now)).toBe(false)
    expect(shouldOfferReturnToToday(new Date(2026, 8, 20, 0, 0, 1), now)).toBe(false)
  })

  it('offers it as soon as the anchor moves to another day', () => {
    const now = new Date(2026, 8, 20, 9, 0, 0)
    expect(shouldOfferReturnToToday(new Date(2026, 8, 21), now)).toBe(true)
    expect(shouldOfferReturnToToday(new Date(2026, 8, 19), now)).toBe(true)
    expect(shouldOfferReturnToToday(new Date(2026, 9, 24), now)).toBe(true)
  })

  it('compares calendar dates, not instants', () => {
    /*
     * 23:00 and 01:00 the next morning are two hours apart and two different
     * days. A `getTime()` comparison would make the control's presence depend
     * on the clock rather than the date.
     */
    const lateTonight = new Date(2026, 8, 20, 23, 0, 0)
    const earlyTomorrow = new Date(2026, 8, 21, 1, 0, 0)
    expect(shouldOfferReturnToToday(earlyTomorrow, lateTonight)).toBe(true)
    expect(Math.abs(earlyTomorrow.getTime() - lateTonight.getTime())).toBeLessThan(3 * 60 * 60 * 1000)
  })

  it('crosses a month boundary correctly', () => {
    const now = new Date(2026, 8, 30, 12, 0, 0)
    expect(shouldOfferReturnToToday(new Date(2026, 9, 1), now)).toBe(true)
    expect(shouldOfferReturnToToday(new Date(2026, 8, 30, 0, 0, 0), now)).toBe(false)
  })
})
