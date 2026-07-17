// ─── acquisition-brain-burst-timing.test.mjs ───────────────────────────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  planShadowBurst,
  seededInRange,
  evaluateContactWindowShadow,
  BURST_DEBOUNCE_MIN_MS,
  BURST_DEBOUNCE_MAX_MS,
  SHADOW_BURST_EVENT,
} from "@/lib/domain/acquisition-brain/shadow-burst-timing.js";

const THREAD = "+16128072000";

test("deterministic debounce in 20–40s range", () => {
  const a = seededInRange("seed-a", BURST_DEBOUNCE_MIN_MS, BURST_DEBOUNCE_MAX_MS);
  const b = seededInRange("seed-a", BURST_DEBOUNCE_MIN_MS, BURST_DEBOUNCE_MAX_MS);
  assert.equal(a, b);
  assert.ok(a >= BURST_DEBOUNCE_MIN_MS && a <= BURST_DEBOUNCE_MAX_MS);
});

test("Example 1: Yeah + proposal + roof → one plan request_asking_price", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      { id: "1", message: "Yeah", classification: { primary_intent: "ownership_confirmed" } },
      { id: "2", message: "What's the proposal?", classification: { primary_intent: "asks_offer" } },
      { id: "3", message: "Needs a roof", classification: { primary_intent: "condition_disclosed" } },
    ],
    now: new Date("2026-07-17T15:00:00.000Z"), // inside window CDT
  });
  assert.equal(r.ok, true);
  assert.equal(r.plan.final_proposed_nba, "request_asking_price");
  assert.equal(r.plan.final_template_use_case, "seller_asking_price");
  assert.equal(r.plan.inbound_message_ids.length, 3);
  assert.equal(r.plan.superseded_reply_plans.length, 2);
  assert.equal(r.plan.may_send, false);
  assert.equal(r.event.event_type, SHADOW_BURST_EVENT);
  assert.ok(r.plan.questions_already_answered.includes("ownership_confirmed"));
});

test("Example 2: price + condition + timeline consolidates", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      {
        id: "1",
        message: "Yes, what's the proposal?",
        classification: { primary_intent: "asks_offer" },
      },
      {
        id: "2",
        message: "Around 250k",
        classification: { primary_intent: "asking_price_provided" },
      },
      {
        id: "3",
        message: "Roof and HVAC are old",
        classification: { primary_intent: "condition_disclosed" },
      },
      {
        id: "4",
        message: "Would want to close next month",
        classification: { primary_intent: "info_request" },
      },
    ],
    now: new Date("2026-07-17T15:00:00.000Z"),
  });
  assert.notEqual(r.plan.final_proposed_nba, "request_asking_price");
  assert.ok(r.plan.questions_already_answered.includes("asking_price"));
});

test("Example 3: authority/probate → complex path, no contract", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      { id: "1", message: "Yes", classification: { primary_intent: "ownership_confirmed" } },
      {
        id: "2",
        message: "Actually this is his brother",
        classification: { primary_intent: "ownership_confirmed" },
      },
      {
        id: "3",
        message: "He passed away",
        classification: { primary_intent: "ownership_confirmed" },
      },
    ],
    now: new Date("2026-07-17T15:00:00.000Z"),
  });
  assert.notEqual(r.plan.final_proposed_nba, "prepare_proposal");
  assert.ok(
    r.plan.facts_after.some((f) => String(f.fact_type).includes("probate") || String(f.fact_type).includes("family") || String(f.fact_type).includes("ownership_relation"))
  );
});

test("Example 4: STOP dominates later proposal", () => {
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      { id: "1", message: "STOP", classification: { primary_intent: "opt_out" } },
      {
        id: "2",
        message: "What's your proposal?",
        classification: { primary_intent: "asks_offer" },
      },
    ],
    now: new Date("2026-07-17T15:00:00.000Z"),
  });
  assert.equal(r.plan.final_proposed_nba, "opt_out");
  assert.equal(r.plan.timing_policy, "terminal_no_reply");
  assert.equal(r.plan.may_send, false);
});

test("outside contact window → deferred_contact_window", () => {
  // 05:00 UTC ≈ midnight CDT in summer
  const r = planShadowBurst({
    thread_key: THREAD,
    messages: [
      {
        id: "1",
        message: "Yes, what's the proposal?",
        classification: { primary_intent: "asks_offer" },
        timestamp: "2026-07-17T05:00:00.000Z",
      },
    ],
    now: new Date("2026-07-17T05:00:00.000Z"),
    timezone: "America/Chicago",
  });
  assert.equal(r.plan.timing_policy, "deferred_contact_window");
  assert.ok(r.plan.next_eligible_at);
  assert.equal(r.plan.may_transport, false);
});

test("non-e164 thread rejected", () => {
  const r = planShadowBurst({
    thread_key: "6128072000",
    messages: [{ id: "1", message: "Yeah", classification: { primary_intent: "ownership_confirmed" } }],
  });
  assert.equal(r.ok, false);
});

test("contact window evaluator inside hours", () => {
  const w = evaluateContactWindowShadow(new Date("2026-07-17T15:00:00.000Z"), "America/Chicago");
  assert.equal(w.allowed, true);
});
