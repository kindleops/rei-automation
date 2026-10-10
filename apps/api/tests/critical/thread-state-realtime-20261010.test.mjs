/**
 * Stage / status / temperature in real time (owner P0 2026-10-10).
 *
 * Prod, 14 days (universal_lead_state_events, source_view workflow_automation_rule):
 *   stage.inbound_new_reply  operational_status → not_contacted   759 inbounds
 *     (from needs_review 256, active_communication 215, paused 150, scheduled 137)
 *   stage.asking_price_hot   lifecycle_stage → offer               2 (regex "price|how much")
 *   stage.not_interested_cold lifecycle_stage → offer_interest     9
 * The Podio-era rules' "open" alias normalizes to not_contacted and
 * "needs_offer" to offer. Then the first-contact promotion saw not_contacted on
 * our next send and flipped it to waiting_on_seller — threads sat at "waiting
 * on seller" while the seller had just replied.
 *
 * Pipeline label: resolveQueuedStep labelled the EARLIEST machine send after a
 * stale `due`, so a thread that had moved on to the S3 price question still read
 * "Autopilot reply delivered (interest question)".
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { guardInboundRulePatch, isPlausibleHeldAskingPrice } from "@/lib/domain/automation/automation-actions.js";
import { stageTemperatureRules } from "@/lib/domain/automation/rules/stage-temperature-rules.js";
import { resolveQueuedStep } from "@/lib/domain/opportunity/pipeline-ownership.js";

const inbound = (classification = {}) => ({ event_type: "inbound_message_received", payload: { classification } });

test("every stage.* inbound rule: no lifecycle stage / status / next_action write survives the guard", () => {
  for (const rule of stageTemperatureRules) {
    for (const action of rule.actions.filter((a) => a.action_type === "patch_thread_state")) {
      for (const classification of [{}, { primary_intent: "asks_offer" }, { primary_intent: "asking_price_provided", price_parse: { qualifies_as_seller_asking_price: true } }]) {
        const { params } = guardInboundRulePatch({ event: inbound(classification), params: action.params });
        for (const key of ["stage", "status", "next_action"]) assert.equal(params[key], undefined, `${rule.rule_key}.${key}`);
      }
    }
  }
});

test("hot / urgent only for a plausible HELD asking price — never a question, never an absurd ask, never unknown", () => {
  const hot = stageTemperatureRules.find((r) => r.rule_key === "stage.asking_price_hot").actions[0].params;
  const cases = [
    [{}, false],
    [{ primary_intent: "asks_offer" }, false],
    [{ primary_intent: "asking_price_implausible", price_parse: { value: 3_000_000, qualifies_as_seller_asking_price: false } }, false],
    [{ primary_intent: "asking_price_provided", price_parse: { value: 3_000_000, qualifies_as_seller_asking_price: true, implausibility: { implausible: true } } }, false],
    [{ primary_intent: "asking_price_provided", price_parse: { value: 165_000, qualifies_as_seller_asking_price: true } }, true],
  ];
  for (const [classification, allowed] of cases) {
    assert.equal(isPlausibleHeldAskingPrice(classification), allowed, JSON.stringify(classification));
    const { params, suppressed } = guardInboundRulePatch({ event: inbound(classification), params: hot });
    assert.equal(params.is_urgent === true, allowed, JSON.stringify(classification));
    assert.equal(params.metadata?.lead_temperature === "hot", allowed);
    assert.ok(suppressed, "the original patch is recorded, never silently lost");
  }
});

test("non-inbound events are untouched by the guard (outbound / delivery rules keep their own semantics)", () => {
  const params = { status: "open", priority: "urgent", is_urgent: true };
  const out = guardInboundRulePatch({ event: { event_type: "outbound_message_delivered" }, params });
  assert.equal(out.params, params);
  assert.equal(out.suppressed, null);
});

test("pipeline label: the latest machine send after the anchor is the step (S3 after S2 → asking-price question)", () => {
  const due = "2026-10-09T14:14:30.000Z";
  const rows = [
    { queue_status: "delivered", use_case_template: "consider_selling", created_at: "2026-10-09T14:17:00.000Z", sent_at: "2026-10-09T14:17:16.000Z", type: "auto_reply" },
    { queue_status: "delivered", use_case_template: "seller_asking_price", created_at: "2026-10-09T18:02:00.000Z", sent_at: "2026-10-09T18:02:06.000Z", type: "auto_reply" },
  ];
  const step = resolveQueuedStep({ due, anchor: "2026-10-09T14:14:19.000Z", rows, now: Date.parse("2026-10-09T19:00:00Z") });
  assert.equal(step.outcome, "sent");
  assert.equal(step.row.use_case_template, "seller_asking_price");
});
