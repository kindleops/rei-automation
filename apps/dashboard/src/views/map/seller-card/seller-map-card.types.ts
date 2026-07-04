export type SellerMapCardMode = 'peek' | 'focus' | 'conversation'

export type SellerMapCardFlag = {
  key: string
  label: string
  severity: 'high' | 'medium' | 'low'
}

export type SellerMapCardMetric = {
  label: string
  value: string
  emphasis?: 'default' | 'primary' | 'accent'
}

export type SellerMapCardIntelligenceField = {
  label: string
  value: string
}

export type FollowUpEligibilityView = {
  visible: boolean
  canExecute: boolean
  label: string
  disabledReason: string | null
  isUncontacted: boolean
}

export type SellerMapCardActivityKind =
  | 'last_reply'
  | 'last_contacted'
  | 'delivery_failed'
  | 'suppressed'
  | 'none'

export type SellerMapCardField = {
  label: string
  value: string
}

export type SellerMapCardViewModel = {
  propertyId: string
  threadKey: string | null

  prospect: {
    id: string | null
    displayName: string
    firstName: string | null
    phone: string | null
    differsFromOwner: boolean
  }

  masterOwner: {
    id: string | null
    displayName: string
    mailingAddress: string | null
    yearsOwned: number | null
    absentee: boolean | null
    outOfState: boolean | null
    freeAndClear: boolean | null
    portfolioCount: number | null
    contactability: string
    suppressed: boolean
    dnc: boolean
    priorityScore: number | null
    priorityClassification: string | null
    prioritySignals: string[]
  }

  property: {
    address: string
    imageUrl: string | null
    assetType: string
    assetClassKey: string
    subtype: string | null
    units: number | null
    beds: number | null
    baths: number | null
    sqft: number | null
    lotSqft: number | null
    acreage: number | null
    yearBuilt: number | null
    effectiveYearBuilt: number | null
    constructionType: string | null
    condition: string | null
    stories: number | null
    zoning: string | null
    landUse: string | null
    roadAccess: string | null
    avgSqftPerUnit: number | null
    avgBedsPerUnit: number | null
    avgBathsPerUnit: number | null
    occupancyCode: string | null
  }

  financials: {
    estimatedValue: number | null
    estimatedEquity: number | null
    equityPercent: number | null
    repairs: number | null
    mortgageBalance: number | null
    loanCount: number | null
    loanType: string | null
    assessedLandValue: number | null
    assessedImprovementValue: number | null
    assessedTotalValue: number | null
    annualTaxes: number | null
    lastSaleAmount: number | null
    lastSaleDate: string | null
    pricePerSqft: number | null
    pricePerUnit: number | null
    valuePerAcre: number | null
  }

  operations: {
    stage: string
    stageLabel: string
    status: string
    statusLabel: string
    temperature: string
    temperatureLabel: string
    followUpEligible: boolean
    followUpDueAt: string | null
    nextActionAt: string | null
    campaignName: string | null
    automationState: string
    suppressionReason: string | null
  }

  conversation: {
    lastInboundText: string | null
    lastInboundAt: string | null
    lastOutboundText: string | null
    lastOutboundAt: string | null
    deliveryStatus: string | null
  }

  flags: SellerMapCardFlag[]
  assetSummaryLine: string
  contextualLine: string | null
  peekMetrics: SellerMapCardMetric[]
  focusMetrics: SellerMapCardMetric[]
  peekDossierFields: SellerMapCardField[]
  intelligenceStrip: SellerMapCardIntelligenceField[]
  followUpEligibility: FollowUpEligibilityView
  focusProfileFields: SellerMapCardField[]
  focusFinancialFields: SellerMapCardField[]
  focusProspectFields: SellerMapCardField[]
  focusOwnerFields: SellerMapCardField[]
  focusOperationFields: SellerMapCardField[]

  activity: {
    kind: SellerMapCardActivityKind
    headline: string
    detail: string | null
    timestamp: string | null
  }

  edgeAccent: 'default' | 'hot' | 'reply' | 'due' | 'suppressed' | 'failed'
  messagingBlocked: boolean
  messagingBlockReason: string | null
}