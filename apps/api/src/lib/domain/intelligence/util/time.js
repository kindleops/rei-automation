/**
 * IC8 time helpers. Pure.
 *
 * Every IC8 module works in epoch milliseconds internally and writes ISO-8601
 * strings at the edges, so a comparison is never between a Date and a string.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Epoch ms from a number, Date or parseable string; null when absent/invalid. */
export function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function toIso(ms) {
  const value = toMs(ms);
  return value === null ? null : new Date(value).toISOString();
}

/** First non-null epoch ms, e.g. coalesce(sent_at, created_at). */
export function coalesceMs(...values) {
  for (const value of values) {
    const ms = toMs(value);
    if (ms !== null) return ms;
  }
  return null;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_PLAUSIBLE_DATE_MS = Date.UTC(1901, 0, 1);

/**
 * A DATE column (recorded sale, mortgage recording) placed conservatively at
 * the END of its UTC day: a record dated D is treated as knowable only after
 * D is over, so it is visible to a decision at T only when D < T's day.
 * Placeholder dates (before 1901, e.g. the vendor's 1900-01-31) are invalid.
 */
export function dateOnlyEndMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim().slice(0, 10);
  const match = DATE_ONLY_RE.exec(text);
  let startMs;
  if (match) {
    startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  } else {
    const parsed = toMs(value);
    if (parsed === null) return null;
    const d = new Date(parsed);
    startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (!Number.isFinite(startMs) || startMs < MIN_PLAUSIBLE_DATE_MS) return null;
  return startMs + DAY_MS - 1;
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;
const DURATION_UNIT_MS = { ms: 1, s: SECOND_MS, m: MINUTE_MS, h: HOUR_MS, d: DAY_MS };

/** "24h" | "72h" | "7d" | "180000ms" -> ms. Throws on anything else. */
export function parseDurationMs(text) {
  const match = DURATION_RE.exec(String(text ?? "").trim());
  if (!match) throw new TypeError(`parseDurationMs: unsupported duration "${text}"`);
  return Math.round(Number(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()]);
}
