/**
 * provider-outcome-lattice.test.mjs
 *
 * Provider knowledge may increase. It may never quietly decrease.
 *
 * The case that matters most is out-of-order delivery: `delivered` followed by
 * `sent`. Both are real TextGrid statuses, the second arrives later, and ranking
 * by arrival time would downgrade a delivered message to "sent". Rank belongs to
 * the status, never to the clock.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_OUTCOME,
  normalizeProviderStatus,
  deliveryPossibilityFor,
  advanceProviderOutcome,
  isTerminalProviderOutcome,
} from "@/lib/domain/communications/provider-outcome-lattice.js";

// ── vocabulary ────────────────────────────────────────────────────────────

test("the three statuses production actually produces are recognised", () => {
  // Measured, not assumed: delivered 7746, failed 2708, sent 40.
  for (const [raw, expected] of [
    ["delivered", PROVIDER_OUTCOME.DELIVERED],
    ["failed", PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE],
    ["sent", PROVIDER_OUTCOME.SENT_BY_PROVIDER],
  ]) {
    const n = normalizeProviderStatus(raw);
    assert.equal(n.outcome, expected, raw);
    assert.equal(n.recognised, true, raw);
  }
});

test("status matching is case and whitespace insensitive", () => {
  assert.equal(normalizeProviderStatus("  DELIVERED ").outcome, PROVIDER_OUTCOME.DELIVERED);
});

test("an unrecognised status is inert, never a guess", () => {
  const n = normalizeProviderStatus("teleported");
  assert.equal(n.outcome, PROVIDER_OUTCOME.UNKNOWN);
  assert.equal(n.recognised, false);
  assert.equal(advanceProviderOutcome(PROVIDER_OUTCOME.DELIVERED, n.outcome).action, "inert");
});

// ── THE load-bearing mapping ──────────────────────────────────────────────

test("a provider `failed` callback is NOT definitely_not_sent", () => {
  // All 2,086 delivery_failed rows in production carry a SID; all 622 local
  // failures carry none. A provider failure therefore always describes a message
  // the provider had already accepted.
  const failed = normalizeProviderStatus("failed").outcome;
  assert.equal(deliveryPossibilityFor(failed), "provider_accepted");
  assert.notEqual(deliveryPossibilityFor(failed), "definitely_not_sent");
});

test("NO provider status maps to definitely_not_sent", () => {
  // If this ever fails, someone has invented a proof of non-delivery that
  // TextGrid does not give us, and retry authority would follow.
  for (const raw of ["delivered", "failed", "undelivered", "sent", "accepted", "queued", "nonsense"]) {
    const possibility = deliveryPossibilityFor(normalizeProviderStatus(raw).outcome);
    assert.notEqual(possibility, "definitely_not_sent",
      `${raw} must not claim the seller received nothing`);
  }
});

// ── monotonicity ──────────────────────────────────────────────────────────

test("certainty may increase", () => {
  const advances = [
    [PROVIDER_OUTCOME.UNKNOWN, PROVIDER_OUTCOME.PROVIDER_ACCEPTED],
    [PROVIDER_OUTCOME.UNKNOWN, PROVIDER_OUTCOME.DELIVERED],
    [PROVIDER_OUTCOME.PROVIDER_ACCEPTED, PROVIDER_OUTCOME.SENT_BY_PROVIDER],
    [PROVIDER_OUTCOME.PROVIDER_ACCEPTED, PROVIDER_OUTCOME.DELIVERED],
    [PROVIDER_OUTCOME.SENT_BY_PROVIDER, PROVIDER_OUTCOME.DELIVERED],
    [PROVIDER_OUTCOME.QUEUED_BY_PROVIDER, PROVIDER_OUTCOME.PROVIDER_ACCEPTED],
  ];
  for (const [from, to] of advances) {
    assert.equal(advanceProviderOutcome(from, to).action, "advance", `${from} -> ${to}`);
  }
});

test("repeating the same outcome is idempotent, not a second application", () => {
  assert.equal(advanceProviderOutcome(PROVIDER_OUTCOME.DELIVERED, PROVIDER_OUTCOME.DELIVERED).action,
    "idempotent");
});

test("OUT OF ORDER: delivered then sent does NOT downgrade", () => {
  // The whole reason rank is semantic rather than chronological.
  const verdict = advanceProviderOutcome(PROVIDER_OUTCOME.DELIVERED, PROVIDER_OUTCOME.SENT_BY_PROVIDER);
  assert.equal(verdict.action, "stale");
  assert.equal(verdict.reason, "weaker_than_current_provider_truth");
});

test("delivered can never regress to a weaker class", () => {
  for (const weaker of [
    PROVIDER_OUTCOME.SENT_BY_PROVIDER,
    PROVIDER_OUTCOME.PROVIDER_ACCEPTED,
    PROVIDER_OUTCOME.QUEUED_BY_PROVIDER,
    PROVIDER_OUTCOME.UNKNOWN,
  ]) {
    const action = advanceProviderOutcome(PROVIDER_OUTCOME.DELIVERED, weaker).action;
    assert.ok(["stale", "inert"].includes(action),
      `delivered -> ${weaker} must not advance (got ${action})`);
  }
});

test("provider_accepted cannot regress to unknown", () => {
  assert.equal(
    advanceProviderOutcome(PROVIDER_OUTCOME.PROVIDER_ACCEPTED, PROVIDER_OUTCOME.UNKNOWN).action,
    "inert");
});

// ── contradiction, not overwrite ──────────────────────────────────────────

test("delivered vs failed is a CONFLICT, never a silent overwrite", () => {
  // Equal rank, opposite verdicts. Recording it as a conflict is what keeps a
  // late `failed` from erasing a delivery the seller actually received.
  const a = advanceProviderOutcome(
    PROVIDER_OUTCOME.DELIVERED, PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE);
  assert.equal(a.action, "conflict");

  const b = advanceProviderOutcome(
    PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE, PROVIDER_OUTCOME.DELIVERED);
  assert.equal(b.action, "conflict");
});

test("both terminal verdicts are recognised as terminal", () => {
  assert.equal(isTerminalProviderOutcome(PROVIDER_OUTCOME.DELIVERED), true);
  assert.equal(isTerminalProviderOutcome(PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE), true);
  assert.equal(isTerminalProviderOutcome(PROVIDER_OUTCOME.SENT_BY_PROVIDER), false);
});

// ── the sequences the mission names explicitly ────────────────────────────

test("the named callback sequences all resolve correctly", () => {
  const SEQ = [
    { name: "accepted -> sent -> delivered", steps: ["accepted", "sent", "delivered"], final: PROVIDER_OUTCOME.DELIVERED },
    { name: "delivered -> sent (late)", steps: ["delivered", "sent"], final: PROVIDER_OUTCOME.DELIVERED },
    { name: "delivered -> accepted (late)", steps: ["delivered", "accepted"], final: PROVIDER_OUTCOME.DELIVERED },
    { name: "duplicate delivered", steps: ["delivered", "delivered"], final: PROVIDER_OUTCOME.DELIVERED },
    { name: "sent -> failed", steps: ["sent", "failed"], final: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE },
    { name: "duplicate failed", steps: ["failed", "failed"], final: PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE },
  ];

  for (const { name, steps, final } of SEQ) {
    let current = PROVIDER_OUTCOME.UNKNOWN;
    for (const raw of steps) {
      const incoming = normalizeProviderStatus(raw).outcome;
      if (advanceProviderOutcome(current, incoming).action === "advance") current = incoming;
    }
    assert.equal(current, final, name);
  }
});

test("failed -> delivered is held as a conflict, not applied", () => {
  // Called out separately because it is the one sequence where "take the newer
  // callback" would look reasonable and be wrong.
  let current = normalizeProviderStatus("failed").outcome;
  const incoming = normalizeProviderStatus("delivered").outcome;
  const verdict = advanceProviderOutcome(current, incoming);
  assert.equal(verdict.action, "conflict");
  // current is unchanged: a conflict is recorded for a human, not auto-resolved.
  assert.equal(current, PROVIDER_OUTCOME.DELIVERY_FAILED_AFTER_ACCEPTANCE);
});
