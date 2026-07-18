// ─── acquisition-brain-seller-intelligence.test.mjs ────────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSellerIntelligenceProfile,
  SELLER_INTEL_EXCLUSIONS,
  SHADOW_SELLER_INTEL_EVENT,
} from "@/lib/domain/acquisition-brain/shadow-seller-intelligence.js";

const THREAD = "+16128072000";

test("builds profile with ownership + interest", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    facts_after: [
      { fact_type: "ownership_confirmed", value: true, active: true, source_message_id: "m1" },
      { fact_type: "proposal_interest_confirmed", value: true, active: true, source_message_id: "m2" },
    ],
    messages: [
      { id: "m1", message: "Yeah" },
      { id: "m2", message: "What's the proposal?" },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.may_send, false);
  assert.ok(r.profile.opportunity_score.normalized_score >= 30);
  assert.equal(r.event.event_type, SHADOW_SELLER_INTEL_EVENT);
});

test("opt-out is terminal temperature", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    facts_after: [{ fact_type: "opt_out", value: true, active: true }],
    messages: [{ id: "1", message: "STOP" }],
  });
  assert.equal(r.profile.opportunity_score.temperature, "terminal");
  assert.equal(r.profile.opportunity_score.normalized_score, 0);
});

test("engagement alone cannot make hot", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    facts_after: [],
    messages: [
      { id: "1", message: "hi" },
      { id: "2", message: "hello again" },
      { id: "3", message: "still here" },
      { id: "4", message: "ping" },
      { id: "5", message: "yo" },
    ],
  });
  assert.notEqual(r.profile.opportunity_score.temperature, "hot");
});

test("not interested not overridden by engagement", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    facts_after: [{ fact_type: "not_interested", value: true, active: true }],
    messages: [
      { id: "1", message: "long message ".repeat(20) },
      { id: "2", message: "more" },
    ],
  });
  assert.ok(r.profile.opportunity_score.normalized_score <= 15);
});

test("archived alias rejected", () => {
  assert.equal(
    buildSellerIntelligenceProfile({ thread_key: "6128072000", facts_after: [] }).ok,
    false
  );
});

test("safety exclusions listed", () => {
  assert.ok(SELLER_INTEL_EXCLUSIONS.includes("race_or_ethnicity"));
  assert.ok(SELLER_INTEL_EXCLUSIONS.includes("financial_desperation"));
});

test("score cannot authorize send", () => {
  const r = buildSellerIntelligenceProfile({
    thread_key: THREAD,
    facts_after: [
      { fact_type: "ownership_confirmed", value: true, active: true },
      { fact_type: "asking_price", value: 250000, active: true },
      { fact_type: "proposal_interest_confirmed", value: true, active: true },
    ],
    messages: [{ id: "1", message: "Yes 250k" }],
  });
  assert.equal(r.may_enqueue, false);
  assert.equal(r.may_send, false);
  assert.equal(r.may_mutate_stages, false);
  assert.equal(r.profile.opportunity_score.hard_rules.score_cannot_authorize_send, true);
});
