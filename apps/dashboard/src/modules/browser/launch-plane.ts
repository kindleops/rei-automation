/**
 * THE RESEARCH LAUNCH PLANE — pure.
 *
 * For one subject, the destinations that REALLY exist (registry), grouped
 * Official records / Market sources / Web search, each with its authority,
 * confidence and how it will open. A destination the registry knows but
 * cannot build stays listed with the reason ("Parcel ID required") — never
 * a fabricated URL, never another county's site.
 */
import { classify, companySearchQuery, destinationsFor, hostOf, propertySearchQuery, searchUrl, type AvailableDestination, type DestinationType, type EmbedMode, type ResearchCompany, type ResearchProperty, type SearchProvider } from './registry'

export type LaunchGroup = 'official' | 'market' | 'search'

export interface LaunchItem {
  id: string
  label: string
  group: LaunchGroup
  type: DestinationType
  authority: string
  confidence: 'VERIFIED' | 'GENERIC' | 'UNAVAILABLE'
  embed: EmbedMode
  url: string | null
  host: string | null
  /** why it cannot open, in operator words */
  reason: string | null
  /** a search-page destination: what to paste into the site's own search */
  copy: { label: string; value: string } | null
  destinationId: string | null
}

export const GROUP_LABEL: Record<LaunchGroup, string> = { official: 'Official records', market: 'Market sources', search: 'Web search' }

const REASON: Record<string, string> = {
  parcel_id_required: 'Parcel ID required',
  address_required: 'Address required',
  coordinates_required: 'Coordinates required',
  company_name_required: 'Company name required',
  wrong_jurisdiction: 'Not this county',
  destination_disabled: 'Unavailable',
  unsafe_url: 'Unavailable',
}

function fromRegistry(d: AvailableDestination): LaunchItem {
  const r = d.record
  const built = d.build
  const url = built.ok ? built.url : null
  return {
    id: r.id,
    label: r.display_name,
    group: d.group,
    type: r.destination_type,
    authority: r.authority,
    confidence: r.confidence,
    embed: url ? classify(url).embed : r.embed,
    url,
    host: hostOf(url) ?? r.hosts[0] ?? null,
    reason: built.ok ? (r.enabled ? null : 'Unavailable') : (REASON[built.reason] ?? built.message),
    copy: built.ok ? built.copy ?? null : null,
    destinationId: r.id,
  }
}

function webSearchItem(query: string | null, provider: SearchProvider, id = 'web-search'): LaunchItem {
  const url = query ? searchUrl(query, provider) : null
  return {
    id,
    label: 'Search the web',
    group: 'search',
    type: 'WEB_SEARCH',
    authority: 'Search',
    confidence: 'GENERIC',
    embed: url ? classify(url).embed : 'UNKNOWN',
    url,
    host: hostOf(url),
    reason: url ? null : 'Address required',
    copy: null,
    destinationId: null,
  }
}

export function propertyLaunchItems(p: ResearchProperty, provider: SearchProvider = 'google'): LaunchItem[] {
  const items = destinationsFor({ type: 'property', property: p }).filter((d) => d.record.enabled || !d.build.ok).map(fromRegistry)
  if (!items.some((i) => i.type === 'WEB_SEARCH')) items.push(webSearchItem(propertySearchQuery(p), provider))
  return items
}

export function companyLaunchItems(c: ResearchCompany, provider: SearchProvider = 'google'): LaunchItem[] {
  const items = destinationsFor({ type: 'company', company: c }).filter((d) => d.record.enabled || !d.build.ok).map(fromRegistry)
  if (!items.some((i) => i.type === 'WEB_SEARCH')) items.push(webSearchItem(companySearchQuery(c), provider, 'web-search-company'))
  return items
}

export function grouped(items: LaunchItem[]): Array<{ group: LaunchGroup; label: string; items: LaunchItem[] }> {
  const order: LaunchGroup[] = ['official', 'market', 'search']
  return order.map((g) => ({ group: g, label: GROUP_LABEL[g], items: items.filter((i) => i.group === g) })).filter((g) => g.items.length)
}

/** What "County records" means, in preference order. */
const FALLBACKS: Partial<Record<DestinationType, DestinationType[]>> = {
  COUNTY_PROPERTY_SEARCH: ['COUNTY_PROPERTY_SEARCH', 'ASSESSOR', 'RECORDER', 'TAX'],
  ASSESSOR: ['ASSESSOR', 'COUNTY_PROPERTY_SEARCH'],
}

/**
 * The item a direct action ("Open assessor") lands on: the first buildable
 * one of that kind, or — when none can open — the reason the closest one
 * gives, or null when this jurisdiction has none at all.
 */
export function pickItem(items: LaunchItem[], type: DestinationType): { item: LaunchItem | null; reason: string | null } {
  const chain = FALLBACKS[type] ?? [type]
  for (const t of chain) {
    const hit = items.find((i) => i.type === t && i.url && !i.reason)
    if (hit) return { item: hit, reason: null }
  }
  const blocked = items.find((i) => chain.includes(i.type))
  return { item: null, reason: blocked?.reason ?? null }
}

export const TYPE_NOUN: Record<DestinationType, string> = {
  WEB_SEARCH: 'web search',
  ASSESSOR: 'assessor',
  TAX: 'tax records',
  RECORDER: 'recorder',
  GIS: 'GIS',
  PERMITS: 'permits',
  CODE: 'code enforcement',
  ZILLOW: 'Zillow',
  REDFIN: 'Redfin',
  REALTOR: 'Realtor.com',
  GOOGLE_MAPS: 'Google Maps',
  STREET_VIEW: 'Street View',
  COUNTY_PROPERTY_SEARCH: 'county records',
  STATE_CORPORATE: 'state corporate records',
}
