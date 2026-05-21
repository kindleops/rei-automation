import type { LiveMarket } from '../live-dashboard.adapter'

export type DashboardMapMode =
  | 'leads'
  | 'heat'
  | 'pressure'
  | 'distress'
  | 'stage'
  | 'closings'
  | 'buyerDemand'
  | 'aiPriority'

export interface DashboardMapFilters {
  marketIds: string[]
  temperatures: Array<'hot' | 'warm' | 'neutral' | 'cold'>
  leadTemperatures: Array<'hot' | 'warm' | 'neutral' | 'cold'>
  priorities: Array<'P0' | 'P1' | 'P2' | 'P3'>
  sellerStages: string[]
  distressSignals: string[]
  campaignSources: string[]
  dateWindow: 'all' | '24h' | '7d' | '30d'
  agentIds: string[]
  propertyTypes: string[]
  followUpStatuses: string[]
  replyStatuses: string[]
  aiScoreMin: number
  aiScoreMax: number
  equityMin: number
  equityMax: number
  offerEligibility: 'all' | 'eligible' | 'ineligible'
  buyerDemandOverlap: 'all' | 'high' | 'medium' | 'low'
  contractStatuses: string[]
}

export interface ActiveMarketConfig {
  id: string
  name: string
  state: string
  lat: number
  lng: number
  activityScore: number
  leadCount: number
  replyRate: number
  hotLeadCount: number
  pipelineValue: number
  operationalStatus: LiveMarket['campaignStatus']
  activityIntensity: number
}
