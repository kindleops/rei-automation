/**
 * CAMPAIGN CARD — mobile.
 *
 * Answers three questions in under two seconds: which campaign, what state,
 * how far along. Everything else is one tap away.
 *
 * What it replaces: a row carrying five equal-weight statistics
 * (ready / sent / pace / replies / leads), four of which were usually zero, a
 * raw target-mode token ("DYNAMIC COHORT"), and a lifecycle enum shouted in
 * caps. It read as a table row in a terminal, and a horizontal rule between
 * every card made the list denser still.
 *
 * The single most useful signal for a running campaign is how much of its
 * audience it has reached, so that gets the progress treatment and the large
 * numeral. Rates are withheld until there is a sample to compute them from —
 * "100% delivered" off nine sends is decoration, not information.
 */
import type { CampaignSummary } from '../campaigns.types'
import {
  campaignContextLine,
  campaignMetrics,
  campaignProgress,
  compactNumber,
  describeCampaignStatus,
  type OperatorState,
} from '../campaign-operator-language'

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')

type Props = {
  campaign: CampaignSummary
  onOpen: (campaign: CampaignSummary) => void
  onMenu?: (campaign: CampaignSummary) => void
}

/** States that earn a coloured dot. Draft and completed are quiet on purpose. */
const TONED: OperatorState[] = ['live', 'attention', 'blocked', 'paused', 'scheduled', 'test']

export function CampaignCardMobile({ campaign, onOpen, onMenu }: Props) {
  const status = describeCampaignStatus(campaign)
  const progress = campaignProgress(campaign)
  const metrics = campaignMetrics(campaign)
  const context = campaignContextLine(campaign)

  return (
    <div className={cls('cmc', `is-${status.state}`, status.needsOperator && 'is-attention')}>
      <button
        type="button"
        className="cmc__hit"
        onClick={() => onOpen(campaign)}
        aria-label={`${campaign.campaign_name || 'Untitled campaign'} — ${status.label}`}
      >
        <span className="cmc__head">
          <span className="cmc__name">{campaign.campaign_name || 'Untitled campaign'}</span>
          <span className={cls('cmc__state', `is-${status.state}`)}>
            {TONED.includes(status.state) && (
              <span className={cls('cmc__dot', status.state === 'live' && 'is-pulsing')} aria-hidden="true" />
            )}
            {status.label}
          </span>
        </span>

        {/* Progress owns the card when there is an audience to measure against. */}
        {progress && progress.sent > 0 ? (
          <span className="cmc__progress">
            <span className="cmc__progress-line">
              <strong>{compactNumber(progress.sent)}</strong>
              <em>of {compactNumber(progress.total)} sent</em>
              <b>{progress.pct}%</b>
            </span>
            <span className="cmc__rail" aria-hidden="true">
              <span className="cmc__fill" style={{ width: `${progress.pct}%` }} />
            </span>
          </span>
        ) : null}

        {/*
          The status line is the only place a problem is stated, and it is stated
          once. A campaign that needs a person says so here; a healthy one says
          the quiet thing and gets out of the way.
        */}
        {status.detail ? (
          <span className={cls('cmc__detail', status.needsOperator && 'is-attention')}>{status.detail}</span>
        ) : null}

        {metrics.length > 0 && (
          <span className="cmc__metrics">
            {metrics.map((m) => (
              <span key={m.key} className="cmc__metric">
                <strong>{m.value}</strong>
                <em>{m.label}</em>
              </span>
            ))}
          </span>
        )}

        {context ? <span className="cmc__context">{context}</span> : null}
      </button>

      {onMenu && (
        <button
          type="button"
          className="cmc__menu"
          aria-label={`Actions for ${campaign.campaign_name || 'campaign'}`}
          onClick={(e) => { e.stopPropagation(); onMenu(campaign) }}
        >
          <span aria-hidden="true">···</span>
        </button>
      )}
    </div>
  )
}

export default CampaignCardMobile
