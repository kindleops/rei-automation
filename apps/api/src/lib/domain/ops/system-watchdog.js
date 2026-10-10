// ─── system-watchdog.js ──────────────────────────────────────────────────────
// The 24/7 SYSTEM WATCHDOG (owner P0 2026-10-10: "let Haiku monitor the system
// 24/7: messages going out, leads followed up, inbox clean").
//
// Deterministic first: one read-only snapshot query, pure rules, alerts through
// the existing launch-safety alert path (notification_events -> push / Discord
// / alert centre, deduplicated per code). It NEVER writes business state and
// NEVER sends a seller message. An LLM summary is optional and not required
// for any alert to fire.
//
// FLAG: SYSTEM_WATCHDOG_MODE = off (default) | observe | alert
//   off      the route answers 200 { mode: "off" } and reads nothing
//   observe  snapshot + findings returned, no alert written
//   alert    findings recorded as alerts; codes that cleared are resolved
//
// Rules (thresholds overridable via env WATCHDOG_<NAME>):
//   sends_stalled            due sends waiting > STALL_MINUTES while outbound is
//                            enabled and nothing was sent in that window
//   followups_overdue        nurture/follow-up threads past follow_up_at by > 24 h
//                            with no pending send (not suppressed)
//   auto_replies_blocked     blocked / duplicate-blocked auto-replies in the last
//                            hour > BLOCKED_PER_HOUR
//   inbox_null_bucket        recently-touched threads with a NULL stored bucket
//   priority_price_gap       Priority holding an absurd ask (must be 0)
//   db_load_high             active connections / long-running queries
//   failures_spike           failed sends in the last hour above FAILURE_RATE of
//                            attempts (min volume)
//   inbound_unprocessed      inbound in the last 2 h with no classification

import { queryWithTimeout } from "@/lib/postgres/client.js";
import {
  recordLaunchCriticalAlert,
  resolveLaunchCriticalAlert,
} from "@/lib/domain/alerts/launch-critical-alerts.js";

export const WATCHDOG_VERSION = "system_watchdog_v1";
export const WATCHDOG_SUBSYSTEM = "system_watchdog";

export const WATCHDOG_CODES = Object.freeze({
  SENDS_STALLED: "watchdog_sends_stalled",
  FOLLOWUPS_OVERDUE: "watchdog_followups_overdue",
  AUTO_REPLIES_BLOCKED: "watchdog_auto_replies_blocked",
  INBOX_NULL_BUCKET: "watchdog_inbox_null_bucket",
  PRIORITY_PRICE_GAP: "watchdog_priority_price_gap",
  DB_LOAD_HIGH: "watchdog_db_load_high",
  FAILURES_SPIKE: "watchdog_failures_spike",
  INBOUND_UNPROCESSED: "watchdog_inbound_unprocessed",
});

export const DEFAULT_THRESHOLDS = Object.freeze({
  STALL_MINUTES: 30,
  FOLLOWUPS_OVERDUE_MAX: 0,
  BLOCKED_PER_HOUR: 10,
  NULL_BUCKET_MAX: 0,
  ACTIVE_CONNECTIONS_MAX: 60,
  LONG_QUERY_SECONDS: 60,
  LONG_QUERIES_MAX: 3,
  FAILURE_RATE: 0.2,
  FAILURE_MIN_ATTEMPTS: 20,
  INBOUND_UNPROCESSED_MAX: 0,
});

export function resolveWatchdogMode(env = process.env) {
  const m = String(env.SYSTEM_WATCHDOG_MODE ?? "").trim().toLowerCase();
  return m === "observe" || m === "alert" ? m : "off";
}

export function resolveThresholds(env = process.env) {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(out)) {
    const v = Number(env[`WATCHDOG_${k}`]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/**
 * ONE read-only statement (every metric is a scalar subquery). Uses only
 * indexed time windows; the price-gap count reads the bucket view's Priority.
 */
export const WATCHDOG_SNAPSHOT_SQL = `
select
  (select count(*) from send_queue where queue_status in ('queued','scheduled','ready','approved')
      and coalesce(scheduled_for_utc, scheduled_for) < now() - make_interval(mins => $1::int)) as sends_due_waiting,
  (select max(sent_at) from send_queue where sent_at > now() - interval '7 days') as last_sent_at,
  (select count(*) from send_queue where sent_at > now() - make_interval(mins => $1::int)) as sent_in_window,
  (select count(*) from inbox_thread_state t
     where t.follow_up_at < now() - interval '24 hours' and t.follow_up_at > now() - interval '60 days'
       and coalesce(t.is_suppressed, false) = false
       and lower(coalesce(t.inbox_bucket, '')) = 'follow_up'
       and not exists (select 1 from send_queue q where q.thread_key = t.thread_key
                        and q.queue_status in ('queued','scheduled','ready','approved','pending','processing'))) as followups_overdue,
  (select count(*) from send_queue where created_at > now() - interval '1 hour'
      and queue_status in ('blocked','duplicate_blocked','held')) as auto_replies_blocked_1h,
  (select count(*) from inbox_thread_state where inbox_bucket is null and updated_at > now() - interval '24 hours'
      and coalesce(is_archived, false) = false) as null_bucket_24h,
  (select count(*) from v_inbox_thread_state_buckets where in_priority
      and (lower(coalesce(last_intent, '')) = 'asking_price_implausible'
           or coalesce(reason_codes, '[]'::jsonb) ? 'price_far_above_value')) as priority_price_gap,
  (select count(*) from pg_stat_activity where state = 'active') as active_connections,
  (select count(*) from pg_stat_activity where state = 'active'
      and now() - query_start > make_interval(secs => $2::int)) as long_queries,
  (select count(*) from send_queue where updated_at > now() - interval '1 hour'
      and queue_status in ('failed','failed_transport')) as failed_1h,
  (select count(*) from send_queue where updated_at > now() - interval '1 hour'
      and queue_status in ('sent','delivered','failed','failed_transport')) as attempts_1h,
  (select count(*) from message_events where direction = 'inbound'
      and created_at > now() - interval '2 hours' and created_at < now() - interval '10 minutes'
      and detected_intent is null) as inbound_unprocessed_2h
`;

const n = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Pure rules over a snapshot. A metric that could not be read (null) never
 * fires and never resolves: unknown is unknown.
 * @param {object} snap  snapshot row (+ outbound_enabled boolean|null)
 * @returns {{ findings: object[], clear: string[], unknown: string[] }}
 */
export function evaluateWatchdog(snap = {}, thresholds = DEFAULT_THRESHOLDS, nowMs = Date.now()) {
  const T = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const findings = [];
  const clear = [];
  const unknown = [];
  const rule = (code, known, firing, severity, summary, metadata) => {
    if (!known) return unknown.push(code);
    if (firing) findings.push({ code, severity, summary, metadata });
    else clear.push(code);
  };

  const due = n(snap.sends_due_waiting);
  const sentWin = n(snap.sent_in_window);
  // The P0 outbound pause (mode=off) is not a stall.
  const outboundOn = snap.outbound_enabled === true;
  rule(WATCHDOG_CODES.SENDS_STALLED, due !== null && sentWin !== null && snap.outbound_enabled !== null && snap.outbound_enabled !== undefined,
    outboundOn && due > 0 && sentWin === 0, "critical",
    `${due} due sends waiting more than ${T.STALL_MINUTES} min and nothing sent`, { sends_due_waiting: due, last_sent_at: snap.last_sent_at || null });

  const overdue = n(snap.followups_overdue);
  rule(WATCHDOG_CODES.FOLLOWUPS_OVERDUE, overdue !== null, overdue > T.FOLLOWUPS_OVERDUE_MAX, "warning",
    `${overdue} follow-ups overdue by more than 24 h with nothing scheduled`, { followups_overdue: overdue });

  const blocked = n(snap.auto_replies_blocked_1h);
  rule(WATCHDOG_CODES.AUTO_REPLIES_BLOCKED, blocked !== null, blocked > T.BLOCKED_PER_HOUR, "warning",
    `${blocked} auto-replies blocked in the last hour`, { auto_replies_blocked_1h: blocked });

  const nul = n(snap.null_bucket_24h);
  rule(WATCHDOG_CODES.INBOX_NULL_BUCKET, nul !== null, nul > T.NULL_BUCKET_MAX, "warning",
    `${nul} inbox threads touched in 24 h have no stored bucket`, { null_bucket_24h: nul });

  const gap = n(snap.priority_price_gap);
  rule(WATCHDOG_CODES.PRIORITY_PRICE_GAP, gap !== null, gap > 0, "warning",
    `${gap} Priority threads hold an ask far above the property's value`, { priority_price_gap: gap });

  const act = n(snap.active_connections);
  const longQ = n(snap.long_queries);
  rule(WATCHDOG_CODES.DB_LOAD_HIGH, act !== null && longQ !== null,
    act > T.ACTIVE_CONNECTIONS_MAX || longQ > T.LONG_QUERIES_MAX, "critical",
    `DB load: ${act} active connections, ${longQ} queries running > ${T.LONG_QUERY_SECONDS}s`, { active_connections: act, long_queries: longQ });

  const failed = n(snap.failed_1h);
  const attempts = n(snap.attempts_1h);
  const rate = attempts ? failed / attempts : 0;
  rule(WATCHDOG_CODES.FAILURES_SPIKE, failed !== null && attempts !== null,
    attempts >= T.FAILURE_MIN_ATTEMPTS && rate > T.FAILURE_RATE, "critical",
    `${failed} of ${attempts} send attempts failed in the last hour (${Math.round(rate * 100)}%)`, { failed_1h: failed, attempts_1h: attempts });

  const unproc = n(snap.inbound_unprocessed_2h);
  rule(WATCHDOG_CODES.INBOUND_UNPROCESSED, unproc !== null, unproc > T.INBOUND_UNPROCESSED_MAX, "warning",
    `${unproc} inbound replies in the last 2 h were never classified`, { inbound_unprocessed_2h: unproc });

  void nowMs;
  return { findings, clear, unknown };
}

/** A short plain-text digest (deterministic; an LLM summary can wrap it). */
export function summarizeWatchdog({ findings = [], unknown = [] } = {}) {
  if (!findings.length) return unknown.length ? `All clear (${unknown.length} checks unreadable)` : "All clear";
  return findings.map((f) => `[${f.severity}] ${f.summary}`).join("\n");
}

/**
 * Read the snapshot. Never throws: a failed read yields an empty snapshot,
 * which makes every rule "unknown" (no alert, no resolve) plus a
 * read-failure flag the caller reports.
 */
export async function collectWatchdogSnapshot({ thresholds = DEFAULT_THRESHOLDS, query = queryWithTimeout, readOutboundEnabled = null } = {}) {
  let row = {};
  let read_error = null;
  try {
    const res = await query(WATCHDOG_SNAPSHOT_SQL, [thresholds.STALL_MINUTES, thresholds.LONG_QUERY_SECONDS], 10_000);
    row = (res?.rows || res || [])[0] || {};
  } catch (e) {
    read_error = String(e?.message || "snapshot_failed").slice(0, 200);
  }
  let outbound_enabled = null;
  if (typeof readOutboundEnabled === "function") {
    try {
      outbound_enabled = await readOutboundEnabled();
    } catch {
      outbound_enabled = null;
    }
  }
  return { ...row, outbound_enabled, read_error };
}

export async function runSystemWatchdog(deps = {}) {
  const env = deps.env || process.env;
  const mode = deps.mode || resolveWatchdogMode(env);
  if (mode === "off") return { ok: true, mode, version: WATCHDOG_VERSION, findings: [], skipped: true };
  const thresholds = resolveThresholds(env);
  const snapshot = deps.snapshot || await collectWatchdogSnapshot({ thresholds, query: deps.query, readOutboundEnabled: deps.readOutboundEnabled });
  const result = evaluateWatchdog(snapshot, thresholds, deps.nowMs || Date.now());
  const record = deps.recordAlert || recordLaunchCriticalAlert;
  const resolve = deps.resolveAlert || resolveLaunchCriticalAlert;
  const written = [];
  if (mode === "alert") {
    for (const f of result.findings) {
      written.push(await record({
        code: f.code, subsystem: WATCHDOG_SUBSYSTEM, severity: f.severity, summary: f.summary,
        metadata: { ...f.metadata, watchdog_version: WATCHDOG_VERSION },
        dedupe_key: `launch_safety:${WATCHDOG_SUBSYSTEM}:${f.code}`,
      }));
    }
    for (const code of result.clear) {
      await resolve({ code, subsystem: WATCHDOG_SUBSYSTEM, dedupe_key: `launch_safety:${WATCHDOG_SUBSYSTEM}:${code}` });
    }
  }
  return {
    ok: !snapshot.read_error,
    mode,
    version: WATCHDOG_VERSION,
    read_error: snapshot.read_error || null,
    findings: result.findings,
    clear: result.clear,
    unknown: result.unknown,
    summary: summarizeWatchdog(result),
    alerts_written: written.length,
  };
}

export default { runSystemWatchdog, evaluateWatchdog, collectWatchdogSnapshot, WATCHDOG_CODES, WATCHDOG_SNAPSHOT_SQL };
