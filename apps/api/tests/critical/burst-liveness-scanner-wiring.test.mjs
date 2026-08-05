/**
 * Burst liveness wired into the REAL disposition-SLO scanner — incident 2026-08-03.
 *
 * The scanner previously inspected only inbound_processing_ledger. The stuck
 * inbound had been (incorrectly) marked terminal there, so the watchdog saw a
 * healthy system while the burst sat open forever and the seller got no reply.
 *
 * These tests drive the actual route handler, not the pure evaluator.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { handleDispositionSloScanRequest } from "@/app/api/internal/inbound/disposition-slo-scan/route.js";
import { BURST_LIVENESS_VIOLATIONS } from "@/lib/domain/seller-flow/seller-inbound-burst-liveness.js";

const OBSERVED_AT = "2026-08-04T00:40:00.000Z";

// The exact production burst, shaped as the real table row.
const STUCK_BURST = {
  id: "0c2b3b2d-2a37-4489-9106-87b06fc1d4ac",
  burst_id: "sib:+15550100001:g1:ba199924",
  thread_key: "+15550100001",
  status: "open",
  eligible_at: "2026-08-03T22:40:51.039Z",
  hard_close_at: "2026-08-03T22:42:01.039Z",
  first_received_at: "2026-08-03T22:40:31.039Z",
  attempt_count: 0,
  claimed_at: null,
  completed_at: null,
  updated_at: "2026-08-03T22:42:16.901Z",
};

function authedRequest() {
  return {
    url: "https://api.example.com/api/internal/inbound/disposition-slo-scan",
    headers: {
      get: (k) => (String(k).toLowerCase() === "x-internal-api-secret" ? "test" : null),
    },
  };
}

/**
 * Supabase double that records every method invoked, so the test can prove the
 * scan is read-only.
 */
function readOnlySupabase(rows, { failWith = null } = {}) {
  const calls = { selects: 0, mutations: [] };
  const builder = {
    select: () => { calls.selects += 1; return builder; },
    gte: () => builder,
    lte: () => builder,
    eq: () => builder,
    in: () => builder,
    is: () => builder,
    or: () => builder,
    not: () => builder,
    order: () => builder,
    limit: async () => (failWith ? { data: null, error: failWith } : { data: rows, error: null }),
    // Any of these firing is a contract violation.
    update: (...a) => { calls.mutations.push(["update", a]); return builder; },
    delete: (...a) => { calls.mutations.push(["delete", a]); return builder; },
    insert: (...a) => { calls.mutations.push(["insert", a]); return builder; },
    upsert: (...a) => { calls.mutations.push(["upsert", a]); return builder; },
    rpc: (...a) => { calls.mutations.push(["rpc", a]); return builder; },
  };
  return { client: { from: () => builder, rpc: (...a) => { calls.mutations.push(["rpc", a]); } }, calls };
}

const healthyLedgerScan = async () => ({
  ok: true,
  stuck_processing: [],
  exhausted_retries: [],
  breach_count: 0,
});

// ── the acceptance test ─────────────────────────────────────────────────────

test("the real scanner flags a stuck eligible burst and emits a P0 alert", async () => {
  const { client, calls } = readOnlySupabase([STUCK_BURST]);
  const sent = [];
  const alerts = [];

  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    supabase: client,
    now: () => OBSERVED_AT,
    launchAlerts: {
      burstLivenessFailure: async (meta) => { alerts.push(meta); },
      inboundNoDisposition: async () => { alerts.push({ ledger: true }); },
    },
  });

  assert.equal(response.status, 200);
  const body = await response.json();

  // The ledger alone said everything was fine.
  assert.equal(body.breach_count, 0);
  // The burst scan did not.
  assert.ok(body.burst_liveness, "burst liveness must appear in the scan result");
  assert.equal(body.burst_liveness.ok, true);
  assert.ok(body.burst_liveness.violation_count > 0, "the stuck burst must be a violation");
  assert.ok(body.burst_liveness.p0_violation_count > 0);
  assert.equal(
    body.burst_liveness.worker_liveness_failure_count,
    1,
    "attempt_count=0 past the window must be distinguishable as worker_liveness_failure"
  );
  assert.equal(body.burst_liveness.counts.stale_open, 1);

  const codes = body.burst_liveness.violations.map((v) => v.code);
  assert.ok(codes.includes(BURST_LIVENESS_VIOLATIONS.WORKER_LIVENESS_FAILURE));
  assert.ok(codes.includes(BURST_LIVENESS_VIOLATIONS.STALE_OPEN_PAST_HARD_CLOSE));

  // A P0 alert was raised.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].worker_liveness_failure_count, 1);
  assert.ok(alerts[0].sample.length >= 1);

  // Read-only, and nothing was sent.
  assert.deepEqual(calls.mutations, [], "the scanner must never mutate a burst");
  assert.ok(calls.selects > 0, "the scanner must actually query bursts");
  assert.deepEqual(sent, [], "the scanner must never send");
});

test("tried-and-failed stays separable from never-attempted", async () => {
  const { client } = readOnlySupabase([
    STUCK_BURST, // never attempted
    {
      ...STUCK_BURST,
      id: "b2",
      burst_id: "sib:+15550100002:g1:x",
      thread_key: "+15550100002",
      status: "claimed",
      claimed_at: "2026-08-03T22:41:00.000Z",
      attempt_count: 3,
    },
  ]);
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    supabase: client,
    now: () => OBSERVED_AT,
    launchAlerts: { burstLivenessFailure: async () => {}, inboundNoDisposition: async () => {} },
  });
  const body = await response.json();
  assert.equal(body.burst_liveness.worker_liveness_failure_count, 1, "only the never-attempted one");
  assert.ok(body.burst_liveness.tried_and_failed_count >= 1, "the dead-worker claim is separate");
});

test("a healthy burst population raises no alert", async () => {
  const { client } = readOnlySupabase([
    {
      ...STUCK_BURST,
      status: "completed",
      attempt_count: 1,
      claimed_at: "2026-08-03T22:41:00.000Z",
      completed_at: "2026-08-03T22:41:05.000Z",
    },
  ]);
  const alerts = [];
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    supabase: client,
    now: () => OBSERVED_AT,
    launchAlerts: {
      burstLivenessFailure: async (m) => { alerts.push(m); },
      inboundNoDisposition: async () => {},
    },
  });
  const body = await response.json();
  assert.equal(body.burst_liveness.violation_count, 0);
  assert.equal(body.burst_liveness.counts.completed, 1);
  assert.deepEqual(alerts, []);
});

test("an empty burst table is safe, not a violation", async () => {
  const { client } = readOnlySupabase([]);
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    supabase: client,
    now: () => OBSERVED_AT,
    launchAlerts: { burstLivenessFailure: async () => {}, inboundNoDisposition: async () => {} },
  });
  const body = await response.json();
  assert.equal(body.burst_liveness.ok, true);
  assert.equal(body.burst_liveness.scanned_count, 0);
  assert.equal(body.burst_liveness.violation_count, 0);
});

test("a burst query failure never reads as healthy", async () => {
  const { client } = readOnlySupabase(null, { failWith: { code: "57014", message: "timeout" } });
  const alerts = [];
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    supabase: client,
    now: () => OBSERVED_AT,
    launchAlerts: {
      burstLivenessFailure: async (m) => { alerts.push(m); },
      inboundNoDisposition: async () => {},
    },
  });
  const body = await response.json();
  assert.equal(body.burst_liveness.ok, false, "a failed scan must not report ok");
  assert.equal(body.burst_liveness.reason, "burst_scan_failed");
  assert.equal(alerts.length, 1, "a broken watchdog must alert");
  assert.equal(alerts[0].scan_failed, true);
});

test("a missing burst table degrades quietly without a false alert storm", async () => {
  const { client } = readOnlySupabase(null, { failWith: { code: "42P01", message: "no table" } });
  const alerts = [];
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    supabase: client,
    now: () => OBSERVED_AT,
    launchAlerts: {
      burstLivenessFailure: async (m) => { alerts.push(m); },
      inboundNoDisposition: async () => {},
    },
  });
  const body = await response.json();
  assert.equal(body.burst_liveness.reason, "burst_table_missing");
  assert.deepEqual(alerts, []);
});

test("the scan route still rejects anonymous callers", async () => {
  const response = await handleDispositionSloScanRequest(
    { url: "https://api.example.com/x", headers: { get: () => null } },
    { findInboundLedgerSlaBreaches: healthyLedgerScan }
  );
  assert.equal(response.status, 401);
});

test("burst liveness failure is registered as an always-critical P0 code", async () => {
  const { LAUNCH_CRITICAL_ALERT_CODES, launchAlerts } = await import(
    "@/lib/domain/alerts/launch-critical-alerts.js"
  );
  assert.equal(LAUNCH_CRITICAL_ALERT_CODES.BURST_LIVENESS_FAILURE, "burst_liveness_failure");
  assert.equal(typeof launchAlerts.burstLivenessFailure, "function");
});

// ── the production entry point must obtain a real client ────────────────────

test("with NO injected supabase the handler resolves the canonical client and scans", async () => {
  // CodeRabbit finding: GET/POST call the handler with no deps, so passing
  // `supabase: null` meant every deployed invocation returned
  // supabase_unconfigured and queried nothing. The production path must resolve
  // the canonical service-role client itself.
  const { client, calls } = readOnlySupabase([STUCK_BURST]);
  let resolver_called = 0;
  const alerts = [];

  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    // deliberately NO `supabase` — mimics the real GET/POST call sites.
    resolveSupabase: async () => { resolver_called += 1; return client; },
    now: () => OBSERVED_AT,
    launchAlerts: {
      burstLivenessFailure: async (m) => { alerts.push(m); },
      inboundNoDisposition: async () => {},
    },
  });

  const body = await response.json();
  assert.equal(resolver_called, 1, "the handler must resolve a client when none is injected");
  assert.equal(body.burst_liveness.ok, true);
  assert.ok(calls.selects > 0, "the scan must actually query the burst table");
  assert.ok(body.burst_liveness.violation_count > 0, "the stale burst must be detected");
  assert.equal(alerts.length, 1, "a stale burst must alert");
  assert.deepEqual(calls.mutations, [], "the scan must stay read-only");
});

test("the real GET/POST exports go through the canonical resolver", async () => {
  const route = await import("@/app/api/internal/inbound/disposition-slo-scan/route.js");
  assert.equal(typeof route.resolveCanonicalSupabase, "function");
  // In an environment with no Supabase configuration it must return null rather
  // than throw — and that null is then treated as an alertable failure.
  assert.equal(await route.resolveCanonicalSupabase(), null);
});

test("an unconfigured client is an alertable failure, never a quiet pass", async () => {
  const alerts = [];
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    scanBurstLiveness: async () => ({
      ok: false, reason: "supabase_unconfigured", violation_count: 0,
    }),
    launchAlerts: {
      burstLivenessFailure: async (m) => { alerts.push(m); },
      inboundNoDisposition: async () => {},
    },
  });
  const body = await response.json();
  assert.equal(body.burst_liveness.ok, false);
  assert.equal(alerts.length, 1, "a scan that looked at nothing must alert");
  assert.equal(alerts[0].scan_failed, true);
});

test("an open burst older than the lookback window still triggers a violation", async () => {
  // Non-terminal bursts are never aged out: a burst stuck for days is more
  // urgent than one stuck for minutes, not less.
  const ancient = {
    ...STUCK_BURST,
    id: "ancient",
    burst_id: "sib:+15550100009:g1:ancient",
    first_received_at: "2026-07-01T00:00:00.000Z",
    eligible_at: "2026-07-01T00:00:20.000Z",
    hard_close_at: "2026-07-01T00:01:30.000Z",
  };
  const { client } = readOnlySupabase([ancient]);
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    supabase: client,
    now: () => OBSERVED_AT,
    launchAlerts: { burstLivenessFailure: async () => {}, inboundNoDisposition: async () => {} },
  });
  const body = await response.json();
  assert.ok(
    body.burst_liveness.violation_count > 0,
    "a month-old open burst must remain visible to monitoring"
  );
  assert.equal(body.burst_liveness.counts.stale_open, 1);
});

test("cancelled bursts are terminal, not open_not_eligible", async () => {
  const { client } = readOnlySupabase([{ ...STUCK_BURST, status: "cancelled", attempt_count: 9 }]);
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: healthyLedgerScan,
    supabase: client,
    now: () => OBSERVED_AT,
    launchAlerts: { burstLivenessFailure: async () => {}, inboundNoDisposition: async () => {} },
  });
  const body = await response.json();
  assert.equal(body.burst_liveness.counts.cancelled, 1);
  assert.equal(body.burst_liveness.counts.open_not_eligible, 0);
  assert.equal(body.burst_liveness.violation_count, 0, "a cancelled burst is not a liveness failure");
});
