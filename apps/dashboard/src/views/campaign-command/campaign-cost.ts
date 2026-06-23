import type { CampaignSummary } from './campaigns.types'

/** Blended per-segment SMS estimate — must match CreateCampaignModal constant. */
export const ESTIMATED_COST_PER_SMS_USD = Number(
  import.meta.env.VITE_SMS_ESTIMATED_COST_PER_SEGMENT ?? 0.0083,
)

export type CampaignCostMetrics = {
  available: boolean
  rateSource: string
  estimatedMessages: number
  totalSpend: number | null
  costPerReply: number | null
  costPerLead: number | null
  costPerDelivered: number | null
}

export function computeCampaignCostMetrics(campaign: CampaignSummary): CampaignCostMetrics {
  const rate = ESTIMATED_COST_PER_SMS_USD
  const hasRate = Number.isFinite(rate) && rate > 0
  const sent = campaign.sent_count
  const delivered = campaign.delivered_count
  const replies = campaign.reply_count || campaign.positive_reply_count + campaign.negative_reply_count

  if (!hasRate) {
    return {
      available: false,
      rateSource: 'unconfigured',
      estimatedMessages: sent,
      totalSpend: null,
      costPerReply: null,
      costPerLead: null,
      costPerDelivered: null,
    }
  }

  const totalSpend = sent > 0 ? sent * rate : null
  return {
    available: true,
    rateSource: 'VITE_SMS_ESTIMATED_COST_PER_SEGMENT',
    estimatedMessages: sent,
    totalSpend,
    costPerReply: totalSpend != null && replies > 0 ? totalSpend / replies : null,
    costPerLead:
      totalSpend != null && campaign.positive_reply_count > 0
        ? totalSpend / campaign.positive_reply_count
        : null,
    costPerDelivered:
      totalSpend != null && delivered > 0 ? totalSpend / delivered : null,
  }
}

export function formatCostUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Cost unavailable'
  if (value >= 100) return `$${Math.round(value).toLocaleString()}`
  return `$${value.toFixed(2)}`
}