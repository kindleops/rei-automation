/**
 * Jurisdiction resolution from canonical property fields.
 *
 * Authority: properties.property_address_county_name + property_address_state (99.99% filled
 * in prod, 2026-10-02). A tiny city table is used ONLY for cities that lie entirely inside a
 * single county; multi-county cities (Dallas, Houston, Atlanta, Chicago…) are deliberately
 * absent — never send the operator to the wrong county.
 */
import type { Jurisdiction, ResearchProperty } from './types'
import { COVERED_COUNTIES } from './registry-data'

const STATES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY',
  LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
}
const CODES = new Set(Object.values(STATES))

export function normalizeState(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.trim().toUpperCase().replace(/\s+/g, ' ')
  if (CODES.has(t)) return t
  return STATES[t] ?? null
}

/**
 * Registry slug for a county name: case/space/punctuation-insensitive, "County"/"Parish"
 * suffix dropped, "Saint" → "st". "De Kalb" (as stored in prod) and "DeKalb" both → "dekalb";
 * "Miami-Dade" → "miamidade".
 */
export function normalizeCountyName(raw: string | null | undefined): string | null {
  if (!raw) return null
  let t = raw.trim().toLowerCase()
  t = t.replace(/\b(county|parish|borough)\b/g, ' ')
  t = t.replace(/\bsaint\b/g, 'st')
  t = t.replace(/[^a-z]/g, '')
  return t || null
}

/** Cities wholly inside one county (consolidated or single-county). Keyed "ST:city". */
const SINGLE_COUNTY_CITIES: Record<string, string> = {
  'MN:minneapolis': 'hennepin',
  'IN:indianapolis': 'marion',
  'FL:jacksonville': 'duval',
  'FL:miami': 'miamidade',
  'FL:hialeah': 'miamidade',
  'FL:tampa': 'hillsborough',
  'FL:fortlauderdale': 'broward',
  'NC:charlotte': 'mecklenburg',
  'CA:losangeles': 'losangeles',
  'AZ:phoenix': 'maricopa',
}

export function countyKey(state: string, countySlug: string): string {
  return `${state}:${countySlug}`
}

export function resolveJurisdiction(property: ResearchProperty | null | undefined): Jurisdiction {
  const state = normalizeState(property?.property_address_state ?? null)
  if (!state) return { state: null, county: null, key: null, covered: false, source: 'none' }
  const slug = normalizeCountyName(property?.property_address_county_name ?? null)
  if (slug) {
    const key = countyKey(state, slug)
    const covered = COVERED_COUNTIES[key]
    return { state, county: covered?.name ?? property?.property_address_county_name?.trim() ?? null, key: covered ? key : null, covered: !!covered, source: 'county_field' }
  }
  const city = (property?.property_address_city ?? '').toLowerCase().replace(/[^a-z]/g, '')
  const viaCity = city ? SINGLE_COUNTY_CITIES[`${state}:${city}`] : undefined
  if (viaCity) {
    const key = countyKey(state, viaCity)
    const covered = COVERED_COUNTIES[key]
    if (covered) return { state, county: covered.name, key, covered: true, source: 'city_lookup' }
  }
  return { state, county: null, key: null, covered: false, source: 'none' }
}
