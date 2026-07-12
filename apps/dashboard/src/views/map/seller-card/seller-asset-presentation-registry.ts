import type { SellerMapCardMetric } from './seller-map-card.types'
import {
  asNumber,
  firstDefined,
  formatDecimal,
  formatInteger,
  formatMoney,
  formatPercent,
  nullIfZeroish,
  text,
  titleize,
} from './seller-map-card-formatters'

export type SellerAssetClassKey =
  | 'single_family'
  | 'multifamily_2_4'
  | 'multifamily_5_plus'
  | 'retail'
  | 'office'
  | 'industrial'
  | 'storage'
  | 'land'
  | 'other_commercial'
  | 'unknown'

type AssetPresentation = {
  key: SellerAssetClassKey
  label: string
  buildSummaryLine: (input: AssetInput) => string
  buildContextualLine: (input: AssetInput) => string
  buildPeekMetrics: (input: AssetInput) => SellerMapCardMetric[]
  buildFocusProfileFields: (input: AssetInput) => Array<{ label: string; value: string }>
}

type AssetInput = {
  assetType: string
  subtype: string | null
  units: number | null
  beds: number | null
  baths: number | null
  sqft: number | null
  lotSqft: number | null
  acreage: number | null
  yearBuilt: number | null
  effectiveYearBuilt: number | null
  constructionType: string | null
  condition: string | null
  stories: number | null
  zoning: string | null
  landUse: string | null
  roadAccess: string | null
  avgSqftPerUnit: number | null
  avgBedsPerUnit: number | null
  avgBathsPerUnit: number | null
  estimatedValue: number | null
  equityPercent: number | null
  equityAmount: number | null
  repairs: number | null
  pricePerUnit: number | null
  pricePerSqft: number | null
  valuePerAcre: number | null
  assessedTotalValue: number | null
  occupancyLabel: string | null
  mortgageBalance: number | null
}

const joinParts = (parts: Array<string | null | undefined>): string =>
  parts.filter((part) => part && part !== '—').join(' · ')

const metric = (label: string, value: string, emphasis?: SellerMapCardMetric['emphasis']): SellerMapCardMetric => ({
  label,
  value: value === '' ? '—' : value,
  emphasis,
})

const inferAssetClassKey = (assetType: string, units: number | null): SellerAssetClassKey => {
  const normalized = text(assetType).toLowerCase().replace(/[\s-/]+/g, '_')
  if (normalized.includes('land') || normalized.includes('vacant_lot')) return 'land'
  if (normalized.includes('self_storage') || normalized.includes('storage')) return 'storage'
  if (normalized.includes('industrial') || normalized.includes('warehouse')) return 'industrial'
  if (normalized.includes('office')) return 'office'
  if (normalized.includes('retail') || normalized.includes('strip')) return 'retail'
  if (
    normalized.includes('multifamily')
    || normalized.includes('apartment')
    || normalized.includes('multi_family')
    || (units ?? 0) > 1
  ) {
    return (units ?? 0) >= 5 ? 'multifamily_5_plus' : 'multifamily_2_4'
  }
  if (
    normalized.includes('commercial')
    || normalized.includes('mixed')
    || normalized.includes('hospitality')
  ) {
    return 'other_commercial'
  }
  if (normalized.includes('single') || normalized.includes('residential') || normalized.includes('sfr')) {
    return 'single_family'
  }
  return units && units > 1 ? ((units >= 5) ? 'multifamily_5_plus' : 'multifamily_2_4') : 'unknown'
}

const SINGLE_FAMILY: AssetPresentation = {
  key: 'single_family',
  label: 'Single Family',
  buildSummaryLine: (input) => joinParts([
    input.beds != null ? `${formatInteger(input.beds)} bd` : null,
    input.baths != null ? `${formatDecimal(input.baths, 1)} ba` : null,
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
    input.effectiveYearBuilt != null && input.effectiveYearBuilt !== input.yearBuilt
      ? `Effective ${formatInteger(input.effectiveYearBuilt)}`
      : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : null,
    input.stories != null ? `${formatInteger(input.stories)} story` : null,
    input.occupancyLabel ? `${titleize(input.occupancyLabel)} use` : null,
    input.assessedTotalValue != null ? `Assessed ${formatMoney(input.assessedTotalValue)}` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Equity %', formatPercent(input.equityPercent)),
    metric('Repairs', formatMoney(input.repairs)),
    metric('Mortgage Balance', formatMoney(input.mortgageBalance)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Bedrooms', value: formatInteger(input.beds) },
    { label: 'Bathrooms', value: formatDecimal(input.baths, 1) },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Lot Sqft', value: formatInteger(input.lotSqft) },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
    { label: 'Effective Year', value: formatInteger(input.effectiveYearBuilt) },
    { label: 'Construction', value: text(input.constructionType) || '—' },
    { label: 'Condition', value: text(input.condition) || '—' },
  ],
}

const MULTIFAMILY_2_4: AssetPresentation = {
  key: 'multifamily_2_4',
  label: 'Multifamily 2–4',
  buildSummaryLine: (input) => joinParts([
    input.units != null ? `${formatInteger(input.units)} units` : null,
    input.beds != null && input.baths != null ? `${formatInteger(input.beds)} bd / ${formatDecimal(input.baths, 1)} ba` : null,
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.units != null ? `${formatInteger(input.units)} units` : null,
    input.avgSqftPerUnit != null ? `${formatInteger(input.avgSqftPerUnit)} avg sqft/unit` : null,
    input.avgBedsPerUnit != null ? `${formatDecimal(input.avgBedsPerUnit, 1)} avg bd/unit` : null,
    input.avgBathsPerUnit != null ? `${formatDecimal(input.avgBathsPerUnit, 1)} avg ba/unit` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Equity %', formatPercent(input.equityPercent)),
    metric('Units', formatInteger(input.units)),
    metric('Price / Unit', formatMoney(input.pricePerUnit)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Units', value: formatInteger(input.units) },
    { label: 'Total Beds', value: formatInteger(input.beds) },
    { label: 'Total Baths', value: formatDecimal(input.baths, 1) },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Avg Sqft / Unit', value: formatInteger(input.avgSqftPerUnit) },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
    { label: 'Effective Year', value: formatInteger(input.effectiveYearBuilt) },
  ],
}

const MULTIFAMILY_5_PLUS: AssetPresentation = {
  key: 'multifamily_5_plus',
  label: 'Multifamily 5+',
  buildSummaryLine: (input) => joinParts([
    input.units != null ? `${formatInteger(input.units)} units` : null,
    input.avgSqftPerUnit != null ? `${formatInteger(input.avgSqftPerUnit)} avg sqft/unit` : null,
    input.avgBedsPerUnit != null ? `${formatDecimal(input.avgBedsPerUnit, 1)} avg bd/unit` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.units != null ? `${formatInteger(input.units)} units` : null,
    input.avgSqftPerUnit != null ? `${formatInteger(input.avgSqftPerUnit)} avg sqft/unit` : null,
    input.avgBedsPerUnit != null ? `${formatDecimal(input.avgBedsPerUnit, 1)} avg bd/unit` : null,
    input.avgBathsPerUnit != null ? `${formatDecimal(input.avgBathsPerUnit, 1)} avg ba/unit` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Equity %', formatPercent(input.equityPercent)),
    metric('Units', formatInteger(input.units)),
    input.avgSqftPerUnit != null
      ? metric('Avg Sqft / Unit', formatInteger(input.avgSqftPerUnit))
      : metric('Price / Unit', formatMoney(input.pricePerUnit)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Units', value: formatInteger(input.units) },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Avg Sqft / Unit', value: formatInteger(input.avgSqftPerUnit) },
    { label: 'Avg Beds / Unit', value: formatDecimal(input.avgBedsPerUnit, 1) },
    { label: 'Avg Baths / Unit', value: formatDecimal(input.avgBathsPerUnit, 1) },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
    { label: 'Construction', value: text(input.constructionType) || '—' },
    { label: 'Condition', value: text(input.condition) || '—' },
  ],
}

const RETAIL: AssetPresentation = {
  key: 'retail',
  label: 'Retail',
  buildSummaryLine: (input) => joinParts([
    'Retail',
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.acreage != null ? `${formatDecimal(input.acreage, 1)} ac` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
    input.constructionType ? titleize(input.constructionType) : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.acreage != null ? `${formatDecimal(input.acreage, 1)} ac` : null,
    input.zoning ? `${titleize(input.zoning)} zoning` : null,
    input.effectiveYearBuilt != null ? `Effective ${formatInteger(input.effectiveYearBuilt)}` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Equity %', formatPercent(input.equityPercent)),
    metric('Building Sqft', formatInteger(input.sqft)),
    metric('Lot Size', input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : formatInteger(input.lotSqft)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Subtype', value: text(input.subtype) || 'Retail' },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Lot Acreage', value: input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : '—' },
    { label: 'Zoning', value: text(input.zoning) || '—' },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
    { label: 'Condition', value: text(input.condition) || '—' },
  ],
}

const OFFICE: AssetPresentation = {
  key: 'office',
  label: 'Office',
  buildSummaryLine: (input) => joinParts([
    'Office',
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.stories != null ? `${formatInteger(input.stories)} stories` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.acreage != null ? `${formatDecimal(input.acreage, 1)} ac` : null,
    input.zoning ? `${titleize(input.zoning)} zoning` : null,
    input.effectiveYearBuilt != null ? `Effective ${formatInteger(input.effectiveYearBuilt)}` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Equity %', formatPercent(input.equityPercent)),
    metric('Building Sqft', formatInteger(input.sqft)),
    metric('Lot Size', input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : formatInteger(input.lotSqft)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Subtype', value: text(input.subtype) || 'Office' },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Stories', value: formatInteger(input.stories) },
    { label: 'Lot Acreage', value: input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : '—' },
    { label: 'Zoning', value: text(input.zoning) || '—' },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
  ],
}

const INDUSTRIAL: AssetPresentation = {
  key: 'industrial',
  label: 'Industrial',
  buildSummaryLine: (input) => joinParts([
    'Industrial',
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.acreage != null ? `${formatDecimal(input.acreage, 1)} ac` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.acreage != null ? `${formatDecimal(input.acreage, 1)} ac` : null,
    input.zoning ? `${titleize(input.zoning)} zoning` : null,
    input.effectiveYearBuilt != null ? `Effective ${formatInteger(input.effectiveYearBuilt)}` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Equity %', formatPercent(input.equityPercent)),
    metric('Building Sqft', formatInteger(input.sqft)),
    metric('Lot Size', input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : formatInteger(input.lotSqft)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Subtype', value: text(input.subtype) || 'Industrial' },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Lot Acreage', value: input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : '—' },
    { label: 'Zoning', value: text(input.zoning) || '—' },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
    { label: 'Condition', value: text(input.condition) || '—' },
  ],
}

const STORAGE: AssetPresentation = {
  key: 'storage',
  label: 'Self Storage',
  buildSummaryLine: (input) => joinParts([
    'Self Storage',
    input.units != null ? `${formatInteger(input.units)} units` : null,
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.units != null ? `${formatInteger(input.units)} units` : null,
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.zoning ? `${titleize(input.zoning)} zoning` : null,
    input.assessedTotalValue != null ? `Assessed ${formatMoney(input.assessedTotalValue)}` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Units', formatInteger(input.units)),
    metric('Building Sqft', formatInteger(input.sqft)),
    metric('Lot Size', input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : formatInteger(input.lotSqft)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Units', value: formatInteger(input.units) },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Avg Sqft / Unit', value: formatInteger(input.avgSqftPerUnit) },
    { label: 'Lot Acreage', value: input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : '—' },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
  ],
}

const LAND: AssetPresentation = {
  key: 'land',
  label: 'Land',
  buildSummaryLine: (input) => joinParts([
    'Land',
    input.acreage != null ? `${formatDecimal(input.acreage, 1)} ac` : null,
    input.zoning ? `${titleize(input.zoning)} zoning` : null,
    input.roadAccess ? `${titleize(input.roadAccess)} access` : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.acreage != null ? `${formatDecimal(input.acreage, 1)} ac` : null,
    input.zoning ? `${titleize(input.zoning)} zoning` : null,
    input.roadAccess ? `${titleize(input.roadAccess)} access` : null,
    input.assessedTotalValue != null ? `Assessed ${formatMoney(input.assessedTotalValue)}` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Lot Size', input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : formatInteger(input.lotSqft)),
    metric('Zoning / Use', text(input.zoning) || text(input.landUse) || '—'),
    metric('Owner Status', input.occupancyLabel ? titleize(input.occupancyLabel) : '—'),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Acreage', value: input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : '—' },
    { label: 'Lot Sqft', value: formatInteger(input.lotSqft) },
    { label: 'Zoning', value: text(input.zoning) || '—' },
    { label: 'Land Use', value: text(input.landUse) || '—' },
    { label: 'Road Access', value: text(input.roadAccess) || '—' },
    { label: 'Condition', value: text(input.condition) || '—' },
  ],
}

const OTHER_COMMERCIAL: AssetPresentation = {
  key: 'other_commercial',
  label: 'Commercial',
  buildSummaryLine: (input) => joinParts([
    text(input.subtype) || 'Commercial',
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.acreage != null ? `${formatDecimal(input.acreage, 1)} ac` : null,
    input.zoning ? `${titleize(input.zoning)} zoning` : null,
    input.effectiveYearBuilt != null ? `Effective ${formatInteger(input.effectiveYearBuilt)}` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Equity %', formatPercent(input.equityPercent)),
    metric('Building Sqft', formatInteger(input.sqft)),
    metric('Lot Size', input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : formatInteger(input.lotSqft)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Subtype', value: text(input.subtype) || 'Commercial' },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Lot Acreage', value: input.acreage != null ? `${formatDecimal(input.acreage, 2)} ac` : '—' },
    { label: 'Zoning', value: text(input.zoning) || '—' },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
  ],
}

const UNKNOWN: AssetPresentation = {
  key: 'unknown',
  label: 'Property',
  buildSummaryLine: (input) => joinParts([
    input.assetType !== 'Property' ? input.assetType : null,
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.units != null ? `${formatInteger(input.units)} units` : null,
    input.yearBuilt != null ? `Built ${formatInteger(input.yearBuilt)}` : null,
  ]),
  buildContextualLine: (input) => joinParts([
    input.sqft != null ? `${formatInteger(input.sqft)} sqft` : null,
    input.units != null ? `${formatInteger(input.units)} units` : null,
    input.zoning ? `${titleize(input.zoning)} zoning` : null,
    input.assessedTotalValue != null ? `Assessed ${formatMoney(input.assessedTotalValue)}` : null,
  ]),
  buildPeekMetrics: (input) => [
    metric('Estimated Value', formatMoney(input.estimatedValue), 'primary'),
    metric('Equity %', formatPercent(input.equityPercent)),
    metric('Repairs', formatMoney(input.repairs)),
    metric('Building Sqft', formatInteger(input.sqft)),
  ],
  buildFocusProfileFields: (input) => [
    { label: 'Asset Type', value: text(input.assetType) || '—' },
    { label: 'Building Sqft', value: formatInteger(input.sqft) },
    { label: 'Units', value: formatInteger(input.units) },
    { label: 'Year Built', value: formatInteger(input.yearBuilt) },
  ],
}

const REGISTRY: Record<SellerAssetClassKey, AssetPresentation> = {
  single_family: SINGLE_FAMILY,
  multifamily_2_4: MULTIFAMILY_2_4,
  multifamily_5_plus: MULTIFAMILY_5_PLUS,
  retail: RETAIL,
  office: OFFICE,
  industrial: INDUSTRIAL,
  storage: STORAGE,
  land: LAND,
  other_commercial: OTHER_COMMERCIAL,
  unknown: UNKNOWN,
}

export const resolveSellerAssetPresentation = (
  assetType: string,
  units: number | null,
): AssetPresentation => REGISTRY[inferAssetClassKey(assetType, units)]

export const buildAssetInput = (record: Record<string, unknown>): AssetInput => {
  const units = nullIfZeroish(asNumber(firstDefined(record, ['units_count', 'units', 'unit_count'])))
  const beds = nullIfZeroish(asNumber(firstDefined(record, ['total_bedrooms', 'beds', 'bedrooms'])))
  const baths = nullIfZeroish(asNumber(firstDefined(record, ['total_baths', 'baths', 'bathrooms'])))
  const sqft = nullIfZeroish(asNumber(firstDefined(record, ['building_square_feet', 'sqft', 'livingAreaSqft'])))
  const estimatedValue = nullIfZeroish(asNumber(firstDefined(record, ['estimated_value', 'estimatedValue'])))
  const equityPercent = nullIfZeroish(asNumber(firstDefined(record, ['equity_percent', 'equityPercent'])))
  const equityAmount = nullIfZeroish(asNumber(firstDefined(record, ['equity_amount', 'equityAmount'])))
  const repairs = nullIfZeroish(asNumber(firstDefined(record, ['estimated_repair_cost', 'estimatedRepairCost', 'repair_estimate'])))
  const pricePerUnit = estimatedValue && units ? Math.round(estimatedValue / units) : null
  const pricePerSqft = estimatedValue && sqft ? Math.round(estimatedValue / sqft) : null
  const acreage = nullIfZeroish(asNumber(firstDefined(record, ['lot_acreage', 'acreage'])))
  const valuePerAcre = estimatedValue && acreage ? Math.round(estimatedValue / acreage) : null

  return {
    assetType: titleize(text(firstDefined(record, ['property_type', 'propertyType', 'asset_class', 'normalized_asset_class'])) || 'Property'),
    subtype: text(firstDefined(record, ['property_class', 'property_subtype', 'normalized_asset_class'])) || null,
    units,
    beds,
    baths,
    sqft,
    lotSqft: nullIfZeroish(asNumber(firstDefined(record, ['lot_square_feet', 'lotSqft']))),
    acreage,
    yearBuilt: nullIfZeroish(asNumber(firstDefined(record, ['year_built', 'yearBuilt']))),
    effectiveYearBuilt: nullIfZeroish(asNumber(firstDefined(record, ['effective_year_built', 'effectiveYearBuilt']))),
    constructionType: text(firstDefined(record, ['construction_type', 'constructionType'])) || null,
    condition: text(firstDefined(record, ['building_condition', 'property_condition', 'condition'])) || null,
    stories: nullIfZeroish(asNumber(firstDefined(record, ['stories', 'story_count']))),
    zoning: text(firstDefined(record, ['zoning', 'zoning_code'])) || null,
    landUse: text(firstDefined(record, ['land_use', 'landUse'])) || null,
    roadAccess: text(firstDefined(record, ['road_access', 'roadAccess'])) || null,
    avgSqftPerUnit: sqft && units ? Math.round(sqft / units) : null,
    avgBedsPerUnit: beds && units ? beds / units : null,
    avgBathsPerUnit: baths && units ? baths / units : null,
    estimatedValue,
    equityPercent,
    equityAmount,
    repairs,
    pricePerUnit,
    pricePerSqft,
    valuePerAcre,
    assessedTotalValue: nullIfZeroish(asNumber(firstDefined(record, [
      'assessed_total_value',
      'assd_total_value',
      'total_assessed_value',
      'assessed_value',
    ]))),
    occupancyLabel: text(firstDefined(record, ['occupancy_code', 'occupancy', 'land_use', 'county_land_use_code'])) || null,
    mortgageBalance: nullIfZeroish(asNumber(firstDefined(record, [
      'mortgage_balance',
      'loan_balance',
      'total_loan_balance',
    ]))),
  }
}

export const buildContextualLine = (record: Record<string, unknown>): string => {
  const input = buildAssetInput(record)
  const presentation = resolveSellerAssetPresentation(input.assetType, input.units)
  return presentation.buildContextualLine(input)
}