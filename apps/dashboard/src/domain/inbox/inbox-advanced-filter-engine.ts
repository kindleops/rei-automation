import type { InboxAdvancedFilters } from '../../modules/inbox/inbox-ui-helpers'
import type { InboxStageSelectValue, InboxViewSelectValue } from './inbox-view-types'

export const DEFAULT_ADVANCED_FILTERS: InboxAdvancedFilters = { outOfStateOwner: 'all' }

export type AdvancedFilterGroupId = 'property' | 'owner' | 'prospect' | 'conversation' | 'phone'

export interface AdvancedFilterFieldSpec {
  id: keyof InboxAdvancedFilters | 'ownerName' | 'phoneNumber' | 'addressSearch'
  group: AdvancedFilterGroupId
  label: string
  kind: 'text' | 'select' | 'number' | 'numberRange' | 'date' | 'dateRange' | 'tri' | 'toggle' | 'multi'
  minKey?: keyof InboxAdvancedFilters
  maxKey?: keyof InboxAdvancedFilters
  optionsKey?: keyof AdvancedFilterOptionBuckets
  placeholder?: string
}

export interface AdvancedFilterOptionBuckets {
  markets: string[]
  states: string[]
  cities: string[]
  zips: string[]
  propertyTypes: string[]
  ownerTypes: string[]
  languages: string[]
  stages: string[]
  deliveryStatuses: string[]
  propertyConditions: string[]
  distressFlags: string[]
}

export const ADVANCED_FILTER_FIELDS: AdvancedFilterFieldSpec[] = [
  { id: 'market', group: 'property', label: 'Market', kind: 'select', optionsKey: 'markets' },
  { id: 'city', group: 'property', label: 'City', kind: 'text' },
  { id: 'state', group: 'property', label: 'State', kind: 'select', optionsKey: 'states' },
  { id: 'zip', group: 'property', label: 'ZIP', kind: 'text' },
  { id: 'propertyType', group: 'property', label: 'Property Type', kind: 'select', optionsKey: 'propertyTypes' },
  { id: 'unitsMin', group: 'property', label: 'Units', kind: 'numberRange', minKey: 'unitsMin', maxKey: 'unitsMax' },
  { id: 'bedsMin', group: 'property', label: 'Bedrooms', kind: 'numberRange', minKey: 'bedsMin', maxKey: 'bedsMax' },
  { id: 'bathsMin', group: 'property', label: 'Bathrooms', kind: 'numberRange', minKey: 'bathsMin', maxKey: 'bathsMax' },
  { id: 'sqftMin', group: 'property', label: 'Square Footage', kind: 'numberRange', minKey: 'sqftMin', maxKey: 'sqftMax' },
  { id: 'yearBuiltMin', group: 'property', label: 'Year Built', kind: 'numberRange', minKey: 'yearBuiltMin', maxKey: 'yearBuiltMax' },
  { id: 'estimatedValueMin', group: 'property', label: 'Property Value', kind: 'numberRange', minKey: 'estimatedValueMin', maxKey: 'estimatedValueMax' },
  { id: 'equityPercentMin', group: 'property', label: 'Equity %', kind: 'numberRange', minKey: 'equityPercentMin', maxKey: 'equityPercentMax' },
  { id: 'equityAmountMin', group: 'property', label: 'Equity Amount', kind: 'numberRange', minKey: 'equityAmountMin', maxKey: 'equityAmountMax' },
  { id: 'mortgageBalanceMin', group: 'property', label: 'Mortgage Balance', kind: 'numberRange', minKey: 'mortgageBalanceMin', maxKey: 'mortgageBalanceMax' },
  { id: 'ownershipYearsMin', group: 'property', label: 'Ownership Duration (yrs)', kind: 'numberRange', minKey: 'ownershipYearsMin', maxKey: 'ownershipYearsMax' },
  { id: 'lastSaleDateFrom', group: 'property', label: 'Last Sale Date', kind: 'dateRange', minKey: 'lastSaleDateFrom', maxKey: 'lastSaleDateTo' },
  { id: 'propertyCondition', group: 'property', label: 'Building Condition', kind: 'select', optionsKey: 'propertyConditions' },
  { id: 'highEquity', group: 'property', label: 'High Equity Flag', kind: 'toggle' },
  { id: 'taxDelinquent', group: 'property', label: 'Tax Delinquent', kind: 'toggle' },
  { id: 'activeLien', group: 'property', label: 'Active Lien', kind: 'toggle' },

  { id: 'ownerName', group: 'owner', label: 'Owner Name', kind: 'text' },
  { id: 'ownerType', group: 'owner', label: 'Owner Type', kind: 'select', optionsKey: 'ownerTypes' },
  { id: 'outOfStateOwner', group: 'owner', label: 'Absentee Owner', kind: 'tri' },
  { id: 'mailingCity', group: 'owner', label: 'Mailing City', kind: 'text' },
  { id: 'mailingState', group: 'owner', label: 'Mailing State', kind: 'text' },
  { id: 'multiplePropertiesOwned', group: 'owner', label: 'Multiple Properties', kind: 'tri' },
  { id: 'corporateMatch', group: 'owner', label: 'Company / Entity Owner', kind: 'tri' },
  { id: 'sellerAgeMin', group: 'owner', label: 'Senior Owner (age min)', kind: 'number', minKey: 'sellerAgeMin' },
  { id: 'netAssetValueMin', group: 'owner', label: 'Owner Score / Net Worth Min', kind: 'number', minKey: 'netAssetValueMin' },

  { id: 'sellerStage', group: 'prospect', label: 'Stage', kind: 'select', optionsKey: 'stages' },
  { id: 'inboxStatus', group: 'prospect', label: 'Disposition', kind: 'text' },
  { id: 'latestIntent', group: 'prospect', label: 'Intent', kind: 'text' },
  { id: 'aiScoreMin', group: 'prospect', label: 'Priority Score Min', kind: 'number', minKey: 'aiScoreMin' },
  { id: 'leadTemperature', group: 'prospect', label: 'Temperature', kind: 'select' },
  { id: 'assignedAgent', group: 'prospect', label: 'Automation Lane / Agent', kind: 'text' },

  { id: 'lastMessageDirection', group: 'conversation', label: 'Latest Direction', kind: 'select' },
  { id: 'hasSellerReply', group: 'conversation', label: 'Has Replied', kind: 'tri' },
  { id: 'activityDateFrom', group: 'conversation', label: 'Last Activity', kind: 'dateRange', minKey: 'activityDateFrom', maxKey: 'activityDateTo' },
  { id: 'lastInboundDateFrom', group: 'conversation', label: 'Last Inbound', kind: 'dateRange', minKey: 'lastInboundDateFrom', maxKey: 'lastInboundDateTo' },
  { id: 'lastOutboundDateFrom', group: 'conversation', label: 'Last Outbound', kind: 'dateRange', minKey: 'lastOutboundDateFrom', maxKey: 'lastOutboundDateTo' },
  { id: 'touchCountMin', group: 'conversation', label: 'Message Count Min', kind: 'number', minKey: 'touchCountMin' },
  { id: 'language', group: 'conversation', label: 'Language', kind: 'select', optionsKey: 'languages' },

  { id: 'phoneNumber', group: 'phone', label: 'Phone Number', kind: 'text' },
  { id: 'deliveryStatus', group: 'phone', label: 'Delivery Status', kind: 'select', optionsKey: 'deliveryStatuses' },
  { id: 'suppressionReason', group: 'phone', label: 'Suppressed / Opted Out', kind: 'text' },
]

const isActiveValue = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') return false
  if (value === 'all') return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
}

export const hasActiveAdvancedFilters = (filters: InboxAdvancedFilters = DEFAULT_ADVANCED_FILTERS): boolean =>
  Object.entries(filters).some(([key, value]) => key !== 'outOfStateOwner' ? isActiveValue(value) : value !== 'all')

export const countActiveAdvancedFilters = (filters: InboxAdvancedFilters = DEFAULT_ADVANCED_FILTERS): number => {
  let count = 0
  const seen = new Set<string>()
  for (const field of ADVANCED_FILTER_FIELDS) {
    if (field.kind === 'numberRange' || field.kind === 'dateRange') {
      const min = field.minKey ? filters[field.minKey] : undefined
      const max = field.maxKey ? filters[field.maxKey] : undefined
      if (isActiveValue(min) || isActiveValue(max)) {
        if (!seen.has(field.id)) { seen.add(field.id); count += 1 }
      }
      continue
    }
    if (field.id === 'ownerName' || field.id === 'phoneNumber' || field.id === 'addressSearch') {
      const searchKey = field.id === 'ownerName' ? 'ownerNameSearch' : field.id === 'phoneNumber' ? 'phoneNumberSearch' : 'addressSearch'
      if (isActiveValue(filters[searchKey as keyof InboxAdvancedFilters]) && !seen.has(field.id)) {
        seen.add(field.id)
        count += 1
      }
      continue
    }
    const value = filters[field.id as keyof InboxAdvancedFilters]
    if (isActiveValue(value) && !seen.has(field.id)) {
      seen.add(field.id)
      count += 1
    }
  }
  if (filters.ownerOccupancy) count += 1
  if (filters.reviewStatus) count += 1
  if (filters.queueStatus) count += 1
  return count
}

export const serializeAdvancedFiltersForServer = (
  filters: InboxAdvancedFilters,
  extras?: { ownerName?: string; phoneNumber?: string; addressSearch?: string; stage?: string; view?: string },
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {}

  const set = (key: string, value: unknown) => {
    if (isActiveValue(value)) payload[key] = value
  }

  set('market', filters.market)
  set('city', filters.city)
  set('state', filters.state)
  set('zip', filters.zip)
  set('propertyType', filters.propertyType)
  set('propertyCondition', filters.propertyCondition)
  set('unitsMin', filters.unitsMin)
  set('unitsMax', filters.unitsMax)
  set('bedsMin', filters.bedsMin)
  set('bedsMax', filters.bedsMax)
  set('bathsMin', filters.bathsMin)
  set('bathsMax', filters.bathsMax)
  set('sqftMin', filters.sqftMin)
  set('sqftMax', filters.sqftMax)
  set('yearBuiltMin', filters.yearBuiltMin)
  set('yearBuiltMax', filters.yearBuiltMax)
  set('estimatedValueMin', filters.estimatedValueMin)
  set('estimatedValueMax', filters.estimatedValueMax)
  set('equityPercentMin', filters.equityPercentMin)
  set('equityPercentMax', filters.equityPercentMax)
  set('equityAmountMin', filters.equityAmountMin)
  set('equityAmountMax', filters.equityAmountMax)
  set('mortgageBalanceMin', filters.mortgageBalanceMin)
  set('mortgageBalanceMax', filters.mortgageBalanceMax)
  set('ownershipYearsMin', filters.ownershipYearsMin)
  set('ownershipYearsMax', filters.ownershipYearsMax)
  set('lastSaleDateFrom', filters.lastSaleDateFrom)
  set('lastSaleDateTo', filters.lastSaleDateTo)
  if (filters.highEquity) set('highEquity', true)
  if (filters.taxDelinquent) set('taxDelinquent', true)
  if (filters.activeLien) set('activeLien', true)
  if (filters.freeAndClear) set('freeAndClear', true)
  if (filters.lowEquity) set('lowEquity', true)
  if (filters.underwater) set('underwater', true)

  set('ownerType', filters.ownerType)
  if (filters.outOfStateOwner === 'yes') set('absenteeOwner', true)
  if (filters.outOfStateOwner === 'no') set('absenteeOwner', false)
  set('mailingCity', filters.mailingCity)
  set('mailingState', filters.mailingState)
  if (filters.corporateMatch === 'yes') set('corporateOwner', true)
  if (filters.corporateMatch === 'no') set('corporateOwner', false)
  if (filters.multiplePropertiesOwned === 'yes') set('multiplePropertiesOwned', true)
  if (filters.multiplePropertiesOwned === 'no') set('multiplePropertiesOwned', false)
  set('sellerAgeMin', filters.sellerAgeMin)
  set('netAssetValueMin', filters.netAssetValueMin)
  set('ownerName', filters.ownerNameSearch || extras?.ownerName)

  set('stage', extras?.stage && extras.stage !== 'all_stages' ? extras.stage : filters.sellerStage)
  set('status', filters.inboxStatus || filters.reviewStatus)
  set('intent', filters.latestIntent)
  set('aiScoreMin', filters.aiScoreMin ?? filters.finalAcquisitionScoreMin ?? filters.motivationMin)
  set('priorityTier', filters.priority)
  set('persona', filters.persona || filters.assignedAgent)
  set('language', filters.language)
  set('leadTemperature', filters.leadTemperature)

  if (filters.lastMessageDirection === 'inbound') set('direction', 'inbound')
  if (filters.lastMessageDirection === 'outbound') set('direction', 'outbound')
  if (filters.hasSellerReply === 'yes') set('hasSellerReply', true)
  if (filters.hasSellerReply === 'no') set('hasSellerReply', false)
  set('activityDateFrom', filters.activityDateFrom)
  set('activityDateTo', filters.activityDateTo)
  set('lastInboundDateFrom', filters.lastInboundDateFrom)
  set('lastInboundDateTo', filters.lastInboundDateTo)
  set('lastOutboundDateFrom', filters.lastOutboundDateFrom)
  set('lastOutboundDateTo', filters.lastOutboundDateTo)
  set('touchCountMin', filters.touchCountMin)
  set('touchCountMax', filters.touchCountMax)
  set('daysSinceLastContactMin', filters.daysSinceLastContactMin)

  set('phoneNumber', filters.phoneNumberSearch || extras?.phoneNumber)
  set('addressSearch', filters.addressSearch || extras?.addressSearch)
  set('deliveryStatus', filters.deliveryStatus)
  if (filters.suppressionReason) set('suppressed', true)
  if (filters.queueStatus) set('queueStatus', filters.queueStatus)

  if (filters.propertyFlagsAny?.length) set('propertyFlagsAny', filters.propertyFlagsAny)
  if (filters.propertyFlagsAll?.length) set('propertyFlagsAll', filters.propertyFlagsAll)
  if (filters.propertyFlagsExclude?.length) set('propertyFlagsExclude', filters.propertyFlagsExclude)
  if (filters.personFlagsAny?.length) set('personFlagsAny', filters.personFlagsAny)
  if (filters.personFlagsAll?.length) set('personFlagsAll', filters.personFlagsAll)
  if (filters.personFlagsExclude?.length) set('personFlagsExclude', filters.personFlagsExclude)

  return payload
}

export interface AdvancedFilterChip {
  key: string
  label: string
  clear: (current: InboxAdvancedFilters) => InboxAdvancedFilters
}

export const buildAdvancedFilterChips = (
  filters: InboxAdvancedFilters,
  context?: { stage?: InboxStageSelectValue; view?: InboxViewSelectValue },
): AdvancedFilterChip[] => {
  const chips: AdvancedFilterChip[] = []
  const push = (key: string, label: string, clear: InboxAdvancedFilters) => {
    chips.push({ key, label, clear })
  }

  if (context?.stage && context.stage !== 'all_stages') {
    push('stage', `Stage: ${context.stage}`, { ...filters, sellerStage: undefined })
  }

  const rangeChip = (key: string, label: string, minKey?: keyof InboxAdvancedFilters, maxKey?: keyof InboxAdvancedFilters) => {
    const min = minKey ? filters[minKey] : undefined
    const max = maxKey ? filters[maxKey] : undefined
    if (!isActiveValue(min) && !isActiveValue(max)) return
    const parts = []
    if (isActiveValue(min)) parts.push(`≥ ${min}`)
    if (isActiveValue(max)) parts.push(`≤ ${max}`)
    push(key, `${label} ${parts.join(' ')}`, {
      ...filters,
      ...(minKey ? { [minKey]: undefined } : {}),
      ...(maxKey ? { [maxKey]: undefined } : {}),
    } as InboxAdvancedFilters)
  }

  for (const field of ADVANCED_FILTER_FIELDS) {
    if (field.kind === 'numberRange' || field.kind === 'dateRange') {
      rangeChip(field.id, field.label, field.minKey, field.maxKey)
      continue
    }
    if (field.id === 'ownerName' || field.id === 'phoneNumber') continue
    const value = filters[field.id as keyof InboxAdvancedFilters]
    if (!isActiveValue(value)) continue
    if (field.kind === 'tri' && value === 'all') continue
    push(field.id, `${field.label}: ${String(value)}`, { ...filters, [field.id]: field.id === 'outOfStateOwner' ? 'all' : undefined } as InboxAdvancedFilters)
  }

  if (filters.highEquity) push('highEquity', 'High Equity', { ...filters, highEquity: undefined })
  if (filters.taxDelinquent) push('taxDelinquent', 'Tax Delinquent', { ...filters, taxDelinquent: undefined })
  if (filters.activeLien) push('activeLien', 'Active Lien', { ...filters, activeLien: undefined })

  return chips
}

export const clearAllAdvancedFilters = (): InboxAdvancedFilters => ({ ...DEFAULT_ADVANCED_FILTERS })