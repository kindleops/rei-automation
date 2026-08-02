// Conversation behavior scoring: evidence-based, confidence-qualified,
// length-proof, compliance-protected. Uses the REAL classifier (heuristicOnly)
// so evidence reflects live signal extraction, plus fixture classifications
// for the bounded model-assist contract.
import { test } from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  scoreConversationBehavior,
  BEHAVIOR_SCORE_DIMENSIONS,
  CONVERSATION_BEHAVIOR_SCORING_VERSION,
  PROTECTED_BEHAVIOR_DIMENSIONS,
} from "@/lib/domain/seller-flow/conversation-behavior-scoring.js";

async function scoreMessage(message, extra = {}, opts = {}) {
  const classification = await classify(message, null, { heuristicOnly: true });
  return {
    classification,
    result: scoreConversationBehavior(
      { raw_text: message, classification, ...extra },
      opts
    ),
  };
}

function evidenceDetails(score) {
  return (score.evidence || []).map((e) => `${e.kind}:${e.detail}`);
}

test("every dimension is present with the full score-object contract", async () => {
  const { result } = await scoreMessage("Yes I own it, I want 150k and need to close this month");
  assert.equal(result.version, CONVERSATION_BEHAVIOR_SCORING_VERSION);
  for (const dimension of BEHAVIOR_SCORE_DIMENSIONS) {
    const score = result.scores[dimension];
    assert.ok(score, `missing dimension ${dimension}`);
    assert.ok("value" in score && "confidence" in score && "evidence" in score);
    assert.equal(score.scorer_version, CONVERSATION_BEHAVIOR_SCORING_VERSION);
    if (score.value == null) {
      assert.ok(score.fallback_reason, `${dimension} null value must carry fallback_reason`);
      assert.equal(score.confidence, 0);
    } else {
      assert.ok(score.evidence.length > 0, `${dimension} has value but no evidence`);
      assert.equal(score.fallback_reason, null);
    }
  }
});

test("hostile/legal message scores high hostility with intent evidence", async () => {
  const classification = await classify(
    "Stop harassing me. This is harassment and I will sue you",
    null,
    { heuristicOnly: true }
  );
  const result = scoreConversationBehavior({
    raw_text: "Stop harassing me. This is harassment and I will sue you",
    classification,
  });
  const hostility = result.scores.hostility;
  // The classifier routes legal-threat language to hostile_or_legal (primary
  // or secondary) — hostility must be scored high with that intent evidence.
  const intents = [classification.primary_intent, ...(classification.secondary_intents || [])];
  assert.ok(
    intents.includes("hostile_or_legal") || classification.primary_intent === "opt_out",
    `unexpected classification ${JSON.stringify(intents)}`
  );
  if (intents.includes("hostile_or_legal")) {
    assert.ok(hostility.value >= 0.7, `hostility=${hostility.value}`);
    assert.ok(evidenceDetails(hostility).includes("intent:hostile_or_legal"));
    assert.ok(hostility.confidence >= 0.7);
  }
});

test("Spanish distress message scores urgency + motivation with matched evidence", async () => {
  const { result } = await scoreMessage("necesito venderlo ya, estoy atrasado en pagos");
  const urgency = result.scores.urgency;
  const motivation = result.scores.motivation;
  assert.ok(urgency.value != null && urgency.value >= 0.5, `urgency=${urgency.value}`);
  assert.ok(motivation.value != null && motivation.value >= 0.5, `motivation=${motivation.value}`);
  const urgencyEvidence = evidenceDetails(urgency);
  assert.ok(
    urgencyEvidence.some((d) =>
      ["positive_signal:financial_pressure", "objection:financial_distress", "positive_signal:urgency"].includes(d)
    ),
    `urgency evidence ${JSON.stringify(urgencyEvidence)}`
  );
  const motivationEvidence = evidenceDetails(motivation);
  assert.ok(
    motivationEvidence.some((d) =>
      ["positive_signal:financial_pressure", "objection:financial_distress"].includes(d)
    ),
    `motivation evidence ${JSON.stringify(motivationEvidence)}`
  );
});

test("skeptical scam question scores skepticism + trust_concern with evidence", async () => {
  const { result } = await scoreMessage("is this a scam? how did you get my number");
  const skepticism = result.scores.skepticism;
  const trust = result.scores.trust_concern;
  assert.ok(skepticism.value != null && skepticism.value >= 0.5, `skepticism=${skepticism.value}`);
  assert.ok(trust.value != null && trust.value >= 0.4, `trust_concern=${trust.value}`);
  assert.ok(evidenceDetails(skepticism).includes("emotion:skeptical"));
});

test("bare 'ok' yields nulls/low values, never mid-range psychological guesses", async () => {
  const { result } = await scoreMessage("ok");
  const s = result.scores;
  // No semantic evidence exists: psychological dimensions must be null.
  for (const dimension of [
    "hostility",
    "urgency",
    "confusion",
    "skepticism",
    "trust_concern",
    "motivation",
    "sale_readiness",
    "price_sensitivity",
    "timing_sensitivity",
    "conversational_momentum",
  ]) {
    assert.equal(s[dimension].value, null, `${dimension} fabricated ${s[dimension].value}`);
    assert.equal(s[dimension].fallback_reason, "insufficient_evidence");
  }
  // `affirmative` on a bare acknowledgement is typing, not positivity.
  assert.equal(s.sentiment.value, null, "sentiment fabricated from bare affirmative");
  // reply_effort is explicitly mechanical and may score low.
  assert.ok(s.reply_effort.value != null && s.reply_effort.value <= 0.2);
  // classify()'s fabricated mid-range motivation_score (55 for "ok") must not
  // leak through.
  assert.notEqual(s.motivation.value, 0.55);
});

test("length alone never produces motivation/engagement (300-char no-signal ramble)", async () => {
  const ramble =
    "well you know we were just talking about things the other day and my cousin " +
    "said something about the weather and then we went to the store and the parking " +
    "lot was full so we came back home and watched television for a while and then " +
    "the neighbor stopped by and we talked about the game last night for an hour";
  assert.ok(ramble.length >= 300);
  const { result } = await scoreMessage(ramble);
  const s = result.scores;
  assert.ok(
    s.motivation.value == null || s.motivation.value < 0.3,
    `motivation fabricated from length: ${s.motivation.value}`
  );
  assert.ok(
    s.engagement.value == null || s.engagement.value < 0.3,
    `engagement fabricated from length: ${s.engagement.value}`
  );
  assert.ok(
    s.urgency.value == null && s.sale_readiness.value == null,
    "urgency/sale_readiness fabricated from length"
  );
  // reply_effort is the one dimension allowed to reflect length — and must
  // say so in mechanical evidence.
  assert.ok(s.reply_effort.value >= 0.8);
  assert.ok(evidenceDetails(s.reply_effort).some((d) => d.startsWith("mechanical:word_count")));
});

test("price + urgency message scores sale_readiness with price_parse evidence", async () => {
  const { result } = await scoreMessage("Yes I own it, I want 150k and need to close this month");
  const readiness = result.scores.sale_readiness;
  assert.ok(readiness.value >= 0.7, `sale_readiness=${readiness.value}`);
  assert.ok(
    evidenceDetails(readiness).some(
      (d) => d === "price_parse:seller_asking_price_stated" || d === "intent:asking_price_provided"
    )
  );
  const urgency = result.scores.urgency;
  assert.ok(urgency.value >= 0.5, `urgency=${urgency.value}`);
});

test("engagement requires thread stats; questions alone on empty stats stay null", async () => {
  const { result } = await scoreMessage("What would the process look like?");
  assert.equal(result.scores.engagement.value, null);
  const { result: withStats } = await scoreMessage("What would the process look like?", {
    thread_stats: { seller_reply_count: 3, conversation_depth: 7, reply_latency_seconds: 120 },
  });
  assert.ok(withStats.scores.engagement.value >= 0.6);
  assert.ok(
    evidenceDetails(withStats.scores.engagement).some((d) => d.startsWith("thread_stat:"))
  );
});

test("re_engagement_strength only corroborates precedence, never creates", async () => {
  const message = "Actually yes, is your offer still on the table?";
  const { result: without } = await scoreMessage(message, { precedence: null });
  assert.equal(without.scores.re_engagement_strength.value, null);
  assert.equal(without.scores.re_engagement_strength.fallback_reason, "precedence_unavailable");

  const { result: notDetected } = await scoreMessage(message, {
    precedence: { re_engagement_detected: false },
  });
  assert.equal(notDetected.scores.re_engagement_strength.value, null);
  assert.equal(
    notDetected.scores.re_engagement_strength.fallback_reason,
    "no_precedence_re_engagement"
  );

  const { result: detected } = await scoreMessage(message, {
    precedence: { re_engagement_detected: true },
  });
  assert.ok(detected.scores.re_engagement_strength.value >= 0.5);
  assert.ok(
    evidenceDetails(detected.scores.re_engagement_strength).includes(
      "precedence:re_engagement_detected"
    )
  );
});

test("scorer failure degrades safely to all-null with scorer_unavailable", () => {
  // A poisoned classification whose secondary_intents getter throws.
  const poisoned = {};
  Object.defineProperty(poisoned, "secondary_intents", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  const result = scoreConversationBehavior({ raw_text: "hello", classification: poisoned });
  assert.equal(result.scorer, "unscored");
  for (const dimension of BEHAVIOR_SCORE_DIMENSIONS) {
    assert.equal(result.scores[dimension].value, null);
    assert.equal(result.scores[dimension].fallback_reason, "scorer_unavailable");
  }
  assert.ok(result.error);
});

test("hostile model-assist cannot flip protected dimensions or compliance contexts", async () => {
  const hostileScorer = () => {
    const proposals = {};
    for (const dimension of BEHAVIOR_SCORE_DIMENSIONS) {
      proposals[dimension] = { value: 0.0, confidence_delta: 1 };
    }
    proposals.hostility = { value: 0, confidence_delta: 1 };
    return proposals;
  };

  // Compliance context: opt-out → model output ignored wholesale.
  const { result: optOut } = await scoreMessage(
    "STOP",
    {},
    { modelAssistScorer: hostileScorer }
  );
  assert.equal(optOut.model_assist.applied, false);
  assert.equal(optOut.model_assist.ignored_reason, "protected_compliance_context");

  // Wrong-number identity context: same wholesale ignore.
  const { result: wrongNumber } = await scoreMessage(
    "wrong number, I never owned that house",
    {},
    { modelAssistScorer: hostileScorer }
  );
  assert.equal(wrongNumber.model_assist.applied, false);
  assert.equal(wrongNumber.model_assist.ignored_reason, "protected_compliance_context");

  // Suppression state: ignored even on a benign message.
  const { result: suppressed } = await scoreMessage(
    "thanks for the info",
    { suppression: { active: true, reason: "opt_out" } },
    { modelAssistScorer: hostileScorer }
  );
  assert.equal(suppressed.model_assist.applied, false);

  // Non-protected context: hostility still protected; a >0.15 jump on any
  // dimension is discarded; null dimensions cannot be invented.
  const { result: benign, classification } = await scoreMessage(
    "My tenants trashed the place, I am so tired of dealing with it",
    {},
    { modelAssistScorer: hostileScorer }
  );
  assert.ok(!benign.model_assist?.adjusted?.includes("hostility"));
  for (const dimension of PROTECTED_BEHAVIOR_DIMENSIONS) {
    const clean = scoreConversationBehavior({
      raw_text: "My tenants trashed the place, I am so tired of dealing with it",
      classification,
    });
    assert.deepEqual(benign.scores[dimension], clean.scores[dimension]);
  }
  const cleanRun = scoreConversationBehavior({
    raw_text: "My tenants trashed the place, I am so tired of dealing with it",
    classification,
  });
  for (const dimension of BEHAVIOR_SCORE_DIMENSIONS) {
    if (cleanRun.scores[dimension].value == null) {
      assert.equal(
        benign.scores[dimension].value,
        null,
        `model invented ${dimension} on null evidence`
      );
    }
  }
});

test("model-assist may only nudge ambiguous mid-range scores within ±0.15", async () => {
  const { classification } = await scoreMessage(
    "My tenants trashed the place, I am so tired of dealing with it"
  );
  const clean = scoreConversationBehavior({
    raw_text: "My tenants trashed the place, I am so tired of dealing with it",
    classification,
  });
  const midRange = Object.entries(clean.scores).filter(
    ([, s]) => s.value != null && s.value >= 0.3 && s.value <= 0.7
  );
  assert.ok(midRange.length > 0, "fixture must produce at least one mid-range score");
  const [dimension, det] = midRange.find(([d]) => !PROTECTED_BEHAVIOR_DIMENSIONS.includes(d));

  const nudger = () => ({
    [dimension]: { value: det.value + 0.1, confidence_delta: 0.05 },
  });
  const nudged = scoreConversationBehavior(
    {
      raw_text: "My tenants trashed the place, I am so tired of dealing with it",
      classification,
    },
    { modelAssistScorer: nudger }
  );
  assert.equal(nudged.model_assist.applied, true);
  assert.ok(nudged.model_assist.adjusted.includes(dimension));
  assert.ok(Math.abs(nudged.scores[dimension].value - det.value) <= 0.15 + 1e-9);
  assert.ok(
    nudged.scores[dimension].evidence.some((e) => e.kind === "model_assist"),
    "model adjustment must be visible in evidence"
  );

  const jumper = () => ({ [dimension]: { value: det.value + 0.5, confidence_delta: 0.05 } });
  const rejected = scoreConversationBehavior(
    {
      raw_text: "My tenants trashed the place, I am so tired of dealing with it",
      classification,
    },
    { modelAssistScorer: jumper }
  );
  assert.equal(rejected.scores[dimension].value, det.value, "out-of-band jump must be discarded");

  const thrower = () => {
    throw new Error("model exploded");
  };
  const survived = scoreConversationBehavior(
    {
      raw_text: "My tenants trashed the place, I am so tired of dealing with it",
      classification,
    },
    { modelAssistScorer: thrower }
  );
  assert.equal(survived.model_assist.applied, false);
  assert.match(survived.model_assist.ignored_reason, /model_assist_error/);
  assert.deepEqual(survived.scores[dimension], det);
});
