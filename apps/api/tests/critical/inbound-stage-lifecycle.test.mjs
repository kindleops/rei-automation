import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  makeInboundLifecycleSupabase,
  makeInboundWebhookBaseDeps,
} from "../helpers/chainable-supabase.mjs";
import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";
import {
  createInMemoryIdempotencyLedger,
  createPodioItem,
} from "../helpers/test-helpers.js";

afterEach(() => {
  __resetTextgridInboundTestDeps();
});

function buildContext({ brain_item = null } = {}) {
  return {
    found: true,
    ids: {
      brain_item_id: brain_item?.item_id || null,
      master_owner_id: 21,
      prospect_id: 31,
      property_id: 41,
      phone_item_id: 51,
    },
    items: {
      brain_item,
      phone_item: createPodioItem(51),
      master_owner_item: createPodioItem(21),
      property_item: createPodioItem(41),
    },
    summary: {
      conversation_stage: "Ownership Confirmation",
      language_preference: "English",
    },
  };
}

// V2 orchestration stub shaped like processSellerInboundMessage's return —
// the handler consumes seller_stage_reply / execution / follow_up /
// intelligence_snapshot from it (resolveSellerAutoReplyPlan and
// executeInboundAutomationDecision are no longer handler-injectable).
function buildSellerOrchestrationResult({
  queued = false,
  queue_row_id = null,
  brain_stage = null,
  plan = { selected_use_case: null, detected_intent: null },
  preview_result = undefined,
  queue_result = undefined,
} = {}) {
  return {
    ok: true,
    decision: null,
    execution: queued
      ? { queued: true, queue_row_id, queue_result: { raw: {} } }
      : { queued: false },
    follow_up: { ok: true, skipped: true, reason: "not_attempted" },
    intelligence_snapshot: null,
    seller_stage_reply: {
      ok: true,
      handled: Boolean(queued || plan?.selected_use_case),
      queued,
      ...(queue_row_id ? { queue_row_id } : {}),
      ...(brain_stage ? { brain_stage } : {}),
      ...(queued ? {} : { reason: "seller_flow_not_handled" }),
      plan,
      ...(preview_result ? { preview_result } : {}),
      ...(queue_result ? { queue_result } : {}),
    },
  };
}

function installInboundDeps({
  context = buildContext(),
  resolveRoute = () => ({
    stage: "Ownership",
    use_case: "ownership_check",
    seller_profile: null,
  }),
  processSellerInboundMessage = async () => buildSellerOrchestrationResult(),
  // The Podio business-write lane is flag-gated off in production
  // (podio_sync_enabled). These tests enable it explicitly so the flag-on
  // lane's brain/pipeline lifecycle + rehydrated message-event contract stays
  // covered.
  getSystemValue = async (key) => {
    if (key === "podio_sync_enabled") return "true";
    return key === "auto_reply_mode" ? "live_limited" : null;
  },
  routeInboundOffer = async () => ({ ok: true, offer_route: null, reason: null, meta: {} }),
  createBrain = async () => null,
  updateBrainAfterInbound = async () => ({ ok: true }),
  updateBrainStage = async () => ({ ok: true }),
  syncPipelineState = async () => ({ ok: true, reason: "pipeline_not_created" }),
  logInboundMessageEvent = async () => {},
  postInboundSmsDiscordCard = async () => ({ ok: true, discord_message_id: "discord-msg-1" }),
  findInboundAutopilotQueue = async () => null,
  buildInboundAutopilotSchedule = (delay_seconds = 60) => {
    const scheduled_for = new Date(Date.now() + delay_seconds * 1000).toISOString();
    return {
      scheduled_for,
      scheduled_for_utc: scheduled_for,
      scheduled_for_local: scheduled_for,
    };
  },
  getSupabaseClient = () => makeInboundLifecycleSupabase(),
  logInboundMessageEventSupabase = async () => ({ ok: true, id: "evt-mock-1" }),
} = {}) {
  const ledger = createInMemoryIdempotencyLedger();
  const load_context_calls = [];

  __setTextgridInboundTestDeps({
    ...makeInboundWebhookBaseDeps({
      getSystemValue,
      getSupabaseClient,
      logInboundMessageEventSupabase,
    }),
    processSellerInboundMessage,
    routeInboundOffer,
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (value) => value,
    info: () => {},
    warn: () => {},
    loadContext: async (args) => {
      load_context_calls.push(args);
      return context;
    },
    createBrain,
    classify: async () => ({
      language: "English",
      source: "test",
    }),
    resolveRoute,
    logInboundMessageEvent,
    updateBrainAfterInbound,
    updateMasterOwnerAfterInbound: async () => ({ ok: true }),
    updateBrainStage,
    findLatestOpenOffer: async () => null,
    maybeProgressOfferStatus: async () => ({ ok: true, updated: false }),
    maybeCreateOfferFromContext: async () => ({ ok: true, created: false }),
    maybeUpsertUnderwritingFromInbound: async () => ({ ok: true, extracted: false }),
    maybeQueueUnderwritingFollowUp: async () => ({ ok: true, queued: false }),
    maybeCreateContractFromAcceptedOffer: async () => ({ ok: true, created: false }),
    syncPipelineState,
    postInboundSmsDiscordCard,
    findInboundAutopilotQueue,
    buildInboundAutopilotSchedule,
  });

  return {
    load_context_calls,
  };
}

test("inbound webhook passes create_brain_if_missing: true to loadContext", async () => {
  let create_brain_count = 0;
  let update_brain_count = 0;
  let sync_pipeline_args = null;

  const { load_context_calls } = installInboundDeps({
    createBrain: async () => {
      create_brain_count += 1;
      return createPodioItem(77);
    },
    updateBrainAfterInbound: async () => {
      update_brain_count += 1;
      return { ok: true };
    },
    syncPipelineState: async (args) => {
      sync_pipeline_args = args;
      return { ok: true, reason: "pipeline_not_created" };
    },
  });

  const result = await handleTextgridInboundWebhook({
    message_id: "sms-no-brain",
    from: "+15550000001",
    to: "+15550000002",
    body: "Who is this?",
    status: "received",
  });

  assert.equal(result.ok, true);
  // Brain creation is delegated to loadContext via create_brain_if_missing,
  // which the handler derives from podio_business_writes_enabled — true here
  // because the fixture enables the flag-gated Podio lane.
  assert.equal(load_context_calls[0]?.create_brain_if_missing, true);
  // The mock loadContext doesn't actually call createBrain, and the mock context
  // has no brain, so shouldCreateBrainForInbound controls the post-queue create.
  // The route use_case (ownership_check) matches the brain creation criteria.
  assert.equal(create_brain_count, 1);
  assert.equal(sync_pipeline_args?.create_if_missing, false);
});

test("inbound webhook creates the brain only after Stage 1 owner confirmation and still defers pipeline creation", async () => {
  let created_brain_args = null;
  const update_brain_calls = [];
  const stage_update_calls = [];
  let sync_pipeline_args = null;

  const result = await (async () => {
    installInboundDeps({
      processSellerInboundMessage: async () =>
        buildSellerOrchestrationResult({
          queued: true,
          queue_row_id: "queue-stage-1",
          brain_stage: "consider_selling",
          plan: {
            selected_use_case: "consider_selling",
            detected_intent: "Ownership Confirmed",
            should_queue_reply: true,
          },
          queue_result: { rendered_message_text: "Stage 2 reply" },
        }),
      createBrain: async (args) => {
        created_brain_args = args;
        return createPodioItem(77);
      },
      updateBrainAfterInbound: async (args) => {
        update_brain_calls.push(args);
        return { ok: true };
      },
      updateBrainStage: async (args) => {
        stage_update_calls.push(args);
        return { ok: true };
      },
      syncPipelineState: async (args) => {
        sync_pipeline_args = args;
        return { ok: true, reason: "pipeline_not_created" };
      },
    });

    return handleTextgridInboundWebhook({
      message_id: "sms-stage-1-yes",
      from: "+15550000001",
      to: "+15550000002",
      body: "Yes, I own it.",
      status: "received",
    });
  })();

  assert.equal(result.ok, true);
  assert.equal(created_brain_args?.master_owner_id, 21);
  assert.equal(created_brain_args?.prospect_id, 31);
  assert.equal(created_brain_args?.property_id, 41);
  assert.equal(created_brain_args?.phone_item_id, 51);
  assert.deepEqual(
    update_brain_calls.map((entry) => entry.brain_id),
    [77]
  );
  assert.deepEqual(stage_update_calls, [
    { brain_id: 77, stage: "consider_selling" },
  ]);
  assert.equal(sync_pipeline_args?.conversation_item_id, 77);
  assert.equal(sync_pipeline_args?.create_if_missing, false);
});

test("inbound webhook allows pipeline creation only after Stage 2 offer-interest confirmation", async () => {
  let create_brain_count = 0;
  const update_brain_calls = [];
  let sync_pipeline_args = null;

  const brain_item = createPodioItem(11);

  installInboundDeps({
    context: buildContext({ brain_item }),
    resolveRoute: () => ({
      stage: "Offer",
      use_case: "consider_selling",
      seller_profile: null,
    }),
    processSellerInboundMessage: async () =>
      buildSellerOrchestrationResult({
        queued: true,
        queue_row_id: "queue-stage-2",
        brain_stage: "asking_price",
        plan: {
          selected_use_case: "asking_price",
          detected_intent: "Open to Selling",
          should_queue_reply: true,
        },
      }),
    createBrain: async () => {
      create_brain_count += 1;
      return createPodioItem(88);
    },
    updateBrainAfterInbound: async (args) => {
      update_brain_calls.push(args);
      return { ok: true };
    },
    syncPipelineState: async (args) => {
      sync_pipeline_args = args;
      return { ok: true, pipeline_item_id: 61, current_stage: "Offer" };
    },
  });

  const result = await handleTextgridInboundWebhook({
    message_id: "sms-stage-2-yes",
    from: "+15550000001",
    to: "+15550000002",
    body: "Yes, I'd consider an offer.",
    status: "received",
  });

  assert.equal(result.ok, true);
  assert.equal(create_brain_count, 0);
  assert.deepEqual(
    update_brain_calls.map((entry) => entry.brain_id),
    [11]
  );
  assert.equal(sync_pipeline_args?.conversation_item_id, 11);
  assert.equal(sync_pipeline_args?.create_if_missing, true);
});

test("inbound webhook defaults to delayed autopilot and still posts Discord control card", async () => {
  const v2_calls = [];
  const card_calls = [];
  const logged_events = [];

  installInboundDeps({
    processSellerInboundMessage: async (args) => {
      v2_calls.push(args);
      return buildSellerOrchestrationResult({
        queued: true,
        queue_row_id: "queue-1",
        plan: {
          selected_use_case: "ownership_check",
          detected_intent: "Ownership Confirmed",
          should_queue_reply: true,
        },
        preview_result: {
          rendered_message_text: "Suggested review reply",
          template_id: "ownership-template-1",
          selected_template_source: "seller_flow",
        },
        queue_result: {
          rendered_message_text: "Suggested review reply",
          template_id: "ownership-template-1",
          selected_template_source: "seller_flow",
        },
      });
    },
    logInboundMessageEvent: async (args) => {
      logged_events.push(args);
      return { item_id: args.record_item_id || "msg-event-1" };
    },
    postInboundSmsDiscordCard: async (args) => {
      card_calls.push(args);
      return { ok: true, discord_message_id: "discord-msg-1", channel_id: "chan-1", channel_key: "inbound_replies", fallback: false };
    },
  });

  const result = await handleTextgridInboundWebhook({
    message_id: "sms-review-default-1",
    from: "+15550000001",
    to: "+15550000002",
    body: "Yes, I own it.",
    status: "received",
  });

  assert.equal(result.ok, true);
  assert.equal(v2_calls.length, 1);
  assert.equal(v2_calls[0].dryRun, false);
  assert.equal(result.seller_stage_reply?.queued, true);
  assert.equal(card_calls.length, 1);
  assert.equal(card_calls[0].autopilot_enabled, true);
  assert.equal(card_calls[0].suggested_reply_preview, "Suggested review reply");
  assert.equal(logged_events.at(-1)?.metadata?.autopilot_reply, true);
  assert.equal(logged_events.at(-1)?.metadata?.discord_review_status, "autopilot_pending");
  assert.equal(logged_events.at(-1)?.metadata?.discord_message_id, "discord-msg-1");
});

test("inbound webhook skips delayed queue and marks manual review when autopilot is disabled", async () => {
  const card_calls = [];
  const logged_events = [];

  installInboundDeps({
    processSellerInboundMessage: async () =>
      buildSellerOrchestrationResult({
        queued: false,
        plan: {
          selected_use_case: "consider_selling",
          detected_intent: "Open to Selling",
          should_queue_reply: false,
        },
        preview_result: {
          rendered_message_text: "Autopilot reply",
          template_id: "template-auto-1",
          selected_template_source: "seller_flow",
        },
      }),
    getSystemValue: async (key) => {
      if (key === "podio_sync_enabled") return "true";
      return key === "auto_reply_mode" ? "disabled" : null;
    },
    logInboundMessageEvent: async (args) => {
      logged_events.push(args);
      return { item_id: args.record_item_id || "msg-event-2" };
    },
    postInboundSmsDiscordCard: async (args) => {
      card_calls.push(args);
      return { ok: true, discord_message_id: "discord-msg-2", channel_id: "chan-1", channel_key: "inbound_replies", fallback: false };
    },
  });

  const result = await handleTextgridInboundWebhook(
    {
      message_id: "sms-autopilot-on-1",
      from: "+15550000001",
      to: "+15550000002",
      body: "Yes, I'd consider an offer.",
      status: "received",
    },
    {
      auto_reply_enabled: true,
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.seller_stage_reply?.queued, false);
  assert.equal(card_calls.length, 1);
  assert.equal(card_calls[0].autopilot_enabled, false);
  assert.equal(logged_events.at(-1)?.metadata?.discord_review_status, "manual_review_required");
});

test("inbound webhook still posts Discord review card when classification degrades", async () => {
  const card_calls = [];

  installInboundDeps({
    resolveRoute: () => {
      throw new Error("route resolution failed");
    },
    logInboundMessageEvent: async (args) => ({ item_id: args.record_item_id || "msg-event-3" }),
    postInboundSmsDiscordCard: async (args) => {
      card_calls.push(args);
      return { ok: true, discord_message_id: "discord-msg-3", channel_id: "chan-1", channel_key: "inbound_replies", fallback: false };
    },
  });

  const result = await handleTextgridInboundWebhook({
    message_id: "sms-degraded-1",
    from: "+15550000001",
    to: "+15550000002",
    body: "Tell me more.",
    status: "received",
  });

  assert.equal(result.ok, true);
  assert.equal(result.classification?.source, "inbound_review_fallback");
  assert.equal(card_calls.length, 1);
  assert.equal(card_calls[0].suggested_reply_preview, "");
  assert.match(card_calls[0].safety_state || "", /manual review/i);
});

test("discord post failure does not block delayed autopilot queueing", async () => {
  const logged_events = [];

  installInboundDeps({
    processSellerInboundMessage: async () =>
      buildSellerOrchestrationResult({
        queued: true,
        queue_row_id: "queue-card-fail",
        plan: {
          selected_use_case: "ownership_check",
          detected_intent: "Ownership Confirmed",
          should_queue_reply: true,
        },
        queue_result: {
          rendered_message_text: "Queued despite card failure",
          template_id: "tmpl-card-fail",
          selected_template_source: "seller_flow",
        },
      }),
    logInboundMessageEvent: async (args) => {
      logged_events.push(args);
      return { item_id: args.record_item_id || "msg-event-card-fail" };
    },
    postInboundSmsDiscordCard: async () => {
      throw new Error("discord unavailable");
    },
  });

  const result = await handleTextgridInboundWebhook({
    message_id: "sms-card-fail-1",
    from: "+15550000001",
    to: "+15550000002",
    body: "Yes, I own it.",
    status: "received",
  });

  // Card failure must never block the queued autopilot reply.
  assert.equal(result.ok, true);
  assert.equal(result.seller_stage_reply?.queued, true);
  assert.equal(logged_events.at(-1)?.metadata?.autopilot_reply, true);
  assert.equal(logged_events.at(-1)?.metadata?.discord_card_error, "discord unavailable");
});

test("idempotent replay does not duplicate autopilot queue or Discord card", async () => {
  const v2_calls = [];
  const card_calls = [];

  installInboundDeps({
    processSellerInboundMessage: async (args) => {
      v2_calls.push(args);
      return buildSellerOrchestrationResult({
        queued: true,
        queue_row_id: "queue-replay-safe",
        plan: {
          selected_use_case: "ownership_check",
          detected_intent: "Ownership Confirmed",
          should_queue_reply: true,
        },
        queue_result: { rendered_message_text: "Replay-safe reply" },
      });
    },
    logInboundMessageEvent: async (args) => ({ item_id: args.record_item_id || "msg-event-replay-1" }),
    postInboundSmsDiscordCard: async (args) => {
      card_calls.push(args);
      return { ok: true, discord_message_id: "discord-msg-replay-1" };
    },
  });

  const payload = {
    message_id: "sms-replay-safe-1",
    from: "+15550000001",
    to: "+15550000002",
    body: "Yes, I own it.",
    status: "received",
  };

  const first = await handleTextgridInboundWebhook(payload);
  const second = await handleTextgridInboundWebhook(payload);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(v2_calls.length, 1);
  assert.equal(card_calls.length, 1);
});
