import type { PurchaseEvent, RankedBuyer } from './buyer-match-v4.types'
import { buildMatchChips } from './buyerFilters'
import { fmtCurrency, fmtMiles, isUnavailableValue } from './formatters'

export interface BuyerDossierModel {
  buyer: RankedBuyer
  chips: string[]
  matchThesis: string[]
  buyBox: Array<{ label: string; value: string; inferred?: boolean }>
  purchaseStats: {
    count30: number
    count90: number
    count180: number
    count365: number
    totalVerified: number
    lastPurchase: string | null
    nearestMiles: number | null
    medianPrice: number | null
    priceLow: number | null
    priceHigh: number | null
    assetMix: string[]
  }
  bidBasis: string
  events: PurchaseEvent[]
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function countInDays(events: PurchaseEvent[], days: number): number {
  const cutoff = Date.now() - days * 86400000
  return events.filter((e) => {
    if (!e.purchaseDate) return false
    const t = new Date(e.purchaseDate).getTime()
    return !Number.isNaN(t) && t >= cutoff
  }).length
}

export function buildBuyerDossier(
  buyer: RankedBuyer,
  allEvents: PurchaseEvent[],
): BuyerDossierModel {
  const events = allEvents.filter((e) => e.buyerId === buyer.buyerId)
  const prices = events
    .map((e) => e.purchasePrice)
    .filter((v): v is number => v != null && !isUnavailableValue(v))
  const assetLanes = [...new Set(events.map((e) => e.assetLane).filter(Boolean))] as string[]

  const thesis: string[] = []
  if (buyer.reasonSummary.length) thesis.push(...buyer.reasonSummary)
  if (buyer.nearestPurchaseMiles != null) {
    thesis.push(`Nearest verified purchase ${fmtMiles(buyer.nearestPurchaseMiles)} from subject`)
  }
  if ((buyer.purchases180d ?? 0) > 0) {
    thesis.push(`${buyer.purchases180d} purchases in the last 180 days near this market`)
  }
  if (buyer.institutionalStatus === 'VERIFIED_INSTITUTIONAL') {
    thesis.push('Verified institutional acquisition pattern in this geography')
  } else if (buyer.institutionalStatus === 'CORPORATE') {
    thesis.push('Corporate repeat buyer with local acquisition history')
  }
  if (buyer.matchGrade) thesis.push(`Match grade ${buyer.matchGrade} based on geographic and price fit`)

  const buyBox: BuyerDossierModel['buyBox'] = [
    { label: 'Asset types', value: assetLanes.length ? assetLanes.join(', ') : 'Unknown', inferred: true },
    {
      label: 'Purchase-price range',
      value: prices.length ? `${fmtCurrency(Math.min(...prices))}–${fmtCurrency(Math.max(...prices))}` : 'Insufficient events',
      inferred: true,
    },
    {
      label: 'Typical acquisition channel',
      value: buyer.institutionalStatus ? 'Institutional acquisition' : 'Direct investor purchase',
      inferred: true,
    },
    {
      label: 'Geographic radius',
      value: buyer.nearestPurchaseMiles != null ? `Within ${fmtMiles(buyer.nearestPurchaseMiles)} of subject` : 'Unknown',
      inferred: true,
    },
  ]

  let bidBasis = 'Based on median verified purchase prices for this buyer near the subject'
  if (isUnavailableValue(buyer.likelyBidBase)) {
    bidBasis = 'Insufficient verified purchase history to estimate likely bid'
  }

  return {
    buyer,
    chips: buildMatchChips(buyer),
    matchThesis: [...new Set(thesis)].slice(0, 8),
    buyBox,
    purchaseStats: {
      count30: countInDays(events, 30),
      count90: countInDays(events, 90),
      count180: countInDays(events, 180),
      count365: countInDays(events, 365),
      totalVerified: events.length,
      lastPurchase: buyer.lastPurchaseAt,
      nearestMiles: buyer.nearestPurchaseMiles,
      medianPrice: median(prices),
      priceLow: prices.length ? Math.min(...prices) : null,
      priceHigh: prices.length ? Math.max(...prices) : null,
      assetMix: assetLanes,
    },
    bidBasis,
    events: events.sort((a, b) => {
      const at = a.purchaseDate ? new Date(a.purchaseDate).getTime() : 0
      const bt = b.purchaseDate ? new Date(b.purchaseDate).getTime() : 0
      return bt - at
    }),
  }
}