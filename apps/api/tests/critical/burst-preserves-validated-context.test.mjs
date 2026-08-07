// ─── burst-preserves-validated-context.test.mjs ──────────────────────────────
// A contextual short reply validated by the webhook must survive durable burst
// persistence and remain authoritative when the SCHEDULED flush runs later.
//
// The failure this locks out: the durable constituent kept only
// { event_id, provider_message_id, body, received_at }, and the execution
// context was not persisted at all. The cron flush therefore ran with
// `const ctx = orchestration_context || {}` and rebuilt the turn from the bare
// aggregated body. An affirmative like "Yeah" has no question to bind to
// minutes later, so a decision already validated at high confidence collapsed
// and the turn ended as effective_action "none" with no reply row.
//
// All identifiers below are synthetic fixtures. Incident-specific evidence
// belongs in the PR description, not in a permanent test.

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendConstituent,
  durableClassification,
  durableExecutionContext,
  jsonSafeClone,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  createSellerInboundBurstCoordinator,
  latestPersistedTurnFacts,
} from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";

const THREAD = "+15550000001";
const SENDER = "+15550000002";
const INBOUND_EVENT_ID = "00000000-0000-4000-8000-00000000e001";
const PROVIDER_ID = "FIXTURE-PROVIDER-INBOUND-1";
const UNRESTRICTED = Object.freeze({ authorized: true, global: true });

// ── JSONB safety boundary ──────────────────────────────────────────────────
// Everything persisted into constituent_messages passes jsonSafeClone first.
// It is all-or-nothing: a partially stripped decision record would be worse
// than none, because the flush would treat the remainder as authoritative.

test("jsonSafeClone rejects a NESTED function", () => {
  const r = jsonSafeClone({ a: 1, deep: { nested: { fn: () => 1 } } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "function");
});

test("jsonSafeClone rejects BigInt and symbols, including symbol keys", () => {
  assert.equal(jsonSafeClone({ n: 1n }).ok, false);
  assert.equal(jsonSafeClone({ n: 1n }).reason, "bigint");
  assert.equal(jsonSafeClone({ s: Symbol("x") }).ok, false);
  assert.equal(jsonSafeClone({ s: Symbol("x") }).reason, "symbol");
  const symKeyed = { ok: 1 };
  symKeyed[Symbol("k")] = 2;
  assert.equal(jsonSafeClone(symKeyed).reason, "symbol_key");
});

test("jsonSafeClone rejects a CYCLIC object instead of overflowing", () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const r = jsonSafeClone(cyclic);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "cycle");
});

test("jsonSafeClone preserves valid nested JSON exactly and deep-copies it", () => {
  const input = { a: 1, b: "two", c: null, d: [1, { e: true }], f: { g: { h: 0.88 } } };
  const r = jsonSafeClone(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, input);
  r.value.f.g.h = 999;
  assert.equal(input.f.g.h, 0.88, "must be a copy, not a live reference");
  assert.deepEqual(JSON.parse(JSON.stringify(r.value)), r.value, "round-trips through JSON");
});

test("classification uses the SAME safety boundary and is rejected as a whole", () => {
  const unsafe = ownershipConfirmedClassification({ automation_decision: { hook: () => true } });
  assert.equal(durableClassification(unsafe), null, "a partially-safe decision record is not persisted");
  const safe = durableClassification(ownershipConfirmedClassification());
  assert.equal(safe.canonical_intent, "ownership_confirmed");
  assert.equal(safe.automation_decision.queue_action, "queue_auto_reply");
});

test("append does not throw, and drops ONLY the unsafe optional field", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const { constituents } = appendConstituent([], {
    event_id: INBOUND_EVENT_ID,
    provider_message_id: PROVIDER_ID,
    body: "Yeah",
    received_at: "2030-01-01T00:00:00.000Z",
    classification: ownershipConfirmedClassification(),
    execution_context: durableExecutionContext({ ...liveOrchestrationContext(), context: cyclic }),
  });
  const row = constituents[0];
  assert.equal(row.body, "Yeah", "append still succeeds");
  assert.ok(row.classification, "the safe field is still persisted");
  assert.equal(row.execution_context.context, undefined, "the cyclic field is omitted");
  assert.equal(row.execution_context.executionAllowed, true, "sibling safe fields survive");
  assert.deepEqual(JSON.parse(JSON.stringify(row)), row, "the whole constituent round-trips");
});

// The classification shape the webhook produces for a contextual affirmative.
function ownershipConfirmedClassification(overrides = {}) {
  return {
    primary_intent: "ownership_confirmed",
    canonical_intent: "ownership_confirmed",
    confidence: 0.88,
    matched_rule: "ctx_yes_after_ownership_check",
    context_status: "valid",
    context_use_case: "ownership_check",
    context_source_outbound_id: "FIXTURE-PROVIDER-OUTBOUND-1",
    automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply" },
    ...overrides,
  };
}

// The execution context the webhook builds and passes to onPersistedInbound.
// Includes two NON-serializable handles that must never reach jsonb.
function liveOrchestrationContext() {
  return {
    propertyId: "fixture_property_1",
    prospectId: "fixture_prospect_1",
    ownerId: "fixture_owner_1",
    phoneId: "phone_1",
    context: { context_status: "valid", last_outbound_use_case: "ownership_check" },
    route: "seller_flow",
    inboundTo: SENDER,
    stageBefore: "ownership_check",
    autoReplyMode: "internal_only",
    executionAllowed: true,
    systemFollowupEnabled: true,
    inboundAutopilotDelaySeconds: 0,
    recentOutbound: { provider_message_id: "FIXTURE-PROVIDER-OUTBOUND-1" },
    supabaseClient: { from() { throw new Error("must not be persisted"); } },
    getSystemValue: async () => null,
  };
}

test("appendConstituent PRESERVES the webhook classification (it was silently dropped)", () => {
  const { constituents } = appendConstituent([], {
    event_id: INBOUND_EVENT_ID,
    provider_message_id: PROVIDER_ID,
    body: "Yeah",
    received_at: "2030-01-01T00:00:00.000Z",
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
  assert.equal(row.execution_context.propertyId, "fixture_property_1");
  assert.equal(row.execution_context.executionAllowed, true);
  assert.equal(row.execution_context.stageBefore, "ownership_check");
});

test("durableExecutionContext excludes non-serializable request handles", () => {
  const durable = durableExecutionContext(liveOrchestrationContext());
  assert.equal(durable.supabaseClient, undefined, "a Supabase client must never reach jsonb");
  assert.equal(durable.getSystemValue, undefined, "a bound function must never reach jsonb");
  assert.equal(JSON.parse(JSON.stringify(durable)).propertyId, "fixture_property_1");
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
  let clock = Date.parse("2030-01-01T00:00:00.000Z");
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
    assert.equal(turn.propertyId, "fixture_property_1");
    assert.equal(turn.prospectId, "fixture_prospect_1");
    assert.equal(turn.ownerId, "fixture_owner_1");
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
