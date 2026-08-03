// The behavior-score → temperature seam: bounded, additive, reason-coded.
// Absent scores change nothing; present scores can never create WARM/HOT on
// their own; the engagement-only floor stays capped at COLD.
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeTemperatureSignal } from "@/lib/domain/seller-flow/temperature-signal-model.js";
import { LEAD_TEMPERATURE_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

function score(value, confidence) {
  return { value, confidence, evidence: [{ kind: "test", detail: "fixture" }] };
}

test("no behavior argument → output identical to pre-seam model", () => {
  const args = {
    intent: "seller_interested",
    facts: { timeline: "soon" },
    secondary: { seller_reply_count: 2, question_count: 1 },
  };
  const without = computeTemperatureSignal(args);
  const withNull = computeTemperatureSignal({ ...args, behavior: null });
  const withEmpty = computeTemperatureSignal({ ...args, behavior: { scores: null } });
  assert.deepEqual(withNull, without);
  assert.deepEqual(withEmpty, without);
});

test("all-null behavior scores change nothing", () => {
  const args = { intent: "unclear", facts: {}, secondary: {} };
  const without = computeTemperatureSignal(args);
  const nullScores = {
    scores: {
      hostility: { value: null, confidence: 0 },
      urgency: { value: null, confidence: 0 },
      engagement: { value: null, confidence: 0 },
    },
  };
  assert.deepEqual(computeTemperatureSignal({ ...args, behavior: nullScores }), without);
});

test("hostility >= 0.6 with confidence >= 0.7 adds friction reason code only", () => {
  const args = { intent: "unclear", facts: {}, secondary: {} };
  const result = computeTemperatureSignal({
    ...args,
    behavior: { scores: { hostility: score(0.8, 0.85) } },
  });
  assert.ok(result.reason_codes.includes("BEHAVIOR_HOSTILITY_FRICTION"));
  assert.equal(result.components.friction_score, 0.3);
  // Floor untouched: friction never participates in floor resolution.
  const base = computeTemperatureSignal(args);
  assert.equal(result.temperature_floor, base.temperature_floor);

  // Below either threshold → no effect.
  const low_conf = computeTemperatureSignal({
    ...args,
    behavior: { scores: { hostility: score(0.8, 0.5) } },
  });
  assert.ok(!low_conf.reason_codes.includes("BEHAVIOR_HOSTILITY_FRICTION"));
  const low_val = computeTemperatureSignal({
    ...args,
    behavior: { scores: { hostility: score(0.4, 0.9) } },
  });
  assert.ok(!low_val.reason_codes.includes("BEHAVIOR_HOSTILITY_FRICTION"));
});

test("behavioral urgency corroborates to at most 0.4 and never creates WARM/HOT", () => {
  const args = { intent: "unclear", facts: {}, secondary: {} };
  const result = computeTemperatureSignal({
    ...args,
    behavior: { scores: { urgency: score(0.9, 0.9) } },
  });
  assert.equal(result.components.urgency_score, 0.4);
  assert.ok(result.reason_codes.includes("BEHAVIOR_URGENCY_CORROBORATED"));
  assert.equal(result.temperature_floor, LEAD_TEMPERATURE_CODES.UNSCORED);

  // Even stacked on a hot intent, 0.4 < the 0.7 the HOT floor requires — the
  // HOT floor must come from explicit facts, not behavioral corroboration.
  const hotIntent = computeTemperatureSignal({
    intent: "asks_offer",
    facts: {},
    secondary: {},
    behavior: { scores: { urgency: score(0.9, 0.9) } },
  });
  assert.ok(
    !hotIntent.reason_codes.includes("FLOOR_HOT_EXPLICIT_PRICE_OR_URGENT_INTENT"),
    "behavioral urgency must not combine with intent into the HOT floor"
  );

  // An explicit timeline fact wins: no corroboration override.
  const explicit = computeTemperatureSignal({
    ...args,
    facts: { timeline: "long_term" },
    behavior: { scores: { urgency: score(0.9, 0.9) } },
  });
  assert.equal(explicit.components.urgency_score, 0.2);
  assert.ok(!explicit.reason_codes.includes("BEHAVIOR_URGENCY_CORROBORATED"));
});

test("explicit negative intent still caps COLD over any behavior scores", () => {
  const result = computeTemperatureSignal({
    intent: "not_interested",
    facts: { asking_price: { value: 200000 } },
    secondary: { seller_reply_count: 5, question_count: 3, reply_latency_seconds: 60 },
    behavior: {
      scores: {
        urgency: score(0.95, 0.95),
        engagement: score(0.95, 0.95),
        hostility: score(0.1, 0.9),
      },
    },
  });
  assert.equal(result.temperature_floor, LEAD_TEMPERATURE_CODES.COLD);
  assert.ok(result.reason_codes.includes("EXPLICIT_NEGATIVE_CAPS_COLD"));
});

test("engagement corroboration is reason-code only; engagement-only floor stays COLD", () => {
  const args = {
    intent: "unclear",
    facts: {},
    secondary: { seller_reply_count: 4, question_count: 2, reply_latency_seconds: 120 },
  };
  const base = computeTemperatureSignal(args);
  const result = computeTemperatureSignal({
    ...args,
    behavior: { scores: { engagement: score(0.9, 0.9) } },
  });
  assert.ok(result.reason_codes.includes("BEHAVIOR_ENGAGEMENT_CORROBORATED"));
  assert.equal(result.components.engagement_score, base.components.engagement_score);
  assert.equal(result.temperature_floor, LEAD_TEMPERATURE_CODES.COLD);
  assert.ok(result.reason_codes.includes("FLOOR_COLD_ENGAGEMENT_ONLY"));
});
