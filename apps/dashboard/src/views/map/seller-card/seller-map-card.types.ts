import type { PropertyDossierContract } from './seller-property-dossier-contract'

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

export type SellerMapCardBadge = {
  key: string
  label: string
  tone: 'stage' | 'status' | 'score' | 'asset' | 'units'
}

export type FollowUpEligibilityView = {
  visible: boolean
  canExecute: boolean
  label: string
  disabledReason: string | null
  isUncontacted: boolean
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

  property: {
    address: string
    imageUrl: string | null
    assetType: string
    assetClassKey: string
    units: number | null
  }

  operations: {
    stage: string
    status: string
    stageLabel: string
    statusLabel: string
  }

  headerBadges: SellerMapCardBadge[]
  assetSummaryLine: string
  peekMetrics: SellerMapCardMetric[]
  weightedSignals: SellerMapCardFlag[]
  operationalState: string | null

  dossier: PropertyDossierContract | null
  dossierReady: boolean

  followUpEligibility: FollowUpEligibilityView
  actionBar: SellerMapCardActionBar

  edgeAccent: 'default' | 'hot' | 'reply' | 'due' | 'suppressed' | 'failed'
  messagingBlocked: boolean
  messagingBlockReason: string | null

  masterOwner: {
    id: string | null
    displayName: string
    priorityScore: number | null
  }
}