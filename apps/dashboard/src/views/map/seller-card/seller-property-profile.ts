import type { SellerMapCardViewModel } from './seller-map-card.types'
import {
  asBoolean,
  firstDefined,
  formatDecimal,
  formatInteger,
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
  const physical = [
    { label: 'Beds', value: formatInteger(vm.property.beds) },
    { label: 'Baths', value: formatDecimal(vm.property.baths, 1) },
    { label: 'Building Sqft', value: formatInteger(vm.property.sqft) },
    { label: 'Lot Sqft', value: formatInteger(vm.property.lotSqft) },
    { label: 'Year Built', value: formatInteger(vm.property.yearBuilt) },
    { label: 'Stories', value: formatInteger(vm.property.stories) },
  ].filter((field) => field.value !== '—')

  const useZoning = [
    { label: 'Property Type', value: vm.property.assetType },
    { label: 'Subtype', value: vm.property.subtype || '—' },
    { label: 'Lot Acres', value: vm.property.acreage != null ? `${formatDecimal(vm.property.acreage, 2)} ac` : '—' },
    { label: 'Zoning', value: vm.property.zoning || '—' },
  ].filter((field) => field.value !== '—')

  const location = [
    { label: 'City', value: text(firstDefined(record, ['property_address_city', 'city'])) || '—' },
    { label: 'State', value: text(firstDefined(record, ['property_address_state', 'state'])) || '—' },
    { label: 'ZIP', value: text(firstDefined(record, ['property_address_zip', 'zip'])) || '—' },
    { label: 'Market', value: text(firstDefined(record, ['market', 'filter_market'])) || '—' },
    { label: 'County', value: text(firstDefined(record, ['property_county_name', 'county'])) || '—' },
  ].filter((field) => field.value !== '—')

  const ownership = [
    { label: 'Owner Type', value: text(firstDefined(record, ['owner_type'])) ? titleize(text(firstDefined(record, ['owner_type']))) : '—' },
    { label: 'Absentee', value: asBoolean(firstDefined(record, ['absentee_owner'])) === true ? 'Yes' : asBoolean(firstDefined(record, ['absentee_owner'])) === false ? 'No' : '—' },
    { label: 'Out-of-State', value: asBoolean(firstDefined(record, ['out_of_state_owner'])) === true ? 'Yes' : asBoolean(firstDefined(record, ['out_of_state_owner'])) === false ? 'No' : '—' },
    { label: 'Ownership Years', value: vm.masterOwner.yearsOwned != null ? `${formatInteger(vm.masterOwner.yearsOwned)} yrs` : '—' },
  ].filter((field) => field.value !== '—')

  const groups: PropertyProfileGroup[] = []
  if (physical.length > 0) groups.push({ key: 'physical', label: 'Physical', fields: dedupeFields(physical) })
  if (useZoning.length > 0) groups.push({ key: 'use', label: 'Use / Zoning', fields: dedupeFields(useZoning) })
  if (location.length > 0) groups.push({ key: 'location', label: 'Location', fields: dedupeFields(location) })
  if (ownership.length > 0) groups.push({ key: 'ownership', label: 'Ownership', fields: dedupeFields(ownership) })

  return groups
}

const dedupeFields = (fields: Array<{ label: string; value: string }>) => {
  const seen = new Set<string>()
  return fields.filter((field) => {
    if (seen.has(field.label)) return false
    seen.add(field.label)
    return true
  })
}