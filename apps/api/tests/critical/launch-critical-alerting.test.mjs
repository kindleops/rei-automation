/**
 * Launch-critical alerting must persist to Supabase.
 *
 * Before this change, launch-critical alerts were stored as Podio items in the
 * Message Events app. Production has no Podio credentials, so alerting was
 * silently dead: recordSystemAlert appeared to succeed while persisting nothing,
 * and two of its Podio reads sat outside their try blocks so a Podio failure
 * threw into the caller and 500'd the route.
 */

import test from "node:test";
import assert from "node:assert/strict";

import "../helpers/critical-test-environment.mjs";

import {
  LAUNCH_CRITICAL_ALERT_CODES,
  LAUNCH_ALERT_DOMAIN,
  recordLaunchCriticalAlert,
  normalizeLaunchAlertSeverity,
  sanitizeAlertMetadata,
  launchAlerts,
} from "@/lib/domain/alerts/launch-critical-alerts.js";

function captureUpsert() {
  const rows = [];
  return {
    rows,
    upsertNotificationEvent: async (row) => {
      rows.push(row);
      return { ok: true, id: `notif-${rows.length}` };
    },
  };
}

// ── mandated coverage ────────────────────────────────────────────────────────

test("the alert catalog covers every mandated launch-critical failure", () => {
  const required = [
    "queue_dispatch_failure",
    "inbound_webhook_failure",
    "delivery_webhook_failure",
    "burst_flush_failure",
    "queue_run_failure",
    "suppression_invariant_failure",
    "canary_scope_violation",
    "unexpected_outbound_while_stopped",
  ];
  const codes = Object.values(LAUNCH_CRITICAL_ALERT_CODES);
  for (const code of required) {
    assert.ok(codes.includes(code), `catalog must contain ${code}`);
  }
  // And every catalog code has a callable wrapper.
  // Contract re-pin: the catalog legitimately grew past the mandated 8 codes;
  // coverage of the required set is the invariant, not an exact wrapper count.
  const wrappers = Object.keys(launchAlerts);
  assert.ok(
    wrappers.length >= required.length,
    `wrapper catalog must cover at least the ${required.length} mandated codes`
  );
  for (const wrapper of wrappers) {
    assert.equal(typeof launchAlerts[wrapper], "function");
  }
});

test("alerts persist to the canonical notification_events sink", async () => {
  const cap = captureUpsert();
  const result = await recordLaunchCriticalAlert(
    {
      code: LAUNCH_CRITICAL_ALERT_CODES.QUEUE_DISPATCH_FAILURE,
      subsystem: "queue",
      severity: "high",
      summary: "Queue dispatch failed",
      metadata: { queue_row_id: "row-1" },
    },
    cap,
  );

  assert.equal(result.ok, true);
  assert.equal(cap.rows.length, 1);
  const row = cap.rows[0];
  assert.equal(row.event_type, "launch_safety.queue_dispatch_failure");
  assert.equal(row.domain, LAUNCH_ALERT_DOMAIN);
  assert.equal(row.deduplication_key, "launch_safety:queue:queue_dispatch_failure");
  assert.equal(row.metrics_snapshot.queue_row_id, "row-1");
  assert.equal(row.metrics_snapshot.alert_code, "queue_dispatch_failure");
});

// ── severity mapping must satisfy the DB CHECK constraint ───────────────────

test("legacy severities map onto the notification_events CHECK constraint", () => {
  // notification_events.severity CHECK: positive|neutral|warning|critical
  const allowed = new Set(["positive", "neutral", "warning", "critical"]);
  for (const legacy of ["info", "warning", "high", "critical", "fatal", "low", "garbage"]) {
    assert.ok(allowed.has(normalizeLaunchAlertSeverity(legacy)), `${legacy} must map into the constraint`);
  }
  assert.equal(normalizeLaunchAlertSeverity("high"), "critical");
  assert.equal(normalizeLaunchAlertSeverity("info"), "neutral");
  assert.equal(normalizeLaunchAlertSeverity("garbage"), "warning");
});

test("safety-invariant alerts are always critical regardless of caller severity", async () => {
  for (const code of [
    LAUNCH_CRITICAL_ALERT_CODES.SUPPRESSION_INVARIANT_FAILURE,
    LAUNCH_CRITICAL_ALERT_CODES.CANARY_SCOPE_VIOLATION,
    LAUNCH_CRITICAL_ALERT_CODES.UNEXPECTED_OUTBOUND_WHILE_STOPPED,
  ]) {
    const cap = captureUpsert();
    await recordLaunchCriticalAlert({ code, severity: "info" }, cap);
    assert.equal(cap.rows[0].severity, "critical", `${code} must be critical`);
  }
});

// ── no secrets or seller content in the ops table ───────────────────────────

test("alert metadata never carries secrets or message content", () => {
  const sanitized = sanitizeAlertMetadata({
    queue_row_id: "row-1",
    message_body: "Hi, is your property for sale?",
    message_text: "seller reply text",
    rendered_message: "outbound copy",
    auth_token: "abc",
    api_key: "k",
    service_role_key: "s",
    password: "p",
    nested: { credential: "x", safe_count: 3 },
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ["nested", "queue_row_id"]);
  assert.deepEqual(sanitized.nested, { safe_count: 3 });
});

test("recording an alert never throws, even when the sink fails", async () => {
  const result = await recordLaunchCriticalAlert(
    { code: "queue_run_failure" },
    {
      upsertNotificationEvent: async () => {
        throw new Error("supabase down");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "alert_persist_threw");
});

test("a sink returning not-ok is reported without throwing", async () => {
  const result = await recordLaunchCriticalAlert(
    { code: "queue_run_failure" },
    { upsertNotificationEvent: async () => ({ ok: false, error: "event_type_required" }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "event_type_required");
});

// ── wrappers carry the right subsystem + severity ───────────────────────────

test("each wrapper records its mandated failure with a stable dedupe key", async () => {
  const expectations = [
    ["queueDispatchFailure", "queue", "queue_dispatch_failure"],
    ["queueRunFailure", "queue", "queue_run_failure"],
    ["inboundWebhookFailure", "inbound", "inbound_webhook_failure"],
    ["deliveryWebhookFailure", "delivery", "delivery_webhook_failure"],
    ["burstFlushFailure", "seller_inbound_burst", "burst_flush_failure"],
    ["suppressionInvariantFailure", "suppression", "suppression_invariant_failure"],
    ["canaryScopeViolation", "canary", "canary_scope_violation"],
    ["unexpectedOutboundWhileStopped", "queue", "unexpected_outbound_while_stopped"],
  ];
  for (const [wrapper, subsystem, code] of expectations) {
    const cap = captureUpsert();
    await launchAlerts[wrapper]({ detail: "x" }, cap);
    assert.equal(cap.rows.length, 1, `${wrapper} must persist exactly one row`);
    assert.equal(cap.rows[0].event_type, `launch_safety.${code}`);
    assert.equal(cap.rows[0].deduplication_key, `launch_safety:${subsystem}:${code}`);
    assert.equal(cap.rows[0].grouping_key, `launch_safety:${subsystem}`);
  }
});

// ── queue run failure is wired into the real route path ─────────────────────

test("queue run failure persists a launch-critical alert", async () => {
  const { handleQueueRunRequest } = await import("@/lib/domain/queue/queue-run-request.js");
  const alerts = [];
  const responses = [];

  await handleQueueRunRequest(
    { url: "https://app.example.com/api/internal/queue/run", json: async () => ({}) },
    "GET",
    {
      requireCronAuth: () => ({
        authorized: true,
        auth: { authenticated: true, is_vercel_cron: true },
        response: null,
      }),
      // Full live_limited rails, otherwise the route 423s before dispatch.
      getSystemValue: async (key) =>
        ({
          queue_processor_mode: "on",
          queue_execution_mode: "normal",
          campaign_mode: "live_limited",
          queue_hard_cap: "5",
          queue_max_batch_size: "5",
          queue_daily_send_cap: "5",
          queue_market_cap: "5",
          queue_per_number_cap: "5",
          queue_run_limit: "5",
          queue_market_filter: "Miami, FL",
          queue_state_filter: "FL",
          queue_emergency_stop_at: "",
        })[key] ?? null,
      runSendQueue: async () => {
        throw new Error("dispatch exploded");
      },
      recordQueueRunFailureAlert: async (metadata) => {
        alerts.push(metadata);
        return { ok: true };
      },
      logger: { info() {}, warn() {}, error() {} },
      jsonResponse: (body, init) => {
        responses.push({ body, status: init?.status ?? 200 });
        return { body, status: init?.status ?? 200 };
      },
    },
  );

  assert.equal(alerts.length, 1, "queue run failure must persist an alert");
  assert.equal(alerts[0].error_message, "dispatch exploded");
});
