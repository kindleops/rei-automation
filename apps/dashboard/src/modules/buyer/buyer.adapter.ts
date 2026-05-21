import type { CommandCenterStore } from '../../domain/types'
import { formatCurrency, formatRelativeTime } from '../../shared/formatters'

export interface BuyerProfile {
  id: string
  name: string
  intent: 'active' | 'passive' | 'watching' | 'dormant'
  budget: number
  budgetLabel: string
  marketLabels: string[]
  targetPropertyTypes: string[]
  targetZips: string[]
  matchScore: number
  lastActivityLabel: string
  lastActivityIso: string
  acquisitionsYTD: number
  avgDaysToClose: number
  preApproved: boolean
  notes: string
}

export interface BuyerMatch {
  buyerId: string
  buyerName: string
  leadId: string
  leadAddress: string
  leadOwnerName: string
  matchScore: number
  propertyType: string
  marketLabel: string
  offerAmount: number
  offerLabel: string
}

export interface BuyerModel {
  buyers: BuyerProfile[]
  matches: BuyerMatch[]
  activeBuyerCount: number
  totalBudget: string
  avgMatchScore: number
}

export const adaptBuyerModel = (store: CommandCenterStore): BuyerModel => {
  const buyers: BuyerProfile[] = store.buyerProfileIds.map((id) => {
    const raw = store.buyerProfilesById[id]!
    const marketLabels = raw.marketIds
      .map((mid) => store.marketsById[mid]?.label ?? mid)

    return {
      id: raw.id,
      name: raw.name,
      intent: raw.intent,
      budget: raw.budget,
      budgetLabel: formatCurrency(raw.budget),
      marketLabels,
      targetPropertyTypes: raw.targetPropertyTypes,
      targetZips: raw.targetZips,
      matchScore: raw.matchScore,
      lastActivityLabel: formatRelativeTime(raw.lastActivityIso),
      lastActivityIso: raw.lastActivityIso,
      acquisitionsYTD: raw.acquisitionsYTD,
      avgDaysToClose: raw.avgDaysToClose,
      preApproved: raw.preApproved,
      notes: raw.notes,
    }
  })

  // Compute matches — cross-reference buyers with available leads
  const matches: BuyerMatch[] = []
  for (const buyer of buyers) {
    if (buyer.intent === 'dormant') continue
    for (const propId of store.propertyIds) {
      const lead = store.propertiesById[propId]!
      const market = store.marketsById[lead.marketId]
      const raw = store.buyerProfilesById[buyer.id]!

      if (!raw.marketIds.includes(lead.marketId)) continue
      if (!raw.targetPropertyTypes.includes(lead.propertyType)) continue

      const zipMatch = raw.targetZips.includes(lead.zip) ? 10 : 0
      const sentimentBonus = lead.sentiment === 'hot' ? 15 : lead.sentiment === 'warm' ? 8 : 0
      const score = Math.min(100, buyer.matchScore + zipMatch + sentimentBonus - 20)

      if (score >= 60) {
        matches.push({
          buyerId: buyer.id,
          buyerName: buyer.name,
          leadId: lead.id,
          leadAddress: lead.address,
          leadOwnerName: lead.ownerName,
          matchScore: score,
          propertyType: lead.propertyType,
          marketLabel: market?.label ?? lead.marketId,
          offerAmount: lead.offerAmount,
          offerLabel: formatCurrency(lead.offerAmount),
        })
      }
    }
  }

  matches.sort((a, b) => b.matchScore - a.matchScore)

  const totalBudget = buyers.reduce((s, b) => s + b.budget, 0)
  const avgMatch = matches.length > 0
    ? Math.round(matches.reduce((s, m) => s + m.matchScore, 0) / matches.length)
    : 0

  return {
    buyers: buyers.sort((a, b) => b.matchScore - a.matchScore),
    matches: matches.slice(0, 10),
    activeBuyerCount: buyers.filter((b) => b.intent === 'active').length,
    totalBudget: formatCurrency(totalBudget),
    avgMatchScore: avgMatch,
  }
}

export const loadBuyer = async (): Promise<BuyerModel> => {
  const { loadCommandCenterStore } = await import('../../domain/normalize-command-center')
  const store = await loadCommandCenterStore()
  return adaptBuyerModel(store)
}
