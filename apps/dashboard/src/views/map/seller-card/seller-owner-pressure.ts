import {
  asBoolean,
  asNumber,
  firstDefined,
  formatInteger,
  nullIfZeroish,
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
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

const tierFromScore = (score: number): OwnerPressureProfile['tier'] => {
  if (score >= 75) return 'high'
  if (score >= 55) return 'elevated'
  if (score >= 35) return 'moderate'
  return 'low'
}

const tierLabel = (tier: OwnerPressureProfile['tier']): string => {
  if (tier === 'high') return 'High'
  if (tier === 'elevated') return 'Elevated'
  if (tier === 'moderate') return 'Moderate'
  if (tier === 'low') return 'Low'
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
      score += 18
      drivers.push({ label: 'High leverage', impact: 'negative' })
    } else if (leverage <= 0.15) {
      score += 6
      drivers.push({ label: 'Low leverage', impact: 'positive' })
    }
  }

  if (input.taxDelinquent === true) {
    score += 16
    signalCount += 1
    drivers.push({ label: 'Tax exposure', impact: 'negative' })
  }

  if (input.activeLien === true) {
    score += 14
    signalCount += 1
    drivers.push({ label: 'Active lien', impact: 'negative' })
  }

  if ((input.portfolioCount ?? 0) >= 3) {
    score += 10
    signalCount += 1
    drivers.push({ label: `${formatInteger(input.portfolioCount)}-property portfolio`, impact: 'negative' })
  } else if ((input.portfolioCount ?? 0) >= 2) {
    score += 6
    signalCount += 1
    drivers.push({ label: 'Multi-property owner', impact: 'negative' })
  }

  if ((input.ownershipYears ?? 0) >= 12) {
    score += 8
    signalCount += 1
    drivers.push({ label: 'Long hold period', impact: 'negative' })
  }

  if (input.absentee === true) {
    score += 8
    signalCount += 1
    drivers.push({ label: 'Absentee', impact: 'negative' })
  }

  if (input.outOfState === true) {
    score += 6
    signalCount += 1
    drivers.push({ label: 'Out-of-state', impact: 'negative' })
  }

  if (input.vacant === true) {
    score += 10
    signalCount += 1
    drivers.push({ label: 'Vacant', impact: 'negative' })
  }

  if ((input.equityPercent ?? 0) >= 95) {
    score -= 8
    signalCount += 1
    drivers.push({ label: 'Free and clear', impact: 'positive' })
  } else if ((input.equityPercent ?? 0) >= 65) {
    score -= 4
    signalCount += 1
    drivers.push({ label: 'High equity', impact: 'positive' })
  }

  if ((input.portfolioMortgageBalance ?? 0) > 0 && (input.portfolioTaxExposure ?? 0) > 0) {
    score += 6
    signalCount += 1
    drivers.push({ label: 'Portfolio debt/tax load', impact: 'negative' })
  }

  if (signalCount === 0) {
    return {
      score: null,
      tier: null,
      label: 'Insufficient data',
      drivers: [],
      confidence: 'low',
      summary: null,
    }
  }

  const normalized = clamp(Math.round(score))
  const tier = tierFromScore(normalized)
  const negativeDrivers = drivers.filter((driver) => driver.impact === 'negative').slice(0, 3)
  const summaryParts = negativeDrivers.map((driver) => driver.label.toLowerCase())

  return {
    score: normalized,
    tier,
    label: tierLabel(tier),
    drivers: drivers.slice(0, 6),
    confidence: signalCount >= 4 ? 'high' : signalCount >= 2 ? 'medium' : 'low',
    summary: summaryParts.length > 0 ? summaryParts.join(' · ') : null,
  }
}

export const buildOwnerPressureInput = (record: Record<string, unknown>): PressureInput => {
  const estimatedValue = nullIfZeroish(asNumber(firstDefined(record, ['estimated_value', 'estimatedValue'])))
  const equityPercent = nullIfZeroish(asNumber(firstDefined(record, ['equity_percent', 'equityPercent'])))
  const mortgageBalance = nullIfZeroish(asNumber(firstDefined(record, [
    'mortgage_balance',
    'loan_balance',
    'total_loan_balance',
  ])))

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
  }
}