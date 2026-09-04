/**
 * communication-transition-authority.test.mjs
 *
 * The transition matrices, and the invariants they exist to guarantee.
 *
 * The single most important property: an outcome whose delivery cannot be
 * disproven can never regain automatic send authority, by ANY route.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateLogicalTransition,
  evaluateAttemptTransition,
  canAllocateAttempt,
  LOGICAL_STATES as S,
  DELIVERY_POSSIBILITY as D,
  RETRY_AUTHORITY as R,
  ATTEMPT_STATES as A,
  TRANSITION_CAUSES as C,
  LOGICAL_STATE_EDGES,
  TERMINAL_STATES,
  AUTOMATIC_RETRY_STATES,
} from "@/lib/domain/communications/communication-transition-authority.js";
import { mapTransportOutcome } from "@/lib/domain/communications/transport-outcome-mapping.js";

const at = (state, delivery = D.DEFINITELY_NOT_SENT, retry = R.RETRY_ALLOWED, extra = {}) => ({
  state, delivery_possibility: delivery, retry_authority: retry, ...extra,
});

const go = (current, requested, cause, now = null) =>
  evaluateLogicalTransition({ current, requested, cause, now });

// ── happy path ─────────────────────────────────────────────────────────────

test("the normal execution path is permitted end to end", () => {
  const steps = [
    [at(S.CREATED), { state: S.READY }, C.RUNTIME_READY],
    [at(S.READY), { state: S.CLAIMED }, C.ATTEMPT_CLAIMED],
    [at(S.CLAIMED), { state: S.PROVIDER_REQUEST_STARTED }, C.PROVIDER_REQUEST_START_RECORDED],
    [
      at(S.PROVIDER_REQUEST_STARTED),
      { state: S.PROVIDER_ACCEPTED, delivery_possibility: D.PROVIDER_ACCEPTED, retry_authority: R.TERMINAL },
      C.PROVIDER_SID_OBSERVED,
    ],
    [
      at(S.PROVIDER_ACCEPTED, D.PROVIDER_ACCEPTED, R.TERMINAL),
      { state: S.DELIVERED, delivery_possibility: D.DELIVERED },
      C.PROVIDER_DELIVERY_OBSERVED,
    ],
  ];
  for (const [current, requested, cause] of steps) {
    const r = go(current, requested, cause);
    assert.equal(r.ok, true, `${current.state} -> ${requested.state}: ${r.reason}`);
  }
});

// ── ambiguity is absorbing ─────────────────────────────────────────────────

test("provider_request_started may become AMBIGUOUS", () => {
  const r = go(
    at(S.PROVIDER_REQUEST_STARTED),
    { state: S.AMBIGUOUS, delivery_possibility: D.MAY_HAVE_BEEN_SENT, retry_authority: R.RETRY_DENIED },
    C.PROVIDER_TRANSPORT_AMBIGUOUS
  );
  assert.equal(r.ok, true, r.reason);
});

test("AMBIGUOUS can never reach a sendable state", () => {
  const amb = at(S.AMBIGUOUS, D.MAY_HAVE_BEEN_SENT, R.RETRY_DENIED);
  for (const target of [S.READY, S.CLAIMED, S.PROVIDER_REQUEST_STARTED, S.FAILED_RETRY_ALLOWED]) {
    const r = go(amb, { state: target }, C.RECONCILIATION);
    assert.equal(r.ok, false, `ambiguous -> ${target} must be refused`);
    assert.equal(r.reason, "illegal_state_transition");
  }
});

test("AMBIGUOUS can never hold automatic retry authority", () => {
  for (const retry of AUTOMATIC_RETRY_STATES) {
    const r = go(
      at(S.PROVIDER_REQUEST_STARTED),
      { state: S.AMBIGUOUS, delivery_possibility: D.MAY_HAVE_BEEN_SENT, retry_authority: retry },
      C.PROVIDER_TRANSPORT_AMBIGUOUS
    );
    assert.equal(r.ok, false, `ambiguous + ${retry} must be refused`);
  }
});

test("may_have_been_sent can never be walked back to definitely_not_sent in Slice 1", () => {
  // Proving a negative needs authoritative provider evidence this system cannot
  // obtain: no caller idempotency key, no verified lookup. Slice 2 may add it.
  const r = go(
    at(S.AMBIGUOUS, D.MAY_HAVE_BEEN_SENT, R.RETRY_DENIED),
    { delivery_possibility: D.DEFINITELY_NOT_SENT },
    C.RECONCILIATION
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "illegal_delivery_possibility_transition");
});

test("ambiguity is refused by the ALLOCATOR too, independently of transitions", () => {
  for (const current of [
    at(S.AMBIGUOUS, D.MAY_HAVE_BEEN_SENT, R.RETRY_DENIED),
    at(S.READY, D.MAY_HAVE_BEEN_SENT, R.RETRY_ALLOWED),
  ]) {
    const r = canAllocateAttempt(current);
    assert.equal(r.ok, false, "an ambiguous parent must not allocate an attempt");
    assert.equal(r.reason, "ambiguous_outcome_absorbing");
  }
});

// ── terminal states are final ──────────────────────────────────────────────

test("terminal states have no successors at all", () => {
  for (const t of TERMINAL_STATES) {
    assert.deepEqual(LOGICAL_STATE_EDGES[t], [], `${t} must be terminal`);
    for (const target of [S.READY, S.CLAIMED, S.PROVIDER_REQUEST_STARTED]) {
      const r = go(at(t, D.DELIVERED, R.TERMINAL), { state: target }, C.RUNTIME_READY);
      assert.equal(r.ok, false, `${t} -> ${target} must be refused`);
    }
  }
});

test("delivered never regresses", () => {
  const delivered = at(S.DELIVERED, D.DELIVERED, R.TERMINAL);
  for (const d of [D.PROVIDER_ACCEPTED, D.UNKNOWN, D.DEFINITELY_NOT_SENT, D.MAY_HAVE_BEEN_SENT]) {
    const r = go(delivered, { delivery_possibility: d }, C.RECONCILIATION);
    assert.equal(r.ok, false, `delivered -> ${d} must be refused`);
  }
});

test("provider_accepted never regresses to unsent or unknown", () => {
  const accepted = at(S.PROVIDER_ACCEPTED, D.PROVIDER_ACCEPTED, R.TERMINAL);
  for (const d of [D.UNKNOWN, D.DEFINITELY_NOT_SENT, D.MAY_HAVE_BEEN_SENT]) {
    const r = go(accepted, { delivery_possibility: d }, C.RECONCILIATION);
    assert.equal(r.ok, false, `provider_accepted -> ${d} must be refused`);
  }
});

// ── retry authority ────────────────────────────────────────────────────────

test("automatic retry requires PROVEN non-delivery", () => {
  for (const delivery of [D.MAY_HAVE_BEEN_SENT, D.PROVIDER_ACCEPTED, D.DELIVERED, D.UNKNOWN]) {
    const r = go(
      at(S.FAILED_RETRY_ALLOWED, delivery, R.RETRY_DENIED),
      { retry_authority: R.RETRY_ALLOWED },
      C.RETRY_WINDOW_ELAPSED
    );
    assert.equal(r.ok, false, `retry must not be granted while delivery is ${delivery}`);
  }
});

test("retry_after -> retry_allowed requires the deadline to have elapsed", () => {
  const base = at(S.FAILED_RETRY_ALLOWED, D.DEFINITELY_NOT_SENT, R.RETRY_AFTER, {
    retry_after_at: "2026-09-04T12:00:00.000Z",
  });

  const early = go(base, { retry_authority: R.RETRY_ALLOWED, retry_after_at: null },
    C.RETRY_WINDOW_ELAPSED, "2026-09-04T11:59:59.000Z");
  assert.equal(early.ok, false);
  assert.equal(early.reason, "retry_window_not_elapsed");

  const onTime = go(base, { retry_authority: R.RETRY_ALLOWED, retry_after_at: null },
    C.RETRY_WINDOW_ELAPSED, "2026-09-04T12:00:00.000Z");
  assert.equal(onTime.ok, true, onTime.reason);

  // ...and only with the right cause.
  const wrongCause = go(base, { retry_authority: R.RETRY_ALLOWED, retry_after_at: null },
    C.RUNTIME_READY, "2026-09-04T12:00:01.000Z");
  assert.equal(wrongCause.ok, false);
  assert.equal(wrongCause.reason, "retry_window_requires_elapsed_cause");
});

test("operator_hold is released only by an explicit remediation cause", () => {
  const held = at(S.FAILED_RETRY_ALLOWED, D.DEFINITELY_NOT_SENT, R.OPERATOR_HOLD);
  assert.equal(go(held, { retry_authority: R.RETRY_ALLOWED }, C.RETRY_WINDOW_ELAPSED).ok, false);
  assert.equal(go(held, { retry_authority: R.RETRY_ALLOWED }, C.CONFIGURATION_HOLD).ok, true);
});

test("retry_after_at pairing is exact in both directions", () => {
  const base = at(S.FAILED_RETRY_ALLOWED, D.DEFINITELY_NOT_SENT, R.RETRY_ALLOWED);

  const noDeadline = go(base, { retry_authority: R.RETRY_AFTER }, C.RETRY_BACKOFF);
  assert.equal(noDeadline.ok, false);
  assert.equal(noDeadline.reason, "retry_after_requires_retry_after_at");

  const withDeadline = go(base,
    { retry_authority: R.RETRY_AFTER, retry_after_at: "2026-09-04T12:00:00.000Z" }, C.RETRY_BACKOFF);
  assert.equal(withDeadline.ok, true, withDeadline.reason);

  // A stale deadline must not survive into a non-retry_after state: any scanner
  // reading retry_after_at would treat the row as due.
  const stale = go(
    at(S.FAILED_RETRY_ALLOWED, D.DEFINITELY_NOT_SENT, R.RETRY_AFTER, { retry_after_at: "2026-09-04T12:00:00.000Z" }),
    { retry_authority: R.RETRY_DENIED, retry_after_at: "2026-09-04T12:00:00.000Z" },
    C.PROVIDER_TRANSPORT_AMBIGUOUS
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "retry_after_at_only_valid_with_retry_after");
});

// ── evidence must actually evidence the claim ──────────────────────────────

test("a transition without a cause is refused", () => {
  assert.equal(go(at(S.CREATED), { state: S.READY }, "").reason, "transition_cause_required");
  assert.equal(go(at(S.CREATED), { state: S.READY }, "made_up").reason, "unknown_transition_cause");
});

test("a cause may only assert the delivery fact it actually evidences", () => {
  // Suppression does not observe a provider SID.
  const bad = go(at(S.PROVIDER_REQUEST_STARTED), { delivery_possibility: D.PROVIDER_ACCEPTED },
    C.RUNTIME_SUPPRESSION);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "cause_cannot_change_delivery_possibility");

  // A definitive rejection cannot claim the provider accepted it.
  const wrong = go(at(S.PROVIDER_REQUEST_STARTED), { delivery_possibility: D.PROVIDER_ACCEPTED },
    C.PROVIDER_DEFINITIVE_REJECTION);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "cause_does_not_evidence_delivery_possibility");
});

test("NO_SEND cannot conceal a possible external side effect", () => {
  // Marking "no send" after the request may already have gone out would erase
  // the one fact reconciliation needs.
  for (const delivery of [D.MAY_HAVE_BEEN_SENT, D.PROVIDER_ACCEPTED]) {
    const r = go(at(S.PROVIDER_REQUEST_STARTED, delivery, R.RETRY_DENIED),
      { state: S.NO_SEND }, C.INTERNAL_NO_SEND);
    assert.equal(r.ok, false, `no_send after ${delivery} must be refused`);
  }
  // But a communication that never left is fine to quarantine.
  const ok = go(at(S.READY), { state: S.NO_SEND, retry_authority: R.TERMINAL }, C.INTERNAL_NO_SEND);
  assert.equal(ok.ok, true, ok.reason);
});

test("no_send requires an authorising cause", () => {
  const r = go(at(S.READY), { state: S.NO_SEND, retry_authority: R.TERMINAL }, C.RUNTIME_READY);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_send_requires_authorising_cause");
});

// ── attempts ───────────────────────────────────────────────────────────────

test("attempt edges follow execution order and never regress", () => {
  assert.equal(evaluateAttemptTransition({ from: A.CREATED, to: A.CLAIMED }).ok, true);
  assert.equal(evaluateAttemptTransition({ from: A.CLAIMED, to: A.PROVIDER_REQUEST_STARTED }).ok, true);
  assert.equal(evaluateAttemptTransition({ from: A.PROVIDER_REQUEST_STARTED, to: A.AMBIGUOUS }).ok, true);

  for (const bad of [
    [A.AMBIGUOUS, A.CLAIMED],
    [A.AMBIGUOUS, A.PROVIDER_REQUEST_STARTED],
    [A.COMPLETED, A.CLAIMED],
    [A.PROVIDER_ACCEPTED, A.PROVIDER_REQUEST_STARTED],
    [A.CREATED, A.PROVIDER_REQUEST_STARTED],
  ]) {
    const r = evaluateAttemptTransition({ from: bad[0], to: bad[1] });
    assert.equal(r.ok, false, `${bad[0]} -> ${bad[1]} must be refused`);
  }
});

// ── allocator ──────────────────────────────────────────────────────────────

test("the allocator refuses every non-sendable posture", () => {
  assert.equal(canAllocateAttempt(at(S.READY, D.DEFINITELY_NOT_SENT, R.RETRY_ALLOWED)).ok, true);
  assert.equal(canAllocateAttempt(at(S.DELIVERED, D.DELIVERED, R.TERMINAL)).reason, "state_forbids_attempt");
  assert.equal(canAllocateAttempt(at(S.NO_SEND, D.DEFINITELY_NOT_SENT, R.TERMINAL)).reason, "state_forbids_attempt");
  assert.equal(canAllocateAttempt(at(S.READY, D.DEFINITELY_NOT_SENT, R.RETRY_DENIED)).reason, "retry_authority_denies");
  assert.equal(canAllocateAttempt(at(S.READY, D.DEFINITELY_NOT_SENT, R.OPERATOR_HOLD)).reason, "retry_authority_denies");
});

// ── Slice 0 classifier mapping ─────────────────────────────────────────────

test("transport outcomes map to three separate facts, not one boolean", () => {
  const cases = [
    ["accepted with sid", { ok: true, provider_message_id: "SM1" },
      D.PROVIDER_ACCEPTED, R.TERMINAL, A.PROVIDER_ACCEPTED],
    ["ambiguous transport", { failure_class: "provider_ambiguous_transport", may_have_transmitted: true },
      D.MAY_HAVE_BEEN_SENT, R.RETRY_DENIED, A.AMBIGUOUS],
    ["sid-less accept", { failure_class: "provider_ambiguous_accept" },
      D.MAY_HAVE_BEEN_SENT, R.RETRY_DENIED, A.AMBIGUOUS],
    ["refused connection", { failure_class: "provider_unreachable_before_request" },
      D.DEFINITELY_NOT_SENT, R.RETRY_ALLOWED, A.FAILED_PROVABLY_UNSENT],
    ["invalid recipient", { failure_class: "invalid_to_number" },
      D.DEFINITELY_NOT_SENT, R.TERMINAL, A.FAILED_TERMINAL],
    ["opted out", { failure_class: "recipient_opted_out" },
      D.DEFINITELY_NOT_SENT, R.TERMINAL, A.FAILED_TERMINAL],
    ["auth failure", { failure_class: "provider_auth_failed" },
      D.DEFINITELY_NOT_SENT, R.OPERATOR_HOLD, A.FAILED_TERMINAL],
    ["unknown", { failure_class: "unknown_failure" },
      D.MAY_HAVE_BEEN_SENT, R.RETRY_DENIED, A.AMBIGUOUS],
  ];
  for (const [label, classified, delivery, retry, attempt] of cases) {
    const m = mapTransportOutcome(classified);
    assert.equal(m.delivery_possibility, delivery, `${label}: delivery`);
    assert.equal(m.retry_authority, retry, `${label}: retry`);
    assert.equal(m.attempt_state, attempt, `${label}: attempt`);
  }
});

test("the two axes genuinely differ: proven-unsent does not imply retryable", () => {
  const invalid = mapTransportOutcome({ failure_class: "invalid_to_number" });
  const refused = mapTransportOutcome({ failure_class: "provider_unreachable_before_request" });

  // Same delivery fact...
  assert.equal(invalid.delivery_possibility, refused.delivery_possibility);
  assert.equal(invalid.delivery_possibility, D.DEFINITELY_NOT_SENT);
  // ...opposite retry authority. This is the modelling correction in one assertion.
  assert.equal(invalid.retry_authority, R.TERMINAL);
  assert.equal(refused.retry_authority, R.RETRY_ALLOWED);
});

test("an unclassified outcome fails closed, never retry-safe", () => {
  for (const c of [{}, { failure_class: "" }, { failure_class: "something_new" }]) {
    const m = mapTransportOutcome(c);
    assert.equal(m.delivery_possibility, D.MAY_HAVE_BEEN_SENT);
    assert.equal(m.retry_authority, R.RETRY_DENIED);
  }
});

test("every mapped outcome is itself a legal transition from provider_request_started", () => {
  // Guards against the mapping producing a posture the authority would refuse.
  for (const classified of [
    { ok: true, provider_message_id: "SM1" },
    { failure_class: "provider_ambiguous_transport", may_have_transmitted: true },
    { failure_class: "provider_unreachable_before_request" },
    { failure_class: "invalid_to_number" },
    { failure_class: "provider_auth_failed" },
  ]) {
    const m = mapTransportOutcome(classified);
    // Realistic starting posture: a communication can only REACH
    // provider_request_started by holding automatic retry authority at
    // allocation time, so retry_denied is not a reachable predecessor here.
    const r = go(
      at(S.PROVIDER_REQUEST_STARTED, D.UNKNOWN, R.RETRY_ALLOWED),
      { state: m.logical_state, delivery_possibility: m.delivery_possibility, retry_authority: m.retry_authority },
      m.cause
    );
    assert.equal(r.ok, true, `${m.reason}: ${r.reason}`);
  }
});
