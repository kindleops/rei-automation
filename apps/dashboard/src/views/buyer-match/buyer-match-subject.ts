/**
 * BUYER-MATCH-MOBILE-LOCK-1 §3 — the property subject, resolved honestly.
 *
 * Buyer Match is PROPERTY-SCOPED: it answers "who should buy this one?". The
 * routed page previously answered a different question entirely, from
 * `referenceCommandCenterData` — hardcoded demo buyers and properties with
 * synthetic `minutesAgo()` activity and a client-side match score computed by
 * looping buyers x demo properties. There was no subject at all.
 *
 * Resolution order, most explicit first. Nothing here invents a subject: when
 * every source is empty the caller must render the honest select-a-property
 * state rather than falling back to a first/last/recent property.
 *
 *   1. `?property_id=` on the URL          — an explicit deep link
 *   2. the global property locator          — what the operator is looking at,
 *      published at SELECTION time into sessionStorage (see
 *      domain/locator/property-locator), which is the only carrier that
 *      survives a dock tap
 *   3. the universal entity context         — the in-memory selected entity,
 *      useful when Buyer Match is opened without a navigation
 */
import { readPropertyLocator } from '../../domain/locator/property-locator'
import { getUniversalEntityContextSnapshot } from '../../domain/entity-graph/universal-entity-context-store'

export interface BuyerMatchSubject {
  propertyId: string
  /** Only ever a hint for first paint; the canonical address is hydrated. */
  addressHint: string | null
  opportunityId: string | null
  threadKey: string | null
  source: 'url' | 'locator' | 'universal'
}

const clean = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

/** The property Buyer Match should be scoped to, or null. */
export function resolveBuyerMatchSubject(search?: string): BuyerMatchSubject | null {
  const params = new URLSearchParams(
    search ?? (typeof window !== 'undefined' ? window.location.search : ''),
  )

  const fromUrl = clean(params.get('property_id'))
  if (fromUrl) {
    return {
      propertyId: fromUrl,
      addressHint: clean(params.get('address')),
      opportunityId: clean(params.get('opportunity_id')),
      threadKey: clean(params.get('thread_key')),
      source: 'url',
    }
  }

  const locator = readPropertyLocator()
  if (locator?.propertyId) {
    return {
      propertyId: locator.propertyId,
      addressHint: clean(locator.address),
      opportunityId: clean(locator.opportunityId),
      threadKey: clean(locator.threadKey),
      source: 'locator',
    }
  }

  const universal = getUniversalEntityContextSnapshot()
  if (universal?.propertyId) {
    return {
      propertyId: String(universal.propertyId),
      addressHint: clean((universal as { propertyAddress?: string }).propertyAddress),
      opportunityId: null,
      threadKey: clean(universal.threadKey),
      source: 'universal',
    }
  }

  return null
}

/**
 * §16 — four states that must never collapse into "No buyers found".
 *
 * `no_property`   the operator has not chosen a property
 * `no_run`        the match engine has never been run for it (run_id === null)
 * `no_candidates` a run exists and returned nothing (run_id set, total 0)
 * `failed`        the request failed — an error is not an empty result
 */
export type BuyerMatchState =
  | { kind: 'no_property' }
  | { kind: 'loading' }
  | { kind: 'no_run'; propertyId: string }
  | { kind: 'no_candidates'; propertyId: string; runId: string }
  | { kind: 'ready'; propertyId: string; runId: string; total: number; loaded: number }
  | { kind: 'failed'; propertyId: string; message: string }

/**
 * Classify a canonical candidates response. The endpoint deliberately
 * distinguishes "no run" (`run_id: null`) from "run found nothing", so the
 * surface can too.
 */
export function classifyCandidatesResponse(input: {
  propertyId: string
  ok: boolean
  message?: string | null
  runId?: string | null
  total?: number | null
  loaded?: number | null
}): BuyerMatchState {
  if (!input.ok) {
    return { kind: 'failed', propertyId: input.propertyId, message: input.message || 'Buyer match request failed' }
  }
  if (!input.runId) return { kind: 'no_run', propertyId: input.propertyId }
  const total = Number(input.total ?? 0)
  if (total <= 0) return { kind: 'no_candidates', propertyId: input.propertyId, runId: input.runId }
  return {
    kind: 'ready',
    propertyId: input.propertyId,
    runId: input.runId,
    total,
    loaded: Number(input.loaded ?? 0),
  }
}

/**
 * §15 — truthful count copy. `total` is the exact canonical count of buyer
 * match candidates for the selected property (the endpoint asks PostgREST for
 * `count: 'exact'`), so a cap must be disclosed rather than shown as the total.
 */
export function describeMatchCount(total: number, loaded: number): string {
  if (total <= 0) return 'No matches'
  const noun = total === 1 ? 'match' : 'matches'
  if (loaded > 0 && loaded < total) return `Showing ${loaded} of ${total} ${noun}`
  return `${total} ${noun}`
}

/**
 * THE CANDIDATES ENVELOPE, unwrapped in one testable place.
 *
 * `callBackend` returns `{ ok, status, data }` where `data` is the WHOLE
 * response body — and the body is itself `{ ok, data: { ... } }`. So the
 * canonical payload is two levels down. Reading it one level shallow was a real
 * defect: `run_id` came back `undefined` for a property with 25 candidates, the
 * surface classified that as "no match run", and the operator saw a confident
 * "no buyers" for a property the engine had actually matched.
 *
 * The failure mode is worse than a blank screen, which is why this is a
 * function rather than inline unwrapping: there are THREE distinct failures
 * (transport, envelope, missing payload) and all three previously collapsed
 * into the same shape as a legitimately empty result. An error must never
 * render as an empty match set.
 */
export interface CandidatesEnvelope<T> {
  ok?: boolean
  error?: string
  message?: string
  data?: { candidates?: T[]; total?: number; run_id?: string | null } | null
}

export type CandidatesRead<T> =
  | { ok: true; candidates: T[]; total: number; runId: string | null }
  | { ok: false; message: string }

export function readCandidatesEnvelope<T>(res: {
  ok: boolean
  error?: string
  message?: string
  data?: CandidatesEnvelope<T> | null
}): CandidatesRead<T> {
  if (!res.ok) {
    return { ok: false, message: res.message || res.error || 'Buyer match request failed' }
  }
  const envelope = res.data
  if (envelope?.ok === false) {
    return { ok: false, message: envelope.message || envelope.error || 'Buyer match request failed' }
  }
  const payload = envelope?.data
  if (!payload) {
    return { ok: false, message: 'Buyer match returned no payload' }
  }
  return {
    ok: true,
    candidates: Array.isArray(payload.candidates) ? payload.candidates : [],
    // `total` absent is NOT zero — fall back to what actually arrived rather
    // than asserting a count the server never sent.
    total: typeof payload.total === 'number' && Number.isFinite(payload.total)
      ? payload.total
      : (Array.isArray(payload.candidates) ? payload.candidates.length : 0),
    runId: payload.run_id ?? null,
  }
}
