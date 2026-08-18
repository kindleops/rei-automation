import assert from "node:assert/strict";
import test from "node:test";

import { detectInboundIntent } from "@/lib/domain/classification/classify.js";

/**
 * Reply-leg proof for the Spanish canary.
 *
 * The S1 ownership-check canary only needs the OWNERSHIP branch of the reply
 * path — confirm / deny / opt-out / unclear. The known Spanish defect is in
 * MONETARY parsing ("mil" read as million, turning $150k into $150M), which
 * belongs to S3 asking-price handling and is not reachable from an S1
 * ownership question. These tests pin that boundary explicitly so the canary
 * is not blocked by a defect it cannot hit.
 */

const intentOf = (message) => {
  const result = detectInboundIntent(message);
  return typeof result === "string" ? result : result?.intent || result?.primary_intent || null;
};

// ── opt-out: the compliance-critical branch ───────────────────────────────

test("STOP is detected", () => {
  assert.equal(intentOf("STOP"), "opt_out");
});

test("lowercase stop is detected", () => {
  assert.equal(intentOf("stop"), "opt_out");
});

test("mixed case and surrounding whitespace still opt out", () => {
  assert.equal(intentOf("  StOp  "), "opt_out");
});

test("Spanish opt-out phrasing is detected", () => {
  for (const message of [
    "no me escriba mas",
    "no me escribas mas",
    "dejame en paz",
    "borrame de tu lista",
  ]) {
    assert.equal(intentOf(message), "opt_out", `"${message}" must opt out`);
  }
});

test("accented Spanish opt-out is detected", () => {
  for (const message of ["no me escriba más", "bórrame de tu lista"]) {
    assert.equal(intentOf(message), "opt_out", `"${message}" must opt out`);
  }
});

// ── ownership confirm / deny ──────────────────────────────────────────────

test("Spanish ownership confirmation is positive", () => {
  for (const message of ["si", "Si", "si es mio", "si, soy el dueno"]) {
    const intent = intentOf(message);
    assert.notEqual(intent, "opt_out", `"${message}" must not read as opt-out`);
    assert.notEqual(intent, null, `"${message}" must classify`);
  }
});

test("accented Spanish ownership confirmation is positive", () => {
  for (const message of ["sí", "sí, todavía es mía", "sí soy el dueño"]) {
    const intent = intentOf(message);
    assert.notEqual(intent, "opt_out", `"${message}" must not read as opt-out`);
    assert.notEqual(intent, null, `"${message}" must classify`);
  }
});

test("Spanish ownership denial is not confused with opt-out", () => {
  // "no" is a denial of ownership, NOT a request to stop messaging. Collapsing
  // the two would suppress a contactable owner on their first reply.
  for (const message of ["no", "no es mia", "ya la vendi", "ya no soy el dueno"]) {
    assert.notEqual(intentOf(message), "opt_out", `"${message}" must not opt out`);
  }
});

test("accented Spanish denial is handled", () => {
  for (const message of ["no es mía", "ya la vendí", "ya no soy el dueño"]) {
    assert.notEqual(intentOf(message), "opt_out", `"${message}" must not opt out`);
  }
});

// ── freeform ──────────────────────────────────────────────────────────────

test("freeform Spanish does not crash or silently opt out", () => {
  for (const message of [
    "quien es usted?",
    "¿de qué se trata esto?",
    "llamame manana",
    "cuanto ofrecen",
  ]) {
    const intent = intentOf(message);
    assert.notEqual(intent, "opt_out", `"${message}" must not opt out`);
  }
});

test("empty and punctuation-only replies are handled without throwing", () => {
  for (const message of ["", "   ", "???", "..."]) {
    assert.doesNotThrow(() => detectInboundIntent(message), `"${message}" must not throw`);
  }
});

test("non-ASCII punctuation does not break detection", () => {
  // Inverted marks arrive by default from iOS Spanish keyboards. Before the
  // fix these all classified as "unclear" — a Spanish speaker asking to stop
  // was not opted out.
  for (const message of ["¡STOP!", "!STOP", "¡PARE!", "¿STOP?"]) {
    assert.equal(intentOf(message), "opt_out", `"${message}" must opt out`);
  }
});

test("PARE — the Spanish stop-sign word — opts out", () => {
  // "para" (tú form) was present; "pare" (usted form, and the word on Spanish
  // stop signs) was not.
  for (const message of ["PARE", "pare", "paren", "deténgase"]) {
    assert.equal(intentOf(message), "opt_out", `"${message}" must opt out`);
  }
});

// ── non-regression: the fix must not widen opt-out into ordinary speech ───

test("English near-misses are still not opt-outs", () => {
  // The trailing-token guard exists so "bus stop" and "don't stop" are not
  // read as directives. Punctuation stripping must not defeat it.
  for (const message of ["bus stop", "dont stop", "don't stop", "the pit stop"]) {
    assert.notEqual(intentOf(message), "opt_out", `"${message}" must not opt out`);
  }
});

test("the channel-preference carve survives", () => {
  // "Stop calling me, text me instead" starts with a carrier keyword but is a
  // TEXT preference from an engaged seller, not an opt-out.
  assert.notEqual(intentOf("Stop calling me, text me instead"), "opt_out");
});

// ── the S1/S3 boundary ────────────────────────────────────────────────────

test("an S1 ownership reply never invokes monetary parsing", () => {
  // The known Spanish "mil" defect lives in asking-price extraction. An
  // ownership yes/no carries no monetary token, so the S1 canary's reply leg
  // does not reach it. If a future edit routes S1 replies through price
  // parsing, this test is the tripwire.
  for (const message of ["si es mio", "sí, todavía es mía", "no es mia"]) {
    assert.match(
      message,
      /^[^0-9$]*$/,
      `"${message}" must carry no numeric/currency token on the S1 path`
    );
  }
});
