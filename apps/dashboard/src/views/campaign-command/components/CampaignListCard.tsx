import { cls, fmt, fmtPct, resolveNextSend } from '../campaign-formatters'
import type { CampaignSummary } from '../campaigns.types'

/**
 * Campaign list card — mobile.
 *
 * Replaces the flat row where every campaign carried identical visual weight and
 * the metrics read as a log line ("348 tgt 339 ready 0 sent Not Started").
 *
 * The screen has to answer four questions in about three seconds:
 *   what is running · what has inventory · what is stalled · what needs me
 *
 * So the card is built around ONE dominant number (READY inventory — the thing
 * that decides whether a campaign can do anything at all), a state rail that is
 * readable peripherally, and at most one attention signal. Everything else is
 * deliberately quiet. A draft with no targets should visually recede; a live
 * campaign burning through inventory should not.
 */

type LifecycleTone = 'running' | 'paused' | 'scheduled' | 'draft' | 'test' | 'done'

function lifecycle(campaign: CampaignSummary): { tone: LifecycleTone; label: string } {
  const status = String(campaign.status ?? '').toLowerCase()
  if (campaign.operator_state === 'test_mode') return { tone: 'test', label: 'TEST' }
  if (status === 'active' || status === 'activating' || status === 'live_limited') {
    return { tone: 'running', label: 'RUNNING' }
  }
  if (status === 'paused') return { tone: 'paused', label: 'PAUSED' }
  if (status === 'scheduled' || status === 'queued') return { tone: 'scheduled', label: 'SCHEDULED' }
  if (status === 'completed') return { tone: 'done', label: 'COMPLETE' }
  if (status === 'archived') return { tone: 'done', label: 'ARCHIVED' }
  return { tone: 'draft', label: 'DRAFT' }
}

/**
 * At most ONE attention signal per card. Ranked by what would actually change the
 * operator's next action — a campaign that cannot send at all outranks a soft
 * delivery wobble.
 */
function attention(campaign: CampaignSummary): { text: string; tone: 'crit' | 'warn' } | null {
  const status = String(campaign.status ?? '').toLowerCase()
  const live = status === 'active' || status === 'activating' || status === 'live_limited'

  if (campaign.launch_readiness === 'blocked') {
    const first = campaign.launch_blockers?.[0]
    return { text: first ? String(first) : 'Launch blocked', tone: 'crit' }
  }
  if (live && campaign.ready_targets === 0 && campaign.total_targets > 0) {
    return { text: 'Out of ready inventory', tone: 'crit' }
  }
  if (campaign.opt_out_rate > 5) return { text: `${fmtPct(campaign.opt_out_rate)} opt-out`, tone: 'crit' }
  if (live && campaign.sent_count === 0) return { text: 'Live but nothing sent', tone: 'warn' }
  if (campaign.failed_count > 0 && campaign.sent_count > 0) {
    const rate = (campaign.failed_count / campaign.sent_count) * 100
    if (rate > 5) return { text: `${fmtPct(rate)} failing`, tone: 'warn' }
  }
  return null
}


/**
 * State-aware footer. Each lifecycle answers the question that actually matters
 * for it, using only data we have — no invented pacing or projections.
 *
 *   RUNNING   -> observed send velocity, else next send
 *   SCHEDULED -> when it starts
 *   PAUSED    -> paused, plus whether automation would resume it
 *   DRAFT     -> whether it is set up enough to do anything
 *   TEST      -> named as test so it is never mistaken for live
 */
function footLabel(campaign: CampaignSummary, tone: LifecycleTone, fallback: string): string {
  if (tone === 'running') {
    if (campaign.sent_count > 0) {
      const interval = Number(campaign.send_interval_seconds || 0)
      // Interval is configured pacing, not a forecast: state it as configured.
      if (interval > 0) return `~${Math.max(1, Math.round(3600 / interval))}/hr pacing`
      return `${fmt(campaign.sent_count)} sent`
    }
    return fallback
  }
  if (tone === 'scheduled') return fallback
  if (tone === 'paused') {
    return campaign.auto_send_enabled ? 'Paused · auto would resume' : 'Paused'
  }
  if (tone === 'draft') {
    if (campaign.total_targets === 0) return 'No targets built'
    if (campaign.ready_targets === 0) return 'Targets built · none ready'
    return 'Ready to schedule'
  }
  if (tone === 'test') return campaign.sent_count > 0 ? 'Test · sent' : 'Test mode'
  return fallback
}

export const CampaignListCard = ({
  campaign,
  selected = false,
  onSelect,
}: {
  campaign: CampaignSummary
  selected?: boolean
  onSelect: () => void
}) => {
  const state = lifecycle(campaign)
  const flag = attention(campaign)
  const next = resolveNextSend(campaign)
  const ready = campaign.ready_targets
  const total = campaign.total_targets
  // Inventory burn-down. Only meaningful once a campaign actually has targets —
  // an empty draft gets no bar rather than a misleading 0%.
  const consumed = total > 0 ? Math.max(0, Math.min(100, ((total - ready) / total) * 100)) : null
  const isDormant = state.tone === 'draft' && total === 0

  return (
    <button
      type="button"
      className={cls('clc', `clc--${state.tone}`, selected && 'is-selected', isDormant && 'is-dormant')}
      onClick={onSelect}
      aria-label={`${campaign.campaign_name}, ${state.label}, ${fmt(ready)} ready`}
    >
      <span className="clc__rail" aria-hidden="true" />

      <span className="clc__body">
        <span className="clc__head">
          <span className="clc__name">{campaign.campaign_name || 'Untitled campaign'}</span>
          <span className="clc__state">{state.label}</span>
        </span>

        {/* One dominant number. Ready inventory decides whether this campaign can
            do anything at all, so it gets the weight and everything else defers. */}
        <span className="clc__metrics">
          <span className="clc__ready">
            <strong>{fmt(ready)}</strong>
            <em>ready</em>
          </span>
          {campaign.sent_count > 0 && (
            <span className="clc__metric">
              <strong>{fmt(campaign.sent_count)}</strong>
              <em>sent</em>
            </span>
          )}
          {campaign.positive_reply_count > 0 && (
            <span className="clc__metric is-good">
              <strong>{fmt(campaign.positive_reply_count)}</strong>
              <em>leads</em>
            </span>
          )}
          {campaign.reply_count > 0 && campaign.positive_reply_count === 0 && (
            <span className="clc__metric">
              <strong>{fmt(campaign.reply_count)}</strong>
              <em>replies</em>
            </span>
          )}
        </span>

        {consumed !== null && (
          <span className="clc__burn" aria-hidden="true">
            <span className="clc__burn-fill" style={{ width: `${consumed}%` }} />
          </span>
        )}

        <span className="clc__foot">
          <span className={cls('clc__next', `is-${next.tone}`)}>{footLabel(campaign, state.tone, next.label)}</span>
          {campaign.auto_send_enabled && <span className="clc__auto">AUTO</span>}
          {flag && <span className={cls('clc__flag', `is-${flag.tone}`)}>{flag.text}</span>}
        </span>
      </span>
    </button>
  )
}
