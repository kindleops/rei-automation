/**
 * Burst flush scheduling contract.
 *
 * SELLER_INBOUND_BURST_ENABLED has an activation prerequisite: the flush route
 * must be driven by a scheduler, otherwise non-safety bursts only finalize when
 * a later inbound trips the hard-close rollover. The route was never scheduled —
 * not even in main's vercel.json. These tests pin the cron wiring and the route
 * preconditions the mandate requires before scheduling it.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLUSH_PATH = "/api/internal/seller-flow/flush-inbound-bursts";

function readVercelConfig() {
  const configPath = path.resolve(__dirname, "../../vercel.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

// ── cron registration ────────────────────────────────────────────────────────

test("flush route is registered as a production cron", () => {
  const config = readVercelConfig();
  const entry = (config.crons || []).find((cron) => cron.path === FLUSH_PATH);
  assert.ok(entry, `${FLUSH_PATH} must be scheduled`);
  // Vercel Cron's finest granularity is one minute. The burst policy is a 20s
  // quiet window with a 90s hard cap, so once per minute is the closest
  // compatible cadence: worst-case finalize latency stays inside ~1 policy
  // cycle, and the hard cap guarantees nothing waits indefinitely.
  assert.equal(entry.schedule, "* * * * *");
});

test("cron list has no duplicate paths", () => {
  const config = readVercelConfig();
  const paths = (config.crons || []).map((cron) => cron.path);
  assert.equal(new Set(paths).size, paths.length, "duplicate cron paths would double-fire");
});

// ── route auth: canonical internal auth, cron-compatible, never anonymous ────

test("flush route rejects anonymous callers", async () => {
  const { POST } = await import("@/app/api/internal/seller-flow/flush-inbound-bursts/route.js");
  const response = await POST({
    headers: { get: () => null },
    json: async () => ({}),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test("flush route rejects a wrong secret", async () => {
  const { POST } = await import("@/app/api/internal/seller-flow/flush-inbound-bursts/route.js");
  const response = await POST({
    headers: {
      get: (key) => (key.toLowerCase() === "x-internal-api-secret" ? "not-the-secret" : null),
    },
    json: async () => ({}),
  });
  assert.equal(response.status, 401);
});

test("flush route accepts the Vercel cron Authorization bearer header", async () => {
  // Vercel injects `Authorization: Bearer $CRON_SECRET` on cron invocations.
  // requireInternalSecret must accept it, or the scheduled job would 401 forever.
  const { requireInternalSecret } = await import("@/lib/security/require-internal-secret.js");
  const savedCron = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron-secret-value";
  try {
    const auth = requireInternalSecret({
      headers: {
        get: (key) =>
          key.toLowerCase() === "authorization" ? "Bearer cron-secret-value" : null,
      },
    });
    assert.equal(auth.ok, true);
  } finally {
    if (savedCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedCron;
  }
});

test("flush route accepts the canonical internal secret header", async () => {
  const { requireInternalSecret } = await import("@/lib/security/require-internal-secret.js");
  const auth = requireInternalSecret({
    headers: {
      get: (key) => (key.toLowerCase() === "x-internal-api-secret" ? "test" : null),
    },
  });
  assert.equal(auth.ok, true);
});

// ── flag-off / zero-work safety, and the stable success contract ─────────────

test("route source keeps the documented activation prerequisites and contract", () => {
  const routePath = path.resolve(
    __dirname,
    "../../src/app/api/internal/seller-flow/flush-inbound-bursts/route.js",
  );
  const source = fs.readFileSync(routePath, "utf8");
  // Canonical internal auth (not a hand-rolled check).
  assert.match(source, /requireInternalSecret\(request\)/);
  // Stable success contract: ok + flushed + results.
  assert.match(source, /ok:\s*true,\s*\n\s*flushed:/);
  // Supabase precondition returns 503 rather than throwing.
  assert.match(source, /missing_supabase/);
  // Flush crashes are contained AND alerted, never silent.
  assert.match(source, /burstFlushFailure/);
  assert.match(source, /seller_inbound_burst_flush_failed/);
});

test("zero eligible bursts is a clean no-op with a stable contract", async () => {
  const { createSellerInboundBurstCoordinator } = await import(
    "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js"
  );
  const { createMemorySellerInboundBurstStore } = await import(
    "@/lib/domain/seller-flow/seller-inbound-burst-store.js"
  );

  let sendAttempts = 0;
  const coordinator = createSellerInboundBurstCoordinator({
    store: createMemorySellerInboundBurstStore(),
    processSellerInboundMessage: async () => {
      sendAttempts += 1;
      return { ok: true };
    },
    // Flag OFF: nothing may ever be appended, so nothing is eligible.
    enabled: false,
    worker_id: "test-worker",
  });

  const result = await coordinator.flushEligible({ limit: 20 });
  assert.deepEqual(result.results || [], []);
  assert.equal(sendAttempts, 0, "flag-off flush must not send");
});

test("flush is idempotent across repeated scheduler ticks with no work", async () => {
  const { createSellerInboundBurstCoordinator } = await import(
    "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js"
  );
  const { createMemorySellerInboundBurstStore } = await import(
    "@/lib/domain/seller-flow/seller-inbound-burst-store.js"
  );
  const coordinator = createSellerInboundBurstCoordinator({
    store: createMemorySellerInboundBurstStore(),
    processSellerInboundMessage: async () => ({ ok: true }),
    enabled: false,
    worker_id: "test-worker",
  });

  for (let tick = 0; tick < 3; tick += 1) {
    const result = await coordinator.flushEligible({ limit: 20 });
    assert.deepEqual(result.results || [], []);
  }
});
