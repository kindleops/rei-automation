import test from "node:test";
import assert from "node:assert/strict";

import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";
import { createInMemoryIdempotencyLedger, createPodioItem } from "../helpers/test-helpers.js";
import { makeInboundWebhookBaseDeps } from "../helpers/chainable-supabase.mjs";

// ─── Shared payload & setup helpers ─────────────────────────────────────

const INBOUND_PAYLOAD = {
  SmsMessageSid: "SM_fail_test_001",
  From: "+15551110001",
  To: "+15559990002",
  Body: "Testing failure handling",
  SmsStatus: "received",
  http_received_at: "2026-07-01T12:00:00.000Z",
};

function baseDeps(ledger) {
  return {
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (v) => v,
    info: () => {},
    warn: () => {},
  };
}

function happyPathDeps() {
  return {
    ...makeInboundWebhookBaseDeps(),
    loadContext: async () => ({
      found: true,
      ids: {
        brain_item_id: 11,
        master_owner_id: 21,
        prospect_id: 31,
        property_id: 41,
        phone_item_id: 51,
      },
      items: {
        brain_item: createPodioItem(11),
        phone_item: createPodioItem(51),
      },
    }),
    classify: async () => ({ language: "English", source: "test" }),
    resolveRoute: () => ({ stage: "Ownership", use_case: "ownership_check", seller_profile: null }),
    extractUnderwritingSignals: () => ({}),
    buildInboundConversationState: () => ({ follow_up_trigger_state: "AI Running" }),
    logInboundMessageEvent: async (payload) => ({ item_id: payload.record_item_id || 991 }),
    updateBrainAfterInbound: async () => {},
    updateMasterOwnerAfterInbound: async () => ({ ok: true }),
    updateBrainStage: async () => ({ ok: true }),
    findLatestOpenOffer: async () => null,
    maybeProgressOfferStatus: async () => ({ ok: true, updated: false }),
    maybeCreateOfferFromContext: async () => ({ ok: true, created: false }),
    maybeUpsertUnderwritingFromInbound: async () => ({ ok: true, extracted: false }),
    routeInboundOffer: async () => ({
      ok: true,
      offer_route: "no_offer_signal",
      reason: "test",
    }),
    resolveSellerAutoReplyPlan: async () => ({
      handled: false,
      should_queue_reply: false,
    }),
    executeInboundAutomationDecision: async () => ({
      ok: true,
      queued: false,
      seller_stage_reply: { ok: true, handled: false, queued: false },
    }),
    maybeQueueUnderwritingFollowUp: async () => ({ ok: true, queued: false }),
    maybeCreateContractFromAcceptedOffer: async () => ({ ok: true, created: false }),
    syncPipelineState: async () => ({ pipeline_item_id: 61, current_stage: "Ownership" }),
    isNegativeReply: () => false,
    cancelPendingQueueItemsForOwner: async () => ({ ok: true }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────


// Closure pass 2026-08-26: the three step-failure tests below inject throws
// into PODIO-lane steps (logInboundMessageEvent, updateMasterOwnerAfterInbound,
// findLatestOpenOffer). Production runs with podio_sync_enabled=false, so the
// throwing dep never fires and processing correctly completes. Each contract is
// now pinned in BOTH worlds: flag ON → the legacy lane still fails closed and
// marks the ledger failed; flag OFF (production) → the dep is never invoked
// and the record completes.
function podioLaneOn() {
  return {
    getSystemValue: async (key) => {
      if (key === "podio_sync_enabled") return "true";
      if (key === "auto_reply_mode") return "disabled";
      return null;
    },
  };
}

test("brain_lookup failure marks idempotency record as failed", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();

  __setTextgridInboundTestDeps({
    ...baseDeps(ledger),
    loadContext: async () => { throw new Error("brain_lookup_boom"); },
  });

  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(INBOUND_PAYLOAD);

  assert.equal(result.ok, false);
  assert.equal(result.error, "textgrid_inbound_failed_brain_lookup");

  // The ledger should have a "failed" record — not stuck in "processing"
  const entries = [...ledger.records.values()];
  const failedEntry = entries.find((e) => e.status === "failed");
  assert.ok(failedEntry, "idempotency record must be marked as failed, not stuck in processing");
  assert.equal(failedEntry.status, "failed");
});

test("message_event_create failure marks idempotency record as failed (podio lane ON)", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();

  __setTextgridInboundTestDeps({
    ...baseDeps(ledger),
    ...happyPathDeps(),
    ...podioLaneOn(),
    logInboundMessageEvent: async () => { throw new Error("event_create_boom"); },
  });

  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(INBOUND_PAYLOAD);

  assert.equal(result.ok, false);
  assert.equal(result.error, "textgrid_inbound_failed_message_event_create");

  const entries = [...ledger.records.values()];
  const failedEntry = entries.find((e) => e.status === "failed");
  assert.ok(failedEntry, "idempotency record must be marked as failed after message_event_create failure");
});

test("flags OFF (production): the podio event writer is never invoked and processing completes", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();
  let podio_writer_calls = 0;

  __setTextgridInboundTestDeps({
    ...baseDeps(ledger),
    ...happyPathDeps(),
    logInboundMessageEvent: async () => {
      podio_writer_calls += 1;
      throw new Error("event_create_boom");
    },
  });

  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(INBOUND_PAYLOAD);

  assert.equal(podio_writer_calls, 0, "flag-gated dep must not run in production posture");
  assert.equal(result.ok, true);
  const completed = [...ledger.records.values()].find((e) => e.status === "completed");
  assert.ok(completed, "record completes on the live lane");
});

test("conversation_resolution failure degrades to manual review and completes idempotency record", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();
  let failCallArgs = null;

  __setTextgridInboundTestDeps({
    ...baseDeps(ledger),
    ...happyPathDeps(),
    // Override failIdempotentProcessing to capture the call args
    failIdempotentProcessing: async (args) => {
      failCallArgs = args;
      return ledger.fail(args);
    },
    // logInboundMessageEvent succeeds → message_event_enriched = true
    logInboundMessageEvent: async (payload) => ({ item_id: payload.record_item_id || 991 }),
    // classify throws → triggers conversation_resolution failure AFTER enrichment
    classify: async () => { throw new Error("classify_boom"); },
  });

  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(INBOUND_PAYLOAD);

  assert.equal(result.ok, true);
  assert.equal(result.classification?.source, "inbound_review_fallback");

  // conversation resolution failures now degrade to manual review instead of failing the idempotency record
  assert.equal(failCallArgs, null);

  const entries = [...ledger.records.values()];
  const completedEntry = entries.find((e) => e.status === "completed");
  assert.ok(completedEntry, "idempotency record must be marked as completed after degraded manual-review handling");
});

test("brain_lookup failure passes skip_content_fields=false since enrichment never happened", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();
  let failCallArgs = null;

  __setTextgridInboundTestDeps({
    ...baseDeps(ledger),
    failIdempotentProcessing: async (args) => {
      failCallArgs = args;
      return ledger.fail(args);
    },
    loadContext: async () => { throw new Error("brain_boom"); },
  });

  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(INBOUND_PAYLOAD);

  assert.equal(result.ok, false);
  assert.equal(result.error, "textgrid_inbound_failed_brain_lookup");

  assert.ok(failCallArgs, "failIdempotentProcessing must be called on brain_lookup failure");
  assert.equal(
    failCallArgs.skip_content_fields,
    false,
    "skip_content_fields must be false when enrichment never happened"
  );
});

test("prospect_resolution failure marks idempotency record as failed", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();

  __setTextgridInboundTestDeps({
    ...baseDeps(ledger),
    ...happyPathDeps(),
    ...podioLaneOn(),
    updateMasterOwnerAfterInbound: async () => { throw new Error("prospect_boom"); },
  });

  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(INBOUND_PAYLOAD);

  assert.equal(result.ok, false);
  assert.equal(result.error, "textgrid_inbound_failed_prospect_resolution");

  const entries = [...ledger.records.values()];
  const failedEntry = entries.find((e) => e.status === "failed");
  assert.ok(failedEntry, "idempotency record must be marked as failed after prospect_resolution failure");
});

test("market_resolution failure marks idempotency record as failed", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();

  __setTextgridInboundTestDeps({
    ...baseDeps(ledger),
    ...happyPathDeps(),
    ...podioLaneOn(),
    findLatestOpenOffer: async () => { throw new Error("market_boom"); },
  });

  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(INBOUND_PAYLOAD);

  assert.equal(result.ok, false);
  assert.equal(result.error, "textgrid_inbound_failed_market_resolution");

  const entries = [...ledger.records.values()];
  const failedEntry = entries.find((e) => e.status === "failed");
  assert.ok(failedEntry, "idempotency record must be marked as failed after market_resolution failure");
});

test("successful inbound processing marks idempotency record as completed (not failed)", async (t) => {
  const ledger = createInMemoryIdempotencyLedger();

  __setTextgridInboundTestDeps({
    ...baseDeps(ledger),
    ...happyPathDeps(),
  });

  t.after(() => __resetTextgridInboundTestDeps());

  const result = await handleTextgridInboundWebhook(INBOUND_PAYLOAD);

  assert.equal(result.ok, true);

  const entries = [...ledger.records.values()];
  const completedEntry = entries.find((e) => e.status === "completed");
  assert.ok(completedEntry, "idempotency record must be completed on success");

  const failedEntry = entries.find((e) => e.status === "failed");
  assert.equal(failedEntry, undefined, "no failed records should exist on success");
});
