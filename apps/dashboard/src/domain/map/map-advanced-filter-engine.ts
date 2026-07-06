import {
  createEmptyExpression,
  createGroup,
  createRule,
  countActiveRules,
} from '../../views/map/master-filters/expression-utils'
import type { AdvancedMapFilterGroup } from '../../views/map/master-filters/types'
import { CANONICAL_PROPERTY_BASELINE } from '../../views/map/master-filters/constants'

export type MapFilterGroupId =
  | 'map_status'
  | 'property'
  | 'financials'
  | 'prospect'
  | 'owner'
  | 'phone'
  | 'email'

export type MapStatusValue = 'all' | 'uncontacted' | 'contacted'
export type TriValue = '' | 'yes' | 'no'

export interface MapAdvancedFilters {
  mapStatus: MapStatusValue
  propertyType: string
  unitsMin?: number
  unitsMax?: number
  equityPercentMin?: number
  equityPercentMax?: number
  estimatedValueMin?: number
  estimatedValueMax?: number
  smsEligible: TriValue
  prospectHasPhone: TriValue
  prospectHasEmail: TriValue
  primaryProspect: TriValue
  ownerPropertyCountMin?: number
  portfolioUnitsMin?: number
  hasCanonicalPhone: TriValue
}

export const DEFAULT_MAP_ADVANCED_FILTERS: MapAdvancedFilters = {
  mapStatus: 'all',
  propertyType: '',
  smsEligible: '',
  prospectHasPhone: '',
  prospectHasEmail: '',
  primaryProspect: '',
  hasCanonicalPhone: '',
}

export const MAP_FILTER_GROUPS: Array<{ id: MapFilterGroupId; label: string; icon: string }> = [
  { id: 'map_status', label: 'Map Status', icon: '🗺️' },
  { id: 'property', label: 'Property', icon: '🏠' },
  { id: 'financials', label: 'Financials', icon: '💰' },
  { id: 'prospect', label: 'Prospect', icon: '👤' },
  { id: 'owner', label: 'Owner & Portfolio', icon: '💼' },
  { id: 'phone', label: 'Phone & Delivery', icon: '📱' },
  { id: 'email', label: 'Email & Eligibility', icon: '✉️' },
]

export type MapFilterFieldKind = 'mapStatus' | 'select' | 'numberRange' | 'tri'

export interface MapFilterFieldSpec {
  id: keyof MapAdvancedFilters
  group: MapFilterGroupId
  label: string
  kind: MapFilterFieldKind
  minKey?: keyof MapAdvancedFilters
  maxKey?: keyof MapAdvancedFilters
  options?: { label: string; value: string }[]
  categoryLabel: string
}

const PROPERTY_TYPE_OPTIONS = [
  { label: 'Single Family', value: 'Single Family' },
  { label: 'Multifamily 2–4', value: 'Multifamily 2-4' },
  { label: 'Multifamily 5+', value: 'Multifamily 5+' },
  { label: 'Commercial', value: 'Commercial' },
  { label: 'Storage', value: 'Storage Units' },
  { label: 'Land', value: 'Land' },
]

export const MAP_FILTER_FIELD_SPECS: MapFilterFieldSpec[] = [
  {
    id: 'mapStatus',
    group: 'map_status',
    label: 'Property Universe',
    kind: 'mapStatus',
    categoryLabel: 'Map Status',
    options: [
      { label: 'All Properties', value: 'all' },
      { label: 'Uncontacted', value: 'uncontacted' },
      { label: 'Contacted', value: 'contacted' },
    ],
  },
  {
    id: 'propertyType',
    group: 'property',
    label: 'Property Type',
    kind: 'select',
    categoryLabel: 'Property',
    options: PROPERTY_TYPE_OPTIONS,
  },
  {
    id: 'unitsMin',
    group: 'property',
    label: 'Units Count',
    kind: 'numberRange',
    minKey: 'unitsMin',
    maxKey: 'unitsMax',
    categoryLabel: 'Property',
  },
  {
    id: 'estimatedValueMin',
    group: 'financials',
    label: 'Estimated Value',
    kind: 'numberRange',
    minKey: 'estimatedValueMin',
    maxKey: 'estimatedValueMax',
    categoryLabel: 'Financials',
  },
  {
    id: 'equityPercentMin',
    group: 'financials',
    label: 'Equity Percentage',
    kind: 'numberRange',
    minKey: 'equityPercentMin',
    maxKey: 'equityPercentMax',
    categoryLabel: 'Financials',
  },
  {
    id: 'smsEligible',
    group: 'prospect',
    label: 'SMS Eligible',
    kind: 'tri',
    categoryLabel: 'Prospect',
  },
  {
    id: 'prospectHasPhone',
    group: 'prospect',
    label: 'Has Phone',
    kind: 'tri',
    categoryLabel: 'Prospect',
  },
  {
    id: 'prospectHasEmail',
    group: 'prospect',
    label: 'Has Email',
    kind: 'tri',
    categoryLabel: 'Prospect',
  },
  {
    id: 'primaryProspect',
    group: 'prospect',
    label: 'Primary Prospect',
    kind: 'tri',
    categoryLabel: 'Prospect',
  },
  {
    id: 'ownerPropertyCountMin',
    group: 'owner',
    label: 'Property Count',
    kind: 'numberRange',
    minKey: 'ownerPropertyCountMin',
    categoryLabel: 'Owner & Portfolio',
  },
  {
    id: 'portfolioUnitsMin',
    group: 'owner',
    label: 'Unit Count',
    kind: 'numberRange',
    minKey: 'portfolioUnitsMin',
    categoryLabel: 'Owner & Portfolio',
  },
  {
    id: 'hasCanonicalPhone',
    group: 'phone',
    label: 'Has Canonical Phone',
    kind: 'tri',
    categoryLabel: 'Phone & Delivery',
  },
  {
    id: 'smsEligible',
    group: 'email',
    label: 'SMS Eligible',
    kind: 'tri',
    categoryLabel: 'Email & Eligibility',
  },
  {
    id: 'prospectHasEmail',
    group: 'email',
    label: 'Has Email',
    kind: 'tri',
    categoryLabel: 'Email & Eligibility',
  },
]

const isActive = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') return false
  if (value === 'all') return false
  return true
}

function withRelationship(rule: ReturnType<typeof createRule>, relationshipMatch?: 'any_linked') {
  if (!relationshipMatch) return rule
  return { ...rule, relationshipMatch }
}

function buildContactStatusExpression(status: MapStatusValue): AdvancedMapFilterGroup | null {
  if (status === 'uncontacted') {
    return createGroup('OR', [
      createRule('property.contact_status', 'is_any_of', ['uncontacted', 'not_contacted', '']),
      createRule('property.contact_status', 'is_blank', true),
    ])
  }
  if (status === 'contacted') {
    const excludeUncontacted = createGroup('OR', [
      createRule('property.contact_status', 'is_any_of', ['uncontacted', 'not_contacted', '']),
    ])
    excludeUncontacted.negated = true
    return createGroup('AND', [
      createRule('property.contact_status', 'is_not_blank', true),
      excludeUncontacted,
    ])
  }
  return null
}

function triToRule(
  fieldKey: string,
  operator: string,
  value: TriValue,
  relationshipMatch?: 'any_linked',
) {
  if (!value) return null
  if (value === 'no') {
    return withRelationship(
      createRule(fieldKey, operator === 'is_true' ? 'is_false' : 'has_no_data', true),
      relationshipMatch,
    )
  }
  return withRelationship(createRule(fieldKey, operator, true), relationshipMatch)
}

export function buildMapFilterExpression(filters: MapAdvancedFilters): AdvancedMapFilterGroup {
  const statusGroup = buildContactStatusExpression(filters.mapStatus)
  const fieldRules = buildFieldRules({ ...filters, mapStatus: 'all' })

  if (statusGroup) {
    if (fieldRules.length === 0) return statusGroup
    return createGroup('AND', [statusGroup, createGroup('AND', fieldRules)])
  }

  const rules: AdvancedMapFilterGroup['children'] = []

  rules.push(...fieldRules)

  if (rules.length === 0) return createEmptyExpression()
  return createGroup('AND', rules)
}

function buildFieldRules(filters: MapAdvancedFilters): AdvancedMapFilterGroup['children'] {
  const rules: AdvancedMapFilterGroup['children'] = []

  if (filters.propertyType) {
    rules.push(createRule('property.property_type', 'equals', filters.propertyType))
  }
  if (isActive(filters.unitsMin)) {
    rules.push(createRule('property.units_count', 'greater_than_or_equal', filters.unitsMin))
  }
  if (isActive(filters.unitsMax)) {
    rules.push(createRule('property.units_count', 'less_than_or_equal', filters.unitsMax))
  }
  if (isActive(filters.equityPercentMin)) {
    rules.push(createRule('property.equity_percent', 'greater_than_or_equal', filters.equityPercentMin))
  }
  if (isActive(filters.equityPercentMax)) {
    rules.push(createRule('property.equity_percent', 'less_than_or_equal', filters.equityPercentMax))
  }
  if (isActive(filters.estimatedValueMin)) {
    rules.push(createRule('property.estimated_value', 'greater_than_or_equal', filters.estimatedValueMin))
  }
  if (isActive(filters.estimatedValueMax)) {
    rules.push(createRule('property.estimated_value', 'less_than_or_equal', filters.estimatedValueMax))
  }

  const smsRule = triToRule('prospect.sms_eligible', 'is_true', filters.smsEligible, 'any_linked')
  if (smsRule) rules.push(smsRule)
  const prospectPhone = triToRule('prospect.has_phone', 'has_data', filters.prospectHasPhone, 'any_linked')
  if (prospectPhone) rules.push(prospectPhone)
  const prospectEmail = triToRule('prospect.has_email', 'has_data', filters.prospectHasEmail, 'any_linked')
  if (prospectEmail) rules.push(prospectEmail)
  const primary = triToRule('prospect.is_primary_prospect', 'is_true', filters.primaryProspect, 'any_linked')
  if (primary) rules.push(primary)

  if (isActive(filters.ownerPropertyCountMin)) {
    rules.push(createRule('master_owner.property_count', 'greater_than_or_equal', filters.ownerPropertyCountMin))
  }
  if (isActive(filters.portfolioUnitsMin)) {
    rules.push(createRule('master_owner.portfolio_total_units', 'greater_than_or_equal', filters.portfolioUnitsMin))
  }

  const phoneRule = triToRule('phone.has_canonical_phone', 'has_data', filters.hasCanonicalPhone, 'any_linked')
  if (phoneRule) rules.push(phoneRule)

  return rules
}

export function countActiveMapFilters(filters: MapAdvancedFilters): number {
  let count = 0
  if (filters.mapStatus !== 'all') count += 1
  if (filters.propertyType) count += 1
  if (isActive(filters.unitsMin) || isActive(filters.unitsMax)) count += 1
  if (isActive(filters.equityPercentMin) || isActive(filters.equityPercentMax)) count += 1
  if (isActive(filters.estimatedValueMin) || isActive(filters.estimatedValueMax)) count += 1
  if (filters.smsEligible) count += 1
  if (filters.prospectHasPhone) count += 1
  if (filters.prospectHasEmail) count += 1
  if (filters.primaryProspect) count += 1
  if (isActive(filters.ownerPropertyCountMin)) count += 1
  if (isActive(filters.portfolioUnitsMin)) count += 1
  if (filters.hasCanonicalPhone) count += 1
  return count
}

export interface MapFilterChip {
  key: string
  label: string
  clear: (filters: MapAdvancedFilters) => MapAdvancedFilters
}

function formatTri(label: string, value: TriValue): string {
  return `${label}: ${value === 'yes' ? 'Yes' : 'No'}`
}

export function buildMapFilterChips(filters: MapAdvancedFilters): MapFilterChip[] {
  const chips: MapFilterChip[] = []

  if (filters.mapStatus !== 'all') {
    const label = filters.mapStatus === 'uncontacted' ? 'Uncontacted' : 'Contacted'
    chips.push({
      key: 'mapStatus',
      label: `Map Status ${label}`,
      clear: (f) => ({ ...f, mapStatus: 'all' }),
    })
  }
  if (filters.propertyType) {
    chips.push({
      key: 'propertyType',
      label: `Property Property Type: ${filters.propertyType}`,
      clear: (f) => ({ ...f, propertyType: '' }),
    })
  }
  if (isActive(filters.unitsMin) || isActive(filters.unitsMax)) {
    const min = filters.unitsMin != null ? `${filters.unitsMin}+` : ''
    const max = filters.unitsMax != null ? `≤${filters.unitsMax}` : ''
    chips.push({
      key: 'units',
      label: `Property Units: ${min || max}`,
      clear: (f) => ({ ...f, unitsMin: undefined, unitsMax: undefined }),
    })
  }
  if (isActive(filters.equityPercentMin)) {
    chips.push({
      key: 'equity',
      label: `Financials Equity %: ${filters.equityPercentMin}%+`,
      clear: (f) => ({ ...f, equityPercentMin: undefined, equityPercentMax: undefined }),
    })
  }
  if (isActive(filters.estimatedValueMin)) {
    chips.push({
      key: 'value',
      label: `Financials Est. Value: $${filters.estimatedValueMin!.toLocaleString()}+`,
      clear: (f) => ({ ...f, estimatedValueMin: undefined, estimatedValueMax: undefined }),
    })
  }
  if (filters.smsEligible) {
    chips.push({
      key: 'sms',
      label: `Prospect ${formatTri('SMS Eligible', filters.smsEligible)}`,
      clear: (f) => ({ ...f, smsEligible: '' }),
    })
  }
  if (filters.prospectHasPhone) {
    chips.push({
      key: 'prospectPhone',
      label: `Prospect ${formatTri('Has Phone', filters.prospectHasPhone)}`,
      clear: (f) => ({ ...f, prospectHasPhone: '' }),
    })
  }
  if (filters.prospectHasEmail) {
    chips.push({
      key: 'prospectEmail',
      label: `Prospect ${formatTri('Has Email', filters.prospectHasEmail)}`,
      clear: (f) => ({ ...f, prospectHasEmail: '' }),
    })
  }
  if (filters.primaryProspect) {
    chips.push({
      key: 'primary',
      label: `Prospect ${formatTri('Primary', filters.primaryProspect)}`,
      clear: (f) => ({ ...f, primaryProspect: '' }),
    })
  }
  if (isActive(filters.ownerPropertyCountMin)) {
    chips.push({
      key: 'ownerCount',
      label: `Owner & Portfolio Property Count: ${filters.ownerPropertyCountMin}+`,
      clear: (f) => ({ ...f, ownerPropertyCountMin: undefined }),
    })
  }
  if (isActive(filters.portfolioUnitsMin)) {
    chips.push({
      key: 'portfolioUnits',
      label: `Owner & Portfolio Unit Count: ${filters.portfolioUnitsMin}+`,
      clear: (f) => ({ ...f, portfolioUnitsMin: undefined }),
    })
  }
  if (filters.hasCanonicalPhone) {
    chips.push({
      key: 'canonicalPhone',
      label: `Phone & Delivery ${formatTri('Has Canonical Phone', filters.hasCanonicalPhone)}`,
      clear: (f) => ({ ...f, hasCanonicalPhone: '' }),
    })
  }

  return chips
}

export function clearAllMapFilters(): MapAdvancedFilters {
  return { ...DEFAULT_MAP_ADVANCED_FILTERS }
}

export function expressionIsComplete(expression: AdvancedMapFilterGroup): boolean {
  return countActiveRules(expression) === 0 || countActiveRules(expression) > 0
}

export function baselinePropertyCount(): number {
  return CANONICAL_PROPERTY_BASELINE
}