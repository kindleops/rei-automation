export type SellerMapCardMode = 'peek' | 'focus' | 'conversation'

export type SellerMapCardFlag = {
  key: string
  label: string
  severity: 'high' | 'medium' | 'low'
  tier?: 'critical' | 'motivation' | 'positive' | 'context' | 'neutral'
  tooltip?: string
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

export type SellerMapCardFinancialMeter = {
  key: string
  label: string
  percent: number
  caption: string | null
}

export type SellerMapCardOwnerPressure = {
  score: number | null
  tier: string | null
  label: string
  drivers: Array<{ label: string; impact: 'positive' | 'negative' }>
  confidence: string
  summary: string | null
}

export type SellerMapCardProspectProfile = {
  resolvedName: string | null
  relationshipConfidence: string
  smsEligible: boolean | null
  hasPhone: boolean
  hasEmail: boolean
  contactScore: number | null
  phoneScore: number | null
  language: string | null
  meterPercent: number
  meterLabel: string
  badges: Array<{ key: string; label: string; tone: 'ready' | 'warn' | 'neutral' }>
  emptyState: string | null
  fields: Array<{ label: string; value: string }>
}

export type SellerMapCardPropertyProfileGroup = {
  key: string
  label: string
  fields: Array<{ label: string; value: string }>
}

export type SellerMapCardActionBar = {
  primary: {
    label: string
    action: 'ownership_check' | 'follow_up' | 'reply' | 'disabled'
    enabled: boolean
    disabledReason: string | null
  }
  secondary: {
    label: string
    action: 'message' | 'open_thread' | 'none'
    enabled: boolean
  }
}

export type SellerMapCardViewModel = {
  propertyId: string
  threadKey: string | null
  headerDisplayName: string
  canonicalPhone: string | null

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
  weightedTags: SellerMapCardFlag[]
  assetSummaryLine: string
  contextualLine: string | null
  peekMetrics: SellerMapCardMetric[]
  focusMetrics: SellerMapCardMetric[]
  intelligenceStrip: SellerMapCardIntelligenceField[]
  followUpEligibility: FollowUpEligibilityView
  actionBar: SellerMapCardActionBar
  financialProfile: {
    fields: Array<{ label: string; value: string }>
    meters: SellerMapCardFinancialMeter[]
    pressureCaption: string | null
  }
  ownerPressure: SellerMapCardOwnerPressure
  prospectProfile: SellerMapCardProspectProfile
  propertyProfileGroups: SellerMapCardPropertyProfileGroup[]
  focusProfileFields: Array<{ label: string; value: string }>
  focusFinancialFields: Array<{ label: string; value: string }>
  focusOwnerFields: Array<{ label: string; value: string }>
  focusOperationFields: Array<{ label: string; value: string }>
  contactStateLabel: string
  activeCommunication: boolean

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