import test from "node:test";
import assert from "node:assert/strict";

import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

// Wiring contract for the natural-response wording layer: it is env-gated
// (NATURAL_REPLY_ENGINE=enabled), may only substitute validated generated
// text for the approved template rendering, and every failure keeps the
// deterministic template text byte-identical. Decisions are never altered.

function liveNestedThreadContext(summaryOverrides = {}) {
  return {
    found: true,
    inbound_from: "+16125551234",
    ids: { master_owner_id: "mo-21", prospect_id: "pros-31", property_id: "prop-227" },
    items: {},
    flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 3, recent_events: [] },
    summary: {
      conversation_stage: "ownership_confirmation",
      seller_stage: "ownership_confirmation",
      property_address: "123 Main St",
      seller_first_name: "Jane",
      language_preference: "English",
      disposition: "not_interested",
      last_intent: "not_interested",
      automation_status: "paused",
      last_inbound_at: "2026-05-01T12:00:00.000Z",
      ...summaryOverrides,
    },
  };
}

const ASKING_PRICE_TEMPLATE = {
  id: "tpl-seller-asking-price",
  template_id: "tpl-seller-asking-price",
  use_case: "seller_asking_price",
  stage_code: "seller_asking_price",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto_reply",
  template_body:
    "Hi {{seller_first_name}}, what were you hoping to get for {{property_address}}? Reply STOP to opt out.",
  property_type_scope: "any",
};

function makeSupabase() {
  function makeChain(table) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      gte: () => chain,
      lte: () => chain,
      lt: () => chain,
      or: () => chain,
      order: () => chain,
      update: () => chain,
      insert: () => chain,
      upsert: () => chain,
      limit: async () => ({
        data:
          table === "sms_templates"
            ? [ASKING_PRICE_TEMPLATE]
            : table === "sms_suppression_list"
              ? [
                  {
                    id: "s-soft-1",
                    phone_number: "+16125551234",
                    suppression_reason: "not_interested",
                    is_active: true,
                  },
                ]
              : [],
        error: null,
      }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
    };
    return chain;
  }
  return { from: (table) => makeChain(table) };
}

async function runDecision({ naturalReplyModelCall = null } = {}) {
  const context = liveNestedThreadContext();
  return executeInboundAutomationDecision({
    message: "Are you still interested in buying?",
    threadKey: "+16125551234",
    inboundFrom: "+16125551234",
    inboundTo: "+16125550000",
    ownerId: "mo-21",
    latestThreadContext: context,
    context,
    classification: {
      primary_intent: "latent_interest",
      confidence: 0.64,
      automation_decision: { auto_reply_allowed: true },
    },
    inboundReceivedAt: "2026-08-01T12:00:00.000Z",
    dryRun: true,
    autoReplyMode: "dry_run",
    supabaseClient: makeSupabase(),
    naturalReplyModelCall,
  });
}

function withEngineEnabled(fn) {
  return async () => {
    const prior = process.env.NATURAL_REPLY_ENGINE;
    process.env.NATURAL_REPLY_ENGINE = "enabled";
    try {
      await fn();
    } finally {
      if (prior === undefined) delete process.env.NATURAL_REPLY_ENGINE;
      else process.env.NATURAL_REPLY_ENGINE = prior;
    }
  };
}

const GENERATED_TEXT =
  "Absolutely, still interested in 123 Main St, Jane. Glad you reached back out. What price would work for you? Reply STOP to opt out.";

function goodModelCall() {
  return async () => ({
    output: {
      response_text: GENERATED_TEXT,
      facts_used: ["property_address", "seller_first_name"],
      questions_answered: [],
      next_question: "What price would work for you?",
      confidence: 0.9,
    },
    provider: "mock",
    model: "mock-1",
  });
}

test("engine disabled by default: template text untouched, no audit", async () => {
  assert.notEqual(process.env.NATURAL_REPLY_ENGINE, "enabled");
  const result = await runDecision({ naturalReplyModelCall: goodModelCall() });
  assert.equal(result.automation_decision.should_queue_reply, true);
  assert.match(result.rendered_message_text, /what were you hoping to get/);
  assert.equal(result.natural_reply, null);
});

test(
  "enabled + valid constrained output substitutes wording without touching the decision",
  withEngineEnabled(async () => {
    const baseline = await runDecision();
    const result = await runDecision({ naturalReplyModelCall: goodModelCall() });
    assert.equal(result.rendered_message_text, GENERATED_TEXT);
    assert.equal(result.natural_reply.source, "generated");
    assert.equal(result.natural_reply.model.provider, "mock");
    // Decision fields identical to the deterministic run.
    assert.deepEqual(
      { ...result.automation_decision, latest_intent_precedence: null },
      { ...baseline.automation_decision, latest_intent_precedence: null }
    );
  })
);

test(
  "enabled + hallucinated price falls back to the template text",
  withEngineEnabled(async () => {
    const result = await runDecision({
      naturalReplyModelCall: async () => ({
        output: {
          response_text: "We can offer $185,000 for 123 Main St today. Reply STOP to opt out.",
          facts_used: ["property_address"],
          questions_answered: [],
          next_question: null,
          confidence: 0.95,
        },
        provider: "mock",
        model: "mock-1",
      }),
    });
    assert.match(result.rendered_message_text, /what were you hoping to get/);
    assert.equal(result.natural_reply.source, "deterministic_fallback");
    assert.equal(result.natural_reply.fallback_reason, "invented_numeric_claim");
  })
);

test(
  "enabled + throwing model call falls back to the template text",
  withEngineEnabled(async () => {
    const result = await runDecision({
      naturalReplyModelCall: async () => {
        throw new Error("provider down");
      },
    });
    assert.match(result.rendered_message_text, /what were you hoping to get/);
    assert.equal(result.natural_reply.source, "deterministic_fallback");
    assert.equal(result.natural_reply.fallback_reason, "model_error");
    assert.equal(result.automation_decision.should_queue_reply, true);
  })
);

test(
  "enabled without any model configured keeps deterministic text",
  withEngineEnabled(async () => {
    const result = await runDecision();
    assert.match(result.rendered_message_text, /what were you hoping to get/);
    assert.equal(result.natural_reply, null);
  })
);
