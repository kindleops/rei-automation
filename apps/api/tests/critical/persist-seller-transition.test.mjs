import test from "node:test";
import assert from "node:assert/strict";

import {
  persistSellerTransitionArtifacts,
  buildNegotiationStatePatch,
  transitionQualifiesForOpportunity,
} from "@/lib/domain/seller-flow/persist-seller-transition.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

const NOW = "2026-07-01T12:00:00.000Z";

/** Generic stateful PostgREST-style mock. Opportunities are materialized; every other table is a permissive no-op. */
function makeFakeSupabase({ opportunities = [] } = {}) {
  const state = { opportunities: opportunities.map((o) => ({ metadata: {}, version: 1, ...o })), nextId: 1000 };

  function query(table) {
    const q = {
      _op: "select",
      _payload: null,
      _filters: [],
      select() { return q; },
      insert(row) { q._op = "insert"; q._payload = row; return q; },
      update(patch) { q._op = "update"; q._payload = patch; return q; },
      upsert(row) { q._op = "insert"; q._payload = row; return q; },
      eq(col, val) { q._filters.push({ type: "eq", col, val }); return q; },
      in(col, vals) { q._filters.push({ type: "in", col, vals }); return q; },
      gte() { return q; },
      order() { return q; },
      limit() { return q._run().then((rows) => ({ data: rows, error: null })); },
      maybeSingle() { return q._run().then((rows) => ({ data: rows[0] || null, error: null })); },
      single() { return q._run().then((rows) => ({ data: rows[0] || null, error: null })); },
      then(onF, onR) { return q._run().then(() => ({ data: null, error: null })).then(onF, onR); },
      async _run() {
        if (table !== "acquisition_opportunities") {
          if (q._op === "insert") return [{ id: `row-${state.nextId++}`, ...(Array.isArray(q._payload) ? q._payload[0] : q._payload) }];
          return [];
        }
        if (q._op === "insert") {
          const row = { id: `opp-${state.nextId++}`, version: 1, metadata: {}, ...q._payload };
          state.opportunities.push(row);
          return [row];
        }
        const matches = state.opportunities.filter((row) =>
          q._filters.every((f) =>
            f.type === "eq" ? String(row[f.col]) === String(f.val) : f.vals.map(String).includes(String(row[f.col]))
          )
        );
        if (q._op === "update") {
          for (const row of matches) Object.assign(row, q._payload);
          return matches;
        }
        return matches;
      },
    };
    return q;
  }

  return { _state: state, from: (table) => query(table) };
}

function priceTransition(overrides = {}) {
  return resolveSellerStageTransition({
    stage_before: "offer_interest",
    intent: "asking_price_provided",
    new_facts: { asking_price: { value: 95000, raw: "$95,000" } },
    classification_confidence: 0.92,
    source_message_id: "msg-1",
    now: NOW,
    ...overrides,
  });
}

test("qualifying transition creates an opportunity with facts, stage, and negotiation state", async () => {
  const supabase = makeFakeSupabase();
  const transition = priceTransition();

  const result = await persistSellerTransitionArtifacts({
    transition,
    threadKey: "+13125550100",
    propertyId: "prop-1",
    ownerId: "owner-1",
    intent: "asking_price_provided",
    inboundEventId: "evt-1",
    supabaseClient: supabase,
    deps: { scoreProperty: async () => ({ ok: true, score: { recommended_cash_offer: 71000, minimum_acceptable_offer: 65000, investor_ceiling_mid: 80000 } }) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.opportunity_created, true);
  assert.ok(result.opportunity_id);
  assert.equal(result.ade.ran, true, `ade error: ${result.ade.error}`);
  assert.equal(result.negotiation_state_updated, true);

  const opp = supabase._state.opportunities.find((o) => o.id === result.opportunity_id);
  assert.equal(opp.asking_price, 95000);
  assert.equal(opp.recommended_offer, 71000);
  assert.equal(opp.offer_to_ask_gap, 95000 - 71000);
  assert.equal(opp.next_action, transition.next_action);
  assert.equal(opp.metadata.negotiation_state.initial_ask, 95000);
  assert.equal(opp.metadata.negotiation_state.current_ask, 95000);
  assert.equal(opp.metadata.negotiation_state.recommended_offer, 71000);
  assert.equal(opp.metadata.negotiation_state.authorized_offer_floor, 65000);
  assert.equal(opp.metadata.negotiation_state.authorized_offer_ceiling, 80000);
  assert.equal(opp.metadata.seller_facts.asking_price.value, 95000);
  assert.equal(opp.metadata.seller_facts.asking_price.source_message_id, "msg-1");
  assert.ok(opp.metadata.ade_snapshot);
});

test("existing opportunity advances stage monotonically with reasoning", async () => {
  const supabase = makeFakeSupabase({
    opportunities: [
      {
        id: "opp-7",
        dedupe_key: "owner:owner-1:property:prop-1",
        master_owner_id: "owner-1",
        primary_property_id: "prop-1",
        primary_thread_key: "+13125550100",
        acquisition_stage: "offer_interest",
        opportunity_status: "active",
        asking_price: null,
      },
    ],
  });
  const transition = priceTransition();

  const result = await persistSellerTransitionArtifacts({
    transition,
    threadKey: "+13125550100",
    propertyId: "prop-1",
    ownerId: "owner-1",
    intent: "asking_price_provided",
    supabaseClient: supabase,
    deps: { scoreProperty: async () => ({ ok: true, score: { recommended_cash_offer: 70000 } }) },
  });

  assert.equal(result.opportunity_created, false);
  assert.equal(result.opportunity_id, "opp-7");
  assert.equal(result.stage_advanced, true, `block: ${result.stage_advance_block}`);
  const opp = supabase._state.opportunities[0];
  assert.equal(opp.acquisition_stage, "property_condition");
  assert.equal(opp.asking_price, 95000);
});

test("stage never regresses on the opportunity record", async () => {
  const supabase = makeFakeSupabase({
    opportunities: [
      {
        id: "opp-9",
        dedupe_key: "thread:+13125550100",
        primary_thread_key: "+13125550100",
        acquisition_stage: "offer",
        opportunity_status: "active",
        asking_price: 100000,
      },
    ],
  });
  // Transition holds at property_condition (stage 4) — below the deal's offer stage.
  const transition = resolveSellerStageTransition({
    stage_before: "property_condition",
    intent: "condition_disclosed",
    new_facts: { repairs_summary: "roof" },
    classification_confidence: 0.9,
    now: NOW,
  });

  await persistSellerTransitionArtifacts({
    transition,
    threadKey: "+13125550100",
    supabaseClient: supabase,
  });

  assert.equal(supabase._state.opportunities[0].acquisition_stage, "offer");
});

test("counter price during negotiation lands in seller_counter, not asking_price", async () => {
  const supabase = makeFakeSupabase({
    opportunities: [
      {
        id: "opp-11",
        dedupe_key: "thread:+13125550100",
        primary_thread_key: "+13125550100",
        acquisition_stage: "offer",
        opportunity_status: "active",
        asking_price: 95000,
        metadata: { negotiation_state: { initial_ask: 95000, current_ask: 95000, negotiation_turn: 1 } },
      },
    ],
  });
  const transition = resolveSellerStageTransition({
    stage_before: "offer",
    intent: "asking_price_provided",
    new_facts: { asking_price: 110000 },
    negotiation_state: { offers_made: 1, terms_accepted: false },
    ade_result: { recommended_offer: 80000, sufficient_facts: true },
    classification_confidence: 0.9,
    now: NOW,
  });

  await persistSellerTransitionArtifacts({
    transition,
    threadKey: "+13125550100",
    intent: "asking_price_provided",
    supabaseClient: supabase,
  });

  const opp = supabase._state.opportunities[0];
  assert.equal(opp.asking_price, 95000, "original ask preserved");
  assert.equal(opp.seller_counter, 110000);
  assert.equal(opp.metadata.negotiation_state.current_ask, 110000);
  assert.equal(opp.metadata.negotiation_state.negotiation_turn, 2);
  assert.equal(opp.metadata.negotiation_state.seller_counters.length, 1);
  assert.equal(opp.metadata.negotiation_state.seller_counters[0].amount, 110000);
});

test("non-qualifying transition without an existing deal is skipped", async () => {
  const supabase = makeFakeSupabase();
  const transition = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: "wrong_number",
    now: NOW,
  });
  const result = await persistSellerTransitionArtifacts({
    transition,
    threadKey: "+13125550100",
    supabaseClient: supabase,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no_opportunity_to_track");
  assert.equal(supabase._state.opportunities.length, 0);
});

test("dry run never writes", async () => {
  const supabase = makeFakeSupabase();
  const result = await persistSellerTransitionArtifacts({
    transition: priceTransition(),
    threadKey: "+13125550100",
    dryRun: true,
    supabaseClient: supabase,
  });
  assert.equal(result.skipped, true);
  assert.equal(supabase._state.opportunities.length, 0);
});

test("ADE failure is isolated and recorded, facts still persist", async () => {
  const supabase = makeFakeSupabase();
  const result = await persistSellerTransitionArtifacts({
    transition: priceTransition(),
    threadKey: "+13125550100",
    propertyId: "prop-1",
    ownerId: "owner-1",
    supabaseClient: supabase,
    deps: { scoreProperty: async () => { throw new Error("comps_unavailable"); } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ade.ran, false);
  assert.equal(result.ade.error, "comps_unavailable");
  assert.equal(result.facts_persisted, true);
});

test("accepted terms mark negotiation state and preserve authorized band", () => {
  const accepted = resolveSellerStageTransition({
    stage_before: "offer",
    intent: "seller_interested",
    negotiation_state: { offers_made: 2, terms_accepted: true },
    known_facts: { asking_price: { value: 95000 }, occupancy_status: "vacant", condition_level: "turnkey" },
    classification_confidence: 0.95,
    now: NOW,
  });
  const state = buildNegotiationStatePatch(
    { initial_ask: 95000, current_ask: 90000, recommended_offer: 85000, authorized_offer_floor: 80000, authorized_offer_ceiling: 92000 },
    { transition: accepted, intent: "seller_interested", now: NOW }
  );
  assert.equal(state.terms_accepted, true);
  assert.equal(state.accepted_price, 85000);
  assert.equal(state.authorized_offer_ceiling, 92000);
});

test("transitionQualifiesForOpportunity gates on engagement", () => {
  assert.equal(transitionQualifiesForOpportunity(priceTransition()), true);
  const hold = resolveSellerStageTransition({ stage_before: "ownership_confirmation", intent: "who_is_this", classification_confidence: 0.9, now: NOW });
  assert.equal(transitionQualifiesForOpportunity(hold), false);
});
