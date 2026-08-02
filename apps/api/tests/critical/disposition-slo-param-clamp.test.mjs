/**
 * Disposition SLO scan: query-parameter clamping contract.
 *
 * The scan window parameters must be bounded positive integers. A negative
 * sla_minutes moves the processing cutoff into the future — every in-flight
 * 'processing' row matches and the always-critical inbound_no_disposition
 * alert fires against a healthy system. An enormous horizon hides real
 * breaches. Invalid / NaN / zero input must fall back to the defaults;
 * excessive values must clamp to the ceilings.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  clampScanMinutes,
  handleDispositionSloScanRequest,
} from "@/app/api/internal/inbound/disposition-slo-scan/route.js";

const ROUTE_URL = "http://localhost:3000/api/internal/inbound/disposition-slo-scan";

function buildRequest(query = "") {
  return {
    url: `${ROUTE_URL}${query}`,
    headers: {
      get: (key) => (key.toLowerCase() === "x-internal-api-secret" ? "test" : null),
    },
  };
}

function stubScanner(calls, result = {}) {
  return async (args) => {
    calls.push(args);
    return {
      ok: true,
      stuck_processing: [],
      exhausted_retries: [],
      breach_count: 0,
      ...result,
    };
  };
}

// ── clamp helper ─────────────────────────────────────────────────────────────

test("clampScanMinutes falls back on invalid, NaN, zero, and negative input", () => {
  assert.equal(clampScanMinutes(null, 10, 1440), 10);
  assert.equal(clampScanMinutes("", 10, 1440), 10);
  assert.equal(clampScanMinutes("abc", 10, 1440), 10);
  assert.equal(clampScanMinutes(NaN, 10, 1440), 10);
  assert.equal(clampScanMinutes("NaN", 10, 1440), 10);
  assert.equal(clampScanMinutes("0", 10, 1440), 10);
  assert.equal(clampScanMinutes(0, 10, 1440), 10);
  assert.equal(clampScanMinutes("-5", 10, 1440), 10);
  assert.equal(clampScanMinutes(-1440, 10, 1440), 10);
  assert.equal(clampScanMinutes("Infinity", 10, 1440), 10);
  assert.equal(clampScanMinutes("-Infinity", 10, 1440), 10);
});

test("clampScanMinutes bounds valid input to positive integers within the ceiling", () => {
  assert.equal(clampScanMinutes("30", 10, 1440), 30);
  assert.equal(clampScanMinutes(30, 10, 1440), 30);
  // Fractionals round, and never round down to zero.
  assert.equal(clampScanMinutes("10.6", 10, 1440), 11);
  assert.equal(clampScanMinutes("0.2", 10, 1440), 1);
  // Excessive values clamp to the ceiling instead of hiding breaches.
  assert.equal(clampScanMinutes("999999", 10, 1440), 1440);
  assert.equal(clampScanMinutes(1441, 10, 1440), 1440);
  assert.equal(clampScanMinutes(1440, 10, 1440), 1440);
});

// ── route behavior ───────────────────────────────────────────────────────────

test("scan route rejects anonymous callers before touching the ledger", async () => {
  const calls = [];
  const response = await handleDispositionSloScanRequest(
    { url: ROUTE_URL, headers: { get: () => null } },
    { findInboundLedgerSlaBreaches: stubScanner(calls) }
  );
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(calls.length, 0);
});

test("scan route uses the defaults when parameters are absent", async () => {
  const calls = [];
  const response = await handleDispositionSloScanRequest(buildRequest(), {
    findInboundLedgerSlaBreaches: stubScanner(calls),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.sla_minutes, 10);
  assert.equal(body.retry_horizon_minutes, 60);
  assert.deepEqual(calls, [{ sla_minutes: 10, retry_horizon_minutes: 60 }]);
});

test("scan route rejects negative windows: the cutoff must never move into the future", async () => {
  const calls = [];
  const response = await handleDispositionSloScanRequest(
    buildRequest("?sla_minutes=-5&retry_horizon_minutes=-60"),
    { findInboundLedgerSlaBreaches: stubScanner(calls) }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sla_minutes, 10);
  assert.equal(body.retry_horizon_minutes, 60);
  assert.deepEqual(calls, [{ sla_minutes: 10, retry_horizon_minutes: 60 }]);
});

test("scan route falls back on NaN and zero parameters", async () => {
  const calls = [];
  await handleDispositionSloScanRequest(
    buildRequest("?sla_minutes=abc&retry_horizon_minutes=0"),
    { findInboundLedgerSlaBreaches: stubScanner(calls) }
  );
  assert.deepEqual(calls, [{ sla_minutes: 10, retry_horizon_minutes: 60 }]);
});

test("scan route clamps excessive windows so real breaches stay visible", async () => {
  const calls = [];
  const response = await handleDispositionSloScanRequest(
    buildRequest("?sla_minutes=999999&retry_horizon_minutes=999999"),
    { findInboundLedgerSlaBreaches: stubScanner(calls) }
  );
  const body = await response.json();
  assert.equal(body.sla_minutes, 1440);
  assert.equal(body.retry_horizon_minutes, 10080);
  assert.deepEqual(calls, [{ sla_minutes: 1440, retry_horizon_minutes: 10080 }]);
});

test("scan route passes bounded valid parameters through unchanged", async () => {
  const calls = [];
  const response = await handleDispositionSloScanRequest(
    buildRequest("?sla_minutes=30&retry_horizon_minutes=120"),
    { findInboundLedgerSlaBreaches: stubScanner(calls) }
  );
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.sla_minutes, 30);
  assert.equal(body.retry_horizon_minutes, 120);
  assert.deepEqual(calls, [{ sla_minutes: 30, retry_horizon_minutes: 120 }]);
});
