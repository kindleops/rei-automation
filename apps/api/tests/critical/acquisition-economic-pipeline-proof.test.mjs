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
async function pricedTurn(message, ade, { negotiation_state = null, priceOptions = undefined } = {}) {
  const store = makeStore();
  const signal = resolveAskingPriceSignal(message, priceOptions);
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
// CLOSE RANGE: a first asking price is NOT a counter
// ══════════════════════════════════════════════════════════════════════════

/**
 * The narrow_range gap is closed by SEMANTICS, not by new copy.
 *
 * An ask inside MAO used to route to `narrow_range`, which had zero production
 * templates and whose two local candidates both asked the seller for a number
 * they had just given. The real question was never "which template is
 * missing?" - it was "has this seller seen an offer from us yet?".
 *
 *   no prior reveal  -> they countered NOTHING -> present our number
 *   prior reveal     -> they countered         -> counter-offer copy
 *
 * Both reuse already-approved families. No near-duplicate use case was added.
 */

test("CASE A: ask inside the buy box with no prior reveal is a FIRST OFFER", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await pricedTurn("I want 220k", ADE);

  assert.equal(r.gate.offer_band, "close_range");
  assert.equal(r.gate.offer_revealed, false, "we have presented nothing");
  assert.equal(r.gate.route_id, "close_range_initial_offer");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER, "S5");

  // The communication is "here is the number we can do".
  assert.equal(r.gate.template_use_case, "offer_reveal_cash");
  assert.equal(r.gate.acquisition_action, "present_approved_cash_offer");
  assert.equal(r.recommendation.template_use_case, "offer_reveal_cash");
  assert.ok(Object.is(r.gate.route, r.recommendation.canonical_route));

  // Ineligible: a counter they never made, a price they already gave, and the
  // retired vacancy shortcut.
  for (const forbidden of [
    "counter_offer",
    "narrow_range",
    "seller_asking_price",
    "asking_price_follow_up",
    "price_works_confirm_basics",
    "vacancy_probe",
    "occupancy_probe",
  ]) {
    assert.notEqual(r.gate.template_use_case, forbidden, `must not select ${forbidden}`);
  }
});

test("CASE B: the same ask AFTER our offer was revealed is a real counter", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await pricedTurn("I want 220k", ADE, {
    // Our $200k was presented. negotiation-state records it; hasRevealedOffer
    // reads it.
    negotiation_state: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
  });

  assert.equal(r.gate.offer_band, "close_range", "identical economics");
  assert.equal(r.gate.offer_revealed, true);
  assert.equal(r.gate.route_id, "close_range_counter");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER, "still S5");

  assert.equal(r.gate.template_use_case, "counter_offer");
  assert.equal(r.gate.acquisition_action, "negotiate_within_buy_box");
  assert.notEqual(r.gate.template_use_case, "offer_reveal_cash", "not a first reveal any more");
});

test("the two close-range cases differ ONLY by whether we had revealed an offer", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const first = await pricedTurn("I want 220k", ADE);
  const counter = await pricedTurn("I want 220k", ADE, {
    negotiation_state: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
  });

  assert.equal(first.gate.offer_band, counter.gate.offer_band);
  assert.equal(first.gate.offer_gap_amount, counter.gate.offer_gap_amount);
  assert.equal(first.transition.stage_after, counter.transition.stage_after);
  assert.notEqual(first.gate.route_id, counter.gate.route_id);
  assert.notEqual(first.gate.template_use_case, counter.gate.template_use_case);
});

test("A COUNTER REQUIRES OUR OFFER FIRST — the parser and the route agree", async () => {
  const { resolveAskingPriceSignal } = await import(
    "@/lib/domain/seller-flow/monetary-understanding.js"
  );
  const { hasRevealedOffer } = await import("@/lib/domain/seller-flow/negotiation-state.js");

  // Nothing presented: the seller's first number is not a counter.
  assert.equal(hasRevealedOffer(null), false);
  assert.equal(hasRevealedOffer({}), false);
  assert.equal(hasRevealedOffer({ offers_made: [] }), false);
  assert.equal(resolveAskingPriceSignal("I want 220k", { negotiationActive: false })?.is_counter, false);

  // Presented: now it is.
  assert.equal(hasRevealedOffer({ latest_offer: 200_000 }), true);
  assert.equal(hasRevealedOffer({ offers_made: [{ amount: 200_000 }] }), true);
  assert.equal(hasRevealedOffer({ offers_made: 1 }), true, "legacy count form still counts");
  assert.equal(resolveAskingPriceSignal("I want 220k", { negotiationActive: true })?.is_counter, true);
});

// ══════════════════════════════════════════════════════════════════════════
// THE RETIRED VACANCY SHORTCUT
// ══════════════════════════════════════════════════════════════════════════

/**
 * narrow_range is no longer reachable at all: close_range now resolves to the
 * approved offer-reveal or counter-offer families depending on negotiation
 * history, so the zero-template gap is closed by semantics rather than by
 * writing new copy.
 */
test("no Stage-3 route asks for narrow_range any more", async () => {
  const { STAGE3_ROUTES } = await import("@/lib/domain/seller-flow/stage3-asking-price-engine.js");
  for (const [key, route] of Object.entries(STAGE3_ROUTES)) {
    assert.notEqual(route.template_use_case, "narrow_range", `${key} still points at the empty family`);
  }
});

test("a workable price presents our number and never probes vacancy", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const RETIRED = ["price_works_confirm_basics", "vacancy_probe", "occupancy_probe"];

  // The exact situation the retired shortcut keyed on: the price works.
  for (const ask of ["I want 220k", "I'd take 195k"]) {
    const r = await pricedTurn(ask, ADE);
    assert.ok(
      !RETIRED.includes(r.gate.template_use_case),
      `"${ask}" selected the retired ${r.gate.template_use_case}`,
    );
    assert.equal(r.gate.acquisition_action, "present_approved_cash_offer");
  }
});

// ══════════════════════════════════════════════════════════════════════════
// SHORTHAND AND BOUNDS, THROUGH THE REAL ECONOMICS
// ══════════════════════════════════════════════════════════════════════════

/** Same call shape process-seller-inbound-message uses: an anchored reference. */
async function anchoredTurn(message, ade, opts = {}) {
  return pricedTurn(message, ade, { ...opts, priceOptions: { reference: ade.recommended_cash_offer } });
}

test("bare shorthand '220' routes on real economics, not on a literal $220", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await anchoredTurn("220", ADE);

  assert.equal(r.ask.value, 220_000, "conventional hundreds-as-thousands");
  assert.equal(r.ask.scaled_from_reference, true, "and we remember it was inferred");
  assert.equal(r.ask.extracted_text, "220", "the seller's raw words survive");

  assert.equal(r.gate.offer_band, "close_range");
  assert.equal(r.gate.offer_revealed, false);
  assert.equal(r.gate.route_id, "close_range_initial_offer");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER);
  assert.equal(r.gate.template_use_case, "offer_reveal_cash");
});

test("the same shorthand after a reveal is a counter", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await anchoredTurn("220", ADE, {
    negotiation_state: { latest_offer: 200_000, offers_made: [{ amount: 200_000 }] },
  });
  assert.equal(r.ask.value, 220_000);
  assert.equal(r.gate.route_id, "close_range_counter");
  assert.equal(r.gate.template_use_case, "counter_offer");
});

test("net shorthand keeps BOTH the magnitude and the net semantic", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await anchoredTurn("250 net", ADE);

  assert.equal(r.ask.value, 250_000);
  assert.equal(r.ask.price_type, "net", "a net requirement is not a gross ask");
  // $250k against a $230k ceiling is above MAO but inside 1.15x.
  assert.equal(r.gate.offer_band, "negotiable");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.PROPERTY_CONDITION);
});

test("a ceiling is stored as a ceiling, even when the economics look great", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await anchoredTurn("I wouldn't need more than 200", ADE);

  // The stored fact is an UPPER BOUND. The seller did not ask for $200,000.
  assert.equal(r.ask.price_type, "maximum", "must not be recorded as exact");
  assert.equal(r.ask.value, 200_000);
  assert.equal(r.ask.extracted_text, "200", "raw seller language preserved");

  // The ADE may still route on the bound - and here it is genuinely promising.
  assert.equal(r.gate.offer_band, "auto_accept");
  assert.equal(r.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER);
  assert.equal(r.transition.lead_temperature, "hot");

  // But the persisted fact keeps the semantic, not the routing convenience.
  assert.equal(
    r.persisted.metadata?.seller_facts?.asking_price?.price_type,
    "maximum",
    "persistence must not flatten the bound to exact",
  );
});

test("a rent figure does not become an asking price, even alongside selling intent", async () => {
  const ADE = { recommended_cash_offer: 200_000, max_allowable_offer: 230_000 };
  const r = await anchoredTurn("Rent is 2200 but I'd sell", ADE);

  assert.equal(r.ask ?? null, null, "no $2.2M ask");
  assert.equal(r.gate?.applied, false, "the economic gate never engaged");
  assert.equal(r.gate?.route_id ?? null, null, "and no route was chosen off a rent figure");
  assert.notEqual(r.transition.stage_after, LIFECYCLE_STAGE_CODES.OFFER);
});
