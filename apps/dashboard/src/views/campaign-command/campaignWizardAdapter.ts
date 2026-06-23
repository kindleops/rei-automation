import { callBackend } from '../../lib/api/backendClient'

export type CampaignDomainKey =
  | 'properties'
  | 'prospects'
  | 'master_owners'
  | 'phones'
  | 'outreach'
  | 'sender_coverage'

export type CampaignFieldType =
  | 'boolean'
  | 'date'
  | 'enum'
  | 'json'
  | 'number'
  | 'text'

export interface CampaignOperator {
  key: string
  label: string
}

export interface CampaignDomainDefinition {
  key: CampaignDomainKey
  tabLabel: string
  sourceOfTruth: string
  categories: string[]
}

export interface CampaignFieldDefinition {
  key: string
  domain: CampaignDomainKey
  category: string
  label: string
  source_table_or_view: string
  source_column: string
  type: CampaignFieldType
  operators: CampaignOperator[]
  filterable: boolean
  searchable: boolean
  supports_options: boolean
  supports_counts: boolean
  supported_in_preview: boolean
  description: string
  derived_from?: string
}

export interface CampaignFieldCatalog {
  domains: CampaignDomainDefinition[]
  fields: CampaignFieldDefinition[]
  fieldsByDomain: Record<CampaignDomainKey, CampaignFieldDefinition[]>
  degraded?: boolean
  degradedReason?: string
  source?: 'backend' | 'local_fallback'
  totalFields?: number
}

export interface CampaignFieldOption {
  value: string
  label: string
  count?: number
  degraded?: boolean
  degradedReason?: string
}

export interface CampaignFilterCondition {
  id: string
  domain: CampaignDomainKey
  category: string
  fieldKey: string
  operator: string
  value: unknown
}

export type CampaignFilterGroups = Record<CampaignDomainKey, CampaignFilterCondition[]>

export interface CampaignWizardDraft {
  name: string
  description: string
  template_use_case: string
  stage_code: string
  target_filters: CampaignFilterGroups
}

export interface CampaignDistributionBucket {
  label: string
  count: number
}

export interface CampaignDistribution {
  key: string
  label: string
  buckets: CampaignDistributionBucket[]
}

export interface CampaignBlockedStep {
  key: string
  label: string
  count: number
  source?: string
  reason_codes?: string[]
}

export interface CampaignEligibilityWaterfallStep {
  key: string
  label: string
  count: number
  kind?: 'pass' | 'block' | 'sample' | 'policy' | string
  source?: string
  description?: string
  reason_codes?: string[]
}

export interface CampaignUnsupportedWarning {
  fieldKey: string
  label: string
  reason: 'unsupported_in_preview'
}

export interface CampaignSampleTarget {
  id: string
  property: Record<string, string | number | boolean | null>
  prospect: Record<string, string | number | boolean | null>
  master_owner: Record<string, string | number | boolean | null>
  phone: Record<string, string | number | boolean | null>
  outreach: Record<string, string | number | boolean | null>
  sender_coverage: Record<string, string | number | boolean | null>
}

export interface CampaignFunnelStep {
  key: string
  label?: string
  count: number | null
  approximate?: boolean
}

export interface CampaignPreviewResult {
  ok: true
  dry_run: true
  request_id?: string | null
  result_hash?: string | null
  preview_unavailable?: boolean
  total_matched_properties: number
  total_matched: number
  total_scanned: number
  clean_targets: number
  ready_to_queue: number
  queueable_today: number
  addressable_properties?: number | null
  addressable_properties_approximate?: boolean
  funnel?: CampaignFunnelStep[]
  headline_metric?: string
  headline_count?: number
  linked_prospects?: number | null
  linked_master_owners?: number | null
  linked_phones?: number | null
  matched_properties?: number | null
  sms_eligible_phones?: number | null
  sms_eligible_phones_count?: number | null
  sender_covered?: number | null
  property_best_phone_count?: number | null
  property_sms_eligible_count?: number | null
  queue_eligibility_scope?: string
  queue_eligibility_note?: string
  current_contact_window_blocks_preview?: boolean
  blocked_waterfall: CampaignBlockedStep[]
  blocked_reason_waterfall?: CampaignBlockedStep[]
  eligibility_waterfall?: CampaignEligibilityWaterfallStep[]
  blocked_counts_by_reason: Record<string, number>
  candidate_window?: {
    scanned?: number
    matched?: number
    clean_targets?: number
    ready_to_queue?: number
    queueable_today?: number
    blocked_counts_by_reason?: Record<string, number>
  }
  full_source_reach?: {
    matched_properties?: number
    linked_master_owners?: number | null
    linked_prospects?: number | null
    linked_phones?: number | null
    sms_eligible_phones?: number | null
    clean_targets?: number | null
    sender_covered?: number | null
    ready_to_queue?: number | null
    queueable_today?: number | null
    count_source?: string | null
    graph_source?: string | null
    join_strategy?: string | null
  }
  distributions: CampaignDistribution[]
  sample_targets: CampaignSampleTarget[]
  unsupported_in_preview: CampaignUnsupportedWarning[]
  warnings: string[]
  applied_filters?: Array<Record<string, unknown>>
  unsupportedFilters?: Array<Record<string, unknown>>
  unsupported_filters?: Array<Record<string, unknown>>
  skippedFilters?: Array<Record<string, unknown>>
  skipped_filters?: Array<Record<string, unknown>>
  appliedSqlFilters?: Array<Record<string, unknown>>
  applied_sql_filters?: Array<Record<string, unknown>>
  sourceColumnsUsed?: Record<string, string[]>
  source_columns_used?: Record<string, string[]>
  graph_columns_used?: Record<string, string[]>
  payloadFiltersByDomain?: Record<string, Array<Record<string, unknown>>>
  payload_filters_by_domain?: Record<string, Array<Record<string, unknown>>>
  diagnostics?: Record<string, unknown>
  frontend_payload_domain_counts?: Record<CampaignDomainKey, number>
  backend_received_domain_counts?: Record<CampaignDomainKey, number>
  backend_applied_domain_counts?: Record<CampaignDomainKey, number>
  layer_counts?: {
    properties_matched?: number | null
    prospects_matched?: number | null
    master_owners_matched?: number | null
    phones_matched?: number | null
    outreach_eligible?: number | null
    sender_coverage_eligible?: number | null
  }
  dropped_filter_count?: number
  dropped_filters?: Array<Record<string, unknown>>
  graph_join_key_report?: Record<string, unknown>
  graph_source_coverage?: Record<string, unknown>
  query_ms?: number
  degraded?: boolean
  degradedReason?: string
  source?: 'backend' | 'local_fallback'
  graph_refresh_scope?: string | null
  graph_row_count?: number | null
  graph_freshness?: {
    refresh_started_at?: string | null
    refresh_finished_at?: string | null
  } | null
  _raw?: unknown
  _request?: {
    endpoint: string
    payload: Record<string, unknown>
    active_filters: Array<Record<string, unknown>>
    request_id?: string | null
    result_hash?: string | null
    response_top_level_keys: string[]
  }
}

const TEXT_OPERATORS: CampaignOperator[] = [
  { key: 'is_any_of', label: 'Is any of' },
  { key: 'is_not_any_of', label: 'Is not any of' },
  { key: 'contains', label: 'Contains' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const ENUM_OPERATORS: CampaignOperator[] = [
  { key: 'is_any_of', label: 'Is any of' },
  { key: 'is_not_any_of', label: 'Is not any of' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const NUMBER_OPERATORS: CampaignOperator[] = [
  { key: 'gte', label: 'Greater than or equal' },
  { key: 'lte', label: 'Less than or equal' },
  { key: 'between', label: 'Between' },
  { key: 'eq', label: 'Equal to' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const DATE_OPERATORS: CampaignOperator[] = [
  { key: 'on_or_after', label: 'On or after' },
  { key: 'on_or_before', label: 'On or before' },
  { key: 'between', label: 'Between' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

const BOOLEAN_OPERATORS: CampaignOperator[] = [
  { key: 'is_true', label: 'Is true' },
  { key: 'is_false', label: 'Is false' },
]

const JSON_OPERATORS: CampaignOperator[] = [
  { key: 'contains', label: 'Contains' },
  { key: 'is_empty', label: 'Is empty' },
  { key: 'is_not_empty', label: 'Is not empty' },
]

export const CAMPAIGN_DOMAIN_DEFINITIONS: CampaignDomainDefinition[] = [
  {
    key: 'properties',
    tabLabel: 'Property Targeting',
    sourceOfTruth: 'Asset source of truth and campaign anchor',
    categories: [
      'Location & Market',
      'Asset Type & Structure',
      'Value / Equity / Debt',
      'Distress & Motivation',
      'Condition / Repair',
      'Land / Lot / Zoning',
      'Tax / Assessment',
      'Owner Relationship',
    ],
  },
  {
    key: 'prospects',
    tabLabel: 'Prospect Targeting',
    sourceOfTruth: 'Individual and contact motivation layer',
    categories: ['Demographics', 'Matching & Eligibility'],
  },
  {
    key: 'master_owners',
    tabLabel: 'Master Owner Targeting',
    sourceOfTruth: 'Portfolio and owner intelligence layer',
    categories: ['Profile', 'Scores', 'Portfolio Financials', 'Portfolio Distress'],
  },
  {
    key: 'phones',
    tabLabel: 'Phone Quality',
    sourceOfTruth: 'Contact quality layer',
    categories: ['Quality'],
  },
  {
    key: 'outreach',
    tabLabel: 'Outreach Rules',
    sourceOfTruth: 'Timing, compliance, and history layer',
    categories: ['Rules'],
  },
  {
    key: 'sender_coverage',
    tabLabel: 'Sender Coverage',
    sourceOfTruth: 'Routing and deliverability layer',
    categories: ['Routing'],
  },
]

const SOURCE_BY_DOMAIN: Record<CampaignDomainKey, string> = {
  properties: 'properties',
  prospects: 'prospects',
  master_owners: 'master_owners',
  phones: 'phones',
  outreach: 'campaign_outreach_context',
  sender_coverage: 'campaign_sender_coverage_context',
}

const DOMAIN_KEYS: CampaignDomainKey[] = [
  'properties',
  'prospects',
  'master_owners',
  'phones',
  'outreach',
  'sender_coverage',
]

const CAMPAIGN_TARGETING_SOURCE = 'outbound_feeder_candidates'
const PREVIEW_TARGETS_ENDPOINT = '/api/cockpit/campaigns/preview-targets'
const DEFAULT_LIMIT_PREVIEW = 1
const DEFAULT_SCAN_PREVIEW = 1
const BACKEND_DEGRADED_WARNING = 'Backend degraded / using local preview fallback'

type CampaignFallbackReason = {
  degraded: true
  degradedReason: string
  source: 'local_fallback'
}

const EMPTY_FILTER_GROUPS: CampaignFilterGroups = {
  properties: [],
  prospects: [],
  master_owners: [],
  phones: [],
  outreach: [],
  sender_coverage: [],
}

const emptyDomainCounts = (): Record<CampaignDomainKey, number> => ({
  properties: 0,
  prospects: 0,
  master_owners: 0,
  phones: 0,
  outreach: 0,
  sender_coverage: 0,
})

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
  'age',
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
  'timezone',
  'contact_window',
  'age_bucket',
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

const PREVIEW_SUPPORTED_FIELD_KEYS = new Set<string>([
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
  // seller_tags_json has no campaign_target_graph column; seller_tags_text covers
  // tag filtering. Keeping it unsupported prevents a silently-skipped active filter.
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

const SPECIAL_LABELS: Record<string, string> = {
  age: 'Age',
  age_bucket: 'Age Bucket',
  mob: 'Age',
  sms_eligible: 'SMS Eligible',
  email_eligible: 'Email Eligible',
  phone_owner: 'Carrier / Phone Owner',
  sqft_range: 'Sqft Range',
  avg_sqft_per_unit: 'Avg Sqft Per Unit',
  selected_textgrid_market: 'Selected TextGrid Market',
  selected_textgrid_state: 'Selected TextGrid State',
}

const FIELD_GROUPS: Array<{
  domain: CampaignDomainKey
  category: string
  columns: string[]
}> = [
  {
    domain: 'properties',
    category: 'Location & Market',
    // Canonical address geography only. Legacy property_state / property_zip /
    // property_county_name are sparse mirrors and are excluded from the builder;
    // their keys still resolve via FIELD_KEY_ALIASES for saved-campaign compatibility.
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
    category: 'Value / Equity / Debt',
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
    category: 'Condition / Repair',
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
    category: 'Land / Lot / Zoning',
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
    category: 'Tax / Assessment',
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

function humanizeColumn(column: string): string {
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

function resolveFieldType(domain: CampaignDomainKey, column: string): CampaignFieldType {
  if (`${domain}.${column}` === 'prospects.matching_flags') return 'text'
  if (BOOLEAN_COLUMNS.has(column)) return 'boolean'
  if (DATE_COLUMNS.has(column)) return 'date'
  if (NUMERIC_COLUMNS.has(column)) return 'number'
  if (JSON_COLUMNS.has(column)) return 'json'
  if (ENUM_COLUMNS.has(column)) return 'text'
  return 'text'
}

function operatorsForType(type: CampaignFieldType): CampaignOperator[] {
  if (type === 'boolean') return BOOLEAN_OPERATORS
  if (type === 'date') return DATE_OPERATORS
  if (type === 'number') return NUMBER_OPERATORS
  if (type === 'json') return JSON_OPERATORS
  if (type === 'enum') return ENUM_OPERATORS
  return TEXT_OPERATORS
}

function descriptionForField(domain: CampaignDomainKey, category: string, label: string): string {
  const domainDef = CAMPAIGN_DOMAIN_DEFINITIONS.find((entry) => entry.key === domain)
  return `${label} filter from ${domainDef?.sourceOfTruth.toLowerCase() ?? category.toLowerCase()}.`
}

// Legacy geography field keys resolve to their canonical property_address_*
// equivalents. The bare property_* columns are sparse mirrors and are no longer
// offered in the builder, but saved campaigns created before the canonical cleanup
// may still reference them, so they normalize here for backward compatibility.
export const CAMPAIGN_FIELD_KEY_ALIASES: Record<string, string> = {
  'properties.property_state': 'properties.property_address_state',
  'properties.property_zip': 'properties.property_address_zip',
  'properties.property_county_name': 'properties.property_address_county_name',
  'properties.property_county': 'properties.property_address_county_name',
  'properties.property_city': 'properties.property_address_city',
}

export function normalizeCampaignFieldKey(key: string): string {
  return CAMPAIGN_FIELD_KEY_ALIASES[key] ?? key
}

function buildFieldCatalog(): CampaignFieldDefinition[] {
  return FIELD_GROUPS.flatMap(({ domain, category, columns }) =>
    columns.map((column) => {
      const type = resolveFieldType(domain, column)
      const derivedFrom = column === 'age_bucket' ? 'mob' : undefined
      const sourceColumn = derivedFrom ?? column
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
    }),
  )
}

const FIELD_CATALOG = buildFieldCatalog()

const FIELDS_BY_DOMAIN = CAMPAIGN_DOMAIN_DEFINITIONS.reduce(
  (acc, domain) => {
    acc[domain.key] = FIELD_CATALOG.filter((field) => field.domain === domain.key)
    return acc
  },
  {
    properties: [],
    prospects: [],
    master_owners: [],
    phones: [],
    outreach: [],
    sender_coverage: [],
  } as Record<CampaignDomainKey, CampaignFieldDefinition[]>,
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function asBooleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeDomainKey(value: unknown): CampaignDomainKey | null {
  const key = asText(value) as CampaignDomainKey
  return DOMAIN_KEYS.includes(key) ? key : null
}

function normalizeFieldType(value: unknown): CampaignFieldType {
  const type = asText(value) as CampaignFieldType
  if (['boolean', 'date', 'enum', 'json', 'number', 'text'].includes(type)) return type
  return 'text'
}

function normalizeOperators(value: unknown, type: CampaignFieldType): CampaignOperator[] {
  const operators = recordArray(value)
    .map((operator) => ({
      key: asText(operator.key),
      label: asText(operator.label, humanizeColumn(asText(operator.key))),
    }))
    .filter((operator) => operator.key.length > 0)

  return operators.length ? operators : operatorsForType(type)
}

function isEnabledFlag(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

function explicitDevMockModeEnabled(): boolean {
  if (!import.meta.env.DEV) return false
  return [
    import.meta.env.VITE_CAMPAIGN_WIZARD_MOCK_MODE,
    import.meta.env.VITE_CAMPAIGN_TARGETING_MOCK,
    import.meta.env.VITE_CAMPAIGN_WIZARD_USE_MOCK,
  ].some(isEnabledFlag)
}

function fallbackMeta(reason: string): CampaignFallbackReason {
  const detail = reason.trim()
  return {
    degraded: true,
    degradedReason: detail ? `${BACKEND_DEGRADED_WARNING}: ${detail}` : BACKEND_DEGRADED_WARNING,
    source: 'local_fallback',
  }
}

function shouldFallbackFromBackendError(result: { status: number; error?: string }): boolean {
  return result.status !== 200 || result.error === 'BACKEND_NETWORK_ERROR'
}

function buildFieldsByDomain(fields: CampaignFieldDefinition[]): Record<CampaignDomainKey, CampaignFieldDefinition[]> {
  const groups: Record<CampaignDomainKey, CampaignFieldDefinition[]> = {
    properties: [],
    prospects: [],
    master_owners: [],
    phones: [],
    outreach: [],
    sender_coverage: [],
  }
  for (const field of fields) {
    groups[field.domain].push(field)
  }
  return groups
}

// Campaign Builder only surfaces fields that are fully supported end-to-end in
// preview/build/launch (i.e. they resolve to a campaign_target_graph column). Any
// field flagged supported_in_preview === false (e.g. master_owner portfolio
// financials/distress/scores, or unmapped JSON mirrors) is hidden entirely rather
// than shown disabled, so an operator can never apply a filter that the backend
// would silently skip. Categories left with no supported fields are pruned too.
function restrictCatalogToSupported(catalog: CampaignFieldCatalog): CampaignFieldCatalog {
  const supportedFields = catalog.fields.filter((field) => field.supported_in_preview)
  const categoriesByDomain = new Map<CampaignDomainKey, Set<string>>()
  for (const field of supportedFields) {
    if (!categoriesByDomain.has(field.domain)) categoriesByDomain.set(field.domain, new Set())
    categoriesByDomain.get(field.domain)!.add(field.category)
  }
  const domains = catalog.domains
    .map((domain) => ({
      ...domain,
      categories: domain.categories.filter((category) => categoriesByDomain.get(domain.key)?.has(category)),
    }))
    .filter((domain) => domain.categories.length > 0)
  return {
    ...catalog,
    domains,
    fields: supportedFields,
    fieldsByDomain: buildFieldsByDomain(supportedFields),
    totalFields: supportedFields.length,
  }
}

function getLocalFieldCatalog(meta?: CampaignFallbackReason): CampaignFieldCatalog {
  return {
    domains: CAMPAIGN_DOMAIN_DEFINITIONS,
    fields: FIELD_CATALOG,
    fieldsByDomain: FIELDS_BY_DOMAIN,
    source: meta?.source ?? 'backend',
    ...(meta ? { degraded: true, degradedReason: meta.degradedReason } : {}),
    totalFields: FIELD_CATALOG.length,
  }
}

function normalizeBackendField(
  raw: Record<string, unknown>,
  fallbackDomain: CampaignDomainKey,
  fallbackCategory: string,
): CampaignFieldDefinition | null {
  const domain = normalizeDomainKey(raw.domain) ?? fallbackDomain
  const rawKey = asText(raw.key)
  const rawColumn = asText(raw.source_column, rawKey.split('.').pop() ?? '')
  const fieldColumn = asText(rawKey.split('.').pop(), rawColumn)
  const key = rawKey || `${domain}.${fieldColumn}`
  if (!key) return null

  const type = normalizeFieldType(raw.type)
  const supportsOptionsDefault = type === 'enum' || type === 'text'
  const label = asText(raw.label, humanizeColumn(fieldColumn))
  const derivedFrom = asText(raw.derived_from)

  return {
    key,
    domain,
    category: asText(raw.category, fallbackCategory),
    label,
    source_table_or_view: asText(raw.source_table_or_view, SOURCE_BY_DOMAIN[domain]),
    source_column: rawColumn || fieldColumn,
    type,
    operators: normalizeOperators(raw.operators, type),
    filterable: asBooleanValue(raw.filterable, true),
    searchable: asBooleanValue(raw.searchable, type === 'enum' || type === 'text' || type === 'json'),
    supports_options: asBooleanValue(raw.supports_options, supportsOptionsDefault),
    supports_counts: asBooleanValue(raw.supports_counts, supportsOptionsDefault),
    supported_in_preview: asBooleanValue(raw.supported_in_preview, false),
    description: asText(raw.description, descriptionForField(domain, fallbackCategory, label)),
    ...(derivedFrom ? { derived_from: derivedFrom } : {}),
  }
}

function normalizeFieldCatalogResponse(payload: unknown): CampaignFieldCatalog {
  if (!isRecord(payload) || payload.ok === false) {
    throw new Error('Campaign field catalog response was not usable.')
  }

  const backendDomains = recordArray(payload.domains)
  const domains: CampaignDomainDefinition[] = []
  const fields: CampaignFieldDefinition[] = []

  for (const domainRecord of backendDomains) {
    const key = normalizeDomainKey(domainRecord.domain ?? domainRecord.id)
    if (!key) continue

    const categoryRecords = recordArray(domainRecord.categories)
    const categories = categoryRecords
      .map((category) => asText(category.label, asText(category.id)))
      .filter(Boolean)

    const fallbackDomain = CAMPAIGN_DOMAIN_DEFINITIONS.find((domain) => domain.key === key)
    domains.push({
      key,
      tabLabel: asText(domainRecord.label, fallbackDomain?.tabLabel ?? formatDomainLabel(key)),
      sourceOfTruth: asText(domainRecord.description, fallbackDomain?.sourceOfTruth ?? ''),
      categories: categories.length ? categories : fallbackDomain?.categories ?? [],
    })

    for (const categoryRecord of categoryRecords) {
      const categoryLabel = asText(categoryRecord.label, asText(categoryRecord.id))
      for (const fieldRecord of recordArray(categoryRecord.fields)) {
        const normalized = normalizeBackendField(fieldRecord, key, categoryLabel)
        if (normalized) fields.push(normalized)
      }
    }
  }

  if (!domains.length || !fields.length) {
    throw new Error('Campaign field catalog response did not include domains and fields.')
  }

  return {
    domains,
    fields,
    fieldsByDomain: buildFieldsByDomain(fields),
    source: 'backend',
    totalFields: asOptionalNumber(payload.total_fields) ?? fields.length,
  }
}

function formatDomainLabel(value: CampaignDomainKey): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeOptionsResponse(payload: unknown): CampaignFieldOption[] {
  const rawOptions = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? Array.isArray(payload.options) ? payload.options : []
      : []

  return rawOptions
    .map((item) => {
      if (isRecord(item)) {
        const label = asText(item.label, asText(item.value))
        const value = asText(item.value, label)
        if (!value || !label) return null
        const count = asOptionalNumber(item.count)
        return {
          value,
          label,
          ...(count === undefined ? {} : { count }),
        }
      }

      const value = asText(item)
      return value ? { value, label: value } : null
    })
    .filter((option): option is CampaignFieldOption => Boolean(option))
}

function withOptionFallbackMeta(options: CampaignFieldOption[], meta: CampaignFallbackReason): CampaignFieldOption[] {
  return options.map((option) => ({
    ...option,
    degraded: true,
    degradedReason: meta.degradedReason,
  }))
}

export function createEmptyFilterGroups(): CampaignFilterGroups {
  return {
    properties: [...EMPTY_FILTER_GROUPS.properties],
    prospects: [...EMPTY_FILTER_GROUPS.prospects],
    master_owners: [...EMPTY_FILTER_GROUPS.master_owners],
    phones: [...EMPTY_FILTER_GROUPS.phones],
    outreach: [...EMPTY_FILTER_GROUPS.outreach],
    sender_coverage: [...EMPTY_FILTER_GROUPS.sender_coverage],
  }
}

export async function getFieldCatalog(): Promise<CampaignFieldCatalog> {
  if (explicitDevMockModeEnabled()) {
    return restrictCatalogToSupported(getLocalFieldCatalog(fallbackMeta('explicit dev mock flag enabled')))
  }

  const result = await callBackend('/api/cockpit/campaigns/field-catalog')
  if (!result.ok) {
    if (shouldFallbackFromBackendError(result)) {
      return restrictCatalogToSupported(getLocalFieldCatalog(fallbackMeta(result.message)))
    }
    throw new Error(result.message)
  }

  return restrictCatalogToSupported(normalizeFieldCatalogResponse(result.data))
}

export async function searchFieldOptions(fieldKey: string, search = ''): Promise<CampaignFieldOption[]> {
  if (explicitDevMockModeEnabled()) {
    const meta = fallbackMeta('explicit dev mock flag enabled')
    return withOptionFallbackMeta([], meta)
  }

  const params = new URLSearchParams({ field: fieldKey, limit: '250' })
  const trimmedSearch = search.trim()
  if (trimmedSearch) params.set('search', trimmedSearch)

  const result = await callBackend(`/api/cockpit/campaigns/options?${params.toString()}`)
  if (!result.ok) {
    if (shouldFallbackFromBackendError(result)) {
      const meta = fallbackMeta(result.message)
      return withOptionFallbackMeta([], meta)
    }
    throw new Error(result.message)
  }

  if (isRecord(result.data) && result.data.ok === false) {
    throw new Error(asText(result.data.message, 'Campaign option response was not usable.'))
  }

  return normalizeOptionsResponse(result.data)
}

export function defaultOperatorForField(field: CampaignFieldDefinition): string {
  return field.operators[0]?.key ?? 'eq'
}

export function defaultValueForField(field: CampaignFieldDefinition, operator = defaultOperatorForField(field)): unknown {
  if (operator === 'is_empty' || operator === 'is_not_empty') return ''
  if (field.type === 'boolean') return operator === 'is_true'
  if (operator === 'between') return ['', '']
  if (operator === 'contains') return ''
  if (field.type === 'enum' || field.type === 'text') return []
  return ''
}

export function serializeFilterGroups(filters: CampaignFilterGroups): Record<CampaignDomainKey, Array<Record<string, unknown>>> {
  return mapFilterGroups(filters, (filter) => {
    return {
      field_key: filter.fieldKey,
      operator: filter.operator,
      value: filter.value,
      domain: filter.domain,
      category: filter.category,
    }
  }, true)
}

function countFiltersByDomain(groups: CampaignFilterGroups | Record<CampaignDomainKey, Array<unknown>>): Record<CampaignDomainKey, number> {
  const counts = emptyDomainCounts()
  for (const domain of DOMAIN_KEYS) {
    counts[domain] = Array.isArray(groups[domain]) ? groups[domain].length : 0
  }
  return counts
}

function findDroppedPreviewFilters(
  draftGroups: CampaignFilterGroups,
  payloadFilters: Record<CampaignDomainKey, Array<Record<string, unknown>>>,
): Array<Record<string, unknown>> {
  const serializedKeys = new Set(
    Object.values(payloadFilters)
      .flat()
      .map((filter) => `${String(filter.domain ?? '')}:${String(filter.field_key ?? '')}:${String(filter.operator ?? '')}:${JSON.stringify(filter.value ?? null)}`),
  )

  return DOMAIN_KEYS.flatMap((domain) => (
    (draftGroups[domain] ?? [])
      .filter((filter) => !serializedKeys.has(`${filter.domain}:${filter.fieldKey}:${filter.operator}:${JSON.stringify(filter.value ?? null)}`))
      .map((filter) => ({
        domain: filter.domain,
        field_key: filter.fieldKey,
        operator: filter.operator,
        value: filter.value,
        reason: hasMeaningfulValue(filter.value, filter.operator) ? 'serialization_mismatch' : 'empty_filter_value',
      }))
  ))
}

function assertPreviewPayloadDomainCounts(
  draftGroups: CampaignFilterGroups,
  payloadFilters: Record<CampaignDomainKey, Array<Record<string, unknown>>>,
) {
  const expected = countFiltersByDomain(draftGroups)
  const actual = countFiltersByDomain(payloadFilters)
  const mismatched = DOMAIN_KEYS.filter((domain) => expected[domain] !== actual[domain])
  if (!mismatched.length) return { expected, actual, dropped: [] as Array<Record<string, unknown>> }

  const dropped = findDroppedPreviewFilters(draftGroups, payloadFilters)
  const detail = mismatched
    .map((domain) => `${domain}: ui=${expected[domain]} payload=${actual[domain]}`)
    .join(', ')
  const error = new Error(`Campaign preview payload dropped active filters (${detail}).`)
  Object.assign(error, {
    expectedDomainCounts: expected,
    payloadDomainCounts: actual,
    droppedFilters: dropped,
  })
  console.error('[previewTargets] active filter serialization mismatch', {
    expectedDomainCounts: expected,
    payloadDomainCounts: actual,
    droppedFilters: dropped,
  })
  throw error
}

function buildPreviewPayload(draft: CampaignWizardDraft, requestId?: string | null): Record<string, unknown> {
  const filters = serializeFilterGroups(draft.target_filters)
  const { expected: frontendPayloadDomainCounts, dropped } = assertPreviewPayloadDomainCounts(draft.target_filters, filters)
  const market = firstSerializedFilterValue(filters.properties, 'properties.market')
  const state = firstSerializedFilterValue(filters.properties, 'properties.property_state')
    ?? firstSerializedFilterValue(filters.properties, 'properties.property_address_state')

  return {
    source: CAMPAIGN_TARGETING_SOURCE,
    filters,
    frontend_payload_domain_counts: frontendPayloadDomainCounts,
    frontend_dropped_filter_count: dropped.length,
    frontend_dropped_filters: dropped,
    limitPreview: DEFAULT_LIMIT_PREVIEW,
    scan_limit: DEFAULT_SCAN_PREVIEW,
    ...(requestId ? { request_id: requestId } : {}),
    ...(market ? { market } : {}),
    ...(state ? { state } : {}),
    template_use_case: draft.template_use_case,
    stage_code: draft.stage_code,
  }
}

function firstSerializedFilterValue(filters: Array<Record<string, unknown>>, fieldKey: string): string | null {
  const filter = filters.find((item) => item.field_key === fieldKey)
  if (!filter) return null
  const value = filter.value
  if (Array.isArray(value)) {
    const first = value.find((item) => String(item ?? '').trim().length > 0)
    return first === undefined ? null : String(first)
  }
  const text = String(value ?? '').trim()
  return text || null
}

export async function previewTargets(draft: CampaignWizardDraft, options: { requestId?: string | null } = {}): Promise<CampaignPreviewResult> {
  if (explicitDevMockModeEnabled()) {
    return previewTargetsLocal(draft, fallbackMeta('explicit dev mock flag enabled'), options.requestId)
  }

  const payload = buildPreviewPayload(draft, options.requestId)
  const result = await callBackend<Record<string, unknown>>(PREVIEW_TARGETS_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  if (import.meta.env.DEV) {
    console.group('[previewTargets] raw API exchange')
    console.log('endpoint:', PREVIEW_TARGETS_ENDPOINT)
    console.log('payload sent:', payload)
    console.log('active filters sent:', Object.values(payload.filters as Record<string, Array<Record<string, unknown>>>).flat())
    console.log('result.ok:', result.ok)
    console.log('result.status:', result.status)
    console.log('result.data:', result.ok ? result.data : null)
    if (!result.ok) console.warn('error:', result.message)
    console.groupEnd()
  }

  if (!result.ok) {
    throw new Error(result.message ?? 'preview-targets request failed')
  }

  if (isRecord(result.data) && result.data.ok === false) {
    throw new Error(asText(result.data.message, 'Campaign preview response was not usable.'))
  }

  if (isRecord(result.data) && Number(result.data.dropped_filter_count || 0) > 0) {
    const dropped = recordArray(result.data.dropped_filters)
    console.warn('[previewTargets] backend skipped active filters', {
      dropped_filter_count: result.data.dropped_filter_count,
      dropped_filters: dropped,
      payload,
    })
  }

  const normalized = normalizePreviewResponse(result.data)

  if (import.meta.env.DEV) {
    normalized._request = {
      endpoint: PREVIEW_TARGETS_ENDPOINT,
      payload,
      active_filters: Object.values(payload.filters as Record<string, Array<Record<string, unknown>>>).flat(),
      request_id: normalized.request_id ?? options.requestId ?? null,
      result_hash: normalized.result_hash ?? null,
      response_top_level_keys: isRecord(result.data) ? Object.keys(result.data).sort() : [],
    }
    console.log('[previewTargets] normalized result:', normalized)
  }

  return normalized
}

async function previewTargetsLocal(draft: CampaignWizardDraft, meta?: CampaignFallbackReason, requestId?: string | null): Promise<CampaignPreviewResult> {
  const filters = Object.values(draft.target_filters).flat()
  const fieldByKey = new Map(FIELD_CATALOG.map((field) => [field.key, field]))
  const validFilters = filters.filter((filter) => hasMeaningfulValue(filter.value, filter.operator))
  const unsupported = validFilters
    .map((filter) => fieldByKey.get(normalizeCampaignFieldKey(filter.fieldKey)))
    .filter((field): field is CampaignFieldDefinition => Boolean(field && !field.supported_in_preview))
    .map((field) => ({
      fieldKey: field.key,
      label: field.label,
      reason: 'unsupported_in_preview' as const,
    }))

  // No fabricated funnel. Reach numbers must come from the backend graph query
  // (the same source Build Targets materializes from), so Builder Reach and
  // Campaign Ready can never disagree with real data. When the live preview is
  // unavailable we surface an explicit "unavailable" state with zeroed counts
  // rather than inventing reach from heuristic multipliers.
  const warnings = unsupported.map((item) => `${item.label} is approved but unsupported in preview.`)
  warnings.unshift(meta?.degradedReason ?? 'Live preview unavailable — reach is computed by the backend graph, not estimated locally.')

  return {
    ok: true,
    dry_run: true,
    request_id: requestId ?? null,
    result_hash: null,
    preview_unavailable: true,
    total_matched_properties: 0,
    total_matched: 0,
    total_scanned: 0,
    clean_targets: 0,
    ready_to_queue: 0,
    queueable_today: 0,
    blocked_waterfall: [],
    blocked_counts_by_reason: {},
    distributions: buildDistributions(0),
    sample_targets: [],
    unsupported_in_preview: unsupported,
    warnings,
    applied_filters: Object.values(serializeFilterGroups(draft.target_filters)).flat(),
    query_ms: 0,
    ...(meta ? { degraded: true, degradedReason: meta.degradedReason, source: meta.source } : { source: 'backend' as const }),
  }
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const parsed = asOptionalNumber(value)
    if (parsed !== undefined) return parsed
  }
  return 0
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (isRecord(value)) return value
  }
  return {}
}

function unwrapPreviewEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const directPreviewKeys = [
    'total_matched_properties',
    'total_matched',
    'total_matching_properties',
    'full_reach_count',
    'clean_targets',
    'ready_to_queue',
    'queueable_today',
    'blocked_waterfall',
    'reach',
  ]
  if (directPreviewKeys.some((key) => key in payload)) return payload

  const nestedKeys = ['preview', 'preview_reach', 'target_reach', 'result', 'data']
  for (const key of nestedKeys) {
    const nested = payload[key]
    if (isRecord(nested) && directPreviewKeys.some((previewKey) => previewKey in nested)) {
      return nested
    }
  }

  return payload
}

function normalizeNumberMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  return Object.entries(value).reduce<Record<string, number>>((acc, [key, count]) => {
    const parsed = asOptionalNumber(count)
    if (parsed !== undefined) acc[key] = parsed
    return acc
  }, {})
}

function normalizeStringArrayMap(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {}
  return Object.entries(value).reduce<Record<string, string[]>>((acc, [key, entry]) => {
    if (Array.isArray(entry)) {
      acc[key] = entry.map((item) => asText(item)).filter(Boolean)
    } else {
      const text = asText(entry)
      if (text) acc[key] = [text]
    }
    return acc
  }, {})
}

function normalizeRecordArrayMap(value: unknown): Record<string, Array<Record<string, unknown>>> {
  if (!isRecord(value)) return {}
  return Object.entries(value).reduce<Record<string, Array<Record<string, unknown>>>>((acc, [key, entry]) => {
    acc[key] = recordArray(entry)
    return acc
  }, {})
}

function previewColumnsFromFilterRecord(filter: Record<string, unknown>): string[] {
  const mapping = firstRecord(filter.preview_mapping, filter.previewMapping)
  return Array.from(new Set([
    asText(filter.graph_column),
    asText(filter.preview_column),
    ...((Array.isArray(filter.preview_columns) ? filter.preview_columns : []) as unknown[]).map((item) => asText(item)),
    asText(mapping.graph_column),
    asText(mapping.preview_column),
    ...((Array.isArray(mapping.preview_columns) ? mapping.preview_columns : []) as unknown[]).map((item) => asText(item)),
  ].filter(Boolean)))
}

function deriveSourceColumnsUsedFromFilters(filters: Array<Record<string, unknown>>): Record<string, string[]> {
  return filters.reduce<Record<string, string[]>>((acc, filter) => {
    const fieldKey = asText(filter.field_key, asText(filter.fieldKey, asText(filter.field)))
    const columns = previewColumnsFromFilterRecord(filter)
    if (fieldKey && columns.length > 0) acc[fieldKey] = columns
    return acc
  }, {})
}

function groupFilterRecordsByDomain(filters: Array<Record<string, unknown>>): Record<string, Array<Record<string, unknown>>> {
  return filters.reduce<Record<string, Array<Record<string, unknown>>>>((acc, filter) => {
    const fieldKey = asText(filter.field_key, asText(filter.fieldKey, asText(filter.field)))
    const explicitDomain = asText(filter.domain)
    const domain = explicitDomain || (fieldKey.includes('.') ? fieldKey.split('.')[0] : '')
    if (!domain) return acc
    acc[domain] = [...(acc[domain] ?? []), filter]
    return acc
  }, {})
}

function normalizeBlockedWaterfall(
  value: unknown,
  blockedCounts: Record<string, number>,
  blockedSummary: Record<string, unknown>,
): CampaignBlockedStep[] {
  const explicit = recordArray(value)
    .map((item) => {
      const key = asText(item.key, asText(item.reason))
      const count = firstNumber(item.count)
      return {
        key,
        label: asText(item.label, humanizeColumn(key)),
        count,
        source: asText(item.source),
        reason_codes: Array.isArray(item.reason_codes)
          ? item.reason_codes.map((reason) => asText(reason)).filter(Boolean)
          : undefined,
      }
    })
    .filter((item) => item.key && item.count > 0)

  if (explicit.length) return explicit

  const summarySteps: CampaignBlockedStep[] = [
    { key: 'suppressed', label: 'Suppressed', count: firstNumber(blockedSummary.suppressed) },
    { key: 'dnc', label: 'DNC / opt-out', count: firstNumber(blockedSummary.dnc) },
    { key: 'wrongNumber', label: 'Wrong number', count: firstNumber(blockedSummary.wrongNumber) },
    { key: 'noPhone', label: 'No clean phone', count: firstNumber(blockedSummary.noPhone) },
    { key: 'noSenderCoverage', label: 'No sender coverage', count: firstNumber(blockedSummary.noSenderCoverage) },
    { key: 'cooldown', label: 'Cooldown / contact window', count: firstNumber(blockedSummary.cooldown) },
    { key: 'identityHold', label: 'Identity hold', count: firstNumber(blockedSummary.identityHold) },
    { key: 'noTemplate', label: 'No template', count: firstNumber(blockedSummary.noTemplate) },
    { key: 'pendingPriorTouch', label: 'Pending prior touch', count: firstNumber(blockedSummary.pendingPriorTouch) },
    { key: 'duplicateQueue', label: 'Duplicate queue', count: firstNumber(blockedSummary.duplicateQueue) },
  ].filter((item) => item.count > 0)

  if (summarySteps.length) return summarySteps

  return Object.entries(blockedCounts)
    .map(([key, count]) => ({
      key,
      label: humanizeColumn(key),
      count: Number(count || 0),
    }))
    .filter((item) => item.count > 0)
}

function normalizeBlockedReasonWaterfall(value: unknown): CampaignBlockedStep[] {
  const rows: CampaignBlockedStep[] = []
  for (const item of recordArray(value)) {
    const key = asText(item.key, asText(item.reason))
    if (!key) continue
    rows.push({
      key,
      label: asText(item.label, humanizeColumn(key)),
      count: firstNumber(item.count),
      source: asText(item.source) || undefined,
      reason_codes: Array.isArray(item.reason_codes)
        ? item.reason_codes.map((reason) => asText(reason)).filter(Boolean)
        : undefined,
    })
  }
  return rows
}

function normalizeEligibilityWaterfall(value: unknown): CampaignEligibilityWaterfallStep[] {
  const rows: CampaignEligibilityWaterfallStep[] = []
  for (const item of recordArray(value)) {
    const key = asText(item.key)
    if (!key) continue
    rows.push({
      key,
      label: asText(item.label, humanizeColumn(key)),
      count: firstNumber(item.count),
      kind: asText(item.kind) || undefined,
      source: asText(item.source) || undefined,
      description: asText(item.description) || undefined,
      reason_codes: Array.isArray(item.reason_codes)
        ? item.reason_codes.map((reason) => asText(reason)).filter(Boolean)
        : undefined,
    })
  }
  return rows
}

const DISTRIBUTION_LABELS: Record<string, string> = {
  markets: 'Markets',
  languages: 'Languages',
  propertyTypes: 'Property Types',
  matchingFlags: 'Matching Flags',
  routingTiers: 'Routing Tiers',
  property_state: 'Property State',
  age_bucket: 'Age Bucket',
  sender_coverage_status: 'Sender Coverage',
}

function normalizeDistributionBuckets(value: unknown): CampaignDistributionBucket[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (isRecord(item)) {
          const label = asText(item.label, asText(item.value))
          return label ? { label, count: firstNumber(item.count) } : null
        }
        const label = asText(item)
        return label ? { label, count: 0 } : null
      })
      .filter((bucket): bucket is CampaignDistributionBucket => Boolean(bucket))
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .map(([label, count]) => ({ label, count: firstNumber(count) }))
      .filter((bucket) => bucket.label.length > 0)
  }

  return []
}

function normalizeDistributionEntries(value: unknown): CampaignDistribution[] {
  return recordArray(value)
    .map((item) => {
      const key = asText(item.key, asText(item.id))
      const buckets = normalizeDistributionBuckets(item.buckets)
      return {
        key,
        label: asText(item.label, DISTRIBUTION_LABELS[key] ?? humanizeColumn(key)),
        buckets,
      }
    })
    .filter((distribution) => distribution.key && distribution.buckets.length > 0)
}

function normalizeDistributions(payload: Record<string, unknown>): CampaignDistribution[] {
  const distributionGroups = normalizeDistributionEntries(payload.distribution_groups)
  if (distributionGroups.length) return distributionGroups

  if (Array.isArray(payload.distributions)) {
    return normalizeDistributionEntries(payload.distributions)
  }

  if (!isRecord(payload.distributions)) return []

  return Object.entries(payload.distributions)
    .map(([key, buckets]) => ({
      key,
      label: DISTRIBUTION_LABELS[key] ?? humanizeColumn(key),
      buckets: normalizeDistributionBuckets(buckets),
    }))
    .filter((distribution) => distribution.buckets.length > 0)
}

function toSampleValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (isRecord(item)) return asText(item.label, asText(item.value, asText(item.name, asText(item.key))))
        return String(item ?? '').trim()
      })
      .filter(Boolean)
      .join(', ')
  }
  if (isRecord(value)) {
    const simple = asText(value.label, asText(value.value, asText(value.name, asText(value.key))))
    return simple || JSON.stringify(value).slice(0, 160)
  }
  return String(value)
}

function sanitizeSampleSection(value: unknown): Record<string, string | number | boolean | null> {
  if (!isRecord(value)) return {}
  return Object.entries(value).reduce<Record<string, string | number | boolean | null>>((acc, [key, entry]) => {
    if (key.toLowerCase() === 'mob') return acc
    acc[key] = toSampleValue(entry)
    return acc
  }, {})
}

function normalizeSampleTargets(value: unknown): CampaignSampleTarget[] {
  return recordArray(value)
    .map((sample, index) => ({
      id: asText(sample.id, asText(sample.campaign_key, `sample-${index + 1}`)),
      property: sanitizeSampleSection(sample.property),
      prospect: sanitizeSampleSection(sample.prospect),
      master_owner: sanitizeSampleSection(sample.master_owner),
      phone: sanitizeSampleSection(sample.phone),
      outreach: sanitizeSampleSection(sample.outreach),
      sender_coverage: sanitizeSampleSection(sample.sender_coverage),
    }))
}

function normalizeUnsupportedWarnings(value: unknown): CampaignUnsupportedWarning[] {
  return recordArray(value)
    .map((warning) => {
      const fieldKey = asText(warning.fieldKey, asText(warning.field_key))
      const label = asText(warning.label, fieldKey)
      return fieldKey ? {
        fieldKey,
        label,
        reason: 'unsupported_in_preview' as const,
      } : null
    })
    .filter((warning): warning is CampaignUnsupportedWarning => Boolean(warning))
}

function normalizeWarningStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((warning) => asText(warning))
    .filter(Boolean)
}

function normalizeFunnelSteps(value: unknown): CampaignFunnelStep[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((step) => ({
      key: asText(step.key) || asText(step.label) || 'step',
      label: asText(step.label) || undefined,
      count: asOptionalNumber(step.count) ?? null,
      approximate: asBooleanValue(step.approximate, false) || undefined,
    }))
    .filter((step) => Boolean(step.key))
}

function normalizePreviewResponse(payload: unknown): CampaignPreviewResult {
  if (!isRecord(payload)) {
    throw new Error('Campaign preview response was not usable.')
  }

  const responsePayload = unwrapPreviewEnvelope(payload)
  const reach = firstRecord(
    responsePayload.reach,
    responsePayload.target_reach,
    responsePayload.preview_reach,
    responsePayload.targetReach,
  )
  const candidateWindow = firstRecord(responsePayload.candidate_window, reach.candidate_window, responsePayload.candidateWindow)
  const fullSourceReach = firstRecord(responsePayload.full_source_reach, reach.full_source_reach, responsePayload.fullSourceReach)
  const diagnostics = firstRecord(responsePayload.diagnostics, payload.diagnostics)
  const blockedSummary = firstRecord(responsePayload.blocked, reach.blocked, payload.blocked)
  const blockedCounts = normalizeNumberMap(
    responsePayload.blocked_counts_by_reason
      ?? candidateWindow.blocked_counts_by_reason
      ?? reach.blocked_counts_by_reason
      ?? payload.blocked_counts_by_reason
  )
  const unsupported = normalizeUnsupportedWarnings(responsePayload.unsupported_in_preview ?? reach.unsupported_in_preview ?? payload.unsupported_in_preview)
  const unsupportedFilters = recordArray(
    responsePayload.unsupportedFilters
      ?? responsePayload.unsupported_filters
      ?? responsePayload.unsupported_in_preview
      ?? diagnostics.unsupportedFilters
      ?? diagnostics.unsupported_filters
      ?? payload.unsupportedFilters
      ?? payload.unsupported_filters
  )
  const skippedFilters = recordArray(responsePayload.skippedFilters ?? responsePayload.skipped_filters ?? diagnostics.skippedFilters ?? diagnostics.skipped_filters ?? payload.skippedFilters ?? payload.skipped_filters)
  const appliedSqlFilters = recordArray(responsePayload.appliedSqlFilters ?? responsePayload.applied_sql_filters ?? diagnostics.appliedSqlFilters ?? diagnostics.applied_sql_filters ?? payload.appliedSqlFilters ?? payload.applied_sql_filters)
  const normalizedFilters = recordArray(responsePayload.normalizedFilters ?? responsePayload.normalized_filters ?? diagnostics.normalizedFilters ?? diagnostics.normalized_filters ?? payload.normalizedFilters)
  const supportedFilters = recordArray(responsePayload.supportedFilters ?? responsePayload.supported_filters ?? diagnostics.supportedFilters ?? diagnostics.supported_filters ?? payload.supportedFilters)
  const diagnosticFilterRows = supportedFilters.length > 0 ? supportedFilters : normalizedFilters
  const explicitSourceColumnsUsed = normalizeStringArrayMap(responsePayload.sourceColumnsUsed ?? responsePayload.source_columns_used ?? responsePayload.graph_columns_used ?? diagnostics.sourceColumnsUsed ?? diagnostics.source_columns_used ?? diagnostics.graph_columns_used ?? payload.sourceColumnsUsed ?? payload.source_columns_used ?? payload.graph_columns_used)
  const sourceColumnsUsed = Object.keys(explicitSourceColumnsUsed).length > 0
    ? explicitSourceColumnsUsed
    : deriveSourceColumnsUsedFromFilters(diagnosticFilterRows)
  const explicitPayloadFiltersByDomain = normalizeRecordArrayMap(responsePayload.payloadFiltersByDomain ?? responsePayload.payload_filters_by_domain ?? diagnostics.payloadFiltersByDomain ?? diagnostics.payload_filters_by_domain ?? payload.payloadFiltersByDomain ?? payload.payload_filters_by_domain)
  const payloadFiltersByDomain = Object.keys(explicitPayloadFiltersByDomain).length > 0
    ? explicitPayloadFiltersByDomain
    : groupFilterRecordsByDomain(normalizedFilters.length > 0 ? normalizedFilters : diagnosticFilterRows)
  const warningSet = new Set([
    ...normalizeWarningStrings(responsePayload.warnings ?? payload.warnings),
    ...unsupported.map((item) => `${item.label} is approved but unsupported in preview.`),
    ...unsupportedFilters.map((item) => asText(item.message)).filter(Boolean),
  ])

  const totalMatchedProperties = firstNumber(
    responsePayload.total_matched_properties,
    reach.total_matched_properties,
    reach.totalMatchedProperties,
    responsePayload.total_matched,
    reach.total_matched,
    reach.totalMatched,
    responsePayload.total_matching_properties,
    reach.total_matching_properties,
    responsePayload.full_reach_count,
    reach.full_reach_count,
    responsePayload.properties_matched,
    reach.properties_matched,
    responsePayload.owners_matched,
  )

  const linkedProspects = asOptionalNumber(
    responsePayload.linked_prospects
      ?? reach.linked_prospects
      ?? reach.linkedProspects
      ?? responsePayload.linked_prospects_count
      ?? reach.linked_prospects_count
  )
  const linkedMasterOwners = asOptionalNumber(
    responsePayload.linked_master_owners
      ?? reach.linked_master_owners
      ?? reach.linkedMasterOwners
      ?? responsePayload.linked_master_owners_count
      ?? reach.linked_master_owners_count
  )
  const linkedPhones = asOptionalNumber(
    responsePayload.linked_phones
      ?? reach.linked_phones
      ?? reach.linkedPhones
      ?? responsePayload.linked_phones_count
      ?? reach.linked_phones_count
  )
  const smsEligiblePhones = asOptionalNumber(
    responsePayload.sms_eligible_phones
      ?? fullSourceReach.sms_eligible_phones
      ?? reach.sms_eligible_phones
      ?? responsePayload.sms_eligible_phones_count
      ?? reach.sms_eligible_phones_count
  )
  const senderCovered = asOptionalNumber(
    responsePayload.sender_covered
      ?? fullSourceReach.sender_covered
      ?? reach.sender_covered
      ?? responsePayload.sender_covered_count
      ?? reach.sender_covered_count
  )
  const propertyBestPhoneCount = asOptionalNumber(
    responsePayload.property_best_phone_count
      ?? fullSourceReach.property_best_phone_count
      ?? reach.property_best_phone_count
  )
  const propertySmsEligibleCount = asOptionalNumber(
    responsePayload.property_sms_eligible_count
      ?? fullSourceReach.property_sms_eligible_count
      ?? reach.property_sms_eligible_count
  )
  const candidateWindowCounts = {
    scanned: asOptionalNumber(candidateWindow.scanned),
    matched: asOptionalNumber(candidateWindow.matched),
    clean_targets: asOptionalNumber(candidateWindow.clean_targets),
    ready_to_queue: asOptionalNumber(candidateWindow.ready_to_queue),
    queueable_today: asOptionalNumber(candidateWindow.queueable_today),
    blocked_counts_by_reason: normalizeNumberMap(candidateWindow.blocked_counts_by_reason),
  }
  const rawLayerCounts = firstRecord(responsePayload.layer_counts, responsePayload.layerCounts, reach.layer_counts, payload.layer_counts)
  const layerCounts = {
    properties_matched: asOptionalNumber(rawLayerCounts.properties_matched ?? rawLayerCounts.propertiesMatched) ?? null,
    prospects_matched: asOptionalNumber(rawLayerCounts.prospects_matched ?? rawLayerCounts.prospectsMatched) ?? null,
    master_owners_matched: asOptionalNumber(rawLayerCounts.master_owners_matched ?? rawLayerCounts.masterOwnersMatched) ?? null,
    phones_matched: asOptionalNumber(rawLayerCounts.phones_matched ?? rawLayerCounts.phonesMatched) ?? null,
    outreach_eligible: asOptionalNumber(rawLayerCounts.outreach_eligible ?? rawLayerCounts.outreachEligible) ?? null,
    sender_coverage_eligible: asOptionalNumber(rawLayerCounts.sender_coverage_eligible ?? rawLayerCounts.senderCoverageEligible) ?? null,
  }

  return {
    ok: true,
    dry_run: true,
    request_id: asText(responsePayload.request_id ?? responsePayload.requestId ?? payload.request_id ?? payload.requestId) || null,
    result_hash: asText(responsePayload.result_hash ?? responsePayload.resultHash ?? payload.result_hash ?? payload.resultHash) || null,
    total_matched_properties: totalMatchedProperties,
    total_matched: totalMatchedProperties,
    total_scanned: firstNumber(responsePayload.total_scanned),
    clean_targets: firstNumber(responsePayload.clean_targets, reach.clean_targets, reach.cleanTargets),
    ready_to_queue: firstNumber(responsePayload.ready_to_queue, reach.ready_to_queue, reach.readyToQueue, responsePayload.clean_ready_targets),
    queueable_today: firstNumber(responsePayload.queueable_today, reach.queueable_today, reach.queueableToday),
    addressable_properties: asOptionalNumber(responsePayload.addressable_properties ?? reach.addressableProperties ?? reach.addressable_properties) ?? null,
    addressable_properties_approximate: asBooleanValue(responsePayload.addressable_properties_approximate ?? reach.addressableApproximate, false),
    funnel: normalizeFunnelSteps(responsePayload.funnel ?? reach.funnel),
    headline_metric: asText(responsePayload.headline_metric) || 'ready_to_queue',
    headline_count: firstNumber(responsePayload.headline_count, responsePayload.ready_to_queue, reach.readyToQueue),
    linked_prospects: linkedProspects ?? null,
    linked_master_owners: linkedMasterOwners ?? null,
    linked_phones: linkedPhones ?? null,
    matched_properties: asOptionalNumber(fullSourceReach.matched_properties ?? responsePayload.matched_properties) ?? totalMatchedProperties,
    sms_eligible_phones: smsEligiblePhones ?? null,
    sender_covered: senderCovered ?? null,
    property_best_phone_count: propertyBestPhoneCount ?? null,
    property_sms_eligible_count: propertySmsEligibleCount ?? null,
    queue_eligibility_scope: asText(responsePayload.queue_eligibility_scope ?? reach.queue_eligibility_scope),
    queue_eligibility_note: asText(responsePayload.queue_eligibility_note ?? reach.queue_eligibility_note),
    current_contact_window_blocks_preview: asBooleanValue(responsePayload.current_contact_window_blocks_preview, false),
    blocked_waterfall: normalizeBlockedWaterfall(responsePayload.blocked_waterfall ?? reach.blocked_waterfall, blockedCounts, blockedSummary),
    blocked_reason_waterfall: normalizeBlockedReasonWaterfall(
      responsePayload.blocked_reason_waterfall
        ?? candidateWindow.explicit_blocked_waterfall
        ?? reach.blocked_reason_waterfall
    ),
    eligibility_waterfall: normalizeEligibilityWaterfall(responsePayload.eligibility_waterfall ?? reach.eligibility_waterfall),
    blocked_counts_by_reason: blockedCounts,
    candidate_window: candidateWindowCounts,
    full_source_reach: {
      matched_properties: firstNumber(fullSourceReach.matched_properties, totalMatchedProperties),
      linked_master_owners: asOptionalNumber(fullSourceReach.linked_master_owners) ?? null,
      linked_prospects: asOptionalNumber(fullSourceReach.linked_prospects) ?? null,
      linked_phones: asOptionalNumber(fullSourceReach.linked_phones) ?? null,
      sms_eligible_phones: asOptionalNumber(fullSourceReach.sms_eligible_phones) ?? null,
      clean_targets: asOptionalNumber(fullSourceReach.clean_targets) ?? null,
      sender_covered: asOptionalNumber(fullSourceReach.sender_covered) ?? null,
      ready_to_queue: asOptionalNumber(fullSourceReach.ready_to_queue) ?? null,
      queueable_today: asOptionalNumber(fullSourceReach.queueable_today) ?? null,
      count_source: asText(fullSourceReach.count_source) || null,
      graph_source: asText(fullSourceReach.graph_source) || null,
      join_strategy: asText(fullSourceReach.join_strategy) || null,
    },
    distributions: normalizeDistributions(responsePayload),
    sample_targets: normalizeSampleTargets(responsePayload.sample_targets ?? responsePayload.sampleTargets),
    unsupported_in_preview: unsupported,
    warnings: [...warningSet],
    applied_filters: recordArray(responsePayload.appliedFilters ?? responsePayload.applied_filters ?? payload.appliedFilters ?? payload.applied_filters),
    unsupportedFilters,
    unsupported_filters: unsupportedFilters,
    skippedFilters,
    skipped_filters: skippedFilters,
    appliedSqlFilters,
    applied_sql_filters: appliedSqlFilters,
    sourceColumnsUsed,
    source_columns_used: sourceColumnsUsed,
    graph_columns_used: sourceColumnsUsed,
    payloadFiltersByDomain,
    payload_filters_by_domain: payloadFiltersByDomain,
    diagnostics,
    frontend_payload_domain_counts: {
      ...emptyDomainCounts(),
      ...normalizeNumberMap(responsePayload.frontend_payload_domain_counts ?? payload.frontend_payload_domain_counts),
    },
    backend_received_domain_counts: {
      ...emptyDomainCounts(),
      ...normalizeNumberMap(responsePayload.backend_received_domain_counts ?? payload.backend_received_domain_counts),
    },
    backend_applied_domain_counts: {
      ...emptyDomainCounts(),
      ...normalizeNumberMap(responsePayload.backend_applied_domain_counts ?? payload.backend_applied_domain_counts),
    },
    layer_counts: layerCounts,
    dropped_filter_count: firstNumber(responsePayload.dropped_filter_count, payload.dropped_filter_count),
    dropped_filters: recordArray(responsePayload.dropped_filters ?? payload.dropped_filters),
    graph_join_key_report: firstRecord(responsePayload.graph_join_key_report, fullSourceReach.graph_join_key_report, payload.graph_join_key_report),
    graph_source_coverage: firstRecord(responsePayload.graph_source_coverage, fullSourceReach.graph_source_coverage, payload.graph_source_coverage),
    query_ms: asOptionalNumber(responsePayload.queryMs ?? responsePayload.query_ms ?? reach.queryMs ?? reach.query_ms ?? payload.queryMs ?? payload.query_ms),
    source: 'backend',
    ...(import.meta.env.DEV ? { _raw: payload } : {}),
  }
}

function hasMeaningfulValue(value: unknown, operator: string): boolean {
  if (operator === 'is_empty' || operator === 'is_not_empty' || operator === 'is_true' || operator === 'is_false') {
    return true
  }
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.some((entry) => String(entry ?? '').trim().length > 0)
  if (isRecord(value)) return Object.keys(value).length > 0
  return String(value ?? '').trim().length > 0
}

function mapFilterGroups<T>(
  filters: CampaignFilterGroups,
  mapper: (filter: CampaignFilterCondition) => T,
  onlyMeaningful = false,
): Record<CampaignDomainKey, T[]> {
  const mapDomain = (domainFilters: CampaignFilterCondition[]) => {
    const selected = onlyMeaningful
      ? domainFilters.filter((filter) => hasMeaningfulValue(filter.value, filter.operator))
      : domainFilters
    return selected.map(mapper)
  }

  return {
    properties: mapDomain(filters.properties),
    prospects: mapDomain(filters.prospects),
    master_owners: mapDomain(filters.master_owners),
    phones: mapDomain(filters.phones),
    outreach: mapDomain(filters.outreach),
    sender_coverage: mapDomain(filters.sender_coverage),
  }
}

function buildDistributions(total: number): CampaignDistribution[] {
  return [
    {
      key: 'property_state',
      label: 'Property State',
      buckets: [
        { label: 'TX', count: Math.round(total * 0.42) },
        { label: 'FL', count: Math.round(total * 0.2) },
        { label: 'GA', count: Math.round(total * 0.16) },
        { label: 'AZ', count: Math.round(total * 0.12) },
      ],
    },
    {
      key: 'age_bucket',
      label: 'Age Bucket',
      buckets: [
        { label: '45-54', count: Math.round(total * 0.24) },
        { label: '55-64', count: Math.round(total * 0.28) },
        { label: '65-74', count: Math.round(total * 0.22) },
        { label: '75+', count: Math.round(total * 0.11) },
      ],
    },
    {
      key: 'sender_coverage_status',
      label: 'Sender Coverage',
      buckets: [
        { label: 'Covered', count: Math.round(total * 0.78) },
        { label: 'Limited', count: Math.round(total * 0.14) },
        { label: 'No Route', count: Math.round(total * 0.08) },
      ],
    },
    {
      key: 'phone_owner',
      label: 'Carrier',
      buckets: [
        { label: 'T-Mobile', count: Math.round(total * 0.36) },
        { label: 'Verizon', count: Math.round(total * 0.28) },
        { label: 'AT&T', count: Math.round(total * 0.22) },
        { label: 'Other', count: Math.round(total * 0.14) },
      ],
    },
    {
      key: 'priority_tier',
      label: 'Priority Tier',
      buckets: [
        { label: 'A', count: Math.round(total * 0.18) },
        { label: 'B', count: Math.round(total * 0.34) },
        { label: 'C', count: Math.round(total * 0.31) },
        { label: 'D', count: Math.round(total * 0.17) },
      ],
    },
    {
      key: 'language_preference',
      label: 'Language',
      buckets: [
        { label: 'English', count: Math.round(total * 0.82) },
        { label: 'Spanish', count: Math.round(total * 0.15) },
        { label: 'Unknown', count: Math.round(total * 0.03) },
      ],
    },
  ]
}
