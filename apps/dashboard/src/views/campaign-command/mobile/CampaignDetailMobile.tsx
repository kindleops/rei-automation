import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { CampaignHealthMobile } from './CampaignHealthMobile'
import {
  campaignContextLine,
  campaignProgress,
  compactNumber,
  describeCampaignStatus,
  formatRatePct,
  RATE_MIN_SAMPLE,
} from '../campaign-operator-language'
import { getQueueControlSettings } from '../../../lib/api/backendClient'
import type { CampaignSummary } from '../campaigns.types'
import { useCampaignResponses } from './useCampaignResponses'

/**
 * Campaign Detail — mobile.
 *
 * TWO PIECES, BECAUSE ONLY ONE OF THEM SHOULD STAY ON SCREEN.
 *
 * The whole header — name, status, health, progress, metrics and the section
 * trigger — used to live inside a sticky container. Measured at 390x844 the
 * section trigger sat at y≈517, so while the campaign stayed pinned, the
 * content it was supposed to introduce got the ~300px left between that and the
 * action dock. That is why the detail felt cramped and why rows slid under
 * things.
 *
 *   CampaignDetailBar   sticky: back, name, state. Always there, never large.
 *   CampaignDetailHero  scrolls: health, progress, outcomes. Read once, then
 *                       out of the way.
 */

const cls = (...t: Array<string | false | null | undefined>) => t.filter(Boolean).join(' ')
const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()

/**
 * Recency, or silence.
 *
 * `last_send_at` is null on campaigns that HAVE sent — this screen once
 * rendered "lifetime · No sends yet" directly above "9 sent · 9 delivered".
 * An absent timestamp means we do not know WHEN, not that it never happened.
 */
function lastActivity(c: CampaignSummary): string {
  if (!c.last_send_at) return c.sent_count > 0 ? '' : 'No messages sent yet'
  const t = new Date(c.last_send_at).getTime()
  if (!Number.isFinite(t)) return c.sent_count > 0 ? '' : 'No messages sent yet'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'Last message sent just now'
  if (mins < 60) return `Last message sent ${mins} min ago`
  if (mins < 1440) return `Last message sent ${Math.round(mins / 60)} hr ago`
  return `Last message sent ${Math.round(mins / 1440)} days ago`
}

/** Global send posture, only when it would actually hold THIS campaign. */
function useContainment(campaign: CampaignSummary): string | null {
  const [queueMode, setQueueMode] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    void getQueueControlSettings().then((res) => {
      if (dead || !res.ok) return
      const d = (res.data?.diagnostics ?? {}) as Record<string, unknown>
      setQueueMode(d.queue_execution_mode ? String(d.queue_execution_mode) : null)
    })
    return () => { dead = true }
  }, [])

  const status = String(campaign.status ?? '').toLowerCase()
  const wouldSend = ['active', 'activating', 'live_limited', 'scheduled', 'queued'].includes(status)
  const mode = String(queueMode ?? '').toLowerCase()
  if (!wouldSend || !mode || mode === 'normal') return null
  return mode === 'scoped_canary_only'
    ? 'Sending is limited to test traffic system-wide right now.'
    : 'Sending is stopped system-wide right now.'
}

export function CampaignDetailBar({
  campaign,
  onClose,
}: {
  campaign: CampaignSummary
  onClose: () => void
}) {
  const status = describeCampaignStatus(campaign)
  return (
    <header className="cdb2">
      <button type="button" className="cdb2__back" onClick={onClose} aria-label="Back to campaigns">
        <Icon name="chevron-left" size={20} />
      </button>
      <h1 className="cdb2__name">{campaign.campaign_name || 'Untitled campaign'}</h1>
      <span className={cls('cdb2__state', `is-${status.state}`)}>
        {status.isLive && <span className="cdb2__dot" aria-hidden="true" />}
        {status.label}
      </span>
    </header>
  )
}

export function CampaignDetailHero({ campaign }: { campaign: CampaignSummary }) {
  const containment = useContainment(campaign)
  const progress = campaignProgress(campaign)
  const context = [
    campaignContextLine(campaign),
    campaign.auto_send_enabled ? 'Auto-send on' : null,
  ].filter(Boolean).join(' · ')
  const recency = lastActivity(campaign)
  const sent = Number(campaign.sent_count ?? 0)
  const rated = sent >= RATE_MIN_SAMPLE

  /*
   * THE OUTCOMES, ONCE.
   *
   * Did it arrive, did they answer, did anyone ask us to stop.
   *
   * Replies used to read `reply_count`, and "Qualified" `positive_reply_count`
   * — both counted from target statuses no target has ever held, so every
   * campaign showed 0 and 0. Miami showed "0 replies" after 41 of the 350
   * sellers it messaged had texted back. Both now come from the message log
   * (/responses, shared with Overview and Replies). "Qualified" is gone: nothing
   * in the data says what qualified means, and a number nobody can check is
   * worse than no number.
   *
   * "Sent" is not repeated: the progress line directly above already says it.
   * "Failed" is not here either — it lives in Exceptions, with its reasons.
   */
  const responses = useCampaignResponses(campaign.id)
  const answer = (n: number | undefined) =>
    responses.data ? compactNumber(n ?? 0) : responses.loading ? '…' : '—'
  const reached = responses.data && progress
    ? {
        messaged: responses.data.sellers_messaged,
        pct: Math.max(0, Math.min(100, Math.round((responses.data.sellers_messaged / progress.total) * 100))),
      }
    : null
  const outcomes = sent > 0
    ? [
        {
          key: 'delivered',
          value: rated ? formatRatePct(campaign.delivery_rate) : compactNumber(campaign.delivered_count),
          label: 'Delivered',
        },
        { key: 'replied', value: answer(responses.data?.sellers_replied), label: 'Replied' },
        { key: 'stopped', value: answer(responses.data?.sellers_asked_to_stop), label: 'Asked to stop' },
      ]
    : []

  return (
    <div className="cdh">
      {context ? <p className="cdh__context">{context}</p> : null}

      <CampaignHealthMobile campaign={campaign} containment={containment} />

      {sent > 0 && progress ? (
        // Sellers reached, not messages sent: a follow-up is a second message
        // to the same seller, and "messages of sellers" can pass 100%. It also
        // has to agree with Replies' "41 of 350 sellers replied".
        <section className={cls('cdh__progress', !reached && 'is-loading')} aria-label="Progress">
          <div className="cdh__progress-line">
            <strong>{reached ? nf(reached.messaged) : responses.loading ? '…' : nf(progress.sent)}</strong>
            <em>
              {reached || responses.loading
                ? `of ${nf(progress.total)} sellers messaged`
                : `messages sent · ${nf(progress.total)} sellers`}
            </em>
            {reached && <b>{reached.pct}%</b>}
          </div>
          <div className="cdh__rail" aria-hidden="true">
            <span className="cdh__fill" style={{ width: `${reached ? reached.pct : 0}%` }} />
          </div>
        </section>
      ) : campaign.ready_targets > 0 ? (
        <section className="cdh__progress" aria-label="Audience">
          <div className="cdh__progress-line">
            <strong>{nf(campaign.ready_targets)}</strong>
            <em>{campaign.ready_targets === 1 ? 'seller' : 'sellers'} ready to message</em>
          </div>
        </section>
      ) : null}

      {outcomes.length > 0 && (
        <section className="cdh__outcomes" aria-label="Outcomes">
          {outcomes.map((o) => (
            <div key={o.key} className="cdh__outcome">
              <strong>{o.value}</strong>
              <span>{o.label}</span>
            </div>
          ))}
        </section>
      )}

      {recency ? <p className="cdh__recency">{recency}</p> : null}
    </div>
  )
}

export default CampaignDetailHero
