import type {
  ActivityFilterState,
  BuyerDirectoryMode,
  BuyerFilterState,
  BuyerSortKey,
  PurchaseEvent,
  RankedBuyer,
} from './buyer-match-v4.types'

export interface BuyerFilterCounts {
  total: number
  highFit: number
  institutional: number
  localRegional: number
  builders: number
  contactReady: number
}

export function countBuyers(buyers: RankedBuyer[]): BuyerFilterCounts {
  return {
    total: buyers.length,
    highFit: buyers.filter((b) => b.matchGrade === 'A+' || b.matchGrade === 'A').length,
    institutional: buyers.filter((b) => b.institutionalStatus === 'VERIFIED_INSTITUTIONAL').length,
    localRegional: buyers.filter((b) =>
      b.buyerClass === 'LOCAL_INVESTOR' || b.buyerClass === 'REGIONAL_OPERATOR',
    ).length,
    builders: buyers.filter((b) => b.buyerClass === 'BUILDER').length,
    contactReady: buyers.filter((b) => b.contactReadiness === 'READY').length,
  }
}

function matchesDirectoryMode(b: RankedBuyer, mode: BuyerDirectoryMode): boolean {
  if (mode === 'all_eligible') return b.eligibleDispositionBuyer !== false
  if (mode === 'best_match') return b.eligibleDispositionBuyer !== false
  if (mode === 'local_regional') {
    return b.buyerClass === 'LOCAL_INVESTOR' || b.buyerClass === 'REGIONAL_OPERATOR'
  }
  if (mode === 'institutional') {
    return b.institutionalStatus === 'VERIFIED_INSTITUTIONAL'
      || b.buyerClass === 'INSTITUTIONAL_OPERATOR'
      || b.buyerClass === 'REIT'
      || b.buyerClass === 'PRIVATE_EQUITY_PLATFORM'
  }
  if (mode === 'builders') return b.buyerClass === 'BUILDER'
  if (mode === 'research') {
    return b.eligibleDispositionBuyer === false
      || b.buyerClass === 'GOVERNMENT_AGENCY'
      || b.buyerClass === 'LENDER_OR_SERVICER'
      || b.buyerClass === 'UNKNOWN'
  }
  return true
}

export function filterAndSortBuyers(
  buyers: RankedBuyer[],
  filters: BuyerFilterState,
): RankedBuyer[] {
  let result = [...buyers]

  result = result.filter((b) => matchesDirectoryMode(b, filters.directoryMode))

  if (filters.grade !== 'all') {
    result = result.filter((b) => b.matchGrade === filters.grade)
  }
  if (filters.institutionalOnly) {
    result = result.filter((b) => b.institutionalStatus === 'VERIFIED_INSTITUTIONAL')
  }
  if (filters.active90d) {
    result = result.filter((b) => (b.purchases90d ?? 0) > 0 || isRecentPurchase(b.lastPurchaseAt, 90))
  }
  if (filters.active180d) {
    result = result.filter((b) => (b.purchases180d ?? 0) > 0 || isRecentPurchase(b.lastPurchaseAt, 180))
  }
  if (filters.contactReady) {
    result = result.filter((b) => b.contactReadiness === 'READY')
  }
  if (filters.exactZip) {
    result = result.filter((b) => b.reasonSummary.some((r) => /zip/i.test(r)))
  }

  return sortBuyers(result, filters.sort)
}

function isRecentPurchase(date: string | null, days: number): boolean {
  if (!date) return false
  const t = new Date(date).getTime()
  if (Number.isNaN(t)) return false
  return Date.now() - t <= days * 86400000
}

export function sortBuyers(buyers: RankedBuyer[], sort: BuyerSortKey): RankedBuyer[] {
  const copy = [...buyers]
  const cmp = (a: number | null, b: number | null, desc = true) => {
    const av = a ?? -Infinity
    const bv = b ?? -Infinity
    return desc ? bv - av : av - bv
  }

  copy.sort((a, b) => {
    switch (sort) {
      case 'most_active':
        return cmp(a.purchases90d, b.purchases90d) || cmp(a.purchases180d, b.purchases180d)
      case 'highest_bid':
        return cmp(a.likelyBidBase, b.likelyBidBase)
      case 'nearest':
        return cmp(a.nearestPurchaseMiles, b.nearestPurchaseMiles, false)
      case 'most_recent': {
        const at = a.lastPurchaseAt ? new Date(a.lastPurchaseAt).getTime() : 0
        const bt = b.lastPurchaseAt ? new Date(b.lastPurchaseAt).getTime() : 0
        return bt - at
      }
      case 'most_purchases':
        return cmp(a.lifetimePurchases ?? a.purchases365d ?? a.purchases180d, b.lifetimePurchases ?? b.purchases365d ?? b.purchases180d)
      case 'contact_ready': {
        const score = (r: RankedBuyer) => (r.contactReadiness === 'READY' ? 2 : r.contactReadiness === 'PARTIAL' ? 1 : 0)
        return score(b) - score(a) || cmp(a.matchScore, b.matchScore)
      }
      case 'best_match':
      default:
        return cmp(a.matchScore, b.matchScore)
    }
  })
  return copy
}

export function filterPurchaseEvents(
  events: PurchaseEvent[],
  opts: {
    periodDays: number
    buyerId?: string | null
    institutionalBuyerIds?: Set<string>
    institutionalOnly?: boolean
    localRegionalOnly?: boolean
    singleAssetOnly?: boolean
    packageOnly?: boolean
    pricingEligibleOnly?: boolean
    demandOnly?: boolean
    nonMarketOnly?: boolean
    unknownIdentityOnly?: boolean
    buyerClass?: ActivityFilterState['buyerClass']
    radiusMiles?: number
  },
): PurchaseEvent[] {
  const cutoff = opts.periodDays > 0 ? Date.now() - opts.periodDays * 86400000 : 0
  return events.filter((e) => {
    const familyId = e.buyerFamilyId ?? e.buyerId
    if (opts.buyerId && familyId !== opts.buyerId) return false
    if (opts.institutionalOnly && opts.institutionalBuyerIds && !opts.institutionalBuyerIds.has(familyId)) {
      return false
    }
    if (opts.localRegionalOnly && e.buyerClass !== 'LOCAL_INVESTOR' && e.buyerClass !== 'REGIONAL_OPERATOR') {
      return false
    }
    if (opts.singleAssetOnly && e.transactionScope !== 'SINGLE_ASSET') return false
    if (opts.packageOnly && e.transactionScope === 'SINGLE_ASSET') return false
    if (opts.pricingEligibleOnly && !e.pricingEligible) return false
    if (opts.demandOnly && e.demandEligibility !== 'DISPOSITION_BUYER') return false
    if (opts.nonMarketOnly && e.demandEligibility === 'DISPOSITION_BUYER') return false
    if (opts.unknownIdentityOnly && e.demandEligibility !== 'IDENTITY_UNRESOLVED') return false
    if (opts.buyerClass && opts.buyerClass !== 'all' && e.buyerClass !== opts.buyerClass) return false
    if (opts.periodDays > 0 && e.purchaseDate) {
      const t = new Date(e.purchaseDate).getTime()
      if (!Number.isNaN(t) && t < cutoff) return false
    }
    if (opts.radiusMiles != null && e.distanceMiles != null && e.distanceMiles > opts.radiusMiles) {
      return false
    }
    return true
  })
}

export function buildMatchChips(buyer: RankedBuyer): string[] {
  const chips: string[] = []
  for (const reason of buyer.reasonSummary.slice(0, 3)) {
    chips.push(reason)
  }
  if (buyer.institutionalStatus === 'VERIFIED_INSTITUTIONAL') chips.push('Institutional')
  if (buyer.buyerClass === 'LOCAL_INVESTOR') chips.push('Local investor')
  if (buyer.buyerClass === 'REGIONAL_OPERATOR') chips.push('Regional operator')
  if (buyer.buyerClass === 'BUILDER') chips.push('Builder')
  if ((buyer.purchases90d ?? 0) > 0) chips.push('Active in last 90 days')
  if (buyer.nearestPurchaseMiles != null && buyer.nearestPurchaseMiles <= 2) chips.push('Near subject')
  if (buyer.matchGrade === 'A+' || buyer.matchGrade === 'A') chips.push('Price band aligned')
  return [...new Set(chips)].slice(0, 5)
}

export const SORT_OPTIONS: Array<{ key: BuyerSortKey; label: string }> = [
  { key: 'best_match', label: 'Best Match' },
  { key: 'most_active', label: 'Most Active' },
  { key: 'highest_bid', label: 'Highest Likely Bid' },
  { key: 'nearest', label: 'Nearest Purchase' },
  { key: 'most_recent', label: 'Most Recent Purchase' },
  { key: 'most_purchases', label: 'Most Purchases' },
  { key: 'contact_ready', label: 'Contact Ready' },
]

export function formatBuyerClassLabel(cls: string | null | undefined): string {
  if (!cls) return 'Unknown'
  return cls.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}