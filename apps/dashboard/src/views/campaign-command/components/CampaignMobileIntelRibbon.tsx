import { computeCampaignHealth, computeCampaignReadiness } from '../campaign-health'
import type { CampaignSummary } from '../campaigns.types'
import { cls, fmt, fmtPct, fmtRelative } from '../campaign-formatters'

interface CampaignMobileIntelRibbonProps {
  campaign: CampaignSummary
}

export function CampaignMobileIntelRibbon({ campaign }: CampaignMobileIntelRibbonProps) {
  const health = computeCampaignHealth(campaign)
  const readiness = computeCampaignReadiness(campaign)
  const queueRows = campaign.queued_targets + campaign.scheduled_targets
  const isPreLaunch = campaign.sent_count === 0

  const tiles = isPreLaunch
    ? [
        { label: 'Readiness', value: readiness.label, tone: readiness.level },
        { label: 'Ready', value: fmt(campaign.ready_targets), tone: 'accent' },
        { label: 'Queue', value: fmt(queueRows), tone: '' },
        { label: 'Next', value: fmtRelative(campaign.next_send_at), tone: '' },
      ]
    : [
        {
          label: 'Health',
          value: health.score != null ? String(health.score) : health.label,
          tone: health.level,
        },
        { label: 'Delivery', value: fmtPct(campaign.delivery_rate), tone: 'good' },
        { label: 'Reply', value: fmtPct(campaign.reply_rate), tone: 'accent' },
        { label: 'Leads', value: fmt(campaign.positive_reply_count), tone: 'good' },
      ]

  return (
    <div className="ccc-mobile-intel">
      {tiles.map((tile) => (
        <div key={tile.label} className={cls('ccc-mobile-intel__tile', tile.tone && `is-${tile.tone}`)}>
          <span className="ccc-mobile-intel__label">{tile.label}</span>
          <strong className="ccc-mobile-intel__value">{tile.value}</strong>
        </div>
      ))}
    </div>
  )
}