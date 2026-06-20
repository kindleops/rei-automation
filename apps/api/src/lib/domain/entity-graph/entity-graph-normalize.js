import { MARKET_ALIASES, normalizeMarketLabel } from '../../config/market-sending-zones.js'

export function clean(value) {
  return String(value ?? '').trim()
}

export function lower(value) {
  return clean(value).toLowerCase()
}

export function int(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, 0), max)
}

export function normalizePhoneE164(value) {
  const raw = clean(value)
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (raw.startsWith('+') && digits.length >= 10) return `+${digits}`
  return digits.length >= 10 ? `+${digits}` : null
}

export function normalizeEmail(value) {
  const email = lower(value)
  return email || null
}

export function normalizeAddressSearch(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeSearchQuery(value) {
  return clean(value).replace(/[,%()]/g, ' ')
}

export function phoneTail(value) {
  const e164 = normalizePhoneE164(value)
  if (!e164) return null
  return e164.slice(-4)
}

export function parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

export function relationshipLabel(prospect, owner) {
  if (prospect?.likely_owner) return 'Likely Owner'
  if (prospect?.likely_renting) return 'Linked Person'
  if (owner?.owner_type_guess) {
    const type = lower(owner.owner_type_guess)
    if (type.includes('trust')) return 'Trust Contact'
    if (type.includes('llc') || type.includes('corp')) return 'Entity Contact'
  }
  return 'Associated Contact'
}

/** Explicit city/locality → canonical metro mappings (configured, not guessed). */
const CITY_TO_CANONICAL_MARKET = Object.freeze({
  'whittier, ca': 'Los Angeles, CA',
  'woodland hills, ca': 'Los Angeles, CA',
  'west hollywood, ca': 'Los Angeles, CA',
  'burbank, ca': 'Los Angeles, CA',
  'glendale, ca': 'Los Angeles, CA',
  'pasadena, ca': 'Los Angeles, CA',
  'torrance, ca': 'Los Angeles, CA',
  'inglewood, ca': 'Los Angeles, CA',
  'santa monica, ca': 'Los Angeles, CA',
  'long beach, ca': 'Los Angeles, CA',
  'winter park, fl': 'Orlando, FL',
  'winter garden, fl': 'Orlando, FL',
  'kissimmee, fl': 'Orlando, FL',
  'sanford, fl': 'Orlando, FL',
  'wayzata, mn': 'Minneapolis, MN',
  'bloomington, mn': 'Minneapolis, MN',
  'eden prairie, mn': 'Minneapolis, MN',
  'st. paul, mn': 'Minneapolis, MN',
  'fort worth, tx': 'Dallas, TX',
  'arlington, tx': 'Dallas, TX',
  'plano, tx': 'Dallas, TX',
  'irving, tx': 'Dallas, TX',
})

const NORMALIZED_ALIASES = new Map(
  Object.entries(MARKET_ALIASES).map(([alias, canonical]) => [
    lower(normalizeMarketLabel(alias)),
    normalizeMarketLabel(canonical),
  ]),
)

const VERIFIED_METRO_PREFIXES = [
  'los angeles',
  'orlando',
  'minneapolis',
  'dallas',
  'houston',
  'miami',
  'atlanta',
  'charlotte',
  'jacksonville',
  'riverside',
  'sacramento',
  'phoenix',
  'chicago',
  'denver',
  'seattle',
  'portland',
  'las vegas',
  'san antonio',
  'austin',
  'tampa',
  'nashville',
  'detroit',
  'philadelphia',
  'boston',
  'new york',
  'tulsa',
  'oklahoma city',
  'columbus',
  'rochester',
  'providence',
  'stockton',
  'bakersfield',
  'fresno',
  'kansas city',
]

function marketStateFromLabel(value) {
  const normalized = normalizeMarketLabel(value)
  if (!normalized.includes(',')) return ''
  return clean(normalized.split(',').at(-1) || '').toUpperCase()
}

function looksLikeMetroLabel(value) {
  const normalized = lower(normalizeMarketLabel(value))
  if (!normalized) return false
  return VERIFIED_METRO_PREFIXES.some((metro) => normalized.startsWith(metro))
}

function cleanAddressPart(value) {
  const raw = clean(value)
  if (!raw || raw === ',' || /^,+\s*$/.test(raw)) return ''
  return raw.replace(/^,\s*/, '').replace(/,\s*$/, '').trim()
}

function normalizeState(value) {
  const state = clean(value).toUpperCase()
  if (!state || state === ',' || state.length < 2) return ''
  return state.length === 2 ? state : state.slice(0, 2)
}

function extractStreetFromFull(full) {
  const raw = clean(full)
  if (!raw || raw.startsWith(',')) return ''
  const commaIdx = raw.indexOf(',')
  if (commaIdx > 0) return cleanAddressPart(raw.slice(0, commaIdx))
  return cleanAddressPart(raw)
}

function isSingleFamilyAsset(assetType) {
  const normalized = lower(assetType)
  return normalized.includes('sfr')
    || normalized.includes('single family')
    || normalized.includes('single-family')
    || normalized === 'sf'
    || normalized === 'residential'
}

export function normalizeAssetTypeLabel(value) {
  const raw = clean(value)
  if (!raw) return null
  const normalized = lower(raw)
  if (isSingleFamilyAsset(raw)) return 'SFR'
  if (normalized.includes('multi')) return 'Multifamily'
  if (normalized.includes('commercial')) return 'Commercial'
  if (normalized.includes('land')) return 'Land'
  if (normalized.includes('condo')) return 'Condo'
  if (normalized.includes('town')) return 'Townhome'
  return raw
}

const PHONE_TYPE_LABELS = Object.freeze({
  W: 'Wireless',
  L: 'Landline',
  V: 'VoIP',
  C: 'Cellular',
  M: 'Mobile',
  WIRELESS: 'Wireless',
  LANDLINE: 'Landline',
  VOIP: 'VoIP',
  MOBILE: 'Mobile',
  CELL: 'Cellular',
})

export function formatPhoneTypeLabel(value) {
  const raw = clean(value)
  if (!raw) return null
  const key = raw.toUpperCase()
  return PHONE_TYPE_LABELS[key] || PHONE_TYPE_LABELS[lower(raw)] || raw
}

export function formatReadablePhone(value) {
  const e164 = normalizePhoneE164(value)
  if (!e164) return clean(value) || null
  const digits = e164.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return e164
}

export function formatContactMethodPresentation(row, entityType = 'phone') {
  const isPhone = entityType === 'phone'
  const wrongNumber = Boolean(isPhone && row.wrong_number_at)
  const score = Number(row.contact_score_final)
  const hasScore = Number.isFinite(score) && score > 0
  const eligible = isPhone ? !wrongNumber && hasScore : hasScore || true
  const reachable = isPhone ? !wrongNumber && hasScore : hasScore

  return {
    contactType: isPhone ? 'Phone' : 'Email',
    phoneType: isPhone ? formatPhoneTypeLabel(row.phone_type) : null,
    eligibility: wrongNumber ? 'Wrong Number' : eligible ? 'Eligible' : 'Not Eligible',
    reachability: wrongNumber ? 'Unreachable' : reachable ? 'Reachable' : 'Unknown',
    wrongNumber,
    suppressed: false,
    optedOut: false,
    displayValue: isPhone
      ? (formatReadablePhone(row.canonical_e164 || row.phone) || row.canonical_e164 || row.phone)
      : (row.email_normalized || row.email),
  }
}

function isTrustedCanonicalRegion(region, { city, state, raw }) {
  if (!region || !looksLikeMetroLabel(region)) return false

  const regionState = marketStateFromLabel(region)
  const propertyState = normalizeState(state)
  if (propertyState && regionState && propertyState !== regionState) return false

  const cityClean = cleanAddressPart(city)
  const propertyStateForKey = propertyState || regionState
  const cityKey = cityClean && propertyStateForKey ? lower(`${cityClean}, ${propertyStateForKey}`) : ''
  const rawKey = lower(normalizeMarketLabel(raw))

  if (cityKey && CITY_TO_CANONICAL_MARKET[cityKey] === region) return true
  if (cityKey && NORMALIZED_ALIASES.get(cityKey) === region) return true
  if (rawKey && lower(region) === rawKey) return true

  const regionCity = lower(cleanAddressPart(region.split(',')[0]))
  const propCity = lower(cityClean)
  if (propCity && regionCity && propCity === regionCity) return true

  return false
}

export function computeContactCoverage({ linkedPeople, reachablePeople } = {}) {
  const people = Number(linkedPeople)
  const reachable = Number(reachablePeople)
  if (!Number.isFinite(people) || people <= 0) return null
  if (!Number.isFinite(reachable) || reachable < 0) return null
  const pct = (reachable / people) * 100
  return Math.min(100, Math.round(pct * 10) / 10)
}

export function clampCoveragePct(value) {
  if (value === null || value === undefined) return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Math.min(100, Math.round(num * 10) / 10)
}

/**
 * Single authoritative market resolver for Entity Graph.
 * Order: trusted stored canonical → explicit city map → aliases → verified metro label → unmapped locality.
 */
export function resolveEntityGraphMarket({ market, marketRegion, city, state } = {}) {
  const region = normalizeMarketLabel(marketRegion)
  const raw = normalizeMarketLabel(market)
  const cityClean = cleanAddressPart(city)
  const stateClean = normalizeState(state) || marketStateFromLabel(raw) || marketStateFromLabel(region)

  if (isTrustedCanonicalRegion(region, { city: cityClean, state: stateClean, raw })) {
    return {
      canonicalKey: region,
      displayMarket: region,
      isUnmapped: false,
      state: stateClean || marketStateFromLabel(region) || null,
    }
  }

  const cityStateKey = cityClean && stateClean ? lower(`${cityClean}, ${stateClean}`) : ''
  const rawKey = lower(raw)

  if (cityStateKey && CITY_TO_CANONICAL_MARKET[cityStateKey]) {
    const canonical = CITY_TO_CANONICAL_MARKET[cityStateKey]
    return {
      canonicalKey: canonical,
      displayMarket: canonical,
      isUnmapped: false,
      state: marketStateFromLabel(canonical),
    }
  }

  if (rawKey && CITY_TO_CANONICAL_MARKET[rawKey]) {
    const canonical = CITY_TO_CANONICAL_MARKET[rawKey]
    return {
      canonicalKey: canonical,
      displayMarket: canonical,
      isUnmapped: false,
      state: marketStateFromLabel(canonical),
    }
  }

  const alias = NORMALIZED_ALIASES.get(cityStateKey) || NORMALIZED_ALIASES.get(rawKey)
  if (alias) {
    return {
      canonicalKey: alias,
      displayMarket: alias,
      isUnmapped: false,
      state: marketStateFromLabel(alias),
    }
  }

  if (raw && looksLikeMetroLabel(raw) && (!stateClean || !marketStateFromLabel(raw) || marketStateFromLabel(raw) === stateClean)) {
    return {
      canonicalKey: raw,
      displayMarket: raw,
      isUnmapped: false,
      state: stateClean || marketStateFromLabel(raw) || null,
    }
  }

  const localityParts = []
  if (cityClean) localityParts.push(cityClean)
  else if (raw) {
    const first = cleanAddressPart(raw.split(',')[0])
    if (first && !looksLikeMetroLabel(first)) localityParts.push(first)
  }
  if (stateClean) localityParts.push(stateClean)
  const locality = localityParts.filter(Boolean).join(', ')
  const displayMarket = locality ? `Unmapped · ${locality}` : (raw ? `Unmapped · ${raw}` : null)

  return {
    canonicalKey: displayMarket || raw || region || 'Unknown',
    displayMarket: displayMarket || raw || region || 'Unknown',
    isUnmapped: true,
    state: stateClean || null,
  }
}

/** @deprecated Use resolveEntityGraphMarket — kept for callers expecting a string key. */
export function canonicalizeEntityGraphMarket(market, marketRegion, city, state) {
  return resolveEntityGraphMarket({ market, marketRegion, city, state }).canonicalKey
}

export function canonicalMarketKey(market, marketRegion, city, state) {
  return resolveEntityGraphMarket({ market, marketRegion, city, state }).canonicalKey || ''
}

export function formatPropertySummary(row) {
  const street = cleanAddressPart(row.property_address_street) || extractStreetFromFull(row.property_address_full)
  const city = cleanAddressPart(row.property_address_city)
  const state = normalizeState(row.property_address_state)
  const zip = cleanAddressPart(row.property_address_zip || row.property_zip)
  const assetType = normalizeAssetTypeLabel(row.normalized_asset_class || row.property_type)
  const market = resolveEntityGraphMarket({
    market: row.market,
    marketRegion: row.market_region,
    city,
    state,
  })

  let units = row.units_count
  if (units !== null && units !== undefined && units !== '') {
    const parsed = Number(units)
    if (Number.isFinite(parsed)) {
      if (assetType === 'SFR' && parsed <= 0) units = undefined
      else units = parsed
    } else {
      units = undefined
    }
  } else {
    units = undefined
  }

  const subtitleParts = [city, state, zip].filter(Boolean)
  const title = street && street.length >= 3 && !street.startsWith(',') ? street : 'Address incomplete'

  return {
    title,
    subtitle: subtitleParts.join(', '),
    assetType: assetType || undefined,
    units,
    marketLabel: market.displayMarket,
    marketKey: market.canonicalKey,
    isUnmappedMarket: market.isUnmapped,
    city: city || undefined,
    state: state || undefined,
    zip: zip || undefined,
    value: row.estimated_value ?? undefined,
    equity: row.equity_percent ?? row.equity_amount ?? undefined,
    acquisitionScore: row.final_acquisition_score ?? undefined,
    flagCount: parseJsonArray(row.property_flags_text).length
      || (row.property_flags_text ? String(row.property_flags_text).split(/[;,|]/).filter(Boolean).length : 0) || undefined,
    flags: row.property_flags_text || undefined,
  }
}