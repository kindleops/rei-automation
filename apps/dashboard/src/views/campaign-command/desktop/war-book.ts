import type { LCRailStep } from '../../../shared/lc'
import type { CampaignIntel, BookCampaign } from './war-room-api'
import type { Mission } from './war-room-model'

/**
 * CAMPAIGN BOOK (R8.3) — the per-campaign instrument and the lifecycle rail.
 * Pure reads of figures the book / intel already carry; a figure the read did
 * not return is null and renders as "—", never as 0. Rates are only computed
 * over a real denominator (no rate over zero sends).
 */

export interface BookInstrument {
  /** sellers a message left us for */
  sent: number | null
  /** of those, carrier-confirmed delivered */
  delivered: number | null
  replied: number | null
  /** sellers who asked to stop */
  optOut: number | null
  /** targets held out of the cohort (suppression, DNC, no sender…) */
  held: number | null
  /** carrier-filtered messages — only the intel read carries it */
  filtered: number | null
  sentToday: number | null
  deliveryRate: number | null
  replyRate: number | null
  optOutRate: number | null
  /** the instrument's own read of health, from the rates above */
  health: 'ok' | 'attn' | 'crit' | 'neutral'
  healthWhy: string
}

const rate = (n: number | null, d: number | null) => (n === null || d === null || d <= 0 ? null : n / d)

export function instrumentOf(book: BookCampaign | null, intel: CampaignIntel | null = null): BookInstrument {
  const sent = intel?.sellers?.left_us ?? book?.sends?.sellers_dispatched ?? null
  const delivered = intel?.sellers?.delivered ?? book?.sends?.sellers_delivered ?? null
  const replied = intel?.replies?.sellers_replied ?? book?.replies?.sellers_replied ?? null
  const optOut = intel?.replies?.sellers_asked_to_stop ?? book?.replies?.sellers_asked_to_stop ?? null
  const held = book?.targets?.held ?? null
  const filtered = intel?.delivery ? intel.delivery.filtered : null
  const sentToday = book?.sends?.sent_today ?? null
  const deliveryRate = rate(delivered, sent)
  const replyRate = rate(replied, delivered ?? sent)
  const optOutRate = rate(optOut, delivered ?? sent)
  // Health is stated from the carrier + seller signal only, and only once
  // there is enough volume to mean something (25 sellers reached).
  let health: BookInstrument['health'] = 'neutral'
  let healthWhy = 'Not enough sends to judge'
  if (sent !== null && sent >= 25) {
    if ((deliveryRate !== null && deliveryRate < 0.7) || (optOutRate !== null && optOutRate > 0.05)) {
      health = 'crit'
      healthWhy = deliveryRate !== null && deliveryRate < 0.7 ? `Delivery ${pct(deliveryRate)} — below 70%` : `Opt-outs ${pct(optOutRate)} — above 5%`
    } else if ((deliveryRate !== null && deliveryRate < 0.85) || (optOutRate !== null && optOutRate > 0.02)) {
      health = 'attn'
      healthWhy = deliveryRate !== null && deliveryRate < 0.85 ? `Delivery ${pct(deliveryRate)} — below 85%` : `Opt-outs ${pct(optOutRate)} — above 2%`
    } else if (deliveryRate !== null) {
      health = 'ok'
      healthWhy = `Delivery ${pct(deliveryRate)}${optOutRate !== null ? ` · opt-outs ${pct(optOutRate)}` : ''}`
    }
  }
  return { sent, delivered, replied, optOut, held, filtered, sentToday, deliveryRate, replyRate, optOutRate, health, healthWhy }
}

export function pct(r: number | null, digits = 1): string {
  if (r === null || !Number.isFinite(r)) return '—'
  const v = r * 100
  return `${v >= 10 || digits === 0 ? Math.round(v) : v.toFixed(digits)}%`
}

/* ── lifecycle rail: Draft → Audience → Scheduled → Live → Complete ────── */

type Stage = 'draft' | 'audience' | 'scheduled' | 'live' | 'complete'
const ORDER: Stage[] = ['draft', 'audience', 'scheduled', 'live', 'complete']

function stageOf(status: string): Stage {
  const s = status.toLowerCase()
  if (['completed', 'complete', 'finished', 'archived'].includes(s)) return 'complete'
  if (['active', 'activating', 'live_limited', 'paused', 'running'].includes(s)) return 'live'
  if (['scheduled', 'queued'].includes(s)) return 'scheduled'
  if (['built', 'previewed', 'ready'].includes(s)) return 'audience'
  return 'draft'
}

export function lifecycleSteps(status: string | null | undefined, mission: Pick<Mission, 'key' | 'label' | 'tone'>, book: BookCampaign | null): LCRailStep[] {
  const s = String(status ?? '').toLowerCase()
  const at = stageOf(s)
  const idx = ORDER.indexOf(at)
  const sched = book?.schedule ?? null
  const paused = s === 'paused'
  const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : undefined)
  const label: Record<Stage, string> = { draft: 'Draft', audience: 'Audience built', scheduled: 'Scheduled', live: paused ? 'Paused' : 'Live', complete: s === 'archived' ? 'Archived' : 'Complete' }
  const sub: Partial<Record<Stage, string | undefined>> = {
    draft: date(book?.created_at),
    scheduled: date(sched?.scheduled_for ?? sched?.missed_for),
    live: paused ? date(sched?.paused_at) : date(sched?.resumed_at ?? sched?.activated_at),
    complete: date(sched?.completed_at ?? book?.completed_at),
  }
  return ORDER.map((st, i) => {
    let state: LCRailStep['state'] = i < idx ? 'done' : i === idx ? 'active' : 'idle'
    if (i === idx && st !== 'complete') state = mission.tone === 'crit' ? 'blocked' : mission.tone === 'attn' ? 'waiting' : 'active'
    if (i === idx && st === 'complete') state = 'done'
    return { id: st, label: label[st], sub: sub[st], state, note: i === idx && (state === 'blocked' || state === 'waiting') ? mission.label : undefined }
  })
}

/** The audience's markets as the coverage read takes them (largest first, at most 24). */
export function coverageMarkets(markets: Record<string, number> | null | undefined): Array<{ market: string; state: string | null; targets: number }> {
  return Object.entries(markets ?? {})
    .filter(([m, n]) => m && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([market, targets]) => {
      const st = market.split(',').pop()?.trim().toUpperCase() ?? ''
      return { market, state: /^[A-Z]{2}$/.test(st) ? st : null, targets }
    })
}
