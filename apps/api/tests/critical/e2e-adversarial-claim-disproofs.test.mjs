/**
 * Adversarial disproofs — written to FAIL if the compliance and extraction
 * claims this PR rests on are false.
 *
 * Every assertion here targets a claim that was asserted to be true, at the
 * layer where a real caller would be harmed rather than at the layer where the
 * unit under test is convenient. Several of these were red when written; that
 * is the point of the file.
 *
 * Scope note: `patchUniversalLeadState` is the ONLY writer of contactability /
 * suppression state, and it normalizes its patch BEFORE the evidence gate runs
 * (patch-universal-lead-state.js:263 precedes :276). So a gate assertion made
 * against `authorizeSuppressionMutation` in isolation proves nothing about what
 * the writer actually does — normalization can delete the very field the gate
 * was meant to judge. These tests therefore go through the registry
 * normalization the writer uses, not around it.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  normalizePatchToCanonical,
  BLOCKING_CONTACTABILITY,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import {
  authorizeSuppressionMutation,
  patchAssertsBindingSuppression,
  detectSuppressionContradictions,
  BLOCKING_CONTACTABILITY_VALUES,
  SELF_EVIDENCING_CONTACTABILITY,
} from "@/lib/domain/lead-state/suppression-evidence.js";

const heuristic = (message) => classify(message, null, { heuristicOnly: true });

// ── CLAIM: "a confirmed wrong number is suppressed" ─────────────────────────

test("a confirmed wrong number never normalizes into 'contactable'", () => {
  // `wrong_number` used to be absent from the alias map, so normalizeContactability
  // fell through to its `contactable` default — a patch asserting we have the
  // wrong person became permission to keep texting. It now maps onto the
  // canonical blocking value the seller flow itself emits
  // (seller-flow-decision-contract.js:86,93).
  const canonical = normalizePatchToCanonical({ contactability_status: "wrong_number" });
  assert.notEqual(canonical.contactability_status, "contactable");
  assert.ok(
    BLOCKING_CONTACTABILITY.has(canonical.contactability_status),
    `a confirmed wrong number must land on a blocking value, got ${canonical.contactability_status}`
  );
});

test("a blocking value is either gated by evidence or self-evidencing — never neither", () => {
  // The real invariant behind the gate. `opted_out` / `invalid_number` /
  // `wrong_number` name their own reason and are exempt by design
  // (suppression-evidence.js:50-56); everything else that blocks sending must
  // present evidence. A value in neither set would be evidence-free suppression,
  // which is the shape the 2026-08-04 audit found 114 times.
  for (const value of BLOCKING_CONTACTABILITY) {
    const canonical = normalizePatchToCanonical({ contactability_status: value });
    const self_evidencing = SELF_EVIDENCING_CONTACTABILITY.includes(value);
    const gated = !authorizeSuppressionMutation({ patch: canonical, evidence: null }).allowed;
    assert.ok(
      self_evidencing || gated,
      `${value} blocks sending but is neither self-evidencing nor evidence-gated`
    );
  }
});

// ── CLAIM: "binding suppression cannot be written without evidence" ─────────

test("every blocking contactability value is judged by the evidence gate", () => {
  // The gate's allowlist was narrower than the registry's blocking set. Any
  // value in the gap reaches buildRowPatch, which sets is_suppressed = true
  // (patch-universal-lead-state.js:199-201) with no evidence required —
  // evidence-free suppression, the 2026-08-04 audit shape.
  //
  // `opted_out` and `wrong_number` are deliberately exempt: they are
  // self-evidencing by design (suppression-evidence.js:50-56) because the value
  // itself names the reason and can only be produced by an explicit seller
  // signal. `do_not_text` is NOT exempt — that is the manufactured catch-all
  // the incident was made of.
  for (const value of BLOCKING_CONTACTABILITY) {
    if (SELF_EVIDENCING_CONTACTABILITY.includes(value)) continue;
    const canonical = normalizePatchToCanonical({ contactability_status: value });
    if (canonical.contactability_status !== value) continue; // normalized away; covered elsewhere
    assert.equal(
      patchAssertsBindingSuppression(canonical),
      true,
      `${value} blocks sending, so it must require suppression evidence`
    );
    assert.equal(
      authorizeSuppressionMutation({ patch: canonical, evidence: null }).allowed,
      false,
      `${value} must not be writable without evidence`
    );
  }
});

test("the gate's blocking list and the registry's blocking set agree", () => {
  // A structural guard on the divergence above: two lists that must not drift.
  for (const value of BLOCKING_CONTACTABILITY) {
    assert.ok(
      BLOCKING_CONTACTABILITY_VALUES.includes(value),
      `registry treats ${value} as blocking but the suppression gate does not know it`
    );
  }
});

// ── CLAIM: "a suppression assertion survives to the gate" ───────────────────

test("KNOWN DEFECT: suppression-asserting fields are dropped by normalization before the gate sees them (see PR #66)", () => {
  // Characterizes CURRENT behaviour so a future fix fails loudly here.
  //
  // patchAssertsBindingSuppression inspects is_suppressed, disposition and
  // inbox_bucket — but patchUniversalLeadState normalizes the patch at :263,
  // BEFORE the evidence gate reads it at :276. None of the three survive
  // normalization, so those three gate branches are unreachable through the only
  // writer of suppression state, and the compensating deletes at :283-289 are
  // dead code.
  //
  // Not an open hole on the live path: the reachable producers write a canonical
  // blocking contactability value, which IS gated (see the evidence-gate test
  // above). This pins the structural gap so it cannot be mistaken for coverage.
  for (const [patch, expected] of [
    [{ is_suppressed: true }, {}],
    [{ inbox_bucket: "suppressed" }, {}],
    [{ disposition: "suppressed" }, { disposition: "none" }],
  ]) {
    const canonical = normalizePatchToCanonical(patch);
    assert.deepEqual(canonical, expected, `CURRENT BEHAVIOUR for ${JSON.stringify(patch)}`);
    assert.equal(
      patchAssertsBindingSuppression(canonical),
      false,
      `CURRENT BEHAVIOUR: ${JSON.stringify(patch)} no longer reads as binding suppression once normalized`
    );
  }
});

// ── CLAIM: "contactable + suppressed cannot coexist" ────────────────────────

test("a contactable row that is also binding-suppressed is always a contradiction", () => {
  for (const row of [
    { is_suppressed: true, contactability_status: "contactable" },
    { disposition: "suppressed", contactability_status: "contactable" },
    { inbox_bucket: "suppressed", contactability_status: "contactable" },
  ]) {
    assert.ok(
      detectSuppressionContradictions(row).includes("contactable_while_binding_suppressed"),
      `${JSON.stringify(row)} is self-contradictory and must be reported`
    );
  }
});

test("contradiction detection is case- and whitespace-insensitive", () => {
  // Values arrive from routes and CSV imports, not only from code.
  assert.ok(
    detectSuppressionContradictions({
      is_suppressed: true,
      contactability_status: " CONTACTABLE ",
    }).includes("contactable_while_binding_suppressed"),
    "casing must not let a contradictory row through"
  );
});

test("automation running under a blocking contactability is reported", () => {
  assert.ok(
    detectSuppressionContradictions({
      contactability_status: "do_not_text",
      automation_state: "running",
    }).includes("automation_running_while_binding_suppressed"),
    "a blocked thread with live automation must be flagged"
  );
});

// ── CLAIM: "'alone' phrasing is not an opt-out unless it is one" ────────────

test("explicit opt-out language is an opt-out", async () => {
  for (const message of [
    "leave me alone",
    "please leave me alone",
    "stop calling me and leave me alone",
    "just leave me alone already",
  ]) {
    const result = await heuristic(message);
    assert.equal(result.primary_intent, "opt_out", `${JSON.stringify(message)} is an opt-out`);
    assert.equal(result.compliance_flag, "stop_texting");
  }
});

test("'alone' describing the property or the household is NOT an opt-out", async () => {
  // Suppressing these would silently delete a live seller. The 2026-08-04 audit
  // found 114 threads suppressed with no durable evidence; over-matching
  // compliance vocabulary is one way that happens.
  for (const message of [
    "I live here alone",
    "the house is alone on the lot",
    "my mom lives there alone",
    "it sits alone at the end of the street",
    "she has been living alone since my dad passed",
  ]) {
    const result = await heuristic(message);
    assert.notEqual(
      result.primary_intent,
      "opt_out",
      `${JSON.stringify(message)} describes the property or household, not a request to stop`
    );
    assert.notEqual(result.compliance_flag, "stop_texting");
  }
});

// ── CLAIM: "a call request needs a request subject" ─────────────────────────

test("reporting an existing appointment is not a callback request", async () => {
  for (const message of [
    "I have a call at 3",
    "I have a call with my attorney tomorrow",
    "im in a call right now",
  ]) {
    const result = await heuristic(message);
    assert.notEqual(
      result.primary_intent,
      "callback_requested",
      `${JSON.stringify(message)} reports an appointment; it does not ask us to call`
    );
    assert.equal(
      (result.secondary_intents || []).includes("callback_requested"),
      false,
      `${JSON.stringify(message)} must not carry callback_requested as a secondary intent either — a secondary intent still drives downstream routing`
    );
  }
});

test("genuine call requests still classify as callback_requested", async () => {
  // The other half of the contract: narrowing the phrase list must not silence
  // real call readiness.
  for (const message of [
    "can we have a call",
    "lets set up a call",
    "give me a call tomorrow",
    "call me",
    "we can schedule a call and talk",
    "what is a good time to call",
  ]) {
    const result = await heuristic(message);
    const intents = [result.primary_intent, ...(result.secondary_intents || [])];
    assert.ok(
      intents.includes("callback_requested"),
      `${JSON.stringify(message)} is a real call request — got ${JSON.stringify(intents)}`
    );
  }
});
