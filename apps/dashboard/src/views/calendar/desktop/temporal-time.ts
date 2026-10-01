/**
 * CALENDAR 5.0 · TIME — the zone math the temporal canvas stands on.
 *
 * Everything is computed from INSTANTS with Intl's own time-zone database:
 * a day is [local midnight, next local midnight) found by asking the zone,
 * never "+24 h" or a fixed offset, so a DST day is 23 or 25 hours long and
 * the axis says so. Days are 'YYYY-MM-DD' strings in a stated zone.
 */

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY_MS = 24 * HOUR

const dtfCache = new Map<string, Intl.DateTimeFormat>()
function dtf(key: string, make: () => Intl.DateTimeFormat) {
  let f = dtfCache.get(key)
  if (!f) { f = make(); dtfCache.set(key, f) }
  return f
}

/** Local calendar day of an instant in `tz`. */
export const dayKey = (at: number | string, tz: string) =>
  dtf(`day|${tz}`, () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })).format(new Date(at))

export function addDays(d: string, n: number) {
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dd) + n * DAY_MS).toISOString().slice(0, 10)
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS)
const noonOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd, 12)) }
/** 0 = Sunday. */
export const weekdayIndex = (d: string) => noonOf(d).getUTCDay()
/** Sunday-first week, as the US calendar reads. */
export const weekStart = (d: string) => addDays(d, -weekdayIndex(d))
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`
export const dayNum = (d: string) => Number(d.slice(8, 10))

export const weekday = (d: string, style: 'short' | 'long' | 'narrow' = 'short') => noonOf(d).toLocaleDateString('en-US', { weekday: style, timeZone: 'UTC' })
export const monthDay = (d: string) => noonOf(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
export const longDay = (d: string) => noonOf(d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
export const fullDay = (d: string) => noonOf(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
export const monthTitle = (d: string) => noonOf(d).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
export const monthShort = (d: string) => noonOf(d).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })

/** Offset (ms) of `tz` at instant `at`, read from the zone database. */
function zoneOffset(at: number, tz: string) {
  const parts = dtf(`off|${tz}`, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })).formatToParts(new Date(at))
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'))
  return asUtc - Math.floor(at / 1000) * 1000
}

/**
 * The instant at which `tz`'s wall clock reads `day` `hh:mm`. Two passes
 * settle a DST boundary (the same method as the server's read model). A
 * wall time that does not exist (spring-forward gap) resolves forward.
 */
export function zonedInstant(day: string, hhmm: string, tz: string) {
  const [y, m, d] = day.split('-').map(Number)
  const [hh, mm] = (hhmm || '00:00').split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0)
  let at = guess - zoneOffset(guess, tz)
  at = guess - zoneOffset(at, tz)
  return at
}

/** [start, end) of a local day as instants — 23 h or 25 h across a DST change. */
export function dayBounds(day: string, tz: string) {
  return { start: zonedInstant(day, '00:00', tz), end: zonedInstant(addDays(day, 1), '00:00', tz) }
}

/** Minutes after local midnight. */
export function localMinutes(at: number | string, tz: string) {
  const p = dtf(`hm|${tz}`, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })).formatToParts(new Date(at))
  return (Number(p.find((x) => x.type === 'hour')?.value) % 24) * 60 + Number(p.find((x) => x.type === 'minute')?.value)
}

/** "YYYY-MM-DDTHH:MM" — the wall clock in `tz`, for a datetime-local field (read from parts, never parsed from a formatted string). */
export function localStamp(at: number, tz: string) {
  const p = dtf(`stamp|${tz}`, () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })).formatToParts(new Date(at))
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '00'
  return `${v('year')}-${v('month')}-${v('day')}T${String(Number(v('hour')) % 24).padStart(2, '0')}:${v('minute')}`
}

/** "2:20 PM" in `tz`. */
export const clock = (at: number | string, tz: string) =>
  dtf(`clk|${tz}`, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })).format(new Date(at))
/** "2 PM" / "2:30 PM" — drops ":00". */
export const clockShort = (at: number | string, tz: string) => clock(at, tz).replace(':00', '')
/** Axis hour label at an instant: "8 AM". */
export const hourAt = (at: number, tz: string) =>
  dtf(`hr|${tz}`, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric' })).format(new Date(at))

const ABBR: Record<string, string> = {
  'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Indiana/Indianapolis': 'ET', 'America/Kentucky/Louisville': 'ET',
  'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Boise': 'MT', 'America/Phoenix': 'MST', 'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT',
}
/** "CT" — the zone as an operator reads it (generic, DST-agnostic). */
export const zoneAbbr = (tz: string | null | undefined) => (!tz ? '' : ABBR[tz] || tz.split('/').pop()?.replace(/_/g, ' ') || tz)
/** "CDT" / "CST" — the zone's name at that instant, for the fine print. */
export const zoneNameAt = (at: number, tz: string) =>
  dtf(`zn|${tz}`, () => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value || zoneAbbr(tz)

export function operatorZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago' } catch { return 'America/Chicago' }
}

/** "3h 12m" / "45m" / "2d 4h" — a duration, never negative. */
export function span(ms: number) {
  const m = Math.max(0, Math.round(ms / MIN))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}
/** "in 3h 12m" / "2h ago" / "now". */
export function relative(at: number, now: number) {
  const d = at - now
  if (Math.abs(d) < MIN) return 'now'
  return d > 0 ? `in ${span(d)}` : `${span(-d)} ago`
}

/** The local hour boundaries (instants) inside [from, to] — DST-correct. */
export function hourTicks(from: number, to: number, tz: string, everyHours = 1) {
  const out: number[] = []
  // Walk instants hour by hour from the first whole local hour; labels come
  // from the zone, so a repeated 1 AM (fall back) appears twice, as it should.
  let t = Math.ceil(from / HOUR) * HOUR
  // Align to local whole hours for zones with half-hour offsets.
  const off = localMinutes(t, tz) % 60
  if (off) t += (60 - off) * MIN
  for (; t <= to; t += HOUR) {
    const h = Math.floor(localMinutes(t, tz) / 60)
    if (h % everyHours === 0) out.push(t)
  }
  return out
}
