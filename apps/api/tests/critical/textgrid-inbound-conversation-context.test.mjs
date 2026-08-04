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

function baseDeps() {
  const ledger = createInMemoryIdempotencyLedger();
  return {
    ...makeInboundWebhookBaseDeps({ getSupabaseClient: () => makeInboundLifecycleSupabase() }),
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

test("the live webhook passes conversation_context into classify()", async (t) => {
  const classify_calls = [];
  const context_calls = [];

  __setTextgridInboundTestDeps({
    ...baseDeps(),
    buildConversationContext: async (args) => {
      context_calls.push(args);
      return {
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
    },
    classify: async (message, brain, options) => {
      classify_calls.push({ message, brain, options });
      return {
        primary_intent: "ownership_confirmed",
        confidence: 0.88,
        version: "test",
      };
    },
  });
  t.after(() => __resetTextgridInboundTestDeps());

  await handleTextgridInboundWebhook(inboundPayload()).catch(() => {});

  assert.ok(context_calls.length >= 1, "the webhook must build conversation context itself");
  assert.equal(context_calls[0].thread_key, THREAD, "context is built for the canonical thread");
  assert.equal(
    context_calls[0].inbound_received_at,
    RECEIVED_AT,
    "the real inbound timestamp is used, never a fabricated now()"
  );

  assert.ok(classify_calls.length >= 1, "classify must run");
  const options = classify_calls[0].options || {};
  assert.equal(options.heuristicOnly, true, "the no-AI guarantee must survive this change");
  assert.ok(
    options.conversation_context,
    "classify() must receive conversation_context — this is the incident"
  );
  assert.equal(options.conversation_context.last_outbound_use_case, "ownership_check");
  assert.equal(options.conversation_context.unanswered_question, true);
});

test("a context-resolution failure degrades to the prior behaviour, never a 500", async (t) => {
  const classify_calls = [];
  __setTextgridInboundTestDeps({
    ...baseDeps(),
    buildConversationContext: async () => {
      throw new Error("context store unreachable");
    },
    classify: async (message, brain, options) => {
      classify_calls.push(options);
      return { primary_intent: "unclear", confidence: 0.4, version: "test" };
    },
  });
  t.after(() => __resetTextgridInboundTestDeps());

  await handleTextgridInboundWebhook(inboundPayload()).catch(() => {});

  assert.ok(classify_calls.length >= 1, "classification must still happen");
  assert.equal(
    classify_calls[0].conversation_context,
    null,
    "a failed lookup yields null context, not a thrown webhook"
  );
  assert.equal(classify_calls[0].heuristicOnly, true);
});

test("no outbound history means no fabricated context", async (t) => {
  const classify_calls = [];
  __setTextgridInboundTestDeps({
    ...baseDeps(),
    buildConversationContext: async () => null,
    classify: async (message, brain, options) => {
      classify_calls.push(options);
      return { primary_intent: "unclear", confidence: 0.4, version: "test" };
    },
  });
  t.after(() => __resetTextgridInboundTestDeps());

  await handleTextgridInboundWebhook(inboundPayload()).catch(() => {});
  assert.equal(classify_calls[0].conversation_context, null);
});
