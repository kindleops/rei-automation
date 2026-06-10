export type AcquisitionRecordType =
  | 'owner'
  | 'property'
  | 'prospect'
  | 'phone'
  | 'email'
  | 'inbox_thread'
  | 'queue_item'
  | 'offer'
  | 'contract'

export interface AcquisitionKpi {
  id: string
  label: string
  value: string
  trend?: string
  tone?: 'neutral' | 'good' | 'warn' | 'critical'
}

export interface AcquisitionOwner {
  id: string
  ownerName: string
  ownerType: string
  market: string
  state: string
  portfolioCount: number
  estimatedPortfolioValue: number
  equityEstimate: number
  motivationScore: number
  contactProbability: number
  lastActivity: string
  nextAction: string
  status: string
  propertyIds: string[]
  prospectIds: string[]
  phoneIds: string[]
  emailIds: string[]
}

export interface AcquisitionProperty {
  id: string
  address: string
  market: string
  propertyType: string
  ownerId: string
  ownerName: string
  value: number
  equity: number
  distressTags: string[]
  occupancy: string
  taxFlag: boolean
  probateFlag: boolean
  foreclosureFlag: boolean
  aiScore: number
  offerStatus: string
  lastActivity: string
}

export interface AcquisitionProspect {
  id: string
  prospectName: string
  ownerId: string
  ownerName: string
  relationshipType: string
  market: string
  bestPhone: string
  bestEmail: string
  language: string
  contactProbability: number
  outreachStatus: string
  lastMessage: string
  nextAction: string
}

export interface AcquisitionPhone {
  id: string
  phoneNumber: string
  ownerId: string
  ownerName: string
  prospectId: string | null
  phoneType: string
  rank: number
  score: number
  smsStatus: string
  suppression: string
  lastContacted: string
  lastReply: string
}

export interface AcquisitionEmail {
  id: string
  email: string
  ownerId: string
  ownerName: string
  prospectId: string | null
  rank: number
  score: number
  linkageQuality: string
  verificationStatus: string
  lastContacted: string
}

export interface AcquisitionOffer {
  id: string
  propertyId: string
  propertyAddress: string
  ownerId: string
  ownerName: string
  strategy: string
  recommendedOffer: number
  sellerAskingPrice: number
  offerStatus: string
  confidence: number
  lastUpdated: string
  nextAction: string
}

export interface AcquisitionUnderwriting {
  id: string
  propertyId: string
  propertyAddress: string
  arv: number
  repairEstimate: number
  equity: number
  mao: number
  cashOffer: number
  creativeOffer: number
  novationPath: string
  multifamilyNoi: string
  rentEstimate: number
  aiValuationConfidence: number
  riskNotes: string
}

export interface AcquisitionAiBrain {
  id: string
  ownerId: string
  ownerName: string
  sellerIntent: string
  objections: string
  language: string
  sentiment: string
  conversationStage: string
  recommendedNextAction: string
  aiConfidence: number
  agentAssigned: string
  templateRecommendation: string
  negotiationPosture: string
  followUpTiming: string
}

export interface AcquisitionActivityItem {
  id: string
  title: string
  detail: string
  kind: string
  severity: 'info' | 'warning' | 'critical'
  timestamp: string
  recordType?: AcquisitionRecordType
  recordId?: string
}

export interface AcquisitionMapPoint {
  id: string
  marketName: string
  lng: number
  lat: number
  hotReplies: number
  failedSends: number
  highMotivation: number
  leadPulse: number
  ownerTypeMix: string
  distressCount: number
  equityBand: string
}

export interface AcquisitionAutomation {
  id: string
  name: string
  status: 'healthy' | 'watch' | 'critical'
  failedJobs: number
  lastRun: string
  detail: string
}

export interface AcquisitionRecordSummary {
  id: string
  title: string
  type: AcquisitionRecordType
  subtitle: string
  keyFields: Array<{ label: string; value: string }>
  linkedRecords: Array<{ id: string; label: string; type: AcquisitionRecordType }>
  recentActivity: string[]
  quickActions: string[]
}

export interface AcquisitionWorkspaceModel {
  workspaceName: string
  subtitle: string
  status: string
  marketOptions: string[]
  kpis: AcquisitionKpi[]
  owners: AcquisitionOwner[]
  properties: AcquisitionProperty[]
  prospects: AcquisitionProspect[]
  phones: AcquisitionPhone[]
  emails: AcquisitionEmail[]
  offers: AcquisitionOffer[]
  underwriting: AcquisitionUnderwriting[]
  aiBrain: AcquisitionAiBrain[]
  activity: AcquisitionActivityItem[]
  mapPoints: AcquisitionMapPoint[]
  automations: AcquisitionAutomation[]
}
