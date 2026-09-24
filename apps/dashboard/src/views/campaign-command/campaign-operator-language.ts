/**
 * OPERATOR LANGUAGE.
 *
 * One place that turns canonical campaign state into words an operator can act
 * on. It exists because the mobile surface was leaking implementation vocabulary
 * straight to the screen — "Test mode — build targets to stage sends",
 * "Dynamic cohort", "Planned", "No SMS transmits" — which describes our data
 * model rather than their campaign.
 *
 * Two rules:
 *
 *   NOTHING IS INVENTED. Every string here is derived from a field that already
 *   exists on CampaignSummary. Where a fact is unavailable the answer is to say
 *   less, never to guess: a fabricated "94% healthy" is worse than no number.
 *
 *   SEVERITY IS NOT VOLUME. A campaign that content-filtered 200 messages and
 *   recovered 196 of them is healthy; one with four dead sender routes and no
 *   fallback is not. Health is derived from operator impact, not from a raw
 *   failure count.
 */
import type { CampaignSummary } from './campaigns.types'
import { computeCampaignHealth } from './campaign-health'

export type OperatorState =
  | 'live'
  | 'scheduled'
  | 'paused'
  | 'draft'
  | 'completed'
  | 'blocked'
  | 'attention'
  | 'test'

export type OperatorStatus = {
  state: OperatorState
  /** Short label for a badge. Sentence case — this is a product, not a terminal. */
  label: string
  /** One line the operator can act on. Empty when there is genuinely nothing to say. */
  detail: string
  /** True only while messages can actually leave. Drives the live dot. */
  isLive: boolean
  /** True when a human has to do something. Drives attention ordering. */
  needsOperator: boolean
}

const LIVE_STATUSES = ['active', 'activating', 'live_limited']
const SCHEDULED_STATUSES = ['scheduled', 'queued']
const TERMINAL_STATUSES = ['completed', 'archived']

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase()

/**
 * The first launch blocker, in operator words.
 *
 * Blocker codes are canonical and must stay canonical — they are how the launch
 * path refuses. They are simply not how a person is told why.
 */
const BLOCKER_COPY: Record<string, string> = {
  no_ready_recipients: 'No sellers are ready to receive messages yet.',
  no_ready_recipients_in_target_snapshot: 'No sellers are ready to receive messages yet.',
  no_eligible_sender: 'No sender numbers are available.',
  no_eligible_sender_numbers: 'No sender numbers are available.',
  no_targets: 'This campaign has no audience yet.',
  no_target_definition: 'This campaign has no audience yet.',
  quarantined: 'This campaign is on hold for a targeting problem.',
  // The quarantine guard's code: the built audience holds sellers outside the
  // explicit selection it was built from.
  target_integrity_violation: 'Its audience reaches beyond the properties that were selected.',
  emergency_stop: 'Sending is stopped system-wide.',
  no_template: 'No approved message is ready for this audience.',
  no_template_after_fallback: 'No approved message is ready for this audience.',
}

export function describeBlocker(code?: string | null, fallback?: string | null): string {
  const key = lower(code).replace(/[\s-]+/g, '_')
  if (key && BLOCKER_COPY[key]) return BLOCKER_COPY[key]
  const text = String(fallback ?? '').trim()
  // A canonical code that reached the screen unmapped is worse than a generic
  // sentence: it teaches the operator our enum names.
  if (!text || /^[a-z0-9_]+$/.test(text)) return 'Setup needs attention before this can launch.'
  return text
}

/**
 * The campaign's state, said plainly.
 *
 * Order matters and is deliberate:
 *   quarantine  outranks everything — it is the only UNSAFE state here
 *   test        outranks live, because "nothing will transmit" is the most
 *               important fact about a campaign that has it
 *   terminal    before live, so an archived campaign never reads as running
 */
export function describeCampaignStatus(campaign: CampaignSummary): OperatorStatus {
  const status = lower(campaign.status)

  if (campaign.quarantined) {
    return {
      state: 'blocked',
      label: 'On hold',
      detail: describeBlocker(campaign.quarantine_reason, campaign.quarantine_reason),
      isLive: false,
      needsOperator: true,
    }
  }

  /*
   * TEST MODE IS AN ATTRIBUTE, NOT ALWAYS THE HEADLINE.
   *
   * `operator_state` reads 'test_mode' on campaigns whose lifecycle status is
   * 'paused' — Miami is paused, in test mode, and has sent 354. Letting test
   * mode win outright rendered "Test mode · No messages will be sent to
   * sellers" directly above "354 of 802 sent", which reads as a contradiction
   * and hides the fact that actually governs the campaign: it is paused.
   *
   * So: paused and terminal states keep their headline and carry test mode in
   * the detail. The copy is forward-looking ("new messages won't reach
   * sellers") because a blanket "no messages will be sent" is falsified by the
   * campaign's own history.
   */
  const inTestMode = campaign.operator_state === 'test_mode'
  if (inTestMode && status !== 'paused' && !TERMINAL_STATUSES.includes(status)) {
    return {
      state: 'test',
      label: 'Test',
      detail: 'Test mode is on. New messages won’t reach sellers.',
      isLive: false,
      needsOperator: false,
    }
  }

  if (TERMINAL_STATUSES.includes(status)) {
    return { state: 'completed', label: 'Completed', detail: '', isLive: false, needsOperator: false }
  }

  if (status === 'paused') {
    return {
      state: 'paused',
      label: 'Paused',
      detail: inTestMode
        ? 'No new messages are being sent. Test mode is on.'
        : 'No new messages are being sent.',
      isLive: false,
      needsOperator: false,
    }
  }

  if (SCHEDULED_STATUSES.includes(status)) {
    return {
      state: 'scheduled',
      label: 'Scheduled',
      detail: campaign.next_send_at ? `Begins ${formatWhen(campaign.next_send_at)}.` : '',
      isLive: false,
      needsOperator: false,
    }
  }

  if (LIVE_STATUSES.includes(status)) {
    const health = computeCampaignHealth(campaign)
    if (health.level === 'dangerous') {
      return {
        state: 'attention',
        label: 'Needs attention',
        detail: health.issues[0] ?? 'Sending is degraded.',
        isLive: true,
        needsOperator: true,
      }
    }
    if (campaign.ready_targets === 0) {
      return {
        state: 'attention',
        label: 'Needs attention',
        detail: 'No sellers are ready to receive messages.',
        isLive: true,
        needsOperator: true,
      }
    }
    return {
      state: 'live',
      label: 'Live',
      detail: 'Sending normally.',
      isLive: true,
      needsOperator: false,
    }
  }

  // Everything else is pre-launch. `built` and `previewed` are real progress and
  // must not collapse into "Draft", which claims no work has happened.
  if (status === 'failed') {
    return {
      state: 'attention',
      label: 'Needs attention',
      detail: 'The last launch attempt did not complete.',
      isLive: false,
      needsOperator: true,
    }
  }

  const hasAudience = campaign.total_targets > 0 || Boolean(campaign.has_target_definition)
  return {
    state: 'draft',
    label: status === 'built' || status === 'previewed' || status === 'ready' ? 'Ready' : 'Draft',
    detail: hasAudience ? 'Ready to schedule.' : 'Finish setup to start this campaign.',
    isLive: false,
    needsOperator: false,
  }
}

/** "tomorrow at 9:00 AM" / "today at 2:15 PM" / a date when further out. */
export function formatWhen(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'soon'
  const now = new Date()
  const time = then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameDay = then.toDateString() === now.toDateString()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (sameDay) return `today at ${time}`
  if (then.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`
  return `${then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`
}

/**
 * Progress, only when it means something.
 *
 * A campaign with no audience has no denominator, and rendering "0 of 0 · 0%"
 * is a progress bar that describes nothing. Returning null lets the card omit
 * the whole treatment rather than show an empty rail.
 */
export function campaignProgress(campaign: CampaignSummary): { sent: number; total: number; pct: number } | null {
  const total = Number(campaign.total_targets ?? 0)
  const sent = Number(campaign.sent_count ?? 0)
  if (total <= 0) return null
  const pct = Math.max(0, Math.min(100, Math.round((sent / total) * 100)))
  return { sent, total, pct }
}

export type CampaignMetric = { key: string; value: string; label: string }

/**
 * At most three metrics, and only ones that carry information.
 *
 * The previous row rendered five — ready / sent / pace / replies / leads — at
 * identical weight, four of which were usually zero. Five equal numbers is not
 * density, it is noise: it costs the operator a scan and answers nothing.
 *
 * A rate is only shown once there is a sample to compute it from; a percentage
 * of nine sends is decoration.
 */
export const RATE_MIN_SAMPLE = 20

export function campaignMetrics(campaign: CampaignSummary): CampaignMetric[] {
  const out: CampaignMetric[] = []
  const sent = Number(campaign.sent_count ?? 0)

  if (sent >= RATE_MIN_SAMPLE && Number.isFinite(campaign.delivery_rate)) {
    out.push({ key: 'delivery', value: formatRatePct(campaign.delivery_rate), label: 'Delivered' })
  } else if (sent > 0) {
    out.push({ key: 'delivered', value: compactNumber(campaign.delivered_count ?? 0), label: 'Delivered' })
  }

  if ((campaign.reply_count ?? 0) > 0) {
    out.push({ key: 'replies', value: compactNumber(campaign.reply_count), label: 'Replies' })
  }
  if ((campaign.positive_reply_count ?? 0) > 0) {
    out.push({ key: 'qualified', value: compactNumber(campaign.positive_reply_count), label: 'Qualified' })
  }

  // Pre-launch, the only number that matters is how many people it would reach.
  if (out.length === 0 && campaign.ready_targets > 0) {
    out.push({ key: 'ready', value: compactNumber(campaign.ready_targets), label: 'Ready to send' })
  }

  return out.slice(0, 3)
}

/**
 * A campaign rate, as the API sends it: ALREADY A PERCENTAGE (0-100).
 *
 * This file shipped `delivery_rate * 100`, which rendered Miami's 99.2 as
 * "9920% Delivered" on its index card. The contract is the same one the Inbox
 * KPIs rely on (`delivery_rate.toFixed(1) + '%'`, compared `> 95`). One helper,
 * so the scale is decided in exactly one place.
 */
export function formatRatePct(ratePct: number | null | undefined): string {
  // Checked BEFORE Number(): Number(null) is 0, which would turn "not measured"
  // into a confident "0%" — a fabricated metric, not a missing one.
  if (ratePct === null || ratePct === undefined) return '—'
  const v = Number(ratePct)
  if (!Number.isFinite(v)) return '—'
  const clamped = Math.max(0, Math.min(100, v))
  // 99.2 → "99%", but 99.6 must not round up to a perfect score it hasn't earned.
  if (clamped > 99 && clamped < 100) return '99%'
  return `${Math.round(clamped)}%`
}

export function compactNumber(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return '0'
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return v.toLocaleString()
}

/** Quiet supporting line. Market is real metadata or it is absent — never guessed. */
export function campaignContextLine(campaign: CampaignSummary): string {
  const bits: string[] = []
  if (campaign.market_label) bits.push(campaign.market_label)
  const total = Number(campaign.total_targets ?? 0)
  if (total > 0) bits.push(`${compactNumber(total)} ${total === 1 ? 'seller' : 'sellers'}`)
  return bits.join(' · ')
}
