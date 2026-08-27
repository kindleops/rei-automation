import { useEffect, useState } from 'react'
import { Icon } from '../../../shared/icons'
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

const TONE_LABEL: Record<Tone, string> = {
  running: 'RUNNING',
  scheduled: 'SCHEDULED',
  paused: 'PAUSED',
  test: 'TEST',
  draft: 'DRAFT',
  done: 'COMPLETE',
}

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

function paceOf(c: CampaignSummary): string {
  const interval = Number(c.send_interval_seconds || 0)
  return interval > 0 ? `${Math.max(1, Math.round(3600 / interval))}/hr` : '—'
}

function lastActivity(c: CampaignSummary): string {
  if (!c.last_send_at) return 'No sends yet'
  const t = new Date(c.last_send_at).getTime()
  if (!Number.isFinite(t)) return 'No sends yet'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 60) return `Last sent ${mins}m ago`
  if (mins < 1440) return `Last sent ${Math.round(mins / 60)}h ago`
  return `Last sent ${Math.round(mins / 1440)}d ago`
}

/**
 * ONE action line, derived from whatever is actually stopping the campaign.
 *
 * The old screen printed the nominal next step and the blocker as two separate
 * lines, so it read "Resume to send 343" directly above "No ready recipients in
 * target snapshot" — advice that cannot be followed, stacked on the reason it
 * cannot. When something blocks the nominal step, the blocker IS the next
 * action, restated as the thing to actually do.
 */
function nextAction(c: CampaignSummary, tone: Tone): { label: string; blocked: boolean } {
  const blockers = c.launch_blockers ?? []
  const blocker = c.launch_readiness === 'blocked' ? String(blockers[0] ?? '') : ''

  if (blocker) {
    const b = blocker.toLowerCase()
    if (b.includes('ready recipient') || b.includes('no eligible target')) {
      return { label: 'Build targets — none are ready to send', blocked: true }
    }
    if (b.includes('frozen target') || b.includes('build targets')) {
      return { label: 'Build targets to load this campaign', blocked: true }
    }
    if (b.includes('name')) return { label: 'Name the campaign to continue', blocked: true }
    if (b.includes('sender') || b.includes('route')) {
      return { label: 'No sender route — check routing before sending', blocked: true }
    }
    if (b.includes('persist')) return { label: 'Save the campaign to continue', blocked: true }
    return { label: blocker, blocked: true }
  }

  if (tone === 'running') {
    if (c.total_targets > 0 && c.ready_targets === 0) {
      return { label: 'Out of inventory — rebuild targets to continue', blocked: true }
    }
    if (c.sent_count === 0) return { label: 'Live but nothing sent yet — check routing', blocked: true }
    return { label: `Sending at ${paceOf(c)}`, blocked: false }
  }
  if (tone === 'scheduled') {
    const at = c.next_send_at ? new Date(c.next_send_at) : null
    if (at && Number.isFinite(at.getTime()) && at.getTime() > Date.now()) {
      const mins = Math.round((at.getTime() - Date.now()) / 60000)
      if (mins < 60) return { label: `Starts in ${mins} min`, blocked: false }
      if (mins < 1440) return { label: `Starts in ${Math.round(mins / 60)} hr`, blocked: false }
      return { label: `Starts ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, blocked: false }
    }
    return { label: 'Scheduled, awaiting its window', blocked: false }
  }
  if (tone === 'paused') {
    return c.ready_targets > 0
      ? { label: `Resume to send ${nf(c.ready_targets)}`, blocked: false }
      : { label: 'Build targets — nothing is ready to resume', blocked: true }
  }
  if (tone === 'test') {
    return c.ready_targets > 0
      ? { label: `${nf(c.ready_targets)} staged — no SMS will transmit`, blocked: false }
      : { label: 'Test mode — build targets to stage sends', blocked: false }
  }
  if (tone === 'done') return { label: 'Campaign finished', blocked: false }
  if (c.total_targets === 0) return { label: 'Build targets to start this campaign', blocked: false }
  return { label: `Schedule to send ${nf(c.ready_targets)}`, blocked: false }
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
    ? (mode === 'scoped_canary_only' ? 'CANARY ONLY' : 'SENDING STOPPED')
    : null
  const next = nextAction(campaign, tone)
  const total = campaign.total_targets
  const ready = campaign.ready_targets
  const consumed = total > 0 ? Math.max(0, Math.min(100, ((total - ready) / total) * 100)) : 0

  // Rates need a real denominator. Below 20 sends we show counts only rather
  // than a confident 0.0%.
  const rated = campaign.sent_count >= 20

  return (
    <div className="cdx">
      {/* A · Identity */}
      <header className="cdx__nav">
        <button type="button" className="cdx__back" onClick={onClose} aria-label="Back to campaigns">
          <Icon name="chevron-left" size={18} />
        </button>
        <h1 className="cdx__name">{campaign.campaign_name || 'Untitled campaign'}</h1>
      </header>

      {/* B · Placement and state */}
      <div className="cdx__place">
        <span className="cdx__place-main">
          <span className={campaign.market_label ? 'cdx__geo' : 'cdx__geo is-absent'}>
            {campaign.market_label || 'No market set'}
          </span>
          <em>· {nf(total)} targets</em>
          {campaign.auto_send_enabled && <span className="cdx__auto">AUTO</span>}
        </span>
        <span className={`cdx__state is-${tone}`}>
          {tone === 'running' && <i className="cdx__pulse" aria-hidden="true" />}
          {TONE_LABEL[tone]}
        </span>
      </div>

      {/* Posture line renders ONLY when it materially constrains this campaign. */}
      {(containment || tone === 'test') && (
        <div className="cdx__posture">
          {[containment, tone === 'test' ? 'NO SMS WILL TRANSMIT' : null]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}

      {/* C · Campaign instrument rail — same five readings as a Command row */}
      <section className="cdx__rail" aria-label="Campaign performance">
        <div className="cdx__rail-key">CAMPAIGN</div>
        <div className="cdx__metrics">
          <span className={`cdx__m is-lead${ready === 0 ? ' is-nil' : ''}`}>
            <strong>{compact(ready)}</strong><em>ready</em>
          </span>
          <span className={`cdx__m${campaign.sent_count === 0 ? ' is-nil' : ''}`}>
            <strong>{compact(campaign.sent_count)}</strong><em>sent</em>
          </span>
          <span className={`cdx__m is-pace${paceOf(campaign) === '—' ? ' is-nil' : ''}`}>
            <strong>{paceOf(campaign)}</strong><em>pace</em>
          </span>
          <span className={`cdx__m${campaign.reply_count === 0 ? ' is-nil' : ''}`}>
            <strong>{compact(campaign.reply_count)}</strong><em>replies</em>
          </span>
          <span className={`cdx__m${campaign.positive_reply_count > 0 ? ' is-good' : ' is-nil'}`}>
            <strong>{compact(campaign.positive_reply_count)}</strong><em>leads</em>
          </span>
        </div>
      </section>

      {/* D · Burn */}
      {total > 0 && (
        <div className="cdx__burn">
          <span className="cdx__burn-track" aria-hidden="true">
            <span className="cdx__burn-fill" style={{ width: `${consumed}%` }} />
          </span>
          <span className="cdx__burn-text">{nf(ready)} of {nf(total)} remaining</span>
        </div>
      )}

      {/* E · Delivery. Lifetime, and labelled so — the API exposes no
             per-campaign today figures, and inventing one is not an option. */}
      <section className="cdx__band" aria-label="Delivery">
        <div className="cdx__band-head">
          <span>DELIVERY</span>
          <em>lifetime · {lastActivity(campaign)}</em>
        </div>
        <div className="cdx__band-row">
          <span className={`cdx__m${campaign.sent_count === 0 ? ' is-nil' : ''}`}>
            <strong>{compact(campaign.sent_count)}</strong><em>sent</em>
          </span>
          <span className={`cdx__m${campaign.delivered_count === 0 ? ' is-nil' : ''}`}>
            <strong>{rated ? `${campaign.delivery_rate.toFixed(0)}%` : compact(campaign.delivered_count)}</strong>
            <em>{rated ? 'delivered' : 'delivered'}</em>
          </span>
          <span className={`cdx__m${campaign.failed_count === 0 ? ' is-nil' : ' is-bad'}`}>
            <strong>{compact(campaign.failed_count)}</strong><em>failed</em>
          </span>
          <span className={`cdx__m${campaign.opt_out_count === 0 ? ' is-nil' : ''}`}>
            <strong>{compact(campaign.opt_out_count)}</strong><em>opt-outs</em>
          </span>
        </div>
      </section>

      {/* F · One action line. When something blocks the nominal step, the
             blocker IS the next action. */}
      <section className={`cdx__next${next.blocked ? ' is-blocked' : ''}`} aria-label="Next action">
        <span className="cdx__next-key">NEXT</span>
        <span className="cdx__next-label">{next.label}</span>
      </section>
    </div>
  )
}
