import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
import { CampaignHealthMobile } from './CampaignHealthMobile'
import { campaignContextLine, campaignProgress } from '../campaign-operator-language'
import { getQueueControlSettings } from '../../../lib/api/backendClient'
import type { CampaignSummary } from '../campaigns.types'

/**
 * Campaign Detail — mobile, 393pt.
 *
 * Zones A–F of the approved IA, in the frozen Command grammar: one gutter,
 * hairline-separated bands, no nested cards, no vanity number. The section
 * switcher and tab content below are unchanged and stay authoritative for
 * detail; this replaces the old header + mission-hero + test-banner stack.
 *
 * Every figure here is CAMPAIGN-scoped and labelled as such, so it can never be
 * read as the 112,695 global inventory shown on Command.
 */

type Tone = 'running' | 'scheduled' | 'paused' | 'test' | 'draft' | 'done'

function toneOf(c: CampaignSummary): Tone {
  const s = String(c.status ?? '').toLowerCase()
  if (c.operator_state === 'test_mode') return 'test'
  if (s === 'active' || s === 'activating' || s === 'live_limited') return 'running'
  if (s === 'scheduled' || s === 'queued') return 'scheduled'
  if (s === 'paused') return 'paused'
  if (s === 'completed' || s === 'archived') return 'done'
  return 'draft'
}

const nf = (n: number | null | undefined) => Number(n ?? 0).toLocaleString()

function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * Recency, or silence.
 *
 * `last_send_at` is null on campaigns that HAVE sent — this screen rendered
 * "lifetime · No sends yet" directly above "9 sent · 9 delivered". Absent
 * timestamp means we do not know WHEN, not that it never happened, so the
 * honest answer when sends exist is to say nothing about recency at all.
 */
function lastActivity(c: CampaignSummary): string {
  if (!c.last_send_at) return c.sent_count > 0 ? '' : 'No sends yet'
  const t = new Date(c.last_send_at).getTime()
  if (!Number.isFinite(t)) return c.sent_count > 0 ? '' : 'No sends yet'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 60) return `Last sent ${mins}m ago`
  if (mins < 1440) return `Last sent ${Math.round(mins / 60)}h ago`
  return `Last sent ${Math.round(mins / 1440)}d ago`
}

export function CampaignDetailMobile({
  campaign,
  onClose,
}: {
  campaign: CampaignSummary
  onClose: () => void
}) {
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

  const tone = toneOf(campaign)

  // Containment is surfaced only when it materially constrains THIS campaign —
  // i.e. the campaign would otherwise be sending. On a draft or a finished
  // campaign the global posture is wallpaper, not a constraint.
  const wouldSend = tone === 'running' || tone === 'scheduled'
  const mode = String(queueMode ?? '').toLowerCase()
  const containment = wouldSend && mode && mode !== 'normal'
    ? (mode === 'scoped_canary_only' ? 'Sending is limited to canary traffic.' : 'Sending is stopped system-wide.')
    : null
  const ready = campaign.ready_targets

  // Rates need a real denominator. Below 20 sends we show counts only rather
  // than a confident 0.0%.
  const rated = campaign.sent_count >= 20
  const progress = campaignProgress(campaign)
  const recency = lastActivity(campaign)
  const context = campaignContextLine(campaign)

  /*
   * The hero readings, in the order an operator asks for them: how many people,
   * did it arrive, did they answer, is any of it worth money. Zero-valued cells
   * are dropped rather than rendered grey — a column of zeros is how the old
   * rail taught people to stop reading it.
   */
  const heroMetrics: Array<{ key: string; value: string; label: string }> = []
  if (campaign.sent_count > 0) {
    heroMetrics.push({ key: 'sent', value: compact(campaign.sent_count), label: 'Sent' })
    heroMetrics.push({
      key: 'delivered',
      value: rated ? `${campaign.delivery_rate.toFixed(0)}%` : compact(campaign.delivered_count),
      label: rated ? 'Delivered' : 'Delivered',
    })
  } else if (ready > 0) {
    heroMetrics.push({ key: 'ready', value: compact(ready), label: 'Ready to send' })
  }
  if (campaign.reply_count > 0) heroMetrics.push({ key: 'replies', value: compact(campaign.reply_count), label: 'Replies' })
  if (campaign.positive_reply_count > 0) heroMetrics.push({ key: 'qualified', value: compact(campaign.positive_reply_count), label: 'Qualified' })
  if (campaign.failed_count > 0 && heroMetrics.length < 4) {
    heroMetrics.push({ key: 'failed', value: compact(campaign.failed_count), label: 'Failed' })
  }

  return (
    <div className="cdx">
      {/* A · Identity */}
      <header className="cdx__nav">
        <button type="button" className="cdx__back" onClick={onClose} aria-label="Back to campaigns">
          <Icon name="chevron-left" size={18} />
        </button>
        <h1 className="cdx__name">{campaign.campaign_name || 'Untitled campaign'}</h1>
      </header>

      {/* B · Placement.
             The state badge that used to sit here is gone: the health block
             immediately below states the same thing in words, and an all-caps
             "TEST" beside "Test mode — no messages will be sent" is the screen
             saying one fact twice. Market and audience are omitted entirely
             when absent rather than rendered as "No market set · 0 targets",
             which is our schema talking, not the campaign's situation. */}
      {context && (
        <div className="cdx__place">
          <span className="cdx__place-main">{context}</span>
          {campaign.auto_send_enabled && <span className="cdx__auto">Auto</span>}
        </div>
      )}

      {/* One status object, not four competing restatements of it. */}
      <CampaignHealthMobile campaign={campaign} containment={containment} />

      {/* Progress owns the hero once there is an audience to measure against.
          A campaign with no targets has no denominator, so it gets no rail
          rather than an empty one reading "0 of 0". */}
      {progress && (
        <section className="cdx__progress" aria-label="Progress">
          <div className="cdx__progress-line">
            <strong>{nf(progress.sent)}</strong>
            <em>of {nf(progress.total)} sent</em>
            <b>{progress.pct}%</b>
          </div>
          <div className="cdx__progress-rail" aria-hidden="true">
            <span className="cdx__progress-fill" style={{ width: `${progress.pct}%` }} />
          </div>
        </section>
      )}

      {/* At most four readings, and only ones that carry information. This was
          two separate rails of five and four — nine numbers, most of them zero,
          with `sent` appearing in both. */}
      {heroMetrics.length > 0 && (
        <section className="cdx__hero" aria-label="Delivery">
          {heroMetrics.map((m) => (
            <div key={m.key} className="cdx__hero-cell">
              <strong>{m.value}</strong>
              <em>{m.label}</em>
            </div>
          ))}
        </section>
      )}

      {recency && <p className="cdx__recency">{recency}</p>}

    </div>
  )
}
