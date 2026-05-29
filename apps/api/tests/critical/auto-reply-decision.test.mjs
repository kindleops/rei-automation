import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { applyInboundAutomationDecision } = await import(
  "../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js"
);

function makeArgs(classification) {
  return {
    message: "test message",
    threadKey: "+15551234567",
    propertyId: "prop_1",
    prospectId: "prospect_1",
    ownerId: "owner_1",
    phoneId: "phone_1",
    classification,
    latestThreadContext: {
      ids: {
        property_id: "prop_1",
        master_owner_id: "owner_1",
        phone_item_id: "phone_1",
      },
      summary: {
        property_type: "Single Family",
      },
    },
  };
}

test("opt_out never queues", () => {
  const decision = applyInboundAutomationDecision(
    makeArgs({
      primary_intent: "opt_out",
      confidence: 0.99,
      compliance_flag: "stop_texting",
      automation_decision: {
        auto_reply_allowed: false,
        suppression_action: "opt_out",
      },
    })
  );

  assert.equal(decision.should_queue_reply, false);
  assert.equal(decision.should_suppress_contact, true);
  assert.equal(decision.reply_mode, "none");
  assert.equal(decision.suppression_reason, "opt_out");
});

test("wrong_number suppresses phone and never queues", () => {
  const decision = applyInboundAutomationDecision(
    makeArgs({
      primary_intent: "wrong_number",
      confidence: 0.98,
      automation_decision: {
        auto_reply_allowed: false,
        suppression_action: "archive_wrong_number",
      },
    })
  );

  assert.equal(decision.should_queue_reply, false);
  assert.equal(decision.should_suppress_contact, true);
  assert.equal(decision.suppression_reason, "wrong_number");
  assert.equal(decision.next_action, "archive_wrong_number");
});

test("hostile_or_legal goes to human review", () => {
  const decision = applyInboundAutomationDecision(
    makeArgs({
      primary_intent: "hostile_or_legal",
      confidence: 0.95,
      automation_decision: {
        auto_reply_allowed: false,
        human_review_required: true,
      },
    })
  );

  assert.equal(decision.should_queue_reply, false);
  assert.equal(decision.should_mark_human_review, true);
  assert.equal(decision.reply_mode, "manual_review");
  assert.equal(decision.human_review_reason, "hostile_or_legal");
});

test("unclear low confidence is blocked for review", () => {
  const decision = applyInboundAutomationDecision(
    makeArgs({
      primary_intent: "unclear",
      confidence: 0.6,
      automation_decision: {
        auto_reply_allowed: false,
        human_review_required: true,
      },
    })
  );

  assert.equal(decision.should_queue_reply, false);
  assert.equal(decision.should_mark_human_review, true);
  assert.equal(decision.human_review_reason, "unclear_low_confidence");
});

test("ownership_confirmed can queue", () => {
  const decision = applyInboundAutomationDecision(
    makeArgs({
      primary_intent: "ownership_confirmed",
      confidence: 0.91,
      automation_decision: {
        auto_reply_allowed: true,
        human_review_required: false,
      },
    })
  );

  assert.equal(decision.should_queue_reply, true);
  assert.equal(decision.reply_mode, "auto");
  assert.equal(decision.route_hint, "consider_selling");
  assert.deepEqual(decision.allowed_template_stages, [
    "consider_selling",
    "stage_2_consider_selling",
  ]);
});

test("asks_offer can queue into price discovery route", () => {
  const decision = applyInboundAutomationDecision(
    makeArgs({
      primary_intent: "asks_offer",
      confidence: 0.9,
      automation_decision: {
        auto_reply_allowed: true,
        human_review_required: false,
      },
    })
  );

  assert.equal(decision.should_queue_reply, true);
  assert.equal(decision.route_hint, "ask_seller_price_or_basic_condition");
  assert.equal(decision.reply_mode, "auto");
});

test("asking_price_provided can queue into price_response route", () => {
  const decision = applyInboundAutomationDecision(
    makeArgs({
      primary_intent: "asking_price_provided",
      confidence: 0.88,
      automation_decision: {
        auto_reply_allowed: true,
        human_review_required: false,
      },
    })
  );

  assert.equal(decision.should_queue_reply, true);
  assert.equal(decision.route_hint, "price_response");
});

test("needs_call routes to text_only_redirect without promising a call", () => {
  const decision = applyInboundAutomationDecision(
    makeArgs({
      primary_intent: "callback_requested",
      objection: "needs_call",
      confidence: 0.9,
      automation_decision: {
        auto_reply_allowed: true,
        human_review_required: false,
      },
    })
  );

  assert.equal(decision.should_queue_reply, true);
  assert.equal(decision.route_hint, "text_only_redirect");
  assert.deepEqual(decision.allowed_template_stages, [
    "text_only_redirect",
    "sms_only_response",
  ]);
});
