/**
 * THE BROWSER'S VIEW OF THE DESTINATION REGISTRY — a thin adapter.
 *
 * The research-destination registry (./destinations, owned by the
 * destinations agent) is the authority for WHERE research goes and HOW each
 * site may be shown (its embed mode is proven per domain by the embedding
 * audit). The Browser consumes only its public contract
 * (`./destinations/index.ts`): resolveJurisdiction, destinationsFor,
 * buildDestinationUrl, classifyUrl, searchUrl, sanitizeUrl,
 * propertySearchQuery, companySearchQuery.
 *
 * FALLBACK below is the SAFEST possible reading of the same signatures
 * (kept for tests and as documentation):
 *   - no destinations beyond web search (nothing invented: no county URLs)
 *   - every domain is EXTERNAL REQUIRED (UNKNOWN), so nothing is framed
 *   - web search uses the providers' documented `q` parameter only
 *
 * On top of whatever the registry says, the Browser applies its own floor
 * (see `guardUrl`): http/https only, no credentials, and never LeadCommand's
 * own origin (a same-origin page with scripts + same-origin sandbox could
 * lift its own sandbox).
 */
import type {
  AvailableDestination,
  BuildContext,
  BuildResult,
  DestinationRecord,
  DestinationType,
  EmbedMode,
  Jurisdiction,
  ResearchCompany,
  ResearchObject,
  ResearchProperty,
  SanitizeResult,
  SearchProvider,
  UrlClassification,
} from './destinations/types'
import * as REAL from './destinations'

export type {
  AvailableDestination,
  BuildContext,
  BuildResult,
  DestinationRecord,
  DestinationType,
  EmbedMode,
  Jurisdiction,
  ResearchCompany,
  ResearchObject,
  ResearchProperty,
  SanitizeResult,
  SearchProvider,
  UrlClassification,
}

/* ── the registry contract (real module once it lands) ────────────────── */

interface RegistryContract {
  resolveJurisdiction(p: ResearchProperty): Jurisdiction
  destinationsFor(o: ResearchObject): AvailableDestination[]
  buildDestinationUrl(d: DestinationRecord, ctx: BuildContext): BuildResult
  classifyUrl(url: string): UrlClassification
  searchUrl(query: string, provider?: SearchProvider): string | null
  sanitizeUrl(raw: string): SanitizeResult
  propertySearchQuery(p: ResearchProperty): string | null
  companySearchQuery(c: ResearchCompany): string | null
}

/* ── fallback: the safest reading of the contract ─────────────────────── */

const SEARCH_BASE: Record<SearchProvider, string> = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
}

function fallbackSanitize(raw: string): SanitizeResult {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, reason: 'invalid_url' }
  let u: URL
  try { u = new URL(text) } catch { return { ok: false, reason: 'invalid_url' } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'unsafe_scheme' }
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' }
  if (!u.hostname) return { ok: false, reason: 'invalid_url' }
  return { ok: true, url: u.toString(), host: u.hostname.toLowerCase(), insecure: u.protocol === 'http:' }
}

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

function fallbackPropertyQuery(p: ResearchProperty): string | null {
  const street = clean(p.property_address) || clean(p.property_address_street) || clean(p.property_address_full).split(',')[0]?.trim() || ''
  const city = clean(p.property_address_city)
  const state = clean(p.property_address_state)
  const q = [street, city, state].filter(Boolean).join(', ')
  return q || null
}

const FALLBACK: RegistryContract = {
  resolveJurisdiction: (p) => ({ state: clean(p.property_address_state).toUpperCase() || null, county: clean(p.property_address_county_name) || null, key: null, covered: false, source: p.property_address_county_name ? 'county_field' : 'none' }),
  destinationsFor: () => [],
  buildDestinationUrl: () => ({ ok: false, reason: 'destination_disabled', message: 'Destination registry not loaded' }),
  classifyUrl: (url) => {
    const s = fallbackSanitize(url)
    return s.ok ? { ok: true, url: s.url, host: s.host, insecure: s.insecure, embed: 'UNKNOWN' } : { ok: false, embed: 'UNKNOWN', reason: s.reason }
  },
  searchUrl: (query, provider = 'google') => {
    const q = clean(query)
    return q ? `${SEARCH_BASE[provider] ?? SEARCH_BASE.google}${encodeURIComponent(q)}` : null
  },
  sanitizeUrl: fallbackSanitize,
  propertySearchQuery: fallbackPropertyQuery,
  companySearchQuery: (c) => clean(c.name) || null,
}

/*
 * REAL — the destinations module's public contract. FALLBACK stays as the
 * documented safe reading (and the test double for "registry unavailable").
 */
const R: RegistryContract = REAL

/** True when the real registry backs this adapter (the UI says "registry pending" otherwise). */
export const REGISTRY_LIVE = (R as RegistryContract) !== FALLBACK
/** The safest reading of the contract, for tests and as documentation. */
export const FALLBACK_REGISTRY: RegistryContract = FALLBACK

/* ── the Browser's own floor ─────────────────────────────────────────── */

export type GuardFailure = 'invalid_url' | 'unsafe_scheme' | 'credentials_in_url' | 'self_origin'

export type Guarded =
  | { ok: true; url: string; host: string; insecure: boolean }
  | { ok: false; reason: GuardFailure }

/** The LeadCommand origin(s) the Browser never frames. */
function selfOrigins(): string[] {
  if (typeof window === 'undefined' || !window.location?.origin) return []
  return [window.location.origin]
}

/** Every URL the Browser renders or opens passes here. */
export function guardUrl(raw: string, own: string[] = selfOrigins()): Guarded {
  const s = R.sanitizeUrl(raw)
  if (!s.ok) return s
  let origin = ''
  try { origin = new URL(s.url).origin } catch { return { ok: false, reason: 'invalid_url' } }
  if (own.includes(origin)) return { ok: false, reason: 'self_origin' }
  return s
}

/**
 * What the operator typed → a URL. "https://x", "x.gov/y" and "x.com" are
 * addresses; anything with a space, or without a dot, is a web search.
 */
export function interpretInput(input: string, provider: SearchProvider = 'google'): { kind: 'url'; url: string } | { kind: 'search'; url: string; query: string } | { kind: 'invalid'; reason: GuardFailure } {
  const text = input.trim()
  if (!text) return { kind: 'invalid', reason: 'invalid_url' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text) && !/^[^\s/:]+\.[a-z]{2,}:\d+/i.test(text)) {
    // a scheme that is not http(s): javascript:, data:, file:, about:, …
    return { kind: 'invalid', reason: 'unsafe_scheme' }
  }
  const looksLikeHost = !/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(text.replace(/^https?:\/\//i, ''))
  if (/^https?:\/\//i.test(text) || looksLikeHost) {
    const g = guardUrl(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    return g.ok ? { kind: 'url', url: g.url } : { kind: 'invalid', reason: g.reason }
  }
  const url = R.searchUrl(text, provider)
  return url ? { kind: 'search', url, query: text } : { kind: 'invalid', reason: 'invalid_url' }
}

/** The host to show — always the real one (anti-spoofing), never a page-supplied title. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return null }
}

/* ── pass-throughs ───────────────────────────────────────────────────── */

export const resolveJurisdiction = (p: ResearchProperty) => R.resolveJurisdiction(p)
export const destinationsFor = (o: ResearchObject) => R.destinationsFor(o)
export const buildDestinationUrl = (d: DestinationRecord, ctx: BuildContext) => R.buildDestinationUrl(d, ctx)
export const searchUrl = (q: string, provider?: SearchProvider) => R.searchUrl(q, provider)
export const propertySearchQuery = (p: ResearchProperty) => R.propertySearchQuery(p)
export const companySearchQuery = (c: ResearchCompany) => R.companySearchQuery(c)

/**
 * How a URL may be shown. The registry's embed mode is authority; the
 * Browser only frames EMBEDS, and only with the registry's proven sandbox.
 * Anything unknown is EXTERNAL REQUIRED.
 */
export function classify(url: string): { embed: EmbedMode; sandbox: string[]; destinationId: string | null } {
  let c = R.classifyUrl(url)
  if (!c.ok) return { embed: 'UNKNOWN', sandbox: [], destinationId: null }
  // a bare host the operator typed ("google.com", "zillow.com") is the same site as its www. form:
  // borrow that form's known REFUSAL so the card says why — never its permission to frame
  if (c.embed === 'UNKNOWN' && c.host && !c.host.startsWith('www.')) {
    try {
      const u = new URL(c.url ?? url)
      u.hostname = `www.${u.hostname}`
      const alt = R.classifyUrl(u.toString())
      if (alt.ok && alt.embed !== 'EMBEDS' && alt.embed !== 'UNKNOWN') c = { ...c, embed: alt.embed, destination_id: alt.destination_id }
    } catch { /* keep UNKNOWN */ }
  }
  const embed: EmbedMode = c.embed ?? 'UNKNOWN'
  return { embed, sandbox: embed === 'EMBEDS' ? [...(c.sandbox ?? [])] : [], destinationId: c.destination_id ?? null }
}

/** The kinds of research a property object can launch straight into. */
export const PROPERTY_DESTINATION_TYPES: DestinationType[] = ['ASSESSOR', 'COUNTY_PROPERTY_SEARCH', 'RECORDER', 'GIS', 'TAX', 'WEB_SEARCH']
