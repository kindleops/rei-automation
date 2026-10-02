/**
 * ONE MONEY PATH — parity across every entry point (RC 7.2 release blocker B).
 *
 * Before: five parsers decided prices on their own and disagreed. "65" was
 * asking_price_provided @0.88 with auto-reply allowed in the classifier while
 * the orchestrator called it ambiguous; "sixty five thousand" was $65,000 in
 * the orchestrator and unparsed in the classifier; "sure, give me a million
 * 😂" scored "Named a price $1,000,000" in Deal Intelligence; a bare "250"
 * after a square-feet question was a price candidate everywhere.
 *
 * Now every entry point delegates to seller-flow/canonical-asking-price.js
 * (monetary understanding + factual commitment). This file runs the owner's
 * cases through ALL of them and requires one answer:
 *
 *   orchestrator slot (end to end)   process-seller-inbound-message.js
 *   canonical resolver / burst       canonical-asking-price.js
 *   classifier                       classify.js (price_parse + intent)
 *   stage engines                    stage 2 / stage 3 / stage 5
 *   underwriting signals             extract-underwriting-signals.js
 *   deal intelligence read model     conversation-signal.js
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalAskingPriceDecision,
  resolveCanonicalAskingPrice,
  resolveCanonicalBurstAskingPrice,
} from "@/lib/domain/seller-flow/canonical-asking-price.js";
import { describeLastQuestion } from "@/lib/domain/classification/last-question.js";
import { classify } from "@/lib/domain/classification/classify.js";
import {
  extractAskingPrice,
  classifyStage2OfferInterest,
  STAGE2_OUTCOMES,
} from "@/lib/domain/seller-flow/stage2-offer-interest-engine.js";
import { classifyStage3AskingPrice } from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { extractCounterOffer } from "@/lib/domain/seller-flow/stage5-offer-negotiation-engine.js";
import { extractUnderwritingSignals } from "@/lib/domain/underwriting/extract-underwriting-signals.js";
import { extractPrices, analyzeConversation } from "@/lib/domain/deal-intelligence/conversation-signal.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";

const ASK_Q = "Do you have an asking price in mind for the property?";
const K_Q = "Would you take $240k?";
const SQFT_Q = "How many square feet is the house?";

// [message, the question we asked, the one answer every entry point must give]
const CASES = [
  ["sure, give me a million 😂", ASK_Q, null],
  ["65", ASK_Q, null],
  ["65k", ASK_Q, 65_000],
  ["sixty five thousand", ASK_Q, 65_000],
  ["250", K_Q, 250_000],
  ["250", SQFT_Q, null],
];

const THREAD = "+16125550188";

function contextFor(question) {
  return {
    context_version: "conversation_context_v1",
    canonical_thread: THREAD,
    inbound_thread: THREAD,
    canonical_stage: null,
    last_outbound_message_id: "out-parity",
    last_outbound_use_case: question === SQFT_Q ? "condition_check" : "asking_price",
    last_outbound_delivered_at: "2026-10-01T15:00:00.000Z",
    current_inbound_received_at: "2026-10-01T15:05:00.000Z",
    intervening_outbound_count: 0,
    intervening_inbound_count: 0,
    unanswered_question: true,
    last_outbound_question: describeLastQuestion(question),
  };
}

async function classifierPrice(message, question) {
  const c = await classify(message, null, { heuristicOnly: true, conversation_context: contextFor(question) });
  return {
    value: c.price_parse?.qualifies_as_seller_asking_price ? c.price_parse.value : null,
    primary_intent: c.primary_intent,
    auto_reply_allowed: c.automation_decision?.auto_reply_allowed === true,
  };
}

function memoryDb() {
  const writes = [];
  const tables = {};
  let seq = 0;
  const rowsOf = (t) => (tables[t] ||= []);
  const query = (table, mode, payload = null) => {
    const filters = [];
    let single = false;
    const b = {
      select: () => b, eq: (c, v) => (filters.push((r) => r[c] === v), b), neq: () => b,
      in: (c, vs) => (filters.push((r) => (vs || []).includes(r[c])), b), is: () => b, not: () => b,
      lt: () => b, lte: () => b, gt: () => b, gte: () => b, or: () => b, ilike: () => b, like: () => b,
      contains: () => b, filter: () => b, match: () => b, range: () => b, order: () => b, limit: () => b,
      maybeSingle: () => ((single = true), b), single: () => ((single = true), b),
      then(resolve, reject) {
        let out;
        if (mode === "select") {
          const rows = rowsOf(table).filter((r) => filters.every((f) => f(r)));
          out = { data: single ? rows[0] ?? null : rows, error: null };
        } else {
          const saved = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `mem-${table}-${++seq}`, ...r }));
          writes.push({ table, mode, rows: saved });
          if (mode !== "update") rowsOf(table).push(...saved);
          out = { data: single ? saved[0] ?? null : saved, error: null };
        }
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  };
  return {
    writes,
    client: {
      from: (table) => ({
        select: () => query(table, "select"), insert: (p) => query(table, "insert", p),
        upsert: (p) => query(table, "upsert", p), update: (p) => query(table, "update", p), delete: () => query(table, "delete", {}),
      }),
      rpc: async () => ({ data: null, error: null }),
    },
  };
}

async function orchestratorPrice(message, question) {
  const db = memoryDb();
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => db.client,
    getDealContextByThread: async () => null,
    probeDealContextAmbiguity: async () => ({ ambiguous: false }),
    runContactResolutionPhase: async () => ({ ran: false, sends: 0 }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
    cancelPendingSellerEmails: async () => ({ ok: true, cancelled: 0 }),
    patchUniversalLeadState: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    executeReferralAutomation: async () => ({ ok: true }),
    scoreProperty: async () => ({ ok: false, error: "no_ade_offline" }),
    scheduleFollowUp: async () => ({ ok: true }),
    info: () => {},
    warn: () => {},
  });
  try {
    const classification = await classify(message, null, { heuristicOnly: true, conversation_context: contextFor(question) });
    const out = await processSellerInboundMessage({
      message,
      threadKey: THREAD,
      inboundFrom: THREAD,
      inboundTo: "+16125550100",
      propertyId: "prop-parity-1",
      ownerId: "mo-parity-1",
      prospectId: "pros-parity-1",
      classification,
      recentOutbound: { direction: "outbound", message_body: question },
      context: { found: true, ids: { property_id: "prop-parity-1", master_owner_id: "mo-parity-1" }, summary: { conversation_stage: "asking_price", seller_stage: "asking_price" } },
      route: { stage: "asking_price", use_case: "asking_price" },
      inboundEventId: "evt-parity-1",
      inboundReceivedAt: "2026-10-01T15:05:00.000Z",
      stageBefore: "asking_price",
      autoReplyMode: "live_limited",
      dryRun: false,
      proofRun: false,
      skipNotifications: true,
      supabaseClient: db.client,
      getSystemValue: async () => null,
    });
    const amount = out.fact_extraction?.facts?.asking_price?.value?.amount;
    return Number.isFinite(Number(amount)) ? Number(amount) : null;
  } finally {
    __resetSellerInboundOrchestratorDeps();
  }
}

for (const [message, question, expected] of CASES) {
  test(`one answer everywhere: ${JSON.stringify(message)} after ${JSON.stringify(question)} -> ${expected ?? "no price"}`, async () => {
    const signal = resolveCanonicalAskingPrice(message, { lastOutboundBody: question });
    const answers = {
      canonical: canonicalAskingPriceDecision(message, { lastOutboundBody: question }).value,
      burst: resolveCanonicalBurstAskingPrice([{ body: message }], { lastOutboundBody: question }).asking_price?.value ?? null,
      classifier: (await classifierPrice(message, question)).value,
      stage2_extract: extractAskingPrice(message, { lastOutboundBody: question })?.value ?? null,
      stage2_outcome:
        classifyStage2OfferInterest({ message, classification: {}, context: {}, price_signal: signal }).outcome ===
        STAGE2_OUTCOMES.SELLER_PROVIDES_ASKING_PRICE
          ? "price"
          : "no price",
      stage3: classifyStage3AskingPrice({ message, price_signal: signal, underwriting: {}, context: {} }).seller_asking_price ?? null,
      stage5: extractCounterOffer(message, null, { lastOutboundBody: question }).normalized_amount,
      underwriting:
        extractUnderwritingSignals({
          message,
          context: { recent: { recent_events: [{ direction: "outbound", message_body: question }] } },
        }).signals.asking_price ?? null,
      read_model: extractPrices(message, { lastOutboundBody: question })[0] ?? null,
      read_model_thread:
        analyzeConversation(
          [
            { direction: "outbound", message_body: question, created_at: "2026-10-01T15:00:00.000Z" },
            { direction: "inbound", message_body: message, created_at: "2026-10-01T15:05:00.000Z" },
          ],
          { now: "2026-10-01T16:00:00.000Z" }
        ).language.priceMentions[0] ?? null,
      orchestrator: await orchestratorPrice(message, question),
    };
    const want = {
      canonical: expected,
      burst: expected,
      classifier: expected,
      stage2_extract: expected,
      stage2_outcome: expected === null ? "no price" : "price",
      stage3: expected,
      stage5: expected,
      underwriting: expected,
      read_model: expected,
      read_model_thread: expected,
      orchestrator: expected,
    };
    assert.deepEqual(answers, want);
  });
}

test("the classifier no longer decides on its own parse: a bare '65' is not an auto-replied asking price", async () => {
  const c = await classifierPrice("65", ASK_Q);
  assert.notEqual(c.primary_intent, "asking_price_provided");
  assert.equal(c.auto_reply_allowed, false);
  const evidence = await classify("65", null, { heuristicOnly: true, conversation_context: contextFor(ASK_Q) });
  assert.equal(evidence.price_parse.classifier_parse_value, 65, "its own parse survives as evidence only");
  assert.equal(evidence.price_parse.qualifies_as_seller_asking_price, false);
  assert.equal(evidence.price_parse.value, null, "no reader can mistake the old parse for a decision");
});

test("a joke fragment in a burst never replaces or becomes the price", () => {
  const kept = resolveCanonicalBurstAskingPrice([{ body: "$350k" }, { body: "lol jk give me a million 😂" }], {});
  assert.equal(kept.asking_price?.value, 350_000);
  const alone = resolveCanonicalBurstAskingPrice([{ body: "ok" }, { body: "sure, give me a million 😂" }], {});
  assert.equal(alone.asking_price, null);
  assert.equal(alone.commitment, "NON_LITERAL");
});

test("stage 5 follows RC 7.1: a bare negotiation number is a clarification, not a guessed thousands counter", () => {
  const bare = extractCounterOffer("can you do 160?", 175_000);
  assert.equal(bare.normalized_amount, null);
  assert.equal(bare.needs_clarification, true);
  assert.equal(bare.clarification_reason, "ambiguous_price_scale");
  assert.equal(extractCounterOffer("I'd take 175k", 175_000).normalized_amount, 175_000);
  assert.equal(extractCounterOffer("lo dejo en 180 mil", 175_000).normalized_amount, 180_000);
  // Once the seller has written in thousands ("175k"), "160" is $160,000.
  assert.equal(extractCounterOffer("can you do 160?", 175_000, { shorthandConvention: true }).normalized_amount, 160_000);
});

// ── Space-grouped thousands ("300 000") ─────────────────────────────────────

const SPACE_CASES = [
  ["300 000", 300_000],
  ["300 000 dólares", 300_000],
  ["I want 1 250 000", 1_250_000],
  ["2 300 sqft", null], // an area, never merged into a price
  ["612 555 0188", null], // phone-like: the last group is 4 digits
  ["Rent is 1 800 a month", null], // under 10,000: not a grouped price
];

for (const [message, expected] of SPACE_CASES) {
  test(`space-grouped thousands, one answer everywhere: ${JSON.stringify(message)} -> ${expected ?? "no price"}`, async () => {
    const question = ASK_Q;
    const signal = resolveCanonicalAskingPrice(message, { lastOutboundBody: question });
    const answers = {
      canonical: canonicalAskingPriceDecision(message, { lastOutboundBody: question }).value,
      burst: resolveCanonicalBurstAskingPrice([{ body: message }], { lastOutboundBody: question }).asking_price?.value ?? null,
      classifier: (await classifierPrice(message, question)).value,
      stage2_extract: extractAskingPrice(message, { lastOutboundBody: question })?.value ?? null,
      stage3: classifyStage3AskingPrice({ message, price_signal: signal, underwriting: {}, context: {} }).seller_asking_price ?? null,
      stage5: extractCounterOffer(message, null, { lastOutboundBody: question }).normalized_amount,
      underwriting:
        extractUnderwritingSignals({
          message,
          context: { recent: { recent_events: [{ direction: "outbound", message_body: question }] } },
        }).signals.asking_price ?? null,
      read_model: extractPrices(message, { lastOutboundBody: question })[0] ?? null,
      orchestrator: await orchestratorPrice(message, question),
    };
    assert.deepEqual(answers, Object.fromEntries(Object.keys(answers).map((k) => [k, expected])));
  });
}
