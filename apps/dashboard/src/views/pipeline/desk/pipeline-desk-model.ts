/**
 * PIPELINE DESK — pure view model.
 *
 * Geometry and vocabulary only: the river's shape from counts the server
 * gave, the ownership words, the age buckets, the activity mapping. Nothing
 * here decides a stage, an owner, a hold or an offer state — those arrive on
 * the payload and are drawn as they are.
 */
import type { IconName } from '../../../shared/icons'
import type { LCActivityEvent, LCTone } from '../../../shared/lc'
import type { AutonomyState, DeskCard, DeskMove, DeskOfferRow, DeskStage, FlowPeriod, HoldClass, OwnerKey, StageFlow } from './pipeline-desk-api'

/* ── vocabulary ────────────────────────────────────────────────────────── */

export type LiveOwner = 'autopilot' | 'scheduled' | 'seller' | 'external' | 'needs_you' | 'blocked'
export const LIVE_OWNERS: readonly LiveOwner[] = ['autopilot', 'scheduled', 'seller', 'external', 'needs_you', 'blocked']

/** One semantic tone per owner: the machine is cyan/cobalt, waiting is calm, attention amber, failure red. */
export const OWNER_META: Record<OwnerKey, { label: string; short: string; tone: LCTone; color: string; definition: string; human: boolean }> = {
  autopilot: { label: 'Autopilot', short: 'Autopilot', tone: 'exec', color: 'var(--pd2-own-autopilot)', definition: 'The machine is acting now — a reply in flight, or held by send gates.', human: false },
  scheduled: { label: 'Next action scheduled', short: 'Scheduled', tone: 'exec', color: 'var(--pd2-own-scheduled)', definition: 'The machine owns a future-dated step: a real queue row with a send time.', human: false },
  seller: { label: 'Waiting on seller', short: 'Seller', tone: 'neutral', color: 'var(--pd2-own-seller)', definition: 'We spoke last. The seller owes the next move.', human: false },
  external: { label: 'External', short: 'External', tone: 'flow', color: 'var(--pd2-own-external)', definition: 'S6–S9: contract, buyer or title holds the next step.', human: false },
  needs_you: { label: 'Needs you', short: 'Needs you', tone: 'attn', color: 'var(--pd2-own-needs)', definition: 'A human decision is required by policy: a review hold, a draft held for review, or an unanswered reply.', human: true },
  blocked: { label: 'Blocked', short: 'Blocked', tone: 'crit', color: 'var(--pd2-own-blocked)', definition: 'The machine tried and failed (never queued, health guard, transport), or cannot reach the seller.', human: true },
  dormant: { label: 'Dormant', short: 'Dormant', tone: 'neutral', color: 'var(--pd2-own-dormant)', definition: 'Active on paper, untouched 30+ days, nothing queued. Inventory the machine is not working.', human: false },
  closed_out: { label: 'Closed out', short: 'Closed out', tone: 'neutral', color: 'var(--pd2-own-dormant)', definition: 'Dead, suppressed or closed-lost.', human: false },
  complete: { label: 'Closed', short: 'Closed', tone: 'ok', color: 'var(--pd2-own-complete)', definition: 'Closing recorded through the Closing Desk.', human: false },
}

/** What kind of rule holds a deal — a fact about the rule, never a verdict on it. */
export const HOLD_META: Record<HoldClass, { label: string; tone: LCTone; rule: string }> = {
  safety: { label: 'Safety hold', tone: 'attn', rule: 'Hostile or legal language — policy forbids an automated reply.' },
  authority: { label: 'Authority to sell', tone: 'attn', rule: 'The respondent may not be the owner (heir, executor, agent) — authority must be confirmed.' },
  context: { label: 'Missing context', tone: 'attn', rule: 'The reply could not be tied to a property or thread with confidence.' },
  classifier: { label: 'Classifier unsure', tone: 'attn', rule: 'The reply was classified below the confidence the autopilot needs to answer.' },
  sweep: { label: 'Recovery-sweep flag', tone: 'attn', rule: 'The gap-recovery sweep found no recorded next step and flagged the deal for review.' },
  review_draft: { label: 'Draft held for review', tone: 'attn', rule: 'A message was drafted and is paused in the queue until someone approves or discards it.' },
  unanswered: { label: 'Reply not handled', tone: 'attn', rule: 'The seller replied and the autopilot scheduled nothing.' },
  review: { label: 'Review requested', tone: 'attn', rule: 'The autopilot asked for a human review.' },
  send_failure: { label: 'Send failed', tone: 'crit', rule: 'The autopilot decided to send, and the message never reached the seller.' },
  contact: { label: 'Contact blocked', tone: 'crit', rule: 'Suppressed, opted out or no sendable contact — the machine cannot reach the seller.' },
  blocker: { label: 'Blocker', tone: 'crit', rule: 'An explicit blocker is recorded on the deal.' },
}

export const AUTONOMY_META: Record<AutonomyState, { label: string; tone: LCTone; definition: string }> = {
  autonomous: { label: 'Autonomous', tone: 'exec', definition: 'The engine may present the number itself: an offer tier with a contamination defense, and the machine holds the conversation.' },
  resolving: { label: 'System resolving', tone: 'flow', definition: 'Not spendable yet, and the engine resolves it without you: still qualifying, or negotiating a large gap without a number.' },
  exception: { label: 'Exception', tone: 'attn', definition: 'Only a human resolves it: an implausible number, a stuck conversation, a high-value gap, or an offer step the engine can’t price.' },
  parked: { label: 'Not being worked', tone: 'neutral', definition: 'No live conversation, and nothing re-prices the offer — there is no scheduled rescoring.' },
}

/** The card's own reason, never a repeat of its lane's name. */
export function autonomyCause(row: DeskOfferRow): string {
  const a = row.autonomy
  if (!a) return ''
  switch (a.cause) {
    case 'authorized': return row.readiness.tierLabel || 'Offer tier · spendable'
    case 'qualifying': return 'Still qualifying'
    case 'large_gap': return 'Large gap · negotiating'
    case 'conversation_held': return row.card.lane.label
    default: return a.label
  }
}

/** "$158–169K" when both ends share a unit; "$950K–1.2M" otherwise. */
export function moneyRange(lo: number | null | undefined, hi: number | null | undefined): string | null {
  const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
  if (!ok(hi)) return null
  if (!ok(lo) || lo >= hi) return compactMoneyLocal(hi)
  const unit = (v: number) => (v >= 1e6 ? 'M' : v >= 1e3 ? 'K' : '')
  const scaled = (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) : v >= 1e3 ? String(Math.round(v / 1e3)) : String(Math.round(v)))
  return unit(lo) === unit(hi) ? `$${scaled(lo)}–${scaled(hi)}${unit(hi)}` : `${compactMoneyLocal(lo)}–${compactMoneyLocal(hi)?.slice(1)}`
}
function compactMoneyLocal(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

export const REPRICES_TEXT: Record<'next_seller_reply' | 'operator' | 'none', string> = {
  next_seller_reply: 'Re-prices on the next seller reply',
  operator: 'Re-prices only when someone acts',
  none: 'Nothing re-prices it',
}

export const PERIODS: ReadonlyArray<{ value: FlowPeriod; label: string; long: string }> = [
  { value: '24h', label: '24H', long: 'last 24 hours' },
  { value: '7d', label: '7D', long: 'last 7 days' },
  { value: '30d', label: '30D', long: 'last 30 days' },
]

/** Canonical S1–S10 order (codes are the server's). */
export const STAGE_CODES = [
  'ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer',
  'formal_contract', 'disposition', 'under_contract', 'prepared_to_close', 'closed',
] as const
export const STAGE_SHORT_LABEL: Record<string, string> = {
  ownership_confirmation: 'Ownership', offer_interest: 'Interest', asking_price: 'Asking', property_condition: 'Condition',
  offer: 'Offer', formal_contract: 'Contract', disposition: 'Dispo', under_contract: 'Buyer contract',
  prepared_to_close: 'Escrow', closed: 'Closed',
}
export const STAGE_GROUPS: ReadonlyArray<{ key: string; label: string; from: number; to: number }> = [
  { key: 'discovery', label: 'Discovery', from: 1, to: 2 },
  { key: 'qualification', label: 'Qualify', from: 3, to: 4 },
  { key: 'negotiation', label: 'Offer', from: 5, to: 5 },
  { key: 'contracting', label: 'Contract', from: 6, to: 6 },
  { key: 'disposition', label: 'Dispo', from: 7, to: 7 },
  { key: 'closing', label: 'Closing', from: 8, to: 9 },
  { key: 'complete', label: 'Closed', from: 10, to: 10 },
]

/* ── the river ─────────────────────────────────────────────────────────── */

export type RiverLens = 'stage' | 'owner' | 'age'
export type RiverStratum = { key: string; label: string; color: string; values: number[] }

/** Per-reach counts that make up the river, by lens. Live (working) deals only. */
export function riverStrata(stages: ReadonlyArray<DeskStage>, lens: RiverLens): RiverStratum[] {
  const ordered = STAGE_CODES.map((code) => stages.find((s) => s.code === code) || null)
  if (lens === 'owner') {
    return LIVE_OWNERS.map((k) => ({ key: k, label: OWNER_META[k].label, color: OWNER_META[k].color, values: ordered.map((s) => s?.owners?.[k] ?? 0) }))
  }
  if (lens === 'age') {
    return [
      { key: 'fresh', label: 'Within the stage clock', color: 'var(--pd2-age-fresh)', values: ordered.map((s) => s?.aging?.buckets.fresh ?? 0) },
      { key: 'aging', label: 'Past half the clock', color: 'var(--pd2-age-aging)', values: ordered.map((s) => s?.aging?.buckets.aging ?? 0) },
      { key: 'over', label: 'Past the stage clock', color: 'var(--pd2-age-over)', values: ordered.map((s) => s?.aging?.buckets.over ?? 0) },
    ]
  }
  return [{ key: 'live', label: 'Live deals', color: 'var(--pd2-river)', values: ordered.map((s) => liveCount(s)) }]
}

/** Live = in the stage and being worked (not dormant). S10 counts only recorded closings. */
export function liveCount(s: DeskStage | null | undefined): number {
  if (!s) return 0
  if (s.code === 'closed') return s.count
  return s.working ?? Math.max(0, s.count - (s.dormant ?? 0))
}

export type Reach = { i: number; x0: number; x1: number; c: number; t: number; total: number }

/**
 * Reach positions and thicknesses. Thickness ∝ √count (so a 5-deal reach is
 * still legible beside a 76-deal one); empty reaches are a dry 2px channel.
 * `along` is the flow axis length, `across` the band's room.
 */
export function riverReaches(totals: ReadonlyArray<number>, { along, across, minT = 10, dryT = 2 }: { along: number; across: number; minT?: number; dryT?: number }): Reach[] {
  const n = totals.length || 1
  const step = along / n
  const max = Math.max(1, ...totals)
  const maxT = Math.max(minT + 2, across)
  return totals.map((total, i) => {
    const t = total > 0 ? Math.max(minT, maxT * (Math.sqrt(total) / Math.sqrt(max))) : dryT
    return { i, x0: i * step, x1: (i + 1) * step, c: (i + 0.5) * step, t, total }
  })
}

const f = (v: number) => (Math.round(v * 10) / 10).toString()

/**
 * The band of one stratum as a closed path, flowing along x (horizontal) or y
 * (vertical). Each reach is flat across its middle `flat` share and eases into
 * the next with a cubic, so the river reads as one body of water. `edges`
 * gives the stratum's [start, end] offset within each reach's thickness.
 */
export function stratumPath(reaches: ReadonlyArray<Reach>, edges: ReadonlyArray<[number, number]>, { mid, orientation = 'horizontal', flat = 0.56 }: { mid: number; orientation?: 'horizontal' | 'vertical'; flat?: number }): string {
  const n = reaches.length
  if (!n) return ''
  const pt = (along: number, across: number) => (orientation === 'horizontal' ? `${f(along)},${f(across)}` : `${f(across)},${f(along)}`)
  const top = reaches.map((r, k) => mid - r.t / 2 + edges[k][0])
  const bot = reaches.map((r, k) => mid - r.t / 2 + edges[k][1])
  const inset = (r: Reach) => ((r.x1 - r.x0) * (1 - flat)) / 2
  // each reach is flat on [a, b]; the river eases between reaches with a cubic
  const a = reaches.map((r, k) => (k === 0 ? r.x0 : r.x0 + inset(r)))
  const b = reaches.map((r, k) => (k === n - 1 ? r.x1 : r.x1 - inset(r)))
  let d = `M${pt(a[0], top[0])}L${pt(b[0], top[0])}`
  for (let k = 1; k < n; k += 1) {
    const mx = (b[k - 1] + a[k]) / 2
    d += `C${pt(mx, top[k - 1])} ${pt(mx, top[k])} ${pt(a[k], top[k])}L${pt(b[k], top[k])}`
  }
  d += `L${pt(b[n - 1], bot[n - 1])}L${pt(a[n - 1], bot[n - 1])}`
  for (let k = n - 2; k >= 0; k -= 1) {
    const mx = (b[k] + a[k + 1]) / 2
    d += `C${pt(mx, bot[k + 1])} ${pt(mx, bot[k])} ${pt(b[k], bot[k])}L${pt(a[k], bot[k])}`
  }
  return `${d}Z`
}

/**
 * Stack strata inside each reach, top to bottom, with a 2px surface gap
 * between touching segments (the gap separates, never a stroke).
 */
export function stackStrata(reaches: ReadonlyArray<Reach>, strata: ReadonlyArray<RiverStratum>, gap = 2): Array<{ stratum: RiverStratum; edges: Array<[number, number]>; present: boolean }> {
  const out = strata.map((s) => ({ stratum: s, edges: [] as Array<[number, number]>, present: s.values.some((v) => v > 0) }))
  reaches.forEach((r, k) => {
    const total = strata.reduce((n, s) => n + (s.values[k] || 0), 0)
    const shown = strata.filter((s) => (s.values[k] || 0) > 0).length
    let cursor = 0
    const usable = total > 0 ? Math.max(0, r.t - gap * Math.max(0, shown - 1)) : r.t
    strata.forEach((s, si) => {
      const v = s.values[k] || 0
      if (total === 0) {
        out[si].edges.push([r.t / 2, r.t / 2])
        return
      }
      const h = (usable * v) / total
      out[si].edges.push([cursor, cursor + h])
      cursor += h + (v > 0 ? gap : 0)
    })
  })
  return out
}

/* ── movement ──────────────────────────────────────────────────────────── */

export const MOVE_ICON: Record<string, IconName> = {
  advance: 'arrow-up-right', regress: 'arrow-down-left', price: 'dollar-sign', offer: 'send', counter: 'refresh-cw',
  created: 'spark', exit: 'archive', reply: 'message',
}

export function moveSource(m: DeskMove): string {
  if (m.by === 'seller' || m.kind === 'reply') return 'Seller'
  if (m.by === 'human') return 'You'
  return 'Autopilot'
}

export function moveTone(m: DeskMove): LCTone {
  if (m.kind === 'advance' || m.kind === 'created') return 'exec'
  if (m.kind === 'regress') return 'attn'
  if (m.kind === 'price' || m.kind === 'offer' || m.kind === 'counter') return 'flow'
  return 'neutral'
}

/** A movement line as a shared activity event (bursts of the same kind group). */
export function moveToActivity(m: DeskMove, onOpen?: (m: DeskMove) => void): LCActivityEvent {
  const quote = m.kind === 'reply' && m.detail ? `“${m.detail}”` : null
  return {
    id: m.id,
    at: Date.parse(m.at),
    title: m.kind === 'reply' ? 'Seller replied' : `${m.title}${m.detail ? ` · ${m.detail}` : ''}`,
    subject: m.address || m.seller || (m.left ? 'Deal left the pipeline' : 'Deal'),
    source: moveSource(m),
    result: quote,
    icon: MOVE_ICON[m.kind] ?? 'activity',
    tone: moveTone(m),
    groupKey: m.kind === 'exit' ? `exit:${m.title}` : m.kind === 'created' ? 'created' : undefined,
    groupNoun: m.kind === 'exit' ? `deals · ${m.title.toLowerCase()}` : m.kind === 'created' ? 'opportunities opened' : undefined,
    onOpen: onOpen ? () => onOpen(m) : undefined,
  }
}

/** Movement the page had not seen yet (first read seeds, never pulses). */
export function arrivals(seen: ReadonlySet<string> | null, moves: ReadonlyArray<DeskMove>): DeskMove[] {
  if (!seen) return []
  return moves.filter((m) => !seen.has(m.id))
}

const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGE_CODES.map((c, i) => [c, i]))
/** Where a real movement travels on the river (reach indexes, 0-based). */
export function pulseRoute(m: DeskMove): { from: number | null; to: number | null } | null {
  if (m.kind === 'advance' || m.kind === 'regress') {
    const from = m.fromStage ? STAGE_INDEX[m.fromStage] : undefined
    const to = m.toStage ? STAGE_INDEX[m.toStage] : undefined
    if (to === undefined) return null
    return { from: from ?? null, to }
  }
  if (m.kind === 'created') {
    const to = m.toStage ? STAGE_INDEX[m.toStage] : STAGE_INDEX[m.stage]
    return to === undefined ? null : { from: null, to }
  }
  if (m.kind === 'exit') {
    const from = STAGE_INDEX[m.stage]
    return from === undefined ? null : { from, to: null }
  }
  return null
}

/* ── flow matrix (age buckets) ─────────────────────────────────────────── */

export const AGE_BUCKETS: ReadonlyArray<{ key: string; label: string; max: number }> = [
  { key: 'd1', label: '≤1d', max: 1 },
  { key: 'd3', label: '2–3d', max: 3 },
  { key: 'd7', label: '4–7d', max: 7 },
  { key: 'd14', label: '1–2w', max: 14 },
  { key: 'd30', label: '2–4w', max: 30 },
  { key: 'd60', label: '1–2mo', max: 60 },
  { key: 'd120', label: '2–4mo', max: 120 },
  { key: 'old', label: '4mo+', max: Number.POSITIVE_INFINITY },
]

export function ageBucket(days: number | null | undefined): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return -1
  const i = AGE_BUCKETS.findIndex((b) => days <= b.max)
  return i < 0 ? AGE_BUCKETS.length - 1 : i
}

/** The first bucket that lies past a stage clock (cells from here are stalled territory). */
export function clockBucket(clockDays: number | null | undefined): number | null {
  if (typeof clockDays !== 'number' || !Number.isFinite(clockDays)) return null
  const i = AGE_BUCKETS.findIndex((_, k) => (k === 0 ? 0 : AGE_BUCKETS[k - 1].max) >= clockDays)
  return i < 0 ? null : i
}

const OWNER_RANK: Record<string, number> = { blocked: 0, needs_you: 1, autopilot: 2, scheduled: 3, external: 4, seller: 5, dormant: 6, closed_out: 7, complete: 8 }
export function byOwnerThenAge(a: DeskCard, b: DeskCard): number {
  return (OWNER_RANK[a.owner] ?? 9) - (OWNER_RANK[b.owner] ?? 9) || (b.daysInStage ?? -1) - (a.daysInStage ?? -1)
}

/* ── offers ────────────────────────────────────────────────────────────── */

export function groupOffers(rows: ReadonlyArray<DeskOfferRow>): Record<AutonomyState, DeskOfferRow[]> {
  const out: Record<AutonomyState, DeskOfferRow[]> = { autonomous: [], resolving: [], exception: [], parked: [] }
  for (const r of rows) if (r.autonomy) out[r.autonomy.state].push(r)
  const rank = (r: DeskOfferRow) => -(r.card.stageIndex ?? 0) * 1e9 - (r.engine?.recommended ?? 0) / 1e3
  for (const k of Object.keys(out) as AutonomyState[]) out[k].sort((a, b) => rank(a) - rank(b))
  return out
}

/* ── words ─────────────────────────────────────────────────────────────── */

export const fmtInt = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—')

export function relShort(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const s = (now - t) / 1000
  const future = s < 0
  const a = Math.abs(s)
  const v = a < 60 ? 'now' : a < 3600 ? `${Math.floor(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h` : a < 86400 * 45 ? `${Math.floor(a / 86400)}d` : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (v === 'now') return 'now'
  if (/^[A-Z]/.test(v)) return v
  return future ? `in ${v}` : `${v} ago`
}

export function stampCT(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return `${new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })} CT`
}

/** "S2 · Interest" */
export function stageTag(stageIndex: number | null | undefined, code: string): string {
  return `S${stageIndex ?? '–'} · ${STAGE_SHORT_LABEL[code] ?? code}`
}

/** Plain words for the stated next action an inbound turn wrote. */
export function intentWords(action: string | null | undefined): string | null {
  const a = String(action || '').trim()
  if (!a) return null
  const known: Record<string, string> = {
    send_message_now: 'send a reply now', schedule_follow_up: 'schedule a follow-up', human_review: 'hand to a human',
    future_seller_followup: 'follow up later', future_seller_followup_tenant_timing: 'follow up when the tenant timing allows',
    no_action_contact_blocked: 'stop — contact blocked', generate_offer: 'generate an offer', generate_contract: 'generate a contract',
  }
  return known[a] || a.replace(/_/g, ' ')
}

/** Sum a flow field across stages. */
export function flowSum(stages: ReadonlyArray<StageFlow>, key: keyof Pick<StageFlow, 'entered' | 'left' | 'system' | 'human'>): number {
  return stages.reduce((n, s) => n + (s[key] || 0), 0)
}

/** Plain words for a queue use case (the server's template key). */
export function stepWords(useCase: string | null | undefined): string | null {
  const u = String(useCase || '').trim().toLowerCase()
  if (!u) return null
  const known: Record<string, string> = {
    condition_probe: 'Condition question', safe_clarifier: 'Clarifying question', justify_price: 'Price justification',
    reengagement: 'Re-engagement', consider_selling: 'Interest question', ownership_check: 'Ownership check',
    seller_asking_price: 'Asking-price question', asking_price_follow_up: 'Asking-price follow-up',
    nurture_not_interested: '30-day nurture', manual_reply: 'Manual reply', occupancy_probe: 'Occupancy question',
  }
  return known[u] || `${u.charAt(0).toUpperCase()}${u.slice(1).replace(/_/g, ' ')}`
}
