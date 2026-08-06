// ─── burst-preserves-validated-context.test.mjs ──────────────────────────────
// Regression lock for the 2026-08-06 live-handset failure.
//
// Canonical failing event: inbound 4dd580d3-1fb6-49fd-8c29-deebe5194877
// (provider SMIebYg3DJfcXf59o0xRQ4ZWw==), body "Yeah", received 23:10:18.641Z,
// 36 seconds after a valid ownership question, proof session active,
// allow_thread_auto_replies true.
//
// The webhook classified it correctly — ownership_confirmed at 0.88, rule
// ctx_yes_after_ownership_check, queue_action queue_auto_reply — then deferred
// to the burst. Burst sib:+16128072000:g2:SMIebYg3DJfcXf59o0xRQ4ZWw== completed
// with effective_action "none", queued false, and no S2 row was created.
//
// Two things were lost between the webhook and the scheduled flush:
//
//   1. appendConstituent kept only { event_id, provider_message_id, body,
//      received_at } and DROPPED the classification the coordinator passed.
//   2. orchestration_context was never persisted at all, so the cron flush ran
//      with `const ctx = orchestration_context || {}` — every execution-critical
//      field null: property/prospect/owner, conversation context, stageBefore,
//      autoReplyMode, executionAllowed.
//
// The flush therefore re-derived the turn from the bare aggregated body. "Yeah"
// with no question to bind to is not ownership_confirmed, so a decision already
// made at 0.88 collapsed and the turn ended as none.

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendConstituent,
  durableExecutionContext,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  createSellerInboundBurstCoordinator,
  latestPersistedTurnFacts,
} from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";

const THREAD = "+16128072000";
const SENDER = "+16128060495";
const INBOUND_EVENT_ID = "4dd580d3-1fb6-49fd-8c29-deebe5194877";
const PROVIDER_ID = "SMIebYg3DJfcXf59o0xRQ4ZWw==";
const UNRESTRICTED = Object.freeze({ authorized: true, global: true });

// The classification the webhook actually produced for the live "Yeah".
function ownershipConfirmedClassification(overrides = {}) {
  return {
    primary_intent: "ownership_confirmed",
    canonical_intent: "ownership_confirmed",
    confidence: 0.88,
    matched_rule: "ctx_yes_after_ownership_check",
    context_status: "valid",
    context_use_case: "ownership_check",
    context_source_outbound_id: "SMOlrdbmG7sQuYjX5EPJPeTUA==",
    automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply" },
    ...overrides,
  };
}

// The execution context the webhook builds and passes to onPersistedInbound.
// Includes two NON-serializable handles that must never reach jsonb.
function liveOrchestrationContext() {
  return {
    propertyId: "canaryprop_6bb8a46414092cb6318fbc35",
    prospectId: "pros1_8fc28a914d507bd9104daab2",
    ownerId: "mo_52f521c7e28ea3152f5e5f2c",
    phoneId: "phone_1",
    context: { context_status: "valid", last_outbound_use_case: "ownership_check" },
    route: "seller_flow",
    inboundTo: SENDER,
    stageBefore: "ownership_check",
    autoReplyMode: "internal_only",
    executionAllowed: true,
    systemFollowupEnabled: true,
    inboundAutopilotDelaySeconds: 0,
    recentOutbound: { provider_message_id: "SMOlrdbmG7sQuYjX5EPJPeTUA==" },
    supabaseClient: { from() { throw new Error("must not be persisted"); } },
    getSystemValue: async () => null,
  };
}

test("appendConstituent PRESERVES the webhook classification (it was silently dropped)", () => {
  const { constituents } = appendConstituent([], {
    event_id: INBOUND_EVENT_ID,
    provider_message_id: PROVIDER_ID,
    body: "Yeah",
    received_at: "2026-08-06T23:10:18.641Z",
    classification: ownershipConfirmedClassification(),
    execution_context: durableExecutionContext(liveOrchestrationContext()),
  });
  const row = constituents[0];
  assert.equal(row.body, "Yeah");
  assert.ok(row.classification, "classification must survive into the durable constituent");
  assert.equal(row.classification.canonical_intent, "ownership_confirmed");
  assert.equal(row.classification.confidence, 0.88);
  assert.equal(row.classification.matched_rule, "ctx_yes_after_ownership_check");
  assert.ok(row.execution_context, "execution context must survive into the durable constituent");
  assert.equal(row.execution_context.propertyId, "canaryprop_6bb8a46414092cb6318fbc35");
  assert.equal(row.execution_context.executionAllowed, true);
  assert.equal(row.execution_context.stageBefore, "ownership_check");
});

test("durableExecutionContext excludes non-serializable request handles", () => {
  const durable = durableExecutionContext(liveOrchestrationContext());
  assert.equal(durable.supabaseClient, undefined, "a Supabase client must never reach jsonb");
  assert.equal(durable.getSystemValue, undefined, "a bound function must never reach jsonb");
  assert.equal(JSON.parse(JSON.stringify(durable)).propertyId, "canaryprop_6bb8a46414092cb6318fbc35");
  for (const [, v] of Object.entries(durable)) assert.notEqual(typeof v, "function");
});

test("latestPersistedTurnFacts recovers the newest validated turn", () => {
  const facts = latestPersistedTurnFacts([
    { body: "first", classification: { canonical_intent: "unclear" } },
    { body: "Yeah", classification: ownershipConfirmedClassification(), execution_context: { executionAllowed: true } },
  ]);
  assert.equal(facts.classification.canonical_intent, "ownership_confirmed");
  assert.equal(facts.execution_context.executionAllowed, true);
});

// ── The end-to-end lock: opening question -> "Yeah" -> append -> SCHEDULED
//    flush -> ownership_confirmed still authoritative -> exactly one S2 row. ──

function buildHarness() {
  let clock = Date.parse("2026-08-06T23:10:18.641Z");
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const turns = [];
  const queueRows = [];

  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    activation_scope: UNRESTRICTED,
    processSellerInboundMessage: async (args) => {
      turns.push(args);
      // Stand-in for the real orchestrator: it acts on the classification and
      // execution authority it is HANDED. If the flush lost them, it cannot
      // advance the stage — which is exactly what happened live.
      const intent = args.classification?.canonical_intent ?? args.classification?.primary_intent ?? null;
      const authorized = args.executionAllowed === true;
      if (intent !== "ownership_confirmed" || !authorized) {
        return { ok: true, queued: false, effective_action: "none", execution: { queued: false } };
      }
      const dedupe = `s2:${args.inboundEventId}`;
      if (!queueRows.some((r) => r.dedupe === dedupe)) {
        queueRows.push({
          dedupe,
          template_id: "400065",
          use_case: "consider_selling",
          stage_after: "Offer Interest Confirmation",
          body: "Thanks for confirming. If I ran some numbers and sent you a proposal, would you take a look?",
          source_event_id: args.inboundEventId,
          to_phone_number: args.threadKey,
          property_id: args.propertyId,
        });
      }
      return {
        ok: true,
        queued: true,
        effective_action: "queue_auto_reply",
        stage_after: "Offer Interest Confirmation",
        lead_temperature: "warm",
        operational_status: "active_communication",
        execution: { queued: true },
      };
    },
  });

  return { coordinator, store, turns, queueRows, advance: (ms) => { clock += ms; }, now };
}

for (const phrase of ["Yeah", "Yep, I still do"]) {
  test(`E2E: "${phrase}" survives the SCHEDULED flush and creates exactly one S2 row`, async () => {
    const h = buildHarness();

    // Webhook ingest: classification + execution context are known HERE.
    const appended = await h.coordinator.onPersistedInbound({
      thread_key: THREAD,
      event_id: INBOUND_EVENT_ID,
      provider_message_id: PROVIDER_ID,
      body: phrase,
      received_at: h.now(),
      classification: ownershipConfirmedClassification(),
      orchestration_context: liveOrchestrationContext(),
    });
    assert.equal(appended.deferred, true, "webhook defers execution to the burst");
    assert.equal(h.turns.length, 0, "no orchestration at ingest time");

    const burst_id = appended.append.burst.burst_id;

    // Debounce elapses; the SCHEDULED flush runs with NO live context — this is
    // the exact condition that produced effective_action=none in production.
    h.advance(25_000);
    const flush = await h.coordinator.flushEligible({ thread_key: THREAD, burst_id, limit: 1 });

    assert.equal(flush.results.length, 1);
    assert.equal(flush.results[0].ok, true, "flush must finalize the burst");
    assert.equal(h.turns.length, 1, "exactly one orchestration turn");

    const turn = h.turns[0];
    assert.equal(
      turn.classification?.canonical_intent,
      "ownership_confirmed",
      "the webhook-validated intent must remain authoritative through the flush"
    );
    assert.equal(turn.classification?.confidence, 0.88);
    assert.equal(turn.executionAllowed, true, "execution authorization must survive the flush");
    assert.equal(turn.propertyId, "canaryprop_6bb8a46414092cb6318fbc35");
    assert.equal(turn.prospectId, "pros1_8fc28a914d507bd9104daab2");
    assert.equal(turn.ownerId, "mo_52f521c7e28ea3152f5e5f2c");
    assert.equal(turn.stageBefore, "ownership_check");
    assert.equal(turn.inboundTo, SENDER);
    assert.equal(turn.threadKey, THREAD);

    // S2 advancement + exactly one queue row.
    assert.equal(flush.results[0].queued, true, "the turn must queue a reply");
    assert.equal(h.queueRows.length, 1, "exactly one S2 queue row");
    const row = h.queueRows[0];
    assert.equal(row.template_id, "400065");
    assert.equal(row.use_case, "consider_selling");
    assert.equal(row.stage_after, "Offer Interest Confirmation");
    assert.equal(
      row.body,
      "Thanks for confirming. If I ran some numbers and sent you a proposal, would you take a look?"
    );
    assert.equal(row.source_event_id, INBOUND_EVENT_ID, "row links to the inbound event");
    assert.equal(row.to_phone_number, THREAD);
  });
}

test("retrying the flush does not create a duplicate S2 row", async () => {
  const h = buildHarness();
  await h.coordinator.onPersistedInbound({
    thread_key: THREAD,
    event_id: INBOUND_EVENT_ID,
    provider_message_id: PROVIDER_ID,
    body: "Yeah",
    received_at: h.now(),
    classification: ownershipConfirmedClassification(),
    orchestration_context: liveOrchestrationContext(),
  });
  h.advance(25_000);
  const first = await h.coordinator.flushEligible({ thread_key: THREAD, limit: 5 });
  assert.equal(first.results[0].ok, true);
  const second = await h.coordinator.flushEligible({ thread_key: THREAD, limit: 5 });
  assert.equal(second.results.length, 0, "a completed burst is no longer eligible");
  assert.equal(h.queueRows.length, 1, "still exactly one S2 row after a retry");
});
