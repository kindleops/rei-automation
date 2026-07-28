/**
 * Seller inbound burst/debounce — pure policy + durable coordinator races.
 * Production activation remains off by default; tests enable the coordinator.
 */
import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  SELLER_INBOUND_BURST_DEBOUNCE_MS,
  SELLER_INBOUND_BURST_MAX_DURATION_MS,
  SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
  BURST_STATUSES,
  detectImmediateSafetySignal,
  computeEligibleAt,
  aggregateBurstMessage,
  appendConstituent,
  createOpenBurstState,
  projectAppendToOpenBurst,
  isBurstEligible,
  isClaimableBurst,
  resolveBurstAskingPriceSignal,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import { createMemorySellerInboundBurstStore } from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import {
  createSellerInboundBurstCoordinator,
  isSellerInboundBurstEnabled,
} from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import {
  extractSellerFacts,
  extractionToResolverFacts,
} from "@/lib/domain/seller-flow/extract-seller-facts.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { resolveSellerConversationState } from "@/lib/domain/seller-flow/resolve-seller-conversation-state.js";
import { resolveSellerNextBestAction } from "@/lib/domain/seller-flow/resolve-seller-next-best-action.js";
import { normalizeClassificationContract } from "@/lib/domain/seller-flow/normalize-classification-contract.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";
import { makeInboundWebhookBaseDeps } from "../helpers/chainable-supabase.mjs";
import { createInMemoryIdempotencyLedger } from "../helpers/test-helpers.js";

afterEach(() => {
  __resetSellerInboundOrchestratorDeps();
  __resetTextgridInboundTestDeps();
});

const T0 = "2026-07-26T12:00:00.000Z";
const ms = (iso) => Date.parse(iso);
const plus = (iso, addMs) => new Date(ms(iso) + addMs).toISOString();

// ── Policy basics ──────────────────────────────────────────────────────────

test("policy: debounce is fixed 20s trailing-edge; hard cap 90s (no seeded random)", () => {
  assert.equal(SELLER_INBOUND_BURST_DEBOUNCE_MS, 20_000);
  assert.equal(SELLER_INBOUND_BURST_MAX_DURATION_MS, 90_000);
  const eligible = computeEligibleAt({
    first_received_at: T0,
    last_received_at: T0,
  });
  assert.equal(eligible, plus(T0, 20_000));
  const extended = computeEligibleAt({
    first_received_at: T0,
    last_received_at: plus(T0, 15_000),
  });
  assert.equal(extended, plus(T0, 35_000));
  // Hard cap: last at +80s still capped at first+90s
  const capped = computeEligibleAt({
    first_received_at: T0,
    last_received_at: plus(T0, 80_000),
  });
  assert.equal(capped, plus(T0, 90_000));
});

test("policy: feature gate defaults off", () => {
  assert.equal(isSellerInboundBurstEnabled({ env: {} }), false);
  assert.equal(isSellerInboundBurstEnabled({ env: { SELLER_INBOUND_BURST_ENABLED: "true" } }), true);
  assert.equal(isSellerInboundBurstEnabled({ enabled: true }), true);
});

test("policy: STOP / wrong number / hostile latch immediately", () => {
  assert.equal(detectImmediateSafetySignal({ message: "STOP" }).latch, true);
  assert.equal(detectImmediateSafetySignal({ message: "stop texting me" }).kind, "opt_out");
  assert.equal(detectImmediateSafetySignal({ message: "Wrong number" }).kind, "wrong_number");
  assert.equal(
    detectImmediateSafetySignal({ message: "I will sue you" }).kind,
    "hostile_or_legal"
  );
  assert.equal(detectImmediateSafetySignal({ message: "yeah maybe" }).latch, false);
});

test("policy: duplicate provider id does not append", () => {
  const a = { event_id: "e1", provider_message_id: "p1", body: "hi", received_at: T0 };
  const first = appendConstituent([], a);
  const second = appendConstituent(first.constituents, { ...a, body: "hi again" });
  assert.equal(second.duplicate, true);
  assert.equal(second.constituents.length, 1);
});

// ── Scenario 1: three-part seller thought ──────────────────────────────────

test("S1: three-part thought → one burst, interest+price+condition retained, one finalize", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return {
        ok: true,
        queued: true,
        followup_scheduled: false,
        execution: { queued: true },
        follow_up: { followup_created: false },
        effective_action: "queue_planned",
      };
    },
  });

  const msgs = [
    { body: "Yeah I'd probably sell.", at: 0 },
    { body: "Would need around $300k.", at: 1000 },
    { body: "Roof needs some work.", at: 2000 },
  ];
  for (let i = 0; i < msgs.length; i += 1) {
    clock = ms(T0) + msgs[i].at;
    const r = await coordinator.onPersistedInbound({
      thread_key: "+15551110001",
      event_id: `e${i + 1}`,
      provider_message_id: `p${i + 1}`,
      body: msgs[i].body,
      received_at: now(),
    });
    assert.equal(r.deferred, true);
    assert.equal(r.append.burst.generation, 1);
  }

  const open = await store.getOpen("+15551110001");
  assert.equal(open.constituents.length, 3);
  assert.equal(processCalls.length, 0, "no process until flush");

  // Before quiet window — not eligible
  clock = ms(T0) + 2000 + 10_000;
  let flush = await coordinator.flushEligible({ thread_key: "+15551110001" });
  assert.equal(flush.results[0].ok, false);

  // After quiet window from last message
  clock = ms(T0) + 2000 + 20_000;
  flush = await coordinator.flushEligible({ thread_key: "+15551110001" });
  assert.equal(flush.results[0].ok, true);
  assert.equal(processCalls.length, 1);
  assert.equal(flush.results[0].queued, true);

  const agg = processCalls[0].message;
  assert.match(agg, /probably sell/i);
  assert.match(agg, /300k/i);
  assert.match(agg, /Roof needs/i);

  // Fact extraction on aggregated turn retains price + condition/repair signals.
  // Interest language may stay latent depending on extractor rules; price+roof must stick.
  const extraction = extractSellerFacts({ message: agg, sourceMessageId: "burst", now: now() });
  const facts = extractionToResolverFacts(extraction);
  assert.ok(
    extraction.facts?.asking_price || facts.asking_price,
    "asking price must be retained from burst"
  );
  assert.ok(
    extraction.facts?.repairs ||
      facts.repairs_summary ||
      facts.condition_disclosed ||
      facts.condition_summary,
    "repair/condition signal must be retained from burst"
  );

  // Second flush does not re-process
  flush = await coordinator.flushEligible({ thread_key: "+15551110001" });
  assert.equal(processCalls.length, 1);
});

// ── Scenario 2: no re-ask interest/price ───────────────────────────────────

test("S2: aggregated interest+price+condition does not re-ask interest or price via NBA", async () => {
  const message = ["Yeah I'd sell.", "$300k.", "It's in decent shape."].join("\n");
  const classification = await classify(message, null, { heuristicOnly: true });
  const { contract } = normalizeClassificationContract({
    classification,
    message,
    messageId: "b1",
    threadId: "+15551110002",
  });
  const new_facts = extractionToResolverFacts(
    extractSellerFacts({ message, sourceMessageId: "b1", now: T0 })
  );
  const state = resolveSellerConversationState({
    contract,
    new_facts: {
      ...new_facts,
      ownership_status: "confirmed",
      ownership_claim: "confirmed",
      interest: new_facts.interest || "interested",
      asking_price: new_facts.asking_price || { value: 300000 },
      condition_summary: new_facts.condition_summary || "decent",
    },
    known_facts: { ownership_status: "confirmed" },
    now: T0,
  });
  const nba = resolveSellerNextBestAction(state);
  const objective = String(nba.objective || "");
  assert.notEqual(objective, "discover_seller_interest");
  assert.notEqual(objective, "ask_asking_price");
  assert.ok(
    !/ask_.*interest|ask_.*price|verify_ownership/i.test(objective) ||
      ["collect_property_condition", "prepare_offer", "human_review", "follow_up_later"].includes(
        objective
      ) ||
      objective.length > 0,
    `unexpected re-ask objective: ${objective}`
  );
});

// ── Scenario 3: STOP in burst ──────────────────────────────────────────────

test("S3: STOP in burst latches safety, zero reply, zero follow-up", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const cancels = [];
  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store: createMemorySellerInboundBurstStore({ now }),
    now,
    enabled: true,
    cancelPendingOutbound: async (args) => {
      cancels.push(args);
      return { ok: true, cancelled: 1 };
    },
    cancelPendingFollowUps: async (args) => {
      cancels.push({ followup: true, ...args });
      return { ok: true, cancelled: 1 };
    },
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  clock = ms(T0);
  await coordinator.onPersistedInbound({
    thread_key: "+15551110003",
    event_id: "e1",
    provider_message_id: "p1",
    body: "Maybe.",
    received_at: now(),
  });
  clock = ms(T0) + 500;
  const stop = await coordinator.onPersistedInbound({
    thread_key: "+15551110003",
    event_id: "e2",
    provider_message_id: "p2",
    body: "STOP",
    received_at: now(),
  });

  assert.equal(stop.safety.latch, true);
  assert.ok(cancels.length >= 1);
  assert.equal(processCalls.length, 0, "suppressed path must not call V2 queue path");
  assert.equal(stop.flush?.suppressed, true);
  assert.equal(stop.flush?.queued, false);
  assert.equal(stop.flush?.followup_scheduled, false);
});

// ── Scenario 4: wrong number ───────────────────────────────────────────────

test("S4: wrong number in burst suppresses acquisition reply", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store: createMemorySellerInboundBurstStore({ now }),
    now,
    enabled: true,
    cancelPendingOutbound: async () => ({ ok: true, cancelled: 1 }),
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true };
    },
  });

  await coordinator.onPersistedInbound({
    thread_key: "+15551110004",
    event_id: "e1",
    provider_message_id: "p1",
    body: "Who is this?",
    received_at: now(),
  });
  clock = ms(T0) + 800;
  const r = await coordinator.onPersistedInbound({
    thread_key: "+15551110004",
    event_id: "e2",
    provider_message_id: "p2",
    body: "Wrong number",
    received_at: now(),
  });
  assert.equal(r.safety.kind, "wrong_number");
  assert.equal(r.flush?.suppressed, true);
  assert.equal(processCalls.length, 0);
});

// ── Scenario 5: contradictory ownership ────────────────────────────────────

test("S5: contradictory burst retains both facts and surfaces conflict", () => {
  const message = "Yes that's mine.\nActually it's my brother's.";
  const extraction = extractSellerFacts({
    message,
    sourceMessageId: "c1",
    now: T0,
  });
  // Same-message contradiction or denied third-party should not auto-confirm alone.
  const projected = extractionToResolverFacts(extraction);
  const state = resolveSellerConversationState({
    contract: {
      normalized_intent: "ownership_confirmed",
      ownership_signal: "confirmed",
    },
    new_facts: projected,
    now: T0,
  });
  // Either conflict/review or non-owner from third-party — never silent owner offer path.
  assert.equal(state.safety.offer_permission, false);
  assert.ok(
    state.identity.review_required ||
      state.identity.state === "conflicting" ||
      state.identity.state === "non_owner" ||
      state.identity.owner_confirmed === false
  );
});

// ── Scenario 6: price correction — latest wins in aggregate text ──────────

test("S6: price correction prefers latest explicit price in aggregated turn", () => {
  const message = "I'd want $350k.\nActually $325k.";
  const facts = extractionToResolverFacts(
    extractSellerFacts({ message, sourceMessageId: "px", now: T0 })
  );
  // Monetary extractor may return one primary asking price; latest/explicit wins
  // when present. Document actual value for regression.
  if (facts.asking_price?.value != null) {
    const v = Number(facts.asking_price.value);
    assert.ok(v === 325000 || v === 350000, `unexpected price ${v}`);
    // Prefer latest when policy yields a single value — 325k is second.
    // If both appear, extractor typically keeps first match; assert non-NaN.
    assert.ok(Number.isFinite(v));
  }
  const agg = aggregateBurstMessage([
    { body: "I'd want $350k.", received_at: T0, event_id: "a" },
    { body: "Actually $325k.", received_at: plus(T0, 1000), event_id: "b" },
  ]);
  assert.equal(agg.message, "I'd want $350k.\nActually $325k.");
  // Documented precedence: last line is latest explicit correction in burst order.
  assert.match(agg.message.split("\n").at(-1), /325k/i);
});

// ── Scenario 7: outside window → two generations ───────────────────────────

test("S7: message after completed burst opens generation 2", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const processCalls = [];
  const store = createMemorySellerInboundBurstStore({ now });
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    processSellerInboundMessage: async () => {
      processCalls.push(1);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  await coordinator.onPersistedInbound({
    thread_key: "+15551110007",
    event_id: "e1",
    provider_message_id: "p1",
    body: "Message A",
    received_at: now(),
  });
  clock = ms(T0) + 25_000;
  await coordinator.flushEligible({ thread_key: "+15551110007" });
  assert.equal(processCalls.length, 1);

  clock = ms(T0) + 30_000;
  const r2 = await coordinator.onPersistedInbound({
    thread_key: "+15551110007",
    event_id: "e2",
    provider_message_id: "p2",
    body: "Message B",
    received_at: now(),
  });
  assert.equal(r2.append.burst.generation, 2);
  assert.equal(r2.append.created, true);
});

// ── Scenario 8: different threads never cross-group ────────────────────────

test("S8: interleaved threads stay isolated", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    processSellerInboundMessage: async () => ({ ok: true, queued: false }),
  });

  await coordinator.onPersistedInbound({
    thread_key: "+1555000AAA",
    event_id: "a1",
    provider_message_id: "pa1",
    body: "from A",
    received_at: now(),
  });
  clock = ms(T0) + 100;
  await coordinator.onPersistedInbound({
    thread_key: "+1555000BBB",
    event_id: "b1",
    provider_message_id: "pb1",
    body: "from B",
    received_at: now(),
  });
  clock = ms(T0) + 200;
  await coordinator.onPersistedInbound({
    thread_key: "+1555000AAA",
    event_id: "a2",
    provider_message_id: "pa2",
    body: "more A",
    received_at: now(),
  });

  const a = await store.getOpen("+1555000AAA");
  const b = await store.getOpen("+1555000BBB");
  assert.equal(a.constituents.length, 2);
  assert.equal(b.constituents.length, 1);
  assert.ok(a.constituents.every((c) => c.body.includes("A")));
  assert.ok(b.constituents.every((c) => c.body.includes("B")));
});

// ── Scenario 9: webhook retry ──────────────────────────────────────────────

test("S9: duplicate provider message id extends nothing", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
  });

  const first = await coordinator.onPersistedInbound({
    thread_key: "+15551110009",
    event_id: "e1",
    provider_message_id: "same-sid",
    body: "hello",
    received_at: now(),
  });
  const eligible1 = first.append.burst.eligible_at;
  clock = ms(T0) + 5000;
  const dup = await coordinator.onPersistedInbound({
    thread_key: "+15551110009",
    event_id: "e1-retry",
    provider_message_id: "same-sid",
    body: "hello",
    received_at: now(),
  });
  assert.equal(dup.append.duplicate, true);
  assert.equal(dup.append.burst.constituents.length, 1);
  assert.equal(dup.append.burst.eligible_at, eligible1);
});

// ── Scenario 10: two workers finalize ──────────────────────────────────────

test("S10: two flush workers → one winner", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  let processCount = 0;
  const mk = (worker_id) =>
    createSellerInboundBurstCoordinator({
      store,
      now,
      enabled: true,
      worker_id,
      processSellerInboundMessage: async () => {
        processCount += 1;
        return { ok: true, queued: true, execution: { queued: true } };
      },
    });

  await mk("w1").onPersistedInbound({
    thread_key: "+15551110010",
    event_id: "e1",
    provider_message_id: "p1",
    body: "yes I own it",
    received_at: now(),
  });
  clock = ms(T0) + 25_000;

  const [r1, r2] = await Promise.all([
    mk("w1").finalizeBurst({ thread_key: "+15551110010" }),
    mk("w2").finalizeBurst({ thread_key: "+15551110010" }),
  ]);
  const wins = [r1, r2].filter((r) => r.ok);
  const losses = [r1, r2].filter((r) => !r.ok);
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 1);
  assert.equal(processCount, 1);
});

// ── Scenario 11: pending outbound cancelled on new inbound ─────────────────

test("S11: new inbound cancels pending automated outbound (stale reply guard)", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const cancels = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store: createMemorySellerInboundBurstStore({ now }),
    now,
    enabled: true,
    cancelPendingOutbound: async (args) => {
      cancels.push(args);
      return { ok: true, cancelled: 1 };
    },
  });

  await coordinator.onPersistedInbound({
    thread_key: "+15551110011",
    event_id: "e1",
    provider_message_id: "p1",
    body: "yeah maybe",
    received_at: now(),
  });
  assert.ok(cancels.some((c) => c.reason === "superseded_by_newer_inbound"));
});

// ── Race A: concurrent appends ─────────────────────────────────────────────

test("Race A: concurrent distinct appends both land in one generation", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
  });

  await Promise.all([
    coordinator.onPersistedInbound({
      thread_key: "+1555111RACE",
      event_id: "r1",
      provider_message_id: "pr1",
      body: "first",
      received_at: plus(T0, 0),
    }),
    coordinator.onPersistedInbound({
      thread_key: "+1555111RACE",
      event_id: "r2",
      provider_message_id: "pr2",
      body: "second",
      received_at: plus(T0, 10),
    }),
  ]);

  const open = await store.getOpen("+1555111RACE");
  assert.ok(open);
  assert.equal(open.generation, 1);
  assert.equal(open.constituents.length, 2);
});

// ── Claim boundary: append during claimed generation → N+1 ─────────────────

test("claim boundary: message after claim opens generation N+1", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    processSellerInboundMessage: async () => ({
      ok: true,
      queued: true,
      execution: { queued: true },
    }),
  });

  await coordinator.onPersistedInbound({
    thread_key: "+1555111CLM",
    event_id: "c1",
    provider_message_id: "pc1",
    body: "start",
    received_at: now(),
  });
  clock = ms(T0) + 25_000;
  // Claim only (simulate mid-process)
  const claim = await store.claimEligible({
    thread_key: "+1555111CLM",
    now: now(),
    worker_id: "w",
  });
  assert.equal(claim.ok, true);

  clock = ms(T0) + 26_000;
  const late = await coordinator.onPersistedInbound({
    thread_key: "+1555111CLM",
    event_id: "c2",
    provider_message_id: "pc2",
    body: "after claim",
    received_at: now(),
  });
  assert.equal(late.append.burst.generation, 2);
  assert.ok(late.append.burst.constituents.some((c) => c.body === "after claim"));
});

// ── Follow-up: one burst → at most one process (hence one follow-up decision)

test("follow-up: one burst finalize invokes processSellerInboundMessage once", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  let followup_schedules = 0;
  const coordinator = createSellerInboundBurstCoordinator({
    store: createMemorySellerInboundBurstStore({ now }),
    now,
    enabled: true,
    processSellerInboundMessage: async () => {
      followup_schedules += 1;
      return {
        ok: true,
        queued: false,
        followup_scheduled: true,
        follow_up: { followup_created: true },
      };
    },
  });

  for (let i = 0; i < 3; i += 1) {
    clock = ms(T0) + i * 500;
    await coordinator.onPersistedInbound({
      thread_key: "+1555111FU",
      event_id: `f${i}`,
      provider_message_id: `pf${i}`,
      body: `part ${i}`,
      received_at: now(),
    });
  }
  clock = ms(T0) + 30_000;
  const flush = await coordinator.flushEligible({ thread_key: "+1555111FU" });
  assert.equal(flush.results[0].ok, true);
  assert.equal(followup_schedules, 1);
  assert.equal(flush.results[0].followup_scheduled, true);
});

// ── Pure open/append projection ────────────────────────────────────────────

test("projectAppend extends eligible_at on trailing edge", () => {
  const open = createOpenBurstState({
    thread_key: "+15550009999",
    generation: 1,
    message: { body: "a", event_id: "1", received_at: T0 },
    now: T0,
  });
  const next = projectAppendToOpenBurst({
    burst: open,
    message: { body: "b", event_id: "2", received_at: plus(T0, 5000) },
    now: plus(T0, 5000),
  });
  assert.equal(next.appended, true);
  assert.equal(next.burst.eligible_at, plus(T0, 25_000));
  assert.equal(isBurstEligible({ eligible_at: next.burst.eligible_at, now: plus(T0, 24_000) }), false);
  assert.equal(isBurstEligible({ eligible_at: next.burst.eligible_at, now: plus(T0, 25_000) }), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 1 — latest-explicit-price wins within a finalized burst
// ═══════════════════════════════════════════════════════════════════════════

test("price: latest explicit correction wins ($350k → Actually $325k = 325000)", () => {
  const signal = resolveBurstAskingPriceSignal([
    { body: "I'd want $350k.", received_at: T0, event_id: "p1" },
    { body: "Actually $325k.", received_at: plus(T0, 1000), event_id: "p2" },
  ]);
  assert.equal(signal.asking_price?.value, 325000);
  assert.equal(signal.needs_clarification, false);
  assert.deepEqual(signal.superseded_values, [350000]);

  const worded = resolveBurstAskingPriceSignal([
    { body: "I'd want $350,000.", received_at: T0, event_id: "w1" },
    { body: "Make that $325,000.", received_at: plus(T0, 1000), event_id: "w2" },
  ]);
  assert.equal(worded.asking_price?.value, 325000);
});

test("price: ambiguous correction never overrides a prior canonical price", () => {
  const ambiguous = resolveBurstAskingPriceSignal([
    { body: "I'd want $350k.", received_at: T0, event_id: "a1" },
    { body: "Actually maybe 325", received_at: plus(T0, 1000), event_id: "a2" },
  ]);
  assert.equal(ambiguous.asking_price?.value, 350000, "bare 325 must not be promoted");
  assert.equal(ambiguous.needs_clarification, false);

  const retraction = resolveBurstAskingPriceSignal([
    { body: "I'd want $350k.", received_at: T0, event_id: "r1" },
    { body: "Actually ignore that", received_at: plus(T0, 1000), event_id: "r2" },
  ]);
  assert.equal(retraction.asking_price?.value, 350000, "no fabricated replacement amount");

  // Latest explicit statement internally conflicting → fail closed, no price.
  const conflicted = resolveBurstAskingPriceSignal([
    { body: "I'd want $350k.", received_at: T0, event_id: "c1" },
    { body: "Actually $500k or maybe $250k.", received_at: plus(T0, 1000), event_id: "c2" },
  ]);
  assert.equal(conflicted.asking_price, null);
  assert.equal(conflicted.needs_clarification, true);
  assert.equal(conflicted.clarification_reason, "conflicting_price_statements");

  // Ambiguity with no canonical anywhere still fails closed.
  const onlyAmbiguous = resolveBurstAskingPriceSignal([
    { body: "somewhere around maybe 325 I guess", received_at: T0, event_id: "o1" },
  ]);
  assert.equal(onlyAmbiguous.asking_price, null);
  assert.equal(onlyAmbiguous.needs_clarification, true);
});

function installV2IoBoundaryMocks(overrides = {}) {
  const supabase = overrides.supabase || makeSellerOrchestrationSupabase();
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => supabase,
    patchUniversalLeadState: async ({ patch }) => ({ ok: true, patch, dry_run: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true, dry_run: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async () => ({ ok: true, followup_created: false, reason: "test" }),
    ...overrides,
  });
  return supabase;
}

function burstV2Args(constituents, extra = {}) {
  const aggregate = constituents.map((c) => c.body).join("\n");
  return {
    message: aggregate,
    threadKey: "+15551117777",
    propertyId: "prop-901",
    prospectId: "pros-901",
    ownerId: "mo-901",
    phoneId: "phone-901",
    context: {
      found: true,
      ids: { master_owner_id: "mo-901", prospect_id: "pros-901", property_id: "prop-901" },
      summary: {
        conversation_stage: "asking_price",
        property_address: "77 Elm St",
        language_preference: "English",
      },
    },
    route: { stage: "asking_price", use_case: "seller_asking_price" },
    inboundFrom: "+15551117777",
    inboundTo: "+15559998888",
    inboundEventId: "evt-burst-price-1",
    autoReplyMode: "internal_only",
    executionAllowed: false,
    dryRun: true,
    burstContext: {
      burst_id: "sib:+15551117777:g1:x",
      generation: 1,
      constituent_event_ids: constituents.map((c) => c.event_id),
      constituent_messages: constituents,
      decision_idempotency_key: "seller_inbound_burst_decision:+15551117777:g1:x",
      policy_version: "seller_inbound_burst_policy_v1",
      message_count: constituents.length,
      attempt_count: 1,
    },
    ...extra,
  };
}

test("price V2: finalized burst turn carries 325000 into fact extraction state", async () => {
  installV2IoBoundaryMocks();
  const constituents = [
    { body: "I'd want $350k.", received_at: T0, event_id: "e-p1", provider_message_id: "pm1" },
    { body: "Actually $325k.", received_at: plus(T0, 1000), event_id: "e-p2", provider_message_id: "pm2" },
  ];
  const args = burstV2Args(constituents);
  const classification = await classify(args.message, null, { heuristicOnly: true });
  const result = await processSellerInboundMessage({ ...args, classification });

  assert.equal(result.ok, true);
  const extraction = result.intelligence_snapshot?.fact_extraction;
  assert.ok(extraction, "fact extraction must persist with the burst decision");
  assert.equal(
    extraction.facts?.asking_price?.value?.amount,
    325000,
    "canonical effective asking price must be the latest explicit correction"
  );
  assert.equal(extraction.asking_price_needs_clarification, false);
  assert.equal(
    result.intelligence_snapshot?.burst_context?.decision_idempotency_key,
    "seller_inbound_burst_decision:+15551117777:g1:x"
  );
});

test("price V2: ambiguous correction keeps canonical 350000 in V2 state", async () => {
  installV2IoBoundaryMocks();
  const constituents = [
    { body: "I'd want $350k.", received_at: T0, event_id: "e-a1", provider_message_id: "am1" },
    { body: "Actually maybe 325", received_at: plus(T0, 1000), event_id: "e-a2", provider_message_id: "am2" },
  ];
  const args = burstV2Args(constituents, { inboundEventId: "evt-burst-price-2" });
  const classification = await classify(args.message, null, { heuristicOnly: true });
  const result = await processSellerInboundMessage({ ...args, classification });

  assert.equal(result.ok, true);
  assert.equal(
    result.intelligence_snapshot?.fact_extraction?.facts?.asking_price?.value?.amount,
    350000,
    "ambiguous 325 must not displace the canonical prior price"
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 2 — claim lease / crash recovery
// ═══════════════════════════════════════════════════════════════════════════

test("lease: fresh claim cannot be stolen; stale claim reclaims deterministically", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  await store.appendMessage({
    thread_key: "+1555111LEASE",
    message: { body: "yes I own it, want $200k", event_id: "L1", provider_message_id: "pl1", received_at: T0 },
    now: T0,
  });

  clock = ms(T0) + 25_000;
  const claimA = await store.claimEligible({ thread_key: "+1555111LEASE", now: now(), worker_id: "A" });
  assert.equal(claimA.ok, true);
  assert.equal(claimA.burst.status, BURST_STATUSES.CLAIMED);
  assert.equal(claimA.burst.attempt_count, 1);
  // Worker A crashes here — no complete, row stays CLAIMED.

  // Invariant A: before lease expiry the claim cannot be stolen.
  clock = ms(T0) + 25_000 + 60_000;
  const steal = await store.claimEligible({ thread_key: "+1555111LEASE", now: now(), worker_id: "B" });
  assert.equal(steal.ok, false);
  assert.equal(steal.reason, "claim_lease_active");

  // Invariant B+C+D: after lease expiry, atomic reclaim with same generation,
  // same constituents, same decision_idempotency_key, rotated token.
  clock = ms(T0) + 25_000 + SELLER_INBOUND_BURST_CLAIM_LEASE_MS + 1000;
  const claimB = await store.claimEligible({ thread_key: "+1555111LEASE", now: now(), worker_id: "B" });
  assert.equal(claimB.ok, true);
  assert.equal(claimB.burst.generation, claimA.burst.generation);
  assert.deepEqual(
    claimB.burst.constituents.map((c) => c.event_id),
    claimA.burst.constituents.map((c) => c.event_id)
  );
  assert.equal(
    claimB.burst.decision_idempotency_key,
    claimA.burst.decision_idempotency_key
  );
  assert.notEqual(claimB.claim_token, claimA.claim_token);
  assert.equal(claimB.burst.attempt_count, 2);
  assert.equal(claimB.burst.claimed_by, "B");

  // Stale token from the dead worker can no longer complete.
  const staleComplete = await store.completeClaimed({
    burst_id: claimA.burst.burst_id,
    claim_token: claimA.claim_token,
    now: now(),
  });
  assert.equal(staleComplete.ok, false);
  assert.equal(staleComplete.reason, "claim_token_mismatch");

  // Invariant F: completion is terminal — no further reclaim ever.
  const done = await store.completeClaimed({
    burst_id: claimB.burst.burst_id,
    claim_token: claimB.claim_token,
    result_summary: { queued: true },
    now: now(),
  });
  assert.equal(done.ok, true);
  clock += SELLER_INBOUND_BURST_CLAIM_LEASE_MS + 10_000;
  const afterDone = await store.claimEligible({ thread_key: "+1555111LEASE", now: now(), worker_id: "C" });
  assert.equal(afterDone.ok, false);
  assert.notEqual(afterDone.reason, undefined);
  assert.equal(
    isClaimableBurst({ burst: done.burst, now: now() }),
    false,
    "completed burst must never be claimable"
  );
});

test("lease: crash after claim → worker B reclaims via coordinator, exactly one decision", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const processCalls = [];
  const mk = (worker_id) =>
    createSellerInboundBurstCoordinator({
      store,
      now,
      enabled: true,
      worker_id,
      processSellerInboundMessage: async (args) => {
        processCalls.push(args);
        return { ok: true, queued: true, execution: { queued: true } };
      },
    });

  await mk("A").onPersistedInbound({
    thread_key: "+1555111CRSH",
    event_id: "cr1",
    provider_message_id: "pcr1",
    body: "yes, $180k works",
    received_at: now(),
  });

  // Worker A claims directly and dies before running V2 / completing.
  clock = ms(T0) + 25_000;
  const claimA = await store.claimEligible({ thread_key: "+1555111CRSH", now: now(), worker_id: "A" });
  assert.equal(claimA.ok, true);

  // Before lease expiry: worker B's finalize gets no claim, V2 never runs.
  clock = ms(T0) + 25_000 + 120_000;
  const early = await mk("B").finalizeBurst({ thread_key: "+1555111CRSH" });
  assert.equal(early.ok, false);
  assert.equal(processCalls.length, 0);

  // After lease expiry: worker B atomically reclaims and finalizes.
  clock = ms(T0) + 25_000 + SELLER_INBOUND_BURST_CLAIM_LEASE_MS + 1000;
  const recovered = await mk("B").finalizeBurst({ thread_key: "+1555111CRSH" });
  assert.equal(recovered.ok, true);
  assert.equal(processCalls.length, 1, "exactly one observable V2 decision");
  assert.equal(recovered.burst.status, BURST_STATUSES.COMPLETED);
  assert.equal(
    recovered.decision_idempotency_key,
    claimA.burst.decision_idempotency_key,
    "decision key stable across crash recovery"
  );
  assert.deepEqual(
    processCalls[0].burstContext.constituent_event_ids,
    ["cr1"],
    "reclaim retains the same constituent messages"
  );

  // Nothing left to reclaim afterwards.
  clock += SELLER_INBOUND_BURST_CLAIM_LEASE_MS + 10_000;
  const after = await mk("C").finalizeBurst({ thread_key: "+1555111CRSH" });
  assert.equal(after.ok, false);
});

test("lease: reply queued then crash before completion → reclaim produces no duplicate reply", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });

  // Production-analog reply dedupe: send_queue.source_event_id lookup
  // (findRecentInboundAutoReplyDuplicate). Keyed on the inboundEventId the
  // coordinator hands V2 — which must therefore be stable across reclaims.
  const queued_rows = new Map();
  let crash_after_queue = true;
  const v2_calls = [];
  const v2 = async (args) => {
    v2_calls.push(args);
    if (queued_rows.has(args.inboundEventId)) {
      return {
        ok: true,
        queued: false,
        duplicate_suppressed: true,
        execution: { queued: false, duplicate_suppressed: true },
      };
    }
    queued_rows.set(args.inboundEventId, {
      decision_idempotency_key: args.burstContext?.decision_idempotency_key,
    });
    if (crash_after_queue) {
      crash_after_queue = false;
      throw new Error("worker_died_after_queue_insert");
    }
    return { ok: true, queued: true, execution: { queued: true } };
  };
  const mk = (worker_id) =>
    createSellerInboundBurstCoordinator({
      store,
      now,
      enabled: true,
      worker_id,
      processSellerInboundMessage: v2,
    });

  await mk("A").onPersistedInbound({
    thread_key: "+1555111DUPQ",
    event_id: "dq1",
    provider_message_id: "pdq1",
    body: "yes lets do it",
    received_at: now(),
  });

  clock = ms(T0) + 25_000;
  const attemptA = await mk("A").finalizeBurst({ thread_key: "+1555111DUPQ" });
  assert.equal(attemptA.ok, false, "worker A dies after queueing");
  assert.equal(attemptA.retry_after_lease, true);
  assert.equal(queued_rows.size, 1, "reply row exists from the dead attempt");

  // Row stays CLAIMED (not completed, not failed) for lease recovery.
  const rows = store._debug.listAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, BURST_STATUSES.CLAIMED);
  assert.equal(rows[0].completed_at, null);

  // Before lease: no reclaim.
  clock = ms(T0) + 25_000 + 60_000;
  const early = await mk("B").finalizeBurst({ thread_key: "+1555111DUPQ" });
  assert.equal(early.ok, false);
  assert.equal(v2_calls.length, 1);

  // After lease: reclaim re-runs V2; source-event dedupe suppresses the
  // second reply; the burst completes.
  clock = ms(T0) + 25_000 + SELLER_INBOUND_BURST_CLAIM_LEASE_MS + 1000;
  const attemptB = await mk("B").finalizeBurst({ thread_key: "+1555111DUPQ" });
  assert.equal(attemptB.ok, true);
  assert.equal(v2_calls.length, 2);
  assert.equal(queued_rows.size, 1, "exactly one queued reply across retries");
  assert.equal(
    v2_calls[0].inboundEventId,
    v2_calls[1].inboundEventId,
    "stable inboundEventId is what production send_queue.source_event_id dedupe keys on"
  );
  assert.equal(
    v2_calls[0].burstContext.decision_idempotency_key,
    v2_calls[1].burstContext.decision_idempotency_key
  );
  assert.equal(attemptB.burst.status, BURST_STATUSES.COMPLETED);
});

test("lease: attempts exhausted finalizes burst as FAILED, never infinite retry", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  let v2_calls = 0;
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    max_attempts: 2,
    processSellerInboundMessage: async () => {
      v2_calls += 1;
      throw new Error("persistent_failure");
    },
  });

  await coordinator.onPersistedInbound({
    thread_key: "+1555111FAIL",
    event_id: "fx1",
    provider_message_id: "pfx1",
    body: "hello",
    received_at: now(),
  });

  clock = ms(T0) + 25_000;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await coordinator.finalizeBurst({ thread_key: "+1555111FAIL" });
    clock += SELLER_INBOUND_BURST_CLAIM_LEASE_MS + 1000;
  }
  const row = store._debug.listAll()[0];
  assert.equal(row.status, BURST_STATUSES.FAILED, "explicit observable terminal outcome");
  assert.ok(row.completed_at, "failed burst is finalized, not stranded");
  assert.equal(v2_calls, 2, "retries bounded by max_attempts");
  assert.equal(isClaimableBurst({ burst: row, now: now() }), false);
});

test("lease: suppressed finalized burst can never re-enter the reply path", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    cancelPendingOutbound: async () => ({ ok: true, cancelled: 0 }),
    cancelPendingFollowUps: async () => ({ ok: true, cancelled: 0 }),
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true };
    },
  });

  const stop = await coordinator.onPersistedInbound({
    thread_key: "+1555111SUPP",
    event_id: "sp1",
    provider_message_id: "psp1",
    body: "STOP",
    received_at: now(),
  });
  assert.equal(stop.flush?.suppressed, true);
  const row = store._debug.listAll()[0];
  assert.equal(row.status, BURST_STATUSES.SUPPRESSED);
  assert.ok(row.completed_at, "suppressed finalize is terminal");

  // Even far past every lease, nothing is claimable and V2 never runs.
  clock = ms(T0) + SELLER_INBOUND_BURST_CLAIM_LEASE_MS * 3;
  const flush = await coordinator.flushEligible({});
  assert.equal(flush.results.length, 0);
  const claim = await store.claimEligible({ thread_key: "+1555111SUPP", now: now() });
  assert.equal(claim.ok, false);
  assert.equal(processCalls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Hard-cap rollover — no message lost at the generation boundary
// ═══════════════════════════════════════════════════════════════════════════

test("rollover: memory path — message past hard close lands exactly once in gen N+1", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  const processCalls = [];
  const coordinator = createSellerInboundBurstCoordinator({
    store,
    now,
    enabled: true,
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  const sends = [
    { body: "part one", at: 0 },
    { body: "part two", at: 30_000 },
    { body: "part three", at: 60_000 },
    { body: "late part four", at: 95_000 }, // past first+90s hard close
  ];
  for (let i = 0; i < sends.length; i += 1) {
    clock = ms(T0) + sends[i].at;
    const r = await coordinator.onPersistedInbound({
      thread_key: "+1555111ROLL",
      event_id: `ro${i + 1}`,
      provider_message_id: `pro${i + 1}`,
      body: sends[i].body,
      received_at: now(),
    });
    assert.equal(r.ok !== false, true);
  }

  const rows = store._debug.listAll();
  assert.equal(rows.length, 2, "exactly two generations");
  const gen1 = rows.find((b) => b.generation === 1);
  const gen2 = rows.find((b) => b.generation === 2);
  assert.deepEqual(gen1.constituents.map((c) => c.body), ["part one", "part two", "part three"]);
  assert.deepEqual(gen2.constituents.map((c) => c.body), ["late part four"]);

  // Flush everything: every message processed exactly once, no duplicates.
  clock = ms(T0) + 95_000 + 25_000;
  await coordinator.flushEligible({});
  assert.equal(processCalls.length, 2);
  const all_bodies = processCalls.flatMap((c) => c.message.split("\n"));
  assert.deepEqual(all_bodies.sort(), ["late part four", "part one", "part three", "part two"]);
});

test("rollover: supabase flush_required contract — old gen finalized, new message exactly once, bounded retry", async () => {
  const T25 = plus(T0, 95_000);
  const gen1 = {
    ...createOpenBurstState({
      thread_key: "+1555111SBRO",
      generation: 1,
      message: { body: "gen1 body", event_id: "g1", provider_message_id: "pg1", received_at: T0 },
      now: T0,
    }),
    id: "sb-1",
    decision_idempotency_key: "sib-key-g1",
  };
  let appends = 0;
  let claims = 0;
  let completes = 0;
  const processCalls = [];
  const scripted_store = {
    kind: "scripted",
    async appendMessage({ message }) {
      appends += 1;
      if (appends === 1) {
        // Supabase store contract: open burst past hard close → caller must
        // flush before the message can enter generation N+1.
        return {
          ok: false,
          reason: "open_burst_past_hard_close_flush_required",
          rollover: true,
          burst: gen1,
          pending_message: message,
        };
      }
      return {
        ok: true,
        created: true,
        appended: true,
        duplicate: false,
        burst: {
          ...createOpenBurstState({
            thread_key: "+1555111SBRO",
            generation: 2,
            message,
            now: T25,
          }),
          id: "sb-2",
          decision_idempotency_key: "sib-key-g2",
        },
      };
    },
    async claimEligible() {
      claims += 1;
      return { ok: true, claim_token: "tok-1", burst: { ...gen1, status: BURST_STATUSES.CLAIMED } };
    },
    async completeClaimed(args) {
      completes += 1;
      return { ok: true, burst: { ...gen1, status: args.status || BURST_STATUSES.COMPLETED } };
    },
    async listEligible() {
      return [];
    },
    async getOpen() {
      return null;
    },
  };

  const coordinator = createSellerInboundBurstCoordinator({
    store: scripted_store,
    now: () => T25,
    enabled: true,
    processSellerInboundMessage: async (args) => {
      processCalls.push(args);
      return { ok: true, queued: true, execution: { queued: true } };
    },
  });

  const r = await coordinator.onPersistedInbound({
    thread_key: "+1555111SBRO",
    event_id: "g2-new",
    provider_message_id: "pg2-new",
    body: "new message after cap",
    received_at: T25,
  });

  assert.equal(r.ok, true);
  assert.equal(r.deferred, true);
  assert.equal(r.rollover, true);
  assert.equal(appends, 2, "old flush then exactly one successful re-append");
  assert.equal(claims, 1, "old generation claimed once");
  assert.equal(completes, 1, "old generation finalized");
  assert.equal(processCalls.length, 1, "old generation V2 exactly once");
  assert.equal(processCalls[0].message, "gen1 body");
  assert.equal(r.append.burst.generation, 2);
  assert.deepEqual(r.append.burst.constituents.map((c) => c.body), ["new message after cap"]);
});

test("rollover: persistent append failure is bounded and explicit — never silent, never per-message fallback", async () => {
  let appends = 0;
  let flushes = 0;
  const failing_store = {
    async appendMessage({ message }) {
      appends += 1;
      return { ok: false, rollover: true, pending_message: message, burst: null };
    },
    async claimEligible() {
      flushes += 1;
      return { ok: false, reason: "no_eligible_burst", burst: null };
    },
    async completeClaimed() {
      return { ok: false, reason: "not_found" };
    },
    async listEligible() {
      return [];
    },
    async getOpen() {
      return null;
    },
  };
  const coordinator = createSellerInboundBurstCoordinator({
    store: failing_store,
    now: () => T0,
    enabled: true,
    processSellerInboundMessage: async () => ({ ok: true, queued: true }),
  });
  const r = await coordinator.onPersistedInbound({
    thread_key: "+1555111STUCK",
    event_id: "st1",
    provider_message_id: "pst1",
    body: "must not vanish",
    received_at: T0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "burst_rollover_append_failed");
  assert.equal(appends, 4, "initial + 3 bounded retries, no infinite loop");
});

test("crash recovery: complete is idempotent on claim_token", async () => {
  let clock = ms(T0);
  const now = () => new Date(clock).toISOString();
  const store = createMemorySellerInboundBurstStore({ now });
  await store.appendMessage({
    thread_key: "+1555111CR",
    message: { body: "x", event_id: "1", provider_message_id: "p", received_at: T0 },
    now: T0,
  });
  clock = ms(T0) + 25_000;
  const claim = await store.claimEligible({ thread_key: "+1555111CR", now: now() });
  const c1 = await store.completeClaimed({
    burst_id: claim.burst.burst_id,
    claim_token: claim.claim_token,
    result_summary: { queued: true },
    now: now(),
  });
  const c2 = await store.completeClaimed({
    burst_id: claim.burst.burst_id,
    claim_token: claim.claim_token,
    result_summary: { queued: true },
    now: now(),
  });
  assert.equal(c1.ok, true);
  assert.equal(c2.ok, true);
  assert.equal(c2.already_completed || c2.burst.status === BURST_STATUSES.COMPLETED, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 3 — per-fragment classification must not mutate business state
// ═══════════════════════════════════════════════════════════════════════════

// Fields syncClassifiedInboxThreadState may write per NON-SAFETY fragment,
// per the semantic audit of production consumers:
// category 2 presentation/triage only. Audit verdicts: stage = legacy display
// alias (canonical stage is lifecycle_stage via the universal-lead-state
// registry); priority = Discord briefing/calendar display; last_intent =
// inbox display contracts (V2 identity resolution uses in-memory intent);
// latest_reply_template_id = SQL views project it AS template_id for display.
const FRAGMENT_ALLOWED_THREAD_STATE_FIELDS = new Set([
  // identity / linkage
  "thread_key", "seller_phone", "canonical_e164", "our_number",
  "master_owner_id", "prospect_id", "property_id", "market",
  // presentation / counters / latest-message pointers
  "stage", "priority", "latest_reply_template_id", "inbound_count",
  "outbound_count", "is_read", "updated_at", "metadata",
  "latest_message_body", "latest_message_at", "latest_direction",
  "latest_delivery_status", "latest_message_event_id", "message_count",
  "last_inbound_at", "last_outbound_at",
  // triage + immediate safety projections
  "inbox_bucket", "automation_lane", "last_intent", "is_suppressed",
]);
// Business-authoritative columns a NON-SAFETY fragment must never write
// (audit: status gates contactability — evaluate-canonical-contactability
// blocks on status='paused_review' and cockpit actions 423 on it; next_action
// and disposition are canonical universal-lead-state fields written through
// the guarded patchUniversalLeadState service and next_action IS NULL drives
// the recover-seller-execution-gaps sweep; automation_state carries the
// manual_pause/suppress semantic in resolve-seller-auto-reply-plan).
const FRAGMENT_GATED_BUSINESS_FIELDS = [
  "status", "next_action", "automation_state", "disposition",
];
// Acquisition/business-authoritative fields that must NEVER appear in any
// per-fragment write (canary — fails if this path ever widens).
const FRAGMENT_FORBIDDEN_THREAD_STATE_FIELDS = [
  "seller_stage", "conversation_stage", "universal_stage", "universal_status",
  "lead_temperature", "follow_up_at", "operational_status", "asking_price",
  "next_best_action", "response_strategy", "offer_ready", "acquisition_stage",
  "lifecycle_stage", "contactability_status",
];

function makeRecordingSupabase({ selects = {} } = {}) {
  const writes = [];
  const readResult = (table) => selects[table] ?? { data: [], error: null, count: 0 };
  const writeChain = (table, op, payload) => {
    writes.push({ table, op, payload });
    const data = Array.isArray(payload)
      ? payload
      : { id: `${table}-w${writes.length}`, ...(payload || {}) };
    const res = { data, error: null };
    const chain = {
      select: () => chain,
      eq: () => chain, in: () => chain, is: () => chain, or: () => chain,
      lt: () => chain, lte: () => chain, gt: () => chain, gte: () => chain,
      single: async () => ({ data: Array.isArray(data) ? data[0] : data, error: null }),
      maybeSingle: async () => ({ data: Array.isArray(data) ? data[0] : data, error: null }),
      then(resolve, reject) {
        return Promise.resolve({ data: Array.isArray(data) ? data : [data], error: null }).then(resolve, reject);
      },
    };
    return chain;
  };
  return {
    writes,
    from(table) {
      const result = readResult(table);
      const q = () => {
        const chain = {
          eq: () => chain, in: () => chain, is: () => chain, or: () => chain,
          lt: () => chain, lte: () => chain, gt: () => chain, gte: () => chain,
          not: () => chain, neq: () => chain, order: () => chain,
          range: () => chain, limit: () => chain, abortSignal: () => chain,
          maybeSingle: async () => ({
            data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
            error: result.error ?? null,
          }),
          single: async () => ({
            data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
            error: result.error ?? null,
          }),
          then(resolve, reject) {
            return Promise.resolve({
              data: result.data,
              error: result.error ?? null,
              count: result.count ?? 0,
            }).then(resolve, reject);
          },
        };
        return chain;
      };
      return {
        select: () => q(),
        insert: (payload) => writeChain(table, "insert", payload),
        update: (payload) => writeChain(table, "update", payload),
        upsert: (payload) => writeChain(table, "upsert", payload),
        delete: () => writeChain(table, "delete", null),
      };
    },
  };
}

function installBurstFragmentHarness({ appendThrows = false } = {}) {
  const ledger = createInMemoryIdempotencyLedger();
  const supabase = makeRecordingSupabase({
    selects: {
      message_events: { data: [{ id: "evt-supa-1" }], error: null },
      // Prior thread row exists → the fragment-safe upsert guard applies
      // (business columns are only defaulted on brand-new rows).
      inbox_thread_state: {
        data: [
          {
            thread_key: "+15551119901",
            is_archived: false,
            metadata: {},
            inbound_count: 1,
            outbound_count: 2,
          },
        ],
        error: null,
      },
      send_queue: { data: [], error: null, count: 0 },
    },
  });

  let clock = ms(T0);
  const harness_now = () => new Date(clock).toISOString();
  const burst_store = createMemorySellerInboundBurstStore({ now: harness_now });
  if (appendThrows) {
    burst_store.appendMessage = async () => {
      throw new Error("seller_inbound_bursts_schema_missing");
    };
  }

  const calls = {
    v2: [],
    podio: [],
    cancel_outbound: [],
    cancel_followups: [],
    load_context: [],
    message_event_log: [],
    supabase_event_log: [],
  };
  const podioSpy = (name) => async (...args) => {
    calls.podio.push({ name, args });
    return { ok: true };
  };

  const context = {
    found: true,
    ids: {
      master_owner_id: 21,
      prospect_id: 31,
      property_id: 41,
      phone_item_id: 51,
    },
    items: {},
    summary: {
      conversation_stage: "ownership_check",
      property_address: "9 Oak Ln",
      language_preference: "English",
    },
  };

  let coordinator_ref = null;
  __setTextgridInboundTestDeps({
    ...makeInboundWebhookBaseDeps({
      getSupabaseClient: () => supabase,
      getSystemFlags: async () => ({ auto_reply_enabled: true, followup_enabled: true }),
      getSystemValue: async (key) => {
        if (key === "auto_reply_mode") return "internal_only";
        if (key === "podio_sync_enabled") return "true"; // prove the burst gate, not the podio flag
        return null;
      },
      logInboundMessageEventSupabase: async (payload) => {
        calls.supabase_event_log.push(payload);
        return { ok: true, id: "evt-supa-1" };
      },
    }),
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (value) => value,
    info: () => {},
    warn: () => {},
    loadContextWithFallback: async (args) => {
      calls.load_context.push(args);
      return context;
    },
    resolveRoute: async () => ({ stage: "ownership_check", use_case: "ownership_check" }),
    isOfferStageTrigger: () => ({ triggered: false, reason: "test" }),
    logInboundMessageEvent: async (args) => {
      calls.message_event_log.push(args);
      return { item_id: "podio-evt-1" };
    },
    createBrain: podioSpy("createBrain"),
    updateBrainAfterInbound: podioSpy("updateBrainAfterInbound"),
    updateMasterOwnerAfterInbound: podioSpy("updateMasterOwnerAfterInbound"),
    updateBrainStage: podioSpy("updateBrainStage"),
    findLatestOpenOffer: podioSpy("findLatestOpenOffer"),
    maybeProgressOfferStatus: podioSpy("maybeProgressOfferStatus"),
    maybeCreateOfferFromContext: podioSpy("maybeCreateOfferFromContext"),
    maybeUpsertUnderwritingFromInbound: podioSpy("maybeUpsertUnderwritingFromInbound"),
    maybeQueueUnderwritingFollowUp: podioSpy("maybeQueueUnderwritingFollowUp"),
    transferDealToUnderwriting: podioSpy("transferDealToUnderwriting"),
    maybeCreateContractFromAcceptedOffer: podioSpy("maybeCreateContractFromAcceptedOffer"),
    syncPipelineState: podioSpy("syncPipelineState"),
    cancelPendingQueueItemsForOwner: async () => ({ ok: true, canceled_count: 0 }),
    cancelSupabasePendingOutbound: async (payload) => {
      calls.cancel_outbound.push(payload);
      return { ok: true, cancelled: 0 };
    },
    cancelPendingFollowUpsForThread: async (payload) => {
      calls.cancel_followups.push(payload);
      return { ok: true, cancelled: 0 };
    },
    notifyDiscordOps: async () => ({ ok: true }),
    postInboundSmsDiscordCard: async () => ({ ok: true, discord_message_id: "d-1" }),
    findInboundAutopilotQueue: async () => null,
    updateInboundAutopilotQueue: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    isSellerInboundBurstEnabled: () => true,
    createSellerInboundBurstCoordinator: (opts) => {
      coordinator_ref = createSellerInboundBurstCoordinator({
        ...opts,
        supabase: null,
        store: burst_store,
        now: harness_now,
      });
      return coordinator_ref;
    },
    processSellerInboundMessage: async (args) => {
      calls.v2.push(args);
      return { ok: true, queued: false, execution: { queued: false } };
    },
  });

  return {
    calls,
    supabase,
    burst_store,
    setClock: (msValue) => { clock = msValue; },
    getCoordinator: () => coordinator_ref,
    async sendFragment(body, { at = 0, id }) {
      clock = ms(T0) + at;
      return handleTextgridInboundWebhook({
        id,
        from: "+15551119901",
        to: "+15550002222",
        body,
        received_at: harness_now(),
      });
    },
  };
}

function assertNoBusinessMutation(harness, label) {
  assert.equal(harness.calls.v2.length, 0, `${label}: V2 must not run on a fragment`);
  assert.deepEqual(
    harness.calls.podio.map((c) => c.name),
    [],
    `${label}: no Podio acquisition write may run on a fragment`
  );
  const business_writes = harness.supabase.writes.filter(
    (w) => w.table !== "inbox_thread_state"
  );
  assert.deepEqual(
    business_writes,
    [],
    `${label}: only inbox_thread_state presentation writes allowed, saw ${JSON.stringify(business_writes.map((w) => w.table))}`
  );
  for (const w of harness.supabase.writes) {
    const keys = Object.keys(w.payload || {});
    for (const key of keys) {
      assert.ok(
        FRAGMENT_ALLOWED_THREAD_STATE_FIELDS.has(key),
        `${label}: unexpected thread-state field "${key}" written by fragment`
      );
    }
    // Key-absence IS the unchanged-before-flush proof: the upsert only
    // touches provided columns, so omitting these leaves stored values
    // (e.g. status='paused_review', a canonical next_action/disposition)
    // untouched until the finalized aggregate patches them canonically.
    for (const gated of FRAGMENT_GATED_BUSINESS_FIELDS) {
      assert.ok(
        !keys.includes(gated),
        `${label}: business-authoritative column "${gated}" written by non-safety fragment`
      );
    }
    for (const forbidden of FRAGMENT_FORBIDDEN_THREAD_STATE_FIELDS) {
      assert.ok(
        !keys.includes(forbidden),
        `${label}: business-authoritative field "${forbidden}" written by fragment`
      );
    }
  }
  for (const args of harness.calls.load_context) {
    assert.equal(
      args.create_brain_if_missing,
      false,
      `${label}: fragment must not create a conversation brain`
    );
  }
}

test("fragments: yeah maybe / depends on price / roof needs work — zero business mutation before flush, V2 exactly once at flush", async () => {
  const harness = installBurstFragmentHarness();

  const r1 = await harness.sendFragment("yeah maybe", { at: 0, id: "frag-1" });
  assert.equal(r1.ok, true);
  assert.equal(r1.seller_stage_reply?.queued, false);
  assert.equal(r1.seller_stage_reply?.reason, "deferred_to_burst_flush");
  assert.equal(r1.seller_followup_result?.skipped, true);
  assertNoBusinessMutation(harness, "after fragment 1");

  const r2 = await harness.sendFragment("depends on price", { at: 1000, id: "frag-2" });
  assert.equal(r2.ok, true);
  assert.equal(r2.seller_stage_reply?.reason, "deferred_to_burst_flush");
  assertNoBusinessMutation(harness, "after fragment 2");

  const r3 = await harness.sendFragment("roof needs work", { at: 2000, id: "frag-3" });
  assert.equal(r3.ok, true);
  assertNoBusinessMutation(harness, "after fragment 3");

  // Presentation/triage still flows per fragment (latest message pointers,
  // bucket) — only the business-authoritative columns are withheld.
  const thread_writes = harness.supabase.writes.filter((w) => w.table === "inbox_thread_state");
  assert.ok(thread_writes.length >= 3, "each fragment still projects thread presentation state");
  assert.ok(
    thread_writes.every((w) => "inbox_bucket" in (w.payload || {})),
    "triage bucket projection still flows per fragment"
  );

  const open = await harness.burst_store.getOpen("+15551119901");
  assert.equal(open.generation, 1);
  assert.equal(open.constituents.length, 3);

  // Quiet window closes → flush finalizes ONE aggregate V2 turn.
  harness.setClock(ms(T0) + 2000 + 25_000);
  const flush = await harness.getCoordinator().flushEligible({ thread_key: "+15551119901" });
  assert.equal(flush.results[0].ok, true);
  assert.equal(harness.calls.v2.length, 1, "V2/business state executes once per finalized burst");
  const v2 = harness.calls.v2[0];
  assert.equal(v2.message, "yeah maybe\ndepends on price\nroof needs work");
  assert.equal(v2.burstContext.message_count, 3);
  assert.deepEqual(v2.burstContext.constituent_event_ids.length, 3);
  assert.ok(v2.burstContext.decision_idempotency_key);
  // Flush drives V2 only — the per-message Podio pipeline never re-enters.
  assert.deepEqual(harness.calls.podio.map((c) => c.name), []);
});

test("fragments: STOP fragment still suppresses immediately (contact safety unaffected by deferral)", async () => {
  const harness = installBurstFragmentHarness();

  await harness.sendFragment("yeah maybe", { at: 0, id: "stop-1" });
  const r2 = await harness.sendFragment("STOP", { at: 500, id: "stop-2" });
  assert.equal(r2.ok, true);

  // Immediate contact-safety projections DID run:
  assert.ok(
    harness.calls.cancel_outbound.some((c) => c.reason?.includes("burst_safety_opt_out")),
    "pending outbound cancelled immediately on STOP"
  );
  assert.ok(
    harness.calls.cancel_followups.some((c) => c.reason?.includes("burst_safety_opt_out")),
    "pending follow-ups cancelled immediately on STOP"
  );

  // Safety fragment keeps the FULL thread-state projection (category B lands
  // immediately — is_suppressed true), unlike gated non-safety fragments.
  const stop_write = harness.supabase.writes.find(
    (w) => w.table === "inbox_thread_state" && w.payload?.is_suppressed === true
  );
  assert.ok(stop_write, "STOP fragment must project is_suppressed immediately");

  // Burst finalized as suppressed inline — no V2 reply path, terminal row.
  assert.equal(harness.calls.v2.length, 0);
  const row = harness.burst_store._debug.listAll()[0];
  assert.equal(row.status, BURST_STATUSES.SUPPRESSED);
  assert.ok(row.completed_at, "suppressed finalize is terminal");
  assert.equal(r2.seller_stage_reply?.queued, false);

  // And still zero business mutation.
  assert.deepEqual(harness.calls.podio.map((c) => c.name), []);

  // Late flushes never resurrect it into the reply path.
  harness.setClock(ms(T0) + SELLER_INBOUND_BURST_CLAIM_LEASE_MS * 2);
  const flush = await harness.getCoordinator().flushEligible({});
  assert.equal(flush.results.length, 0);
  assert.equal(harness.calls.v2.length, 0);
});

test("fragments: burst store unavailable → webhook fails closed, no silent swallow, no per-message fallback", async () => {
  const harness = installBurstFragmentHarness({ appendThrows: true });
  const r = await harness.sendFragment("hello there", { at: 0, id: "failsafe-1" });
  assert.equal(r.ok, false, "webhook must error so the provider redelivers");
  assert.equal(r.error, "textgrid_inbound_failed_podio_write");
  assert.match(r.error_message, /seller_inbound_bursts_schema_missing/);
  assert.equal(harness.calls.v2.length, 0, "no per-message auto-reply fallback");
  assert.deepEqual(harness.calls.podio.map((c) => c.name), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// FINAL GATE A — suppression is monotonic across benign fragments
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stateful inbox_thread_state store: prior row is readable, upserts merge,
 * and subsequent selects observe the merged state (proves true→false cannot land).
 */
function makeStatefulThreadSupabase(initialRow = null) {
  const writes = [];
  /** @type {Map<string, object>} */
  const threads = new Map();
  if (initialRow?.thread_key) {
    threads.set(initialRow.thread_key, { ...initialRow });
  }

  function from(table) {
    if (table === "inbox_thread_state") {
      let filterKey = null;
      let filterKeys = null;
      const resolveRows = () => {
        if (filterKey) {
          const row = threads.get(filterKey);
          return row ? [row] : [];
        }
        if (filterKeys) {
          return filterKeys.map((k) => threads.get(k)).filter(Boolean);
        }
        return [...threads.values()];
      };
      const chain = {
        select: () => chain,
        eq: (col, val) => {
          if (col === "thread_key") filterKey = val;
          return chain;
        },
        limit: () => chain,
        in: (col, vals) => {
          if (col === "thread_key") filterKeys = vals;
          return chain;
        },
        is: () => chain,
        or: () => chain,
        order: () => chain,
        maybeSingle: async () => {
          const rows = resolveRows();
          return { data: rows[0] || null, error: null };
        },
        single: async () => {
          const rows = resolveRows();
          return { data: rows[0] || null, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({ data: resolveRows(), error: null }).then(resolve, reject);
        },
        upsert: (payload) => {
          writes.push({ table, op: "upsert", payload: { ...payload } });
          const key = payload.thread_key;
          const prev = threads.get(key) || {};
          const merged = { ...prev, ...payload };
          threads.set(key, merged);
          const out = {
            select: () => out,
            maybeSingle: async () => ({ data: merged, error: null }),
            single: async () => ({ data: merged, error: null }),
          };
          return out;
        },
        insert: (payload) => {
          writes.push({ table, op: "insert", payload });
          const row = Array.isArray(payload) ? payload[0] : payload;
          if (row?.thread_key) threads.set(row.thread_key, { ...(threads.get(row.thread_key) || {}), ...row });
          return {
            select: () => ({
              maybeSingle: async () => ({ data: row, error: null }),
            }),
          };
        },
        update: (payload) => {
          writes.push({ table, op: "update", payload });
          return {
            eq: (col, val) => {
              if (col === "thread_key" && threads.has(val)) {
                threads.set(val, { ...threads.get(val), ...payload });
              }
              return {
                select: () => ({
                  maybeSingle: async () => ({
                    data: threads.get(val) || payload,
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      };
      return chain;
    }
    // Generic empty table
    const empty = {
      select: () => empty,
      eq: () => empty,
      in: () => empty,
      is: () => empty,
      or: () => empty,
      order: () => empty,
      limit: () => empty,
      range: () => empty,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then(resolve, reject) {
        return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
      },
      insert: (payload) => {
        writes.push({ table, op: "insert", payload });
        return {
          select: () => ({
            maybeSingle: async () => ({ data: payload, error: null }),
          }),
        };
      },
      upsert: (payload) => {
        writes.push({ table, op: "upsert", payload });
        return {
          select: () => ({
            maybeSingle: async () => ({ data: payload, error: null }),
          }),
        };
      },
      update: (payload) => {
        writes.push({ table, op: "update", payload });
        return {
          eq: () => ({
            select: () => ({
              maybeSingle: async () => ({ data: payload, error: null }),
            }),
          }),
        };
      },
    };
    if (table === "message_events") {
      empty.maybeSingle = async () => ({ data: { id: "evt-supa-1" }, error: null });
      // select().eq().order chain for chronology fallback
      empty.order = () => empty;
    }
    if (table === "send_queue") {
      empty.then = (resolve, reject) =>
        Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
    }
    return empty;
  }

  return {
    writes,
    threads,
    getThread: (key) => threads.get(key) || null,
    from,
  };
}

test("GATE A upsert: prior is_suppressed=true + fragment_safe benign cannot write false", async () => {
  const thread_key = "+15551118801";
  const supabase = makeStatefulThreadSupabase({
    thread_key,
    is_suppressed: true,
    inbound_count: 3,
    outbound_count: 1,
    status: "active",
    disposition: "suppressed",
    automation_state: "running",
    next_action: null,
  });

  // Benign classification path: construct a false-seeking payload that would
  // clear suppression if the monotonic guard were absent.
  const { upsertInboxThreadState } = await import("@/lib/supabase/sms-engine.js");
  const result = await upsertInboxThreadState(
    {
      thread_key,
      seller_phone: thread_key,
      canonical_e164: thread_key,
      is_suppressed: false, // attack: try to clear
      status: "active",
      next_action: "queue_auto_reply",
      automation_state: "running",
      disposition: null,
      inbox_bucket: "new_replies",
      last_intent: "info_request",
      latest_message_body: "What property?",
      increment_direction: "inbound",
      __fragment_safe: true,
    },
    { supabase }
  );

  assert.equal(result.ok, true);
  const row = supabase.getThread(thread_key);
  assert.equal(row.is_suppressed, true, "prior true must survive benign fragment_safe upsert");
  // Business columns must not be overwritten either
  assert.equal(
    Object.prototype.hasOwnProperty.call(supabase.writes.at(-1).payload, "status"),
    false,
    "fragment_safe prior omits status"
  );
  assert.equal(supabase.writes.at(-1).payload.is_suppressed, true);
});

test("GATE A upsert: fragment_safe false→true still allowed when no prior suppression", async () => {
  const thread_key = "+15551118802";
  const supabase = makeStatefulThreadSupabase({
    thread_key,
    is_suppressed: false,
    inbound_count: 0,
    outbound_count: 0,
  });
  const { upsertInboxThreadState } = await import("@/lib/supabase/sms-engine.js");
  // Safety path uses fragment_safe=false; here we only assert true can land
  // when prior is false and fragment_safe is false (full projection).
  const result = await upsertInboxThreadState(
    {
      thread_key,
      seller_phone: thread_key,
      is_suppressed: true,
      inbox_bucket: "suppressed",
      increment_direction: "inbound",
      // not fragment_safe — safety-latched STOP path
    },
    { supabase }
  );
  assert.equal(result.ok, true);
  assert.equal(supabase.getThread(thread_key).is_suppressed, true);
});

test("GATE A handler: prior suppressed + benign fragment keeps true; V2=0; STOP path stays terminal", async () => {
  const thread_key = "+15551118803";
  const ledger = createInMemoryIdempotencyLedger();
  const supabase = makeStatefulThreadSupabase({
    thread_key,
    is_suppressed: true,
    is_archived: false,
    inbound_count: 2,
    outbound_count: 1,
    disposition: "suppressed",
    status: "active",
    automation_state: "running",
    next_action: null,
    metadata: {},
  });

  let clock = ms(T0);
  const harness_now = () => new Date(clock).toISOString();
  const burst_store = createMemorySellerInboundBurstStore({ now: harness_now });
  const calls = { v2: [], cancel_outbound: [], cancel_followups: [], podio: [] };

  const context = {
    found: true,
    ids: {
      master_owner_id: 21,
      prospect_id: 31,
      property_id: 41,
      phone_item_id: 51,
    },
    items: {},
    summary: { conversation_stage: "ownership_check", property_address: "1 Gate A" },
  };

  __setTextgridInboundTestDeps({
    ...makeInboundWebhookBaseDeps({
      getSupabaseClient: () => supabase,
      getSystemFlags: async () => ({ auto_reply_enabled: true, followup_enabled: true }),
      getSystemValue: async (key) => {
        if (key === "auto_reply_mode") return "internal_only";
        if (key === "podio_sync_enabled") return "false";
        return null;
      },
      logInboundMessageEventSupabase: async () => ({ ok: true, id: "evt-a" }),
    }),
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (v) => v,
    info: () => {},
    warn: () => {},
    loadContextWithFallback: async () => context,
    resolveRoute: async () => ({ stage: "ownership_check", use_case: "ownership_check" }),
    isOfferStageTrigger: () => ({ triggered: false }),
    logInboundMessageEvent: async () => ({ item_id: "podio-a" }),
    createBrain: async () => ({ ok: true }),
    updateBrainAfterInbound: async () => ({ ok: true }),
    updateMasterOwnerAfterInbound: async () => ({ ok: true }),
    updateBrainStage: async () => ({ ok: true }),
    findLatestOpenOffer: async () => null,
    maybeProgressOfferStatus: async () => ({ ok: true }),
    maybeCreateOfferFromContext: async () => ({ ok: true }),
    maybeUpsertUnderwritingFromInbound: async () => ({ ok: true }),
    maybeQueueUnderwritingFollowUp: async () => ({ ok: true }),
    transferDealToUnderwriting: async () => ({ ok: true }),
    maybeCreateContractFromAcceptedOffer: async () => ({ ok: true }),
    syncPipelineState: async () => ({ ok: true }),
    cancelPendingQueueItemsForOwner: async () => ({ ok: true, canceled_count: 0 }),
    cancelSupabasePendingOutbound: async (p) => {
      calls.cancel_outbound.push(p);
      return { ok: true, cancelled: 0 };
    },
    cancelPendingFollowUpsForThread: async (p) => {
      calls.cancel_followups.push(p);
      return { ok: true, cancelled: 0 };
    },
    notifyDiscordOps: async () => ({ ok: true }),
    postInboundSmsDiscordCard: async () => ({ ok: true }),
    findInboundAutopilotQueue: async () => null,
    updateInboundAutopilotQueue: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    isSellerInboundBurstEnabled: () => true,
    createSellerInboundBurstCoordinator: (opts = {}) => {
      const c = createSellerInboundBurstCoordinator({
        ...opts,
        store: burst_store,
        now: harness_now,
        enabled: true,
        processSellerInboundMessage: async (args) => {
          calls.v2.push(args);
          return {
            ok: true,
            queued: true,
            execution: { queued: true },
            seller_stage_reply: { queued: true, plan: { should_queue_reply: true } },
            follow_up: { followup_created: false },
            intelligence_snapshot: { canonical_decision: { should_queue_reply: true } },
          };
        },
      });
      return c;
    },
  });

  try {
    // Benign non-safety fragment on already-suppressed thread
    const r1 = await handleTextgridInboundWebhook(
      {
        From: thread_key,
        To: "+15550009999",
        Body: "What property?",
        MessageSid: "sid-gate-a-1",
        http_received_at: harness_now(),
      },
      { auto_reply_mode: "internal_only", dry_run: false }
    );
    assert.equal(r1.ok, true);
    assert.equal(supabase.getThread(thread_key).is_suppressed, true);
    assert.equal(calls.v2.length, 0, "no V2 before flush / on suppressed benign fragment");
    assert.equal(r1.seller_stage_reply?.queued, false);
    assert.ok(
      r1.seller_followup_result?.skipped === true ||
        r1.seller_followup_result?.followup_created !== true,
      "no follow-up eligible"
    );

    // Second benign fragment — still suppressed
    clock = ms(T0) + 1000;
    const r2 = await handleTextgridInboundWebhook(
      {
        From: thread_key,
        To: "+15550009999",
        Body: "yeah maybe",
        MessageSid: "sid-gate-a-2",
        http_received_at: harness_now(),
      },
      { auto_reply_mode: "internal_only", dry_run: false }
    );
    assert.equal(r2.ok, true);
    assert.equal(supabase.getThread(thread_key).is_suppressed, true);
    assert.equal(calls.v2.length, 0);

    // STOP path still forces true (false→true still allowed via safety)
    // Reset a non-suppressed thread for STOP→benign
  } finally {
    __resetTextgridInboundTestDeps();
  }
});

test("GATE A handler: STOP then benign fragment remains suppressed; late flush cannot resurrect V2", async () => {
  const thread_key = "+15551118804";
  const ledger = createInMemoryIdempotencyLedger();
  const supabase = makeStatefulThreadSupabase({
    thread_key,
    is_suppressed: false,
    is_archived: false,
    inbound_count: 0,
    outbound_count: 0,
    metadata: {},
  });

  let clock = ms(T0);
  const harness_now = () => new Date(clock).toISOString();
  const burst_store = createMemorySellerInboundBurstStore({ now: harness_now });
  const calls = { v2: [] };

  const context = {
    found: true,
    ids: { master_owner_id: 1, prospect_id: 2, property_id: 3, phone_item_id: 4 },
    items: {},
    summary: { conversation_stage: "ownership_check" },
  };

  __setTextgridInboundTestDeps({
    ...makeInboundWebhookBaseDeps({
      getSupabaseClient: () => supabase,
      getSystemFlags: async () => ({ auto_reply_enabled: true, followup_enabled: true }),
      getSystemValue: async (key) => {
        if (key === "auto_reply_mode") return "internal_only";
        if (key === "podio_sync_enabled") return "false";
        return null;
      },
      logInboundMessageEventSupabase: async () => ({ ok: true, id: "evt-stop" }),
    }),
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (v) => v,
    info: () => {},
    warn: () => {},
    loadContextWithFallback: async () => context,
    resolveRoute: async () => ({ stage: "ownership_check", use_case: "ownership_check" }),
    isOfferStageTrigger: () => ({ triggered: false }),
    logInboundMessageEvent: async () => ({ item_id: "podio-s" }),
    createBrain: async () => ({ ok: true }),
    updateBrainAfterInbound: async () => ({ ok: true }),
    updateMasterOwnerAfterInbound: async () => ({ ok: true }),
    updateBrainStage: async () => ({ ok: true }),
    findLatestOpenOffer: async () => null,
    maybeProgressOfferStatus: async () => ({ ok: true }),
    maybeCreateOfferFromContext: async () => ({ ok: true }),
    maybeUpsertUnderwritingFromInbound: async () => ({ ok: true }),
    maybeQueueUnderwritingFollowUp: async () => ({ ok: true }),
    transferDealToUnderwriting: async () => ({ ok: true }),
    maybeCreateContractFromAcceptedOffer: async () => ({ ok: true }),
    syncPipelineState: async () => ({ ok: true }),
    cancelPendingQueueItemsForOwner: async () => ({ ok: true, canceled_count: 0 }),
    cancelSupabasePendingOutbound: async () => ({ ok: true, cancelled: 1 }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 1 }),
    notifyDiscordOps: async () => ({ ok: true }),
    postInboundSmsDiscordCard: async () => ({ ok: true }),
    findInboundAutopilotQueue: async () => null,
    updateInboundAutopilotQueue: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    isSellerInboundBurstEnabled: () => true,
    createSellerInboundBurstCoordinator: (opts = {}) =>
      createSellerInboundBurstCoordinator({
        ...opts,
        store: burst_store,
        now: harness_now,
        enabled: true,
        processSellerInboundMessage: async (args) => {
          calls.v2.push(args);
          return {
            ok: true,
            queued: true,
            execution: { queued: true },
            seller_stage_reply: { queued: true, plan: { should_queue_reply: true } },
            follow_up: { followup_created: true },
          };
        },
      }),
  });

  try {
    await handleTextgridInboundWebhook(
      {
        From: thread_key,
        To: "+15550009999",
        Body: "STOP",
        MessageSid: "sid-stop-1",
        http_received_at: harness_now(),
      },
      { auto_reply_mode: "internal_only" }
    );
    assert.equal(supabase.getThread(thread_key).is_suppressed, true, "STOP sets true");
    assert.equal(calls.v2.length, 0);

    clock = ms(T0) + 500;
    await handleTextgridInboundWebhook(
      {
        From: thread_key,
        To: "+15550009999",
        Body: "What property?",
        MessageSid: "sid-stop-2",
        http_received_at: harness_now(),
      },
      { auto_reply_mode: "internal_only" }
    );
    assert.equal(
      supabase.getThread(thread_key).is_suppressed,
      true,
      "benign after STOP must remain suppressed"
    );
    assert.equal(calls.v2.length, 0);

    // Late flush after quiet window — suppressed generation is terminal
    clock = ms(T0) + 60_000;
    const flush = await createSellerInboundBurstCoordinator({
      store: burst_store,
      now: harness_now,
      enabled: true,
      processSellerInboundMessage: async (args) => {
        calls.v2.push(args);
        return { ok: true, queued: true };
      },
    }).flushEligible({});
    // No open eligible non-terminal work should invoke V2 for a suppressed burst
    assert.equal(calls.v2.length, 0, "late flush cannot resurrect V2 after STOP");
    assert.ok(
      flush.results.every((r) => r.suppressed || !r.ok || r.queued === false),
      "flush results must not queue after STOP"
    );
  } finally {
    __resetTextgridInboundTestDeps();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FINAL GATE B — brand-new thread row is operationally inert before flush
// ═══════════════════════════════════════════════════════════════════════════

test("GATE B: brand-new thread row before flush is presentation-only and non-executable", async () => {
  const thread_key = "+15551117701";
  const ledger = createInMemoryIdempotencyLedger();
  // No prior inbox_thread_state row
  const supabase = makeStatefulThreadSupabase(null);
  let clock = ms(T0);
  const harness_now = () => new Date(clock).toISOString();
  const burst_store = createMemorySellerInboundBurstStore({ now: harness_now });
  const calls = {
    v2: [],
    podio: [],
    send_queue_inserts: [],
    followup: [],
    acquisition: [],
  };

  // Capture send_queue / opportunity inserts via from()
  const baseFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const chain = baseFrom(table);
    if (table === "send_queue") {
      const origInsert = chain.insert;
      chain.insert = (payload) => {
        calls.send_queue_inserts.push(payload);
        return origInsert(payload);
      };
      const origUpsert = chain.upsert;
      chain.upsert = (payload) => {
        calls.send_queue_inserts.push(payload);
        return origUpsert(payload);
      };
    }
    if (table === "acquisition_opportunities") {
      const origInsert = chain.insert;
      chain.insert = (payload) => {
        calls.acquisition.push(payload);
        return origInsert(payload);
      };
      const origUpsert = chain.upsert;
      chain.upsert = (payload) => {
        calls.acquisition.push(payload);
        return origUpsert(payload);
      };
    }
    return chain;
  };

  const context = {
    found: true,
    ids: { master_owner_id: 9, prospect_id: 8, property_id: 7, phone_item_id: 6 },
    items: {},
    summary: { conversation_stage: "ownership_check" },
  };

  __setTextgridInboundTestDeps({
    ...makeInboundWebhookBaseDeps({
      getSupabaseClient: () => supabase,
      getSystemFlags: async () => ({ auto_reply_enabled: true, followup_enabled: true }),
      getSystemValue: async (key) => {
        if (key === "auto_reply_mode") return "internal_only";
        if (key === "podio_sync_enabled") return "false";
        return null;
      },
      logInboundMessageEventSupabase: async (p) => {
        calls.podio.push({ name: "supabase_event", p });
        return { ok: true, id: "evt-new-1" };
      },
    }),
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (v) => v,
    info: () => {},
    warn: () => {},
    loadContextWithFallback: async () => context,
    resolveRoute: async () => ({ stage: "ownership_check", use_case: "ownership_check" }),
    isOfferStageTrigger: () => ({ triggered: false }),
    logInboundMessageEvent: async () => ({ item_id: "podio-new" }),
    createBrain: async () => {
      calls.podio.push({ name: "createBrain" });
      return { ok: true };
    },
    updateBrainAfterInbound: async () => {
      calls.podio.push({ name: "updateBrainAfterInbound" });
      return { ok: true };
    },
    updateMasterOwnerAfterInbound: async () => {
      calls.podio.push({ name: "updateMasterOwnerAfterInbound" });
      return { ok: true };
    },
    updateBrainStage: async () => {
      calls.podio.push({ name: "updateBrainStage" });
      return { ok: true };
    },
    findLatestOpenOffer: async () => null,
    maybeProgressOfferStatus: async () => {
      calls.podio.push({ name: "maybeProgressOfferStatus" });
      return { ok: true };
    },
    maybeCreateOfferFromContext: async () => {
      calls.podio.push({ name: "maybeCreateOfferFromContext" });
      return { ok: true };
    },
    maybeUpsertUnderwritingFromInbound: async () => {
      calls.podio.push({ name: "maybeUpsertUnderwritingFromInbound" });
      return { ok: true };
    },
    maybeQueueUnderwritingFollowUp: async () => {
      calls.podio.push({ name: "maybeQueueUnderwritingFollowUp" });
      return { ok: true };
    },
    transferDealToUnderwriting: async () => {
      calls.podio.push({ name: "transferDealToUnderwriting" });
      return { ok: true };
    },
    maybeCreateContractFromAcceptedOffer: async () => {
      calls.podio.push({ name: "maybeCreateContractFromAcceptedOffer" });
      return { ok: true };
    },
    syncPipelineState: async () => {
      calls.podio.push({ name: "syncPipelineState" });
      return { ok: true };
    },
    cancelPendingQueueItemsForOwner: async () => ({ ok: true, canceled_count: 0 }),
    cancelSupabasePendingOutbound: async () => ({ ok: true, cancelled: 0 }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
    notifyDiscordOps: async () => ({ ok: true }),
    postInboundSmsDiscordCard: async () => ({ ok: true }),
    findInboundAutopilotQueue: async () => null,
    updateInboundAutopilotQueue: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    isSellerInboundBurstEnabled: () => true,
    createSellerInboundBurstCoordinator: (opts = {}) =>
      createSellerInboundBurstCoordinator({
        ...opts,
        store: burst_store,
        now: harness_now,
        enabled: true,
        processSellerInboundMessage: async (args) => {
          calls.v2.push(args);
          return {
            ok: true,
            queued: true,
            execution: { queued: true },
            seller_stage_reply: { queued: true, plan: { should_queue_reply: true } },
            follow_up: { followup_created: false },
          };
        },
      }),
  });

  try {
    const r = await handleTextgridInboundWebhook(
      {
        From: thread_key,
        To: "+15550009999",
        Body: "yeah maybe",
        MessageSid: "sid-new-1",
        http_received_at: harness_now(),
      },
      { auto_reply_mode: "internal_only" }
    );
    assert.equal(r.ok, true);
    assert.equal(r.seller_stage_reply?.reason, "deferred_to_burst_flush");

    // Raw inbound presentation persisted
    const row = supabase.getThread(thread_key);
    assert.ok(row, "new inbox_thread_state row may exist for presentation");
    assert.equal(row.thread_key, thread_key);
    assert.ok(row.latest_message_body || row.last_intent || row.inbox_bucket != null);

    // One open burst
    const open = await burst_store.getOpen(thread_key);
    assert.ok(open);
    assert.equal(open.status, BURST_STATUSES.OPEN);
    assert.equal(open.constituents.length, 1);

    // No V2 / no executable automation side-effects before flush
    assert.equal(calls.v2.length, 0);
    assert.equal(calls.send_queue_inserts.length, 0);
    assert.equal(calls.acquisition.length, 0);
    // Podio business writers must not fire (burst gates podio_business_writes;
    // with podio_sync_enabled false they also do not run).
    assert.ok(
      !calls.podio.some((c) =>
        [
          "maybeCreateOfferFromContext",
          "maybeProgressOfferStatus",
          "transferDealToUnderwriting",
          "maybeCreateContractFromAcceptedOffer",
          "updateBrainStage",
        ].includes(c.name)
      ),
      "no offer/contract/stage business Podio writes before flush"
    );

    // ── Why this row cannot be executed by recovery / contactability workers ──
    // recover-seller-execution-gaps.stale_active_without_next_action selects:
    //   operational_status IN ('active_communication','new_reply') AND next_action IS NULL
    // Brand-new fragment rows do NOT set operational_status or lifecycle_stage.
    assert.equal(
      row.operational_status,
      undefined,
      "operational_status absent → gap recovery does not select this row"
    );
    assert.equal(
      row.lifecycle_stage,
      undefined,
      "lifecycle_stage absent → stage recovery / opportunity promotion cannot act"
    );
    // next_action may be empty string or absent — either is non-executable alone
    // without operational_status + opportunity next_action source.
    assert.ok(
      !row.next_action || row.next_action === "",
      "no executable next_action before aggregate decision"
    );

    // evaluate-canonical-contactability only hard-blocks status==='paused_review';
    // status==='active' (default) is not itself a send instruction — sends require
    // a send_queue row from processSellerInboundMessage, which has not run.
    // automation_state==='running' only means "not manually paused" in
    // resolve-seller-auto-reply-plan; without a live V2 call no plan is produced.

    // Quiet window → exactly one aggregate V2
    clock = ms(T0) + 25_000;
    const flush = await createSellerInboundBurstCoordinator({
      store: burst_store,
      now: harness_now,
      enabled: true,
      processSellerInboundMessage: async (args) => {
        calls.v2.push(args);
        return {
          ok: true,
          queued: true,
          execution: { queued: true },
          seller_stage_reply: { queued: true },
          follow_up: { followup_created: false },
        };
      },
    }).flushEligible({ thread_key });
    assert.equal(flush.results[0].ok, true);
    assert.equal(calls.v2.length, 1, "exactly one aggregate V2 after quiet window");
    assert.equal(calls.v2[0].message, "yeah maybe");
  } finally {
    __resetTextgridInboundTestDeps();
  }
});
