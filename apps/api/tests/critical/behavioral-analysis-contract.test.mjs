// The analysis contract carries real evidence-backed behavioral scores while
// staying additive/back-compatible and degrading safely when scoring cannot
// run.
import { test } from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { buildInboundAnalysis } from "@/lib/domain/inbound/inbound-analysis-contract.js";
import {
  CONVERSATION_BEHAVIOR_SCORING_VERSION,
  BEHAVIOR_SCORE_DIMENSIONS,
} from "@/lib/domain/seller-flow/conversation-behavior-scoring.js";

test("contract carries scored behavioral dimensions with evidence", async () => {
  const raw_text = "Yes I own it, I want 150k and need to close this month";
  const classification = await classify(raw_text, null, { heuristicOnly: true });
  const analysis = buildInboundAnalysis({ raw_text, classification });

  assert.equal(analysis.behavior_scoring.version, CONVERSATION_BEHAVIOR_SCORING_VERSION);
  assert.equal(analysis.behavior_scoring.scorer, "deterministic_v1");

  assert.ok(analysis.sale_readiness.value >= 0.7);
  assert.ok(analysis.sale_readiness.evidence.length > 0);
  assert.equal(analysis.sale_readiness.scorer, "deterministic_v1");
  assert.ok(analysis.urgency.value >= 0.5);
  assert.ok(analysis.reply_effort.value != null);

  // Out-of-scope dimensions remain honestly unscored.
  assert.equal(analysis.emotional_tone.scorer, "unscored");
  assert.equal(analysis.ownership_authority_confidence.scorer, "unscored");
  assert.equal(analysis.property_identity_confidence.scorer, "unscored");

  // trust carries the trust_concern score object (documented alias).
  assert.deepEqual(analysis.trust, analysis.trust_concern);
});

test("no-evidence message: scores are null with fallback_reason, never fabricated", async () => {
  const classification = await classify("ok", null, { heuristicOnly: true });
  const analysis = buildInboundAnalysis({ raw_text: "ok", classification });
  for (const field of ["hostility", "urgency", "motivation", "sale_readiness"]) {
    assert.equal(analysis[field].value, null, `${field} fabricated`);
    assert.equal(analysis[field].fallback_reason, "insufficient_evidence");
    assert.equal(analysis[field].confidence, 0);
  }
});

test("pre-existing deterministic surface fields are unchanged (back-compat)", async () => {
  const raw_text = "Is the offer still available? We talked in May.";
  const classification = await classify(raw_text, null, { heuristicOnly: true });
  const analysis = buildInboundAnalysis({
    raw_text,
    classification,
    timing: {
      received_at: "2026-08-01T12:00:00.000Z",
      prior_outbound_at: "2026-08-01T11:30:00.000Z",
    },
  });
  assert.equal(analysis.version, "inbound_analysis_contract_v1");
  assert.equal(analysis.word_count, 9);
  assert.equal(analysis.question_count, 1);
  assert.equal(analysis.reply_latency_minutes, 30);
  assert.equal(analysis.intent, classification.primary_intent);
});

test("scoring failure degrades to unscored objects without throwing", () => {
  // Poison a field only the behavior scorer reads (the contract's own surface
  // section never touches positive_signals), so the failure is scoped to
  // scoring and the degradation path is what gets exercised.
  const poisoned = {};
  Object.defineProperty(poisoned, "positive_signals", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  const analysis = buildInboundAnalysis({ raw_text: "hello there", classification: poisoned });
  assert.equal(analysis.behavior_scoring.scorer, "unscored");
  for (const field of ["sentiment", "hostility", "urgency", "motivation"]) {
    assert.equal(analysis[field].value, null);
    assert.equal(analysis[field].fallback_reason, "scorer_unavailable");
  }
  // Surface signals still computed — scoring failure never poisons them.
  assert.equal(analysis.word_count, 2);
});

test("precomputed behavior result is honored verbatim (no double scoring)", async () => {
  const classification = await classify("is this a scam?", null, { heuristicOnly: true });
  const precomputed = {
    version: CONVERSATION_BEHAVIOR_SCORING_VERSION,
    scorer: "deterministic_v1",
    scores: Object.fromEntries(
      BEHAVIOR_SCORE_DIMENSIONS.map((d) => [
        d,
        {
          value: d === "skepticism" ? 0.77 : null,
          confidence: d === "skepticism" ? 0.9 : 0,
          evidence: d === "skepticism" ? [{ kind: "test", detail: "pinned" }] : [],
          scorer: d === "skepticism" ? "deterministic_v1" : "unscored",
          scorer_version: CONVERSATION_BEHAVIOR_SCORING_VERSION,
          fallback_reason: d === "skepticism" ? null : "insufficient_evidence",
        },
      ])
    ),
    model_assist: null,
  };
  const analysis = buildInboundAnalysis({
    raw_text: "is this a scam?",
    classification,
    behavior: precomputed,
  });
  assert.equal(analysis.skepticism.value, 0.77);
  assert.deepEqual(analysis.skepticism.evidence, [{ kind: "test", detail: "pinned" }]);
});
