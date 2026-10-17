// ADAPTIVE 3–40 MINUTE RESPONSE SCHEDULER (rc-8.5.20, Phase 3). PURE: no I/O, no clock, no
// Math.random — every input is an argument and the "randomness" is a seeded draw, so the same
// turn version always plans the same time (a retried / recovered job re-plans identically).
//
// Output: when the reply to ONE resolved turn should go, measured from the seller's LATEST
// inbound of the turn, inside [3, 40] minutes, never mechanical:
//
//   1. CENTER (log space). The prior median (9 min) is shrunk toward the seller's OWN observed
//      reply cadence (median of their reply latencies to our texts × mirror_ratio 0.6):
//          w = n / (n + prior_strength)          n = observed latencies (prior_strength 4)
//          log c = w·log(mirror) + (1 − w)·log(prior)
//      Thin history ⇒ w small ⇒ the prior dominates (no false precision).
//   2. ADJUSTMENTS (multiplicative, each recorded in `factors`):
//          active negotiation ×0.6 · urgency u∈[0,1] ×(1 − 0.45u) · engagement e∈[0,1]
//          ×(1.2 − 0.4e) · complexity x∈[0,1] ×(1 + 0.5x) · underwriting needed but not
//          ready ×1.5 · seller mid-burst (≥2 inbounds in 5 min) ×1.15 · stage (S1/S2 ×1.1,
//          S5 ×0.9) · sender health h ×(1 + 0.6(1 − h)) · campaign health ×(1 + 0.3(1 − h))
//   3. DRAW. A truncated log-normal around the center, truncated to [3, 40] by inverse-CDF
//      sampling (no pile-up at the bounds), sigma 0.38 widened up to ×1.3 when history is
//      thin. The seed is the turn key + version. Seconds are kept (never round minutes).
//   4. FREQUENCY. Opt-out ⇒ IMMEDIATE (no delay, no model). AI replies to this seller today ≥
//      the per-seller cap (canary: 1) ⇒ HOLD — unless the turn is an active negotiation, the
//      policy field `negotiation_turns_enabled` is on (separate owner approval) and the
//      negotiation cap is not reached. All-origin outbound to this seller today ≥
//      max_outbound_per_seller_per_day ⇒ HOLD. Never closer than min_spacing after our last
//      outbound.
//   5. CONTACT WINDOW (never bypassed). A target is lawful when it is inside the recipient-
//      local window (08:00–21:00) OR still IN SESSION (≤ conversational window − margin after
//      the seller's inbound: owner rule 2026-10-10, a reply to a live conversation may go at
//      any hour). Not lawful ⇒ pull it into the session when ≥ 3 min is still possible
//      (pull_into_session), else defer to the NEXT LAWFUL TIME: the next local open plus a
//      seeded 2–24 min offset. rc-8.5.21: the verdict is queue/reply-timing.js#evaluateReplyTiming
//      (the ONE function the dispatcher and the row gate also call). Recipient zones come from
//      recipient-local evidence (area code, mailing state) intersected with the property zone; an
//      unknown zone uses the conservative lower-48 intersection instead of a hold.
//   6. RECOVERY. A plan made late (restart, outage): a target already in the past ⇒ due now +
//      a seeded 0.5–2 min (still window-checked), reason overdue_recovery.
import crypto from 'node:crypto'
import { evaluateReplyTiming, normalizeZones, resolveRecipientZones } from '../../queue/reply-timing.js'

export const DELAY_PLANNER_VERSION = 'conv-ai.delay-planner.v2'
export const DELAY_BOUNDS = Object.freeze({ min_minutes: 3, max_minutes: 40 })

export const DEFAULT_DELAY_POLICY = Object.freeze({
  prior_median_minutes: 9,
  prior_strength: 4,
  mirror_ratio: 0.6,
  sigma: 0.38,
  contact_window: Object.freeze({ start_hour: 8, end_hour: 21 }),
  in_session_minutes: 30,
  session_margin_minutes: 2,
  pull_into_session: true,
  min_spacing_minutes: 3,
  // canary: one AI reply per seller per day (a policy VALUE). Ongoing negotiation turns need a
  // separate owner approval: negotiation_turns_enabled (default false) + its own cap.
  max_ai_replies_per_seller_per_day: 1,
  negotiation_turns_enabled: false,
  max_negotiation_turns_per_seller_per_day: 6,
  max_outbound_per_seller_per_day: 8,
})

const MIN = 60_000
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const unit = (x) => (x == null || !Number.isFinite(Number(x)) ? null : clamp(Number(x), 0, 1))
const iso = (ms) => new Date(ms).toISOString()
const r2 = (x) => Math.round(x * 100) / 100

/** Policy merge: a caller can tighten / adjust, never widen the [3, 40] bounds or drop the window. */
export function normalizeDelayPolicy(p = {}) {
  const d = DEFAULT_DELAY_POLICY
  const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : def)
  const cw = p?.contact_window || {}
  const start = Math.trunc(num(cw.start_hour, 8, 12, d.contact_window.start_hour))
  const end = Math.trunc(num(cw.end_hour, 13, 21, d.contact_window.end_hour))
  return {
    prior_median_minutes: num(p?.prior_median_minutes, 3, 40, d.prior_median_minutes),
    prior_strength: num(p?.prior_strength, 1, 50, d.prior_strength),
    mirror_ratio: num(p?.mirror_ratio, 0.2, 1.5, d.mirror_ratio),
    sigma: num(p?.sigma, 0.1, 0.8, d.sigma),
    contact_window: { start_hour: start, end_hour: end },
    in_session_minutes: num(p?.in_session_minutes, 0, 120, d.in_session_minutes),
    session_margin_minutes: num(p?.session_margin_minutes, 1, 15, d.session_margin_minutes),
    pull_into_session: p?.pull_into_session === false ? false : d.pull_into_session,
    min_spacing_minutes: num(p?.min_spacing_minutes, 1, 40, d.min_spacing_minutes),
    max_ai_replies_per_seller_per_day: Math.trunc(num(p?.max_ai_replies_per_seller_per_day, 0, 50, d.max_ai_replies_per_seller_per_day)),
    negotiation_turns_enabled: p?.negotiation_turns_enabled === true,
    max_negotiation_turns_per_seller_per_day: Math.trunc(num(p?.max_negotiation_turns_per_seller_per_day, 0, 20, d.max_negotiation_turns_per_seller_per_day)),
    max_outbound_per_seller_per_day: Math.trunc(num(p?.max_outbound_per_seller_per_day, 0, 50, d.max_outbound_per_seller_per_day)),
  }
}

// ── seeded uniforms ─────────────────────────────────────────────────────────
export function seededUniforms(seed, n = 4) {
  const out = []
  let block = 0
  while (out.length < n) {
    const h = crypto.createHash('sha256').update(`conv-ai.delay.v1\n${String(seed)}\n${block}`).digest()
    for (let i = 0; i + 6 <= h.length && out.length < n; i += 6) out.push((h.readUIntBE(i, 6) + 0.5) / 2 ** 48)
    block += 1
  }
  return out
}

// ── normal CDF / inverse (Abramowitz–Stegun 7.1.26; Acklam) ────────────────
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}
export function normInv(p) {
  const q = clamp(p, 1e-12, 1 - 1e-12)
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (q < lo) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1) }
  if (q > 1 - lo) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1) }
  const r = q - 0.5; const s = r * r
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
}

/** A draw from a log-normal(center, sigma) truncated to [lo, hi] minutes, by inverse CDF. */
export function truncatedLogNormal(u, centerMinutes, sigma, lo = DELAY_BOUNDS.min_minutes, hi = DELAY_BOUNDS.max_minutes) {
  const mu = Math.log(centerMinutes)
  const a = normCdf((Math.log(lo) - mu) / sigma)
  const b = normCdf((Math.log(hi) - mu) / sigma)
  const p = a + clamp(u, 0, 1) * Math.max(b - a, 1e-12)
  return clamp(Math.exp(mu + sigma * normInv(p)), lo, hi)
}

// ── recipient-local time ────────────────────────────────────────────────────
const FMT = new Map()
function localMinutes(ms, tz) {
  let f = FMT.get(tz)
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }); FMT.set(tz, f) }
  const parts = f.formatToParts(new Date(ms))
  const h = Number(parts.find((x) => x.type === 'hour')?.value || 0) % 24
  const m = Number(parts.find((x) => x.type === 'minute')?.value || 0)
  return h * 60 + m
}
export function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}
export function inLocalWindow(ms, tz, { start_hour, end_hour }) {
  const m = localMinutes(ms, tz)
  return m >= start_hour * 60 && m < end_hour * 60
}
/** The first instant ≥ ms at which the local window is open (minute precision, ≤ 3 days ahead). */
export function nextLocalOpen(ms, tz, window) {
  if (inLocalWindow(ms, tz, window)) return ms
  let t = Math.ceil(ms / MIN) * MIN
  for (let i = 0; i < 3 * 24 * 4; i += 1) { // 15-minute steps, then refine to the minute
    const next = t + 15 * MIN
    if (inLocalWindow(next, tz, window)) {
      for (let k = t + MIN; k <= next; k += MIN) if (inLocalWindow(k, tz, window)) return k
      return next
    }
    t = next
  }
  return null
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null
}

/** The recipient zones a plan uses: the resolved evidence, else a legacy single zone, else unknown. */
export function recipientZonesFor(a = {}) {
  const rz = a.recipientZones
  if (rz && normalizeZones(rz.zones).length) return { zones: normalizeZones(rz.zones), certainty: rz.certainty || 'single', recipient_local: rz.recipient_local === true }
  if (validTimezone(a.timezone)) return { zones: [a.timezone], certainty: 'stored_only', recipient_local: false }
  return resolveRecipientZones({})
}

/**
 * @param {object} a
 * @param {string} a.seed                 turn key + version (deterministic draw)
 * @param {string} a.now                  ISO
 * @param {string} a.lastInboundAt        ISO: the turn's LATEST seller inbound
 * @param {number[]} [a.sellerReplyLatenciesMinutes] the seller's observed reply latencies to our texts
 * @param {string[]} [a.recentInboundAts] the seller's inbound times (burst detection)
 * @param {string|null} [a.timezone]      a single recipient IANA zone (legacy input; used when no zones evidence)
 * @param {{ zones: string[], certainty: string, recipient_local?: boolean }|null} [a.recipientZones]  resolveRecipientZones()
 * @param {string|null} [a.inboundId]     the turn's latest inbound id (the in-session linkage)
 * @param {number|null} [a.engagement]    0..1
 * @param {string|null} [a.stage]         S1_ownership … S5_offer
 * @param {number|null} [a.urgency]       0..1
 * @param {boolean} [a.activeNegotiation]
 * @param {number|null} [a.complexity]    0..1
 * @param {{ required?: boolean, ready?: boolean }|null} [a.underwriting]
 * @param {number|null} [a.senderHealth]  0..1 (1 healthy)
 * @param {number|null} [a.campaignHealth] 0..1
 * @param {{ aiRepliesToSellerToday?: number, negotiationTurnsToday?: number, outboundToSellerToday?: number, lastOutboundAt?: string|null }} [a.counts]
 * @param {boolean} [a.optOut]
 * @param {object} [a.policy]
 */
export function planReplyDelay(a = {}) {
  const policy = normalizeDelayPolicy(a.policy)
  const reasons = []
  const base = { version: DELAY_PLANNER_VERSION }
  const nowMs = Date.parse(a.now)
  const inMs = Date.parse(a.lastInboundAt)
  if (a.optOut === true) return { ...base, action: 'immediate', due_at: Number.isFinite(nowMs) ? iso(nowMs) : null, delay_minutes: 0, reasons: ['opt_out_bypasses_delay'] }
  if (!Number.isFinite(nowMs) || !Number.isFinite(inMs)) return { ...base, action: 'hold', due_at: null, delay_minutes: null, reasons: ['plan_inputs_invalid'] }

  // 4. frequency (before any draw: a held turn has no time)
  const c = a.counts || {}
  const aiToday = Math.max(0, Number(c.aiRepliesToSellerToday) || 0)
  const negToday = Math.max(0, Number(c.negotiationTurnsToday) || 0)
  const outToday = Math.max(0, Number(c.outboundToSellerToday) || 0)
  if (outToday >= policy.max_outbound_per_seller_per_day) return { ...base, action: 'hold', due_at: null, delay_minutes: null, reasons: ['contact_frequency_limit'] }
  if (aiToday >= policy.max_ai_replies_per_seller_per_day) {
    const negotiationAllowed = a.activeNegotiation === true && policy.negotiation_turns_enabled && negToday < policy.max_negotiation_turns_per_seller_per_day
    if (!negotiationAllowed) return { ...base, action: 'hold', due_at: null, delay_minutes: null, reasons: [a.activeNegotiation === true && policy.negotiation_turns_enabled ? 'negotiation_turn_cap' : 'seller_daily_ai_reply_cap'] }
    reasons.push('negotiation_turn_beyond_canary_cap')
  }

  // 1. center: prior shrunk toward the seller's own cadence
  const lat = (a.sellerReplyLatenciesMinutes || []).map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x <= 7 * 1440)
  const n = lat.length
  const w = n / (n + policy.prior_strength)
  const mirror = n ? clamp(median(lat) * policy.mirror_ratio, DELAY_BOUNDS.min_minutes, DELAY_BOUNDS.max_minutes) : policy.prior_median_minutes
  let center = Math.exp(w * Math.log(mirror) + (1 - w) * Math.log(policy.prior_median_minutes))
  const confidence = n === 0 ? 'prior' : w < 0.5 ? 'thin_history' : 'observed'

  // 2. adjustments
  const f = {}
  if (a.activeNegotiation === true) f.active_negotiation = 0.6
  const u = unit(a.urgency); if (u != null && u > 0) f.urgency = 1 - 0.45 * u
  const e = unit(a.engagement); if (e != null) f.engagement = 1.2 - 0.4 * e
  const x = unit(a.complexity); if (x != null && x > 0) f.complexity = 1 + 0.5 * x
  if (a.underwriting?.required === true && a.underwriting?.ready !== true) f.underwriting_not_ready = 1.5
  const recent = (a.recentInboundAts || []).map(Date.parse).filter((t) => Number.isFinite(t) && t <= inMs && inMs - t <= 5 * MIN)
  if (recent.length >= 2) f.seller_mid_burst = 1.15
  if (/^S[12]_/.test(String(a.stage || ''))) f.stage = 1.1
  else if (/^S5_/.test(String(a.stage || ''))) f.stage = 0.9
  const h = unit(a.senderHealth); if (h != null && h < 1) f.sender_health = 1 + 0.6 * (1 - h)
  const ch = unit(a.campaignHealth); if (ch != null && ch < 1) f.campaign_health = 1 + 0.3 * (1 - ch)
  for (const v of Object.values(f)) center *= v
  center = clamp(center, DELAY_BOUNDS.min_minutes * 1.05, DELAY_BOUNDS.max_minutes * 0.95)

  // 3. the draw
  const [u1, u2, u3] = seededUniforms(`${a.seed ?? ''}|${a.lastInboundAt}`, 3)
  const sigma = policy.sigma * (1 + 0.3 * (1 - w))
  const targetMin = truncatedLogNormal(u1, center, sigma)
  let due = inMs + Math.round(targetMin * 60) * 1000
  let basis = 'planned'

  // 6. recovery: never in the past
  if (due < nowMs) { due = nowMs + Math.round((0.5 + 1.5 * u2) * 60) * 1000; basis = 'overdue_recovery'; reasons.push('overdue_recovery') }
  // 4b. spacing after our last outbound
  const lastOut = Date.parse(c.lastOutboundAt || '')
  if (Number.isFinite(lastOut) && due < lastOut + policy.min_spacing_minutes * MIN) {
    due = lastOut + policy.min_spacing_minutes * MIN + Math.round(u2 * 90) * 1000
    reasons.push('min_spacing_after_last_outbound')
  }

  // 5. the contact window — THE shared eligibility function (queue/reply-timing.js), the same one
  //    the R3 enqueue check and the dispatch-time row gate call, so they can never disagree
  const zones = recipientZonesFor(a)
  const sessionMinutes = Math.max(0, policy.in_session_minutes - policy.session_margin_minutes)
  const judge = (t) => evaluateReplyTiming({ at: iso(t), queuedAt: iso(t), inboundId: a.inboundId || 'turn', inboundAt: iso(inMs), zones: zones.zones, sessionMinutes, hours: { start_hour: policy.contact_window.start_hour, end_hour: policy.contact_window.end_hour } })
  const sessionEnd = inMs + sessionMinutes * MIN
  const inSession = (t) => sessionMinutes > 0 && t <= sessionEnd
  const zoneInfo = { certainty: zones.certainty, zones: zones.zones, recipient_local: zones.recipient_local }
  let window = { lawful_basis: null, deferred: false, timezone_known: zones.certainty !== 'unknown', ...zoneInfo }
  const verdict = judge(due)
  if (verdict.lawful) {
    window.lawful_basis = verdict.basis
  } else {
    const earliest = Math.max(inMs + DELAY_BOUNDS.min_minutes * MIN, nowMs, Number.isFinite(lastOut) ? lastOut + policy.min_spacing_minutes * MIN : 0)
    if (policy.pull_into_session && inSession(earliest) && judge(earliest).lawful) {
      due = earliest + Math.round(u3 * Math.max(0, sessionEnd - earliest) / 1000) * 1000
      window = { ...window, lawful_basis: 'in_session', deferred: false, pulled_into_session: true }
      reasons.push('pulled_into_session_window')
    } else {
      const open = verdict.next_permitted_at ? Date.parse(verdict.next_permitted_at) : null
      if (open == null) return { ...base, action: 'hold', due_at: null, delay_minutes: null, reasons: [...reasons, 'contact_window_unresolvable'] }
      // natural jitter after the open (seeded 2–24 min), re-checked against the same function
      due = open + Math.round((2 + 22 * u3) * 60) * 1000
      if (!judge(due).lawful) due = open
      window = { ...window, lawful_basis: 'local_hours', deferred: true }
      reasons.push('deferred_to_contact_window')
    }
  }
  if (zones.certainty === 'unknown') reasons.push('recipient_timezone_unknown_conservative_window')

  return {
    ...base,
    action: 'schedule',
    due_at: iso(due),
    delay_minutes: r2((due - nowMs) / MIN),
    target_minutes: r2(targetMin),
    since_inbound_minutes: r2((due - inMs) / MIN),
    center_minutes: r2(center),
    basis,
    confidence,
    history_n: n,
    shrinkage_weight: r2(w),
    factors: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, r2(v)])),
    window,
    reasons,
  }
}
