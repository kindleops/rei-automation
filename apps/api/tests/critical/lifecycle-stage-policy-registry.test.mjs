import test from "node:test";
import assert from "node:assert/strict";

import {
  SELLER_LIFECYCLE_STAGE_REGISTRY,
  validateLifecycleTransition,
} from "@/lib/domain/lead-state/seller-lifecycle-stage-registry.js";
import {
  LIFECYCLE_STAGE_ORDER,
  LIFECYCLE_STAGE_CODES,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import {
  FOLLOWUP_POLICY_BY_STAGE,
  resolveFollowUpPolicyForStage,
} from "@/lib/domain/seller-flow/followup-policy-registry.js";
import { computeTemperatureSignal } from "@/lib/domain/seller-flow/temperature-signal-model.js";
import { resolveThreadLanguage } from "@/lib/domain/seller-flow/resolve-thread-language.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

// ── Stage rule registry ──────────────────────────────────────────────────────

test("stage registry covers exactly the ten canonical stages", () => {
  assert.deepEqual(
    Object.keys(SELLER_LIFECYCLE_STAGE_REGISTRY).sort(),
    [...LIFECYCLE_STAGE_ORDER].sort()
  );
  for (const code of LIFECYCLE_STAGE_ORDER) {
    const entry = SELLER_LIFECYCLE_STAGE_REGISTRY[code];
    assert.ok(entry.entry_condition, `${code} needs an entry condition`);
    assert.ok(entry.workflow?.label, `${code} needs workflow metadata`);
  }
});

test("transition validator: manual operators may move a lead anywhere", () => {
  const result = validateLifecycleTransition({
    from: LIFECYCLE_STAGE_CODES.CLOSED,
    to: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    change_source: "manual",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "manual_override");
});

test("transition validator: automated writers never regress a stage", () => {
  const result = validateLifecycleTransition({
    from: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
    to: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    change_source: "autopilot",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "monotonic_stage_guard_blocked_regression");
});

test("transition validator: automation cannot enter S7-S10 without authoritative evidence", () => {
  for (const to of [
    LIFECYCLE_STAGE_CODES.UNDER_CONTRACT,
    LIFECYCLE_STAGE_CODES.DISPOSITION,
    LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE,
    LIFECYCLE_STAGE_CODES.CLOSED,
  ]) {
    const blocked = validateLifecycleTransition({
      from: LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
      to,
      change_source: "system",
    });
    assert.equal(blocked.allowed, false, `${to} must be blocked without evidence`);
    assert.equal(blocked.reason, "operational_stage_requires_authoritative_event");

    const allowed = validateLifecycleTransition({
      from: LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT,
      to,
      change_source: "system",
      authority_evidence: { type: "persisted_deal_state", source: "test" },
    });
    assert.equal(allowed.allowed, true, `${to} must be allowed with evidence`);
  }
});

test("transition validator: conversation stages advance without evidence", () => {
  const result = validateLifecycleTransition({
    from: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    to: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
    change_source: "autopilot",
  });
  assert.equal(result.allowed, true);
});

// ── Follow-up policy registry ────────────────────────────────────────────────

test("follow-up policy: every canonical stage has a policy entry", () => {
  for (const code of LIFECYCLE_STAGE_ORDER) {
    assert.ok(FOLLOWUP_POLICY_BY_STAGE[code], `${code} missing follow-up policy`);
  }
});

test("follow-up policy: operational stages never allow automated follow-ups", () => {
  for (const code of [
    LIFECYCLE_STAGE_CODES.UNDER_CONTRACT,
    LIFECYCLE_STAGE_CODES.DISPOSITION,
    LIFECYCLE_STAGE_CODES.PREPARED_TO_CLOSE,
    LIFECYCLE_STAGE_CODES.CLOSED,
  ]) {
    assert.equal(resolveFollowUpPolicyForStage(code).policy.enabled, false, code);
  }
});

test("follow-up policy: conversation stages allow capped, delivery-confirmed follow-ups", () => {
  const s1 = resolveFollowUpPolicyForStage("ownership_confirmation").policy;
  assert.equal(s1.enabled, true);
  assert.ok(s1.max_automated_followups >= 1);
  assert.equal(s1.requires_delivery_confirmation, true);
  // Unknown stage resolves to the S1 policy, never to "unlimited".
  assert.deepEqual(resolveFollowUpPolicyForStage(null).policy, s1);
});

// ── Temperature signal model ─────────────────────────────────────────────────

test("temperature: explicit 'not interested' stays cold despite fast, deep engagement", () => {
  const signal = computeTemperatureSignal({
    intent: "not_interested",
    facts: {},
    secondary: {
      reply_latency_seconds: 10,
      seller_reply_count: 8,
      conversation_depth: 20,
      message_word_count: 300,
      question_count: 4,
    },
  });
  assert.equal(signal.temperature_floor, "cold");
  assert.ok(signal.reason_codes.includes("EXPLICIT_NEGATIVE_CAPS_COLD"));
});

test("temperature: secondary signals alone never create warm or hot", () => {
  const signal = computeTemperatureSignal({
    intent: "unclear",
    facts: {},
    secondary: { reply_latency_seconds: 5, seller_reply_count: 6, question_count: 3, conversation_depth: 12 },
  });
  assert.ok(["unscored", "cold"].includes(signal.temperature_floor));
});

test("temperature: explicit price + interest floors hot with reason codes", () => {
  const signal = computeTemperatureSignal({
    intent: "asking_price_provided",
    facts: { asking_price: { value: 120000 } },
    secondary: {},
  });
  assert.equal(signal.temperature_floor, "hot");
  assert.ok(signal.reason_codes.includes("PRICE_PROVIDED"));
  assert.ok(Object.keys(signal.components).length >= 7);
});

test("temperature: resolver carries signal reason codes without letting them override nurture cold", () => {
  const signal = computeTemperatureSignal({ intent: "not_interested", facts: {}, secondary: {} });
  const transition = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: "not_interested",
    temperature_signal: signal,
  });
  assert.equal(transition.lead_temperature, "cold");
  assert.equal(transition.temperature_signal.model_version, signal.model_version);
});

// ── Language continuity ──────────────────────────────────────────────────────

test("language: established thread language beats per-message detection", () => {
  const result = resolveThreadLanguage({
    threadLanguage: "Spanish",
    detectedLanguage: "English",
    messageText: "ok sounds good thanks",
  });
  assert.equal(result.language, "Spanish");
  assert.equal(result.source, "thread_language");
});

test("language: prospect preference beats detection when thread language is unknown", () => {
  const result = resolveThreadLanguage({
    threadLanguage: null,
    prospectLanguagePreference: "Mandarin",
    detectedLanguage: "English",
    messageText: "yes",
  });
  assert.equal(result.language, "Mandarin");
});

test("language: high-confidence non-English detection stands on its own", () => {
  const result = resolveThreadLanguage({
    detectedLanguage: "Japanese",
    messageText: "はい、私が所有者です",
  });
  assert.equal(result.language, "Japanese");
  assert.equal(result.source, "high_confidence_detection");
});

test("language: terse English-looking reply with no history resolves unknown, not English", () => {
  const result = resolveThreadLanguage({
    detectedLanguage: "English",
    messageText: "ok",
  });
  assert.equal(result.is_unknown, true);
  assert.equal(result.language, "unknown");
});

test("language: unrecognized language codes pass through instead of collapsing to English", () => {
  const result = resolveThreadLanguage({ threadLanguage: "Tagalog" });
  assert.equal(result.language, "Tagalog");
});
