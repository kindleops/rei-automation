/**
 * Live TextGrid webhook must construct conversation context BEFORE the first
 * authoritative classification — incident 2026-08-03.
 *
 * The fallback inside processSellerInboundMessage is unreachable for live
 * traffic: handle-textgrid-inbound always supplies `classification`, so the
 * `if (!classification)` branch never runs. The webhook therefore has to build
 * the context itself, or a delivered ownership question can never bind the
 * seller's "Yeah".
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
  handleTextgridInboundWebhook,
} from "@/lib/flows/handle-textgrid-inbound.js";
import {
  makeInboundWebhookBaseDeps,
  makeInboundLifecycleSupabase,
} from "../helpers/chainable-supabase.mjs";
import { createInMemoryIdempotencyLedger, createPodioItem } from "../helpers/test-helpers.js";
import { CONTEXT_VERSION } from "@/lib/domain/classification/conversation-context.js";

const THREAD = "+15550100042";
const RECEIVED_AT = "2026-08-03T22:40:31.039Z";

let orchestrationCalls = [];

function baseDeps() {
  orchestrationCalls = [];
  const ledger = createInMemoryIdempotencyLedger();
  return {
    ...makeInboundWebhookBaseDeps({ getSupabaseClient: () => makeInboundLifecycleSupabase() }),
    // Capture what orchestration actually receives.
    processSellerInboundMessage: async (args) => {
      orchestrationCalls.push(args);
      return { ok: true, queued: false, effective_action: "none" };
    },
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (value) => value,
    info: () => {},
    warn: () => {},
    loadContext: async () => ({
      found: true,
      ids: { brain_item_id: null, master_owner_id: 21, prospect_id: 31, property_id: 41, phone_item_id: 51 },
      items: {
        brain_item: null,
        phone_item: createPodioItem(51),
        master_owner_item: createPodioItem(21),
        property_item: createPodioItem(41),
      },
      summary: { conversation_stage: "Ownership Confirmation", language_preference: "English" },
    }),
    createBrain: async () => null,
    resolveRoute: () => ({ stage: "Ownership", use_case: "ownership_check", seller_profile: null }),
    updateBrainAfterInbound: async () => ({ ok: true }),
    updateMasterOwnerAfterInbound: async () => ({ ok: true }),
    updateBrainStage: async () => ({ ok: true }),
    findLatestOpenOffer: async () => null,
    maybeProgressOfferStatus: async () => ({ ok: true, updated: false }),
    maybeCreateOfferFromContext: async () => ({ ok: true, created: false }),
    maybeUpsertUnderwritingFromInbound: async () => ({ ok: true, extracted: false }),
    maybeQueueUnderwritingFollowUp: async () => ({ ok: true, queued: false }),
    maybeCreateContractFromAcceptedOffer: async () => ({ ok: true, created: false }),
    syncPipelineState: async () => ({ ok: true, reason: "pipeline_not_created" }),
    postInboundSmsDiscordCard: async () => ({ ok: true, discord_message_id: "d1" }),
    findInboundAutopilotQueue: async () => null,
    buildInboundAutopilotSchedule: (delay_seconds = 60) => {
      const scheduled_for = new Date(Date.now() + delay_seconds * 1000).toISOString();
      return { scheduled_for, scheduled_for_utc: scheduled_for, scheduled_for_local: scheduled_for };
    },
  };
}

function inboundPayload(body = "Yeah") {
  return {
    message_id: "sms-context-proof-1",
    from: THREAD,
    to: "+15550100999",
    body,
    status: "received",
    received_at: RECEIVED_AT,
    http_received_at: RECEIVED_AT,
  };
}

test("the live webhook passes conversation_context into the classify() whose result reaches orchestration", async (t) => {
  const classify_calls = [];
  const context_calls = [];
  const CONTEXT = {
    context_version: CONTEXT_VERSION,
    canonical_thread: THREAD,
    inbound_thread: THREAD,
    last_outbound_message_id: "SM-outbound-1",
    last_outbound_use_case: "ownership_check",
    last_outbound_question_type: "ownership",
    last_outbound_delivered_at: "2026-08-03T22:38:33.178Z",
    current_inbound_received_at: RECEIVED_AT,
    intervening_outbound_count: 0,
    intervening_inbound_count: 0,
    question_status: "unanswered",
    unanswered_question: true,
  };
  const CLASSIFICATION = {
    primary_intent: "ownership_confirmed",
    confidence: 0.88,
    version: "ctx-test",
    source: "contextual_short_reply",
  };

  __setTextgridInboundTestDeps({
    ...baseDeps(),
    buildConversationContext: async (args) => {
      context_calls.push(args);
      return CONTEXT;
    },
    classify: async (message, brain, options) => {
      classify_calls.push({ message, brain, options });
      return CLASSIFICATION;
    },
  });
  t.after(() => __resetTextgridInboundTestDeps());

  // No .catch(): a webhook failure must fail this test, not be swallowed.
  const result = await handleTextgridInboundWebhook(inboundPayload());
  assert.notEqual(result?.ok, false, `webhook must not fail: ${JSON.stringify(result?.reason ?? null)}`);

  // Context was built by the LIVE handler, from the real inbound timestamp.
  assert.equal(context_calls.length >= 1, true, "the webhook must build context itself");
  assert.equal(context_calls[0].thread_key, THREAD);
  assert.equal(context_calls[0].inbound_received_at, RECEIVED_AT, "no fabricated now()");

  // It reached classify, with the no-AI guarantee intact.
  assert.equal(classify_calls.length >= 1, true);
  const options = classify_calls[0].options || {};
  assert.equal(options.heuristicOnly, true);
  assert.equal(options.conversation_context?.last_outbound_use_case, "ownership_check");
  assert.equal(options.conversation_context?.unanswered_question, true);

  // The context-derived classification is the one orchestration consumes —
  // not a second classify, and not the inbound_review_fallback.
  assert.equal(orchestrationCalls.length, 1, "orchestration must run exactly once");
  const handed = orchestrationCalls[0].classification;
  assert.equal(handed.source, "contextual_short_reply", "context-derived result must survive");
  assert.notEqual(handed.source, "inbound_review_fallback");
  assert.equal(handed.primary_intent, "ownership_confirmed");
  assert.equal(handed.confidence, 0.88);
  assert.equal(handed, CLASSIFICATION, "the exact object, not a re-derived one");
});

test("processSellerInboundMessage's own fallback is NOT production coverage", async (t) => {
  // The webhook always supplies a classification, so the `if (!classification)`
  // branch inside the orchestrator never executes for live traffic. If it ever
  // did, the context wiring in the webhook would be pointless.
  __setTextgridInboundTestDeps({
    ...baseDeps(),
    buildConversationContext: async () => null,
    classify: async () => ({ primary_intent: "unclear", confidence: 0.4, version: "t" }),
  });
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(inboundPayload());
  assert.notEqual(result?.ok, false);
  assert.equal(orchestrationCalls.length, 1);
  assert.ok(
    orchestrationCalls[0].classification,
    "the webhook always supplies a classification, so the orchestrator fallback is dead for live traffic"
  );
});

test("a context lookup failure completes without a 500", async (t) => {
  const classify_calls = [];
  __setTextgridInboundTestDeps({
    ...baseDeps(),
    buildConversationContext: async () => {
      throw new Error("context store unreachable");
    },
    classify: async (message, brain, options) => {
      classify_calls.push(options);
      return { primary_intent: "unclear", confidence: 0.4, version: "t" };
    },
  });
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(inboundPayload());
  assert.notEqual(result?.ok, false, "a context failure must not fail the webhook");
  assert.equal(classify_calls.length >= 1, true, "classification still runs");
  assert.equal(classify_calls[0].conversation_context, null, "degrades to null context");
  assert.equal(classify_calls[0].heuristicOnly, true);
});

test("no outbound history completes without a 500 and fabricates nothing", async (t) => {
  const classify_calls = [];
  __setTextgridInboundTestDeps({
    ...baseDeps(),
    buildConversationContext: async () => null,
    classify: async (message, brain, options) => {
      classify_calls.push(options);
      return { primary_intent: "unclear", confidence: 0.4, version: "t" };
    },
  });
  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(inboundPayload());
  assert.notEqual(result?.ok, false);
  assert.equal(classify_calls[0].conversation_context, null);
});

test("a downstream orchestration failure now FAILS this test instead of being swallowed", async (t) => {
  // Guards the guard: proves the assertions above would catch a real break.
  __setTextgridInboundTestDeps({
    ...baseDeps(),
    buildConversationContext: async () => null,
    classify: async () => ({ primary_intent: "unclear", confidence: 0.4, version: "t" }),
    processSellerInboundMessage: async () => {
      throw new Error("orchestration exploded");
    },
  });
  t.after(() => __resetTextgridInboundTestDeps());

  let threw = false;
  try {
    const result = await handleTextgridInboundWebhook(inboundPayload());
    if (result?.ok === false) threw = true;
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "a real downstream failure must surface, not be swallowed");
});
