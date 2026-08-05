/**
 * Suppression evidence, field authority, contradiction guards, and the exact
 * "alone" phrase matrix.
 *
 * Production audit 2026-08-04: 293 binding-suppressed threads, 114 with NO
 * durable evidence, 292 internally contradictory (291 of them holding
 * is_suppressed=true + disposition=suppressed + contactability=contactable at
 * once). Proximate cause: stage transitions wrote a compliance field they do
 * not own — `S1_TO_S4_CONDITION_DISCLOSED` and even
 * `S1_TO_S2_OWNERSHIP_CONFIRMED` set contactability_status='do_not_text'.
 *
 * The isolated token "alone" is never an opt-out. "For 327 Pennsylvania alone
 * 130,000" is a price quote from a motivated seller.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  authorizeSuppressionMutation,
  validateSuppressionEvidence,
  patchAssertsBindingSuppression,
  detectSuppressionContradictions,
  SUPPRESSION_EVIDENCE_TYPES,
} from "@/lib/domain/lead-state/suppression-evidence.js";
import { isNegativeReply } from "@/lib/domain/classification/is-negative-reply.js";

const OPT_OUT_EVIDENCE = {
  type: SUPPRESSION_EVIDENCE_TYPES.EXPLICIT_OPT_OUT,
  source_event_id: "evt-1",
  source_authority: "classifier",
  matched_phrase: "leave me alone",
  rule_version: "v1",
};

// ── the exact incident ──────────────────────────────────────────────────────

test("a stage transition cannot establish binding suppression", () => {
  // The literal production shape: reason S1_TO_S4_CONDITION_DISCLOSED,
  // no opt-out, no suppression record.
  const verdict = authorizeSuppressionMutation({
    patch: { contactability_status: "do_not_text", lifecycle_stage: "property_condition" },
    evidence: null,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "missing_suppression_evidence");
});

test("an ownership confirmation cannot set do_not_text", () => {
  // S1_TO_S2_OWNERSHIP_CONFIRMED did exactly this in production — the most
  // positive signal in the funnel silencing the thread.
  assert.equal(
    authorizeSuppressionMutation({
      patch: { contactability_status: "do_not_text" },
      evidence: null,
    }).allowed,
    false
  );
});

test("manufactured binding fields require evidence", () => {
  for (const patch of [
    { is_suppressed: true },
    { disposition: "suppressed" },
    { contactability_status: "do_not_text" },
    { inbox_bucket: "suppressed" },
  ]) {
    assert.equal(patchAssertsBindingSuppression(patch), true, JSON.stringify(patch));
  }
});

test("opted_out and wrong_number are self-evidencing and must NOT be gated", () => {
  // These values can only be produced by an explicit opt-out or a confirmed
  // wrong number, and they name their own reason. Demanding a separately
  // supplied evidence object for them broke STOP: a real opt-out was rejected
  // by the gate. `do_not_text` stays gated — that is the manufactured catch-all
  // the incident was made of.
  for (const patch of [
    { contactability_status: "opted_out" },
    { contactability_status: "wrong_number" },
    { contactability_status: "opted_out", is_suppressed: true },
  ]) {
    assert.equal(patchAssertsBindingSuppression(patch), false, JSON.stringify(patch));
    assert.equal(
      authorizeSuppressionMutation({ patch, evidence: null }).allowed,
      true,
      "a genuine opt-out must never be blocked by the evidence gate"
    );
  }
});

test("non-binding updates pass straight through", () => {
  for (const patch of [
    { lifecycle_stage: "offer_interest" },
    { lead_temperature: "hot" },
    { disposition: "interested" },
    { next_action: "send_message_now" },
    { operational_status: "active_communication" },
  ]) {
    const verdict = authorizeSuppressionMutation({ patch, evidence: null });
    assert.equal(verdict.allowed, true, JSON.stringify(patch));
  }
});

// ── accepted evidence ───────────────────────────────────────────────────────

test("each accepted evidence type authorizes suppression", () => {
  const cases = [
    OPT_OUT_EVIDENCE,
    { type: SUPPRESSION_EVIDENCE_TYPES.CONFIRMED_WRONG_NUMBER, source_event_id: "e2" },
    { type: SUPPRESSION_EVIDENCE_TYPES.LEGAL_PROHIBITION, source_event_id: "e3" },
    { type: SUPPRESSION_EVIDENCE_TYPES.MANUAL_OPERATOR, actor: "operator:ryan" },
    { type: SUPPRESSION_EVIDENCE_TYPES.SUPPRESSION_RECORD, suppression_record_id: "sup-1" },
  ];
  for (const evidence of cases) {
    const verdict = authorizeSuppressionMutation({
      patch: { is_suppressed: true, contactability_status: "do_not_text" },
      evidence,
    });
    assert.equal(verdict.allowed, true, evidence.type);
    assert.equal(verdict.evidence.binding, true);
  }
});

test("evidence without provenance is rejected", () => {
  assert.equal(
    validateSuppressionEvidence({ type: SUPPRESSION_EVIDENCE_TYPES.EXPLICIT_OPT_OUT }).reason,
    "suppression_evidence_requires_source_event"
  );
  assert.equal(
    validateSuppressionEvidence({ type: SUPPRESSION_EVIDENCE_TYPES.MANUAL_OPERATOR }).reason,
    "manual_suppression_requires_actor"
  );
  assert.equal(
    validateSuppressionEvidence({ type: SUPPRESSION_EVIDENCE_TYPES.SUPPRESSION_RECORD }).reason,
    "suppression_record_requires_id"
  );
  assert.equal(
    validateSuppressionEvidence({ type: "condition_disclosed", source_event_id: "e" }).reason,
    "unrecognized_suppression_evidence_type"
  );
});

test("non-binding evidence cannot suppress", () => {
  assert.equal(
    validateSuppressionEvidence({ ...OPT_OUT_EVIDENCE, binding: false }).reason,
    "non_binding_evidence_cannot_suppress"
  );
});

test("evidence keeps only a short matched span, never the whole message", () => {
  const long = "a".repeat(500);
  const { evidence } = validateSuppressionEvidence({ ...OPT_OUT_EVIDENCE, matched_phrase: long });
  assert.ok(evidence.matched_phrase.length <= 65, "the span must stay bounded");
});

// ── contradiction guards ────────────────────────────────────────────────────

test("the exact production contradiction is detected", () => {
  const contradictions = detectSuppressionContradictions({
    is_suppressed: true,
    disposition: "suppressed",
    contactability_status: "contactable",
    lead_temperature: "hot",
  });
  assert.ok(contradictions.includes("contactable_while_binding_suppressed"));
});

test("running automation on a binding-suppressed thread is a contradiction", () => {
  const contradictions = detectSuppressionContradictions({
    is_suppressed: true,
    contactability_status: "do_not_text",
    automation_state: "running",
  });
  assert.ok(contradictions.includes("automation_running_while_binding_suppressed"));
});

test("a consistent suppressed thread reports nothing", () => {
  assert.deepEqual(
    detectSuppressionContradictions({
      is_suppressed: true,
      disposition: "suppressed",
      contactability_status: "opted_out",
      automation_state: "stopped",
    }),
    []
  );
});

test("a consistent contactable thread reports nothing", () => {
  assert.deepEqual(
    detectSuppressionContradictions({
      is_suppressed: false,
      disposition: "interested",
      contactability_status: "contactable",
      automation_state: "running",
    }),
    []
  );
});

// ── one binding predicate for authorization AND contradiction detection ─────

test("inbox_bucket=suppressed with contactable is a contradiction", () => {
  // Regression: patchAssertsBindingSuppression treated inbox_bucket as binding
  // while detectSuppressionContradictions did not, so this exact row reported
  // nothing at all.
  assert.ok(
    detectSuppressionContradictions({
      inbox_bucket: "suppressed",
      contactability_status: "contactable",
    }).includes("contactable_while_binding_suppressed")
  );
});

test("a blocking contactability alone makes the row binding for the detector", () => {
  // Same divergence, second half: without is_suppressed the detector reported
  // no running-automation contradiction.
  assert.ok(
    detectSuppressionContradictions({
      contactability_status: "do_not_text",
      automation_state: "running",
    }).includes("automation_running_while_binding_suppressed")
  );
});

test("an absent is_suppressed beside a blocking contactability is an unfinished write", () => {
  // The guard used a strict `=== false`, so null/undefined never tripped it.
  for (const row of [
    { contactability_status: "do_not_text" },
    { contactability_status: "do_not_text", is_suppressed: null },
    { contactability_status: "opted_out", is_suppressed: undefined },
  ]) {
    assert.ok(
      detectSuppressionContradictions(row).includes("blocking_contactability_without_suppression"),
      JSON.stringify(row)
    );
  }
});

test("every registry-blocking contactability is gated or self-evidencing — none slip through", () => {
  // dnc / provider_blacklisted / invalid_number all make buildRowPatch write
  // is_suppressed=true, but the gate's value list omitted them, so they wrote
  // binding suppression with zero evidence.
  for (const value of ["dnc", "provider_blacklisted"]) {
    assert.equal(
      patchAssertsBindingSuppression({ contactability_status: value }),
      true,
      `${value} must require evidence`
    );
    assert.equal(
      authorizeSuppressionMutation({ patch: { contactability_status: value }, evidence: null })
        .allowed,
      false,
      `${value} must be rejected without evidence`
    );
  }
  // invalid_number is the canonical code the resolver emits for a confirmed
  // wrong number — self-evidencing, exactly like opted_out.
  for (const value of ["invalid_number", "opted_out", "wrong_number"]) {
    assert.equal(
      patchAssertsBindingSuppression({ contactability_status: value }),
      false,
      `${value} is self-evidencing`
    );
  }
});

// ── the "alone" matrix ──────────────────────────────────────────────────────

const OPT_OUT_PHRASES = [
  "Leave me alone",
  "leave me alone",
  "LEAVE ME ALONE",
  "  Leave me alone.  ",
  "Leave me alone!!",
  "Please leave us alone",
  "Do not contact me again",
  "do not contact me again.",
];

for (const phrase of OPT_OUT_PHRASES) {
  test(`opt-out phrase ${JSON.stringify(phrase)} suppresses`, () => {
    assert.equal(
      isNegativeReply(phrase),
      true,
      "an explicit go-away instruction must be recognised"
    );
  });
}

const NOT_OPT_OUT = [
  "For 327 Pennsylvania alone 130,000",
  "for 327 pennsylvania alone 130,000...",
  "The house alone is 130k",
  "That parcel alone would be 50 thousand",
  "I live alone",
  "I cannot decide alone",
  "Alone, I would probably sell",
  "  the house alone is 130k  ",
];

for (const phrase of NOT_OPT_OUT) {
  test(`price/context phrase ${JSON.stringify(phrase)} must NOT suppress`, () => {
    assert.equal(
      isNegativeReply(phrase),
      false,
      "the bare token 'alone' is never an opt-out — this is a live seller"
    );
  });
}

test("a seller quoting a price is never routed to suppression", () => {
  const message = "For 327 Pennsylvania alone 130,000";
  assert.equal(isNegativeReply(message), false);
  // And no evidence exists, so even if something tried, the gate refuses.
  assert.equal(
    authorizeSuppressionMutation({
      patch: { is_suppressed: true },
      evidence: null,
    }).allowed,
    false
  );
});
