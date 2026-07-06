import type { InboxAdvancedFilters } from '../../modules/inbox/inbox-ui-helpers'
import { serializeAdvancedFiltersForServer } from '../inbox/inbox-advanced-filter-engine'
import {
  createEmptyExpression,
  createGroup,
  createRule,
} from '../../views/map/master-filters/expression-utils'
import type { AdvancedMapFilterGroup } from '../../views/map/master-filters/types'

export type MapStatusValue = 'all' | 'uncontacted' | 'contacted'

const isActive = (v: unknown): boolean => {
  if (v === undefined || v === null || v === '') return false
  if (v === 'all') return false
  if (Array.isArray(v) && v.length === 0) return false
  return true
}

function triRule(
  fieldKey: string,
  operator: string,
  value: unknown,
  relationshipMatch?: 'any_linked',
) {
  if (!isActive(value)) return null
  if (value === 'no' || value === false) {
    if (operator === 'is_true') return withRel(createRule(fieldKey, 'is_false', true), relationshipMatch)
    if (operator === 'has_data') return withRel(createRule(fieldKey, 'has_no_data', true), relationshipMatch)
    return withRel(createRule(fieldKey, 'is_false', true), relationshipMatch)
  }
  return withRel(createRule(fieldKey, operator, true), relationshipMatch)
}

function withRel(rule: ReturnType<typeof createRule>, rel?: 'any_linked') {
  if (!rel) return rule
  return { ...rule, relationshipMatch: rel }
}

function contactStatusGroup(status: MapStatusValue): AdvancedMapFilterGroup | null {
  if (status === 'uncontacted') {
    return createGroup('OR', [
      createRule('property.contact_status', 'is_any_of', ['uncontacted', 'not_contacted', '']),
      createRule('property.contact_status', 'is_blank', true),
    ])
  }
  if (status === 'contacted') {
    const exclude = createGroup('OR', [
      createRule('property.contact_status', 'is_any_of', ['uncontacted', 'not_contacted', '']),
    ])
    exclude.negated = true
    return createGroup('AND', [
      createRule('property.contact_status', 'is_not_blank', true),
      exclude,
    ])
  }
  return null
}

function buildDirectRules(payload: Record<string, unknown>): AdvancedMapFilterGroup['children'] {
  const rules: AdvancedMapFilterGroup['children'] = []
  const push = (r: ReturnType<typeof createRule> | null) => { if (r) rules.push(r) }
  const gte = (k: string, v: unknown, rel?: 'any_linked') => { if (isActive(v)) push(withRel(createRule(k, 'greater_than_or_equal', v), rel)) }
  const lte = (k: string, v: unknown, rel?: 'any_linked') => { if (isActive(v)) push(withRel(createRule(k, 'less_than_or_equal', v), rel)) }
  const eq = (k: string, v: unknown, rel?: 'any_linked') => { if (isActive(v)) push(withRel(createRule(k, 'equals', v), rel)) }
  const contains = (k: string, v: unknown, rel?: 'any_linked') => { if (isActive(v)) push(withRel(createRule(k, 'contains', v), rel)) }

  eq('property.market', payload.market)
  contains('property.property_address_city', payload.city)
  eq('property.property_address_state', payload.state)
  contains('property.property_address_zip', payload.zip)
  eq('property.property_address_county_name', payload.county)
  eq('property.market_region', payload.marketRegion)
  contains('property.property_address_full', payload.addressSearch)
  eq('property.property_type', payload.propertyType)
  eq('property.property_class', payload.propertyClass)

  gte('property.units_count', payload.unitsMin)
  lte('property.units_count', payload.unitsMax)
  gte('property.total_bedrooms', payload.bedsMin)
  lte('property.total_bedrooms', payload.bedsMax)
  gte('property.total_baths', payload.bathsMin)
  lte('property.total_baths', payload.bathsMax)
  gte('property.building_square_feet', payload.sqftMin)
  lte('property.building_square_feet', payload.sqftMax)
  gte('property.lot_square_feet', payload.lotSqftMin)
  gte('property.lot_acreage', payload.lotAcreageMin)
  gte('property.year_built', payload.yearBuiltMin)
  lte('property.year_built', payload.yearBuiltMax)
  gte('property.effective_year_built', payload.effectiveYearBuiltMin)
  gte('property.ownership_years', payload.ownershipYearsMin)
  lte('property.ownership_years', payload.ownershipYearsMax)

  if (isActive(payload.lastSaleDateFrom)) push(createRule('property.sale_date', 'after', payload.lastSaleDateFrom))
  if (isActive(payload.lastSaleDateTo)) push(createRule('property.sale_date', 'before', payload.lastSaleDateTo))
  gte('property.sale_price', payload.lastSalePriceMin)
  gte('property.assd_total_value', payload.assessedValueMin)
  gte('property.estimated_value', payload.estimatedValueMin)
  lte('property.estimated_value', payload.estimatedValueMax)
  gte('property.calculated_total_value', payload.arvMin)
  gte('property.cash_offer', payload.cashOfferMin)

  gte('property.equity_amount', payload.equityAmountMin)
  lte('property.equity_amount', payload.equityAmountMax)
  gte('property.equity_percent', payload.equityPercentMin)
  lte('property.equity_percent', payload.equityPercentMax)
  gte('property.total_loan_balance', payload.mortgageBalanceMin)
  lte('property.total_loan_balance', payload.mortgageBalanceMax)
  gte('property.total_loan_balance', payload.totalLoanAmtMin)
  gte('property.total_loan_payment', payload.loanPaymentMin)
  gte('property.tax_amt', payload.taxAmtMin)
  gte('property.estimated_repair_cost', payload.repairCostMin)

  gte('property.ai_score', payload.aiScoreMin)
  gte('property.final_acquisition_score', payload.finalAcquisitionScoreMin)
  gte('property.deal_strength_score', payload.dealStrengthScoreMin)
  gte('property.structured_motivation_score', payload.motivationMin)
  gte('property.tag_distress_score', payload.distressScoreMin)

  eq('property.building_condition', payload.buildingCondition || payload.propertyCondition)
  eq('property.building_quality', payload.buildingQuality)
  eq('property.rehab_level', payload.rehabLevel)
  eq('property.construction_type', payload.constructionType)
  eq('property.zoning', payload.zoning)

  push(triRule('property.tax_delinquent', 'is_true', payload.taxDelinquent))
  push(triRule('property.active_lien', 'is_true', payload.activeLien))
  if (payload.highEquity) gte('property.equity_percent', 40)
  if (payload.freeAndClear) gte('property.equity_percent', 95)
  if (payload.lowEquity) lte('property.equity_percent', 20)

  if (Array.isArray(payload.propertyFlagsAny) && payload.propertyFlagsAny.length) {
    push(createRule('property.property_flags_json', 'contains_any', payload.propertyFlagsAny))
  }
  if (Array.isArray(payload.propertyFlagsAll) && payload.propertyFlagsAll.length) {
    push(createRule('property.property_flags_json', 'contains_all', payload.propertyFlagsAll))
  }
  if (Array.isArray(payload.propertyFlagsExclude) && payload.propertyFlagsExclude.length) {
    push(createRule('property.property_flags_json', 'contains_none', payload.propertyFlagsExclude))
  }

  contains('master_owner.display_name', payload.ownerName)
  eq('master_owner.owner_type_guess', payload.ownerType)
  push(triRule('property.is_corporate_owner', 'is_true', payload.corporateOwner))
  push(triRule('property.out_of_state_owner', 'is_true', payload.absenteeOwner))

  gte('master_owner.contactability_score', payload.contactabilityScoreMin)
  gte('master_owner.financial_pressure_score', payload.financialPressureScoreMin)
  gte('master_owner.urgency_score', payload.urgencyScoreMin)
  gte('master_owner.priority_score', payload.ownerPriorityScoreMin)
  eq('master_owner.priority_tier', payload.ownerPriorityTier || payload.priorityTier)
  gte('master_owner.portfolio_total_value', payload.portfolioValueMin)
  gte('master_owner.portfolio_total_equity', payload.portfolioEquityMin)
  gte('master_owner.portfolio_total_loan_balance', payload.portfolioLoanBalanceMin)
  gte('master_owner.portfolio_total_units', payload.portfolioUnitsMin)
  gte('master_owner.property_count', payload.propertyCountMin)
  gte('master_owner.tax_delinquent_count', payload.taxDelinquentCountMin)
  gte('master_owner.active_lien_count', payload.activeLienCountMin)

  push(triRule('prospect.likely_owner', 'is_true', payload.likelyOwner, 'any_linked'))
  push(triRule('prospect.likely_renting', 'is_true', payload.likelyRenting, 'any_linked'))
  push(triRule('prospect.sms_eligible', 'is_true', payload.smsEligible, 'any_linked'))
  push(triRule('prospect.email_eligible', 'is_true', payload.emailEligible, 'any_linked'))
  eq('prospect.best_language', payload.language, 'any_linked')
  gte('prospect.contact_score_final', payload.prospectContactScoreMin, 'any_linked')
  gte('prospect.phone_score_final', payload.prospectPhoneScoreMin, 'any_linked')

  if (Array.isArray(payload.personFlagsAny) && payload.personFlagsAny.length) {
    push(withRel(createRule('prospect.person_flags_json', 'contains_any', payload.personFlagsAny), 'any_linked'))
  }
  if (Array.isArray(payload.personFlagsAll) && payload.personFlagsAll.length) {
    push(withRel(createRule('prospect.person_flags_json', 'contains_all', payload.personFlagsAll), 'any_linked'))
  }
  if (Array.isArray(payload.personFlagsExclude) && payload.personFlagsExclude.length) {
    push(withRel(createRule('prospect.person_flags_json', 'contains_none', payload.personFlagsExclude), 'any_linked'))
  }

  push(triRule('prospect.has_phone', 'has_data', payload.hasPhone, 'any_linked'))
  push(triRule('prospect.has_email', 'has_data', payload.hasEmail, 'any_linked'))
  push(triRule('prospect.is_primary_prospect', 'is_true', payload.primaryProspect, 'any_linked'))
  eq('phone.phone_owner', payload.phoneCarrier, 'any_linked')
  eq('phone.contact_window', payload.contactWindow, 'any_linked')

  return rules
}

export function buildInboxToMapFilterExpression(
  filters: InboxAdvancedFilters,
  mapStatus: MapStatusValue = 'all',
): AdvancedMapFilterGroup {
  const serialized = serializeAdvancedFiltersForServer(filters)
  const statusGroup = contactStatusGroup(mapStatus)
  const directRules = buildDirectRules(serialized)

  const children: AdvancedMapFilterGroup['children'] = []
  if (statusGroup) children.push(statusGroup)
  children.push(...directRules)

  if (!children.length) return createEmptyExpression()
  return createGroup('AND', children)
}

export function countMapFilterActiveFields(
  filters: InboxAdvancedFilters,
  mapStatus: MapStatusValue,
): number {
  let count = mapStatus !== 'all' ? 1 : 0
  const serialized = serializeAdvancedFiltersForServer(filters)
  for (const [key, value] of Object.entries(serialized)) {
    if (isActive(value)) count += 1
  }
  return count
}