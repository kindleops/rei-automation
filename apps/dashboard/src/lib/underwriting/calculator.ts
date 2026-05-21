/**
 * Deterministic MAO Calculator
 * Enforces strict wholesale rules for SFR and Multifamily deals.
 */

export interface UnderwritingInput {
  propertyType: 'sfh' | 'multifamily_small' | 'multifamily_large' | 'land' | 'commercial'
  arv: number
  repairs: number
  askingPrice?: number | null
}

export interface UnderwritingResult {
  mao: number
  maoCeiling: number
  assignmentFee: number
  equity: number
  marginPercent: number
  verdict: 'strong-buy' | 'buy' | 'maybe' | 'pass'
  score: number
}

const SFR_MIN_PROFIT = 20000
const MF_MIN_PROFIT = 50000
const MF_PERCENT_PROFIT = 0.05

export function calculateWholesaleDeal(input: UnderwritingInput): UnderwritingResult {
  const { propertyType, arv, repairs, askingPrice } = input
  
  // 1. Determine Target Assignment Fee
  let minAssignmentFee = SFR_MIN_PROFIT
  if (propertyType.startsWith('multifamily')) {
    minAssignmentFee = Math.max(MF_MIN_PROFIT, arv * MF_PERCENT_PROFIT)
  }

  // 2. Base Formula: (ARV * 0.70) - Repairs - Fee
  const mao = (arv * 0.70) - repairs - minAssignmentFee
  
  // 3. Max Stretch Ceiling: (ARV * 0.75) - Repairs - Fee
  const maoCeiling = (arv * 0.75) - repairs - minAssignmentFee

  // 4. Equity and Margin
  const equity = arv - repairs - (askingPrice || mao)
  const marginPercent = askingPrice ? ((mao - askingPrice) / mao) * 100 : 0

  // 5. Scoring & Verdict
  let score = 50
  if (askingPrice) {
    if (askingPrice <= mao) score += 30
    if (askingPrice <= mao * 0.9) score += 20
  }

  let verdict: UnderwritingResult['verdict'] = 'maybe'
  if (score >= 80) verdict = 'strong-buy'
  else if (score >= 60) verdict = 'buy'
  else if (score < 40) verdict = 'pass'

  return {
    mao: Math.max(0, Math.floor(mao)),
    maoCeiling: Math.max(0, Math.floor(maoCeiling)),
    assignmentFee: minAssignmentFee,
    equity: Math.floor(equity),
    marginPercent: parseFloat(marginPercent.toFixed(2)),
    verdict,
    score
  }
}
