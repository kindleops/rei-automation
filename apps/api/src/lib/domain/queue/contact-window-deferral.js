// ─── contact-window-deferral.js ──────────────────────────────────────────────
// Outside contact hours: classify/facts proceed, but outbound is scheduled
// deferred with next_eligible_at — never ambiguously "queued" without reason.

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Compute the next eligible local send datetime from a contact-window evaluation.
 * @param {{ allowed: boolean, reason?: string, timezone?: string, next_open_at?: string|null, window?: { start?: string, end?: string } }} windowResult
 * @param {string|Date} [now]
 */
/**
 * Best-effort next local open (08:00) in an IANA timezone when the provider
 * did not supply next_open_at.
 */
export function computeNextLocalOpenAt({
  timezone = "America/Chicago",
  open_hour = 8,
  now = new Date(),
} = {}) {
  try {
    const tz = clean(timezone) || "America/Chicago";
    const base = now instanceof Date ? now : new Date(now);
    const probe = new Date(base.getTime());
    const open_minutes = Number(open_hour) * 60;
    for (let i = 0; i < 200; i += 1) {
      probe.setUTCMinutes(probe.getUTCMinutes() + 15);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(probe);
      const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
      const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
      const minutes = hour * 60 + minute;
      if (minutes >= open_minutes && minutes < open_minutes + 15) {
        const overshoot = minutes - open_minutes;
        return new Date(probe.getTime() - overshoot * 60_000).toISOString();
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function buildContactWindowDeferral(windowResult = {}, now = new Date()) {
  const allowed = windowResult?.allowed === true;
  if (allowed) {
    return {
      deferred: false,
      reason: null,
      next_eligible_at: null,
      queue_status: "queued",
    };
  }

  const reason = clean(windowResult.reason) || "outside_local_send_window";
  let next =
    clean(windowResult.next_open_at) ||
    clean(windowResult.next_eligible_at) ||
    null;
  if (!next) {
    next = computeNextLocalOpenAt({
      timezone: windowResult.timezone || "America/Chicago",
      open_hour: 8,
      now,
    });
  }

  return {
    deferred: true,
    reason: "deferred_contact_window",
    underlying_reason: reason,
    next_eligible_at: next,
    timezone: clean(windowResult.timezone) || null,
    queue_status: "scheduled",
    metadata: {
      deferred_contact_window: true,
      next_eligible_at: next,
      contact_window_block_reason: reason,
      scheduled_reason: "deferred_contact_window",
    },
  };
}

export default buildContactWindowDeferral;
