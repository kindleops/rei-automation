/**
 * DEAL RECORD — every populated field on the property, its owner and its
 * people, grouped the way an underwriter reads them. Pure: takes rows, returns
 * sections. Also shapes comps with their full property detail.
 *
 * Rules:
 *   - Only populated values render (no grid of dashes); 0 on a money field is
 *     "not recorded", not "$0".
 *   - Raw ids, hashes, export bookkeeping and legacy Podio-era scores are never
 *     shown (ENTITY_GRAPH_WITHHELD_FIELDS + the SKIP set below).
 *   - Individual buyers on comps are never named (W8C serving rule): company
 *     buyers show their entity name, people show as "Individual".
 */

const clean = (v) => String(v ?? '').trim()
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

const money = (n) => {
  const v = num(n)
  if (v === null || v === 0) return null
  return `$${Math.round(v).toLocaleString('en-US')}`
}
const int = (n) => { const v = num(n); return v === null ? null : Math.round(v).toLocaleString('en-US') }
const pct = (n) => { const v = num(n); return v === null ? null : `${Math.round(v * (Math.abs(v) <= 1 ? 100 : 1))}%` }
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : null)
const text = (v) => {
  if (Array.isArray(v)) return v.length ? v.map(clean).filter(Boolean).join(' · ') : null
  if (v && typeof v === 'object') return null
  const s = clean(v)
  return s ? s : null
}
const date = (v) => {
  const t = Date.parse(v || '')
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}
const humanize = (key) => clean(key).replace(/_/g, ' ').replace(/\bsqft\b/i, 'sq ft').replace(/^\w/, (c) => c.toUpperCase())

const SKIP = /(^|_)(id|ids|key|hash|uid|json|seed|cohort|persona|family|slot|upsert|row|export|source_system|version|rank_order|fips|latitude|longitude)$|^(created_at|updated_at|exported_at_utc|master_key|individual_key|matching_flags|raw_|address_full$|address_base)/

/** [label, key, formatter] per section. Keys not listed land in "Other". */
const PARCEL_GROUPS = [
  ['Structure', [
    ['Property type', 'property_type', text], ['Use', 'property_use', text], ['Units', 'units_count', int],
    ['Bedrooms', 'bedrooms', int], ['Bathrooms', 'baths', text], ['Living area', 'building_sqft', (v) => (int(v) ? `${int(v)} sq ft` : null)],
    ['Stories', 'stories', text], ['Rooms', 'total_rooms', (v) => (num(v) ? int(v) : null)], ['Year built', 'year_built', text],
    ['Effective year', 'effective_year_built', text], ['Condition', 'building_condition', text], ['Quality', 'building_quality', text],
    ['Construction', 'construction_type', text], ['Exterior', 'exterior_walls', text], ['Roof', 'roof_cover', text], ['Roof type', 'roof_type', text],
    ['Heating', 'heating_type', text], ['Cooling', 'air_conditioning', text], ['Garage spaces', 'garage_spaces', int],
    ['Garage area', 'garage_sqft', (v) => (int(v) ? `${int(v)} sq ft` : null)], ['Pool', 'pool', text], ['Basement', 'basement', text],
  ]],
  ['Lot & location', [
    ['Lot size', 'lot_sqft', (v) => (int(v) ? `${int(v)} sq ft` : null)], ['Acreage', 'lot_acreage', text], ['Zoning', 'zoning', text],
    ['Flood zone', 'flood_zone', text], ['Subdivision', 'subdivision_name', text], ['Legal', 'legal_description', text],
    ['Lot #', 'lot_number', text], ['APN', 'apn', text], ['County', 'county_name', text], ['Census tract', 'census_tract', text],
    ['School district', 'school_district', text], ['Land use code', 'county_land_use_code', text], ['Vacant', 'is_vacant', yesNo],
  ]],
  ['Value & equity', [
    ['AVM', 'estimated_value', money], ['AVM low', 'value_low', money], ['AVM high', 'value_high', money],
    ['AVM confidence', 'value_confidence', text], ['Valued on', 'valuation_date', date], ['Equity', 'estimated_equity', money],
    ['Equity %', 'equity_percent', (v) => (num(v) === null ? null : `${Math.round(num(v))}%`)], ['Assessed total', 'assessed_total_value', money],
    ['Assessed year', 'assessed_year', text], ['Calc. total', 'calc_total_value', money], ['Calc. land', 'calc_land_value', money],
    ['Calc. improvements', 'calc_improvement_value', money], ['Improvement share', 'improvement_pct', pct],
    ['Repair estimate', 'estimated_repair_cost', money], ['Repair $/sq ft', 'repair_cost_per_sqft', (v) => (num(v) ? `$${num(v)}` : null)],
  ]],
  ['Debt & liens', [
    ['Open balance (est.)', 'total_loan_balance', money], ['Original loans', 'total_loan_amount', money],
    ['Payment (est.)', 'total_loan_payment', (v) => (money(v) ? `${money(v)}/mo` : null)], ['Recorded mortgages', 'mortgage_count', int],
    ['Open mortgages', 'open_mortgage_count', int], ['Liens', 'lien_count', int], ['HOA liens', 'hoa_lien_count', int],
    ['Active lien', 'active_lien', yesNo], ['HOA fee', 'hoa_fee_amount', money],
  ]],
  ['Tax', [
    ['Annual tax', 'tax_amount', money], ['Tax year', 'tax_year', text], ['Delinquent', 'tax_delinquent', yesNo],
  ]],
  ['Ownership', [
    ['Owner of record', 'owner_name', text], ['Owner 1', 'owner_1_name', text], ['Owner 2', 'owner_2_name', text],
    ['Occupancy', 'owner_status', text], ['Owner location', 'owner_location', text], ['Corporate owner', 'is_corporate_owner', yesNo],
    ['Trust', 'is_trust', yesNo], ['Bank-owned', 'owner_is_bank', yesNo], ['Out-of-state owner', 'out_of_state_owner', yesNo],
    ['Owns other property', 'owner_has_multiple_properties', yesNo], ['Mailing address', 'mail_address_full', text],
    ['Companies linked', 'company_count', int], ['Contacts on file', 'contact_count', int], ['Phones on file', 'phone_record_count', int],
    ['Emails on file', 'email_record_count', int],
  ]],
  ['Distress & market', [
    ['Signals', 'distress_flags', text], ['Preforeclosure', 'preforeclosure_status', text], ['Preforeclosure type', 'preforeclosure_type', text],
    ['HOA foreclosure', 'is_hoa_foreclosure', yesNo], ['Auction date', 'auction_date', date], ['Market status', 'market_status', text],
    ['Listed on MLS', 'is_mls_active', yesNo],
  ]],
]

// Legacy Podio-era scores are never shown (see ENTITY_GRAPH_WITHHELD_FIELDS).
const LEGACY = ['cash_offer', 'final_acquisition_score', 'ai_score', 'structured_motivation_score', 'deal_strength_score', 'tag_distress_score']
const PARCEL_HIDDEN = new Set([...LEGACY, 'address_full', 'city', 'state', 'zip5', 'mail_city', 'mail_state', 'mail_zip5', 'mail_address_line1', 'latitude', 'longitude', 'property_class', 'property_use_standardized', 'owner_location'])

function buildGroups(row, groups, hidden = new Set()) {
  const used = new Set()
  const sections = []
  for (const [title, fields] of groups) {
    const out = []
    for (const [label, key, fmt] of fields) {
      used.add(key)
      const value = fmt(row[key])
      if (value) out.push({ label, value })
    }
    if (out.length) sections.push({ title, fields: out })
  }
  const other = []
  for (const [key, raw] of Object.entries(row)) {
    if (used.has(key) || hidden.has(key) || SKIP.test(key)) continue
    const value = typeof raw === 'boolean' ? yesNo(raw) : typeof raw === 'number' ? int(raw) : text(raw)
    if (value) other.push({ label: humanize(key), value })
  }
  if (other.length) sections.push({ title: 'Other recorded fields', fields: other })
  return sections
}

export function parcelSections(parcel) {
  if (!parcel || typeof parcel !== 'object') return []
  return buildGroups(parcel, PARCEL_GROUPS, PARCEL_HIDDEN)
}

const OWNER_FIELDS = [
  ['Owner', [
    ['Name', 'display_name', text], ['Type', 'owner_type_guess', (v) => (text(v) ? text(v).toLowerCase().split(/\s*\|\s*/).map((x) => x.replace(/^\w/, (c) => c.toUpperCase())).join(' · ') : null)], ['Mailing address', 'primary_owner_address', text],
    ['Located in', 'owner_location_text', text], ['Markets', 'markets_text', text], ['Tags', 'seller_tags_text', text],
    ['Longest hold', 'max_ownership_years', (v) => (num(v) ? `${num(v).toFixed(1)} yrs` : null)], ['Last deed type', 'last_sale_doc_type', text],
  ]],
  ['Portfolio', [
    ['Properties', 'property_count', int], ['Units', 'portfolio_total_units', int], ['Value', 'portfolio_total_value', money],
    ['Equity', 'portfolio_total_equity', money], ['Debt', 'portfolio_total_loan_balance', money],
    ['Debt service', 'portfolio_total_loan_payment', (v) => (money(v) ? `${money(v)}/mo` : null)], ['Property tax', 'portfolio_total_tax_amount', money],
    ['Tax-delinquent properties', 'tax_delinquent_count', int], ['Oldest delinquency', 'oldest_tax_delinquent_year', text],
    ['Properties with liens', 'active_lien_count', int],
  ]],
  ['Reachability', [
    ['Best channel', 'best_channel', (v) => (text(v) ? humanize(v) : null)], ['Best window', 'best_contact_window', text],
    ['Language', 'best_language', text], ['Timezone', 'routing_timezone', text], ['Contactability', 'contactability_score', int],
  ]],
]

export function ownerSections(owner) {
  if (!owner || typeof owner !== 'object') return []
  // Owner rows carry many scoring/bookkeeping columns; only the curated set renders.
  const used = OWNER_FIELDS.flatMap(([, f]) => f.map(([, k]) => k))
  const trimmed = Object.fromEntries(used.map((k) => [k, owner[k]]))
  return buildGroups(trimmed, OWNER_FIELDS)
}

export function prospectCards(prospects) {
  return (Array.isArray(prospects) ? prospects : []).slice(0, 8).map((p) => {
    const fields = [
      ['Gender', text(p.gender)], ['Marital status', text(p.marital_status)], ['Education', text(p.education_model)],
      ['Occupation', text(p.occupation_group)], ['Household income', text(p.est_household_income)], ['Net assets', text(p.net_asset_value)],
      ['Buying power', text(p.buying_power)], ['Language', text(p.language_preference)],
      ['Tenure', p.likely_owner && p.likely_renting ? 'Unclear — flagged owner and renter' : p.likely_owner ? 'Likely owner' : p.likely_renting ? 'Likely renter' : null],
      ['Best phone', text(p.best_phone)], ['Best email', text(p.best_email)], ['Contact window', text(p.contact_window)], ['Timezone', text(p.timezone)],
      ['SMS eligible', yesNo(p.sms_eligible)], ['Email eligible', yesNo(p.email_eligible)], ['Contact score', int(p.contact_score_final)],
      ['Flags', text(p.person_flags_text)],
    ].filter(([, v]) => v).map(([label, value]) => ({ label, value }))
    return { id: clean(p.prospect_id), name: clean(p.full_name) || clean(p.first_name) || 'Unnamed', primary: p.is_primary_prospect === true, fields }
  })
}

/* ── comps ─────────────────────────────────────────────────────────────── */

const COMPANY = /\b(l\.?l\.?c|inc|corp(oration)?|co|company|trust|holdings?|propert(y|ies)|invest(ment)?s?|capital|partners|lp|llp|ltd|group|realty|homes?|rentals?|ventures?|enterprises?|management|fund|bank|associates|development|builders?|construction|housing|equity|assets?|contractors?|solutions)\b/i

export function buyerFromPurchaseInfo(purchaseInfo) {
  const first = clean(String(purchaseInfo ?? '').split('·')[0])
  if (!first || /^\$|^\d{4}/.test(first)) return { kind: 'unknown', label: null }
  if (COMPANY.test(first)) return { kind: 'company', label: first }
  return { kind: 'individual', label: 'Individual' }
}

export const assetFamily = (cls, units) => {
  const c = clean(cls).toLowerCase()
  if (/multi|apartment|duplex|triplex|quad|plex/.test(c) || (num(units) ?? 0) >= 2) return 'multi'
  if (/land|lot/.test(c)) return 'land'
  if (/commercial|office|retail|industrial/.test(c)) return 'commercial'
  return 'single'
}

/** Merge the engine's selected comp with its source row; add asset integrity. */
export function enrichComp(sel, detail, subject) {
  const d = detail || {}
  const units = num(d.units_count) ?? num(sel?.units)
  const fam = assetFamily(d.normalized_asset_class || d.property_type, units)
  const subjFam = assetFamily(subject.propertyType, subject.units)
  const subjUnits = Math.max(1, num(subject.units) ?? 1)
  const compUnits = Math.max(1, units ?? 1)
  const ratio = compUnits / subjUnits
  const assetMatch = fam === subjFam && (fam !== 'multi' || (ratio >= 0.35 && ratio <= 2.75)) && (fam !== 'single' || compUnits <= 1)
  const buyer = buyerFromPurchaseInfo(d.purchase_info)
  const salePrice = num(sel?.sale_price) ?? num(d.sale_price)
  const sqft = num(d.building_square_feet)
  return {
    propertyType: clean(d.property_type) || null,
    assetClass: clean(d.normalized_asset_class) || null,
    family: fam,
    assetMatch,
    beds: num(d.total_bedrooms),
    baths: num(d.total_baths),
    sqft,
    lotSqft: num(d.lot_square_feet),
    units,
    yearBuilt: num(d.year_built),
    effectiveYear: num(d.effective_year_built),
    condition: clean(d.building_condition) || null,
    quality: clean(d.building_quality) || null,
    construction: clean(d.construction_type) || null,
    renovation: clean(d.renovation_level_classification) || null,
    stories: clean(d.stories) || null,
    pool: clean(d.pool) || null,
    ppsf: num(d.computed_ppsf) ?? (salePrice && sqft ? Math.round(salePrice / sqft) : null),
    ppu: num(d.ppu) ?? (salePrice && units ? Math.round(salePrice / Math.max(units, 1)) : null),
    saleSource: clean(d.sale_source) || null,
    mlsSoldPrice: num(d.mls_sold_price),
    avmAtSale: num(d.estimated_value),
    buyerKind: buyer.kind,
    buyerLabel: buyer.label,
    photo: /^https:\/\//.test(clean(d.streetview_image)) ? clean(d.streetview_image) : null,
  }
}

export const COMP_DETAIL_COLUMNS = [
  'id', 'property_type', 'normalized_asset_class', 'total_bedrooms', 'total_baths', 'building_square_feet', 'lot_square_feet',
  'units_count', 'year_built', 'effective_year_built', 'building_condition', 'building_quality', 'construction_type',
  'renovation_level_classification', 'stories', 'pool', 'computed_ppsf', 'ppu', 'sale_source', 'purchase_info',
  'mls_sold_price', 'estimated_value', 'streetview_image', 'sale_price',
].join(',')

export { money as recordMoney }
