/**
 * EMAIL COMMAND'S SUBJECT — §5/§6.
 *
 * Email Command is reachable from Inbox, Pipeline, Deal Intelligence and the
 * mobile dock, all of which publish a property locator at SELECTION time.
 * Without reading it, arriving from a specific seller showed the entire
 * 165,655-address corpus — technically true and operationally useless.
 *
 * Resolution order, most explicit first:
 *   1. `?property_id=` in the URL (what the dock writes)
 *   2. the sessionStorage property locator (the cross-app carrier)
 *
 * The universal entity snapshot is deliberately NOT consulted: it is wiped on
 * every dock tap, which is exactly when this needs to be read.
 *
 * §6 — when a subject is present but has no email addresses, that is reported
 * as "this subject has none", NOT by falling back to the whole corpus. Showing
 * subject A's data while B is selected is the specific failure §6 forbids.
 */
import { readPropertyLocator } from '../../domain/locator/property-locator'

export interface EmailSubject {
  propertyId: string | null
  masterOwnerId: string | null
  address: string | null
  source: 'url' | 'locator' | 'none'
}

export const NO_SUBJECT: EmailSubject = {
  propertyId: null,
  masterOwnerId: null,
  address: null,
  source: 'none',
}

const str = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

export function resolveEmailSubject(search?: string): EmailSubject {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '')
  try {
    const params = new URLSearchParams(query)
    const fromUrl = str(params.get('property_id'))
    const ownerFromUrl = str(params.get('master_owner_id'))
    if (fromUrl || ownerFromUrl) {
      return { propertyId: fromUrl, masterOwnerId: ownerFromUrl, address: null, source: 'url' }
    }
  } catch {
    /* a malformed query string must not break the surface */
  }

  const locator = readPropertyLocator()
  if (locator?.propertyId || locator?.masterOwnerId) {
    return {
      propertyId: str(locator.propertyId),
      masterOwnerId: str(locator.masterOwnerId),
      address: str(locator.address),
      source: 'locator',
    }
  }
  return NO_SUBJECT
}

export function hasSubject(subject: EmailSubject): boolean {
  return Boolean(subject.propertyId || subject.masterOwnerId)
}

/** Two subjects are the same only if BOTH identifiers agree. */
export function sameSubject(a: EmailSubject, b: EmailSubject): boolean {
  return a.propertyId === b.propertyId && a.masterOwnerId === b.masterOwnerId
}

export function describeSubject(subject: EmailSubject, address?: string | null): string {
  if (!hasSubject(subject)) return 'All email records'
  const label = address ?? subject.address
  if (label) return label
  if (subject.propertyId) return `Property ${subject.propertyId}`
  return `Owner ${subject.masterOwnerId}`
}

/**
 * What to say when a scoped view is empty. A subject with no addresses is a
 * fact about that subject, not an error and not an invitation to show someone
 * else's data.
 */
export function describeSubjectEmpty(subject: EmailSubject, address?: string | null): string {
  if (!hasSubject(subject)) return 'No email records match this view.'
  return `No email addresses are linked to ${describeSubject(subject, address)} yet.`
}
