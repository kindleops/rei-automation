// Contact window for the missed-call text: 08:00 <= local < 21:00 in the
// CALLER's time zone (owner rule 2026-10-05, same hard window the queue
// processor enforces at dispatch).
//
// When the caller's zone is known (their property's geography, or a zone stored
// on the thread) we use it. When it is NOT known we do not guess one zone: the
// text is only placed at a moment that is inside the window in EVERY
// continental US zone (i.e. 8 AM Pacific .. 9 PM Eastern), so it cannot land at
// 7 AM or 10 PM for anyone.

export const WINDOW_START_MINUTES = 8 * 60;
export const WINDOW_END_MINUTES = 21 * 60; // exclusive

export const CONTINENTAL_US_ZONES = Object.freeze([
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
]);

function minutesOfDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function isValidTimeZone(zone) {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function insideWindow(date, zones) {
  return zones.every((zone) => {
    const m = minutesOfDay(date, zone);
    return m >= WINDOW_START_MINUTES && m < WINDOW_END_MINUTES;
  });
}

/**
 * @returns {{ send_now: boolean, scheduled_for: string, zones: string[], basis: string }}
 *   scheduled_for is `now` when inside the window, else the next window open.
 */
export function planMissedCallSendTime({ now = new Date(), timezone = null } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const zones = isValidTimeZone(timezone) ? [timezone] : [...CONTINENTAL_US_ZONES];
  const basis = isValidTimeZone(timezone) ? "caller_timezone" : "continental_us_intersection";

  if (insideWindow(at, zones)) {
    return { send_now: true, scheduled_for: at.toISOString(), zones, basis };
  }

  // Walk forward on 5-minute boundaries (every US offset is a multiple of 15)
  // until the window is open in all zones. 48 h is far more than one night.
  const step = 5 * 60 * 1000;
  let probe = Math.ceil(at.getTime() / step) * step;
  const limit = at.getTime() + 48 * 60 * 60 * 1000;
  while (probe <= limit) {
    const d = new Date(probe);
    if (insideWindow(d, zones)) {
      return { send_now: false, scheduled_for: d.toISOString(), zones, basis };
    }
    probe += step;
  }
  // Unreachable for real zones; fail toward not sending now.
  return { send_now: false, scheduled_for: null, zones, basis };
}

export function formatLocalTime(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default { planMissedCallSendTime, insideWindow, formatLocalTime, CONTINENTAL_US_ZONES };
