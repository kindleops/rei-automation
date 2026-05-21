export type PropertyFieldCategory =
  | 'Identity'
  | 'Location'
  | 'Owner'
  | 'Valuation'
  | 'Equity'
  | 'Loan'
  | 'Taxes'
  | 'Sale'
  | 'Structure'
  | 'Condition'
  | 'Distress'
  | 'Motivation'
  | 'Assessment'
  | 'MLS'
  | 'HOA'
  | 'Media'
  | 'System'

export type PropertyFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multi_select'
  | 'json_tags'

export interface PropertyFieldConfig {
  key: string
  label: string
  category: PropertyFieldCategory
  type: PropertyFieldType
  operators: string[]
  supabaseColumn: string
  optionsProvider?: string
  formatValue?: (value: unknown) => string
}

const TEXT_OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'is_empty', 'is_not_empty']
const NUMBER_OPERATORS = ['equals', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal', 'between', 'is_empty', 'is_not_empty']
const BOOLEAN_OPERATORS = ['is_true', 'is_false', 'is_empty', 'is_not_empty']
const DATE_OPERATORS = ['before', 'after', 'between', 'on', 'is_empty', 'is_not_empty']
const JSON_OPERATORS = ['includes', 'excludes', 'contains_text', 'is_empty', 'is_not_empty']

const makeField = (
  key: string,
  category: PropertyFieldCategory,
  type: PropertyFieldType,
): PropertyFieldConfig => {
  const label = key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

  const operators =
    type === 'number'
      ? NUMBER_OPERATORS
      : type === 'boolean'
        ? BOOLEAN_OPERATORS
        : type === 'date'
          ? DATE_OPERATORS
          : type === 'json_tags'
            ? JSON_OPERATORS
            : TEXT_OPERATORS

  return {
    key,
    label,
    category,
    type,
    operators,
    supabaseColumn: key,
  }
}

export const PROPERTY_FIELD_REGISTRY: PropertyFieldConfig[] = [
  makeField('property_export_id', 'Identity', 'text'),
  makeField('property_id', 'Identity', 'text'),
  makeField('upsert_key', 'Identity', 'text'),
  makeField('master_owner_id', 'Identity', 'text'),
  makeField('master_key', 'Identity', 'text'),
  makeField('owner_id', 'Identity', 'text'),
  makeField('owner_match_key', 'Identity', 'text'),
  makeField('owner_match_key_full', 'Identity', 'text'),
  makeField('owner_name_addr_key', 'Identity', 'text'),
  makeField('property_address_full', 'Location', 'text'),
  makeField('property_address', 'Location', 'text'),
  makeField('property_address2', 'Location', 'text'),
  makeField('property_address_city', 'Location', 'text'),
  makeField('property_address_county_name', 'Location', 'text'),
  makeField('property_address_state', 'Location', 'text'),
  makeField('property_address_zip', 'Location', 'text'),
  makeField('property_address_range', 'Location', 'text'),
  makeField('property_county_name', 'Location', 'text'),
  makeField('property_state', 'Location', 'text'),
  makeField('property_zip', 'Location', 'text'),
  makeField('market', 'Location', 'select'),
  makeField('market_region', 'Location', 'select'),
  makeField('latitude', 'Location', 'number'),
  makeField('longitude', 'Location', 'number'),
  makeField('owner_name', 'Owner', 'text'),
  makeField('owner_type', 'Owner', 'select'),
  makeField('owner_location', 'Owner', 'text'),
  makeField('owner_address_full', 'Owner', 'text'),
  makeField('owner_address', 'Owner', 'text'),
  makeField('owner_address_city', 'Owner', 'text'),
  makeField('owner_address_state', 'Owner', 'text'),
  makeField('owner_address_zip', 'Owner', 'text'),
  makeField('owner_1_name', 'Owner', 'text'),
  makeField('owner_2_name', 'Owner', 'text'),
  makeField('is_corporate_owner', 'Owner', 'boolean'),
  makeField('out_of_state_owner', 'Owner', 'boolean'),
  makeField('removed_owner', 'Owner', 'boolean'),
  makeField('ownership_years', 'Owner', 'number'),
  makeField('estimated_value', 'Valuation', 'number'),
  makeField('cash_offer', 'Valuation', 'number'),
  makeField('equity_amount', 'Equity', 'number'),
  makeField('equity_percent', 'Equity', 'number'),
  makeField('total_loan_balance', 'Loan', 'number'),
  makeField('total_loan_payment', 'Loan', 'number'),
  makeField('total_loan_amt', 'Loan', 'number'),
  makeField('offer_vs_loan', 'Loan', 'text'),
  makeField('offer_vs_sale_price', 'Loan', 'number'),
  makeField('tax_amt', 'Taxes', 'number'),
  makeField('tax_year', 'Taxes', 'number'),
  makeField('tax_delinquent', 'Taxes', 'boolean'),
  makeField('tax_delinquent_year', 'Taxes', 'number'),
  makeField('past_due_amount', 'Taxes', 'number'),
  makeField('active_lien', 'Taxes', 'boolean'),
  makeField('lienholder_name', 'Taxes', 'text'),
  makeField('sale_date', 'Sale', 'date'),
  makeField('sale_price', 'Sale', 'number'),
  makeField('saleprice', 'Sale', 'number'),
  makeField('document_type', 'Sale', 'text'),
  makeField('recording_date', 'Sale', 'date'),
  makeField('default_date', 'Sale', 'date'),
  makeField('last_sale_doc_type', 'Sale', 'text'),
  makeField('property_type', 'Structure', 'select'),
  makeField('property_class', 'Structure', 'text'),
  makeField('building_square_feet', 'Structure', 'number'),
  makeField('year_built', 'Structure', 'number'),
  makeField('effective_year_built', 'Structure', 'number'),
  makeField('total_bedrooms', 'Structure', 'number'),
  makeField('total_baths', 'Structure', 'number'),
  makeField('units_count', 'Structure', 'number'),
  makeField('lot_acreage', 'Structure', 'number'),
  makeField('lot_square_feet', 'Structure', 'number'),
  makeField('stories', 'Structure', 'number'),
  makeField('avg_sqft_per_unit', 'Structure', 'number'),
  makeField('beds_per_unit', 'Structure', 'number'),
  makeField('building_condition', 'Condition', 'text'),
  makeField('building_quality', 'Condition', 'text'),
  makeField('construction_type', 'Condition', 'text'),
  makeField('air_conditioning', 'Condition', 'text'),
  makeField('basement', 'Condition', 'text'),
  makeField('garage', 'Condition', 'text'),
  makeField('heating_fuel_type', 'Condition', 'text'),
  makeField('heating_type', 'Condition', 'text'),
  makeField('interior_walls', 'Condition', 'text'),
  makeField('exterior_walls', 'Condition', 'text'),
  makeField('floor_cover', 'Condition', 'text'),
  makeField('roof_cover', 'Condition', 'text'),
  makeField('roof_type', 'Condition', 'text'),
  makeField('rehab_level', 'Condition', 'select'),
  makeField('estimated_repair_cost', 'Condition', 'number'),
  makeField('estimated_repair_cost_per_sqft', 'Condition', 'number'),
  makeField('seller_tags_text', 'Distress', 'text'),
  makeField('seller_tags_json', 'Distress', 'json_tags'),
  makeField('property_flags_text', 'Distress', 'text'),
  makeField('property_flags_json', 'Distress', 'json_tags'),
  makeField('podio_tags', 'Distress', 'json_tags'),
  makeField('tag_distress_score', 'Distress', 'number'),
  makeField('structured_motivation_score', 'Motivation', 'number'),
  makeField('deal_strength_score', 'Motivation', 'number'),
  makeField('final_acquisition_score', 'Motivation', 'number'),
  makeField('ai_score', 'Motivation', 'number'),
  makeField('contact_status', 'Motivation', 'text'),
  makeField('highlighted', 'Motivation', 'boolean'),
  makeField('assd_improvement_value', 'Assessment', 'number'),
  makeField('assd_land_value', 'Assessment', 'number'),
  makeField('assd_total_value', 'Assessment', 'number'),
  makeField('assd_year', 'Assessment', 'number'),
  makeField('calculated_improvement_value', 'Assessment', 'number'),
  makeField('calculated_land_value', 'Assessment', 'number'),
  makeField('calculated_total_value', 'Assessment', 'number'),
  makeField('mls_current_listing_price', 'MLS', 'number'),
  makeField('mls_market_status', 'MLS', 'select'),
  makeField('mls_sold_date', 'MLS', 'date'),
  makeField('mls_sold_price', 'MLS', 'number'),
  makeField('market_status_label', 'MLS', 'text'),
  makeField('market_status_value', 'MLS', 'text'),
  makeField('market_sub_status', 'MLS', 'text'),
  makeField('hoa1_name', 'HOA', 'text'),
  makeField('hoa1_type', 'HOA', 'text'),
  makeField('hoa_fee_amount', 'HOA', 'number'),
  makeField('map_image', 'Media', 'text'),
  makeField('satellite_image', 'Media', 'text'),
  makeField('streetview_image', 'Media', 'text'),
  makeField('source_system', 'System', 'text'),
  makeField('export_version', 'System', 'text'),
  makeField('exported_at_utc', 'System', 'date'),
  makeField('row_hash', 'System', 'text'),
  makeField('created_at', 'System', 'date'),
  makeField('updated_at', 'System', 'date'),
  makeField('raw_payload_json', 'System', 'json_tags'),
]

export const PROPERTY_FIELD_REGISTRY_MAP = new Map(
  PROPERTY_FIELD_REGISTRY.map((field) => [field.key, field]),
)

export const searchPropertyFieldRegistry = (query: string): PropertyFieldConfig[] => {
  const needle = query.trim().toLowerCase()
  if (!needle) return PROPERTY_FIELD_REGISTRY
  return PROPERTY_FIELD_REGISTRY.filter((field) =>
    field.label.toLowerCase().includes(needle) ||
    field.key.toLowerCase().includes(needle) ||
    field.category.toLowerCase().includes(needle),
  )
}
