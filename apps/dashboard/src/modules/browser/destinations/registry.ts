/**
 * Registry queries: which destinations exist for an object.
 */
import type { AvailableDestination, DestinationRecord, ResearchObject, SearchProvider } from './types'
import { DESTINATIONS, REGISTRY_VERSION } from './registry-data'
import { buildDestinationUrl } from './build'
import { countyKey, normalizeCountyName, normalizeState, resolveJurisdiction } from './jurisdiction'
import { DEFAULT_SEARCH_PROVIDER } from './search'

export { REGISTRY_VERSION }

const BY_ID = new Map(DESTINATIONS.map((d) => [d.id, d]))

export function getDestination(id: string): DestinationRecord | undefined {
  return BY_ID.get(id)
}

export function allDestinations(): readonly DestinationRecord[] {
  return DESTINATIONS
}

const OFFICIAL_ORDER = ['ASSESSOR', 'COUNTY_PROPERTY_SEARCH', 'TAX', 'RECORDER', 'GIS', 'PERMITS', 'CODE', 'STATE_CORPORATE']
const MARKET_ORDER = ['ZILLOW', 'REDFIN', 'REALTOR', 'GOOGLE_MAPS', 'STREET_VIEW']

function groupOf(d: DestinationRecord): AvailableDestination['group'] {
  if (d.authority === 'Official') return 'official'
  if (d.authority === 'Search') return 'search'
  return 'market'
}

function rank(d: DestinationRecord): number {
  const o = OFFICIAL_ORDER.indexOf(d.destination_type)
  if (o >= 0) return o
  const m = MARKET_ORDER.indexOf(d.destination_type)
  return m >= 0 ? 100 + m : 200
}

export interface DestinationsForOptions {
  provider?: SearchProvider
  /** Include records whose build fails (e.g. "Parcel ID required"). Default true. */
  includeUnbuildable?: boolean
}

/**
 * Destinations that really exist for the object, ordered official → market → search.
 *  - property: covered county/city records (+ uncovered → county-site web search), market sources,
 *    web search. State corporate registries are NOT offered for a property (owner/company
 *    research is a separate explicit action on a company object).
 *  - company: the state's corporate registry (when covered) + company web search.
 */
export function destinationsFor(object: ResearchObject, opts: DestinationsForOptions = {}): AvailableDestination[] {
  const provider = opts.provider ?? DEFAULT_SEARCH_PROVIDER
  const includeUnbuildable = opts.includeUnbuildable ?? true
  let picked: DestinationRecord[] = []
  let ctx = {}

  if (object.type === 'property') {
    const p = object.property
    ctx = { property: p }
    const j = resolveJurisdiction(p)
    const citySlug = normalizeCountyName(p.property_address_city ?? null)
    picked = DESTINATIONS.filter((d) => {
      if (!d.enabled) return false
      if (d.scope.level === 'county') return j.covered && j.key === countyKey(d.scope.state, d.scope.county)
      if (d.scope.level === 'city') return j.covered && j.key === countyKey(d.scope.state, d.scope.county) && citySlug === d.scope.city
      if (d.scope.level === 'state') return false
      if (d.destination_type === 'COUNTY_PROPERTY_SEARCH') return !j.covered // generic fallback only when uncovered
      if (d.id === 'web-search-company') return false
      return true
    })
  } else if (object.type === 'company') {
    const st = normalizeState(object.company.state ?? null)
    ctx = { company: object.company }
    picked = DESTINATIONS.filter((d) => d.enabled && (
      (d.scope.level === 'state' && d.scope.state === st && d.destination_type === 'STATE_CORPORATE') || d.id === 'web-search-company'
    ))
  } else {
    picked = []
  }

  // De-duplicate identical URLs from different counties' shared records (e.g. GSCCCA).
  const out: AvailableDestination[] = []
  const seen = new Set<string>()
  for (const record of picked.sort((a, b) => rank(a) - rank(b))) {
    const build = buildDestinationUrl(record, ctx, provider)
    if (!build.ok && !includeUnbuildable) continue
    const key = build.ok ? `${record.destination_type}|${build.url}` : record.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ record, build, group: groupOf(record) })
  }
  return out
}
