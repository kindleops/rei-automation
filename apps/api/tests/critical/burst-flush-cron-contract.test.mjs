/**
 * Burst flush scheduling contract.
 *
 * SELLER_INBOUND_BURST_ENABLED has an activation prerequisite: the flush route
 * must be driven by a scheduler, otherwise non-safety bursts only finalize when
 * a later inbound trips the hard-close rollover.
 *
 * PRODUCTION-COMMISSIONING-1 (2026-09-17) — this contract was pointed at the
 * WRONG AUTHORITY and asserting a lane production governance had refused.
 *
 * It required the flush route to be scheduled in apps/api/vercel.json every
 * minute. It genuinely was — but by a live Vercel deployment running a build
 * 135 commits behind production, which was a SECOND un-governed executor on the
 * production database. Meanwhile the governed scheduler,
 * PRODUCTION_CRON_JOBS in infra/cloudflare/worker/index.ts, lists this exact
 * path in FORBIDDEN_JOBS as an unbraked follow-up leg, and
 * cloudflare-cron-scope.test.mjs asserts it appears nowhere in the Worker's
 * executable code. The two contracts flatly contradicted each other, and the
 * vercel.json entry was the only thing hiding it.
 *
 * The crons are now removed from vercel.json, so this file asserts the truth:
 * the route is auth-gated and fail-closed, and it is DELIBERATELY UNSCHEDULED.
 *
 * The functional consequence is real and named rather than papered over: burst
 * flush is NOT commissioned. In practice the lane was already inert —
 * seller-inbound-burst-coordinator resolves
 * `asBoolean(env.SELLER_INBOUND_BURST_ENABLED, false)` and that variable is not
 * set in wrangler.production.jsonc — so removing the cron changed no behaviour.
 * Commissioning it is an explicit operator decision that must also reconcile
 * FORBIDDEN_JOBS, not something a config file grants by accident.
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

test("vercel.json schedules NOTHING, so there is one governed scheduler", () => {
  // The whole point of the consolidation: a second executor cannot reappear by
  // someone adding a cron back to this file without this test going red.
  const config = readVercelConfig();
  assert.deepEqual(
    config.crons ?? [],
    [],
    "apps/api/vercel.json must declare no crons; the governed scheduler is PRODUCTION_CRON_JOBS"
  );
});

test("the flush route is deliberately NOT scheduled by the governed scheduler", async () => {
  // Agreement with cloudflare-cron-scope.test.mjs, which lists this path in
  // FORBIDDEN_JOBS. If it is ever commissioned, BOTH contracts must change
  // together and the reason must be written down in both.
  const workerPath = path.resolve(__dirname, "../../../../infra/cloudflare/worker/index.ts");
  const worker = fs.readFileSync(workerPath, "utf8");
  const executable = worker
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  assert.ok(
    !executable.includes(FLUSH_PATH),
    `${FLUSH_PATH} must not be reachable from any schedule while it sits in FORBIDDEN_JOBS`
  );
});

test("burst flush stays fail-closed, so being unscheduled cannot silently arm it", async () => {
  // The activation authority is what makes the unscheduled state safe rather
  // than merely quiet: absent configuration resolves to disabled.
  const { isSellerInboundBurstEnabled } = await import(
    "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js"
  );
  assert.equal(isSellerInboundBurstEnabled({ env: {} }), false, "absent config must be disabled");
  assert.equal(
    isSellerInboundBurstEnabled({ env: { SELLER_INBOUND_BURST_ENABLED: "" } }),
    false,
    "empty config must be disabled"
  );
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

test("route exports both cron GET and internal POST onto the shared handler", async () => {
  // The 2026-08-03 outage: Vercel Cron issues GET and this route exported POST
  // only, so the scheduled worker never ran. Behaviour of both methods is
  // covered in burst-flush-cron-get-integration.test.mjs.
  const route = await import("@/app/api/internal/seller-flow/flush-inbound-bursts/route.js");
  assert.equal(typeof route.GET, "function", "Vercel Cron issues GET");
  assert.equal(typeof route.POST, "function", "operator/internal invocation");
});

test("handler keeps the documented activation prerequisites and contract", () => {
  const handlerPath = path.resolve(
    __dirname,
    "../../src/lib/domain/seller-flow/flush-inbound-bursts-request.js",
  );
  const source = fs.readFileSync(handlerPath, "utf8");
  // Canonical internal + cron auth (not a hand-rolled check).
  assert.match(source, /requireInternalSecret/);
  assert.match(source, /requireCronAuth/);
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
