/**
 * Web search + typed-input resolution.
 *
 * Privacy: property queries carry street, city and state ONLY — never owner, phone,
 * notes, scores, ZIP+4, parcel or any LeadCommand identifier. Company/owner research is
 * a separate, explicit operator action (companySearchQuery). Nothing here runs a search
 * on its own; callers pass the result to the Browser only after an operator gesture.
 */
import type { ResearchCompany, ResearchProperty, SearchProvider, TypedInputResolution } from './types'
import { sanitizeUrl } from './sanitize'
import { normalizeState } from './jurisdiction'

export const SEARCH_PROVIDERS: Readonly<Record<SearchProvider, { label: string; host: string; base: string }>> = {
  google: { label: 'Google', host: 'www.google.com', base: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', host: 'www.bing.com', base: 'https://www.bing.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', host: 'duckduckgo.com', base: 'https://duckduckgo.com/?q=' },
}

export const DEFAULT_SEARCH_PROVIDER: SearchProvider = 'google'

const MAX_QUERY = 256

function cleanQuery(q: string): string {
  // eslint-disable-next-line no-control-regex
  return q.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY)
}

export function searchUrl(query: string, provider: SearchProvider = DEFAULT_SEARCH_PROVIDER): string {
  const p = SEARCH_PROVIDERS[provider] ?? SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER]
  return p.base + encodeURIComponent(cleanQuery(query))
}

function titleCaseCity(c: string): string {
  return c.trim().replace(/\s+/g, ' ')
}

/** Street line only — from the canonical street column, else the first segment of the full address. */
export function streetLine(p: ResearchProperty): string | null {
  const s = (p.property_address ?? p.property_address_street ?? '').trim()
  if (s) return s.replace(/\s+/g, ' ')
  const full = (p.property_address_full ?? '').trim()
  if (!full) return null
  const first = full.split(',')[0]?.trim()
  // A full address with no street ("Tampa, FL 33604") must not be searched as if it were the property.
  if (!first || !/\d/.test(first)) return null
  if (p.property_address_city && first.toLowerCase() === p.property_address_city.trim().toLowerCase()) return null
  return first
}

/** "street, city, ST" — or null when the street is unknown (never search a city alone as if it were the property). */
export function propertySearchQuery(p: ResearchProperty): string | null {
  const street = streetLine(p)
  if (!street) return null
  const city = p.property_address_city ? titleCaseCity(p.property_address_city) : ''
  const st = normalizeState(p.property_address_state) ?? ''
  return cleanQuery([street, city, st].filter(Boolean).join(', '))
}

/** Explicit company research: the entity name (+ state when known). */
export function companySearchQuery(c: ResearchCompany): string | null {
  const name = cleanQuery(c.name ?? '')
  if (!name) return null
  const st = normalizeState(c.state ?? null)
  return cleanQuery(st ? `"${name}" ${st}` : `"${name}"`)
}

const HOSTLIKE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i

/**
 * Address-field resolution. A full http(s) URL → that URL. A bare host ("hcad.org/x")
 * → https://. Any other scheme → invalid (never "search for javascript:…"). Else → web search.
 */
export function resolveTypedInput(text: string, provider: SearchProvider = DEFAULT_SEARCH_PROVIDER): TypedInputResolution {
  const t = (text ?? '').trim()
  if (!t) return { kind: 'invalid', reason: 'empty' }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https' && !/^[^\s/]+:\d+/.test(t)) {
    return { kind: 'invalid', reason: 'unsafe_scheme' }
  }
  if (scheme === 'http' || scheme === 'https') {
    const r = sanitizeUrl(t)
    return r.ok ? { kind: 'url', url: r.url, host: r.host, insecure: r.insecure } : { kind: 'invalid', reason: r.reason }
  }
  if (!/\s/.test(t) && HOSTLIKE.test(t)) {
    const r = sanitizeUrl(`https://${t}`)
    if (r.ok) return { kind: 'url', url: r.url, host: r.host, insecure: false }
  }
  const query = cleanQuery(t)
  return { kind: 'search', url: searchUrl(query, provider), query }
}
