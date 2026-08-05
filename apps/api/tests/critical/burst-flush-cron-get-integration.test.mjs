/**
 * Burst flush cron GET integration — production incident 2026-08-03.
 *
 * Vercel Cron invokes scheduled paths with GET. The flush route exported POST
 * only, so the scheduled worker never entered the handler: burst
 * sib:+16128072000:g1:ba199924 sat status=open, attempt_count=0, past both its
 * eligible_at and hard_close_at, and the seller's "Yeah" never got a reply.
 *
 * The pre-existing burst-flush-cron-contract test asserted the cron path in
 * vercel.json and exercised auth through POST — it never issued a GET, so it
 * passed throughout the outage. These tests drive the real coordinator through
 * the GET entry point and assert the burst is actually claimed and finalized.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  handleFlushInboundBurstsRequest,
  summarizeFlushResults,
} from "@/lib/domain/seller-flow/flush-inbound-bursts-request.js";
import { createSellerInboundBurstCoordinator } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";

const T0 = "2026-08-03T22:40:31.039Z";
const THREAD = "+16128072000";
const CRON_SECRET = "cron-secret-for-flush-test";
// Pinned so the suite never depends on ambient environment values.
const INTERNAL_SECRET = "internal-secret-for-flush-test";

function ms(iso) {
  return new Date(iso).getTime();
}

/** Request double: only the surface the handler touches. */
function makeRequest({ method = "GET", headers = {}, body = null } = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    method,
    headers: { get: (key) => lower[String(key).toLowerCase()] ?? null },
    json: async () => {
      if (body === null) throw new Error("no body");
      return body;
    },
  };
}

/** Exactly how Vercel Cron calls a scheduled path. */
function vercelCronRequest() {
  return makeRequest({
    method: "GET",
    headers: {
      authorization: `Bearer ${CRON_SECRET}`,
      "user-agent": "vercel-cron/1.0",
      "x-vercel-id": "iad1::test-request-id",
    },
  });
}

/**
 * Real coordinator + memory store, seeded with the incident's burst and
 * advanced past the 20s quiet window so it is genuinely eligible.
 */
async function seedEligibleBurst({ processResult } = {}) {
  const state = { clock: ms(T0), processCalls: [] };
  const now = () => new Date(state.clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    processSellerInboundMessage: async (args) => {
      state.processCalls.push(args);
      return (
        processResult || {
          ok: true,
          queued: true,
          execution: { queued: true },
          effective_action: "queued",
        }
      );
    },
  });

  await coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "ba199924-5f13-4b2e-9f2e-471658cc8d2c",
    provider_message_id: "SMI~1nfXyUu6wYBQ8oHBjU7QQ==",
    body: "Yeah",
    received_at: now(),
  });

  const open_before = await store.getOpen(THREAD);
  assert.ok(open_before, "burst must be open before the flush");
  assert.equal(open_before.status, "open");

  // Past the 20s debounce quiet window — now eligible for the worker.
  state.clock = ms(T0) + 25_000;
  return { state, store, coordinator, now };
}

/**
 * Credentials AND global burst activation.
 *
 * These tests describe what the cron GET does WHEN THE WORKER IS ACTIVATED —
 * that was always their subject, but it used to be expressed by handing the
 * coordinator a hardcoded `enabled: true`, which is the defect itself. The
 * handler now resolves activation from SELLER_INBOUND_BURST_ENABLED, so the
 * premise has to be stated honestly in the environment instead of smuggled in
 * through a constructor argument.
 *
 * Activation-gate behaviour (disabled, internal_proof, resolver faults, the
 * preserved 2026-08-03 burst) is covered in
 * burst-flush-activation-authority.test.mjs.
 */
function withCronSecret(fn) {
  return async (...args) => {
    const saved_cron = process.env.CRON_SECRET;
    const saved_internal = process.env.INTERNAL_API_SECRET;
    const saved_burst = process.env.SELLER_INBOUND_BURST_ENABLED;
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
    process.env.SELLER_INBOUND_BURST_ENABLED = "1";
    try {
      return await fn(...args);
    } finally {
      if (saved_cron === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved_cron;
      if (saved_internal === undefined) delete process.env.INTERNAL_API_SECRET;
      else process.env.INTERNAL_API_SECRET = saved_internal;
      if (saved_burst === undefined) delete process.env.SELLER_INBOUND_BURST_ENABLED;
      else process.env.SELLER_INBOUND_BURST_ENABLED = saved_burst;
    }
  };
}

// ── the regression that caused the incident ─────────────────────────────────

test(
  "GET (Vercel cron) claims and finalizes an eligible burst",
  withCronSecret(async () => {
    const { state, store, coordinator } = await seedEligibleBurst();

    const response = await handleFlushInboundBurstsRequest(vercelCronRequest(), {
      method: "GET",
      coordinator,
      supabase: {},
      logger: { info: () => {}, warn: () => {} },
      launchAlerts: { burstFlushFailure: async () => {} },
    });

    assert.equal(response.status, 200, "cron GET must reach the handler");
    const body = await response.json();

    assert.equal(body.ok, true);
    assert.equal(body.method, "GET");
    assert.equal(body.caller_type, "vercel_cron");
    assert.equal(body.request_id, "iad1::test-request-id");

    // The burst was actually worked, not merely listed.
    assert.equal(body.eligible_count, 1, "the seeded burst must be eligible");
    assert.equal(body.claimed_count, 1, "the burst must be claimed");
    assert.equal(body.completed_count, 1, "the burst must be finalized");
    assert.equal(body.queued_count, 1, "finalizing must produce a reply");
    assert.equal(body.failed_count, 0);

    assert.equal(state.processCalls.length, 1, "the seller flow must run exactly once");

    // Durable state, not just the response payload.
    const open_after = await store.getOpen(THREAD);
    assert.ok(!open_after, "no burst may remain open for the thread after a flush");
  })
);

test(
  "GET is idempotent — a second cron tick finds no work and sends nothing",
  withCronSecret(async () => {
    const { state, coordinator } = await seedEligibleBurst();
    const deps = {
      method: "GET",
      coordinator,
      supabase: {},
      logger: { info: () => {}, warn: () => {} },
      launchAlerts: { burstFlushFailure: async () => {} },
    };

    const first = await handleFlushInboundBurstsRequest(vercelCronRequest(), deps);
    assert.equal((await first.json()).completed_count, 1);

    const second = await handleFlushInboundBurstsRequest(vercelCronRequest(), deps);
    const second_body = await second.json();
    assert.equal(second.status, 200);
    assert.equal(second_body.eligible_count, 0, "nothing left to claim");
    assert.equal(state.processCalls.length, 1, "the seller flow must not run twice");
  })
);

// ── authorization is not weakened by adding GET ─────────────────────────────

test("GET rejects an anonymous caller", async () => {
  const response = await handleFlushInboundBurstsRequest(makeRequest({ method: "GET" }), {
    method: "GET",
    coordinator: { flushEligible: async () => assert.fail("must not run unauthenticated") },
    supabase: {},
    logger: { info: () => {}, warn: () => {} },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).ok, false);
});

test(
  "GET rejects a wrong bearer secret",
  withCronSecret(async () => {
    const response = await handleFlushInboundBurstsRequest(
      makeRequest({
        method: "GET",
        headers: { authorization: "Bearer not-the-secret", "user-agent": "vercel-cron/1.0" },
      }),
      {
        method: "GET",
        coordinator: { flushEligible: async () => assert.fail("must not run unauthenticated") },
        supabase: {},
        logger: { info: () => {}, warn: () => {} },
      }
    );
    assert.equal(response.status, 401);
  })
);

test(
  "a vercel-cron user-agent alone does not authenticate",
  withCronSecret(async () => {
    // The user-agent is attacker-controlled; only the secret authorizes.
    const response = await handleFlushInboundBurstsRequest(
      makeRequest({ method: "GET", headers: { "user-agent": "vercel-cron/1.0" } }),
      {
        method: "GET",
        coordinator: { flushEligible: async () => assert.fail("must not run unauthenticated") },
        supabase: {},
        logger: { info: () => {}, warn: () => {} },
      }
    );
    assert.equal(response.status, 401);
  })
);

test("POST keeps the pre-existing internal-secret contract", withCronSecret(async () => {
  const { coordinator } = await seedEligibleBurst();
  const response = await handleFlushInboundBurstsRequest(
    makeRequest({
      method: "POST",
      headers: { "x-internal-api-secret": INTERNAL_SECRET },
      body: {},
    }),
    {
      method: "POST",
      coordinator,
      supabase: {},
      logger: { info: () => {}, warn: () => {} },
      launchAlerts: { burstFlushFailure: async () => {} },
    }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.caller_type, "internal_secret");
  assert.equal(body.completed_count, 1);
}));

// ── failure is alerted, never silent ────────────────────────────────────────

test(
  "a crashing flush returns 500 and raises an operational alert",
  withCronSecret(async () => {
    const alerts = [];
    const response = await handleFlushInboundBurstsRequest(vercelCronRequest(), {
      method: "GET",
      coordinator: {
        flushEligible: async () => {
          throw new Error("store_unreachable");
        },
      },
      supabase: {},
      logger: { info: () => {}, warn: () => {} },
      launchAlerts: {
        burstFlushFailure: async (meta) => {
          alerts.push(meta);
        },
      },
    });

    assert.equal(response.status, 500);
    assert.equal((await response.json()).reason, "seller_inbound_burst_flush_failed");
    assert.equal(alerts.length, 1, "a failed invocation must alert");
    assert.equal(alerts[0].method, "GET");
    assert.equal(alerts[0].error_message, "store_unreachable");
  })
);

test(
  "per-burst failures are counted and alerted without failing the run",
  withCronSecret(async () => {
    const alerts = [];
    const response = await handleFlushInboundBurstsRequest(vercelCronRequest(), {
      method: "GET",
      coordinator: {
        flushEligible: async () => ({
          ok: true,
          results: [{ ok: false, reason: "attempts_exhausted" }],
        }),
      },
      supabase: {},
      logger: { info: () => {}, warn: () => {} },
      launchAlerts: {
        burstFlushFailure: async (meta) => {
          alerts.push(meta);
        },
      },
    });

    const body = await response.json();
    assert.equal(body.failed_count, 1);
    assert.deepEqual(body.failed_reasons, ["attempts_exhausted"]);
    assert.equal(alerts.length, 1);
  })
);

// ── counter derivation ──────────────────────────────────────────────────────

test("summarizeFlushResults derives counters from the coordinator's real shape", () => {
  const counts = summarizeFlushResults([
    { ok: true, queued: true },
    { ok: true, suppressed: true, queued: false },
    { ok: false, reason: "burst_claim_conflict", claim: { ok: false } },
    { ok: false, reason: "attempts_exhausted" },
    { ok: false, reason: "no_eligible_burst" },
  ]);
  assert.equal(counts.eligible_count, 4, "no_eligible_burst is not an eligible burst");
  assert.equal(counts.claimed_count, 3, "a failed claim is not a claim");
  assert.equal(counts.completed_count, 1);
  assert.equal(counts.suppressed_count, 1);
  assert.equal(counts.queued_count, 1);
  assert.equal(counts.failed_count, 1, "no_eligible_burst is not a failure");
  assert.equal(counts.no_eligible_burst_count, 1);
});

// ── the route wires both methods to the shared handler ──────────────────────

test("route exports GET and POST", async () => {
  const route = await import("@/app/api/internal/seller-flow/flush-inbound-bursts/route.js");
  assert.equal(typeof route.GET, "function", "Vercel Cron issues GET");
  assert.equal(typeof route.POST, "function", "operator/internal invocation");
});
