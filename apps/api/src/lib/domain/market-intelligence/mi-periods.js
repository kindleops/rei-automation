/**
 * MARKET INTELLIGENCE: periods, coverage window and valid baselines (brief §14, §50).
 *
 * Days are integers since 2000-01-01 (UTC); months are integers y*12+m.
 *
 * The sales corpus is an import window, not a uniform history. The 2026-10-04
 * audit measured ~150–400 sales a month before 2025-09, then 36K–69K a month.
 * So:
 *   coverage_start   the first month whose count reaches COVERAGE_FLOOR of the
 *                    trailing-12 median. Earlier months are "pre-coverage".
 *   complete_through the end of the last month reaching COMPLETE_FLOOR of that
 *                    median. Later months are "possibly incomplete (recording lag)".
 * Both are derived from the data at load, never hard-coded.
 *
 * A growth figure exists only when the current AND prior windows end on
 * complete months and the prior window starts inside coverage. Otherwise it is
 * "no valid baseline", never a number.
 */
export const EPOCH_MS = Date.UTC(2000, 0, 1)
const DAY_MS = 86_400_000
export const COVERAGE_FLOOR = 0.25
export const COMPLETE_FLOOR = 0.75

export const PERIODS = Object.freeze([
  { id: '30d', label: '30D', days: 30, months: 1 },
  { id: '90d', label: '90D', days: 90, months: 3 },
  { id: '6m', label: '6M', days: 182, months: 6 },
  { id: '1y', label: '1Y', days: 365, months: 12 },
  { id: '3y', label: '3Y', days: 1095, months: 36 },
  { id: 'all', label: 'All', days: null, months: null },
])
export const DEFAULT_PERIOD = '1y'

export const dayOfDate = (iso) => {
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(t) ? Math.round((t - EPOCH_MS) / DAY_MS) : null
}
export const dateOfDay = (d) => new Date(EPOCH_MS + d * DAY_MS).toISOString().slice(0, 10)
export const monthOfDay = (d) => { const dt = new Date(EPOCH_MS + d * DAY_MS); return dt.getUTCFullYear() * 12 + dt.getUTCMonth() }
export const monthLabel = (m) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`
export const firstDayOfMonth = (m) => Math.round((Date.UTC(Math.floor(m / 12), m % 12, 1) - EPOCH_MS) / DAY_MS)
export const lastDayOfMonth = (m) => firstDayOfMonth(m + 1) - 1

const median = (arr) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

/**
 * Pure: national monthly counts {month → n} + the as-of day → coverage facts.
 * Months with zero sales are real zeros inside [min, max].
 */
export function deriveCoverage(monthCounts, asOfDay) {
  const months = [...monthCounts.keys()].sort((a, b) => a - b)
  if (!months.length || asOfDay === null) return { coverage_start_month: null, complete_through_month: null, months: [] }
  const lastMonth = monthOfDay(asOfDay)
  const series = []
  for (let m = months[0]; m <= lastMonth; m += 1) series.push({ month: m, n: monthCounts.get(m) || 0 })
  // Trailing-12 median over the 12 months before the as-of month (the as-of month is partial by definition).
  const trailing = series.filter((s) => s.month < lastMonth).slice(-12).map((s) => s.n)
  const med = median(trailing) || 0
  const covIdx = series.findIndex((s) => med > 0 && s.n >= COVERAGE_FLOOR * med)
  let completeIdx = -1
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].month < lastMonth && med > 0 && series[i].n >= COMPLETE_FLOOR * med) { completeIdx = i; break }
  }
  const coverageStart = covIdx >= 0 ? series[covIdx].month : null
  const completeThrough = completeIdx >= 0 ? series[completeIdx].month : null
  return {
    trailing_median: med,
    coverage_start_month: coverageStart,
    complete_through_month: completeThrough,
    months: series.map((s) => ({
      month: s.month,
      label: monthLabel(s.month),
      n: s.n,
      status: coverageStart === null || s.month < coverageStart ? 'pre_coverage'
        : completeThrough === null || s.month > completeThrough ? (s.month === lastMonth ? 'partial' : 'incomplete')
          : 'covered',
    })),
  }
}

/** Window [from, to] in days for a period id, ending at the as-of day. */
export function periodWindow(periodId, asOfDay, firstDay) {
  const p = PERIODS.find((x) => x.id === periodId) || PERIODS.find((x) => x.id === DEFAULT_PERIOD)
  const to = asOfDay
  const from = p.days === null ? firstDay : asOfDay - p.days + 1
  return { id: p.id, label: p.label, from, to, from_date: dateOfDay(from), to_date: dateOfDay(to) }
}

/**
 * The growth baseline for a period: equal-length windows of COMPLETE months.
 * Returns { valid, reason, current:{from,to}, prior:{from,to}, months }.
 */
export function growthWindows(periodId, coverage) {
  const p = PERIODS.find((x) => x.id === periodId)
  if (!p || p.months === null) return { valid: false, reason: 'All has no prior period' }
  const end = coverage?.complete_through_month
  const start = coverage?.coverage_start_month
  if (end === null || end === undefined || start === null || start === undefined) return { valid: false, reason: 'Coverage window not established' }
  const curFrom = end - p.months + 1
  const priorFrom = curFrom - p.months
  const priorTo = curFrom - 1
  if (priorFrom < start) {
    return { valid: false, reason: `Prior ${p.label} would start ${monthLabel(priorFrom)}, before sales coverage begins (${monthLabel(start)})` }
  }
  return {
    valid: true,
    months: p.months,
    current: { from: firstDayOfMonth(curFrom), to: lastDayOfMonth(end), label: `${monthLabel(curFrom)}–${monthLabel(end)}` },
    prior: { from: firstDayOfMonth(priorFrom), to: lastDayOfMonth(priorTo), label: `${monthLabel(priorFrom)}–${monthLabel(priorTo)}` },
  }
}

/** Complete, covered months inside a day window (for monthly velocity). */
export function completeMonthsIn(from, to, coverage) {
  const out = []
  const s = coverage?.coverage_start_month
  const e = coverage?.complete_through_month
  if (s === null || s === undefined || e === null || e === undefined) return out
  for (let m = Math.max(monthOfDay(from), s); m <= Math.min(monthOfDay(to), e); m += 1) {
    if (firstDayOfMonth(m) >= from && lastDayOfMonth(m) <= to) out.push(m)
  }
  return out
}
