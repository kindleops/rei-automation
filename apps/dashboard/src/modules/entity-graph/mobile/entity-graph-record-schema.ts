/**
 * Schema-aware field grouping for the record inspector.
 *
 * `properties` carries 343 columns (160 populated on a typical row), owners 77,
 * prospects 63. Listing them raw is unusable and listing a curated dozen hides
 * the acquisition data the operator came for. So sections are defined by rules —
 * explicit field lists plus prefix/pattern matchers — and every populated field
 * is routed to exactly one section. Anything a rule doesn't claim still appears,
 * under "Other fields", so adding a column upstream can never make it invisible.
 *
 * Nothing is fabricated: fields that are null/empty on the record are dropped
 * entirely rather than rendered as "—", because a 343-row list of blanks buries
 * the 160 that have answers.
 */

export type FieldSectionKey =
  | 'overview'
  | 'ownership'
  | 'people'
  | 'contact'
  | 'intelligence'
  | 'distress'
  | 'outreach'
  | 'related'
  | 'provenance'
  | 'other'

export type FieldSectionDef = {
  key: FieldSectionKey
  label: string
  /** Exact column names claimed by this section, in display order. */
  fields?: string[]
  /** Regex claimed by this section, applied after exact matches. */
  patterns?: RegExp[]
}

export const RECORD_SECTIONS: FieldSectionDef[] = [
  {
    key: 'overview',
    label: 'Overview',
    fields: [
      'property_address_full', 'property_address_city', 'property_address_state',
      'property_address_zip', 'property_address_county_name', 'market', 'market_region',
      'property_type', 'normalized_asset_class', 'asset_class', 'asset_type', 'property_group',
      'property_subtype', 'property_class', 'units_count', 'total_bedrooms', 'total_baths',
      'building_square_feet', 'year_built', 'effective_year_built', 'stories',
      'estimated_value', 'equity_percent', 'equity_amount', 'final_acquisition_score',
      'display_name', 'full_name', 'first_name', 'owner_type_guess', 'priority_tier',
      'priority_score', 'property_count', 'portfolio_total_value', 'portfolio_total_units',
      'canonical_e164', 'phone', 'phone_type', 'email', 'email_normalized',
    ],
  },
  {
    key: 'ownership',
    label: 'Ownership',
    fields: [
      'master_owner_id', 'owner_name', 'owner_1_name', 'owner_2_name', 'owner_type',
      'owner_display_name', 'owner_location', 'owner_address_full', 'owner_address_city',
      'owner_address_state', 'owner_address_zip', 'primary_owner_address', 'ownership_years',
      'is_corporate_owner', 'out_of_state_owner', 'removed_owner', 'owner_entity_id',
      'sub_owner_id', 'portfolio_total_equity', 'contactability_score',
    ],
    patterns: [/^owner_/, /^sub_owner/, /^portfolio_/],
  },
  {
    key: 'people',
    label: 'People',
    fields: [
      'prospect_id', 'canonical_prospect_id', 'likely_owner', 'likely_renting',
      'occupation_group', 'occupation_code', 'est_household_income', 'net_asset_value',
      'buying_power', 'education_model', 'marital_status', 'gender', 'age', 'mob',
      'person_flags_text', 'rank_position', 'source_slot', 'relationship',
    ],
  },
  {
    key: 'contact',
    label: 'Contact Methods',
    fields: [
      'best_phone', 'best_phone_e164', 'best_phone_id', 'best_phone_score', 'best_phone_1',
      'best_phone_2', 'best_phone_3', 'best_email', 'best_email_1', 'best_email_2',
      'best_email_id', 'email_score_final', 'phone_score_final', 'contact_score_final',
      'sms_eligible', 'activity_status', 'usage_12_months', 'usage_2_months',
      'contact_window', 'timezone', 'best_channel', 'best_language', 'language_preference',
      'wrong_number_at', 'sort_rank', 'contact_status', 'follow_up_cadence',
    ],
    patterns: [/^best_phone/, /^best_email/, /phones_json$/, /emails_json$/],
  },
  {
    key: 'intelligence',
    label: 'Property Intelligence',
    fields: [
      'lot_acreage', 'lot_square_feet', 'lot_size_depth_feet', 'lot_size_frontage_feet',
      'zoning', 'land_use', 'property_use', 'building_condition', 'building_quality',
      'construction_type', 'exterior_walls', 'interior_walls', 'roof_cover', 'roof_type',
      'floor_cover', 'heating_type', 'heating_fuel_type', 'air_conditioning', 'basement',
      'garage', 'pool', 'porch', 'patio', 'deck', 'driveway', 'sewer', 'water',
      'num_of_fireplaces', 'style', 'topography', 'flood_zone', 'school_district_name',
      'subdivision_name', 'legal_description', 'hoa1_name', 'hoa1_type', 'hoa_fee_amount',
      'arv_estimate', 'arv_ppsf', 'rent_estimate', 'monthly_rent', 'gross_monthly_income',
      'gross_annual_income', 'noi_estimate', 'cap_rate', 'ppsf', 'ppu', 'ppbd',
      'sqft_per_unit', 'avg_sqft_per_unit', 'beds_per_unit', 'rehab_level',
      'estimated_repair_cost', 'estimated_repair_cost_per_sqft', 'cash_offer',
      'offer_ppsf', 'offer_ppu', 'offer_ppbd', 'offer_ppls', 'offer_vs_loan',
      'offer_vs_sale_price', 'potential_spread', 'price_off_value', 'percent_off',
      'comp_confidence_score', 'renovation_level_classification', 'latitude', 'longitude',
      'total_loan_balance', 'total_loan_amt', 'total_loan_payment', 'sale_date', 'sale_price',
      'saleprice', 'recording_date', 'last_sale_doc_type', 'document_type',
      'mls_current_listing_price', 'mls_market_status', 'mls_sold_date', 'mls_sold_price',
      'market_status_label', 'market_status_value', 'market_sub_status',
    ],
    patterns: [/^assd_/, /^calculated_/, /^tax_(amt|year)$/, /^sum_/, /^lot_/],
  },
  {
    key: 'distress',
    label: 'Distress & Acquisition Signals',
    fields: [
      'tax_delinquent', 'tax_delinquent_year', 'active_lien', 'lien_type', 'lien_position',
      'lien_recording_date', 'lienholder_name', 'past_due_amount', 'default_amount',
      'default_date', 'default_date_raw', 'judgment_amount', 'notice_type', 'notice_date',
      'foreclosure_status', 'foreclosure_stage', 'foreclosure_type', 'preforeclosure_status',
      'preforeclosure_stage', 'trustee_name', 'trustee_phone', 'trustee_address',
      'lender_name', 'beneficiary_name', 'opening_bid', 'case_number', 'court_name',
      'county_case_url', 'property_flags_text', 'seller_tags_text', 'podio_tags',
      'tag_distress_score', 'structured_motivation_score', 'deal_strength_score',
      'acquisition_bucket', 'import_asset_signal', 'ai_score', 'deal_list_label',
      'deal_list_type', 'deal_list_normalized', 'highlighted',
      'tax_delinquent_count', 'active_lien_count', 'urgency_score', 'financial_pressure_score',
    ],
    patterns: [/^auction_/, /^is_(hot_)?(pre_?)?foreclosure/, /^is_tax_delinquent/],
  },
  {
    key: 'outreach',
    label: 'Campaign & Outreach',
    fields: [
      'agent_persona', 'agent_family', 'last_contacted', 'last_response',
      'thread_key', 'conversation_state', 'acquisition_stage', 'opportunity_id',
    ],
  },
  {
    key: 'related',
    label: 'Related Records',
    patterns: [/_ids_json$/, /_ids_text$/, /^joined_/, /^linked_/],
  },
  {
    key: 'provenance',
    label: 'Data Provenance',
    fields: [
      'property_id', 'property_export_id', 'apn_parcel_id', 'master_key', 'upsert_key',
      'owner_id', 'source_system', 'export_version', 'exported_at_utc', 'row_hash',
      'created_at', 'updated_at', 'source_sheet_name', 'source_row_number',
      'source_list_label', 'source_list_type', 'source_list_category', 'source_list_name',
      'source_list_id', 'list_name', 'list_id', 'list_label', 'list_type', 'list_category',
      'search_profile_hash', 'comp_search_profile_hash', 'owner_match_key',
      'owner_match_key_full', 'owner_name_addr_key', 'property_type_normalized_at',
      'asset_classification_source', 'asset_classified_at', 'asset_type_confidence',
      'email_id', 'phone_id', 'primary_prospect_id', 'sub_owner_id',
    ],
    patterns: [/_hash$/, /_key$/, /^raw_payload/, /^export/],
  },
]

/** Columns that carry no operator meaning even when populated. */
const SUPPRESSED = new Set([
  'raw_payload_json', 'seller_tags_json', 'property_flags_json', 'options',
  'map_image', 'satellite_image', 'streetview_image', 'purchase_info', 'other_rooms',
])

/**
 * Boolean-flag columns are only interesting when true. `is_office: false` on a
 * single-family home is noise; `is_office: true` is a classification.
 */
function isUninformative(key: string, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && !value.trim()) return true
  if (Array.isArray(value) && value.length === 0) return true
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0) return true
  if (typeof value === 'boolean' && value === false) return true
  if (/^is_/.test(key) && (value === false || value === 0 || value === '0')) return true
  return false
}

export function humanizeFieldName(key: string): string {
  return key
    .replace(/_json$/, '')
    .replace(/_/g, ' ')
    .replace(/\bid\b/gi, 'ID')
    .replace(/\bapn\b/gi, 'APN')
    .replace(/\bmls\b/gi, 'MLS')
    .replace(/\bhoa1?\b/gi, 'HOA')
    .replace(/\bppsf\b/gi, 'PPSF')
    .replace(/\bppu\b/gi, 'PPU')
    .replace(/\bppbd\b/gi, 'PPBD')
    .replace(/\barv\b/gi, 'ARV')
    .replace(/\bnoi\b/gi, 'NOI')
    .replace(/\be164\b/gi, 'E.164')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim()
}

// `equity` is safe here because PERCENT_HINT is tested first, so
// `equity_percent` still formats as a percentage while `portfolio_total_equity`
// stops rendering as a bare "202,000" next to a "$202,000" value field.
const CURRENCY_HINT = /(value|price|amount|_amt$|balance|payment|income|cost|bid|offer|equity|judgment|spread|rent)/i
const PERCENT_HINT = /(percent|_pct$|cap_rate)/i
const DATE_HINT = /(_at$|_date$|_utc$|date_raw$)/i
/**
 * Identifier-ish numerics that must never be thousands-separated or rounded:
 * a ZIP printed as "30,318" and a year as "1,948" are both wrong.
 */
const LITERAL_NUMERIC_HINT = /(zip|postal|year|_id$|^id$|apn|parcel|tract|census|code$|number$|_nbr$|case|phone|fips|lot_nbr)/i

export function formatFieldValue(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.length <= 4 ? value.join(', ') : `${value.length} entries`
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'

  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value as object)
    return `${entries.length} field${entries.length === 1 ? '' : 's'}`
  }

  const raw = String(value)

  if (DATE_HINT.test(key)) {
    const parsed = new Date(raw)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    }
  }

  const num = Number(raw)
  if (Number.isFinite(num) && raw.trim() !== '' && !LITERAL_NUMERIC_HINT.test(key)) {
    if (PERCENT_HINT.test(key)) return `${Math.round(num * 10) / 10}%`
    if (CURRENCY_HINT.test(key)) {
      if (Math.abs(num) >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`
      if (Math.abs(num) >= 1_000) return `$${Math.round(num).toLocaleString()}`
      return `$${Math.round(num * 100) / 100}`
    }
    if (Number.isInteger(num) && Math.abs(num) >= 1000) return num.toLocaleString()
  }

  return raw
}

export type RecordField = { key: string; label: string; value: string }
export type RecordSection = { key: FieldSectionKey; label: string; fields: RecordField[] }

/**
 * Route every populated field on the record into exactly one section. Order
 * within a section follows the declared field order, then alphabetical for
 * pattern-claimed fields, so the layout is stable across records.
 */
export function buildRecordSections(record: Record<string, unknown> | null | undefined): RecordSection[] {
  if (!record) return []

  const claimed = new Set<string>()
  const sections: RecordSection[] = []

  for (const def of RECORD_SECTIONS) {
    const fields: RecordField[] = []

    for (const key of def.fields ?? []) {
      if (claimed.has(key) || SUPPRESSED.has(key)) continue
      if (!(key in record)) continue
      const value = record[key]
      if (isUninformative(key, value)) { claimed.add(key); continue }
      claimed.add(key)
      fields.push({ key, label: humanizeFieldName(key), value: formatFieldValue(key, value) })
    }

    if (def.patterns?.length) {
      const matched = Object.keys(record)
        .filter((key) => !claimed.has(key) && !SUPPRESSED.has(key))
        .filter((key) => def.patterns!.some((pattern) => pattern.test(key)))
        .sort()
      for (const key of matched) {
        const value = record[key]
        claimed.add(key)
        if (isUninformative(key, value)) continue
        fields.push({ key, label: humanizeFieldName(key), value: formatFieldValue(key, value) })
      }
    }

    if (fields.length > 0) sections.push({ key: def.key, label: def.label, fields })
  }

  // Nothing upstream can hide: whatever no rule claimed still gets a home.
  const leftovers = Object.keys(record)
    .filter((key) => !claimed.has(key) && !SUPPRESSED.has(key))
    .filter((key) => !isUninformative(key, record[key]))
    .sort()

  if (leftovers.length > 0) {
    sections.push({
      key: 'other',
      label: 'Other fields',
      fields: leftovers.map((key) => ({
        key,
        label: humanizeFieldName(key),
        value: formatFieldValue(key, record[key]),
      })),
    })
  }

  return sections
}

/** Count of populated fields, for the inspector header. */
export function countPopulated(record: Record<string, unknown> | null | undefined): { populated: number; total: number } {
  if (!record) return { populated: 0, total: 0 }
  const keys = Object.keys(record)
  return {
    total: keys.length,
    populated: keys.filter((key) => !isUninformative(key, record[key])).length,
  }
}
