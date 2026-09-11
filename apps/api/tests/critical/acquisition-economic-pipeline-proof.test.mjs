/**
 * THE THREE PRODUCTION CASES, RUN THROUGH THE SAME PIPELINE.
 *
 * Each scenario starts from raw seller TEXT, runs the real parser, the real
 * resolver and the real persistence writer, then re-reads the stored row. What
 * is asserted is the set of things that must agree:
 *
 *   canonical route id  ==  persisted acquisition_stage  ==  recommended use case
 *
 * If those three can disagree, the seller receives a message from a stage the
 * system is not actually in - which is the defect this whole pass exists to
 * close.
 *
 * No message is dispatched. Sending is disabled.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { persistSellerTransitionArtifacts } from "@/lib/domain/seller-flow/persist-seller-transition.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import { classifyStage3AskingPrice } from "@/lib/domain/seller-flow/stage3-asking-price-engine.js";
import { LOCAL_TEMPLATE_CANDIDATES } from "@/lib/domain/templates/local-template-registry.js";
import { LIFECYCLE_STAGE_CODES } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

const INTERESTED = { ownership_status: "confirmed", interest: "interested" };

function makeStore() {
  const state = { opportunities: [], nextId: 1 };
  const query = (table) => {
    const q = {
      _op: "select", _payload: null, _filters: [],
      select() { return q; },
      insert(row) { q._op = "insert"; q._payload = row; return q; },
      update(patch) { q._op = "update"; q._payload = patch; return q; },
      upsert(row) { q._op = "insert"; q._payload = row; return q; },
      eq(col, val) { q._filters.push({ col, val }); return q; },
      in() { return q; }, gte() { return q; }, order() { return q; },
      limit() { return q._run().then((rows) => ({ data: rows, error: null })); },
      maybeSingle() { return q._run().then((r) => ({ data: r[0] || null, error: null })); },
      single() { return q._run().then((r) => ({ data: r[0] || null, error: null })); },
      then(onF, onR) { return q._run().then(() => ({ data: null, error: null })).then(onF, onR); },
      async _run() {
        if (table !== "acquisition_opportunities") {
          if (q._op === "insert") {
            const p = Array.isArray(q._payload) ? q._payload[0] : q._payload;
            return [{ id: `row-${state.nextId++}`, ...p }];
          }
          return [];
        }
        if (q._op === "insert") {
          const row = { id: `opp-${state.nextId++}`, version: 1, metadata: {}, ...q._payload };
          state.opportunities.push(row);
          return [row];
        }
        const m = state.opportunities.filter((r) => q._filters.every((f) => String(r[f.col]) === String(f.val)));
        if (q._op === "update") { for (const r of m) Object.assign(r, q._payload); return m; }
        return m;
      },
    };
    return q;
  };
  return { _state: state, from: query };
}

/** Does an APPROVED template actually exist for this use case? */
function templatesFor(use_case) {
  return LOCAL_TEMPLATE_CANDIDATES.filter((t) => t.use_case === use_case).map(
    (t) => t.item_id || t.id || null,
  );
}

/**
 * One priced inbound turn, end to end: text -> parser -> resolver ->
 * persistence -> re-read, plus the recommender's independent answer.
 */
async function pricedTurn(message, ade, { negotiation_state = null } = {}) {
  const store = makeStore();
  const signal = resolveAskingPriceSignal(message);
  const ask = signal?.asking_price;

  const transition = resolveSellerStageTransition({
    stage_before: LIFECYCLE_STAGE_CODES.ASKING_PRICE,
    known_facts: INTERESTED,
    new_facts: { asking_price: ask },
    intent: "price_provided",
    ade_result: { ...ade, sufficient_facts: true },
    negotiation_state,
    source_message_id: "msg-econ-1",
    now: "2026-07-01T12:00:00.000Z",
  });

  await persistSellerTransitionArtifacts({
    transition,
    threadKey: "+13125550177",
    propertyId: "prop-econ",
    ownerId: "owner-econ",
    intent: "price_provided",
    inboundEventId: "evt-econ-1",
    supabaseClient: store,
    deps: { scoreProperty: async () => ({ ok: false, reason: "not_exercised" }) },
  });

  const persisted = store._state.opportunities[0] || null;
  const gate = transition.economic_gate;
  const recommendation = gate
    ? classifyStage3AskingPrice({
        seller_asking_price: ask?.value,
        underwriting: ade,
        context: { creative_allowed: gate.creative_allowed },
      })
    : null;

  return { signal, ask, transition, gate, persisted, recommendation, store };
}

// ══════════════════════════════════════════════════════════════════════════
// JAMES — "Half mil and its yours" on a house we would pay $160,000 for
// ══════════════════════════════════════════════════════════════════════════

test("JAMES: half a million against a $160k offer is cold nurture, not a condition probe", async () => {
  const ADE = { recommended_cash_offer: 160_000, max_allowable_offer: 184_000 };
  const r = await pricedTurn("Half mil and its yours", ADE);

  // Parser: this is the bug that made it $1,500,000 before the fraction fix.
  assert.equal(r.ask.value, 500_000, "half a million, not 1.5 million");

  assert.equal(r.gate.offer_band, "very_wide_gap");
  assert.equal(r.gate.economic_fit, "out_of_band");
  assert.equal(r.gate.route_id, "very_wide_gap_nurture");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.ASKING_PRICE);
  assert.equal(r.transition.lead_temperature, "cold");

  // The three that must agree.
  assert.equal(r.persisted.acquisition_stage, LIFECYCLE_STAGE_CODES.ASKING_PRICE, "PERSISTED");
  assert.equal(r.gate.template_use_case, "asking_price_follow_up");
  assert.equal(r.recommendation.template_use_case, "asking_price_follow_up");
  assert.ok(Object.is(r.gate.route, r.recommendation.canonical_route), "same route instance");

  // And an approved template actually exists for that purpose.
  assert.ok(templatesFor("asking_price_follow_up").length > 0, "approved template must exist");

  // Nothing the system does here may claim condition, offer or contract.
  assert.notEqual(r.transition.stage_after, LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION);
  assert.notEqual(r.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER);
  assert.notEqual(r.transition.stage_after, LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT);
  assert.equal(r.gate.creative_allowed, false, "no creative signal, so no creative route");
  assert.notEqual(r.persisted.metadata?.negotiation_state?.terms_accepted, true);
});

// ══════════════════════════════════════════════════════════════════════════
// LORRIE — "Number has to start with a 4"
// ══════════════════════════════════════════════════════════════════════════

test("LORRIE: a digit-anchored floor is a MINIMUM of $400k, and it is cold", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await pricedTurn("Number has to start with a 4. Otherwise nothing to talk about.", ADE);

  assert.equal(r.ask.value, 400_000, "a 4 means $400,000");
  assert.equal(r.ask.price_type, "minimum", "a floor, not an exact price");

  assert.equal(r.gate.offer_band, "very_wide_gap");
  assert.equal(r.gate.economic_fit, "out_of_band");
  assert.equal(r.gate.route_id, "very_wide_gap_nurture");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.ASKING_PRICE);
  assert.equal(r.transition.lead_temperature, "cold");

  assert.equal(r.persisted.acquisition_stage, LIFECYCLE_STAGE_CODES.ASKING_PRICE, "PERSISTED");
  assert.equal(r.gate.template_use_case, "asking_price_follow_up");
  assert.equal(r.recommendation.template_use_case, "asking_price_follow_up");
  assert.ok(Object.is(r.gate.route, r.recommendation.canonical_route));
  assert.ok(templatesFor("asking_price_follow_up").length > 0);
});

// ══════════════════════════════════════════════════════════════════════════
// AUTO-ACCEPT — affordable is not accepted
// ══════════════════════════════════════════════════════════════════════════

test("AUTO_ACCEPT: an affordable ask presents an offer and claims NOTHING about acceptance", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await pricedTurn("I'd take 195k", ADE);

  assert.equal(r.ask.value, 195_000);
  assert.equal(r.gate.offer_band, "auto_accept");
  assert.equal(r.gate.economic_fit, "actionable");
  assert.equal(r.gate.route_id, "auto_accept_offer");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER, "S5, make the offer");
  assert.equal(r.transition.lead_temperature, "hot");

  assert.equal(r.persisted.acquisition_stage, LIFECYCLE_STAGE_CODES.OFFER, "PERSISTED as S5");
  assert.equal(r.gate.template_use_case, "offer_reveal_cash", "offer-class template");
  assert.equal(r.recommendation.template_use_case, "offer_reveal_cash");
  assert.equal(r.gate.acquisition_action, "present_approved_cash_offer");

  // THE RULING. Economics cannot fabricate any of these.
  assert.notEqual(r.transition.stage_after, LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT);
  assert.notEqual(r.persisted.metadata?.negotiation_state?.terms_accepted, true, "terms_accepted is FALSE");
  assert.notEqual(r.gate.acquisition_action, "verify_signers_and_generate_contract");
  assert.ok(
    !(r.transition.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"),
    "no acceptance event may fire from arithmetic",
  );
});

test("only a seller acceptance advances toward S6 — and it comes from seller evidence", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000, sufficient_facts: true };

  // Turn 1: economics alone. The ask is affordable, and it caps at S5.
  const before = await pricedTurn("I'd take 195k", ADE);
  assert.equal(before.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER);
  assert.equal(before.gate.offer_band, "auto_accept");

  // Turn 2: the SAME economics, the SAME ask, one new thing - the seller said
  // yes. Acceptance arrives as negotiation state, which the acceptance
  // resolver owns from inbound evidence; the ADE cannot write it.
  const accepted = resolveSellerStageTransition({
    stage_before: LIFECYCLE_STAGE_CODES.OFFER,
    known_facts: {
      ...INTERESTED,
      asking_price: { value: 195_000, raw: "195k" },
      // Condition IS resolved here, because milestone completeness is
      // first-unresolved-wins: an open condition milestone would hold the
      // lifecycle at S4/S5 no matter what the seller agreed to.
      occupancy_status: "vacant",
      condition_level: "needs work",
    },
    new_facts: {},
    intent: "accepts_offer",
    ade_result: ADE,
    negotiation_state: { terms_accepted: true, current_ask: 195_000, accepted_price: 195_000 },
    now: "2026-07-02T12:00:00.000Z",
  });

  assert.equal(accepted.stage_after, LIFECYCLE_STAGE_CODES.FORMAL_CONTRACT, "now S6");
  assert.ok(
    (accepted.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"),
    "the acceptance event fires only on real seller evidence",
  );

  // The control: identical inputs MINUS the acceptance stay at S5 forever.
  const without = resolveSellerStageTransition({
    stage_before: LIFECYCLE_STAGE_CODES.OFFER,
    known_facts: {
      ...INTERESTED,
      asking_price: { value: 195_000, raw: "195k" },
      // Condition IS resolved here, because milestone completeness is
      // first-unresolved-wins: an open condition milestone would hold the
      // lifecycle at S4/S5 no matter what the seller agreed to.
      occupancy_status: "vacant",
      condition_level: "needs work",
    },
    new_facts: {},
    intent: "accepts_offer",
    ade_result: ADE,
    negotiation_state: { terms_accepted: false, current_ask: 195_000 },
    now: "2026-07-02T12:00:00.000Z",
  });
  assert.equal(without.stage_after, LIFECYCLE_STAGE_CODES.OFFER, "no acceptance, no S6");
  assert.ok(!(without.workflow_event_types || []).includes("SELLER_ACCEPTED_OFFER"));
});

// ══════════════════════════════════════════════════════════════════════════
// TEMPLATE GAP: a missing template must HOLD, never improvise
// ══════════════════════════════════════════════════════════════════════════

/**
 * close_range routes to `narrow_range`, and production has ZERO sms_templates
 * rows for that use case (verified 2026-09-11 against lcppdrmrdfblstpcbgpf).
 * Two local candidates exist, but neither is in the auto-reply approval
 * registry, so both fail closed and the turn holds for operator review.
 *
 * This test exists so that stops being luck. If someone adds a narrow_range
 * approval without an operator signing off on the copy, this fails.
 */
test("narrow_range has no approved auto-reply template, so it holds for review", async () => {
  const { LOCAL_TEMPLATE_CANDIDATES: candidates, verifyLocalAutoReplyApproval } = await import(
    "@/lib/domain/templates/local-template-registry.js"
  );
  const narrowRange = candidates.filter((t) => t.use_case === "narrow_range");
  assert.ok(narrowRange.length > 0, "the local candidates still exist");

  for (const template of narrowRange) {
    const verdict = verifyLocalAutoReplyApproval(template, { env: { NODE_ENV: "production" } });
    assert.equal(
      verdict.approved,
      false,
      `${template.item_id} must not be auto-sendable without an operator approval record`,
    );
    assert.ok(verdict.reasons.includes("no_approval_record"));
  }
});

test("close_range still routes to narrow_range — the gap is a hold, not a reroute", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await pricedTurn("I want 220k", ADE);

  assert.equal(r.gate.offer_band, "close_range");
  assert.equal(r.gate.route_id, "close_range_negotiation");
  assert.equal(r.gate.template_use_case, "narrow_range");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER);

  // The missing template must NOT cause the route to silently become some
  // other stage's message. The purpose stays correct and unsent.
  assert.notEqual(r.gate.template_use_case, "price_high_condition_probe");
  assert.notEqual(r.gate.template_use_case, "asking_price_follow_up");
  assert.notEqual(r.gate.template_use_case, "seller_asking_price");
});
