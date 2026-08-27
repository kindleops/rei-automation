/**
 * Phase 11 (no silent dead-end): a top-level orchestration result of ok:false
 * must NEVER finalize the burst as a clean COMPLETED carrying no reply, review,
 * or fallback. It is folded into the existing bounded at-least-once retry and,
 * on retry exhaustion, becomes a VISIBLE FAILED — the same lifecycle a thrown
 * process error already gets. Successful orchestration must still finalize
 * normally, and a nested-helper ok:false inside a top-level SUCCESS must not be
 * mistaken for a top-level orchestration failure.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createSellerInboundBurstCoordinator } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import {
  BURST_STATUSES,
  SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";

const THREAD = "+15550100411";
const T0 = "2026-08-27T10:00:00.000Z";
const ms = (iso) => new Date(iso).getTime();

function harness({ processResult, maxAttempts = null } = {}) {
  const state = { clock: ms(T0), settlements: [] };
  const now = () => new Date(state.clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    supabase: {},
    ...(maxAttempts != null ? { max_attempts: maxAttempts } : {}),
    processSellerInboundMessage: async () =>
      processResult || { ok: true, queued: true, execution: { queued: true } },
    finalizeConstituentLedger: async (args) => {
      state.settlements.push(args);
      return { ok: true, finalized: 1, pending: 0, disposition: "recorded" };
    },
    completeInboundProcessingClaim: async () => ({ ok: true }),
    alertBurstFailure: async () => {},
  });
  return { state, store, coordinator, now };
}

async function seed(h, { body = "Yeah", classification = null } = {}) {
  await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-1",
    body,
    classification,
    received_at: h.now(),
  });
  h.state.clock = ms(T0) + 25_000; // past the quiet window
}

// ── 1) ok:false is diverted from COMPLETED into the retry path ───────────────

test("top-level orchestration ok:false never finalizes COMPLETED; it enters bounded retry", async () => {
  const h = harness({ processResult: { ok: false, reason: "missing_classification" } });
  await seed(h);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const r = flush.results[0];

  assert.equal(r.ok, false, "an unprocessable orchestration is not reported ok:true");
  assert.equal(r.retry_after_lease, true, "it is routed through the existing at-least-once retry");
  assert.equal(r.reason, "missing_classification", "the orchestration reason is carried through");
  assert.equal(h.state.settlements.length, 0, "no terminal ledger settle happens on the retry tick");

  const burst = h.store.getById(r.burst.id);
  assert.equal(burst.status, BURST_STATUSES.CLAIMED, "left CLAIMED for retry — NOT COMPLETED");
  assert.notEqual(burst.status, BURST_STATUSES.COMPLETED);
});

// ── 2) ok:false -> bounded retry -> visible FAILED on exhaustion ─────────────

test("top-level orchestration ok:false becomes a VISIBLE FAILED once retries are exhausted", async () => {
  // max_attempts=1: tick 1 claims (attempt_count 1, 1>1 false) -> processed ->
  // ok:false -> retry. tick 2 reclaims after lease (attempt_count 2, 2>1 true)
  // -> attempts-exhausted FAILED. It is COMPLETED on neither tick.
  const h = harness({
    processResult: { ok: false, reason: "missing_classification" },
    maxAttempts: 1,
  });
  await seed(h);

  const t1 = await h.coordinator.flushEligible({ thread_key: THREAD });
  const r1 = t1.results[0];
  assert.equal(r1.retry_after_lease, true, "tick 1 -> retry, not a terminal completion");
  const rowId = r1.burst.id; // internal store key for getById
  const pinId = r1.burst.burst_id; // pinned claim key for finalizeBurst
  assert.equal(h.store.getById(rowId).status, BURST_STATUSES.CLAIMED);

  // Advance past the claim lease so the stale-lease reclaim can run.
  h.state.clock = ms(T0) + 25_000 + SELLER_INBOUND_BURST_CLAIM_LEASE_MS + 5_000;

  const r2 = await h.coordinator.finalizeBurst({ thread_key: THREAD, burst_id: pinId });
  assert.equal(r2.ok, false, "the terminal outcome is a failure, never ok:true");
  assert.equal(r2.reason, "attempts_exhausted", "bounded retry ended in explicit exhaustion");

  const burst = h.store.getById(rowId);
  assert.equal(burst.status, BURST_STATUSES.FAILED, "terminal status is VISIBLE FAILED");
  assert.notEqual(burst.status, BURST_STATUSES.COMPLETED, "and it was never silently COMPLETED");

  const failedSettle = h.state.settlements.at(-1);
  assert.equal(failedSettle.result.ok, false, "the FAILED burst settles its ledger as not-ok");
  assert.equal(failedSettle.result.retriable, false, "attempts spent -> terminal, not retriable");
});

// ── 3) successful orchestration still finalizes COMPLETED normally ───────────

test("a successful orchestration still finalizes COMPLETED normally", async () => {
  const h = harness({ processResult: { ok: true, queued: true, execution: { queued: true } } });
  await seed(h);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const r = flush.results[0];

  assert.equal(r.ok, true, "success is reported ok:true");
  assert.equal(h.store.getById(r.burst.id).status, BURST_STATUSES.COMPLETED);
  assert.equal(h.state.settlements.length, 1);
  assert.equal(h.state.settlements[0].result.ok, true);
  assert.equal(h.state.settlements[0].result.queued, true);
});

// ── 4) nested-helper ok:false inside a top-level SUCCESS is NOT a failure ─────

test("a nested helper ok:false inside a top-level success does NOT trigger the failure path", async () => {
  // The orchestrator's TOP-LEVEL result is ok:true; it merely carries nested
  // sub-results (follow-up / cancel helpers) that are ok:false. These must not
  // be mistaken for a top-level orchestration failure — only `result.ok` counts.
  const h = harness({
    processResult: {
      ok: true,
      queued: true,
      execution: { queued: true },
      follow_up: { ok: false, skipped: true, reason: "followup_failed" },
      cancel_result: { ok: false, cancelled: 0, reason: "cancel_failed" },
    },
  });
  await seed(h);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const r = flush.results[0];

  assert.equal(r.ok, true, "top-level ok:true wins; nested ok:false is ignored");
  assert.notEqual(r.retry_after_lease, true, "it is NOT diverted into the retry path");
  assert.equal(h.store.getById(r.burst.id).status, BURST_STATUSES.COMPLETED);
});

// ── 5) the condition triggers ONLY on an explicit ok:false ───────────────────

test("an orchestration result with ok omitted (not explicitly false) finalizes normally", async () => {
  // Guards against widening: `orchestration.ok === false` is strict, so a
  // result that simply lacks an `ok` field must NOT be treated as a failure.
  const h = harness({ processResult: { queued: true, execution: { queued: true } } });
  await seed(h);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const r = flush.results[0];

  assert.equal(r.ok, true, "no explicit ok:false -> normal COMPLETED finalize");
  assert.equal(h.store.getById(r.burst.id).status, BURST_STATUSES.COMPLETED);
});
