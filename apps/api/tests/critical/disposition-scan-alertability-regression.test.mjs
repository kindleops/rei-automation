/**
 * A watchdog must not report health it has not established.
 *
 * Two gaps, both measured on this branch before the fix:
 *
 * 1. HTTP STATUS. A failed burst scan returned `ok:false` in the BODY but HTTP
 *    200. Cron runners and uptime monitors key on the status code, so a scan
 *    that looked at nothing was recorded as a successful run. The equivalent
 *    ledger failure already returned 500 — the two halves of the same watchdog
 *    disagreed.
 *
 *      burst_scan_failed      -> HTTP 200   (ledger_scan_failed -> HTTP 500)
 *      supabase_unconfigured  -> HTTP 200
 *
 *    `burst_table_missing` also disagreed with itself: the alerting branch
 *    treats it as the one condition that degrades quietly, while the response
 *    still reported `ok:false` for it.
 *
 * 2. ROW-CAP TRUNCATION. scanBurstLiveness caps at `limit` (default 200) and
 *    silently dropped the remainder, so a backlog of 250 stuck bursts reported
 *    a bounded violation_count with ok:true and looked smaller than it was.
 *
 * Both are the defect class this PR exists to close.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { handleDispositionSloScanRequest } from "@/app/api/internal/inbound/disposition-slo-scan/route.js";
import { scanBurstLiveness } from "@/lib/domain/seller-flow/seller-inbound-burst-liveness.js";

const authedRequest = () => ({
  url: "https://api.example.com/api/internal/inbound/disposition-slo-scan",
  headers: {
    get: (k) => (String(k).toLowerCase() === "x-internal-api-secret" ? "test" : null),
  },
});

const healthyLedger = async () => ({
  ok: true,
  breach_count: 0,
  stuck_processing: [],
  exhausted_retries: [],
});

const silentAlerts = () => {
  const sent = [];
  return {
    sent,
    inboundNoDisposition: async (p) => { sent.push(["ledger", p]); },
    burstLivenessFailure: async (p) => { sent.push(["burst", p]); },
  };
};

async function scanWith(burst_scan, { ledger = healthyLedger, alerts = silentAlerts() } = {}) {
  const response = await handleDispositionSloScanRequest(authedRequest(), {
    findInboundLedgerSlaBreaches: ledger,
    scanBurstLiveness: async () => burst_scan,
    supabase: {},
    launchAlerts: alerts,
  });
  return { response, body: await response.json(), alerts };
}

// ── 1. an alertable burst-scan failure must be a non-2xx ────────────────────

for (const reason of ["burst_scan_failed", "supabase_unconfigured", "burst_query_timeout"]) {
  test(`a burst scan that failed with ${reason} returns a non-2xx`, async () => {
    const { response, body, alerts } = await scanWith({
      ok: false,
      reason,
      violation_count: 0,
    });
    assert.equal(response.status, 500, "a cron monitor keys on the status code");
    assert.equal(body.ok, false);
    assert.equal(body.burst_scan_ok, false);
    assert.equal(body.burst_scan_degraded, false, `${reason} is not a quiet degrade`);
    assert.equal(
      alerts.sent.filter(([kind]) => kind === "burst").length,
      1,
      "and it must page"
    );
  });
}

test("the ledger half already behaved this way — the two now agree", async () => {
  const failing = async () => ({ ok: false, reason: "ledger_scan_failed" });
  const { response } = await scanWith(
    { ok: true, violation_count: 0, counts: {}, violations: [] },
    { ledger: failing }
  );
  assert.equal(response.status, 500);
});

// ── burst_table_missing is the ONE quiet-degrade, in BOTH places ────────────

test("a missing burst table is a degraded SUCCESS, consistently", async () => {
  const { response, body, alerts } = await scanWith({
    ok: false,
    reason: "burst_table_missing",
    violation_count: 0,
  });
  // The alerting branch has always exempted it; the response now agrees.
  assert.equal(response.status, 200, "a missing table does not fail the run");
  assert.equal(body.ok, true, "degraded SUCCESS — this is what the alert branch assumes");
  assert.equal(body.burst_scan_degraded, true);
  assert.equal(
    body.burst_scan_ok,
    false,
    "but the response must still record that the burst half did not run"
  );
  assert.equal(
    alerts.sent.filter(([kind]) => kind === "burst").length,
    0,
    "and it must not page"
  );
});

test("a healthy scan is still an unqualified 200", async () => {
  const { response, body } = await scanWith({
    ok: true,
    violation_count: 0,
    counts: {},
    violations: [],
  });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.burst_scan_ok, true);
  assert.equal(body.burst_scan_degraded, false);
});

test("violations are a 200: the scan ran and found real problems", async () => {
  const { response, body, alerts } = await scanWith({
    ok: true,
    violation_count: 3,
    p0_violation_count: 3,
    counts: {},
    violations: [{ code: "worker_liveness_failure", severity: "p0", burst_id: "b1" }],
  });
  assert.equal(response.status, 200, "a working watchdog is not a failed run");
  assert.equal(body.ok, true);
  assert.equal(alerts.sent.filter(([kind]) => kind === "burst").length, 1);
});

// ── 2. a capped scan cannot masquerade as a complete one ────────────────────

/** Supabase double that HONOURS the requested limit, the way Postgres does. */
function cappedDb(total_rows) {
  const all = Array.from({ length: total_rows }, (_, i) => ({
    id: `r${i}`,
    burst_id: `b${i}`,
    thread_key: `t${i}`,
    status: "open",
    eligible_at: "2026-08-03T22:40:51.039Z",
    hard_close_at: "2026-08-03T22:42:01.039Z",
    first_received_at: "2026-08-03T22:40:31.039Z",
    attempt_count: 0,
    claimed_at: null,
    completed_at: null,
    updated_at: "2026-08-03T22:41:30.039Z",
  }));
  let requested_limit = null;
  const builder = {
    select: () => builder,
    or: () => builder,
    order: () => builder,
    limit: async (n) => {
      requested_limit = n;
      return { data: all.slice(0, n), error: null };
    },
  };
  return { client: { from: () => builder }, requestedLimit: () => requested_limit };
}

const NOW = "2026-08-04T00:00:00Z";

test("a backlog larger than the cap reports truncation", async () => {
  const db = cappedDb(250);
  const result = await scanBurstLiveness({ supabase: db.client, limit: 200, now: NOW });
  assert.equal(result.ok, true, "the scan itself succeeded");
  assert.equal(result.truncated, true, "but it did not see the whole backlog");
  assert.equal(result.scan_complete, false);
  assert.equal(result.row_limit, 200);
  assert.equal(result.scanned_count, 200, "the probe row is discarded, not evaluated");
});

test("a backlog at EXACTLY the cap is not falsely reported as truncated", async () => {
  // This is why the scan asks for limit+1 rather than testing rows.length === limit.
  const db = cappedDb(200);
  const result = await scanBurstLiveness({ supabase: db.client, limit: 200, now: NOW });
  assert.equal(result.truncated, false);
  assert.equal(result.scan_complete, true);
  assert.equal(result.scanned_count, 200);
  assert.equal(db.requestedLimit(), 201, "one row beyond the cap is requested as a probe");
});

test("a backlog under the cap is a complete scan", async () => {
  const result = await scanBurstLiveness({ supabase: cappedDb(12).client, limit: 200, now: NOW });
  assert.equal(result.truncated, false);
  assert.equal(result.scan_complete, true);
  assert.equal(result.scanned_count, 12);
});

test("one row beyond the cap is enough to flag truncation", async () => {
  const result = await scanBurstLiveness({ supabase: cappedDb(11).client, limit: 10, now: NOW });
  assert.equal(result.truncated, true);
  assert.equal(result.scanned_count, 10);
});

test("truncation reaches the alert payload and the response envelope", async () => {
  const { response, body, alerts } = await scanWith({
    ok: true,
    truncated: true,
    row_limit: 200,
    scan_complete: false,
    violation_count: 200,
    p0_violation_count: 200,
    counts: {},
    violations: [{ code: "worker_liveness_failure", severity: "p0", burst_id: "b1" }],
  });
  assert.equal(response.status, 200);
  assert.equal(body.burst_scan_truncated, true, "visible without reading the nested object");
  const [, payload] = alerts.sent.find(([kind]) => kind === "burst");
  assert.equal(payload.truncated, true, "the pager must know the count is a floor");
  assert.equal(payload.row_limit, 200);
});

test("an untruncated scan does not claim truncation anywhere", async () => {
  const { body, alerts } = await scanWith({
    ok: true,
    truncated: false,
    row_limit: 200,
    scan_complete: true,
    violation_count: 1,
    counts: {},
    violations: [{ code: "worker_liveness_failure", severity: "p0", burst_id: "b1" }],
  });
  assert.equal(body.burst_scan_truncated, false);
  const [, payload] = alerts.sent.find(([kind]) => kind === "burst");
  assert.equal(payload.truncated, false);
});
