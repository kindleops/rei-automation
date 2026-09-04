// ─── resolve-inbox-schedule.js ───────────────────────────────────────────────
// Schedule-time resolution for operator-chosen Inbox follow-ups.
//
// The operator picks an instant in the Inbox. Before that instant is persisted
// we resolve it through the SAME authority the dispatcher uses at send time
// (`evaluateContactWindow`), so the time the UI promises and the time the
// message actually leaves can never diverge. If the requested instant falls in
// the recipient's quiet hours we persist the next eligible instant instead and
// report it back, rather than confirming a time we know we will silently defer.
//
// This module owns NO timezone math of its own. IANA resolution comes from
// `mapQueueTimezoneToIana`, window/next-open comes from `evaluateContactWindow`,
// and local wall-clock parts come from Intl with the resolved zone. The
// dispatch-time gate remains in place as defense in depth.

import { evaluateContactWindow } from "@/lib/supabase/sms-engine.js";
import { mapQueueTimezoneToIana } from "@/lib/domain/queue/queue-schedule.js";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Resolve a raw timezone value (label or IANA) to a usable IANA zone.
 * Labels ("Central") go through the canonical queue mapper. Values that already
 * look like IANA are validated against Intl and used directly, so rows that
 * already carry "America/New_York" are not flattened to the Central default.
 */
export function resolveIanaTimezone(value) {
  const raw = clean(value);
  if (!raw) return "America/Chicago";

  if (raw.includes("/")) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date());
      return raw;
    } catch {
      /* not a valid IANA zone — fall through to the label mapper */
    }
  }

  return mapQueueTimezoneToIana(raw);
}

/**
 * Local wall-clock parts for an instant in a given zone.
 * Used to populate local_send_date / local_send_hour truthfully.
 */
export function localPartsFor(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);

  const get = (type) => parts.find((entry) => entry.type === type)?.value || "00";
  // Intl renders midnight as hour 24 in some ICU versions; normalize to 0.
  const hour = Number(get("hour")) % 24;

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: Number(get("minute")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function formatLocalLabel(parts) {
  const meridiem = parts.hour >= 12 ? "PM" : "AM";
  let hour12 = parts.hour % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}:${String(parts.minute).padStart(2, "0")} ${meridiem}`;
}

/**
 * @param {object} input
 * @param {string|Date} input.requested_at  Operator-chosen instant (UTC ISO).
 * @param {string} [input.timezone]         Recipient timezone (label or IANA).
 * @param {string} [input.contact_window]   Row contact window, e.g. "9AM-8PM CT".
 * @param {string|Date} [input.now]         Clock, for tests.
 * @param {Function} [input.evaluate]       Injectable window authority, for tests.
 */
export function resolveInboxSchedule({
  requested_at,
  timezone = null,
  contact_window = null,
  now = new Date(),
  evaluate = evaluateContactWindow,
} = {}) {
  const requested = requested_at instanceof Date ? requested_at : new Date(clean(requested_at));
  if (!requested_at || Number.isNaN(requested.getTime())) {
    return { ok: false, reason: "invalid_requested_at" };
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const safeNow = Number.isNaN(nowDate.getTime()) ? new Date() : nowDate;

  if (requested.getTime() <= safeNow.getTime()) {
    return { ok: false, reason: "requested_at_in_past" };
  }

  const timezone_iana = resolveIanaTimezone(timezone);

  // Same authority the dispatcher runs, evaluated AS OF the requested instant.
  const windowResult = evaluate(
    { timezone: timezone_iana, contact_window: clean(contact_window) || null },
    { now: requested }
  );

  const allowed = windowResult?.allowed === true;
  let effective = requested;
  let deferred = false;
  let deferral_reason = null;

  if (!allowed) {
    const next = clean(windowResult?.next_open_at) || clean(windowResult?.next_eligible_at);
    const nextDate = next ? new Date(next) : null;
    if (!nextDate || Number.isNaN(nextDate.getTime())) {
      // The authority declined but could not name a next opening. Refuse rather
      // than persisting the operator's quiet-hours instant as if it were valid.
      return {
        ok: false,
        reason: "contact_window_unresolvable",
        timezone_iana,
        underlying_reason: clean(windowResult?.reason) || null,
      };
    }
    effective = nextDate;
    deferred = true;
    deferral_reason = clean(windowResult?.reason) || "outside_local_send_window";
  }

  const requestedParts = localPartsFor(requested, timezone_iana);
  const effectiveParts = localPartsFor(effective, timezone_iana);

  return {
    ok: true,
    deferred,
    deferral_reason,
    timezone_input: clean(timezone) || null,
    timezone_iana,
    contact_window: clean(contact_window) || null,

    requested_utc: requested.toISOString(),
    requested_local_date: requestedParts.date,
    requested_local_hour: requestedParts.hour,
    requested_local_label: formatLocalLabel(requestedParts),

    // Persisted columns — all six describe the SAME effective instant.
    //
    // scheduled_for_local stays a TRUE instant rather than a naive wall clock.
    // `normalizeSendQueueRow` resolves the due-time gate through the fallback
    // chain scheduled_for -> scheduled_for_utc -> scheduled_for_local, so a
    // naive local string parked here would be read back as UTC and could make a
    // message due hours EARLY (9:17 AM Pacific stored naive = 2:17 AM Pacific).
    // Local wall-clock truth is carried by local_send_date + local_send_hour +
    // timezone, which is what "when does the seller receive this" should read.
    scheduled_for: effective.toISOString(),
    scheduled_for_utc: effective.toISOString(),
    scheduled_for_local: effective.toISOString(),
    timezone: timezone_iana,
    local_send_date: effectiveParts.date,
    local_send_hour: effectiveParts.hour,

    // Derived, not persisted (there is no local_send_minute column): the exact
    // local wall clock, recomputable from scheduled_for_utc + timezone.
    effective_local_minute: effectiveParts.minute,
    effective_local_wall: `${effectiveParts.date} ${String(effectiveParts.hour).padStart(2, "0")}:${String(effectiveParts.minute).padStart(2, "0")}`,

    effective_local_label: formatLocalLabel(effectiveParts),
  };
}

export default resolveInboxSchedule;
