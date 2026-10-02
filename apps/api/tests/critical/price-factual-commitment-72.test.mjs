/**
 * FACTUAL COMMITMENT for prices (7.2).
 *
 * IC8 audit §8: "sure, give me a million 😂" was accepted as a $1,000,000
 * asking price at 0.9 and the stage advanced. The transform now sits in the
 * one slot every price consumer reads (process-seller-inbound-message.js,
 * right after resolveAskingPriceSignal), so a NON-LITERAL or AMBIGUOUS price
 * can neither persist nor move the stage. RC 7.1's scale rules are unchanged.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import {
  applyFactualCommitmentToPriceSignal,
  questionEstablishesThousandsShorthand,
  describeLastQuestion,
} from "@/lib/domain/classification/factual-commitment.js";
import { classify } from "@/lib/domain/classification/classify.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";

function signal(message, { question = null, reference = null, negotiationActive = false } = {}) {
  const raw = resolveAskingPriceSignal(message, {
    reference,
    negotiationActive,
    shorthandConvention: questionEstablishesThousandsShorthand(question),
  });
  return applyFactualCommitmentToPriceSignal(raw, { message, lastOutboundBody: question });
}

test("laughter beside a number is NON-LITERAL: never an asking price, always a clarification", () => {
  for (const message of ["sure, give me a million 😂", "Sure, I'll take a million dollars 😂", "$1,000,000 haha"]) {
    const s = signal(message, { reference: 150000 });
    assert.equal(s.asking_price, null, message);
    assert.equal(s.commitment, "NON_LITERAL", message);
    assert.equal(s.needs_clarification, true, message);
    assert.equal(s.clarification_reason, "non_literal_price", message);
  }
  // Below any price the parser accepts there is nothing to demote; still no ask.
  assert.equal(signal("lol 5 bucks", { reference: 150000 }).asking_price, null);
});

test("RC 7.1 scale rules are unchanged: '65' is ambiguous, '65k' and 'sixty five thousand' are $65,000", () => {
  const bare = signal("65", { reference: 110000, negotiationActive: true });
  assert.equal(bare.asking_price, null);
  assert.equal(bare.commitment, "AMBIGUOUS");
  assert.equal(signal("65k", { reference: 110000, negotiationActive: true }).asking_price.value, 65000);
  assert.equal(signal("sixty five thousand").asking_price.value, 65000);
});

test("'250' after 'Would you take $240k?' is the counter $250,000 (our own k-shorthand sets the scale)", () => {
  const q = "Would you take $240k?";
  assert.equal(describeLastQuestion(q).kind, "offer_amount_in_thousands");
  const s = signal("250", { question: q, reference: 240000, negotiationActive: true });
  assert.equal(s.asking_price.value, 250000);
  assert.equal(s.is_counter, true);
  assert.notEqual(s.commitment, "CONFIRMED", "an inferred scale is LIKELY, never CONFIRMED");
});

test("'250' after a square-feet question is a size, not a price, and asks no price question", () => {
  const q = "How many square feet is the house?";
  assert.equal(describeLastQuestion(q).kind, "non_price_quantity");
  const s = signal("250", { question: q, reference: 240000, negotiationActive: true });
  assert.equal(s.asking_price, null);
  assert.equal(s.needs_clarification, false);
  assert.equal(s.commitment_reason, "number_answers_a_quantity_question");
});

test("'250' after an asking-price question with no amount stays ambiguous (RC 7.1)", () => {
  const s = signal("250", { question: "Do you have an asking price in mind?", reference: 110000 });
  assert.equal(s.asking_price, null);
  assert.equal(s.commitment, "AMBIGUOUS");
});

test("the classifier agrees: laughter + amount is NON_LITERAL and never asking_price_provided", async () => {
  const c = await classify("Sure, I'll take a million dollars 😂", null, { heuristicOnly: true });
  assert.notEqual(c.primary_intent, "asking_price_provided");
  assert.equal(c.factual_commitment, "NON_LITERAL");
  const bare = await classify("250", null, { heuristicOnly: true });
  assert.notEqual(bare.factual_commitment, "CONFIRMED", "a bare 250 is never a confirmed fact");
});

// ── The slot, end to end: nothing non-literal persists ──────────────────────

function memoryDb(seed = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  const writes = [];
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

test("the live orchestrator never persists a joke price: 'sure, give me a million 😂' after the asking-price question", async () => {
  const thread = "+16125550188";
  const db = memoryDb({ sms_templates: [], send_queue: [] });
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
    const message = "sure, give me a million 😂";
    const classification = await classify(message, null, { heuristicOnly: true });
    const out = await processSellerInboundMessage({
      message,
      threadKey: thread,
      inboundFrom: thread,
      inboundTo: "+16125550100",
      propertyId: "prop-joke-1",
      ownerId: "mo-joke-1",
      prospectId: "pros-joke-1",
      classification,
      recentOutbound: { direction: "outbound", message_body: "Do you have an asking price in mind for the property?" },
      context: { found: true, ids: { property_id: "prop-joke-1", master_owner_id: "mo-joke-1" }, summary: { conversation_stage: "asking_price", seller_stage: "asking_price" } },
      route: { stage: "asking_price", use_case: "asking_price" },
      inboundEventId: "evt-joke-1",
      inboundReceivedAt: "2026-10-01T15:00:00.000Z",
      stageBefore: "asking_price",
      autoReplyMode: "live_limited",
      dryRun: false,
      proofRun: false,
      skipNotifications: true,
      supabaseClient: db.client,
      getSystemValue: async () => null,
    });
    assert.ok(out.fact_extraction, "the extraction record is returned");
    assert.equal(
      /1000000|1e\+?6/.test(JSON.stringify(out.fact_extraction?.facts?.asking_price ?? null)),
      false,
      "the extraction record carries no $1M ask (without the slot it is {amount: 1000000})"
    );
    const persisted = JSON.stringify(db.writes);
    assert.equal(/1000000|1e\+?6/.test(persisted), false, "no write anywhere carries the joke price");
  } finally {
    __resetSellerInboundOrchestratorDeps();
  }
});
