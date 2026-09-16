import { describe, expect, it } from 'vitest'
import {
  NO_CALENDAR_SUBJECT,
  describeCalendarSubject,
  describeCalendarSubjectEmpty,
  hasCalendarSubject,
  resolveCalendarSubject,
  sameCalendarSubject,
} from './calendar-subject'

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
