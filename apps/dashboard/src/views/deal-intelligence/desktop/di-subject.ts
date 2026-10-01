/**
 * THE SUBJECT CONTRACT — how desktop Deal Intelligence knows what it is
 * looking at. Pure helpers; the hook that wires them lives in
 * useDecisionSubject.ts.
 *
 * Sources, in order of explicitness:
 *   1. an explicit `subject` prop (a host embedding the surface)
 *   2. the PANE-AWARE location (useRouteLocation): `?property=` /
 *      `?property_id=` / `?thread_key=` / `?opportunity_id=` (and the legacy
 *      camelCase spellings). Notifications link `?property=`; every other app
 *      links `?property_id=`.
 *   3. linked context: the property locator, live, only while the pane
 *      follows the workspace selection.
 */
import type { PropertyLocator } from '../../../domain/locator/property-locator'
import type { DiMode } from './di-types'

export interface DiSubject {
  propertyId: string | null
  threadKey: string | null
  opportunityId: string | null
  prospectId: string | null
  masterOwnerId: string | null
  /** a label the source already knew (the locator carries the address) */
  address?: string | null
}

export const EMPTY_SUBJECT: DiSubject = { propertyId: null, threadKey: null, opportunityId: null, prospectId: null, masterOwnerId: null, address: null }

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

/** The query string of a path+query location ("/deal-intelligence?property=1" → "?property=1"). */
export function searchOf(location: string | null | undefined): string {
  const s = String(location ?? '')
  const i = s.indexOf('?')
  if (i < 0) return ''
  const h = s.indexOf('#', i)
  return h < 0 ? s.slice(i) : s.slice(i, h)
}

export function subjectFromSearch(search: string): DiSubject {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const read = (...keys: string[]) => {
    for (const k of keys) {
      const v = clean(params.get(k))
      if (v) return v
    }
    return null
  }
  return {
    propertyId: read('property_id', 'property', 'propertyId'),
    threadKey: read('thread_key', 'threadKey', 'thread'),
    opportunityId: read('opportunity_id', 'opportunityId', 'opp'),
    prospectId: read('prospect_id', 'prospectId'),
    masterOwnerId: read('master_owner_id', 'masterOwnerId'),
    address: null,
  }
}

const MODES: DiMode[] = ['decision', 'evidence', 'record', 'model', 'scenario']
export function modeFromSearch(search: string): DiMode | null {
  const v = clean(new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('mode'))
  return v && (MODES as string[]).includes(v) ? (v as DiMode) : null
}

export function subjectFromLocator(l: PropertyLocator | null | undefined): DiSubject {
  if (!l) return EMPTY_SUBJECT
  return {
    propertyId: clean(l.propertyId),
    threadKey: clean(l.threadKey),
    opportunityId: clean(l.opportunityId),
    prospectId: clean(l.prospectId),
    masterOwnerId: clean(l.masterOwnerId),
    address: clean(l.address),
  }
}

/**
 * The identity the decision read model resolves from: property first, then
 * thread, then opportunity (prospect / owner alone cannot be underwritten).
 */
export function fetchKey(s: DiSubject | null | undefined): string {
  if (!s) return ''
  if (s.propertyId) return `p:${s.propertyId}`
  if (s.threadKey) return `t:${s.threadKey}`
  if (s.opportunityId) return `o:${s.opportunityId}`
  return ''
}

export const hasSubject = (s: DiSubject | null | undefined) => Boolean(fetchKey(s))

/**
 * Is `next` the subject already on screen? A thread-only arrival resolves to a
 * property; a later property-keyed selection of that same property is the
 * same subject and must not refetch.
 */
export function sameSubject(current: DiSubject | null, next: DiSubject | null, resolved?: { propertyId?: string | null; threadKey?: string | null } | null): boolean {
  if (!current || !next) return false
  if (fetchKey(current) && fetchKey(current) === fetchKey(next)) return true
  if (resolved?.propertyId && next.propertyId && resolved.propertyId === next.propertyId) return true
  if (!next.propertyId && resolved?.threadKey && next.threadKey && resolved.threadKey === next.threadKey) return true
  return false
}

/** A deep link that reloads to the same subject and mode. */
export function buildDiPath(s: DiSubject, mode?: DiMode | null): string {
  const q = new URLSearchParams()
  if (s.propertyId) q.set('property_id', s.propertyId)
  if (s.threadKey) q.set('thread_key', s.threadKey)
  if (!s.propertyId && !s.threadKey && s.opportunityId) q.set('opportunity_id', s.opportunityId)
  if (mode && mode !== 'decision') q.set('mode', mode)
  const qs = q.toString()
  return qs ? `/deal-intelligence?${qs}` : '/deal-intelligence'
}

/* ── recents: the operator's own recently opened subjects (this browser) ── */

export interface DiRecent {
  propertyId: string
  threadKey: string | null
  address: string | null
  seller: string | null
  tier: string | null
  at: number
}

const RECENTS_KEY = 'lc.di.recents.v1'
const RECENTS_MAX = 8

export function readRecents(): DiRecent[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as DiRecent[]) : []
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.propertyId === 'string').slice(0, RECENTS_MAX) : []
  } catch {
    return []
  }
}

export function rememberRecent(entry: DiRecent): void {
  try {
    const next = [entry, ...readRecents().filter((r) => r.propertyId !== entry.propertyId)].slice(0, RECENTS_MAX)
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    /* private mode: recents are a convenience */
  }
}
