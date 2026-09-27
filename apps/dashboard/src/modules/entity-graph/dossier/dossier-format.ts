/**
 * Formatting + field grouping for the property dossier.
 *
 * The dossier merges two records of the same parcel: `dossier.summary` (the
 * properties row) and `records.parcel` (the county parcel as imported into
 * seller.property). Parcel columns that restate a summary column are folded
 * onto the summary key so a value is shown once; the summary wins when both
 * carry one.
 */
import { isLegacyAcquisitionField } from '../../../domain/acquisition/legacy-acquisition-fields'

export type Row = Record<string, unknown>

export const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return null
  const s = String(v).trim()
  return s && s.toLowerCase() !== 'null' && s !== 'undefined' ? s : null
}

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

export function money(v: number | null | undefined, { compact = true }: { compact?: boolean } = {}): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  const sign = v < 0 ? '−' : ''
  const a = Math.abs(v)
  if (!compact || a < 10_000) return `${sign}$${Math.round(a).toLocaleString()}`
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`
  return `${sign}$${Math.round(a / 1e3)}K`
}

export function pct(v: number | null | undefined, digits = 0): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  return `${v.toFixed(digits)}%`
}

/** YYYY-MM-DD without a timezone shift. */
export function parseDay(v: unknown): Date | null {
  const s = text(v)
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function day(v: unknown): string | null {
  const d = parseDay(v)
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null
}

export function monthYear(v: unknown): string | null {
  const d = parseDay(v)
  return d ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : null
}

export function year(v: unknown): string | null {
  const d = parseDay(v)
  return d ? String(d.getFullYear()) : null
}

export function yearsSince(v: unknown): number | null {
  const d = parseDay(v)
  if (!d) return null
  return Math.max(0, (Date.now() - d.getTime()) / (365.25 * 86_400_000))
}

export function titleCase(s: string | null): string | null {
  if (!s) return null
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Llc|Lp|Llp|Inc|Ii|Iii|Iv|Po|Nw|Ne|Sw|Se|Hoa|Fha|Va|Apn|Mls)\b/g, (w) => w.toUpperCase())
}

/* ── Field inventory ──────────────────────────────────────────────────── */

/** Parcel columns that restate a properties column → the properties key. */
const PARCEL_ALIAS: Record<string, string> = {
  address_full: 'property_address_full',
  city: 'property_address_city',
  state: 'property_address_state',
  zip5: 'property_address_zip',
  county_name: 'property_address_county_name',
  building_sqft: 'building_square_feet',
  bedrooms: 'total_bedrooms',
  baths: 'total_baths',
  lot_sqft: 'lot_square_feet',
  lot_number: 'lot_nbr',
  tax_amount: 'tax_amt',
  assessed_total_value: 'assd_total_value',
  assessed_land_value: 'assd_land_value',
  assessed_improvement_value: 'assd_improvement_value',
  assessed_year: 'assd_year',
  calc_total_value: 'calculated_total_value',
  calc_land_value: 'calculated_land_value',
  calc_improvement_value: 'calculated_improvement_value',
  estimated_equity: 'equity_amount',
  garage_sqft: 'sum_garage_sqft',
  school_district: 'school_district_name',
  apn: 'apn_parcel_id',
  census_tract: 'situs_census_tract',
  total_loan_amount: 'total_loan_amt',
  mls_list_price: 'mls_current_listing_price',
  mls_status: 'mls_market_status',
  mail_address_full: 'owner_address_full',
  mail_city: 'owner_address_city',
  mail_state: 'owner_address_state',
  mail_zip5: 'owner_address_zip',
  estimated_repair_cost: 'estimated_repair_cost',
  repair_cost_per_sqft: 'estimated_repair_cost_per_sqft',
  property_use: 'property_use',
}

/** Columns that are bookkeeping, identifiers, blobs, or shown elsewhere. */
const EXCLUDE_EXACT = new Set([
  'property_id', 'property_export_id', 'master_owner_id', 'master_key', 'owner_id', 'upsert_key', 'row_hash',
  'raw_payload_json', 'source_system', 'export_version', 'exported_at_utc', 'created_at', 'updated_at',
  'search_profile_hash', 'comp_search_profile_hash', 'owner_match_key', 'owner_match_key_full', 'owner_name_addr_key',
  'source_sheet_name', 'source_row_number', 'map_image', 'satellite_image', 'streetview_image', 'podio_tags',
  'options', 'highlighted', 'removed_owner', 'first_observed_at', 'last_observed_at', 'property_type_normalized_at',
  'asset_classified_at', 'asset_classification_source', 'asset_type_confidence', 'canonical_market_source',
  'canonical_market_id', 'best_phone_id', 'best_phone', 'best_phone_e164', 'best_phone_score', 'best_email_id',
  'best_email', 'email_score_final', 'phone_type', 'sms_eligible', 'activity_status', 'usage_12_months',
  'usage_2_months', 'contact_window', 'timezone', 'agent_persona', 'agent_family', 'follow_up_cadence', 'best_channel',
  'best_language', 'contact_status', 'acquisition_bucket', 'import_asset_signal', 'search_profile', 'marketLabel',
  'marketKey', 'isUnmappedMarket', 'property_data_id', 'owner_hash', 'address_mak', 'priority_tier',
  'source_market_label', 'deal_list_label', 'deal_list_type', 'deal_list_normalized', 'deal_list_name',
  'deal_lists_label', 'comp_confidence_score', 'distress_flags', 'person_flags', 'owner_type_guess',
])

const EXCLUDE_PATTERNS: RegExp[] = [
  /_json$/, /_id$/, /^source_list/, /^list_/, /^deal_lists?_/, /^podio/, /_hash$/, /_raw$/, /^offer_/,
]

export function excludedField(key: string): boolean {
  return EXCLUDE_EXACT.has(key) || isLegacyAcquisitionField(key) || EXCLUDE_PATTERNS.some((re) => re.test(key))
}

export type FieldGroupKey = 'building' | 'systems' | 'lot' | 'valuation' | 'mls' | 'hoa' | 'legal' | 'location' | 'owner' | 'distress' | 'income' | 'other'

type GroupDef = { key: FieldGroupKey; label: string; exact?: string[]; patterns?: RegExp[] }

const GROUPS: GroupDef[] = [
  {
    key: 'building', label: 'Building',
    exact: ['property_type', 'property_class', 'property_group', 'property_subtype', 'asset_type', 'asset_class', 'asset_subtype', 'asset_label', 'asset_type_label', 'normalized_asset_class', 'normalized_asset_subclass', 'asset_subclass', 'original_property_type', 'building_class', 'property_use_standardized', 'property_use', 'units_count', 'total_rooms', 'total_bedrooms', 'total_baths', 'building_square_feet', 'year_built', 'effective_year_built', 'year_built_bucket', 'stories', 'style', 'construction_type', 'exterior_walls', 'interior_walls', 'floor_cover', 'roof_cover', 'roof_type', 'basement', 'garage', 'garage_spaces', 'sum_garage_sqft', 'building_condition', 'building_quality', 'num_of_fireplaces', 'porch', 'patio', 'deck', 'pool', 'sum_buildings_nbr', 'other_rooms', 'avg_sqft_per_unit', 'sqft_per_unit', 'beds_per_unit', 'sqft_range', 'estimated_repair_cost', 'estimated_repair_cost_per_sqft', 'rehab_level', 'renovation_level_classification', 'commercial_units', 'multifamily_units', 'storage_units', 'strip_center_units', 'sum_commercial_units'],
  },
  { key: 'systems', label: 'Systems & Utilities', exact: ['air_conditioning', 'heating_type', 'heating_fuel_type', 'sewer', 'water'] },
  { key: 'lot', label: 'Lot & Land', exact: ['lot_acreage', 'lot_square_feet', 'lot_size_depth_feet', 'lot_size_frontage_feet', 'lot_nbr', 'topography', 'driveway', 'geographic_features', 'land_use', 'flood_zone'] },
  {
    key: 'valuation', label: 'Valuation & Tax',
    exact: ['estimated_value', 'value_low', 'value_high', 'value_confidence', 'valuation_date', 'equity_percent', 'equity_amount', 'total_loan_balance', 'total_loan_amt', 'total_loan_payment', 'mortgage_count', 'open_mortgage_count', 'improvement_pct', 'tax_amt', 'tax_year', 'tax_delinquent', 'tax_delinquent_year', 'sale_date', 'sale_price', 'saleprice', 'last_sale_doc_type', 'ownership_years', 'arv_estimate', 'arv_ppsf', 'ppsf', 'ppu', 'ppbd', 'price_off_value', 'percent_off', 'potential_spread'],
    patterns: [/^assd_/, /^calculated_/],
  },
  { key: 'income', label: 'Income', exact: ['rent_estimate', 'monthly_rent', 'gross_monthly_income', 'gross_annual_income', 'noi_estimate', 'cap_rate'] },
  { key: 'mls', label: 'MLS & Market', exact: ['is_mls_active', 'market_status', 'market_status_label', 'market_status_value', 'market_sub_status', 'mls_days_on_market'], patterns: [/^mls_/] },
  { key: 'hoa', label: 'HOA', patterns: [/^hoa/] },
  { key: 'legal', label: 'Legal & Zoning', exact: ['apn_parcel_id', 'zoning', 'legal_description', 'subdivision_name', 'county_land_use_code', 'property_use_code', 'school_district_name', 'situs_census_tract', 'fips', 'lot_number'] },
  {
    key: 'distress', label: 'Distress & Auction',
    exact: ['active_lien', 'lien_count', 'hoa_lien_count', 'is_hoa_foreclosure', 'past_due_amount', 'default_amount', 'default_date', 'default_date_raw', 'notice_type', 'notice_date', 'judgment_amount', 'case_number', 'court_name', 'county_case_url', 'trustee_name', 'trustee_phone', 'trustee_address', 'beneficiary_name', 'lender_name', 'lienholder_name', 'lien_position', 'lien_type', 'lien_recording_date', 'opening_bid', 'document_type', 'recording_date', 'purchase_info'],
    patterns: [/^auction/, /foreclosure/, /^preforeclosure/],
  },
  {
    key: 'owner', label: 'Owner of record',
    exact: ['owner_name', 'owner_1_name', 'owner_2_name', 'owner_display_name', 'owner_type', 'owner_location', 'owner_status', 'ownership_rights', 'is_corporate_owner', 'out_of_state_owner', 'is_trust', 'owner_is_bank', 'owner_has_multiple_properties', 'primary_owner_address', 'mail_co_name', 'mail_opt_out'],
    patterns: [/^owner_address/, /^owner_\d_/, /^owner_last/, /^mail_address/],
  },
  {
    key: 'location', label: 'Location',
    exact: ['property_address_full', 'property_address', 'property_address2', 'property_address_city', 'property_address_state', 'property_address_zip', 'property_address_county_name', 'property_address_range', 'property_county_name', 'property_state', 'property_zip', 'market', 'market_region', 'latitude', 'longitude'],
  },
]

const LABELS: Record<string, string> = {
  property_address_full: 'Address', property_address_city: 'City', property_address_state: 'State',
  property_address_zip: 'ZIP', property_address_county_name: 'County', property_county_name: 'County',
  building_square_feet: 'Building sq ft', total_bedrooms: 'Bedrooms', total_baths: 'Bathrooms',
  units_count: 'Units', lot_square_feet: 'Lot sq ft', lot_acreage: 'Lot acres', lot_nbr: 'Lot number',
  tax_amt: 'Annual tax', assd_total_value: 'Assessed total', assd_land_value: 'Assessed land',
  assd_improvement_value: 'Assessed improvements', assd_year: 'Assessment year',
  calculated_total_value: 'Calculated total', calculated_land_value: 'Calculated land',
  calculated_improvement_value: 'Calculated improvements', equity_amount: 'Equity',
  equity_percent: 'Equity', total_loan_balance: 'Loan balance', total_loan_amt: 'Original loans',
  total_loan_payment: 'Loan payment', apn_parcel_id: 'APN', situs_census_tract: 'Census tract',
  sum_garage_sqft: 'Garage sq ft', num_of_fireplaces: 'Fireplaces', sum_buildings_nbr: 'Buildings',
  mls_current_listing_price: 'MLS list price', mls_market_status: 'MLS status', mls_sold_price: 'MLS sold price',
  mls_sold_date: 'MLS sold date', mls_days_on_market: 'Days on market', is_mls_active: 'Listed on MLS',
  hoa_fee_amount: 'HOA fee', hoa1_name: 'HOA', hoa1_type: 'HOA type', hoa_lien_count: 'HOA liens',
  saleprice: 'Sale price', sale_price: 'Last sale price', sale_date: 'Last sale date',
  last_sale_doc_type: 'Last deed', ownership_years: 'Years owned', estimated_repair_cost: 'Est. repair cost',
  estimated_repair_cost_per_sqft: 'Repair cost / sq ft', ppsf: 'Price / sq ft', ppu: 'Price / unit',
  ppbd: 'Price / bed', arv_estimate: 'ARV estimate', arv_ppsf: 'ARV / sq ft', noi_estimate: 'NOI estimate',
  is_corporate_owner: 'Company-owned', out_of_state_owner: 'Out-of-state owner', is_trust: 'Held in trust',
  owner_is_bank: 'Bank-owned', owner_has_multiple_properties: 'Owns multiple properties',
  owner_address_full: 'Mailing address', owner_address_city: 'Mailing city', owner_address_state: 'Mailing state',
  owner_address_zip: 'Mailing ZIP', mail_co_name: 'Mail c/o', mail_opt_out: 'Mail opt-out',
  improvement_pct: 'Improvement share', value_confidence: 'Value confidence', year_built_bucket: 'Era',
  county_land_use_code: 'County land-use code', property_use_code: 'Use code',
  school_district_name: 'School district', is_hoa_foreclosure: 'HOA foreclosure', fips: 'FIPS',
  cap_rate: 'Cap rate', open_mortgage_count: 'Open mortgages', mortgage_count: 'Mortgages recorded',
  lien_count: 'Liens recorded', active_lien: 'Active lien', tax_delinquent: 'Tax delinquent',
  tax_delinquent_year: 'Delinquent since',
}

const WORDS: Record<string, string> = {
  sqft: 'sq ft', assd: 'assessed', calc: 'calculated', apn: 'APN', mls: 'MLS', hoa: 'HOA', nbr: 'number',
  pct: '%', amt: 'amount', ppsf: 'per sq ft', num: 'number', dt: 'date', id: 'ID', zip: 'ZIP', noi: 'NOI',
  arv: 'ARV', mf: 'MF', sfr: 'SFR', url: 'URL', hoa1: 'HOA',
}

export function fieldLabel(key: string): string {
  if (LABELS[key]) return LABELS[key]
  const words = key.replace(/^is_/, '').split('_').map((w) => WORDS[w] ?? w)
  const label = words.join(' ').replace(/\s+/g, ' ').trim()
  return label.charAt(0).toUpperCase() + label.slice(1)
}

const MONEY = /(value|price|amount|amt|balance|payment|tax$|tax_amt|fee(?:_|$)|cost|bid|rent|income|noi|equity$|spread|ppsf|ppu|ppbd|loan)/
const PERCENT = /(percent|pct|rate$|_share$)/
const DATE = /(date|_at$|_on$)/

export function formatField(key: string, value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) {
    const items = value.map((v) => text(v)).filter(Boolean) as string[]
    return items.length ? items.map((v) => titleCase(v)).join(', ') : null
  }
  if (value && typeof value === 'object') return null
  const s = text(value)
  if (!s) return null
  if (['true', 'false', 't', 'f'].includes(s.toLowerCase()) && /^(is_|has_|tax_delinquent|active_lien|out_of_state|mail_opt)/.test(key)) {
    return ['true', 't'].includes(s.toLowerCase()) ? 'Yes' : 'No'
  }
  if (/year/.test(key) && /^\d{4}(\.0+)?$/.test(s)) return s.slice(0, 4)
  if (key === 'latitude' || key === 'longitude') return Number(s).toFixed(5)
  const n = num(s)
  if (n !== null && /^[-$\d.,\s]+$/.test(s)) {
    if (key === 'cap_rate') return pct(n <= 1 ? n * 100 : n, 1)
    if (PERCENT.test(key)) return pct(n, Math.abs(n) < 10 && !Number.isInteger(n) ? 1 : 0)
    if (MONEY.test(key) && !/count|units|year|confidence|days|stories|rooms|sqft|feet|acre|spaces|nbr|number/.test(key)) return money(n, { compact: false })
    if (/acre/.test(key)) return n.toFixed(2)
    return Number.isInteger(n) ? n.toLocaleString() : String(Math.round(n * 100) / 100)
  }
  if (DATE.test(key) && /^\d{4}-\d{2}-\d{2}/.test(s)) return day(s)
  if (/^https?:\/\//.test(s)) return s
  return s.length > 3 && s === s.toUpperCase() ? titleCase(s) : s
}

export type DetailField = { key: string; label: string; value: string }
export type DetailGroup = { key: FieldGroupKey; label: string; fields: DetailField[] }

/** Every populated, displayable field, grouped; summary wins over parcel. */
export function buildDetailGroups(summary: Row | null, parcel: Row | null): DetailGroup[] {
  const merged = new Map<string, unknown>()
  for (const [key, value] of Object.entries(summary ?? {})) merged.set(key, value)
  for (const [rawKey, value] of Object.entries(parcel ?? {})) {
    const key = PARCEL_ALIAS[rawKey] ?? rawKey
    const existing = merged.get(key)
    if (existing === undefined || existing === null || text(existing) === null) merged.set(key, value)
  }

  const claimed = new Set<string>()
  const groups: DetailGroup[] = []
  const entries = [...merged.entries()]
    .filter(([key]) => !excludedField(key))
    .map(([key, value]) => ({ key, value, shown: formatField(key, value) }))
    // A false `is_*` asset flag is noise ("Is warehouse: No" × 40); a true one is a fact.
    .filter((entry) => entry.shown !== null && !(/^is_/.test(entry.key) && entry.shown === 'No' && !LABELS[entry.key]))

  for (const def of GROUPS) {
    const fields: DetailField[] = []
    const take = (key: string) => {
      if (claimed.has(key)) return
      const entry = entries.find((e) => e.key === key)
      if (!entry) return
      claimed.add(key)
      fields.push({ key, label: fieldLabel(key), value: entry.shown as string })
    }
    for (const key of def.exact ?? []) take(key)
    for (const re of def.patterns ?? []) for (const entry of entries) if (re.test(entry.key)) take(entry.key)
    if (fields.length) groups.push({ key: def.key, label: def.label, fields })
  }
  const rest = entries.filter((e) => !claimed.has(e.key))
  // Boolean asset classifiers the importer carries (is_residential, is_duplex …) read better as one line.
  const flags = rest.filter((e) => /^is_/.test(e.key) && e.shown === 'Yes')
  const other = rest.filter((e) => !flags.includes(e))
  const otherFields: DetailField[] = other.map((e) => ({ key: e.key, label: fieldLabel(e.key), value: e.shown as string }))
  if (flags.length) otherFields.unshift({ key: '__flags', label: 'Classified as', value: flags.map((f) => fieldLabel(f.key)).join(', ') })
  if (otherFields.length) groups.push({ key: 'other', label: 'More on record', fields: otherFields })
  return groups
}
