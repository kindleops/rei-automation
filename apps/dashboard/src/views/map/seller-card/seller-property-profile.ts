import type { SellerMapCardViewModel } from './seller-map-card.types'
import {
  asBoolean,
  firstDefined,
  formatDecimal,
  formatInteger,
  formatMoney,
  text,
  titleize,
} from './seller-map-card-formatters'

export type PropertyProfileGroup = {
  key: string
  label: string
  fields: Array<{ label: string; value: string }>
}

export const buildPropertyProfileGroups = (
  vm: SellerMapCardViewModel,
  record: Record<string, unknown>,
): PropertyProfileGroup[] => {
  const assetFirst = vm.focusProfileFields.map((field) => ({ label: field.label, value: field.value }))

  const physical = [
    ...assetFirst,
    { label: 'Stories', value: formatInteger(vm.property.stories) },
    { label: 'Roof', value: text(firstDefined(record, ['roof_type', 'roof'])) || '—' },
    { label: 'Garage', value: text(firstDefined(record, ['garage', 'garage_type'])) || '—' },
    { label: 'Pool', value: asBoolean(firstDefined(record, ['pool', 'has_pool'])) === true ? 'Yes' : '—' },
  ].filter((field) => field.value !== '—')

  const useZoning = [
    { label: 'Property Type', value: vm.property.assetType },
    { label: 'Subtype', value: vm.property.subtype || '—' },
    { label: 'Zoning', value: vm.property.zoning || '—' },
    { label: 'Land Use', value: vm.property.landUse || '—' },
    { label: 'Lot Acres', value: vm.property.acreage != null ? `${formatDecimal(vm.property.acreage, 2)} ac` : '—' },
    { label: 'Building Class', value: text(firstDefined(record, ['building_class', 'property_class'])) || '—' },
  ].filter((field) => field.value !== '—')

  const location = [
    { label: 'City', value: text(firstDefined(record, ['property_address_city', 'city'])) || '—' },
    { label: 'State', value: text(firstDefined(record, ['property_address_state', 'state'])) || '—' },
    { label: 'ZIP', value: text(firstDefined(record, ['property_address_zip', 'zip'])) || '—' },
    { label: 'County', value: text(firstDefined(record, ['property_county_name', 'county'])) || '—' },
    { label: 'Market', value: text(firstDefined(record, ['market', 'filter_market'])) || '—' },
    { label: 'Neighborhood', value: text(firstDefined(record, ['neighborhood', 'subdivision'])) || '—' },
  ].filter((field) => field.value !== '—')

  const taxAssessment = [
    { label: 'Assessed Value', value: formatMoney(vm.financials.assessedTotalValue) },
    { label: 'Tax Amount', value: formatMoney(vm.financials.annualTaxes) },
    { label: 'Delinquency', value: asBoolean(firstDefined(record, ['tax_delinquent'])) === true ? 'Delinquent' : '—' },
  ].filter((field) => field.value !== '—')

  const ownership = [
    { label: 'Owner Occupied', value: formatOccupancy(record, 'owner_occupied') },
    { label: 'Absentee', value: asBoolean(firstDefined(record, ['absentee_owner'])) === true ? 'Yes' : asBoolean(firstDefined(record, ['absentee_owner'])) === false ? 'No' : '—' },
    { label: 'Out of State', value: asBoolean(firstDefined(record, ['out_of_state_owner'])) === true ? 'Yes' : asBoolean(firstDefined(record, ['out_of_state_owner'])) === false ? 'No' : '—' },
    { label: 'Ownership Years', value: vm.masterOwner.yearsOwned != null ? `${formatInteger(vm.masterOwner.yearsOwned)} yrs` : '—' },
    { label: 'Owner Type', value: text(firstDefined(record, ['owner_type'])) ? titleize(text(firstDefined(record, ['owner_type']))) : '—' },
  ].filter((field) => field.value !== '—')

  const groups: PropertyProfileGroup[] = []
  if (physical.length > 0) groups.push({ key: 'physical', label: 'Physical', fields: dedupeFields(physical) })
  if (useZoning.length > 0) groups.push({ key: 'use', label: 'Use / Zoning', fields: dedupeFields(useZoning) })
  if (location.length > 0) groups.push({ key: 'location', label: 'Location', fields: dedupeFields(location) })
  if (taxAssessment.length > 0) groups.push({ key: 'tax', label: 'Tax / Assessment', fields: dedupeFields(taxAssessment) })
  if (ownership.length > 0) groups.push({ key: 'ownership', label: 'Ownership', fields: dedupeFields(ownership) })

  return groups
}

const formatOccupancy = (record: Record<string, unknown>, key: string): string => {
  const value = asBoolean(firstDefined(record, [key, 'is_owner_occupied']))
  if (value === true) return 'Yes'
  if (value === false) return 'No'
  return '—'
}

const dedupeFields = (fields: Array<{ label: string; value: string }>) => {
  const seen = new Set<string>()
  return fields.filter((field) => {
    if (seen.has(field.label)) return false
    seen.add(field.label)
    return true
  })
}