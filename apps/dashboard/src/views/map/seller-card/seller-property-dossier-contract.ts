import type { SellerAssetClassKey } from './seller-asset-presentation-registry'
import {
  asNumber,
  firstDefined,
  formatDate,
  formatDecimal,
  formatInteger,
  formatMoney,
  nullIfZeroish,
  text,
  titleize,
} from './seller-map-card-formatters'

export type DossierField = {
  key: string
  label: string
  value: string
  rawValue: unknown
  sourceColumn: string
  available: boolean
}

export type DossierFieldGroup = {
  key: string
  label: string
  fields: DossierField[]
}

export type PropertyDossierContract = {
  propertyDetails: DossierFieldGroup[]
  valuationAssessment: DossierField[]
  loanTransaction: DossierField[]
  distressLegal: DossierField[] | null
  assetSpecific: DossierField[]
}

type FieldSpec = {
  key: string
  label: string
  columns: string[]
  format?: (raw: unknown, record: Record<string, unknown>) => string
  assetClasses?: SellerAssetClassKey[]
  excludeWhenUsed?: boolean
}

const RESIDENTIAL: SellerAssetClassKey[] = ['single_family', 'multifamily_2_4', 'multifamily_5_plus']
const COMMERCIAL: SellerAssetClassKey[] = ['retail', 'office', 'industrial', 'other_commercial']
const STORAGE: SellerAssetClassKey[] = ['storage']
const LAND: SellerAssetClassKey[] = ['land']

const readRaw = (record: Record<string, unknown>, columns: string[]): unknown => {
  for (const column of columns) {
    const value = record[column]
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && !value.trim()) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    return value
  }
  return null
}

const fmtText = (raw: unknown) => {
  const value = text(raw)
  return value ? titleize(value) : '—'
}

const fmtMoneyField = (raw: unknown) => formatMoney(nullIfZeroish(asNumber(raw)))
const fmtIntField = (raw: unknown) => formatInteger(nullIfZeroish(asNumber(raw)))
const fmtDecField = (raw: unknown, digits = 1) => formatDecimal(nullIfZeroish(asNumber(raw)), digits)
const fmtBool = (raw: unknown) => {
  if (raw === true) return 'Yes'
  if (raw === false) return 'No'
  return '—'
}
const fmtAcres = (raw: unknown) => {
  const n = nullIfZeroish(asNumber(raw))
  return n != null ? `${formatDecimal(n, 2)} ac` : '—'
}

const buildField = (
  record: Record<string, unknown>,
  spec: FieldSpec,
  usedKeys: Set<string>,
  assetClassKey: SellerAssetClassKey,
): DossierField | null => {
  if (spec.assetClasses && !spec.assetClasses.includes(assetClassKey)) return null
  if (spec.excludeWhenUsed && usedKeys.has(spec.key)) return null

  const raw = readRaw(record, spec.columns)
  const sourceColumn = spec.columns.find((c) => record[c] != null && text(record[c])) ?? spec.columns[0]
  const value = spec.format ? spec.format(raw, record) : fmtText(raw)
  if (value === '—') return null

  usedKeys.add(spec.key)
  return {
    key: spec.key,
    label: spec.label,
    value,
    rawValue: raw,
    sourceColumn,
    available: true,
  }
}

const buildGroup = (
  record: Record<string, unknown>,
  key: string,
  label: string,
  specs: FieldSpec[],
  usedKeys: Set<string>,
  assetClassKey: SellerAssetClassKey,
): DossierFieldGroup | null => {
  const fields = specs
    .map((spec) => buildField(record, spec, usedKeys, assetClassKey))
    .filter((field): field is DossierField => field != null)
  if (fields.length === 0) return null
  return { key, label, fields }
}

const STRUCTURE_SPECS: FieldSpec[] = [
  { key: 'beds', label: 'Bedrooms', columns: ['total_bedrooms', 'beds'], assetClasses: RESIDENTIAL },
  { key: 'baths', label: 'Bathrooms', columns: ['total_baths', 'baths'], assetClasses: RESIDENTIAL, format: (r) => fmtDecField(r, 1) },
  { key: 'building_sqft', label: 'Building Sqft', columns: ['building_square_feet', 'sqft'], excludeWhenUsed: true },
  { key: 'units', label: 'Units', columns: ['units_count', 'units'], excludeWhenUsed: true },
  { key: 'buildings_count', label: 'Buildings Count', columns: ['sum_buildings_nbr'] },
  { key: 'commercial_units', label: 'Commercial Units', columns: ['sum_commercial_units'], assetClasses: [...COMMERCIAL, ...RESIDENTIAL] },
  { key: 'garage_sqft', label: 'Garage Sqft', columns: ['sum_garage_sqft'] },
  { key: 'fireplaces', label: 'Fireplaces', columns: ['num_of_fireplaces'] },
  { key: 'year_built', label: 'Year Built', columns: ['year_built'], format: fmtIntField },
  { key: 'effective_year_built', label: 'Effective Year Built', columns: ['effective_year_built'], format: fmtIntField },
  { key: 'avg_sqft_per_unit', label: 'Avg Sqft per Unit', columns: ['avg_sqft_per_unit'], assetClasses: RESIDENTIAL, format: (r, rec) => {
    const sqft = nullIfZeroish(asNumber(firstDefined(rec, ['building_square_feet'])))
    const units = nullIfZeroish(asNumber(firstDefined(rec, ['units_count'])))
    return sqft && units ? formatInteger(Math.round(sqft / units)) : fmtIntField(r)
  } },
]

const CONSTRUCTION_SPECS: FieldSpec[] = [
  { key: 'building_condition', label: 'Building Condition', columns: ['building_condition', 'property_condition'], format: fmtText },
  { key: 'building_quality', label: 'Building Quality', columns: ['building_quality'], format: fmtText },
  { key: 'construction_type', label: 'Construction Type', columns: ['construction_type'], format: fmtText },
  { key: 'exterior_walls', label: 'Exterior Walls', columns: ['exterior_walls'], format: fmtText },
  { key: 'interior_walls', label: 'Interior Walls', columns: ['interior_walls'], format: fmtText },
  { key: 'floor_cover', label: 'Floor Cover', columns: ['floor_cover'], format: fmtText },
  { key: 'style', label: 'Architectural Style', columns: ['style'], format: fmtText },
  { key: 'rehab_level', label: 'Rehab Level', columns: ['rehab_level'], format: fmtText },
]

const SYSTEMS_SPECS: FieldSpec[] = [
  { key: 'air_conditioning', label: 'Air Conditioning', columns: ['air_conditioning'], format: fmtText },
  { key: 'heating_type', label: 'Heating Type', columns: ['heating_type'], format: fmtText },
  { key: 'heating_fuel', label: 'Heating Fuel', columns: ['heating_fuel_type'], format: fmtText },
  { key: 'sewer', label: 'Sewer', columns: ['sewer'], format: fmtText },
  { key: 'water', label: 'Water', columns: ['water'], format: fmtText },
]

const AMENITIES_SPECS: FieldSpec[] = [
  { key: 'basement', label: 'Basement', columns: ['basement'], format: fmtText },
  { key: 'garage', label: 'Garage', columns: ['garage'], format: fmtText },
  { key: 'pool', label: 'Pool', columns: ['pool'], format: fmtText },
  { key: 'porch', label: 'Porch', columns: ['porch'], format: fmtText },
  { key: 'patio', label: 'Patio', columns: ['patio'], format: fmtText },
  { key: 'deck', label: 'Deck', columns: ['deck'], format: fmtText },
  { key: 'driveway', label: 'Driveway', columns: ['driveway'], format: fmtText },
]

const ROOF_SPECS: FieldSpec[] = [
  { key: 'roof_type', label: 'Roof Type', columns: ['roof_type'], format: fmtText },
  { key: 'roof_cover', label: 'Roof Cover', columns: ['roof_cover'], format: fmtText },
]

const SITE_SPECS: FieldSpec[] = [
  { key: 'lot_sqft', label: 'Lot Sqft', columns: ['lot_square_feet'], format: fmtIntField, excludeWhenUsed: true },
  { key: 'lot_acres', label: 'Lot Acres', columns: ['lot_acreage'], format: fmtAcres, excludeWhenUsed: true },
  { key: 'lot_frontage', label: 'Lot Frontage', columns: ['lot_size_frontage_feet', 'lot_frontage'], format: fmtIntField },
  { key: 'lot_depth', label: 'Lot Depth', columns: ['lot_size_depth_feet', 'lot_depth'], format: fmtIntField },
  { key: 'topography', label: 'Topography', columns: ['topography'], format: fmtText },
  { key: 'zoning', label: 'Zoning', columns: ['zoning', 'zoning_code'], format: fmtText, excludeWhenUsed: true },
  { key: 'land_use', label: 'Land Use', columns: ['county_land_use_code', 'property_use'], format: fmtText, excludeWhenUsed: true },
  { key: 'property_use', label: 'Property Use', columns: ['property_use'], format: fmtText, assetClasses: [...COMMERCIAL, ...STORAGE, ...LAND] },
  { key: 'building_class', label: 'Building Class', columns: ['building_class'], format: fmtText, assetClasses: COMMERCIAL },
  { key: 'flood_zone', label: 'Flood Zone', columns: ['flood_zone'], format: fmtText },
  { key: 'hoa_name', label: 'HOA Name', columns: ['hoa1_name'], format: fmtText },
  { key: 'hoa_type', label: 'HOA Type', columns: ['hoa1_type'], format: fmtText },
  { key: 'hoa_fee', label: 'HOA Fee', columns: ['hoa_fee_amount'], format: fmtMoneyField },
]

const VALUATION_SPECS: FieldSpec[] = [
  { key: 'assessed_total', label: 'Assessed Total Value', columns: ['assd_total_value', 'assessed_total_value'], format: fmtMoneyField },
  { key: 'assessed_improvement', label: 'Assessed Improvement Value', columns: ['assd_improvement_value', 'assessed_improvement_value'], format: fmtMoneyField },
  { key: 'assessed_land', label: 'Assessed Land Value', columns: ['assd_land_value', 'assessed_land_value'], format: fmtMoneyField, excludeWhenUsed: true },
  { key: 'calculated_total', label: 'Calculated Total Value', columns: ['calculated_total_value'], format: fmtMoneyField },
  { key: 'calculated_improvement', label: 'Calculated Improvement Value', columns: ['calculated_improvement_value'], format: fmtMoneyField },
  { key: 'calculated_land', label: 'Calculated Land Value', columns: ['calculated_land_value'], format: fmtMoneyField },
  { key: 'tax_amount', label: 'Tax Amount', columns: ['tax_amt', 'annual_taxes'], format: fmtMoneyField },
  { key: 'tax_year', label: 'Tax Year', columns: ['tax_year'], format: fmtIntField },
  { key: 'value_per_sqft', label: 'Value / Sqft', columns: ['value_per_sqft'], format: (r, rec) => {
    const v = nullIfZeroish(asNumber(firstDefined(rec, ['estimated_value'])))
    const sqft = nullIfZeroish(asNumber(firstDefined(rec, ['building_square_feet'])))
    return v && sqft ? formatMoney(Math.round(v / sqft)) : fmtMoneyField(r)
  } },
  { key: 'value_per_unit', label: 'Value / Unit', columns: ['value_per_unit'], format: (r, rec) => {
    const v = nullIfZeroish(asNumber(firstDefined(rec, ['estimated_value'])))
    const units = nullIfZeroish(asNumber(firstDefined(rec, ['units_count'])))
    return v && units ? formatMoney(Math.round(v / units)) : fmtMoneyField(r)
  }, assetClasses: RESIDENTIAL },
  { key: 'repair_estimate', label: 'Repair Estimate', columns: ['estimated_repair_cost', 'repair_estimate'], format: fmtMoneyField, excludeWhenUsed: true },
  { key: 'repair_per_sqft', label: 'Repair Cost / Sqft', columns: ['repair_per_sqft'], format: (r, rec) => {
    const repairs = nullIfZeroish(asNumber(firstDefined(rec, ['estimated_repair_cost'])))
    const sqft = nullIfZeroish(asNumber(firstDefined(rec, ['building_square_feet'])))
    return repairs && sqft ? formatMoney(Math.round(repairs / sqft)) : fmtMoneyField(r)
  }, assetClasses: RESIDENTIAL },
]

const LOAN_SPECS: FieldSpec[] = [
  { key: 'loan_balance', label: 'Total Loan Balance', columns: ['total_loan_balance', 'mortgage_balance'], format: fmtMoneyField, excludeWhenUsed: true },
  { key: 'original_loan', label: 'Original Loan Amount', columns: ['total_loan_amt', 'original_loan_amount'], format: fmtMoneyField },
  { key: 'loan_payment', label: 'Loan Payment', columns: ['total_loan_payment', 'loan_payment'], format: fmtMoneyField },
  { key: 'last_sale_date', label: 'Last Sale Date', columns: ['sale_date', 'last_sale_date'], format: (r) => formatDate(text(r)) },
  { key: 'last_sale_price', label: 'Last Sale Price', columns: ['saleprice', 'last_sale_amount'], format: fmtMoneyField },
  { key: 'recording_date', label: 'Recording Date', columns: ['recording_date'], format: (r) => formatDate(text(r)) },
  { key: 'document_type', label: 'Document Type', columns: ['document_type'], format: fmtText },
  { key: 'mls_status', label: 'MLS Status', columns: ['mls_market_status', 'mls_status'], format: fmtText },
  { key: 'listing_price', label: 'Current Listing Price', columns: ['mls_current_listing_price', 'current_listing_price'], format: fmtMoneyField },
  { key: 'mls_sold_date', label: 'MLS Sold Date', columns: ['mls_sold_date'], format: (r) => formatDate(text(r)) },
  { key: 'mls_sold_price', label: 'MLS Sold Price', columns: ['mls_sold_price'], format: fmtMoneyField },
  { key: 'ownership_years', label: 'Ownership Years', columns: ['ownership_years'], format: (r) => {
    const n = nullIfZeroish(asNumber(r))
    return n != null ? `${formatInteger(n)} yrs` : '—'
  } },
]

const DISTRESS_SPECS: FieldSpec[] = [
  { key: 'tax_delinquent', label: 'Tax Delinquent', columns: ['tax_delinquent'], format: fmtBool },
  { key: 'tax_delinquent_year', label: 'Tax Delinquent Year', columns: ['tax_delinquent_year'], format: fmtIntField },
  { key: 'past_due_amount', label: 'Past Due Amount', columns: ['past_due_amount'], format: fmtMoneyField },
  { key: 'active_lien', label: 'Active Lien', columns: ['active_lien'], format: fmtBool },
  { key: 'lienholder', label: 'Lienholder', columns: ['lienholder_name'], format: fmtText },
  { key: 'lien_type', label: 'Lien Type', columns: ['lien_type'], format: fmtText },
  { key: 'lien_position', label: 'Lien Position', columns: ['lien_position'], format: fmtText },
  { key: 'lien_recording_date', label: 'Lien Recording Date', columns: ['lien_recording_date'], format: (r) => formatDate(text(r)) },
  { key: 'foreclosure_status', label: 'Foreclosure Status', columns: ['foreclosure_status'], format: fmtText },
  { key: 'foreclosure_stage', label: 'Foreclosure Stage', columns: ['foreclosure_stage'], format: fmtText },
  { key: 'foreclosure_type', label: 'Foreclosure Type', columns: ['foreclosure_type'], format: fmtText },
  { key: 'preforeclosure_status', label: 'Pre-Foreclosure Status', columns: ['preforeclosure_status'], format: fmtText },
  { key: 'preforeclosure_stage', label: 'Pre-Foreclosure Stage', columns: ['preforeclosure_stage'], format: fmtText },
  { key: 'auction_date', label: 'Auction Date', columns: ['auction_date'], format: (r) => formatDate(text(r)) },
  { key: 'auction_time', label: 'Auction Time', columns: ['auction_time'], format: fmtText },
  { key: 'auction_location', label: 'Auction Location', columns: ['auction_location'], format: fmtText },
  { key: 'auction_status', label: 'Auction Status', columns: ['auction_status'], format: fmtText },
  { key: 'auction_type', label: 'Auction Type', columns: ['auction_type'], format: fmtText },
  { key: 'auction_opening_bid', label: 'Opening Bid', columns: ['auction_opening_bid'], format: fmtMoneyField },
  { key: 'auction_final_bid', label: 'Final Bid', columns: ['auction_final_bid'], format: fmtMoneyField },
  { key: 'auction_case_number', label: 'Case Number', columns: ['auction_case_number'], format: fmtText },
]

const ASSET_SPECIFIC_SPECS: Record<SellerAssetClassKey, FieldSpec[]> = {
  single_family: [],
  multifamily_2_4: [
    { key: 'avg_beds_per_unit', label: 'Beds per Unit', columns: ['avg_beds_per_unit'], format: (r, rec) => {
      const beds = nullIfZeroish(asNumber(firstDefined(rec, ['total_bedrooms'])))
      const units = nullIfZeroish(asNumber(firstDefined(rec, ['units_count'])))
      return beds && units ? formatDecimal(beds / units, 1) : fmtDecField(r, 1)
    } },
  ],
  multifamily_5_plus: [
    { key: 'avg_beds_per_unit', label: 'Beds per Unit', columns: ['avg_beds_per_unit'], format: (r, rec) => {
      const beds = nullIfZeroish(asNumber(firstDefined(rec, ['total_bedrooms'])))
      const units = nullIfZeroish(asNumber(firstDefined(rec, ['units_count'])))
      return beds && units ? formatDecimal(beds / units, 1) : fmtDecField(r, 1)
    } },
  ],
  retail: [{ key: 'commercial_category', label: 'Commercial Category', columns: ['commercial_category'], format: fmtText }],
  office: [{ key: 'commercial_category', label: 'Commercial Category', columns: ['commercial_category'], format: fmtText }],
  industrial: [{ key: 'commercial_category', label: 'Commercial Category', columns: ['commercial_category'], format: fmtText }],
  other_commercial: [
    { key: 'commercial_category', label: 'Commercial Category', columns: ['commercial_category'], format: fmtText },
    { key: 'commercial_subtype', label: 'Commercial Subtype', columns: ['commercial_subtype', 'property_class'], format: fmtText },
  ],
  storage: [
    { key: 'storage_units', label: 'Storage Units', columns: ['storage_units', 'units_count'], format: fmtIntField },
    { key: 'storage_class', label: 'Property Class', columns: ['property_class'], format: fmtText },
  ],
  land: [
    { key: 'land_use_detail', label: 'Land Use', columns: ['county_land_use_code', 'property_use'], format: fmtText },
  ],
  unknown: [],
}

export const buildTopMetricUsedKeys = (assetClassKey: SellerAssetClassKey): Set<string> => {
  const keys = new Set<string>(['estimated_value', 'equity_percent'])
  if (assetClassKey === 'single_family') {
    keys.add('repair_estimate')
    keys.add('loan_balance')
    return keys
  }
  if (assetClassKey === 'multifamily_2_4' || assetClassKey === 'multifamily_5_plus') {
    keys.add('units')
    keys.add('value_per_unit')
    return keys
  }
  if (assetClassKey === 'storage') {
    keys.add('units')
    keys.add('building_sqft')
    keys.add('lot_acres')
    keys.add('lot_sqft')
    return keys
  }
  if (assetClassKey === 'land') {
    keys.add('lot_acres')
    keys.add('lot_sqft')
    keys.add('zoning')
    keys.add('land_use')
    keys.add('assessed_land')
    return keys
  }
  keys.add('building_sqft')
  keys.add('lot_acres')
  keys.add('lot_sqft')
  return keys
}

export const buildPropertyDossierContract = (
  record: Record<string, unknown>,
  assetClassKey: SellerAssetClassKey,
): PropertyDossierContract | null => {
  if (record._dossierHydrated !== true && record.dossier_hydrated !== true) return null

  const usedKeys = buildTopMetricUsedKeys(assetClassKey)

  const propertyDetails = [
    buildGroup(record, 'structure', 'Structure & Size', STRUCTURE_SPECS, usedKeys, assetClassKey),
    buildGroup(record, 'construction', 'Construction & Condition', CONSTRUCTION_SPECS, usedKeys, assetClassKey),
    buildGroup(record, 'systems', 'Systems', SYSTEMS_SPECS, usedKeys, assetClassKey),
    buildGroup(record, 'amenities', 'Features & Amenities', AMENITIES_SPECS, usedKeys, assetClassKey),
    buildGroup(record, 'roof', 'Roof & Exterior', ROOF_SPECS, usedKeys, assetClassKey),
    buildGroup(record, 'site', 'Site & Land', SITE_SPECS, usedKeys, assetClassKey),
  ].filter((group): group is DossierFieldGroup => group != null)

  const valuationAssessment = VALUATION_SPECS
    .map((spec) => buildField(record, spec, usedKeys, assetClassKey))
    .filter((field): field is DossierField => field != null)

  const loanTransaction = LOAN_SPECS
    .map((spec) => buildField(record, spec, usedKeys, assetClassKey))
    .filter((field): field is DossierField => field != null)

  const distressLegal = DISTRESS_SPECS
    .map((spec) => buildField(record, spec, usedKeys, assetClassKey))
    .filter((field): field is DossierField => field != null)

  const assetSpecific = (ASSET_SPECIFIC_SPECS[assetClassKey] ?? [])
    .map((spec) => buildField(record, spec, usedKeys, assetClassKey))
    .filter((field): field is DossierField => field != null)

  return {
    propertyDetails,
    valuationAssessment,
    loanTransaction,
    distressLegal: distressLegal.length > 0 ? distressLegal : null,
    assetSpecific,
  }
}

export const buildOperationalStateLine = (
  record: Record<string, unknown>,
  statusLabel: string,
  messagingBlocked: boolean,
  messagingBlockReason: string | null,
): string | null => {
  if (messagingBlocked) return messagingBlockReason || 'Suppressed'
  const lastInbound = text(firstDefined(record, ['last_inbound_text', 'latest_inbound_body']))
  if (text(firstDefined(record, ['operational_status', 'conversation_status'])).includes('new_reply') && lastInbound) {
    return `New reply: ${lastInbound.slice(0, 120)}`
  }
  if (statusLabel.toLowerCase().includes('follow')) return 'Follow-up due'
  if (statusLabel.toLowerCase().includes('contacted') || statusLabel.toLowerCase().includes('active')) {
    return 'Active communication'
  }
  if (statusLabel.toLowerCase().includes('not contacted')) return 'No contact activity yet'
  return statusLabel
}