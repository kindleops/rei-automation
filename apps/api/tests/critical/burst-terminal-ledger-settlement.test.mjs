/**
 * Every terminal burst outcome must settle its constituent ledger rows.
 *
 * Finalization previously ran only after the normal orchestration-success path,
 * so a suppressed or attempts-exhausted burst reached a terminal status while
 * its constituent inbounds stayed marked awaiting_burst_finalization forever —
 * the 2026-08-03 shape (a decision nobody recorded) in a new disguise.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { createSellerInboundBurstCoordinator } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import { TERMINAL_DISPOSITIONS } from "@/lib/domain/inbound/terminal-disposition.js";

const THREAD = "+15550100311";
const T0 = "2026-08-04T10:00:00.000Z";
const ms = (iso) => new Date(iso).getTime();

/** Records every settlement call the coordinator makes. */
function harness({ processResult, safety = false, maxAttempts = null } = {}) {
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

async function seed(h, { body = "Yeah", safetyBody = null, classification = null } = {}) {
  await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: "evt-1",
    provider_message_id: "SM-1",
    body: safetyBody || body,
    classification,
    received_at: h.now(),
  });
  h.state.clock = ms(T0) + 25_000; // past the quiet window
}

// ── branch 1: normal completion ─────────────────────────────────────────────

test("a normally completed burst settles its ledger rows", async () => {
  const h = harness();
  await seed(h);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const result = flush.results[0];

  assert.equal(result.ok, true);
  assert.equal(h.state.settlements.length, 1, "settlement must run on the completed path");
  const settled = h.state.settlements[0];
  assert.equal(settled.result.ok, true);
  assert.equal(settled.result.queued, true);
  assert.ok(settled.burst?.burst_id, "the real final burst record is used");
  assert.ok(result.ledger_finalization, "the outcome is reported back");
});

// ── branch 2: safety suppression ────────────────────────────────────────────

test("a safety-suppressed burst settles its ledger rows as suppressed", async () => {
  const h = harness();
  // A safety latch finalizes INLINE during append (suppression must land
  // immediately, not wait for the next worker tick), so the settlement happens
  // there rather than on a later flush.
  await seed(h, {
    safetyBody: "STOP",
    classification: { primary_intent: "opt_out", compliance_flag: "opt_out", confidence: 1 },
  });

  assert.equal(h.state.settlements.length, 1, "a suppressed burst must still settle");
  const settled = h.state.settlements[0];
  assert.equal(settled.result.suppressed, true);
  assert.equal(settled.result.ok, true, "suppression is a successful terminal outcome");
  assert.equal(settled.result.suppression_kind != null, true, "the safety kind is carried through");

  // Nothing is left open for the thread afterwards. A thread_key with no
  // burst_id is now a filter over the scoped eligible list rather than a bare
  // thread-scoped claim, so "nothing left" is an empty result set instead of
  // one refused claim carrying `no_eligible_burst`.
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  assert.equal(flush.results.length, 0, "nothing eligible → no claim attempted");
  assert.equal(h.state.settlements.length, 1, "and it is not settled twice");
});

// ── branch 3: attempts exhausted ────────────────────────────────────────────

test("an attempts-exhausted burst settles its ledger rows as failed, never ok:true", async () => {
  // max_attempts below the claim's starting attempt_count forces the
  // attempts-exhausted branch deterministically.
  const h = harness({ maxAttempts: -1 });
  await seed(h);
  const flush = await h.coordinator.flushEligible({ thread_key: THREAD });
  const result = flush.results[0];

  assert.equal(result.ok, false);
  assert.equal(result.reason, "attempts_exhausted");
  assert.equal(h.state.settlements.length, 1, "a failed burst must still settle its rows");
  const settled = h.state.settlements[0];
  assert.equal(settled.result.ok, false, "a failed burst must NEVER be reported as ok:true");
  assert.equal(settled.result.retriable, false, "attempts are spent — terminal, not retriable");
  assert.ok(result.ledger_finalization);
});

// ── the settlement contract itself ──────────────────────────────────────────

test("settlement uses the store's final burst record, so one generation cannot settle another", async () => {
  const h = harness();
  await seed(h);
  const before = await h.store.getOpen(THREAD);
  await h.coordinator.flushEligible({ thread_key: THREAD });
  const settled = h.state.settlements[0];
  assert.equal(
    settled.burst.burst_id,
    before.burst_id,
    "the exact burst that was claimed is the one settled"
  );
  assert.equal(typeof settled.burst.status, "string", "a real terminal record, not a stub");
});

test("a second flush settles nothing further", async () => {
  const h = harness();
  await seed(h);
  await h.coordinator.flushEligible({ thread_key: THREAD });
  const first = h.state.settlements.length;
  await h.coordinator.flushEligible({ thread_key: THREAD });
  assert.equal(h.state.settlements.length, first, "settlement must be idempotent across flushes");
});

test("terminal dispositions used by settlement are canonical", () => {
  for (const d of [
    TERMINAL_DISPOSITIONS.REPLY_SENT,
    TERMINAL_DISPOSITIONS.NO_REPLY_REQUIRED,
    TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT,
    TERMINAL_DISPOSITIONS.FAILED_TERMINAL,
  ]) {
    assert.equal(typeof d, "string");
  }
});
