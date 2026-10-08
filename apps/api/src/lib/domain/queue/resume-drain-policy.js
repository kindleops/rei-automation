// ─── resume-drain-policy.js ──────────────────────────────────────────────────
// P1 (owner, 2026-10-08): when queue_processor_mode goes back to live, no
// backlog may auto-flush. Today's lifecycle reconcile never stale-expires a
// scheduled / queued row (sms-engine.js isRowEligibleForStaleExpiration:
// "never stale-expire scheduled or queued rows"), so every overdue row would
// be claimable at once, bounded only by batch size and caps.
//
// This is the pure per-row decision for a RESUME DRAIN. NOT WIRED: the
// intended caller is a 'resume_drain' pass run once before the runner claims
// rows (it needs the dispatch-path change the owner approves). Every row it
// lets through is still re-gated individually at dispatch (send-time guard,
// caps, pacing, contact window) — this policy only decides send / re-plan /
// re-evaluate / hold, and never touches sender, campaign or template fields.
//
//   auto-reply / reply      overdue > REPLY_STALE_MIN  -> reevaluate (never send a stale reply)
//   manual operator send    overdue > MANUAL_STALE_MIN -> hold_for_operator
//   follow-up / nurture     overdue > FOLLOWUP_STALE_H -> replan
//   campaign / other        overdue > OPENER_STALE_H   -> replan
//   otherwise               send (normal claim; still re-gated)
// replan = the next opening of the recipient-local 08:00–21:00 window, with a
// deterministic per-row jitter, never earlier than the thread's previous
// planned row (per-thread order preserved).

export const RESUME_DRAIN_POLICY_VERSION = "resume_drain.v1.2026-10-08";
export const RESUME_DEFAULTS = Object.freeze({
  REPLY_STALE_MIN: 15,
  MANUAL_STALE_MIN: 30,
  FOLLOWUP_STALE_H: 6,
  OPENER_STALE_H: 2,
  WINDOW_START_H: 8,
  WINDOW_END_H: 21,
  JITTER_MIN: 90,
});

const clean = (v) => String(v ?? "").trim();
const lower = (v) => clean(v).toLowerCase();

export function rowKind(row = {}) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const kinds = [row.type, row.message_type, meta.type, meta.source, row.use_case_template].map(lower).join(" ");
  if (/manual|send_now|inbox_reply/.test(kinds)) return "manual";
  if (/auto_reply|autopilot|reply|clarifier/.test(kinds)) return "reply";
  if (/follow|nurture/.test(kinds) || lower(meta.followup_reason)) return "followup";
  return "opener";
}

function hash01(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h % 10000) / 10000;
}

/** Local hour/minute in an IANA zone (default America/Chicago). */
function localParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

/** The first instant >= ms inside the recipient-local window (minute resolution). */
export function nextWindowOpening(ms, timeZone = "America/Chicago", { start = RESUME_DEFAULTS.WINDOW_START_H, end = RESUME_DEFAULTS.WINDOW_END_H } = {}) {
  let t = Math.ceil(ms / 60000) * 60000;
  for (let i = 0; i < 48 * 4; i += 1) {
    const { hour } = localParts(t, timeZone);
    if (hour >= start && hour < end) return t;
    t += 15 * 60000;
  }
  return t;
}

export function inLocalWindow(ms, timeZone = "America/Chicago", { start = RESUME_DEFAULTS.WINDOW_START_H, end = RESUME_DEFAULTS.WINDOW_END_H } = {}) {
  const { hour } = localParts(ms, timeZone);
  return hour >= start && hour < end;
}

/**
 * rows: overdue unsent rows. Returns [{ id, action, reason, scheduled_for_utc? }]
 * in input order; replans per thread are monotonic in the thread's order.
 */
export function planResumeDrain(rows = [], { now = Date.now(), config = RESUME_DEFAULTS } = {}) {
  const c = { ...RESUME_DEFAULTS, ...config };
  const lastPerThread = new Map();
  const ordered = [...rows].sort((a, b) => Date.parse(a.scheduled_for_utc || a.scheduled_for || a.created_at || 0) - Date.parse(b.scheduled_for_utc || b.scheduled_for || b.created_at || 0) || clean(a.id).localeCompare(clean(b.id)));
  const out = new Map();
  for (const row of ordered) {
    const due = Date.parse(row.scheduled_for_utc || row.scheduled_for || row.created_at || "");
    const overdue_min = Number.isFinite(due) ? (now - due) / 60000 : Infinity;
    const kind = rowKind(row);
    const thread = clean(row.thread_key || row.to_phone_number);
    const tz = clean(row.timezone) || "America/Chicago";
    let decision;
    if (overdue_min <= 0) decision = { action: "send", reason: "not_overdue" };
    else if (kind === "reply" && overdue_min > c.REPLY_STALE_MIN) decision = { action: "reevaluate", reason: "stale_reply" };
    else if (kind === "manual" && overdue_min > c.MANUAL_STALE_MIN) decision = { action: "hold_for_operator", reason: "stale_manual_send" };
    else if (kind === "followup" && overdue_min > c.FOLLOWUP_STALE_H * 60) decision = { action: "replan", reason: "stale_followup" };
    else if (kind === "opener" && overdue_min > c.OPENER_STALE_H * 60) decision = { action: "replan", reason: "stale_opener" };
    else decision = { action: "send", reason: "within_tolerance" };
    if (decision.action === "send" && !inLocalWindow(now, tz, { start: c.WINDOW_START_H, end: c.WINDOW_END_H })) {
      decision = { action: "replan", reason: "outside_local_window" };
    }
    if (decision.action === "replan") {
      const base = nextWindowOpening(Math.max(now, lastPerThread.get(thread) ?? 0), tz, { start: c.WINDOW_START_H, end: c.WINDOW_END_H });
      let at = base + Math.floor(hash01(clean(row.id)) * c.JITTER_MIN) * 60000;
      if (!inLocalWindow(at, tz, { start: c.WINDOW_START_H, end: c.WINDOW_END_H })) at = base;
      const prev = lastPerThread.get(thread);
      if (prev != null && at <= prev) at = prev + 60000;
      lastPerThread.set(thread, at);
      decision.scheduled_for_utc = new Date(at).toISOString();
    } else if (decision.action === "send") {
      lastPerThread.set(thread, Math.max(now, lastPerThread.get(thread) ?? 0));
    }
    out.set(row.id, { id: row.id, kind, ...decision, version: RESUME_DRAIN_POLICY_VERSION });
  }
  return rows.map((r) => out.get(r.id));
}

export default planResumeDrain;
