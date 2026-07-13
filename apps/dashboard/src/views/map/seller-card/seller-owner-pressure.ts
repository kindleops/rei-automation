import {
  asBoolean,
  asNumber,
  firstDefined,
  nullIfZeroish,
  text,
} from './seller-map-card-formatters'

export type OwnerPressureDriver = {
  label: string
  impact: 'positive' | 'negative'
}

export type OwnerPressureProfile = {
  score: number | null
  tier: 'low' | 'moderate' | 'elevated' | 'high' | null
  label: string
  drivers: OwnerPressureDriver[]
  confidence: 'high' | 'medium' | 'low'
  summary: string | null
}

export type AcquisitionFitProfile = {
  score: number | null
  tier: 'weak' | 'moderate' | 'strong' | 'exceptional' | null
  label: string
  drivers: OwnerPressureDriver[]
  summary: string | null
}

type PressureInput = {
  equityPercent: number | null
  mortgageBalance: number | null
  estimatedValue: number | null
  taxDelinquent: boolean | null
  activeLien: boolean | null
  absentee: boolean | null
  outOfState: boolean | null
  vacant: boolean | null
  ownershipYears: number | null
  portfolioCount: number | null
  portfolioMortgageBalance: number | null
  portfolioTaxExposure: number | null
  hasDistressFlags: boolean
  hasDialablePhone: boolean
  smsEligible: boolean | null
  hasResolvedProspect: boolean
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

const pressureTierFromScore = (score: number): OwnerPressureProfile['tier'] => {
  if (score >= 75) return 'high'
  if (score >= 55) return 'elevated'
  if (score >= 35) return 'moderate'
  return 'low'
}

const pressureTierLabel = (tier: OwnerPressureProfile['tier']): string => {
  if (tier === 'high') return 'High'
  if (tier === 'elevated') return 'Elevated'
  if (tier === 'moderate') return 'Moderate'
  if (tier === 'low') return 'Low'
  return 'Unknown'
}

const fitTierFromScore = (score: number): AcquisitionFitProfile['tier'] => {
  if (score >= 80) return 'exceptional'
  if (score >= 45) return 'strong'
  if (score >= 25) return 'moderate'
  return 'weak'
}

const fitTierLabel = (tier: AcquisitionFitProfile['tier']): string => {
  if (tier === 'exceptional') return 'Exceptional'
  if (tier === 'strong') return 'Strong'
  if (tier === 'moderate') return 'Moderate'
  if (tier === 'weak') return 'Weak'
  return 'Unknown'
}

export const computeOwnerPressureProfile = (input: PressureInput): OwnerPressureProfile => {
  const drivers: OwnerPressureDriver[] = []
  let score = 0
  let signalCount = 0

  const leverage = input.estimatedValue && input.mortgageBalance
    ? input.mortgageBalance / input.estimatedValue
    : null
  if (leverage != null) {
    signalCount += 1
    if (leverage >= 0.75) {
      score += 22
      drivers.push({ label: 'High leverage', impact: 'negative' })
    } else if (leverage >= 0.55) {
      score += 12
      drivers.push({ label: 'Elevated leverage', impact: 'negative' })
    }
  }

  if (input.taxDelinquent === true) {
    score += 20
    signalCount += 1
    drivers.push({ label: 'Tax delinquent', impact: 'negative' })
  }

  if (input.activeLien === true) {
    score += 18
    signalCount += 1
    drivers.push({ label: 'Active lien', impact: 'negative' })
  }

  if (input.vacant === true) {
    score += 14
    signalCount += 1
    drivers.push({ label: 'Vacant', impact: 'negative' })
  }

  if (input.hasDistressFlags) {
    score += 16
    signalCount += 1
    drivers.push({ label: 'Distress signal', impact: 'negative' })
  }

  if ((input.portfolioMortgageBalance ?? 0) > 0 && (input.portfolioTaxExposure ?? 0) > 0) {
    score += 10
    signalCount += 1
    drivers.push({ label: 'Portfolio debt/tax load', impact: 'negative' })
  }

  if (signalCount === 0) {
    return {
      score: 0,
      tier: 'low',
      label: 'Low',
      drivers: [],
      confidence: 'medium',
      summary: 'No legal/financial pressure detected',
    }
  }

  const normalized = clamp(Math.round(score))
  const tier = pressureTierFromScore(normalized)
  const negativeDrivers = drivers.filter((driver) => driver.impact === 'negative').slice(0, 3)
  const summaryParts = negativeDrivers.map((driver) => driver.label.toLowerCase())

  return {
    score: normalized,
    tier,
    label: pressureTierLabel(tier),
    drivers: drivers.slice(0, 6),
    confidence: signalCount >= 3 ? 'high' : signalCount >= 2 ? 'medium' : 'low',
    summary: summaryParts.length > 0 ? summaryParts.join(' · ') : 'No legal/financial pressure detected',
  }
}

export const computeAcquisitionFitProfile = (input: PressureInput): AcquisitionFitProfile => {
  const drivers: OwnerPressureDriver[] = []
  let score = 0

  if ((input.equityPercent ?? 0) >= 95) {
    score += 24
    drivers.push({ label: 'Free & clear', impact: 'positive' })
  } else if ((input.equityPercent ?? 0) >= 65) {
    score += 16
    drivers.push({ label: 'High equity', impact: 'positive' })
  }

  if (input.absentee === true) {
    score += 14
    drivers.push({ label: 'Absentee', impact: 'positive' })
  }

  if (input.outOfState === true) {
    score += 10
    drivers.push({ label: 'Out-of-state', impact: 'positive' })
  }

  if ((input.ownershipYears ?? 0) >= 12) {
    score += 10
    drivers.push({ label: 'Long hold', impact: 'positive' })
  }

  if ((input.portfolioCount ?? 0) >= 2) {
    score += 12
    drivers.push({ label: 'Portfolio owner', impact: 'positive' })
  }

  if (input.hasResolvedProspect && input.smsEligible === true && input.hasDialablePhone) {
    score += 18
    drivers.push({ label: 'Contactable prospect', impact: 'positive' })
  } else if (input.hasDialablePhone) {
    score += 8
    drivers.push({ label: 'Phone coverage', impact: 'positive' })
  }

  if (drivers.length === 0) {
    return {
      score: null,
      tier: null,
      label: 'Insufficient data',
      drivers: [],
      summary: null,
    }
  }

  const normalized = clamp(Math.round(score))
  const tier = fitTierFromScore(normalized)
  const summaryParts = drivers.slice(0, 4).map((driver) => driver.label.toLowerCase())

  return {
    score: normalized,
    tier,
    label: fitTierLabel(tier),
    drivers: drivers.slice(0, 6),
    summary: summaryParts.join(' · '),
  }
}

const hasDistressFlags = (record: Record<string, unknown>): boolean => {
  const flags = text(firstDefined(record, [
    'property_flags_text',
    'property_flags_json',
    'property_tags_text',
  ])).toLowerCase()
  return /foreclosure|pre-foreclosure|probate|auction|code violation|urgent/.test(flags)
}

const hasDialablePhone = (record: Record<string, unknown>): boolean => {
  const phone = text(firstDefined(record, [
    'canonical_e164',
    'seller_phone',
    'prospect_best_phone',
    'display_phone',
  ]))
  return Boolean(phone) && phone.toLowerCase() !== 'no phone'
}

export const buildOwnerPressureInput = (record: Record<string, unknown>): PressureInput => {
  const estimatedValue = nullIfZeroish(asNumber(firstDefined(record, ['estimated_value', 'estimatedValue'])))
  const equityPercent = nullIfZeroish(asNumber(firstDefined(record, ['equity_percent', 'equityPercent'])))
  const mortgageBalance = nullIfZeroish(asNumber(firstDefined(record, [
    'mortgage_balance',
    'loan_balance',
    'total_loan_balance',
  ])))

  const prospectName = text(firstDefined(record, [
    'prospect_full_name',
    'prospect_first_name',
    'prospect_name',
  ]))

  return {
    equityPercent,
    mortgageBalance,
    estimatedValue,
    taxDelinquent: asBoolean(firstDefined(record, ['tax_delinquent', 'taxDelinquent'])),
    activeLien: asBoolean(firstDefined(record, ['active_lien', 'activeLien'])),
    absentee: asBoolean(firstDefined(record, ['absentee_owner', 'absenteeOwner'])),
    outOfState: asBoolean(firstDefined(record, ['out_of_state_owner', 'outOfStateOwner'])),
    vacant: asBoolean(firstDefined(record, ['vacant', 'is_vacant'])),
    ownershipYears: nullIfZeroish(asNumber(firstDefined(record, ['ownership_years', 'ownershipYears', 'years_owned']))),
    portfolioCount: nullIfZeroish(asNumber(firstDefined(record, [
      'portfolio_count',
      'property_count',
      'owner_property_count',
    ]))),
    portfolioMortgageBalance: nullIfZeroish(asNumber(firstDefined(record, [
      'portfolio_total_loan_balance',
      'portfolio_mortgage_balance',
    ]))),
    portfolioTaxExposure: nullIfZeroish(asNumber(firstDefined(record, [
      'portfolio_total_tax_amount',
      'portfolio_tax_exposure',
    ]))),
    hasDistressFlags: hasDistressFlags(record),
    hasDialablePhone: hasDialablePhone(record),
    smsEligible: record.sms_eligible === true ? true : record.sms_eligible === false ? false : null,
    hasResolvedProspect: Boolean(prospectName),
  }
}