/**
 * Scheduling core — time zone arithmetic.
 *
 * Every persisted instant is UTC (timestamptz). Wall-clock values ("09:00 on
 * 2026-11-01 in America/Chicago") are converted through the IANA database via
 * Intl, never by adding fixed offsets, so DST transitions are handled:
 *   - a wall time skipped by spring-forward does not exist and yields null;
 *   - a wall time repeated by fall-back resolves to its FIRST occurrence.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const partsCache = new Map();
function formatter(tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    formatter(tz).format(0);
    return true;
  } catch {
    return false;
  }
}

const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall-clock parts of an instant in a zone. weekday is ISO (1 = Monday). */
export function zonedParts(instant, tz) {
  const parts = formatter(tz).formatToParts(new Date(instant));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: WD[get('weekday')],
  };
}

/** Offset (ms) of the zone from UTC at an instant. */
export function zoneOffsetMs(instant, tz) {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (Math.floor(new Date(instant).getTime() / 1000) * 1000);
}

const wallCache = new Map();

/**
 * The instant at which the wall clock in `tz` reads date + time, or null when
 * that wall time does not exist (spring-forward gap).
 */
export function wallTimeToInstant(dateStr, time, tz) {
  // Pure in (date, time, zone) — memoized; zone rules do not change at runtime.
  const key = `${tz}|${dateStr}|${time}`;
  if (wallCache.has(key)) {
    const v = wallCache.get(key);
    return v == null ? null : new Date(v);
  }
  const result = computeWallTime(dateStr, time, tz);
  if (wallCache.size > 50_000) wallCache.clear();
  wallCache.set(key, result ? result.getTime() : null);
  return result;
}

function computeWallTime(dateStr, time, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Two candidate offsets: the one before and after any transition near here.
  const candidates = [...new Set([zoneOffsetMs(naive - DAY / 2, tz), zoneOffsetMs(naive + DAY / 2, tz)])]
    .map((offset) => naive - offset)
    .filter((t) => {
      const p = zonedParts(t, tz);
      return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi;
    })
    .sort((a, b) => a - b);
  return candidates.length ? new Date(candidates[0]) : null;
}

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDate(instant, tz) {
  const p = zonedParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Calendar dates (YYYY-MM-DD) in `tz` covering [from, to]. */
export function localDatesBetween(from, to, tz) {
  const out = [];
  const end = localDate(to, tz);
  let cursor = localDate(from, tz);
  let guard = 0;
  while (cursor <= end && guard++ < 400) {
    out.push(cursor);
    const [y, m, d] = cursor.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    cursor = next.toISOString().slice(0, 10);
  }
  return out;
}

/** ISO weekday (1 = Monday) of a calendar date. */
export function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Short zone label (EDT / CST / GMT+1) for an instant, for display. */
export function zoneAbbreviation(instant, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(instant));
  return p.find((x) => x.type === 'timeZoneName')?.value ?? tz;
}

export const TIME = { MIN, DAY };
