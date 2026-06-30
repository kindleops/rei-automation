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
    count60: number
    count90: number
    count180: number
    count365: number
    lifetime: number
    events30: number
    events180: number
    packageAssets: number
    lastPurchase: string | null
    nearestMiles: number | null
    medianPrice: number | null
    priceLow: number | null
    priceHigh: number | null
    assetMix: string[]
    localZipPurchases: number
    radiusPurchases: number
    singleAssetPct: number | null
    packagePct: number | null
  }
  bidBasis: string
  events: PurchaseEvent[]
}

function familyId(buyer: RankedBuyer): string {
  return buyer.buyerFamilyId ?? buyer.buyerId
}

export function buildBuyerDossier(
  buyer: RankedBuyer,
  allEvents: PurchaseEvent[],
): BuyerDossierModel {
  const fid = familyId(buyer)
  const events = allEvents.filter((e) => (e.buyerFamilyId ?? e.buyerId) === fid)
  const activity = buyer.activity

  const prices = events
    .filter((e) => e.pricingEligible && e.propertyAllocatedConsideration != null)
    .map((e) => e.propertyAllocatedConsideration!)
    .filter((v) => !isUnavailableValue(v))

  const assetLanes = [...new Set(events.map((e) => e.assetLane).filter(Boolean))] as string[]

  const thesis: string[] = []
  if (buyer.reasonSummary.length) thesis.push(...buyer.reasonSummary)
  if (buyer.nearestPurchaseMiles != null) {
    thesis.push(`Nearest verified purchase ${fmtMiles(buyer.nearestPurchaseMiles)} from subject`)
  }
  if ((buyer.purchases180d ?? 0) > 0) {
    thesis.push(`${buyer.purchases180d} unique assets in the last 180 days near this market`)
  }
  if (buyer.institutionalStatus === 'VERIFIED_INSTITUTIONAL') {
    thesis.push('Verified institutional acquisition pattern in this geography')
  } else if (buyer.buyerClass === 'LOCAL_INVESTOR') {
    thesis.push('Local investor with verified acquisition history')
  } else if (buyer.buyerClass === 'REGIONAL_OPERATOR') {
    thesis.push('Regional operator with multi-market velocity')
  }
  if (buyer.matchGrade) thesis.push(`Match grade ${buyer.matchGrade} based on geographic and price fit`)

  const buyBox: BuyerDossierModel['buyBox'] = [
    { label: 'Asset types', value: assetLanes.length ? assetLanes.join(', ') : 'Unknown', inferred: true },
    {
      label: 'Qualified purchase-price range',
      value: prices.length ? `${fmtCurrency(Math.min(...prices))}–${fmtCurrency(Math.max(...prices))}` : 'Insufficient qualified events',
      inferred: true,
    },
    {
      label: 'Typical acquisition channel',
      value: buyer.institutionalStatus ? 'Institutional single-asset' : 'Direct investor purchase',
      inferred: true,
    },
    {
      label: 'Geographic radius',
      value: buyer.nearestPurchaseMiles != null ? `Within ${fmtMiles(buyer.nearestPurchaseMiles)} of subject` : 'Unknown',
      inferred: true,
    },
  ]

  let bidBasis = 'Based on qualified single-asset purchases and supported allocations near the subject'
  if (isUnavailableValue(buyer.likelyBidBase)) {
    bidBasis = 'Insufficient qualified purchase history to estimate likely bid'
  }

  const stats = activity
    ? {
        count30: activity.unique30d,
        count60: activity.unique60d,
        count90: activity.unique90d,
        count180: activity.unique180d,
        count365: activity.unique365d,
        lifetime: activity.lifetime,
        events30: activity.events30d,
        events180: activity.events180d,
        packageAssets: activity.packageAssetsLifetime,
        lastPurchase: activity.mostRecentPurchase ?? buyer.lastPurchaseAt,
        nearestMiles: activity.nearestPurchaseMiles ?? buyer.nearestPurchaseMiles,
        medianPrice: activity.medianQualifiedPrice ?? buyer.medianQualifiedPrice ?? null,
        priceLow: activity.qualifiedPriceLow ?? (prices.length ? Math.min(...prices) : null),
        priceHigh: activity.qualifiedPriceHigh ?? (prices.length ? Math.max(...prices) : null),
        assetMix: assetLanes,
        localZipPurchases: activity.localZipPurchases,
        radiusPurchases: activity.radiusPurchases,
        singleAssetPct: activity.singleAssetPct,
        packagePct: activity.packagePct,
      }
    : {
        count30: buyer.purchases30d ?? 0,
        count60: buyer.purchases60d ?? 0,
        count90: buyer.purchases90d ?? 0,
        count180: buyer.purchases180d ?? 0,
        count365: buyer.purchases365d ?? 0,
        lifetime: buyer.lifetimePurchases ?? events.length,
        events30: 0,
        events180: 0,
        packageAssets: 0,
        lastPurchase: buyer.lastPurchaseAt,
        nearestMiles: buyer.nearestPurchaseMiles,
        medianPrice: buyer.medianQualifiedPrice ?? null,
        priceLow: prices.length ? Math.min(...prices) : null,
        priceHigh: prices.length ? Math.max(...prices) : null,
        assetMix: assetLanes,
        localZipPurchases: buyer.localPurchases ?? 0,
        radiusPurchases: 0,
        singleAssetPct: null,
        packagePct: null,
      }

  return {
    buyer,
    chips: buildMatchChips(buyer),
    matchThesis: [...new Set(thesis)].slice(0, 8),
    buyBox,
    purchaseStats: stats,
    bidBasis,
    events: events.sort((a, b) => {
      const at = a.purchaseDate ? new Date(a.purchaseDate).getTime() : 0
      const bt = b.purchaseDate ? new Date(b.purchaseDate).getTime() : 0
      return bt - at
    }),
  }
}