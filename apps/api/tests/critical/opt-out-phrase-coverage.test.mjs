/**
 * opt-out-phrase-coverage.test.mjs
 *
 * Audit of the contact-cessation resolver prompted by live thread ••1156:
 * "rwmove me from all you lists" classified as unclear at 0.60 and stayed in the
 * ACTIVE conversation lane instead of being suppressed.
 *
 * Finding: the resolver was NOT missing that phrase family. "remove me",
 * "remove me from your list", "take me off your list" and "stop texting me" all
 * matched already; the live miss was a MISSPELLING ("rwmove"). Only one idiom
 * the operator named was genuinely absent -- "lose my number" -- and that is the
 * sole addition. No typo tolerance and no widened semantics: this file pins both
 * the additions AND the non-cessation phrases that must keep passing through.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { detectInboundIntent } from "@/lib/domain/classification/classify.js";

// primary_intent is the field the suppression decision actually reads
// (apply-inbound-automation-decision.js ~376). A compliance_flag of
// "stop_texting" is what drives it to "opt_out" at confidence 0.99.
function intentOf(body) {
  return detectInboundIntent(body)?.primary_intent || null;
}

test("the phrase family that already worked still works", () => {
  for (const body of [
    "remove me",
    "remove me from your list",
    "remove me from all your lists",
    "take me off your list",
    "stop texting me",
    "do not text me",
    "unsubscribe",
    "STOP",
  ]) {
    assert.equal(intentOf(body), "opt_out", body);
  }
});

test("the newly added 'lose my number' family is caught", () => {
  for (const body of [
    "lose my number",
    "Lose my number please",
    "loose my number",
    "forget my number",
  ]) {
    assert.equal(intentOf(body), "opt_out", body);
  }
});

test("ordinary messages containing 'remove' or 'number' are NOT opt-outs", () => {
  // The addition must not widen semantics. Each of these is a live-plausible
  // seller message that shares vocabulary with the cessation list.
  for (const body of [
    "I had to remove the tenant last year",
    "Can you remove the debris if I sell?",
    "My number is changing next week",
    "What number would you offer?",
    "I will lose money at that price",
  ]) {
    assert.notEqual(intentOf(body), "opt_out", body);
  }
});

test("a misspelled cessation request is still NOT matched, by design", () => {
  // Documents the live ••1156 behaviour rather than silently fixing it with
  // fuzzy matching. This one is handled as an operator action.
  assert.notEqual(intentOf("rwmove me from all you lists"), "opt_out");
});

test("Spanish cessation phrases are unaffected", () => {
  for (const body of ["no me escriba", "quítame de tu lista", "deja de escribirme"]) {
    assert.equal(intentOf(body), "opt_out", body);
  }
});
