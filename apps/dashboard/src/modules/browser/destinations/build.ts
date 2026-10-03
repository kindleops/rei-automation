/**
 * buildDestinationUrl — the ONLY way a registry record becomes a URL.
 *
 * Guarantees:
 *  - never fabricates a parcel id: missing → parcel_id_required, malformed → parcel_id_invalid
 *    (both carry the county's own search page as `fallback`);
 *  - never sends the operator to the wrong county: a county/city-scoped record only builds for
 *    a property that resolves to that jurisdiction;
 *  - never becomes an open redirect: every input is validated + encoded, and the final URL is
 *    re-parsed and must be https on one of the record's declared hosts.
 */
import type { BuildContext, BuildResult, DestinationRecord, ResearchProperty, SearchProvider } from './types'
import { resolveJurisdiction, countyKey, normalizeCountyName, normalizeState } from './jurisdiction'
import { hostIn, sanitizeUrl } from './sanitize'
import { companySearchQuery, propertySearchQuery, searchUrl, streetLine, DEFAULT_SEARCH_PROVIDER } from './search'

const fail = (reason: Extract<BuildResult, { ok: false }>['reason'], message: string, fallback?: { url: string; label: string }): BuildResult =>
  ({ ok: false, reason, message, ...(fallback ? { fallback } : {}) })

function finalize(rec: DestinationRecord, url: string, copy?: { label: string; value: string }): BuildResult {
  const s = sanitizeUrl(url)
  if (!s.ok || s.insecure || !hostIn(s.host, rec.hosts)) return fail('unsafe_url', 'Destination URL failed validation')
  return copy && copy.value ? { ok: true, url: s.url, copy } : { ok: true, url: s.url }
}

function zip5(p?: ResearchProperty): string | null {
  const z = (p?.property_address_zip ?? '').trim().match(/^(\d{5})(?:-?\d{4})?$/)
  return z ? z[1] : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

function coords(p?: ResearchProperty): { lat: number; lng: number } | null {
  const lat = num(p?.latitude)
  const lng = num(p?.longitude)
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null
  return { lat, lng }
}

/** Zillow's public address URL: words joined by "-", then "_rb/". Only [A-Za-z0-9] survive. */
function zillowSlug(p: ResearchProperty): string | null {
  const q = propertySearchQuery(p)
  const zip = zip5(p)
  if (!q) return null
  const words = `${q} ${zip ?? ''}`.split(/[^A-Za-z0-9]+/).filter(Boolean)
  return words.length >= 3 ? words.join('-') : null
}

function copyFor(rec: DestinationRecord, ctx: BuildContext): { label: string; value: string } | undefined {
  const p = ctx.property
  switch (rec.copy_hint) {
    case 'apn':
      if (p?.apn_parcel_id?.trim()) return { label: 'Parcel ID', value: p.apn_parcel_id.trim() }
      return addressCopy(p)
    case 'address':
    case 'street':
      return addressCopy(p)
    case 'company_name':
      return ctx.company?.name?.trim() ? { label: 'Company', value: ctx.company.name.trim() } : undefined
    default:
      return undefined
  }
}

function addressCopy(p?: ResearchProperty): { label: string; value: string } | undefined {
  if (!p) return undefined
  const street = streetLine(p)
  return street ? { label: 'Address', value: street } : undefined
}

/** True when the property resolves to the record's county (and city, for city-scoped records). */
function inJurisdiction(rec: DestinationRecord, p?: ResearchProperty): boolean {
  if (rec.scope.level === 'national') return true
  if (rec.scope.level === 'state') return true // state registries are chosen by the company's state, not the property
  const j = resolveJurisdiction(p)
  if (!j.covered || j.key !== countyKey(rec.scope.state, rec.scope.county)) return false
  if (rec.scope.level === 'city') {
    const city = normalizeCountyName(p?.property_address_city ?? null)
    return city === rec.scope.city
  }
  return true
}

export function buildDestinationUrl(rec: DestinationRecord, ctx: BuildContext = {}, provider: SearchProvider = DEFAULT_SEARCH_PROVIDER): BuildResult {
  if (!rec.enabled) return fail('destination_disabled', `${rec.display_name} is disabled`)
  const p = ctx.property
  const spec = rec.url

  if ((rec.scope.level === 'county' || rec.scope.level === 'city') && !inJurisdiction(rec, p)) {
    return fail('wrong_jurisdiction', `${rec.display_name} does not cover this property`)
  }

  switch (spec.kind) {
    case 'static':
      return finalize(rec, spec.href, copyFor(rec, ctx))

    case 'apn': {
      const fallback = { url: spec.search_href, label: `${rec.display_name} search` }
      const raw = p?.apn_parcel_id?.trim()
      if (!raw) return fail('parcel_id_required', 'Parcel ID required', fallback)
      const norm = spec.normalize === 'digits' ? raw.replace(/\D/g, '') : raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
      if (!new RegExp(spec.pattern).test(norm)) return fail('parcel_id_invalid', `Parcel ID "${raw}" is not in this county's format`, fallback)
      return finalize(rec, spec.template.replace('{apn}', encodeURIComponent(norm)))
    }

    case 'company': {
      const name = ctx.company?.name?.replace(/\s+/g, ' ').trim()
      if (!name) return fail('company_name_required', 'Company name required')
      return finalize(rec, spec.template.replace('{name}', encodeURIComponent(name.slice(0, 120))))
    }

    case 'zip': {
      const z = zip5(p)
      if (!z) return fail('address_required', 'ZIP code required')
      return finalize(rec, spec.template.replace('{zip}', z), copyFor(rec, ctx))
    }

    case 'zillow_address': {
      const slug = p ? zillowSlug(p) : null
      if (!slug) return fail('address_required', 'Street address required')
      return finalize(rec, `https://www.zillow.com/homes/${slug}_rb/`)
    }

    case 'maps_query': {
      const q = p ? propertySearchQuery(p) : null
      if (!q) return fail('address_required', 'Street address required')
      return finalize(rec, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`)
    }

    case 'street_view': {
      const c = coords(p)
      if (!c) return fail('coordinates_required', 'Coordinates required')
      return finalize(rec, `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${c.lat.toFixed(6)},${c.lng.toFixed(6)}`)
    }

    case 'web_search': {
      if (spec.subject === 'property') {
        const q = p ? propertySearchQuery(p) : null
        if (!q) return fail('address_required', 'Street address required')
        return finalize(rec, searchUrl(q, provider))
      }
      if (spec.subject === 'company') {
        const q = ctx.company ? companySearchQuery(ctx.company) : null
        if (!q) return fail('company_name_required', 'Company name required')
        return finalize(rec, searchUrl(q, provider))
      }
      const j = resolveJurisdiction(p)
      const st = j.state ?? normalizeState(p?.property_address_state ?? null)
      if (!st) return fail('address_required', 'State required')
      const countyName = (p?.property_address_county_name ?? '').replace(/[^A-Za-z .'-]/g, '').trim()
      const q = countyName ? `${countyName} County ${st} property search` : `${st} county property records search`
      return finalize(rec, searchUrl(q, provider))
    }
  }
}
