import type { BuyerMatchV4Projection, RankedBuyer } from './buyer-match-v4.types'
import { isUnavailableValue } from './formatters'

export interface BidSegments {
  highFitLow: number | null
  highFitHigh: number | null
  medianLikelyBid: number | null
  institutionalLow: number | null
  institutionalHigh: number | null
  broadLow: number | null
  broadHigh: number | null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function rangeFromBases(buyers: RankedBuyer[]): { low: number | null; high: number | null } {
  const bases = buyers
    .map((b) => b.likelyBidBase)
    .filter((v): v is number => v != null && !isUnavailableValue(v))
  if (!bases.length) return { low: null, high: null }
  return { low: Math.min(...bases), high: Math.max(...bases) }
}

function isHighFit(b: RankedBuyer): boolean {
  return b.matchGrade === 'A+' || b.matchGrade === 'A'
}

function isInstitutional(b: RankedBuyer): boolean {
  return b.institutionalStatus === 'VERIFIED_INSTITUTIONAL' || b.institutionalStatus === 'CORPORATE'
}

/** Segment likely-bid display — broad range is never the headline. */
export function buildBidSegments(projection: BuyerMatchV4Projection | null): BidSegments {
  const buyers = projection?.rankedBuyers ?? []
  const highFit = buyers.filter(isHighFit)
  const institutional = buyers.filter(isInstitutional)

  const highFitRange = rangeFromBases(highFit)
  const instRange = rangeFromBases(institutional)

  const allBases = buyers
    .map((b) => b.likelyBidBase)
    .filter((v): v is number => v != null && !isUnavailableValue(v))

  const market = projection?.market
  const broadLow = market?.likelyBidLow != null && !isUnavailableValue(market.likelyBidLow)
    ? market.likelyBidLow
    : allBases.length ? Math.min(...allBases) : null
  const broadHigh = market?.likelyBidHigh != null && !isUnavailableValue(market.likelyBidHigh)
    ? market.likelyBidHigh
    : allBases.length ? Math.max(...allBases) : null

  return {
    highFitLow: highFitRange.low,
    highFitHigh: highFitRange.high,
    medianLikelyBid: median(allBases),
    institutionalLow: instRange.low,
    institutionalHigh: instRange.high,
    broadLow,
    broadHigh,
  }
}