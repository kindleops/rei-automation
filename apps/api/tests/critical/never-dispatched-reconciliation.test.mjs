/**
 * CLEARING AN AMBIGUOUS ATTEMPT REQUIRES PROOF, NOT CONVENIENCE (§1, §2).
 *
 * The ambiguity guard is the last thing standing between a provider hiccup and
 * messaging a human twice, so a tool that clears it is inherently dangerous.
 * These tests hold the property that makes it safe: it refuses unless the
 * durable evidence itself shows no transport ever occurred, and it can never be
 * used as a general "mark this failed" escape hatch.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isAmbiguousSendRow } from "@/lib/domain/messaging/ambiguous-send-evidence.js";
import {
  LEDGER_SUPERSEDED_FAILURE_CLASS,
  evaluateLedgerTerminalEvidence,
  reconcileFromCanonicalAttemptVerdict,
  NEVER_DISPATCHED_FAILURE_CLASS,
  evaluateNeverDispatchedEvidence,
  reconcileNeverDispatchedAttempt,
} from "@/lib/domain/communications/reconcile-never-dispatched-attempt.js";

const ambiguousRow = (over = {}) => ({
  id: "q-1",
  queue_status: "failed",
  to_phone_number: "+16128072000",
  provider_message_id: null,
  textgrid_message_id: null,
  sent_at: null,
  metadata: {
    provider_error: {
      failure_class: "provider_ambiguous_accept",
      normalized_reason: "provider_response_missing_sid",
      message: "SEND FAILED - NO SID",
    },
  },
  ...over,
});

const preTransportAttempt = (over = {}) => ({
  id: "a-1",
  provider_message_id: null,
  http_status: null,
  provider_status: null,
  transport_phase: "request_started",
  outcome_class: "ambiguous",
  delivery_possibility: "may_have_been_sent",
  ...over,
});

const deps = (over = {}) => ({
  loadQueueRow: async () => ambiguousRow(),
  loadAttempt: async () => preTransportAttempt(),
  countCallbacks: async () => 0,
  applyPatch: async () => {},
  evidence_reference: "project_s11_live_canary_ambiguous: deterministic reproduction",
  actor: "campaign_certification",
  queue_row_id: "q-1",
  ...over,
});

// ── it refuses whenever transport MIGHT have happened

test("a row holding a provider message id is NEVER reconciled", () => {
  const verdict = evaluateNeverDispatchedEvidence({
    queue_row: ambiguousRow({ provider_message_id: "SM123" }),
    attempt: preTransportAttempt(),
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.includes("queue_row_holds_provider_message_id"));
});

test("an attempt with an HTTP STATUS means bytes moved — refused", () => {
  // An HTTP status can only exist if the request reached the provider.
  const verdict = evaluateNeverDispatchedEvidence({
    queue_row: ambiguousRow(),
    attempt: preTransportAttempt({ http_status: 500 }),
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.includes("attempt_has_http_status"));
});

test("ANY callback for the destination refuses the reconciliation", async () => {
  const result = await reconcileNeverDispatchedAttempt(deps({ countCallbacks: async () => 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transport_evidence_present");
});

test("an attempt that advanced past request_started is refused", () => {
  const verdict = evaluateNeverDispatchedEvidence({
    queue_row: ambiguousRow(),
    attempt: preTransportAttempt({ transport_phase: "response_received" }),
  });
  assert.equal(verdict.ok, false);
});

test("a row that is not ambiguous is left alone", async () => {
  const result = await reconcileNeverDispatchedAttempt(deps({
    loadQueueRow: async () => ambiguousRow({ metadata: { provider_error: { failure_class: "carrier_rejected" } } }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "row_is_not_ambiguous");
});

// ── it refuses to be unauditable

test("an unreferenced reconciliation is refused", async () => {
  assert.equal((await reconcileNeverDispatchedAttempt(deps({ evidence_reference: "" }))).reason,
    "evidence_reference_required");
  assert.equal((await reconcileNeverDispatchedAttempt(deps({ actor: "" }))).reason, "actor_required");
});

// ── what it does when the evidence is genuinely conclusive

test("a proven never-dispatched attempt is reconciled, and STOPS BEING AMBIGUOUS", async () => {
  let patched = null;
  const result = await reconcileNeverDispatchedAttempt(deps({
    applyPatch: async (_id, patch) => { patched = patch },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.before.failure_class, "provider_ambiguous_accept");
  assert.equal(result.after.failure_class, NEVER_DISPATCHED_FAILURE_CLASS);

  // The point of the exercise: the guard must no longer see it as ambiguous.
  assert.equal(isAmbiguousSendRow({ metadata: patched.metadata }), false);
});

test("the ORIGINAL verdict is preserved, not erased", async () => {
  let patched = null;
  await reconcileNeverDispatchedAttempt(deps({ applyPatch: async (_id, p) => { patched = p } }));
  const superseded = patched.metadata.provider_error.superseded_evidence;
  assert.equal(superseded.failure_class, "provider_ambiguous_accept");
  assert.equal(superseded.message, "SEND FAILED - NO SID");
  assert.ok(superseded.superseded_at);
});

test("it records who, why and on what evidence", async () => {
  let patched = null;
  await reconcileNeverDispatchedAttempt(deps({ applyPatch: async (_id, p) => { patched = p } }));
  const audit = patched.metadata.ambiguity_reconciliation;
  assert.match(audit.evidence_reference, /deterministic reproduction/);
  assert.equal(audit.actor, "campaign_certification");
  assert.ok(audit.reconciled_at);
  assert.equal(audit.before.delivery_possibility, "may_have_been_sent");
});

test("IT NEVER AUTHORISES RETRYING THE ORIGINAL ATTEMPT", async () => {
  // Clearing the recipient for NEW work is not the same as resurrecting the
  // old logical attempt, whose identity stays consumed.
  let patched = null;
  await reconcileNeverDispatchedAttempt(deps({ applyPatch: async (_id, p) => { patched = p } }));
  assert.equal(patched.metadata.ambiguity_reconciliation.logical_attempt_retryable, false);
});


// ── the second shape: the ledger holds a terminal verdict the queue row lost

const terminalAttempt = (over = {}) => ({
  id: "a-2",
  provider_message_id: null,
  http_status: 400,
  provider_status: null,
  transport_phase: "unknown",
  outcome_class: "failed_terminal",
  delivery_possibility: "definitely_not_sent",
  ...over,
});

const ledgerDeps = (over = {}) => ({
  loadQueueRow: async () => ambiguousRow(),
  loadAttempt: async () => terminalAttempt(),
  countCallbacks: async () => 0,
  applyPatch: async () => {},
  evidence_reference: "canonical attempt ledger e068b487: http 400, definitely_not_sent",
  actor: "campaign_certification",
  queue_row_id: "q-2",
  ...over,
});

test("THE CANONICAL LEDGER OUTRANKS THE QUEUE ROW'S SYNTHETIC AMBIGUITY", async () => {
  // The runner mints Error("SEND FAILED - NO SID") and discards the seam's real
  // verdict. The ledger kept it: http 400, definitely_not_sent. The ledger wins.
  let patched = null;
  const result = await reconcileFromCanonicalAttemptVerdict(ledgerDeps({
    applyPatch: async (_id, p) => { patched = p },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.before.delivery_possibility, "definitely_not_sent");
  assert.equal(result.before.http_status, 400);
  assert.equal(result.after.failure_class, LEDGER_SUPERSEDED_FAILURE_CLASS);
  assert.equal(isAmbiguousSendRow({ metadata: patched.metadata }), false);
});

test("a ledger that does NOT say definitely_not_sent is refused", async () => {
  const result = await reconcileFromCanonicalAttemptVerdict(ledgerDeps({
    loadAttempt: async () => terminalAttempt({ delivery_possibility: "may_have_been_sent" }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ledger_verdict_not_terminal");
});

test("a ledger verdict is IGNORED if a provider message id exists anywhere", () => {
  // A SID means the provider accepted it; no ledger conclusion outranks that.
  assert.equal(evaluateLedgerTerminalEvidence({
    queue_row: ambiguousRow({ provider_message_id: "SM999" }),
    attempt: terminalAttempt(),
  }).ok, false);

  assert.equal(evaluateLedgerTerminalEvidence({
    queue_row: ambiguousRow(),
    attempt: terminalAttempt({ provider_message_id: "SM999" }),
  }).ok, false);
});

test("a delivery callback for the destination refuses the ledger path too", () => {
  assert.equal(evaluateLedgerTerminalEvidence({
    queue_row: ambiguousRow(),
    attempt: terminalAttempt(),
    callback_count: 1,
  }).ok, false);
});

test("with no canonical attempt record at all, the ledger path refuses", () => {
  const verdict = evaluateLedgerTerminalEvidence({ queue_row: ambiguousRow(), attempt: null });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.includes("no_canonical_attempt_record"));
});
