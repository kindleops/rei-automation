/**
 * Burst liveness invariants + inbound ledger semantics — incident 2026-08-03.
 *
 * The production burst sib:+16128072000:g1:ba199924 sat status=open,
 * attempt_count=0, past both eligible_at and hard_close_at, and NOTHING
 * noticed: the burst layer had no liveness invariant, and the same inbound had
 * been recorded in inbound_processing_ledger as `reply_deferred_compliance` —
 * a terminal disposition — so the SLO scanner considered it finished.
 *
 * A scheduling handoff is not a compliance outcome.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBurstLiveness,
  classifyBurstState,
  collectBurstMetrics,
  BURST_LIVENESS_VIOLATIONS,
  BURST_LIVENESS_SEVERITY,
  BURST_METRIC_BUCKETS,
  BURST_CLAIM_GRACE_MS,
} from "@/lib/domain/seller-flow/seller-inbound-burst-liveness.js";
import {
  resolveInboundTerminalDisposition,
  TERMINAL_DISPOSITIONS,
  PENDING_DISPOSITIONS,
  isTerminalDisposition,
  isPendingDisposition,
} from "@/lib/domain/inbound/terminal-disposition.js";

// The exact production row.
const INCIDENT_BURST = {
  id: "0c2b3b2d-2a37-4489-9106-87b06fc1d4ac",
  burst_id: "sib:+16128072000:g1:ba199924-5f13-4b2e-9f2e-471658cc8d2c",
  thread_key: "+16128072000",
  status: "open",
  eligible_at: "2026-08-03T22:40:51.039Z",
  hard_close_at: "2026-08-03T22:42:01.039Z",
  first_received_at: "2026-08-03T22:40:31.039Z",
  attempt_count: 0,
};
// Observed ~2 hours later, still open.
const OBSERVED_AT = "2026-08-04T00:40:00.000Z";

// ── liveness ────────────────────────────────────────────────────────────────

test("the incident burst raises P0 violations instead of sitting silently", () => {
  const { violations } = evaluateBurstLiveness(INCIDENT_BURST, { now: OBSERVED_AT });
  const codes = violations.map((v) => v.code);

  assert.ok(
    codes.includes(BURST_LIVENESS_VIOLATIONS.STALE_OPEN_PAST_HARD_CLOSE),
    "an open burst past hard_close_at must be a violation"
  );
  assert.ok(
    codes.includes(BURST_LIVENESS_VIOLATIONS.WORKER_LIVENESS_FAILURE),
    "attempt_count=0 past the first worker window is a worker liveness failure"
  );
  for (const v of violations) {
    assert.equal(v.severity, BURST_LIVENESS_SEVERITY.P0);
    assert.equal(v.burst_id, INCIDENT_BURST.burst_id);
  }
  assert.equal(classifyBurstState(INCIDENT_BURST, { now: OBSERVED_AT }), "stale_open");
});

test("an eligible burst inside the grace window is not yet a violation", () => {
  const now = new Date(new Date(INCIDENT_BURST.eligible_at).getTime() + 30_000).toISOString();
  const { violations, state } = evaluateBurstLiveness(
    { ...INCIDENT_BURST, hard_close_at: "2026-08-04T00:00:00.000Z" },
    { now }
  );
  assert.deepEqual(violations, [], "one missed minute-tick is normal jitter");
  assert.equal(state, "eligible_waiting");
});

test("grace is bounded — past it, an unclaimed burst is P0", () => {
  const now = new Date(
    new Date(INCIDENT_BURST.eligible_at).getTime() + BURST_CLAIM_GRACE_MS + 1000
  ).toISOString();
  const { violations } = evaluateBurstLiveness(
    { ...INCIDENT_BURST, hard_close_at: "2026-08-04T00:00:00.000Z" },
    { now }
  );
  const codes = violations.map((v) => v.code);
  assert.ok(codes.includes(BURST_LIVENESS_VIOLATIONS.STALE_OPEN_PAST_ELIGIBLE));
});

test("a not-yet-eligible burst is quiet", () => {
  const now = "2026-08-03T22:40:35.000Z"; // before eligible_at
  const { violations, state } = evaluateBurstLiveness(INCIDENT_BURST, { now });
  assert.deepEqual(violations, []);
  assert.equal(state, "open_not_eligible");
});

test("a claimed burst past its lease is reclaimable, not silently lost", () => {
  const burst = {
    ...INCIDENT_BURST,
    status: "claimed",
    claimed_at: "2026-08-03T22:41:00.000Z",
    attempt_count: 1,
  };
  const { violations, state } = evaluateBurstLiveness(burst, { now: OBSERVED_AT });
  const stale = violations.find(
    (v) => v.code === BURST_LIVENESS_VIOLATIONS.STALE_CLAIMED_PAST_LEASE
  );
  assert.ok(stale, "a dead worker's claim must be reclaimable");
  assert.equal(stale.detail.reclaimable, true);
  assert.equal(state, "stale_claimed");
});

test("exhausted retries must reach an explicit failed state", () => {
  const burst = { ...INCIDENT_BURST, status: "open", attempt_count: 5 };
  const codes = evaluateBurstLiveness(burst, { now: OBSERVED_AT }).violations.map((v) => v.code);
  assert.ok(codes.includes(BURST_LIVENESS_VIOLATIONS.RETRIES_EXHAUSTED_NOT_TERMINAL));

  const failed = { ...burst, status: "failed" };
  const failed_codes = evaluateBurstLiveness(failed, { now: OBSERVED_AT }).violations.map(
    (v) => v.code
  );
  assert.ok(!failed_codes.includes(BURST_LIVENESS_VIOLATIONS.RETRIES_EXHAUSTED_NOT_TERMINAL));
});

test("a completed burst is clean", () => {
  const burst = {
    ...INCIDENT_BURST,
    status: "completed",
    attempt_count: 1,
    claimed_at: "2026-08-03T22:41:00.000Z",
    completed_at: "2026-08-03T22:41:05.000Z",
  };
  const { violations, state } = evaluateBurstLiveness(burst, { now: OBSERVED_AT });
  assert.deepEqual(violations, []);
  assert.equal(state, "completed");
});

// ── metrics ─────────────────────────────────────────────────────────────────

test("metrics expose every required bucket and the latency distributions", () => {
  const metrics = collectBurstMetrics(
    [
      INCIDENT_BURST,
      { ...INCIDENT_BURST, id: "b2", burst_id: "b2", status: "completed", attempt_count: 1, claimed_at: "2026-08-03T22:41:00.000Z", completed_at: "2026-08-03T22:41:05.000Z" },
      { ...INCIDENT_BURST, id: "b3", burst_id: "b3", status: "suppressed", attempt_count: 1 },
      { ...INCIDENT_BURST, id: "b4", burst_id: "b4", status: "claimed", claimed_at: "2026-08-03T22:41:00.000Z", attempt_count: 1 },
    ],
    { now: OBSERVED_AT, worker_invocation: 7, worker_failure: 2 }
  );

  for (const bucket of BURST_METRIC_BUCKETS) {
    assert.ok(bucket in metrics.counts, `missing metric bucket ${bucket}`);
  }
  assert.equal(metrics.counts.stale_open, 1);
  assert.equal(metrics.counts.completed, 1);
  assert.equal(metrics.counts.suppressed, 1);
  assert.equal(metrics.counts.stale_claimed, 1);
  assert.equal(metrics.worker_invocation, 7);
  assert.equal(metrics.worker_failure, 2);
  assert.ok(metrics.p0_violation_count > 0);

  // Only the burst that actually completed contributes latency.
  assert.equal(metrics.time_to_complete.count, 1);
  assert.equal(metrics.time_to_claim.count, 2);
});

test("a stuck burst never counts as fast", () => {
  const metrics = collectBurstMetrics([INCIDENT_BURST], { now: OBSERVED_AT });
  assert.equal(metrics.time_to_complete.count, 0);
  assert.equal(metrics.time_to_complete.p50_ms, null);
});

// ── ledger semantics ────────────────────────────────────────────────────────

test("deferred_to_burst_flush is NOT reply_deferred_compliance", () => {
  const resolved = resolveInboundTerminalDisposition({
    ok: true,
    deferred_burst: true,
    burst_id: INCIDENT_BURST.burst_id,
    classification: { primary_intent: "ownership_confirmed" },
    seller_stage_reply: { queued: false, reason: "deferred_to_burst_flush" },
  });

  assert.notEqual(
    resolved.disposition,
    TERMINAL_DISPOSITIONS.REPLY_DEFERRED_COMPLIANCE,
    "a scheduling handoff must never be recorded as a compliance deferral"
  );
  assert.equal(resolved.disposition, PENDING_DISPOSITIONS.REPLY_DEFERRED_BURST);
  assert.equal(resolved.pending, true);
  assert.equal(resolved.detail.awaiting_burst_finalization, true);
  assert.equal(resolved.detail.burst_id, INCIDENT_BURST.burst_id);
});

test("the burst-pending state is not a terminal disposition", () => {
  assert.equal(isTerminalDisposition(PENDING_DISPOSITIONS.REPLY_DEFERRED_BURST), false);
  assert.equal(isPendingDisposition(PENDING_DISPOSITIONS.REPLY_DEFERRED_BURST), true);
  assert.equal(isPendingDisposition(TERMINAL_DISPOSITIONS.REPLY_SENT), false);
});

test("a genuine contact-window deferral is still a compliance deferral", () => {
  const resolved = resolveInboundTerminalDisposition({
    ok: true,
    classification: { primary_intent: "ownership_confirmed" },
    seller_stage_reply: { queued: false, reason: "deferred_contact_window" },
  });
  assert.equal(resolved.disposition, TERMINAL_DISPOSITIONS.REPLY_DEFERRED_COMPLIANCE);
});

test("a durably queued reply still terminalizes as reply_sent", () => {
  const resolved = resolveInboundTerminalDisposition({
    ok: true,
    classification: { primary_intent: "ownership_confirmed" },
    seller_stage_reply: { queued: true, queue_row_id: "c171add3", reason: "queued" },
  });
  assert.equal(resolved.disposition, TERMINAL_DISPOSITIONS.REPLY_SENT);
  assert.equal(resolved.detail.reply_queue_row_id, "c171add3");
});

test("opt-out and wrong-number still win over the burst handoff", () => {
  for (const [intent, expected] of [
    ["opt_out", TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT],
    ["wrong_number", TERMINAL_DISPOSITIONS.SUPPRESSED_WRONG_NUMBER],
  ]) {
    const resolved = resolveInboundTerminalDisposition({
      ok: true,
      deferred_burst: true,
      classification: { primary_intent: intent },
      seller_stage_reply: { queued: false, reason: "deferred_to_burst_flush" },
    });
    assert.equal(resolved.disposition, expected, `${intent} must not be parked behind a burst`);
  }
});
