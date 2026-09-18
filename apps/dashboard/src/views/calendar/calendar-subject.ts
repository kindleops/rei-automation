/**
 * CALENDAR'S SUBJECT — §5/§6.
 *
 * Calendar scoped only from the Inbox's `selectedThread`, so arriving from
 * Pipeline, Deal Intelligence or the mobile dock — none of which set that —
 * always showed the global schedule. A deep link carrying ?property_id= was
 * ignored entirely, which meant "open Calendar for this seller" was not
 * expressible.
 *
 * Resolution order, most explicit first:
 *   1. `?property_id=` / `?opportunity_id=` in the URL (what the dock writes)
 *   2. the sessionStorage property locator (the cross-app carrier)
 *
 * §6 — a subject that has no scheduled work reports exactly that. It must
 * never fall back to the global schedule, because a global list under a
 * subject header reads as "this seller has 1,500 items".
 */

export interface CalendarSubject {
  propertyId: string | null
  masterOwnerId: string | null
  opportunityId: string | null
  threadKey: string | null
  address: string | null
  source: 'url' | 'none'
}

export const NO_CALENDAR_SUBJECT: CalendarSubject = {
  propertyId: null,
  masterOwnerId: null,
  opportunityId: null,
  threadKey: null,
  address: null,
  source: 'none',
}

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

export function resolveCalendarSubject(search?: string): CalendarSubject {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '')
  try {
    const params = new URLSearchParams(query)
    const propertyId = str(params.get('property_id'))
    const ownerId = str(params.get('master_owner_id') || params.get('seller_id'))
    const opportunityId = str(params.get('opportunity_id') || params.get('opp'))
    const threadKey = str(params.get('thread_key'))
    if (propertyId || ownerId || opportunityId || threadKey) {
      return { propertyId, masterOwnerId: ownerId, opportunityId, threadKey, address: null, source: 'url' }
    }
  } catch {
    /* a malformed query string must not break the surface */
  }

  return NO_CALENDAR_SUBJECT
}

export function hasCalendarSubject(subject: CalendarSubject): boolean {
  return Boolean(subject.propertyId || subject.masterOwnerId || subject.opportunityId || subject.threadKey)
}

/** Same subject only when every identifier agrees, so a switch always refetches. */
export function sameCalendarSubject(a: CalendarSubject, b: CalendarSubject): boolean {
  return a.propertyId === b.propertyId &&
    a.masterOwnerId === b.masterOwnerId &&
    a.opportunityId === b.opportunityId &&
    a.threadKey === b.threadKey
}

export function describeCalendarSubject(subject: CalendarSubject): string {
  if (!hasCalendarSubject(subject)) return 'All scheduled work'
  if (subject.address) return subject.address
  if (subject.propertyId) return `Property ${subject.propertyId}`
  if (subject.opportunityId) return `Opportunity ${subject.opportunityId}`
  return `Seller ${subject.masterOwnerId}`
}

/**
 * §6 — what to say when a scoped calendar is empty. A fact about this subject,
 * never an invitation to show the global schedule.
 */
export function describeCalendarSubjectEmpty(subject: CalendarSubject): string {
  if (!hasCalendarSubject(subject)) return 'No scheduled work in this range.'
  return `No scheduled work for ${describeCalendarSubject(subject)} in this range.`
}
