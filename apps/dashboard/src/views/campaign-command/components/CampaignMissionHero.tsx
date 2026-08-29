import { cls, fmt, fmtPct, resolveNextSend } from '../campaign-formatters'
import type { CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — mission-control hero.
 *
 * The first viewport has to answer six questions without scrolling:
 *   what state · how much READY remains · is it sending · at what pace ·
 *   what happens next · are replies/delivery healthy
 *
 * So READY is the dominant number and everything else is a compact execution
 * strip beneath it. The hero is explicitly NOT a spreadsheet — the canonical
 * funnel and the Overview/Execution/Targets/Queue/Replies/Failures tabs live
 * below and stay authoritative for detail.
 *
 * Every figure is measured. Pacing is stated as CONFIGURED pacing where that is
 * what we actually know, never presented as an observed rate.
 */

type Tone = 'running' | 'paused' | 'scheduled' | 'draft' | 'test' | 'done'

function toneOf(c: CampaignSummary): { tone: Tone; label: string } {
  const s = String(c.status ?? '').toLowerCase()
  if (c.operator_state === 'test_mode') return { tone: 'test', label: 'TEST MODE' }
  if (s === 'active' || s === 'activating' || s === 'live_limited') return { tone: 'running', label: 'RUNNING' }
  if (s === 'paused') return { tone: 'paused', label: 'PAUSED' }
  if (s === 'scheduled' || s === 'queued') return { tone: 'scheduled', label: 'SCHEDULED' }
  if (s === 'completed') return { tone: 'done', label: 'COMPLETE' }
  if (s === 'archived') return { tone: 'done', label: 'ARCHIVED' }
  return { tone: 'draft', label: 'DRAFT' }
}

/**
 * The state row above already declares PAUSED / DRAFT / COMPLETE, so this line
 * must answer "what happens next" rather than echo it — the header previously
 * read "PAUSED · AUTO · Paused".
 *
 * resolveNextSend stays the shared authority for the countdown itself; this only
 * replaces the labels that would restate the state badge verbatim, and only in
 * the hero.
 */
function nextAction(
  campaign: CampaignSummary,
  tone: Tone,
  next: ReturnType<typeof resolveNextSend>,
): { label: string; tone: string } {
  if (tone === 'paused') {
    return campaign.ready_targets > 0
      ? { label: `Resume to send ${fmt(campaign.ready_targets)} ready`, tone: 'pending' }
      : { label: 'Nothing ready to resume', tone: 'neutral' }
  }
  if (tone === 'test') {
    return campaign.ready_targets > 0
      ? { label: `${fmt(campaign.ready_targets)} ready · no SMS will send`, tone: 'neutral' }
      : { label: 'Test mode · nothing queued', tone: 'neutral' }
  }
  if (tone === 'draft') {
    if (campaign.total_targets === 0) return { label: 'Build targets to continue', tone: 'neutral' }
    if (campaign.ready_targets === 0) return { label: 'Targets built · none ready', tone: 'neutral' }
    return { label: `Schedule to send ${fmt(campaign.ready_targets)} ready`, tone: 'pending' }
  }
  // Running / scheduled / complete keep the resolved countdown, which is already
  // state-aware and never renders a past-due countdown for a campaign that
  // cannot act.
  return next
}

export const CampaignMissionHero = ({ campaign }: { campaign: CampaignSummary }) => {
  const state = toneOf(campaign)
  const next = nextAction(campaign, state.tone, resolveNextSend(campaign))
  const ready = campaign.ready_targets
  const total = campaign.total_targets
  const consumed = total > 0 ? Math.max(0, Math.min(100, ((total - ready) / total) * 100)) : 0
  const interval = Number(campaign.send_interval_seconds || 0)
  const perHour = interval > 0 ? Math.max(1, Math.round(3600 / interval)) : null

  // Delivery/reply only become meaningful with a real denominator. Below that,
  // say so rather than rendering a confident 0.0%.
  const hasDeliverySignal = campaign.sent_count >= 20
  const hasReplySignal = campaign.delivered_count >= 20

  return (
    <div className={cls('cmh', `cmh--${state.tone}`)}>
      <div className="cmh__top">
        <span className="cmh__state">
          {state.tone === 'running' && <i className="cmh__pip" />}
          {state.label}
        </span>
        {campaign.auto_send_enabled ? (
          <span className="cmh__mode is-auto">AUTO</span>
        ) : (
          <span className="cmh__mode">MANUAL</span>
        )}
      </div>

      <div className="cmh__hero">
        <div className="cmh__hero-value">{fmt(ready)}</div>
        <div className="cmh__hero-meta">
          <span className="cmh__hero-label">ready remaining</span>
          <span className="cmh__hero-sub">of {fmt(total)} targets</span>
        </div>
      </div>

      {total > 0 && (
        <div className="cmh__burn" aria-hidden="true">
          <div className="cmh__burn-fill" style={{ width: `${consumed}%` }} />
        </div>
      )}

      {/* Live execution strip — four slots, uneven by design. */}
      <div className="cmh__strip">
        <div className="cmh__cell">
          <span className="cmh__cell-value">{fmt(campaign.sent_count)}</span>
          <span className="cmh__cell-label">sent</span>
        </div>
        <div className="cmh__cell">
          <span className="cmh__cell-value">{perHour ? `${perHour}/hr` : '—'}</span>
          <span className="cmh__cell-label">{perHour ? 'pacing' : 'no pacing'}</span>
        </div>
        <div className="cmh__cell">
          <span className={cls('cmh__cell-value', hasDeliverySignal && campaign.delivery_rate < 90 && 'is-warn')}>
            {hasDeliverySignal ? fmtPct(campaign.delivery_rate) : '—'}
          </span>
          <span className="cmh__cell-label">delivered</span>
        </div>
        <div className="cmh__cell">
          <span className={cls('cmh__cell-value', campaign.positive_reply_count > 0 && 'is-good')}>
            {hasReplySignal ? fmtPct(campaign.reply_rate) : fmt(campaign.reply_count)}
          </span>
          <span className="cmh__cell-label">{hasReplySignal ? 'reply rate' : 'replies'}</span>
        </div>
      </div>

      <div className="cmh__next">
        <span className={cls('cmh__next-label', `is-${next.tone}`)}>{next.label}</span>
        {campaign.launch_readiness === 'blocked' && campaign.launch_blockers?.[0] && (
          <span className="cmh__blocker">{String(campaign.launch_blockers[0])}</span>
        )}
      </div>
    </div>
  )
}
