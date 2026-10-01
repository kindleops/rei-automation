/**
 * PIPELINE DESK — typed reads for the desktop Pipeline.
 *
 * Read-only. The server owns every judgement (stage, owner, hold class,
 * offer autonomy, movement); these types only describe what it returns.
 * The overview, feed and deal story come from the shared Pipeline command
 * client; the period flow and the offers read are desktop-only.
 */
import { callBackend } from '../../../lib/api/backendClient'
import type {
  PipelineCommandCard,
  PipelineCommandOverview,
  PipelineCommandParams,
  PipelineLane,
  PipelineMovement,
  PipelineStageSummary,
} from '../../../domain/pipeline/pipeline-command-api'

export type OwnerKey = 'autopilot' | 'scheduled' | 'seller' | 'external' | 'needs_you' | 'blocked' | 'dormant' | 'closed_out' | 'complete'
export type HoldClass = 'safety' | 'authority' | 'context' | 'classifier' | 'sweep' | 'review_draft' | 'unanswered' | 'send_failure' | 'contact' | 'blocker' | 'review'

export type DeskLane = PipelineLane & { evidence?: string; cause?: string; at?: string }

export type DeskQueueStep = {
  status: string
  at: string | null
  useCase: string | null
  kind: 'reply' | 'follow_up'
  by: 'system' | 'human'
  future: boolean
}

export type DeskCard = Omit<PipelineCommandCard, 'lane' | 'money'> & {
  lane: DeskLane
  money: PipelineCommandCard['money'] & { askImplausible?: boolean; counterImplausible?: boolean }
  owner: OwnerKey
  hold: HoldClass | null
  intent_next: { action: string; due: string | null; source: string | null } | null
  queue: { next: DeskQueueStep | null; held: { at: string | null; useCase: string | null; by: 'system' | 'human' } | null } | null
}

export type StageOwners = Record<'autopilot' | 'scheduled' | 'seller' | 'external' | 'needs_you' | 'blocked' | 'dormant' | 'complete', number>
export type StageAging = { median: number | null; max: number | null; overClock: number; clockDays: number | null; buckets: { fresh: number; aging: number; over: number } }
export type DeskStage = PipelineStageSummary & { owners?: StageOwners; aging?: StageAging; asking?: number | null; valued?: number }

export type DeskOverview = Omit<PipelineCommandOverview, 'stages' | 'attentionTop'> & {
  stages: DeskStage[]
  attentionTop: DeskCard[]
  ownership?: StageOwners
  excluded?: { synthetic: number }
  totals: PipelineCommandOverview['totals'] & { machine?: number; needsYou?: number; blocked?: number }
}

export type FlowPeriod = '24h' | '7d' | '30d'

export type DeskMove = PipelineMovement & {
  by?: 'system' | 'human' | 'seller'
  actor?: string | null
  intent?: string | null
  left?: boolean
  status?: string
}

export type StageFlow = { code: string; index: number; entered: number; left: number; advanced: number; regressed: number; created: number; exited: number; system: number; human: number }

export type DeskFlow = {
  scope: string
  period: FlowPeriod
  since: string
  generatedAt: string
  capped: boolean
  excluded: { synthetic: number }
  totals: { moved: number; events: number; advanced: number; regressed: number; created: number; exited: number; nurtured: number; priced: number; replies: number; bySystem: number; byHuman: number }
  stages: StageFlow[]
  series: { hourly: boolean; buckets: Array<{ key: string; moves: number; replies: number }> }
  movement: DeskMove[]
  inFlight: Array<DeskQueueStep & { opportunityId: string; address: string | null; seller: string | null; stage: string; stageIndex: number | null }>
  held: Array<{ opportunityId: string; address: string | null; seller: string | null; stage: string; stageIndex: number | null; at: string | null; useCase: string | null; by: 'system' | 'human' }>
}

export type AutonomyState = 'autonomous' | 'resolving' | 'exception' | 'parked'

export type DeskOfferRow = {
  card: DeskCard
  autonomy: {
    state: AutonomyState
    cause: string
    label: string
    why: string
    reprices: 'next_seller_reply' | 'operator' | 'none'
    zone: string | null
    valuationAgeDays: number | null
    stale: boolean
    implausible: boolean
  } | null
  plausibility: { engineValueOff: boolean; recommendedOff: boolean }
  negotiation: { zone: string | null; strategy: string | null; nextAction: string | null; reviewReason: string | null; updatedAt: string | null } | null
  engine: {
    tier: string | null
    tierLabel: string | null
    strategy: string | null
    confidence: number | null
    valuationConfidence: number | null
    compCount: number | null
    compStatus: string | null
    low: number | null
    mid: number | null
    high: number | null
    recommended: number | null
    floor: number | null
    assignmentFee: number | null
    computedAt: string | null
  } | null
  offer: { price: number | null; status: string | null; binding: boolean; version: number | null; direction: string | null; createdAt: string | null; sentAt: string | null; acceptedAt: string | null; acceptedPrice: number | null } | null
  offersCount: number
  readiness: { state: 'authorized' | 'needs_validation' | 'not_priced'; spendable: boolean; reason: string | null; reasons: string[]; tier: string | null; tierLabel: string | null; compCount: number | null; thinCoverage: boolean; persistedIgnored: string | null }
  askImplausible: boolean
  counterImplausible: boolean
}

export type DeskOffers = {
  scope: string
  generatedAt: string
  capped: boolean
  excluded?: { synthetic: number }
  totals: { deals: number; atOfferStage: number; priced: number; withEngineOffer: number; authorized: number; needsValidation: number; notPriced: number; thinCoverage: number; sent: number; countered: number; accepted: number; offerRecords: number; persistedVerdictsIgnored?: number }
  autonomy: Record<AutonomyState, number>
  thresholds: { compCoverageMin: number; highValueReview?: number; valuationStaleDays?: number }
  markets: Array<{ market: string; deals: number; priced: number; needsValidation: number; authorized: number; medianComps: number | null; thinCoverage: boolean | null }>
  rows: DeskOfferRow[]
  truncated: boolean
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out.set(k, String(v))
  return out.toString()
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await callBackend<{ ok: boolean; data: T; message?: string }>(path, { signal })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.message || res.error || 'pipeline_desk_failed')
  }
  if (!res.data?.data) throw new Error('pipeline_desk_empty')
  return res.data.data
}

export const fetchDeskFlow = (params: PipelineCommandParams & { period: FlowPeriod }, signal?: AbortSignal) =>
  get<DeskFlow>(`/api/cockpit/pipeline/command/flow?${qs(params)}`, signal)

export const fetchDeskOffers = (params: PipelineCommandParams, signal?: AbortSignal) =>
  get<DeskOffers>(`/api/cockpit/pipeline/command/offers?${qs(params)}`, signal)
