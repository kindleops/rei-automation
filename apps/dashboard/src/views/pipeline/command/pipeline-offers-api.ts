/**
 * PIPELINE OFFERS — client for GET /api/cockpit/pipeline/command/offers.
 *
 * Read-only. Per deal: the Decision Engine's recommendation, any seller_offers
 * row, the negotiation's authorization and the canonical spendability verdict
 * (valuation-offer-authority). Nothing reachable from here can authorize, send
 * or accept an offer — validation is a handoff to Deal Intelligence.
 */
import { callBackend } from '../../../lib/api/backendClient'
import type { PipelineCommandCard, PipelineCommandParams } from '../../../domain/pipeline/pipeline-command-api'

export type OfferReadinessState = 'authorized' | 'needs_validation' | 'not_priced'

export type PipelineOfferRow = {
  card: PipelineCommandCard
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
  offer: {
    price: number | null
    status: string | null
    binding: boolean
    version: number | null
    direction: string | null
    createdAt: string | null
    sentAt: string | null
    acceptedAt: string | null
    acceptedPrice: number | null
  } | null
  offersCount: number
  authorization: { presentable: boolean | null; withheldReason: string | null; zone: string | null } | null
  readiness: {
    state: OfferReadinessState
    spendable: boolean
    source: 'engine_row' | 'negotiation' | null
    reason: string | null
    reasons: string[]
    tier: string | null
    tierLabel: string | null
    compCount: number | null
    thinCoverage: boolean
    gates: Array<{ key: string; label: string; pass: boolean }>
  }
  askImplausible: boolean
  counterImplausible: boolean
}

export type PipelineOffersMarket = {
  market: string
  deals: number
  priced: number
  needsValidation: number
  authorized: number
  medianComps: number | null
  thinCoverage: boolean | null
}

export type PipelineOffers = {
  scope: string
  generatedAt: string
  capped: boolean
  totals: {
    deals: number
    atOfferStage: number
    priced: number
    withEngineOffer: number
    engineOfferValue: number | null
    authorized: number
    needsValidation: number
    notPriced: number
    thinCoverage: number
    sent: number
    countered: number
    accepted: number
    offerRecords: number
  }
  thresholds: { compCoverageMin: number }
  markets: PipelineOffersMarket[]
  rows: PipelineOfferRow[]
  truncated: boolean
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out.set(k, String(v))
  return out.toString()
}

export async function fetchPipelineOffers(params: PipelineCommandParams, signal?: AbortSignal): Promise<PipelineOffers> {
  const res = await callBackend<{ ok: boolean; data: PipelineOffers; message?: string }>(`/api/cockpit/pipeline/command/offers?${qs(params)}`, { signal })
  if (!res.ok) {
    const upstream = (res as { upstream?: { error?: string } }).upstream
    throw new Error(upstream?.error || res.message || res.error || 'pipeline_offers_failed')
  }
  if (!res.data?.data) throw new Error('pipeline_offers_empty')
  return res.data.data
}

/**
 * The operator checkpoint as the UI states it. The server's `spendable` is the
 * canonical automation verdict; engine gates are reported for context only
 * (a range offer legitimately fails the HARD-offer gates), so they are listed
 * separately and never counted as a validation reason here.
 */
export function validationReasons(row: PipelineOfferRow): string[] {
  return row.readiness.reasons.filter((r) => !/^Gate not met:/i.test(r))
}
