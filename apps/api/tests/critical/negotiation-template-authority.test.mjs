import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";

const OFFER_TEMPLATE = {
  id: "tpl-offer",
  template_id: "tpl-offer",
  use_case: "initial_offer",
  stage_code: "initial_offer",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto_reply",
  template_body: "I can purchase {{property_address}} directly, as-is, for {{offer_price}}. Would that work?",
  property_type_scope: "any",
};

function baseArgs(overrides = {}) {
  return {
    message: "I want $95,000 for it",
    threadKey: "+15551230000",
    propertyId: "prop-9",
    prospectId: "pros-9",
    ownerId: "mo-9",
    phoneId: "phone-9",
    classification: {
      primary_intent: "asking_price_value",
      confidence: 0.92,
      seller_state: { price_mentioned: 95000 },
      automation_decision: { auto_reply_allowed: true },
    },
    context: {
      found: true,
      summary: {
        conversation_stage: "offer",
        property_address: "9 Elm St",
        seller_first_name: "Sam",
        language_preference: "English",
      },
    },
    inboundFrom: "+15551230000",
    inboundTo: "+15559990000",
    inboundEventId: "evt-auth-1",
    enableQueueInsert: true,
    dryRun: false,
    autoReplyMode: "live_all",
    ...overrides,
  };
}

function offerDirective(overrides = {}) {
  return {
    strategy: "initial_offer",
    reason_code: "NEAR_GAP_INITIAL_OFFER",
    template_use_case: "initial_offer",
    allowed_template_use_cases: ["initial_offer", "offer_reveal_cash"],
    review_required: false,
    review_reason: null,
    ...overrides,
  };
}

test("§12: offer renders ONLY the strategy-authorized ADE amount — never the seller's ask", async () => {
  const insertedQueueRows = [];
  const supabase = makeSellerOrchestrationSupabase({ templates: [OFFER_TEMPLATE], insertedQueueRows });
  const result = await executeInboundAutomationDecision({
    ...baseArgs(),
    supabaseClient: supabase,
    strategyDirective: offerDirective(),
    dealAuthority: {
      recommended_offer: 80000,
      authorized_offer_amount: 80000,
      authorized_offer_ceiling: 90000,
    },
  });
  assert.equal(result.queued, true);
  assert.ok(result.rendered_message_text.includes("$80,000"));
  assert.ok(!result.rendered_message_text.includes("95,000"), "seller ask must never reach the offer field");
});

test("§12: renderer fails closed to human review when authority is missing", async () => {
  const supabase = makeSellerOrchestrationSupabase({ templates: [OFFER_TEMPLATE] });
  const result = await executeInboundAutomationDecision({
    ...baseArgs(),
    supabaseClient: supabase,
    strategyDirective: offerDirective(),
    dealAuthority: null,
  });
  assert.equal(result.queued, false);
  assert.equal(result.rendered_message_text, null);
  assert.equal(result.automation_decision.should_mark_human_review, true);
  assert.equal(result.automation_decision.human_review_reason, "template_render_failed");
});

test("§12: an amount above the persisted ceiling is discarded and the send blocks", async () => {
  const supabase = makeSellerOrchestrationSupabase({ templates: [OFFER_TEMPLATE] });
  const result = await executeInboundAutomationDecision({
    ...baseArgs(),
    supabaseClient: supabase,
    strategyDirective: offerDirective(),
    dealAuthority: {
      recommended_offer: 99000, // model/upstream tried to exceed authority
      authorized_offer_amount: 99000,
      authorized_offer_ceiling: 90000,
    },
  });
  assert.equal(result.queued, false, "no send may carry an amount above the ceiling");
  assert.equal(result.automation_decision.should_mark_human_review, true);
});

test("§12: review-tier strategy blocks queueing outright", async () => {
  const supabase = makeSellerOrchestrationSupabase({ templates: [OFFER_TEMPLATE] });
  const result = await executeInboundAutomationDecision({
    ...baseArgs(),
    supabaseClient: supabase,
    strategyDirective: offerDirective({
      strategy: "structured_terms_review",
      review_required: true,
      review_reason: "structured_terms_signal",
    }),
    dealAuthority: { recommended_offer: 80000, authorized_offer_ceiling: 90000 },
  });
  assert.equal(result.queued, false);
  assert.equal(result.automation_decision.should_mark_human_review, true);
  assert.equal(result.automation_decision.human_review_reason, "structured_terms_signal");
});

test("§18: duplicate inbound never queues a second reply", async () => {
  const supabase = makeSellerOrchestrationSupabase({
    templates: [OFFER_TEMPLATE],
    sendQueueRows: [
      { id: "queue-dup", source_event_id: "evt-auth-1", type: "auto_reply", queue_status: "queued" },
    ],
  });
  const result = await executeInboundAutomationDecision({
    ...baseArgs(),
    supabaseClient: supabase,
    strategyDirective: offerDirective(),
    dealAuthority: {
      recommended_offer: 80000,
      authorized_offer_amount: 80000,
      authorized_offer_ceiling: 90000,
    },
  });
  assert.equal(result.queued, false);
  assert.equal(result.duplicate_suppressed, true);
});

test("§12: negotiation strategies fall back to the local template registry", async () => {
  // No condition_probe row in sms_templates — the canonical local registry
  // supplies it instead of silently downgrading to review.
  const supabase = makeSellerOrchestrationSupabase({ templates: [] });
  const result = await executeInboundAutomationDecision({
    ...baseArgs({ message: "The house needs some work" }),
    supabaseClient: supabase,
    strategyDirective: {
      strategy: "condition_discovery",
      reason_code: "GAP_DISCOVERY_CONDITION",
      template_use_case: "condition_probe",
      allowed_template_use_cases: ["condition_probe"],
      review_required: false,
    },
    dealAuthority: { recommended_offer: 80000, authorized_offer_ceiling: 90000 },
  });
  assert.equal(result.queued, true);
  assert.equal(result.selected_template.use_case, "condition_probe");
  assert.equal(result.selected_template.source, "local_registry");
  assert.ok(result.rendered_message_text.length > 0);
  assert.ok(!/\{\{/.test(result.rendered_message_text), "no unresolved tokens");
});
