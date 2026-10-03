/**
 * ANALYTICS GOALS — the pure model (no I/O).
 *
 * A goal is an operator-set TARGET on a canonical Analytics Lab metric:
 *
 *   (metric_id, market | all markets, period_kind week|month|quarter,
 *    comparator at_least|at_most, target_value)
 *
 * Goals recur: a "month" goal is judged against the CURRENT calendar month
 * (in the goal's time zone) every time it is read. The VALUE is never stored.
 * Progress is the Lab's own `evaluate()` over the period-to-date with the
 * goal's market as a Lab filter — the same definitions, exclusions and
 * sample gates Analytics shows. This module only adds the arithmetic a
 * target needs (elapsed share, linear pace, run-rate projection) and refuses
 * to project anything the Lab would not honestly sum over time.
 *
 *   status (verbatim from the Lab): ok | no_data | insufficient_sample |
 *                                   unavailable | not_applicable
 *   verdict (ours, only when status = ok):
 *     met       the target is already reached (at_least) / still held (at_most rate)
 *     on_pace   period-to-date ≥ linear pace (at_least) / projection ≤ target (at_most)
 *     behind    below linear pace (at_least)
 *     at_risk   projection exceeds the target (at_most count)
 *     missed    an at_most count already above its target
 *     met / not_met         a rate goal, judged on its period-to-date value
 *     in_progress / within  a non-additive count (no pace: it does not sum by day)
 *
 * A projection exists only for metrics the registry marks additive over time
 * (counts you can add day by day). Rates, durations and distinct-throughput
 * counts are judged on the period-to-date value with no projection. A
 * projection is withheld until a full day of the period has elapsed.
 */
import { METRICS_BY_ID } from '../lab/metric-registry.js'
import { validTimeZone, zonedParts, zonedToUtc } from '../lab/query-contract.js'

export const GOAL_TABLE = 'analytics_goals'
export const PERIOD_KINDS = Object.freeze(['week', 'month', 'quarter'])
export const COMPARATORS = Object.freeze(['at_least', 'at_most'])
export const MAX_GOALS = 60
export const MAX_PROGRESS_GOALS = 24
export const DEFAULT_TZ = 'America/Chicago'
const DAY = 86_400_000
const GOAL_ID = /^[A-Za-z0-9_-]{4,64}$/
const MARKET = /^[a-z0-9][a-z0-9_.:-]{0,79}$/i

/**
 * The metrics a target may be set on — operator words for the funnel, every
 * one a registry metric. Offers / contracts / closings are counts over
 * near-empty ledgers today: their registry caveat travels with the goal, and
 * any metric the Lab gates as unavailable reads "unavailable" with the Lab's
 * own reason, never a number.
 */
export const GOAL_METRIC_IDS = Object.freeze([
  'sellers_reached', 'sellers_replied', 'reached_replied', 'interested_sellers', 'opted_out_sellers', 'opportunities_created',
  'stage_advancements', 'offers_issued', 'contracts_signed', 'closings', 'messages_delivered',
  'reply_rate', 'interest_rate', 'delivery_rate', 'opt_out_rate',
])

export class GoalError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

/** The catalogue the UI offers (registry facts only — label, unit, polarity, gate, additivity). */
export function goalCatalogue() {
  return GOAL_METRIC_IDS.map((id) => {
    const m = METRICS_BY_ID[id]
    return {
      id,
      label: m.label,
      unit: m.unit,
      polarity: m.polarity,
      additive: m.additive_over_time === true && m.unit === 'count',
      min_sample: m.min_sample ?? null,
      gated: m.availability ? m.availability.reason : null,
      caveat: m.caveat ?? null,
      default_comparator: m.polarity === 'down' ? 'at_most' : 'at_least',
      description: m.description,
    }
  })
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '')

/** Validate and normalise one goal from a client. Throws invalid_goal with the reason. */
export function validateGoal(raw) {
  const bad = (reason) => new GoalError('invalid_goal', 400, reason)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('goal must be an object')
  const goalId = clean(raw.goal_id)
  if (!GOAL_ID.test(goalId)) throw bad('goal_id must be 4–64 letters, digits, _ or -')
  const metricId = clean(raw.metric_id)
  if (!GOAL_METRIC_IDS.includes(metricId) || !METRICS_BY_ID[metricId]) throw bad(`metric "${metricId}" cannot carry a goal`)
  const metric = METRICS_BY_ID[metricId]
  const periodKind = clean(raw.period_kind)
  if (!PERIOD_KINDS.includes(periodKind)) throw bad(`period_kind must be one of ${PERIOD_KINDS.join(', ')}`)
  const comparator = clean(raw.comparator) || (metric.polarity === 'down' ? 'at_most' : 'at_least')
  if (!COMPARATORS.includes(comparator)) throw bad('comparator must be at_least or at_most')
  const target = Number(raw.target_value)
  if (!Number.isFinite(target) || target < 0) throw bad('target_value must be a non-negative number')
  if (metric.unit === 'rate' && target > 1) throw bad('a rate target is a share between 0 and 1')
  if (metric.unit === 'count' && (!Number.isInteger(target) || target > 10_000_000)) throw bad('a count target is a whole number')
  const marketRaw = raw.market == null || raw.market === '' ? null : clean(String(raw.market))
  if (marketRaw !== null && !MARKET.test(marketRaw)) throw bad('market must be a canonical market id')
  const tz = validTimeZone(raw.timezone) || DEFAULT_TZ
  const label = raw.label == null ? null : clean(String(raw.label)).slice(0, 120) || null
  const revision = Number(raw.revision ?? 1)
  if (!Number.isInteger(revision) || revision < 0 || revision > 1e9) throw bad('revision must be a non-negative integer')
  const status = raw.status === 'archived' ? 'archived' : 'active'
  return {
    goal_id: goalId,
    metric_id: metricId,
    label,
    market: marketRaw,
    market_label: raw.market_label == null ? null : clean(String(raw.market_label)).slice(0, 120) || null,
    period_kind: periodKind,
    comparator,
    target_value: target,
    timezone: tz,
    status,
    revision,
  }
}

/* ── periods ──────────────────────────────────────────────────────────── */

/** The current calendar period (inclusive start, exclusive end) containing `now`, in `tz`. Weeks start Monday. */
export function periodBounds(kind, now = Date.now(), tz = DEFAULT_TZ) {
  const z = zonedParts(now, tz)
  // zonedToUtc normalises overflowing days / months (Date.UTC semantics), so day 0 or month 13 are safe
  if (kind === 'week') {
    const back = (z.wd + 6) % 7 // Monday = 0
    return { kind, start: zonedToUtc(z.y, z.mo, z.d - back, 0, 0, tz), end: zonedToUtc(z.y, z.mo, z.d - back + 7, 0, 0, tz) }
  }
  if (kind === 'month') return { kind, start: zonedToUtc(z.y, z.mo, 1, 0, 0, tz), end: zonedToUtc(z.y, z.mo + 1, 1, 0, 0, tz) }
  if (kind === 'quarter') {
    const q0 = Math.floor((z.mo - 1) / 3) * 3 + 1
    return { kind, start: zonedToUtc(z.y, q0, 1, 0, 0, tz), end: zonedToUtc(z.y, q0 + 3, 1, 0, 0, tz) }
  }
  throw new GoalError('invalid_goal', 400, `unknown period_kind "${kind}"`)
}

/** The Lab query context for a goal's period-to-date (custom range, no comparison, the market as a filter). */
export function labContextFor(goal, now = Date.now()) {
  const p = periodBounds(goal.period_kind, now, goal.timezone || DEFAULT_TZ)
  return {
    v: 1,
    tz: goal.timezone || DEFAULT_TZ,
    metric: goal.metric_id,
    range: { preset: 'custom', start: new Date(p.start).toISOString(), end: new Date(Math.min(p.end, now)).toISOString() },
    compare: { mode: 'none' },
    grain: 'day',
    filters: goal.market ? [{ field: 'market', op: 'eq', value: goal.market }] : [],
    segment: [],
  }
}

/* ── progress ─────────────────────────────────────────────────────────── */

const round = (n, d = 4) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d)

/**
 * Progress for one goal from the Lab's evaluation of its period-to-date.
 * `value` is the Lab metric result ({ status, value, n, reason … });
 * `series` (optional) the Lab's daily series for the same window.
 */
export function progressOf(goal, value, { now = Date.now(), series = null } = {}) {
  const metric = METRICS_BY_ID[goal.metric_id]
  const p = periodBounds(goal.period_kind, now, goal.timezone || DEFAULT_TZ)
  const span = p.end - p.start
  const elapsedMs = Math.max(0, Math.min(span, now - p.start))
  const elapsed = span > 0 ? elapsedMs / span : 0
  const additive = metric?.additive_over_time === true && metric?.unit === 'count'
  const base = {
    goal_id: goal.goal_id,
    metric_id: goal.metric_id,
    unit: metric?.unit ?? 'count',
    period: { kind: p.kind, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString(), elapsed: round(elapsed), days_left: Math.max(0, Math.ceil((p.end - now) / DAY)) },
    target: goal.target_value,
    comparator: goal.comparator,
    status: value?.status ?? 'unavailable',
    reason: value?.reason ?? null,
    current: value?.status === 'ok' || value?.status === 'insufficient_sample' ? value.value ?? null : null,
    n: value?.n ?? null,
    min_sample: value?.minSample ?? metric?.min_sample ?? null,
    additive,
    pace: null,
    projection: null,
    projection_basis: null,
    share: null,
    verdict: null,
    cumulative: null,
  }
  if (!metric) return { ...base, status: 'unavailable', reason: 'This metric is no longer in the Analytics registry (retired).' }
  if (base.status !== 'ok') return base
  const cur = Number(value.value)
  const target = goal.target_value
  if (additive) {
    const pace = target * elapsed
    const canProject = elapsedMs >= DAY && elapsed > 0
    const projection = canProject ? cur / elapsed : null
    let verdict
    if (goal.comparator === 'at_least') verdict = cur >= target ? 'met' : cur >= pace ? 'on_pace' : 'behind'
    else verdict = cur > target ? 'missed' : projection !== null && projection > target ? 'at_risk' : 'on_pace'
    return {
      ...base,
      current: cur,
      pace: round(pace, 2),
      projection: projection === null ? null : Math.round(projection),
      projection_basis: projection === null ? 'Too early in the period to project (less than one day elapsed).' : 'Run-rate projection: period-to-date ÷ share of the period elapsed. Modeled, not a forecast of intent.',
      share: target > 0 ? round(cur / target) : null,
      verdict,
      cumulative: cumulativeOf(series),
    }
  }
  // rates / non-additive counts: judged on the period-to-date value, no projection
  const met = goal.comparator === 'at_least' ? cur >= target : cur <= target
  const verdict = metric.unit === 'rate' ? (met ? 'met' : 'not_met') : goal.comparator === 'at_least' ? (met ? 'met' : 'in_progress') : (met ? 'within' : 'missed')
  return {
    ...base,
    current: cur,
    share: target > 0 ? round(cur / target) : null,
    verdict,
    projection_basis: 'Not projected: this metric does not add up day by day. Judged on the period-to-date value.',
  }
}

/** The Lab's daily series as a running total (counts only), for the progress line. */
export function cumulativeOf(series) {
  const pts = Array.isArray(series?.current) ? series.current : Array.isArray(series) ? series : null
  if (!pts) return null
  let run = 0
  return pts.map((pt) => {
    if (Number.isFinite(pt?.value)) run += pt.value
    return { start: typeof pt.start === 'number' ? new Date(pt.start).toISOString() : pt.start, total: run }
  })
}
