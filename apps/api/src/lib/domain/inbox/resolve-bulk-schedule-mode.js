// ─── resolve-bulk-schedule-mode.js ───────────────────────────────────────────
// Scheduling MODES for bulk follow-ups: best_contact_time | exact | starting_at
// | window.
//
// Owns no scheduling authority of its own. Every mode converts an operator
// choice into a seller-LOCAL wall clock, then hands that instant to the
// canonical resolveInboxSchedule, which applies the same contact-window
// authority the dispatcher uses. Distribution reuses the existing deterministic
// pickMinuteInRange -- a stable hash, never Math.random, so the same selection
// and settings always resolve to the same instant.

import { resolveInboxSchedule, resolveIanaTimezone, localPartsFor }
  from "@/lib/domain/inbox/resolve-inbox-schedule.js";
import { pickMinuteInRange, mapQueueTimezoneToIana, parseQueueContactWindow }
  from "@/lib/domain/queue/queue-schedule.js";

export const SCHEDULE_MODES = Object.freeze(["best_contact_time", "exact", "starting_at", "window"]);

function clean(v) { return String(v ?? "").trim(); }

/**
 * A seller-LOCAL wall clock -> the true UTC instant, using the zone's real
 * offset at that moment. Two correction passes settle DST boundaries; offsets
 * are never hard-coded.
 */
export function zonedWallClockToUtc(dateStr, minutesOfDay, timeZone) {
  const [y, m, d] = clean(dateStr).split("-").map(Number);
  if (!y || !m || !d) return null;
  const hh = Math.floor(minutesOfDay / 60);
  const mm = minutesOfDay % 60;
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = target;
  for (let i = 0; i < 2; i += 1) {
    const p = localPartsFor(new Date(ts), timeZone);
    const actual = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), p.hour, p.minute, 0);
    ts += target - actual;
  }
  return new Date(ts);
}

/** "2:30 PM" / "14:30" -> minutes since midnight. */
export function parseClockToMinutes(value) {
  const raw = clean(value).toUpperCase();
  if (!raw) return null;
  const ampm = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3] === "PM") h += 12;
    return h * 60 + Number(ampm[2] || 0);
  }
  const iso = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (iso) return Number(iso[1]) * 60 + Number(iso[2]);
  return null;
}

/**
 * @param {object} input
 * @param {'best_contact_time'|'exact'|'starting_at'|'window'} input.mode
 * @param {string} [input.date]        YYYY-MM-DD, seller-local
 * @param {string} [input.time]        exact / starting_at
 * @param {string} [input.window_start] window mode
 * @param {string} [input.window_end]   window mode
 * @param {object} input.recipient     { thread_key, timezone, contact_window,
 *                                       routing_timezone, best_contact_window }
 */
export function resolveBulkScheduleMode({ mode = "best_contact_time", date = null, time = null,
  window_start = null, window_end = null, recipient = {}, now = new Date() } = {}) {

  const threadKey = clean(recipient.thread_key);
  // Best Contact Time prefers the master-owner routing timezone and window;
  // manual modes still resolve in the seller's own zone.
  const tzLabel = clean(recipient.routing_timezone) || clean(recipient.timezone);
  const timeZone = resolveIanaTimezone(tzLabel);
  // TWO DIFFERENT WINDOWS, deliberately not merged:
  //
  //   PREFERENCE  master_owners.best_contact_window ("9AM-11AM CT") is inferred
  //               seller intelligence. It OPTIMISES Best Contact Time. It is
  //               not a permission boundary, and an operator choosing 2 PM is
  //               not doing anything disallowed.
  //   HARD RAIL   evaluateContactWindow's 08:00-21:00 local limit plus
  //               compliance/quiet-hour rules. This binds every mode.
  //
  // Passing the preference window as the contact_window made all three manual
  // modes fail whenever the operator picked a time outside it: EXACT 2 PM
  // against a 9-11 AM preference returned contact_window_unresolvable, and
  // WINDOW 2-5 PM returned no_valid_window_overlap. An operator override was
  // being treated as a rule violation.
  const preferenceWindow = clean(recipient.best_contact_window) || clean(recipient.contact_window) || null;
  // Manual modes deliberately pass NO contact_window, so evaluateContactWindow
  // applies the hard rail alone.
  const HARD_OPEN_MINUTES = 8 * 60;
  const HARD_CLOSE_MINUTES = 21 * 60;

  if (mode === "best_contact_time") {
    // Schedule INTO the seller's best contact window rather than "as soon as
    // allowed". parseQueueContactWindow reads the canonical "12PM-1PM ET" form
    // and pickMinuteInRange places each seller deterministically inside it, so
    // two sellers with different windows genuinely differ.
    const parsed = parseQueueContactWindow(preferenceWindow);
    const lo = parsed?.start ?? 9 * 60;
    const hi = Math.max(lo, parsed?.end ?? 20 * 60);
    const minute = pickMinuteInRange(lo, hi, threadKey, "best_contact_time");

    // Today if that minute is still ahead of us in the seller's zone, else the
    // next day -- never a time already past.
    const nowParts = localPartsFor(now, timeZone);
    const nowMinutes = nowParts.hour * 60 + nowParts.minute;
    let dayOffset = minute > nowMinutes + 1 ? 0 : 1;
    const base = new Date(now.getTime() + dayOffset * 86_400_000);
    const dayParts = localPartsFor(base, timeZone);
    const localUtc = zonedWallClockToUtc(dayParts.date, minute, timeZone);
    if (!localUtc) return { ok: false, mode, reason: "invalid_date" };

    const resolved = resolveInboxSchedule({
      requested_at: localUtc.toISOString(), timezone: tzLabel,
      contact_window: preferenceWindow, now,
    });
    return { ok: resolved.ok, mode, ...resolved,
      requested_local_minutes: minute, contact_window_used: preferenceWindow };
  }

  if (!date) return { ok: false, mode, reason: "missing_date" };

  if (mode === "exact" || mode === "starting_at") {
    const minutes = parseClockToMinutes(time);
    if (minutes == null) return { ok: false, mode, reason: "missing_time" };

    let targetMinutes = minutes;
    if (mode === "starting_at") {
      // Deterministic stagger AT OR AFTER the requested start, bounded by the
      // end of the local send day. Same key => same offset, every render.
      // Bounded by the HARD close only; the preference window must not pull a
      // deliberate operator start time back.
      const ceiling = Math.max(minutes, HARD_CLOSE_MINUTES);
      targetMinutes = pickMinuteInRange(minutes, ceiling, threadKey, "starting_at");
    }

    const localUtc = zonedWallClockToUtc(date, targetMinutes, timeZone);
    if (!localUtc) return { ok: false, mode, reason: "invalid_date" };
    const resolved = resolveInboxSchedule({
      requested_at: localUtc.toISOString(), timezone: tzLabel,
      contact_window: null, now,
    });
    return { ok: resolved.ok, mode, ...resolved,
      requested_local_minutes: targetMinutes,
      preference_window: preferenceWindow, honours_preference: false };
  }

  if (mode === "window") {
    const start = parseClockToMinutes(window_start);
    const end = parseClockToMinutes(window_end);
    if (start == null || end == null) return { ok: false, mode, reason: "missing_window_bounds" };
    if (end <= start) return { ok: false, mode, reason: "window_end_before_start" };

    // Intersect the operator's window with the seller's canonical contact
    // window. Scheduling outside the chosen range is never silently allowed.
    // Intersect with the HARD permitted hours only. A window that merely
    // disagrees with the seller's inferred preference is still schedulable.
    const lo = Math.max(start, HARD_OPEN_MINUTES);
    const hi = Math.min(end, HARD_CLOSE_MINUTES);
    if (hi <= lo) {
      return { ok: false, mode, reason: "no_valid_window_overlap",
        requested_window: [start, end], hard_window: [HARD_OPEN_MINUTES, HARD_CLOSE_MINUTES] };
    }

    const minute = pickMinuteInRange(lo, hi, threadKey, "window");
    const localUtc = zonedWallClockToUtc(date, minute, timeZone);
    if (!localUtc) return { ok: false, mode, reason: "invalid_date" };
    const resolved = resolveInboxSchedule({
      requested_at: localUtc.toISOString(), timezone: tzLabel,
      contact_window: null, now,
    });
    return { ok: resolved.ok, mode, ...resolved,
      requested_local_minutes: minute, overlap_window: [lo, hi],
      preference_window: preferenceWindow, honours_preference: false };
  }

  return { ok: false, mode, reason: "unsupported_mode" };
}

export default resolveBulkScheduleMode;
