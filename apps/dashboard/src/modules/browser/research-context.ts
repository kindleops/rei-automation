import { useEffect, useState } from 'react'
import { callBackend } from '../../lib/api/backendClient'
import type { ResearchCompany, ResearchProperty } from './registry'
import type { ResearchSubject } from './session-model'

/**
 * The PUBLIC address facts research needs for a property, read from the
 * canonical subject contract (GET /api/cockpit/properties/:id/subject —
 * properties.property_address_* , apn_parcel_id, latitude/longitude).
 *
 * Only these fields ever reach a destination builder or a search query:
 * street, city, state, ZIP, county, parcel id, coordinates. Never the owner,
 * phone, notes, scores or values — and owner research is its own explicit
 * action, not something a property search does.
 */

export interface PropertyFacts {
  property: ResearchProperty
  /** "3635 Emerson Ave N" — the chip's words */
  short: string | null
  county: string | null
  apn: string | null
}

type Field = unknown
const v = (f: Field): unknown => (f && typeof f === 'object' && 'value' in (f as Record<string, unknown>) ? (f as { value: unknown }).value : f)
const t = (f: Field): string | null => { const x = v(f); return typeof x === 'string' ? x.trim() || null : typeof x === 'number' && Number.isFinite(x) ? String(x) : null }
const n = (f: Field): number | null => { const x = Number(v(f)); return v(f) !== null && v(f) !== '' && Number.isFinite(x) ? x : null }

/** Pure: subject contract → research facts. */
export function factsFromSubject(id: string, d: Record<string, Field> | null | undefined): PropertyFacts | null {
  if (!d) return null
  const full = t(d.canonical_address)
  const street = full ? full.split(',')[0].trim() || null : null
  const county = t(d.county)
  const apn = t(d.parcel_apn)
  return {
    property: {
      property_id: id,
      property_address_full: full,
      property_address: street,
      property_address_city: t(d.city),
      property_address_state: t(d.state),
      property_address_zip: t(d.zip),
      property_address_county_name: county,
      apn_parcel_id: apn,
      latitude: n(d.latitude),
      longitude: n(d.longitude),
      market: t(d.market),
    },
    short: street,
    county,
    apn,
  }
}

const cache = new Map<string, Promise<PropertyFacts | null>>()

export function loadPropertyFacts(id: string): Promise<PropertyFacts | null> {
  let p = cache.get(id)
  if (!p) {
    p = callBackend<{ ok?: boolean; data?: Record<string, Field> }>(`/api/cockpit/properties/${encodeURIComponent(id)}/subject`, { timeoutMs: 20_000 })
      .then((res) => (res.ok ? factsFromSubject(id, res.data?.data ?? null) : null))
      .catch(() => null)
    cache.set(id, p)
    // a failure is not remembered: the next ask tries again
    p.then((r) => { if (!r) cache.delete(id) })
  }
  return p
}

export type FactsState = { status: 'idle' | 'loading' | 'ready' | 'missing'; facts: PropertyFacts | null }

/** The research facts for a property subject (companies need no read: the name is the input). */
export function usePropertyFacts(subject: ResearchSubject | null): FactsState {
  const id = subject?.kind === 'property' ? subject.id : null
  const [state, setState] = useState<{ id: string | null; facts: PropertyFacts | null; done: boolean }>({ id: null, facts: null, done: false })
  useEffect(() => {
    if (!id) return
    let live = true
    loadPropertyFacts(id).then((facts) => { if (live) setState({ id, facts, done: true }) })
    return () => { live = false }
  }, [id])
  if (!id) return { status: 'idle', facts: null }
  if (state.id !== id || !state.done) return { status: 'loading', facts: null }
  return state.facts ? { status: 'ready', facts: state.facts } : { status: 'missing', facts: null }
}

export const companyOf = (subject: ResearchSubject | null): ResearchCompany | null =>
  subject?.kind === 'company' && subject.label ? { name: subject.label, state: null } : null
