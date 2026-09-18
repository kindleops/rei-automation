
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

/**
 * §42/§58 — THE DEMO BUYER UNIVERSE IS GONE.
 *
 * `adaptBuyerModel` and `loadBuyer` read a `CommandCenterStore`, and the only
 * thing that ever produced one was `referenceCommandCenterData`: 1,175 lines of
 * hardcoded buyers, properties and markets with synthetic `minutesAgo()`
 * activity and a match score the page computed for itself in a loop.
 *
 * `/buyer-match` stopped using it when BuyerMatchSubjectPage landed, and the
 * note left behind said the dataset stayed "because other reference surfaces
 * import" it. Nothing did: the whole chain was `loadBuyer` -> normalize ->
 * dataset, `loadBuyer` had no callers, and the two views that consumed it
 * (BuyerMatchView, BuyerIntelPage) were unreachable and imported only types.
 * All of it is deleted rather than left one import away from a production
 * screen.
 *
 * The types below stay: they describe a buyer, which is still a real thing.
 */
