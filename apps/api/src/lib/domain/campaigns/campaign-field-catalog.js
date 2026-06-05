import { supabase as defaultSupabase } from '@/lib/supabase/client.js'

const DOMAIN_KEYS = ['properties', 'prospects', 'master_owners', 'phones', 'outreach', 'sender_coverage']

const CAMPAIGN_DOMAINS = [
  {
    id: 'properties',
    label: 'Property Targeting',
    description: 'Asset source of truth and campaign anchor.',
    categories: [
      'Location & Market',
      'Asset Type & Structure',
      'Value, Equity & Debt',
      'Distress & Motivation',
      'Condition & Repair',
      'Land, Lot & Zoning',
      'Tax & Assessment',
      'Owner Relationship',
    ],
  },
  {
    id: 'prospects',
    label: 'Prospect Targeting',
    description: 'Individual and contact motivation layer.',
    categories: ['Demographics', 'Matching & Eligibility'],
  },
  {
    id: 'master_owners',
    label: 'Master Owner Targeting',
    description: 'Portfolio and owner intelligence layer.',
    categories: ['Profile', 'Scores', 'Portfolio Financials', 'Portfolio Distress'],
  },
  {
    id: 'phones',
    label: 'Phone Quality',
    description: 'Contact quality layer.',
    categories: ['Quality'],
  },
  {
    id: 'outreach',
    label: 'Outreach Rules',
    description: 'Timing, compliance, and history layer.',
    categories: ['Rules'],
  },
  {
    id: 'sender_coverage',
    label: 'Sender Coverage',
    description: 'Routing and deliverability layer.',
    categories: ['Routing'],
  },
]

const SOURCE_BY_DOMAIN = {
  properties: 'properties',
  prospects: 'prospects',
  master_owners: 'master_owners',
  phones: 'phones',
  outreach: 'v_feeder_candidates_fast',
  sender_coverage: 'v_feeder_candidates_fast',
}

const FIELD_KEY_ALIASES = Object.freeze({
  'properties.units': 'properties.units_count',
  // Canonical geography. The bare property_* mirrors are sparse partial columns
  // (property_state/property_zip ~6.5% populated, property_county_name 0%), while
  // property_address_* is ~100% populated and is the source of truth. Legacy keys
  // from saved campaigns or older clients normalize to the canonical address field
  // so the catalog, options, and preview compiler always resolve canonical columns.
  'properties.property_state': 'properties.property_address_state',
  'properties.property_zip': 'properties.property_address_zip',
  'properties.property_county_name': 'properties.property_address_county_name',
  'properties.property_county': 'properties.property_address_county_name',
  'properties.property_city': 'properties.property_address_city',
})

const CANONICAL_SOURCE_MAPPINGS = Object.freeze({
  'properties.market': {
    canonicalField: 'properties.market',
    sourceColumns: ['market', 'canonical_market', 'seller_market', 'market_name'],
    diagnosticFallbackColumns: ['selected_textgrid_market'],
    forbiddenColumns: [
      'property_address_city',
      'city',
      'owner_location',
      'property_address_county_name',
      'property_county_name',
      'county',
    ],
    unavailableWarning: 'canonical_market_unavailable',
  },
  'properties.property_address_city': {
    canonicalField: 'properties.property_address_city',
    sourceColumns: ['property_address_city', 'city'],
  },
  'properties.property_state': {
    canonicalField: 'properties.property_state',
    sourceColumns: ['property_state', 'property_address_state', 'state'],
  },
  'properties.property_zip': {
    canonicalField: 'properties.property_zip',
    sourceColumns: ['property_zip', 'property_address_zip', 'zip'],
  },
  'properties.property_type': {
    canonicalField: 'properties.property_type',
    sourceColumns: ['property_type', 'canonical_property_group', 'property_group', 'asset_type_label', 'asset_type', 'property_class'],
  },
  'properties.property_class': {
    canonicalField: 'properties.property_class',
    sourceColumns: ['property_class', 'canonical_property_group', 'property_group', 'asset_class', 'normalized_asset_class'],
  },
  'prospects.language_preference': {
    canonicalField: 'prospects.language_preference',
    sourceColumns: ['language_preference', 'best_language', 'language', 'preferred_language'],
  },
  'prospects.age_bucket': {
    canonicalField: 'prospects.age_bucket',
    sourceColumns: ['age_bucket', 'mob'],
  },
  'prospects.matching_flags': {
    canonicalField: 'prospects.matching_flags',
    sourceColumns: ['matching_flags', 'prospect_matching_flags', 'person_flags_text'],
  },
  'prospects.person_flags_text': {
    canonicalField: 'prospects.person_flags_text',
    sourceColumns: ['person_flags_text', 'matching_flags', 'prospect_matching_flags'],
  },
  'prospects.seller_tags_text': {
    canonicalField: 'prospects.seller_tags_text',
    sourceColumns: ['seller_tags_text', 'seller_tags_json'],
  },
  'master_owners.priority_tier': {
    canonicalField: 'master_owners.priority_tier',
    sourceColumns: ['priority_tier'],
  },
  'master_owners.owner_type_guess': {
    canonicalField: 'master_owners.owner_type_guess',
    sourceColumns: ['owner_type_guess'],
  },
  'master_owners.follow_up_cadence': {
    canonicalField: 'master_owners.follow_up_cadence',
    sourceColumns: ['follow_up_cadence'],
  },
  'master_owners.contactability_score': {
    canonicalField: 'master_owners.contactability_score',
    sourceColumns: ['contactability_score'],
  },
  'master_owners.financial_pressure_score': {
    canonicalField: 'master_owners.financial_pressure_score',
    sourceColumns: ['financial_pressure_score'],
  },
  'master_owners.urgency_score': {
    canonicalField: 'master_owners.urgency_score',
    sourceColumns: ['urgency_score'],
  },
  'master_owners.priority_score': {
    canonicalField: 'master_owners.priority_score',
    sourceColumns: ['priority_score', 'master_owner_priority_score', 'final_acquisition_score'],
  },
  'phones.phone_owner': {
    canonicalField: 'phones.phone_owner',
    sourceColumns: ['phone_owner', 'carrier_name', 'carrier', 'phone_carrier'],
  },
  'phones.activity_status': {
    canonicalField: 'phones.activity_status',
    sourceColumns: ['activity_status', 'phone_contact_status', 'contact_status'],
  },
  'phones.usage_12_months': {
    canonicalField: 'phones.usage_12_months',
    sourceColumns: ['usage_12_months'],
  },
  'phones.usage_2_months': {
    canonicalField: 'phones.usage_2_months',
    sourceColumns: ['usage_2_months'],
  },
  'outreach.never_contacted': {
    canonicalField: 'outreach.never_contacted',
    sourceColumns: ['never_contacted'],
  },
  'outreach.pending_prior_touch': {
    canonicalField: 'outreach.pending_prior_touch',
    sourceColumns: ['pending_prior_touch'],
  },
  'outreach.true_post_contact_suppression': {
    canonicalField: 'outreach.true_post_contact_suppression',
    sourceColumns: ['true_post_contact_suppression', 'post_contact_suppression', 'is_suppressed'],
  },
  'outreach.duplicate_queue_status': {
    canonicalField: 'outreach.duplicate_queue_status',
    sourceColumns: ['duplicate_queue_status'],
  },
  'sender_coverage.routing_allowed': {
    canonicalField: 'sender_coverage.routing_allowed',
    sourceColumns: ['routing_allowed'],
  },
  'sender_coverage.routing_tier': {
    canonicalField: 'sender_coverage.routing_tier',
    sourceColumns: ['routing_tier', 'selected_textgrid_routing_tier'],
  },
  'sender_coverage.selected_textgrid_market': {
    canonicalField: 'sender_coverage.selected_textgrid_market',
    sourceColumns: ['selected_textgrid_market'],
  },
  'sender_coverage.selected_textgrid_state': {
    canonicalField: 'sender_coverage.selected_textgrid_state',
    sourceColumns: ['selected_textgrid_state', 'seller_state', 'state', 'property_address_state'],
  },
  'sender_coverage.sender_coverage_status': {
    canonicalField: 'sender_coverage.sender_coverage_status',
    sourceColumns: ['sender_coverage_status'],
  },
})

const OPTION_VALUE_PAGE_SIZE = 1000
const OPTION_VALUE_MAX_ROWS = 200000
const OPTION_COUNT_MAX_ROWS = 5000
const CATALOG_HYDRATION_BATCH_SIZE = 250
const LINKED_COUNT_VALUE_COLUMN = '__campaign_option_value'
const OPTION_CACHE_TTL_MS = 30_000
const optionRowsCache = new Map()
const CAMPAIGN_TARGET_GRAPH_TABLE = 'campaign_target_graph'
const CAMPAIGN_TARGET_GRAPH_FACET_TABLE = 'campaign_target_graph_facets'
const CAMPAIGN_TARGET_GRAPH_REFRESH_RUN_TABLE = 'campaign_target_graph_refresh_runs'
const GRAPH_FACET_FIELD_ALIASES = Object.freeze({
  'properties.property_address_state': 'properties.property_state',
  'properties.property_address_zip': 'properties.property_zip',
  'properties.property_address_county_name': 'properties.property_county_name',
  'properties.seller_tags_json': 'properties.seller_tags_text',
  'prospects.person_flags_text': 'prospects.matching_flags',
  'prospects.seller_tags_text': 'properties.seller_tags_text',
  'sender_coverage.selected_textgrid_state': 'sender_coverage.selected_textgrid_state',
})
const ORDERED_CANDIDATE_SOURCES = new Set(['outbound_feeder_candidates', 'v_feeder_candidates_fast'])
const DEFAULT_COUNT_SOURCE_CANDIDATES = Object.freeze([
  'outbound_feeder_candidates',
  'v_sms_ready_contacts',
  'v_sms_campaign_queue_candidates',
])
const SOURCE_STABLE_ORDER_COLUMNS = Object.freeze({
  properties: 'property_id',
  prospects: 'prospect_id',
  master_owners: 'master_owner_id',
  phones: 'phone_id',
})
const TRUE_MARKET_COLUMNS = Object.freeze(['market', 'canonical_market', 'seller_market', 'market_name'])
const MARKET_FORBIDDEN_COLUMNS = Object.freeze([
  'property_address_city',
  'city',
  'owner_location',
  'property_address_county_name',
  'property_county_name',
  'county',
])
const MARKET_OPTION_SOURCE_CANDIDATES = Object.freeze([
  {
    source: 'markets',
    columns: ['market', 'canonical_market', 'market_name', 'name', 'label'],
  },
  {
    source: 'properties',
    columns: TRUE_MARKET_COLUMNS,
  },
])

const TEXT_OPERATORS = [
  { key: 'is_any_of', label: 'Is any of' },
  { key: 'is_not_any_of', label: 'Is not any of' },
  { key: 'contains', label: 'Contains' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const ENUM_OPERATORS = [
  { key: 'is_any_of', label: 'Is any of' },
  { key: 'is_not_any_of', label: 'Is not any of' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const NUMBER_OPERATORS = [
  { key: 'gte', label: 'Greater than or equal' },
  { key: 'lte', label: 'Less than or equal' },
  { key: 'between', label: 'Between' },
  { key: 'eq', label: 'Equal to' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const DATE_OPERATORS = [
  { key: 'on_or_after', label: 'On or after' },
  { key: 'on_or_before', label: 'On or before' },
  { key: 'between', label: 'Between' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const BOOLEAN_OPERATORS = [
  { key: 'is_true', label: 'Is true' },
  { key: 'is_false', label: 'Is false' },
]

const JSON_OPERATORS = [
  { key: 'contains', label: 'Contains' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const FIELD_GROUPS = [
  {
    domain: 'properties',
    category: 'Location & Market',
    // Canonical address geography only. The legacy property_state / property_zip /
    // property_county_name columns are deliberately excluded from the operator-facing
    // catalog because they are sparse mirrors; their field keys still resolve via
    // FIELD_KEY_ALIASES for backward compatibility with saved campaigns.
    columns: [
      'market',
      'market_region',
      'property_address_city',
      'property_address_county_name',
      'property_address_state',
      'property_address_zip',
      'owner_location',
    ],
  },
  {
    domain: 'properties',
    category: 'Asset Type & Structure',
    columns: [
      'property_type',
      'property_class',
      'units_count',
      'sum_commercial_units',
      'sum_garage_sqft',
      'building_square_feet',
      'avg_sqft_per_unit',
      'beds_per_unit',
      'total_bedrooms',
      'total_baths',
      'year_built',
      'effective_year_built',
      'sqft_range',
      'stories',
      'sum_buildings_nbr',
    ],
  },
  {
    domain: 'properties',
    category: 'Value, Equity & Debt',
    columns: [
      'estimated_value',
      'equity_amount',
      'equity_percent',
      'total_loan_balance',
      'total_loan_amt',
      'total_loan_payment',
      'sale_price',
      'sale_date',
      'ownership_years',
      'last_sale_doc_type',
    ],
  },
  {
    domain: 'properties',
    category: 'Distress & Motivation',
    columns: [
      'tax_delinquent',
      'tax_delinquent_year',
      'tax_amt',
      'active_lien',
      'document_type',
      'recording_date',
      'default_date',
      'past_due_amount',
      'seller_tags_text',
      'seller_tags_json',
      'property_flags_text',
      'structured_motivation_score',
      'deal_strength_score',
      'tag_distress_score',
      'final_acquisition_score',
    ],
  },
  {
    domain: 'properties',
    category: 'Condition & Repair',
    columns: [
      'building_condition',
      'building_quality',
      'estimated_repair_cost',
      'estimated_repair_cost_per_sqft',
      'rehab_level',
      'style',
      'construction_type',
      'exterior_walls',
      'floor_cover',
      'roof_cover',
      'roof_type',
      'air_conditioning',
      'heating_type',
      'heating_fuel_type',
      'interior_walls',
      'basement',
      'garage',
      'pool',
      'porch',
      'patio',
      'deck',
      'driveway',
      'other_rooms',
      'num_of_fireplaces',
    ],
  },
  {
    domain: 'properties',
    category: 'Land, Lot & Zoning',
    columns: [
      'lot_acreage',
      'lot_square_feet',
      'lot_nbr',
      'lot_size_depth_feet',
      'lot_size_frontage_feet',
      'topography',
      'zoning',
      'county_land_use_code',
      'subdivision_name',
      'school_district_name',
      'flood_zone',
      'geographic_features',
      'sewer',
      'water',
    ],
  },
  {
    domain: 'properties',
    category: 'Tax & Assessment',
    columns: [
      'assd_improvement_value',
      'assd_land_value',
      'assd_total_value',
      'assd_year',
      'calculated_improvement_value',
      'calculated_land_value',
      'calculated_total_value',
    ],
  },
  {
    domain: 'properties',
    category: 'Owner Relationship',
    columns: [
      'owner_type',
      'owner_type_guess',
      'is_corporate_owner',
      'out_of_state_owner',
      'property_address_range',
      'deal_list_label',
      'search_profile_hash',
    ],
  },
  {
    domain: 'prospects',
    category: 'Demographics',
    columns: [
      'language_preference',
      'gender',
      'marital_status',
      'education_model',
      'occupation_group',
      'est_household_income',
      'net_asset_value',
      'buying_power',
      'mob',
      'age_bucket',
      'timezone',
      'contact_window',
    ],
  },
  {
    domain: 'prospects',
    category: 'Matching & Eligibility',
    columns: [
      'matching_flags',
      'person_flags_text',
      'seller_tags_text',
      'sms_eligible',
      'email_eligible',
    ],
  },
  {
    domain: 'master_owners',
    category: 'Profile',
    columns: ['owner_type_guess', 'priority_tier', 'follow_up_cadence'],
  },
  {
    domain: 'master_owners',
    category: 'Scores',
    columns: [
      'contactability_score',
      'financial_pressure_score',
      'urgency_score',
      'priority_score',
    ],
  },
  {
    domain: 'master_owners',
    category: 'Portfolio Financials',
    columns: [
      'portfolio_total_value',
      'portfolio_total_equity',
      'portfolio_total_loan_balance',
      'portfolio_total_loan_payment',
      'portfolio_total_tax_amount',
      'portfolio_total_units',
      'property_count',
    ],
  },
  {
    domain: 'master_owners',
    category: 'Portfolio Distress',
    columns: [
      'tax_delinquent_count',
      'oldest_tax_delinquent_year',
      'active_lien_count',
      'max_ownership_years',
    ],
  },
  {
    domain: 'phones',
    category: 'Quality',
    columns: ['phone_owner', 'activity_status', 'usage_12_months', 'usage_2_months'],
  },
  {
    domain: 'outreach',
    category: 'Rules',
    columns: [
      'never_contacted',
      'last_sms_at',
      'last_outbound_at',
      'next_allowed_sms_at',
      'first_outbound_at',
      'last_touch_at',
      'touch_count',
      'current_touch_number',
      'true_post_contact_suppression',
      'pending_prior_touch',
      'duplicate_queue_status',
    ],
  },
  {
    domain: 'sender_coverage',
    category: 'Routing',
    columns: [
      'routing_allowed',
      'routing_tier',
      'selected_textgrid_market',
      'selected_textgrid_state',
      'sender_coverage_status',
    ],
  },
]

const NUMERIC_COLUMNS = new Set([
  'units_count',
  'sum_commercial_units',
  'building_square_feet',
  'avg_sqft_per_unit',
  'beds_per_unit',
  'total_bedrooms',
  'total_baths',
  'year_built',
  'effective_year_built',
  'stories',
  'sum_buildings_nbr',
  'estimated_value',
  'equity_amount',
  'equity_percent',
  'total_loan_balance',
  'total_loan_amt',
  'total_loan_payment',
  'sale_price',
  'ownership_years',
  'tax_delinquent_year',
  'tax_amt',
  'past_due_amount',
  'structured_motivation_score',
  'deal_strength_score',
  'tag_distress_score',
  'final_acquisition_score',
  'estimated_repair_cost',
  'estimated_repair_cost_per_sqft',
  'num_of_fireplaces',
  'lot_acreage',
  'lot_square_feet',
  'lot_size_depth_feet',
  'lot_size_frontage_feet',
  'assd_improvement_value',
  'assd_land_value',
  'assd_total_value',
  'assd_year',
  'calculated_improvement_value',
  'calculated_land_value',
  'calculated_total_value',
  'age',
  'contactability_score',
  'financial_pressure_score',
  'urgency_score',
  'priority_score',
  'portfolio_total_value',
  'portfolio_total_equity',
  'portfolio_total_loan_balance',
  'portfolio_total_loan_payment',
  'portfolio_total_tax_amount',
  'portfolio_total_units',
  'property_count',
  'tax_delinquent_count',
  'oldest_tax_delinquent_year',
  'active_lien_count',
  'max_ownership_years',
  'touch_count',
  'current_touch_number',
  'sum_garage_sqft',
])

const BOOLEAN_COLUMNS = new Set([
  'tax_delinquent',
  'active_lien',
  'is_corporate_owner',
  'out_of_state_owner',
  'sms_eligible',
  'email_eligible',
  'never_contacted',
  'true_post_contact_suppression',
  'pending_prior_touch',
  'routing_allowed',
])

const DATE_COLUMNS = new Set([
  'recording_date',
  'default_date',
  'last_sms_at',
  'last_outbound_at',
  'next_allowed_sms_at',
  'first_outbound_at',
  'last_touch_at',
])

const JSON_COLUMNS = new Set(['seller_tags_json', 'matching_flags'])

const ENUM_COLUMNS = new Set([
  'property_county_name',
  'property_state',
  'property_zip',
  'market',
  'market_region',
  'property_address_city',
  'property_address_county_name',
  'property_address_state',
  'property_address_zip',
  'owner_location',
  'property_type',
  'property_class',
  'sqft_range',
  'sale_date',
  'last_sale_doc_type',
  'document_type',
  'building_condition',
  'building_quality',
  'rehab_level',
  'style',
  'construction_type',
  'exterior_walls',
  'floor_cover',
  'roof_cover',
  'roof_type',
  'air_conditioning',
  'heating_type',
  'heating_fuel_type',
  'interior_walls',
  'basement',
  'garage',
  'pool',
  'porch',
  'patio',
  'deck',
  'driveway',
  'other_rooms',
  'topography',
  'zoning',
  'county_land_use_code',
  'subdivision_name',
  'school_district_name',
  'flood_zone',
  'geographic_features',
  'sewer',
  'water',
  'owner_type',
  'owner_type_guess',
  'property_address_range',
  'deal_list_label',
  'lot_nbr',
  'language_preference',
  'gender',
  'marital_status',
  'education_model',
  'occupation_group',
  'est_household_income',
  'net_asset_value',
  'buying_power',
  'mob',
  'age_bucket',
  'timezone',
  'contact_window',
  'person_flags_text',
  'priority_tier',
  'follow_up_cadence',
  'phone_owner',
  'activity_status',
  'usage_12_months',
  'usage_2_months',
  'duplicate_queue_status',
  'routing_tier',
  'selected_textgrid_market',
  'selected_textgrid_state',
  'sender_coverage_status',
])

const PREVIEW_SUPPORTED_FIELD_KEYS = new Set([
  'properties.property_id',
  'properties.property_county_name',
  'properties.property_state',
  'properties.property_zip',
  'properties.market',
  'properties.property_address_city',
  'properties.property_address_county_name',
  'properties.property_address_state',
  'properties.property_address_zip',
  'properties.property_type',
  'properties.property_class',
  'properties.units_count',
  'properties.tax_delinquent',
  'properties.active_lien',
  'properties.property_flags_text',
  'properties.building_condition',
  'properties.rehab_level',
  'properties.estimated_value',
  'properties.equity_amount',
  'properties.equity_percent',
  'properties.seller_tags_text',
  // properties.seller_tags_json intentionally NOT preview-supported: it is a JSON
  // mirror of seller_tags_text with no campaign_target_graph column of its own, so
  // applying it would be silently skipped ("no graph column mapping found").
  // seller_tags_text -> graph.podio_tags already covers tag filtering in preview.
  'properties.structured_motivation_score',
  'properties.deal_strength_score',
  'properties.tag_distress_score',
  'properties.final_acquisition_score',
  'properties.owner_type',
  'properties.owner_type_guess',
  'properties.is_corporate_owner',
  'properties.out_of_state_owner',
  'prospects.language_preference',
  'prospects.gender',
  'prospects.marital_status',
  'prospects.education_model',
  'prospects.occupation_group',
  'prospects.est_household_income',
  'prospects.net_asset_value',
  'prospects.buying_power',
  'prospects.age_bucket',
  'prospects.timezone',
  'prospects.contact_window',
  'prospects.matching_flags',
  'prospects.person_flags_text',
  'prospects.seller_tags_text',
  'prospects.sms_eligible',
  'prospects.email_eligible',
  'master_owners.owner_type_guess',
  'master_owners.priority_tier',
  'master_owners.follow_up_cadence',
  'master_owners.priority_score',
  'phones.phone_owner',
  'phones.activity_status',
  'phones.usage_12_months',
  'phones.usage_2_months',
  'outreach.never_contacted',
  'outreach.last_sms_at',
  'outreach.last_outbound_at',
  'outreach.last_touch_at',
  'outreach.touch_count',
  'outreach.current_touch_number',
  'outreach.true_post_contact_suppression',
  'outreach.pending_prior_touch',
  'outreach.duplicate_queue_status',
  'sender_coverage.routing_allowed',
  'sender_coverage.routing_tier',
  'sender_coverage.selected_textgrid_market',
  'sender_coverage.selected_textgrid_state',
  'sender_coverage.sender_coverage_status',
])

const SPECIAL_LABELS = {
  age: 'Age',
  age_bucket: 'Age Bucket',
  sms_eligible: 'SMS Eligible',
  email_eligible: 'Email Eligible',
  mob: 'Age',
  phone_owner: 'Carrier / Phone Owner',
  sqft_range: 'Sqft Range',
  avg_sqft_per_unit: 'Avg Sqft Per Unit',
  selected_textgrid_market: 'Selected TextGrid Market',
  selected_textgrid_state: 'Selected TextGrid State',
}

function clean(value) {
  return String(value ?? '').trim()
}

function graphOptionErrorMessage(error) {
  if (!error) return 'unknown_error'
  if (typeof error === 'string') return error
  if (error.message) return error.message
  try {
    const json = JSON.stringify(error)
    if (json && json !== '{}') return json
  } catch {
    // best effort below
  }
  return String(error)
}

function uniqueClean(values = []) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))]
}

function normalizeSlug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function humanizeColumn(column) {
  if (SPECIAL_LABELS[column]) return SPECIAL_LABELS[column]
  return column
    .split('_')
    .map((part) => {
      if (part === 'sms') return 'SMS'
      if (part === 'sqft') return 'Sqft'
      if (part === 'nbr') return 'Number'
      if (part === 'amt') return 'Amount'
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

function resolveFieldType(domain, column) {
  if (`${domain}.${column}` === 'prospects.matching_flags') return 'text'
  if (BOOLEAN_COLUMNS.has(column)) return 'boolean'
  if (DATE_COLUMNS.has(column)) return 'date'
  if (NUMERIC_COLUMNS.has(column)) return 'number'
  if (JSON_COLUMNS.has(column)) return 'json'
  if (ENUM_COLUMNS.has(column)) return 'text'
  return 'text'
}

function operatorsForType(type) {
  if (type === 'boolean') return BOOLEAN_OPERATORS
  if (type === 'date') return DATE_OPERATORS
  if (type === 'number') return NUMBER_OPERATORS
  if (type === 'json') return JSON_OPERATORS
  if (type === 'enum') return ENUM_OPERATORS
  return TEXT_OPERATORS
}

function descriptionForField(domain, category, label) {
  const domainDef = CAMPAIGN_DOMAINS.find((entry) => entry.id === domain)
  return `${label} filter from ${domainDef?.description?.replace(/\.$/, '').toLowerCase() || category.toLowerCase()}.`
}

function buildFieldCatalog() {
  return FIELD_GROUPS.flatMap(({ domain, category, columns }) =>
    columns.map((column) => {
      const type = resolveFieldType(domain, column)
      const derivedFrom = column === 'age_bucket' ? 'mob' : undefined
      const sourceColumn = derivedFrom || column
      const supportsOptions = type === 'enum' || type === 'text' || type === 'json'
      return {
        key: `${domain}.${column}`,
        domain,
        category,
        label: humanizeColumn(column),
        source_table_or_view: SOURCE_BY_DOMAIN[domain],
        source_column: sourceColumn,
        type,
        operators: operatorsForType(type),
        filterable: true,
        searchable: type === 'enum' || type === 'text' || type === 'json',
        supports_options: supportsOptions,
        supports_counts: true,
        supported_in_preview: PREVIEW_SUPPORTED_FIELD_KEYS.has(`${domain}.${column}`),
        description: descriptionForField(domain, category, humanizeColumn(column)),
        ...(derivedFrom ? { derived_from: derivedFrom } : {}),
      }
    })
  )
}

export const CAMPAIGN_FIELD_CATALOG = Object.freeze(buildFieldCatalog())
export const CAMPAIGN_FIELD_BY_KEY = new Map(CAMPAIGN_FIELD_CATALOG.map((field) => [field.key, field]))

export function normalizeCampaignFieldKey(value) {
  const normalized = clean(value)
  return FIELD_KEY_ALIASES[normalized] || normalized
}

export function getCampaignFieldDefinition(fieldKey) {
  return CAMPAIGN_FIELD_BY_KEY.get(normalizeCampaignFieldKey(fieldKey)) || null
}

export function getCampaignCanonicalSourceMapping(fieldKey) {
  const normalized = normalizeCampaignFieldKey(fieldKey)
  const field = getCampaignFieldDefinition(normalized)
  if (!field) return null
  const mapping = CANONICAL_SOURCE_MAPPINGS[normalized]
  const sourceColumns = mapping?.sourceColumns?.length
    ? mapping.sourceColumns
    : [field.source_column]
  return {
    canonicalField: mapping?.canonicalField || field.key,
    sourceUsed: field.source_table_or_view,
    sourceColumns: uniqueClean(sourceColumns),
    diagnosticFallbackColumns: uniqueClean(mapping?.diagnosticFallbackColumns || []),
    forbiddenColumns: uniqueClean(mapping?.forbiddenColumns || []),
    unavailableWarning: mapping?.unavailableWarning || 'field_options_unavailable',
  }
}

export function getCampaignDomainKeys() {
  return [...DOMAIN_KEYS]
}

export function getCampaignFieldCatalogResponse({ generated_at = new Date().toISOString() } = {}) {
  const domains = CAMPAIGN_DOMAINS.map((domain) => ({
    id: domain.id,
    domain: domain.id,
    label: domain.label,
    description: domain.description,
    categories: domain.categories.map((category) => ({
      id: `${domain.id}.${normalizeSlug(category)}`,
      label: category,
      fields: CAMPAIGN_FIELD_CATALOG.filter((field) => field.domain === domain.id && field.category === category),
    })),
  }))

  return {
    ok: true,
    domains,
    total_fields: CAMPAIGN_FIELD_CATALOG.length,
    generated_at,
  }
}

function isSafeSqlIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(clean(value))
}

function normalizeSearch(value) {
  return clean(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120)
}

function parseMaybeJson(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return value
  const text = clean(value)
  if (!text) return []
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function flattenOptionValues(value, field) {
  if (field.key === 'prospects.mob') {
    const age = ageFromMob(value)
    return age === null ? [] : [String(age)]
  }

  if (field.key === 'prospects.age_bucket') {
    const text = clean(value)
    if (['Under 35', '35-44', '45-54', '55-64', '65-74', '75+'].includes(text)) return [text]
    const bucket = ageBucketFromMob(value)
    return bucket ? [bucket] : []
  }

  const parsed = parseMaybeJson(value)
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => flattenOptionValues(item, { ...field, key: `${field.key}.__nested` }))
  }
  if (parsed && typeof parsed === 'object') {
    const label = clean(parsed.label || parsed.value || parsed.name || parsed.key)
    return label ? [label] : []
  }

  const text = clean(parsed)
  if (!text) return []
  if (field.key.includes('tags_text') || field.key.includes('flags_text') || field.key.endsWith('.matching_flags')) {
    return text.split(/[,\n;|]+/).map((item) => clean(item)).filter(Boolean)
  }
  return [text]
}

export function ageFromMob(value, now = new Date()) {
  if (value === null || value === undefined || clean(value) === '') return null
  const text = clean(value)
  const numeric = Number(text)
  if (Number.isFinite(numeric)) {
    if (numeric > 0 && numeric <= 120) return Math.trunc(numeric)
    if (numeric >= 1900 && numeric <= now.getUTCFullYear()) return now.getUTCFullYear() - Math.trunc(numeric)
    if (/^\d{8}$/.test(text)) {
      const year = Number(text.slice(0, 4))
      const month = Number(text.slice(4, 6))
      const day = Number(text.slice(6, 8))
      return ageFromDateParts(year, month, day, now)
    }
    if (/^\d{6}$/.test(text)) {
      const year = Number(text.slice(0, 4))
      const month = Number(text.slice(4, 6))
      return ageFromDateParts(year, month, 1, now)
    }
  }

  const parsed = new Date(text)
  if (Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() > 1900) {
    return ageFromDateParts(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(), now)
  }
  return null
}

function ageFromDateParts(year, month, day, now = new Date()) {
  if (!Number.isFinite(year) || year < 1900 || year > now.getUTCFullYear()) return null
  let age = now.getUTCFullYear() - year
  const currentMonth = now.getUTCMonth() + 1
  const currentDay = now.getUTCDate()
  if (month > currentMonth || (month === currentMonth && day > currentDay)) age -= 1
  return age >= 0 && age <= 120 ? age : null
}

export function ageBucketFromMob(value, now = new Date()) {
  const age = ageFromMob(value, now)
  if (age === null) return null
  if (age < 35) return 'Under 35'
  if (age <= 44) return '35-44'
  if (age <= 54) return '45-54'
  if (age <= 64) return '55-64'
  if (age <= 74) return '65-74'
  return '75+'
}

function optionLabel(value) {
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  const text = clean(value)
  if (text.toLowerCase() === 'true') return 'True'
  if (text.toLowerCase() === 'false') return 'False'
  return text
}

function optionValue(value, field) {
  if (field?.type === 'boolean') return normalizeComparable(value)
  return clean(value)
}

function canReturnOptionsForField(field) {
  return Boolean(field?.supports_options || field?.type === 'boolean')
}

function optionModeForField(field) {
  if (field?.type === 'boolean') return 'boolean'
  if (field?.key === 'prospects.age_bucket') return 'derived_bucket'
  if (field?.type === 'number' || field?.type === 'date') return 'range'
  return 'distinct'
}

function graphFacetKeyForField(field) {
  if (!field?.key) return null
  return GRAPH_FACET_FIELD_ALIASES[field.key] || field.key
}

function graphSourceColumnForField(field) {
  const facetKey = graphFacetKeyForField(field)
  const column = facetKey?.split('.').pop() || field?.source_column || null
  return ({
    property_state: 'state',
    property_address_state: 'state',
    property_zip: 'property_zip',
    property_address_zip: 'property_zip',
    property_address_city: 'property_city',
    property_county_name: 'property_county_name',
    property_address_county_name: 'property_county_name',
    seller_tags_text: 'podio_tags',
    seller_tags_json: 'podio_tags',
    language_preference: 'language',
    est_household_income: 'income',
    selected_textgrid_market: 'sender_market',
    selected_textgrid_state: 'state',
    routing_allowed: 'sender_covered',
    sender_coverage_status: 'sender_covered',
  })[column] || column
}

async function readCampaignGraphOptionStatus(supabase) {
  if (!supabase) {
    return {
      graph_refresh_scope: 'unknown',
      graph_row_count: null,
      facet_count: null,
      latest_generated_at: null,
      latest_facet_updated_at: null,
      refresh_run_id: null,
      refresh_status: null,
      refresh_finished_at: null,
      warnings: ['campaign_target_graph_facets_unavailable'],
    }
  }

  const warnings = []
  const [graphResult, facetResult, runResult] = await Promise.all([
    supabase
      .from(CAMPAIGN_TARGET_GRAPH_TABLE)
      .select('generated_at', { count: 'exact' })
      .order('generated_at', { ascending: false, nullsFirst: false })
      .limit(1),
    supabase
      .from(CAMPAIGN_TARGET_GRAPH_FACET_TABLE)
      .select('updated_at', { count: 'exact' })
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1),
    supabase
      .from(CAMPAIGN_TARGET_GRAPH_REFRESH_RUN_TABLE)
      .select('id,status,graph_rows,facet_rows,started_at,finished_at,metadata')
      .order('started_at', { ascending: false })
      .limit(1),
  ])

  if (graphResult.error) warnings.push(`campaign_target_graph_status_unavailable:${graphOptionErrorMessage(graphResult.error)}`)
  if (facetResult.error) warnings.push(`campaign_target_graph_facet_status_unavailable:${graphOptionErrorMessage(facetResult.error)}`)
  if (runResult.error) warnings.push(`campaign_target_graph_refresh_run_unavailable:${graphOptionErrorMessage(runResult.error)}`)

  const run = Array.isArray(runResult.data) ? runResult.data[0] : null
  const metadata = run?.metadata && typeof run.metadata === 'object' ? run.metadata : {}
  const graphRowCount = Number(graphResult.count || 0)
  const facetCount = Number(facetResult.count || 0)

  return {
    graph_refresh_scope: clean(metadata.graph_refresh_scope) || (graphRowCount > 0 ? 'unknown' : 'empty'),
    graph_row_count: graphRowCount,
    facet_count: facetCount,
    latest_generated_at: Array.isArray(graphResult.data) ? graphResult.data[0]?.generated_at || null : null,
    latest_facet_updated_at: Array.isArray(facetResult.data) ? facetResult.data[0]?.updated_at || null : null,
    refresh_run_id: run?.id || null,
    refresh_status: run?.status || null,
    refresh_started_at: run?.started_at || null,
    refresh_finished_at: run?.finished_at || null,
    refresh_graph_rows: Number(run?.graph_rows || 0),
    refresh_facet_rows: Number(run?.facet_rows || 0),
    warnings,
  }
}

function graphOptionResponseBase({
  field,
  canonicalField,
  option_mode,
  warnings = [],
  graphRefreshStatus = null,
  startedAt,
}) {
  return {
    field,
    sourceUsed: CAMPAIGN_TARGET_GRAPH_TABLE,
    sourceColumn: graphSourceColumnForField(field),
    optionSourceTableOrView: CAMPAIGN_TARGET_GRAPH_FACET_TABLE,
    optionColumn: 'value',
    countSourceUsed: CAMPAIGN_TARGET_GRAPH_TABLE,
    countColumn: 'target_count',
    countSourceTableOrView: CAMPAIGN_TARGET_GRAPH_FACET_TABLE,
    countJoinStrategy: 'precomputed_target_graph_facet',
    countMeaning: 'precomputed campaign target graph path rows matching this option',
    graphRefreshStatus,
    graph_refresh_scope: graphRefreshStatus?.graph_refresh_scope || null,
    graph_row_count: graphRefreshStatus?.graph_row_count ?? null,
    graph_freshness: graphRefreshStatus ? {
      latest_generated_at: graphRefreshStatus.latest_generated_at || null,
      latest_facet_updated_at: graphRefreshStatus.latest_facet_updated_at || null,
      refresh_finished_at: graphRefreshStatus.refresh_finished_at || null,
      refresh_status: graphRefreshStatus.refresh_status || null,
      refresh_run_id: graphRefreshStatus.refresh_run_id || null,
    } : null,
    option_mode,
    canonicalField,
    warnings: [...new Set(warnings)],
    queryMs: Date.now() - startedAt,
  }
}

async function queryGraphFacetOptions({
  supabase,
  field,
  search = '',
  limit = 50,
  startedAt = Date.now(),
  canonicalField = null,
  option_mode = 'distinct',
} = {}) {
  const normalizedSearch = normalizeSearch(search)
  const requestedLimit = Math.max(1, Math.min(Number(limit) || 50, 250))
  const facetKey = graphFacetKeyForField(field)
  const graphRefreshStatus = await readCampaignGraphOptionStatus(supabase)
  const base = graphOptionResponseBase({
    field,
    canonicalField,
    option_mode,
    graphRefreshStatus,
    warnings: graphRefreshStatus.warnings || [],
    startedAt,
  })

  if (option_mode === 'range') {
    return {
      ok: true,
      ...base,
      options: [],
      countJoinStrategy: 'range_input_no_dropdown',
      countMeaning: 'range input; dropdown options are not generated',
      queryMs: Date.now() - startedAt,
    }
  }

  if (!facetKey || !supabase) {
    return {
      ok: true,
      ...base,
      options: [],
      warning: 'campaign_target_graph_facets_unavailable',
      warnings: uniqueClean([...(base.warnings || []), 'campaign_target_graph_facets_unavailable']),
      queryMs: Date.now() - startedAt,
    }
  }

  let query = supabase
    .from(CAMPAIGN_TARGET_GRAPH_FACET_TABLE)
    .select('field_key,value,label,target_count,clean_count,queueable_count,sender_covered_count,sms_eligible_count,updated_at')
    .eq('field_key', facetKey)
    .order('target_count', { ascending: false })
    .order('label', { ascending: true })
    .limit(requestedLimit)

  if (normalizedSearch) query = query.ilike('label', `%${normalizedSearch}%`)

  const { data, error } = await query
  if (error) {
    const message = error?.message || String(error)
    return {
      ok: true,
      ...base,
      options: [],
      warning: 'campaign_target_graph_facets_unavailable',
      message,
      warnings: uniqueClean([...(base.warnings || []), `campaign_target_graph_facets_unavailable:${message}`]),
      queryMs: Date.now() - startedAt,
    }
  }

  const options = (Array.isArray(data) ? data : []).map((row) => ({
    value: row.value,
    label: row.label || row.value,
    count: Number(row.target_count || 0),
    clean_count: Number(row.clean_count || 0),
    queueable_count: Number(row.queueable_count || 0),
    sender_covered_count: Number(row.sender_covered_count || 0),
    sms_eligible_count: Number(row.sms_eligible_count || 0),
    healthy_count: Number(row.sender_covered_count || 0),
    count_source: 'campaign_target_graph',
    sourceColumn: facetKey,
  }))

  return {
    ok: true,
    ...base,
    options,
    sourceColumn: graphSourceColumnForField(field),
    queryMs: Date.now() - startedAt,
  }
}

function normalizeComparable(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return clean(value).toLowerCase()
}

function normalizeComparableSlug(value) {
  return normalizeComparable(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function optionLookupKeys(value) {
  return uniqueClean([
    clean(value),
    normalizeComparable(value),
    normalizeComparableSlug(value),
  ])
}

function optionSourceCandidatesForField(field, mapping) {
  if (field.key === 'properties.market') return MARKET_OPTION_SOURCE_CANDIDATES
  if (field.domain === 'outreach' || field.domain === 'sender_coverage') {
    return DEFAULT_COUNT_SOURCE_CANDIDATES.map((source) => ({
      source,
      columns: uniqueClean(mapping?.sourceColumns || [field.source_column]),
    }))
  }
  return [
    {
      source: mapping?.sourceUsed || field.source_table_or_view,
      columns: uniqueClean(mapping?.sourceColumns || [field.source_column]),
    },
  ]
}

function countSourceCandidatesForField(field, mapping, selectedOptionColumn) {
  const columns = uniqueClean([
    ...(mapping?.sourceColumns || []),
    selectedOptionColumn,
    field.source_column,
    field.key.split('.').pop(),
  ])
  const safeColumns = field.key === 'properties.market'
    ? columns.filter((column) => !MARKET_FORBIDDEN_COLUMNS.includes(column))
    : columns

  return DEFAULT_COUNT_SOURCE_CANDIDATES.map((source) => ({
    source,
    columns: safeColumns,
  }))
}

function countMeaningForField(field, sourceUsed = null) {
  if (!sourceUsed) return 'raw source rows for this option'
  if (['properties', 'prospects', 'master_owners', 'phones'].includes(sourceUsed)) {
    return `all public.${sourceUsed} rows matching this option`
  }
  return `property-anchored candidate rows in ${sourceUsed} matching this option`
}

function isSafeSourceCandidate(candidate = {}) {
  return isSafeSqlIdentifier(candidate.source) && (candidate.columns || []).every(isSafeSqlIdentifier)
}

async function fetchColumnRows({
  supabase,
  source,
  column,
  field,
  search = '',
  maxRows = OPTION_VALUE_MAX_ROWS,
  pageSize = OPTION_VALUE_PAGE_SIZE,
  propertyAnchored = false,
} = {}) {
  const rows = []
  const normalizedSearch = normalizeSearch(search)
  const canSearchInDb =
    normalizedSearch &&
    field?.derived_from !== 'mob' &&
    (field?.type === 'enum' || field?.type === 'text')

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const selectColumns = propertyAnchored ? uniqueClean([column, 'property_id']).join(',') : column
    let query = supabase
      .from(source)
      .select(selectColumns)
      .range(offset, Math.min(offset + pageSize - 1, maxRows - 1))

    if (!propertyAnchored) query = query.not(column, 'is', null)

    if (ORDERED_CANDIDATE_SOURCES.has(source)) {
      query = query
        .order('never_contacted', { ascending: false, nullsFirst: false })
        .order('touch_count', { ascending: true, nullsFirst: true })
        .order('final_acquisition_score', { ascending: false, nullsFirst: false })
        .order('best_phone_score', { ascending: false, nullsFirst: false })
    } else if (SOURCE_STABLE_ORDER_COLUMNS[source]) {
      query = query.order(SOURCE_STABLE_ORDER_COLUMNS[source], { ascending: true, nullsFirst: false })
    }

    if (canSearchInDb) {
      query = query.ilike(column, `%${normalizedSearch}%`)
    }

    const { data, error } = await query
    if (error) {
      return {
        ok: false,
        source,
        column,
        rows: [],
        error,
        message: error?.message || String(error),
      }
    }

    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < pageSize || rows.length >= maxRows) {
      return {
        ok: true,
        source,
        column,
        rows,
        truncated: rows.length >= maxRows && page.length === pageSize,
      }
    }
  }

  return {
    ok: true,
    source,
    column,
    rows,
    truncated: rows.length >= maxRows,
  }
}

async function fetchFirstUsableColumnRows({
  supabase,
  candidates = [],
  field,
  search = '',
  maxRows = OPTION_VALUE_MAX_ROWS,
  propertyAnchored = false,
} = {}) {
  const attempts = []
  let firstEmpty = null

  for (const candidate of candidates) {
    if (!isSafeSourceCandidate(candidate)) {
      attempts.push({
        source: candidate.source,
        columns: candidate.columns || [],
        ok: false,
        message: 'unsafe_source_mapping',
      })
      continue
    }

    for (const column of uniqueClean(candidate.columns || [])) {
      const result = await fetchColumnRows({
        supabase,
        source: candidate.source,
        column,
        field,
        search,
        maxRows,
        propertyAnchored,
      })
      attempts.push({
        source: candidate.source,
        column,
        ok: result.ok,
        rows: result.rows?.length || 0,
        truncated: Boolean(result.truncated),
        message: result.message || null,
      })

      if (!result.ok) continue
      if (result.rows.length > 0) return { ...result, attempts }
      if (!firstEmpty) firstEmpty = result
    }
  }

  if (firstEmpty) return { ...firstEmpty, attempts }
  return { ok: false, rows: [], attempts }
}

function optionRowsCacheKey({ candidates = [], field, search = '', maxRows = OPTION_VALUE_MAX_ROWS }) {
  return JSON.stringify({
    candidates,
    field: field?.key || '',
    search: normalizeSearch(search),
    maxRows,
  })
}

async function fetchCachedOptionRows(input = {}) {
  const normalizedSearch = normalizeSearch(input.search)
  const key = optionRowsCacheKey({ ...input, search: normalizedSearch })
  const cached = optionRowsCache.get(key)
  if (cached && Date.now() - cached.at < OPTION_CACHE_TTL_MS) {
    return {
      ...cached.value,
      cached: true,
    }
  }
  const value = await fetchFirstUsableColumnRows({
    ...input,
    search: normalizedSearch,
  })
  optionRowsCache.set(key, { at: Date.now(), value })
  if (optionRowsCache.size > 100) {
    const oldest = [...optionRowsCache.entries()].sort((left, right) => left[1].at - right[1].at)[0]
    if (oldest) optionRowsCache.delete(oldest[0])
  }
  return value
}

function addOptionBucket(buckets, rawValue, field, sourceColumn, rawCount = 1) {
  for (const flattened of flattenOptionValues(rawValue, field)) {
    const label = optionLabel(flattened)
    const value = optionValue(flattened, field)
    if (!label || !value) continue
    const key = value
    const bucket = buckets.get(key) || {
      value,
      label,
      count: 0,
      rawSourceCount: 0,
      sample: rawValue,
      disabled: false,
      disabled_reason: null,
      sourceColumn,
    }
    bucket.rawSourceCount += rawCount
    buckets.set(key, bucket)
  }
}

function buildOptionBuckets(rows = [], sourceColumn, field, search = '') {
  const buckets = new Map()
  const normalizedSearch = normalizeSearch(search).toLowerCase()

  for (const row of rows || []) {
    const rawValue = row?.[sourceColumn]
    const beforeSize = buckets.size
    addOptionBucket(buckets, rawValue, field, sourceColumn)
    if (normalizedSearch && buckets.size !== beforeSize) {
      for (const [key, bucket] of [...buckets.entries()]) {
        const haystack = `${bucket.label} ${bucket.value}`.toLowerCase()
        if (!haystack.includes(normalizedSearch)) buckets.delete(key)
      }
    }
  }

  return buckets
}

function buildCandidateCountLookup(rows = [], countColumn, field) {
  const countByKey = new Map()
  for (const row of rows || []) {
    const propertyId = clean(row?.property_id)
    if (propertyId === '') continue
    const rawValue = row?.[countColumn]
    const flattened = flattenOptionValues(rawValue, field)
    const rowKeys = new Set(flattened.flatMap(optionLookupKeys))
    for (const key of rowKeys) {
      countByKey.set(key, Number(countByKey.get(key) || 0) + 1)
    }
  }
  return countByKey
}

function countForOption(countByKey, option) {
  for (const key of optionLookupKeys(option.value || option.label)) {
    if (countByKey.has(key)) return Number(countByKey.get(key) || 0)
  }
  for (const key of optionLookupKeys(option.label)) {
    if (countByKey.has(key)) return Number(countByKey.get(key) || 0)
  }
  return 0
}

function chunkValues(values = [], size = CATALOG_HYDRATION_BATCH_SIZE) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function rowKey(value) {
  return clean(value)
}

function uniqueRowKeys(values = []) {
  return uniqueClean(values.map(rowKey))
}

function sourceColumnsForDomain(domain) {
  return CAMPAIGN_FIELD_CATALOG
    .filter((field) => field.domain === domain)
    .map((field) => field.source_column)
}

function tableSelectColumns(domain) {
  const linkColumns = {
    properties: ['property_id', 'master_owner_id'],
    prospects: ['prospect_id', 'canonical_prospect_id', 'master_owner_id'],
    master_owners: ['master_owner_id'],
    phones: ['phone_id', 'master_owner_id', 'canonical_prospect_id', 'primary_prospect_id'],
  }[domain] || []
  return uniqueClean([...linkColumns, ...sourceColumnsForDomain(domain)])
    .filter(isSafeSqlIdentifier)
    .join(',')
}

async function fetchRowsByIn({ supabase, table, select, column, values }) {
  const rows = []
  const errors = []
  const safeValues = uniqueRowKeys(values)
  if (!safeValues.length) return { rows, errors }

  for (const chunk of chunkValues(safeValues)) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .in(column, chunk)

    if (error) {
      errors.push({
        table,
        column,
        message: error?.message || String(error),
      })
      continue
    }
    rows.push(...(Array.isArray(data) ? data : []))
  }

  return { rows, errors }
}

function mapRowsBy(rows = [], column) {
  const map = new Map()
  for (const row of rows) {
    const key = rowKey(row?.[column])
    if (key && !map.has(key)) map.set(key, row)
  }
  return map
}

function groupRowsBy(rows = [], column) {
  const map = new Map()
  for (const row of rows) {
    const key = rowKey(row?.[column])
    if (!key) continue
    const list = map.get(key) || []
    list.push(row)
    map.set(key, list)
  }
  return map
}

function uniqueRowsBy(rows = [], column) {
  const seen = new Set()
  const unique = []
  for (const row of rows) {
    const key = rowKey(row?.[column]) || JSON.stringify(row)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  return unique
}

function candidateId(candidate = {}, key) {
  const raw = candidate.raw && typeof candidate.raw === 'object' ? candidate.raw : {}
  return rowKey(candidate[key] ?? raw[key])
}

export async function hydrateCampaignCandidateRowsWithCatalogLayers(rows = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase
  const candidates = Array.isArray(rows) ? rows : []
  const requestedDomains = new Set(Array.isArray(deps.domains) && deps.domains.length
    ? deps.domains
    : ['properties', 'prospects', 'master_owners', 'phones'])
  const wantsDomain = (domain) => requestedDomains.has(domain)
  if (!supabase || !candidates.length) {
    return {
      ok: Boolean(supabase),
      rows: candidates,
      warnings: supabase ? [] : ['catalog_hydration_supabase_unavailable'],
      counts: {},
    }
  }

  const propertyIds = uniqueRowKeys(candidates.map((candidate) => candidateId(candidate, 'property_id')))
  const masterOwnerIds = uniqueRowKeys(candidates.map((candidate) => candidateId(candidate, 'master_owner_id')))
  const prospectIds = uniqueRowKeys(candidates.flatMap((candidate) => [
    candidateId(candidate, 'primary_prospect_id'),
    candidateId(candidate, 'canonical_prospect_id'),
    candidateId(candidate, 'prospect_id'),
  ]))
  const phoneIds = uniqueRowKeys(candidates.flatMap((candidate) => [
    candidateId(candidate, 'best_phone_id'),
    candidateId(candidate, 'phone_id'),
  ]))

  const [
    propertiesByPropertyIdResult,
    masterOwnersResult,
    prospectsByMasterOwnerResult,
    prospectsByProspectIdResult,
    phonesByMasterOwnerResult,
    phonesByPhoneIdResult,
  ] = await Promise.all([
    wantsDomain('properties') ? fetchRowsByIn({
      supabase,
      table: 'properties',
      select: tableSelectColumns('properties'),
      column: 'property_id',
      values: propertyIds,
    }) : { rows: [], errors: [] },
    wantsDomain('master_owners') ? fetchRowsByIn({
      supabase,
      table: 'master_owners',
      select: tableSelectColumns('master_owners'),
      column: 'master_owner_id',
      values: masterOwnerIds,
    }) : { rows: [], errors: [] },
    wantsDomain('prospects') ? fetchRowsByIn({
      supabase,
      table: 'prospects',
      select: tableSelectColumns('prospects'),
      column: 'master_owner_id',
      values: masterOwnerIds,
    }) : { rows: [], errors: [] },
    wantsDomain('prospects') ? fetchRowsByIn({
      supabase,
      table: 'prospects',
      select: tableSelectColumns('prospects'),
      column: 'prospect_id',
      values: prospectIds,
    }) : { rows: [], errors: [] },
    wantsDomain('phones') ? fetchRowsByIn({
      supabase,
      table: 'phones',
      select: tableSelectColumns('phones'),
      column: 'master_owner_id',
      values: masterOwnerIds,
    }) : { rows: [], errors: [] },
    wantsDomain('phones') ? fetchRowsByIn({
      supabase,
      table: 'phones',
      select: tableSelectColumns('phones'),
      column: 'phone_id',
      values: phoneIds,
    }) : { rows: [], errors: [] },
  ])

  const warnings = [
    propertiesByPropertyIdResult,
    masterOwnersResult,
    prospectsByMasterOwnerResult,
    prospectsByProspectIdResult,
    phonesByMasterOwnerResult,
    phonesByPhoneIdResult,
  ].flatMap((result) => result.errors || []).map((error) => `catalog_hydration_partial:${error.table}.${error.column}:${error.message}`)

  const propertyById = mapRowsBy(propertiesByPropertyIdResult.rows, 'property_id')
  const masterOwnerById = mapRowsBy(masterOwnersResult.rows, 'master_owner_id')
  const prospectsByMasterOwner = groupRowsBy(prospectsByMasterOwnerResult.rows, 'master_owner_id')
  const prospectById = mapRowsBy(prospectsByProspectIdResult.rows, 'prospect_id')
  const phonesByMasterOwner = groupRowsBy(phonesByMasterOwnerResult.rows, 'master_owner_id')
  const phoneById = mapRowsBy(phonesByPhoneIdResult.rows, 'phone_id')

  const hydratedRows = candidates.map((candidate) => {
    const propertyId = candidateId(candidate, 'property_id')
    const masterOwnerId = candidateId(candidate, 'master_owner_id')
    const primaryProspectId = candidateId(candidate, 'primary_prospect_id')
    const canonicalProspectId = candidateId(candidate, 'canonical_prospect_id')
    const prospectId = candidateId(candidate, 'prospect_id')
    const bestPhoneId = candidateId(candidate, 'best_phone_id')
    const phoneId = candidateId(candidate, 'phone_id')
    const exactProspects = [primaryProspectId, canonicalProspectId, prospectId]
      .map((id) => prospectById.get(id))
      .filter(Boolean)
    const exactPhones = [bestPhoneId, phoneId]
      .map((id) => phoneById.get(id))
      .filter(Boolean)
    const prospectRows = uniqueRowsBy([
      ...exactProspects,
      ...(prospectsByMasterOwner.get(masterOwnerId) || []),
    ], 'prospect_id')
    const phoneRows = uniqueRowsBy([
      ...exactPhones,
      ...(phonesByMasterOwner.get(masterOwnerId) || []),
    ], 'phone_id')

    return {
      ...candidate,
      catalog_layers: {
        ...(candidate.catalog_layers || {}),
        properties: propertyById.get(propertyId) || null,
        prospects: prospectRows[0] || null,
        prospects_rows: prospectRows,
        master_owners: masterOwnerById.get(masterOwnerId) || null,
        phones: phoneRows[0] || null,
        phones_rows: phoneRows,
      },
    }
  })

  return {
    ok: warnings.length === 0,
    rows: hydratedRows,
    warnings: [...new Set(warnings)],
    counts: {
      properties: propertyById.size,
      prospects: prospectsByMasterOwnerResult.rows.length + prospectsByProspectIdResult.rows.length,
      master_owners: masterOwnerById.size,
      phones: phonesByMasterOwnerResult.rows.length + phonesByPhoneIdResult.rows.length,
    },
  }
}

function rowsForDomain(candidate = {}, domain) {
  const layers = candidate.catalog_layers || {}
  if (domain === 'properties') return [layers.properties].filter(Boolean)
  if (domain === 'prospects') return Array.isArray(layers.prospects_rows) && layers.prospects_rows.length
    ? layers.prospects_rows
    : [layers.prospects].filter(Boolean)
  if (domain === 'master_owners') return [layers.master_owners].filter(Boolean)
  if (domain === 'phones') return Array.isArray(layers.phones_rows) && layers.phones_rows.length
    ? layers.phones_rows
    : [layers.phones].filter(Boolean)
  return []
}

function pickValuesFromRows(rows = [], columns = []) {
  const values = []
  for (const row of rows) {
    for (const column of columns) {
      if (row?.[column] === undefined || row?.[column] === null || clean(row[column]) === '') continue
      values.push(row[column])
      break
    }
  }
  return values
}

function candidateFallbackValues(candidate = {}, columns = []) {
  const raw = candidate.raw && typeof candidate.raw === 'object' ? candidate.raw : {}
  const values = []
  for (const column of columns) {
    if (candidate[column] !== undefined && candidate[column] !== null && clean(candidate[column]) !== '') values.push(candidate[column])
    else if (raw[column] !== undefined && raw[column] !== null && clean(raw[column]) !== '') values.push(raw[column])
  }
  return values
}

export function readCampaignFieldValuesFromCandidate(candidate = {}, fieldOrKey) {
  const field = typeof fieldOrKey === 'string' ? getCampaignFieldDefinition(fieldOrKey) : fieldOrKey
  if (!field) return []

  const mapping = getCampaignCanonicalSourceMapping(field.key)
  const columns = uniqueClean([
    ...(mapping?.sourceColumns || []),
    field.key.split('.').pop(),
    field.source_column,
  ])

  const layerValues = pickValuesFromRows(rowsForDomain(candidate, field.domain), columns)
  const fallbackValues = candidateFallbackValues(candidate, columns)
  const values = layerValues.length ? layerValues : fallbackValues

  if (field.key === 'prospects.mob') {
    return values.map((value) => ageFromMob(value)).filter((value) => value !== null).map(String)
  }
  if (field.key === 'prospects.age_bucket') {
    return values.map((value) => ageBucketFromMob(value)).filter(Boolean)
  }
  return values
}

const CANDIDATE_LINK_COLUMNS_BY_SOURCE = Object.freeze({
  outbound_feeder_candidates: ['property_id', 'master_owner_id', 'primary_prospect_id', 'best_phone_id'],
  v_sms_ready_contacts: ['property_id', 'master_owner_id', 'primary_prospect_id', 'canonical_prospect_id', 'best_phone_id', 'phone_id'],
  v_sms_campaign_queue_candidates: ['property_id', 'master_owner_id', 'primary_prospect_id', 'canonical_prospect_id', 'best_phone_id', 'phone_id'],
})

async function fetchCandidateLinkRows({ supabase, source, maxRows = OPTION_COUNT_MAX_ROWS }) {
  const rows = []
  const columns = CANDIDATE_LINK_COLUMNS_BY_SOURCE[source] || ['property_id', 'master_owner_id']
  const select = columns.join(',')

  for (let offset = 0; offset < maxRows; offset += OPTION_VALUE_PAGE_SIZE) {
    let query = supabase
      .from(source)
      .select(select)
      .range(offset, Math.min(offset + OPTION_VALUE_PAGE_SIZE - 1, maxRows - 1))

    if (ORDERED_CANDIDATE_SOURCES.has(source)) {
      query = query
        .order('never_contacted', { ascending: false, nullsFirst: false })
        .order('touch_count', { ascending: true, nullsFirst: true })
        .order('final_acquisition_score', { ascending: false, nullsFirst: false })
        .order('best_phone_score', { ascending: false, nullsFirst: false })
    }

    const { data, error } = await query
    if (error) {
      return {
        ok: false,
        rows: [],
        source,
        message: error?.message || String(error),
      }
    }
    const page = Array.isArray(data) ? data : []
    rows.push(...page)
    if (page.length < OPTION_VALUE_PAGE_SIZE || rows.length >= maxRows) break
  }

  return {
    ok: true,
    rows,
    source,
    truncated: rows.length >= maxRows,
  }
}

async function fetchLinkedCampaignFieldCountRows({ supabase, field, maxRows = OPTION_COUNT_MAX_ROWS }) {
  const attempts = []

  for (const source of DEFAULT_COUNT_SOURCE_CANDIDATES) {
    const candidateRows = await fetchCandidateLinkRows({ supabase, source, maxRows })
    attempts.push({
      source,
      ok: candidateRows.ok,
      rows: candidateRows.rows?.length || 0,
      message: candidateRows.message || null,
    })
    if (!candidateRows.ok || !candidateRows.rows.length) continue

    const hydrated = await hydrateCampaignCandidateRowsWithCatalogLayers(candidateRows.rows, {
      supabase,
      domains: [field.domain],
    })
    const rows = hydrated.rows.map((candidate) => ({
      property_id: candidateId(candidate, 'property_id'),
      [LINKED_COUNT_VALUE_COLUMN]: readCampaignFieldValuesFromCandidate(candidate, field),
    }))

    return {
      ok: true,
      source,
      column: LINKED_COUNT_VALUE_COLUMN,
      rows,
      attempts,
      warnings: hydrated.warnings || [],
      truncated: candidateRows.truncated,
    }
  }

  return {
    ok: false,
    rows: [],
    attempts,
  }
}

export async function queryCampaignFieldOptions({
  field_key,
  search = '',
  limit = 50,
  deps = {},
} = {}) {
  const startedAt = Date.now()
  const field = getCampaignFieldDefinition(field_key)
  if (!field) {
    return {
      ok: false,
      status: 400,
      error: 'campaign_field_not_allowed',
      message: 'field must be an allowlisted campaign field key',
      queryMs: Date.now() - startedAt,
    }
  }

  const canonicalMapping = getCampaignCanonicalSourceMapping(field.key)
  const canonicalField = canonicalMapping?.canonicalField || field.key
  const sourceCandidates = optionSourceCandidatesForField(field, canonicalMapping)
  const initialSource = sourceCandidates[0]?.source || canonicalMapping?.sourceUsed || field.source_table_or_view
  const initialSourceColumn = sourceCandidates[0]?.columns?.[0] || field.source_column
  const warnings = []
  const option_mode = optionModeForField(field)

  if (!canReturnOptionsForField(field)) {
    return {
      ok: true,
      field,
      options: [],
      sourceUsed: initialSource,
      sourceColumn: initialSourceColumn,
      optionSourceTableOrView: initialSource,
      optionColumn: initialSourceColumn,
      countSourceUsed: null,
      countColumn: null,
      countSourceTableOrView: null,
      countJoinStrategy: 'none',
      countMeaning: option_mode === 'range' ? 'range input; dropdown options are not generated' : 'field does not use dropdown options',
      option_mode,
      canonicalField,
      warnings,
      queryMs: Date.now() - startedAt,
    }
  }

  if (!sourceCandidates.every(isSafeSourceCandidate)) {
    return {
      ok: false,
      status: 500,
      error: 'campaign_field_catalog_invalid',
      message: 'catalog source mapping is not a safe identifier',
      field,
      sourceUsed: initialSource,
      sourceColumn: initialSourceColumn,
      optionSourceTableOrView: initialSource,
      optionColumn: initialSourceColumn,
      countSourceUsed: null,
      countColumn: null,
      countSourceTableOrView: null,
      countJoinStrategy: 'none',
      countMeaning: 'catalog source mapping invalid',
      option_mode,
      canonicalField,
      warnings,
      queryMs: Date.now() - startedAt,
    }
  }

  const supabase = deps.supabase || defaultSupabase
  const requestedLimit = Math.max(1, Math.min(Number(limit) || 50, 250))
  const graphFacetResult = await queryGraphFacetOptions({
    supabase,
    field,
    search,
    limit: requestedLimit,
    startedAt,
    canonicalField,
    option_mode,
  })
  if (process.env.CAMPAIGN_OPTIONS_ALLOW_SOURCE_SCAN !== '1') return graphFacetResult

  const optionValueMaxRows = OPTION_VALUE_MAX_ROWS
  const normalizedSearch = normalizeSearch(search)

  const optionRows = await fetchCachedOptionRows({
    supabase,
    candidates: sourceCandidates,
    field,
    search: normalizedSearch,
    maxRows: optionValueMaxRows,
  })
  const sourceColumnErrors = (optionRows.attempts || []).filter((attempt) => !attempt.ok)

  if (!optionRows.ok) {
    if (field.key === 'properties.market') {
      warnings.push('canonical_market_unavailable')
      for (const attempt of sourceColumnErrors) {
        warnings.push(`source_column_unavailable:${attempt.source}.${attempt.column || attempt.columns?.join(',') || 'unknown'}`)
      }
      return {
        ok: true,
        field,
        options: [],
        sourceUsed: null,
        sourceColumn: null,
        optionSourceTableOrView: null,
        optionColumn: null,
        countSourceUsed: null,
        countColumn: null,
        countSourceTableOrView: null,
        countJoinStrategy: 'none',
        countMeaning: 'canonical market column unavailable; city/county/locality fallback is forbidden',
        option_mode,
        canonicalField,
        warning: 'canonical_market_unavailable',
        warnings: [...new Set(warnings)],
        queryMs: Date.now() - startedAt,
      }
    }

    for (const attempt of sourceColumnErrors) {
      warnings.push(`source_column_unavailable:${attempt.source}.${attempt.column || attempt.columns?.join(',') || 'unknown'}`)
    }
    return {
      ok: true,
      field,
      options: [],
      warning: 'field_options_unavailable',
      message: sourceColumnErrors[0]?.message || 'field options source unavailable',
      sourceUsed: initialSource,
      sourceColumn: initialSourceColumn || null,
      optionSourceTableOrView: initialSource,
      optionColumn: initialSourceColumn || null,
      countSourceUsed: null,
      countColumn: null,
      countSourceTableOrView: null,
      countJoinStrategy: 'none',
      countMeaning: 'field options source unavailable',
      option_mode,
      canonicalField,
      warnings: [...new Set(warnings)],
      queryMs: Date.now() - startedAt,
    }
  }

  if (optionRows.truncated) warnings.push('option_source_sampled')
  for (const attempt of optionRows.attempts || []) {
    if (attempt.ok && attempt.rows === 0) warnings.push(`source_column_empty:${attempt.source}.${attempt.column}`)
  }

  const selectedSource = optionRows.source || initialSource
  const selectedSourceColumn = optionRows.column || initialSourceColumn

  let countSourceUsed = selectedSource
  let countColumn = selectedSourceColumn || null
  let countMeaning = countMeaningForField(field, selectedSource)
  let countJoinStrategy = 'source_table_full_scan'
  let countLookup = null

  if (!['properties', 'prospects', 'master_owners', 'phones'].includes(selectedSource)) {
    const linkedCountRows = await fetchLinkedCampaignFieldCountRows({
      supabase,
      field,
      maxRows: OPTION_COUNT_MAX_ROWS,
    })

    if (linkedCountRows.ok && linkedCountRows.rows.length > 0) {
      countSourceUsed = linkedCountRows.source
      countColumn = linkedCountRows.column
      countMeaning = countMeaningForField(field, countSourceUsed)
      countJoinStrategy = 'linked_property_candidate_hydration'
      countLookup = buildCandidateCountLookup(linkedCountRows.rows, countColumn, field)
      if (linkedCountRows.truncated) warnings.push('count_estimate')
      warnings.push(...(linkedCountRows.warnings || []))
    } else {
    const countCandidates = countSourceCandidatesForField(field, canonicalMapping, selectedSourceColumn)
    const countRows = await fetchFirstUsableColumnRows({
      supabase,
      candidates: countCandidates,
      field,
      maxRows: OPTION_COUNT_MAX_ROWS,
      propertyAnchored: true,
    })

    if (countRows.ok && countRows.rows.length > 0) {
      countSourceUsed = countRows.source
      countColumn = countRows.column
      countMeaning = countMeaningForField(field, countSourceUsed)
      countJoinStrategy = 'candidate_source_column_match'
      countLookup = buildCandidateCountLookup(countRows.rows, countColumn, field)
      if (countRows.truncated) warnings.push('count_estimate')
    } else {
      warnings.push('count_source_partial')
      for (const attempt of (linkedCountRows.attempts || []).filter((entry) => !entry.ok)) {
        warnings.push(`count_source_unavailable:${attempt.source}:${attempt.message || 'unknown'}`)
      }
      for (const attempt of (countRows.attempts || []).filter((entry) => !entry.ok)) {
        warnings.push(`count_column_unavailable:${attempt.source}.${attempt.column || 'unknown'}`)
      }
    }
    }
  }

  const buckets = buildOptionBuckets(optionRows.rows || [], selectedSourceColumn, field, normalizedSearch)
  const options = [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      count: countLookup ? countForOption(countLookup, bucket) : Number(bucket.rawSourceCount || 0),
      count_source: countLookup ? 'candidate' : 'raw_source',
    }))
    .sort((left, right) => Number(right.count || 0) - Number(left.count || 0) || left.label.localeCompare(right.label))
    .slice(0, requestedLimit)

  return {
    ok: true,
    field,
    options,
    sourceUsed: selectedSource,
    sourceColumn: selectedSourceColumn || null,
    optionSourceTableOrView: selectedSource,
    optionColumn: selectedSourceColumn || null,
    countSourceUsed,
    countColumn,
    countSourceTableOrView: countSourceUsed,
    countJoinStrategy,
    countMeaning,
    option_mode,
    canonicalField,
    warnings: [...new Set(warnings)],
    queryMs: Date.now() - startedAt,
  }
}
