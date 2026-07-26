/**
 * Auto Reply Intelligence V2 — deterministic core.
 *
 * Every assertion runs against REAL production functions:
 *   classify (heuristicOnly) → resolveAskingPriceSignal → extractSellerFacts
 *   → normalizeClassificationContract → resolveSellerAuthorityState
 *   → resolveSellerConversationState → resolveSellerNextBestAction
 *   → resolveSellerStageTransition → resolveSellerResponseStrategy
 *
 * Fixtures carry state/evidence only. No expected policy is encoded in any
 * helper — the helpers below build INPUTS and read OUTPUTS, never decisions.
 *
 * No AI, no model API, no network: classification is forced heuristic-only and
 * every module under test is pure.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { resolveAskingPriceSignal } from "@/lib/domain/seller-flow/monetary-understanding.js";
import {
  extractSellerFacts,
  extractionToResolverFacts,
} from "@/lib/domain/seller-flow/extract-seller-facts.js";
import { normalizeClassificationContract } from "@/lib/domain/seller-flow/normalize-classification-contract.js";
import { resolveSellerAuthorityState } from "@/lib/domain/seller-flow/seller-authority-state.js";
import {
  FACT_RESOLUTION,
  IDENTITY_STATES,
  INTEREST_STATES,
  resolveSellerConversationState,
} from "@/lib/domain/seller-flow/resolve-seller-conversation-state.js";
import {
  ACQUISITION_OBJECTIVES,
  resolveSellerNextBestAction,
} from "@/lib/domain/seller-flow/resolve-seller-next-best-action.js";
import { resolveSellerResponseStrategy } from "@/lib/domain/seller-flow/resolve-seller-response-strategy.js";
import {
  NEXT_ACTIONS,
  resolveSellerStageTransition,
} from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import {
  loadSellerDealState,
  persistSellerTransitionArtifacts,
} from "@/lib/domain/seller-flow/persist-seller-transition.js";
import { makeAcquisitionOpportunityStore } from "../helpers/acquisition-opportunity-store.mjs";

const NOW = "2026-07-24T00:00:00.000Z";
const THREAD = "+15551230000";

/** Run the real deterministic chain for one turn. Builds inputs only. */
async function runTurn(message, {
  known_facts = {},
  stage_before = null,
  negotiation_state = null,
  contract_state = null,
  ade_snapshot = null,
  underwriting = null,
  source_message_id = "msg-1",
} = {}) {
  const classification = await classify(message, null, { heuristicOnly: true });
  const contract = normalizeClassificationContract({
    classification,
    message,
    messageId: source_message_id,
    threadId: THREAD,
  }).contract;

  const price_signal = resolveAskingPriceSignal(message, { sourceMessageId: source_message_id });
  const extraction = extractSellerFacts({
    message,
    sourceMessageId: source_message_id,
    priceSignal: price_signal,
    now: NOW,
  });
  const projected = extractionToResolverFacts(extraction);

  const price_clarification_required =
    price_signal.needs_clarification === true && price_signal.asking_price == null;
  const new_facts = {
    ...projected,
    asking_price: price_clarification_required
      ? null
      : price_signal.asking_price ?? contract.extracted_facts.asking_price ?? null,
    ...(price_clarification_required ? { asking_price_needs_clarification: true } : {}),
    occupancy_status: contract.extracted_facts.tenant_occupied
      ? "tenant_occupied"
      : projected.occupancy_status || null,
  };

  const authority_state = resolveSellerAuthorityState({
    message,
    known_facts,
    new_facts,
    contract_state,
  });

  const conversation_state = resolveSellerConversationState({
    contract,
    known_facts,
    new_facts,
    negotiation_state,
    contract_state,
    ade_snapshot,
    underwriting,
    message,
    stage_before,
    now: NOW,
  });

  const next_best_action = resolveSellerNextBestAction(conversation_state);

  const transition = resolveSellerStageTransition({
    stage_before,
    known_facts,
    new_facts,
    intent: contract.normalized_intent,
    classification_confidence: classification.confidence,
    negotiation_state,
    contract_state,
    ade_result: ade_snapshot ? { sufficient_facts: true, underwriting_ready: true } : null,
    source_message_id,
    authority_state,
    now: NOW,
  });

  const response_strategy = resolveSellerResponseStrategy({
    conversation_state,
    next_best_action,
    underwriting,
    ade_snapshot,
  });

  // Mirror of the ONLY template authority production actually hands to
  // executeInboundAutomationDecision (process-seller-inbound-message.js
  // `transitionDirective`). The raw `transition.required_template_use_case` is
  // NOT what ships: when V2 withholds the reply the whole directive is
  // dropped. Invariants must be asserted against this effective value.
  const v2_withholds_reply = Boolean(
    response_strategy.no_reply ||
      response_strategy.human_review_required ||
      response_strategy.suppression_required
  );
  const effective_template_use_case =
    transition.advanced && !transition.review_required && !transition.contactability_patch && !v2_withholds_reply
      ? response_strategy.template_use_case || transition.required_template_use_case
      : null;

  return {
    classification, contract, price_signal, extraction, new_facts,
    authority_state, conversation_state, next_best_action, transition, response_strategy,
    v2_withholds_reply, effective_template_use_case,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Basic acquisition discovery (multi-turn, real persistence)
// ══════════════════════════════════════════════════════════════════════════

test("multi-turn discovery preserves ownership, interest and price through real persistence", async () => {
  const supabase = makeAcquisitionOpportunityStore();
  const messages = ["Yes, I own it.", "I might sell.", "I'd want $285,000."];
  const askedObjectives = [];
  let stage = null;
  let midReload = null;

  for (const [index, message] of messages.entries()) {
    const deal = await loadSellerDealState({
      threadKey: THREAD, propertyId: "prop-1", ownerId: "own-1", supabaseClient: supabase,
    });
    const turn = await runTurn(message, {
      known_facts: deal?.known_facts || {},
      stage_before: stage,
      negotiation_state: deal?.negotiation_state || null,
      contract_state: deal?.contract_state || null,
      source_message_id: `msg-${index + 1}`,
    });

    await persistSellerTransitionArtifacts({
      transition: turn.transition,
      threadKey: THREAD, propertyId: "prop-1", ownerId: "own-1",
      intent: turn.contract.normalized_intent,
      inboundEventId: `msg-${index + 1}`,
      supabaseClient: supabase,
      priceSignal: turn.price_signal,
    });
    stage = turn.transition.stage_after;
    askedObjectives.push(turn.next_best_action.objective);

    // After Turn 2 ("I might sell.") — stop and assert durable interest.
    if (index === 1) {
      midReload = await loadSellerDealState({
        threadKey: THREAD, propertyId: "prop-1", ownerId: "own-1", supabaseClient: supabase,
      });
      assert.equal(midReload.known_facts.ownership_status, "confirmed", "ownership survives Turn 2 reload");
      assert.ok(
        ["interested", "conditional"].includes(String(midReload.known_facts.interest || "")),
        `seller interest must be durable after "I might sell." — got ${midReload.known_facts.interest}`
      );
      assert.ok(
        !(midReload.known_facts.asking_price?.value > 0),
        "asking price must still be missing after Turn 2"
      );

      const midState = resolveSellerConversationState({
        contract: { normalized_intent: "latent_interest", ownership_signal: "confirmed" },
        known_facts: midReload.known_facts,
        stage_before: stage,
        now: NOW,
      });
      assert.notEqual(midState.interest, INTEREST_STATES.UNCLEAR, "interest must not be unclear after Turn 2");
      assert.equal(midState.identity.owner_confirmed, true);
      assert.equal(midState.acquisition.asking_price.resolution, FACT_RESOLUTION.MISSING);

      const midNba = resolveSellerNextBestAction(midState);
      assert.notEqual(
        midNba.objective,
        ACQUISITION_OBJECTIVES.DISCOVER_INTEREST,
        "next-best action must NOT re-ask seller interest after durable conditional interest"
      );
    }
  }

  const final = await loadSellerDealState({
    threadKey: THREAD, propertyId: "prop-1", ownerId: "own-1", supabaseClient: supabase,
  });

  // Facts genuinely survived reload through the production path.
  assert.equal(final.known_facts.ownership_status, "confirmed");
  assert.ok(
    ["interested", "conditional"].includes(String(final.known_facts.interest || "")),
    `interest must survive Turn 3 — got ${final.known_facts.interest}`
  );
  assert.equal(final.known_facts.asking_price.value, 285000);
  assert.ok(midReload, "Turn 2 mid-reload checkpoint must have run");

  const state = resolveSellerConversationState({
    contract: { normalized_intent: "asking_price_provided", ownership_signal: "confirmed" },
    known_facts: final.known_facts,
    stage_before: stage,
    now: NOW,
  });
  assert.equal(state.identity.owner_confirmed, true);
  assert.notEqual(state.interest, INTEREST_STATES.UNCLEAR);
  assert.equal(state.acquisition.asking_price.resolution, FACT_RESOLUTION.KNOWN);
  assert.ok(state.known_facts.includes("asking_price"));

  // Highest-priority remaining fact, and no repeated ownership / interest / price.
  const nba = resolveSellerNextBestAction(state);
  assert.equal(nba.objective, ACQUISITION_OBJECTIVES.DISCOVER_CONDITION);
  assert.notEqual(nba.objective, ACQUISITION_OBJECTIVES.VERIFY_OWNERSHIP);
  assert.notEqual(nba.objective, ACQUISITION_OBJECTIVES.DISCOVER_INTEREST);
  assert.notEqual(nba.objective, ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE);
  assert.ok(!askedObjectives.includes(ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE) ||
    askedObjectives.indexOf(ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE) < messages.length - 1);
  assert.ok(!nba.missing_facts.includes("asking_price"));
});

test("conditional-sale language is recognized as durable latent interest (not bare hedges)", async () => {
  const positive = [
    "I might sell.",
    "I may sell",
    "I might sell the property",
    "I'd consider selling",
    "I would consider it",
    "maybe I'd sell",
    "depends on the offer",
    "for the right price",
    "I could be interested",
  ];
  for (const message of positive) {
    const turn = await runTurn(message, {
      known_facts: { ownership_status: "confirmed" },
      stage_before: "offer_interest",
    });
    assert.ok(
      ["latent_interest", "seller_interested"].includes(turn.contract.normalized_intent) ||
        ["interested", "conditional"].includes(String(turn.new_facts.interest || "")),
      `"${message}" must yield latent/seller interest intent or interest fact — intent=${turn.contract.normalized_intent} facts=${JSON.stringify(turn.new_facts.interest)}`
    );
    assert.ok(
      turn.transition.facts_patch?.interest === "interested" ||
        turn.transition.facts_patch?.interest === "conditional" ||
        turn.conversation_state.interest !== INTEREST_STATES.UNCLEAR,
      `"${message}" must leave interest known in conversation/facts`
    );
  }

  // Bare hedges without sell context must remain unclear (no forced interest).
  for (const message of ["maybe", "possibly"]) {
    const turn = await runTurn(message, {
      known_facts: { ownership_status: "confirmed" },
      stage_before: "offer_interest",
    });
    assert.equal(turn.contract.normalized_intent, "unclear", `"${message}" alone must stay unclear`);
    assert.ok(
      !turn.new_facts.interest,
      `"${message}" alone must not invent an interest fact`
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Duplicate-question prevention
// ══════════════════════════════════════════════════════════════════════════

test("known price, condition and timeline are never re-asked", async () => {
  const known_facts = {
    ownership_status: "confirmed",
    interest: "interested",
    asking_price: { value: 285000 },
    condition_summary: "roof:standard",
    timeline: "soon",
  };
  const turn = await runTurn("Yes, still interested.", { known_facts, stage_before: "property_condition" });

  const forbidden = [
    ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE,
    ACQUISITION_OBJECTIVES.DISCOVER_CONDITION,
    ACQUISITION_OBJECTIVES.DISCOVER_TIMELINE,
  ];
  assert.ok(!forbidden.includes(turn.next_best_action.objective),
    `selected a resolved discovery objective: ${turn.next_best_action.objective}`);
  for (const key of ["asking_price", "property_condition", "timeline"]) {
    assert.equal(turn.conversation_state.acquisition[key].resolution, FACT_RESOLUTION.KNOWN);
    assert.ok(!turn.conversation_state.missing_facts.includes(key));
  }
});

test("each canonical known fact removes exactly its own discovery objective", async () => {
  const base = { ownership_status: "confirmed", interest: "interested" };
  const cases = [
    { fact: { asking_price: { value: 300000 } }, forbidden: ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE },
    { fact: { asking_price: { value: 300000 }, condition_summary: "hvac:standard" }, forbidden: ACQUISITION_OBJECTIVES.DISCOVER_CONDITION },
    { fact: { asking_price: { value: 300000 }, condition_summary: "hvac:standard", occupancy_status: "vacant" }, forbidden: ACQUISITION_OBJECTIVES.DISCOVER_OCCUPANCY },
  ];
  for (const { fact, forbidden } of cases) {
    const turn = await runTurn("Sounds good.", { known_facts: { ...base, ...fact }, stage_before: "property_condition" });
    assert.notEqual(turn.next_best_action.objective, forbidden);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Seller requests offer too early
// ══════════════════════════════════════════════════════════════════════════

test("'just make me an offer' preserves the request but never grants offer permission", async () => {
  const turn = await runTurn("Just make me an offer.", {
    known_facts: { ownership_status: "confirmed" },
    stage_before: "offer_interest",
  });

  assert.equal(turn.conversation_state.seller_requests_offer, true);
  assert.equal(turn.conversation_state.safety.offer_permission, false);
  assert.equal(turn.next_best_action.offer_allowed, false);
  assert.equal(turn.response_strategy.offer_allowed, false);
  assert.notEqual(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.PREPARE_OFFER);
  // Never re-asks the price the seller declined to name.
  assert.notEqual(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE);
  assert.equal(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.DISCOVER_CONDITION);
  assert.equal(turn.transition.next_action !== NEXT_ACTIONS.GENERATE_OFFER, true);
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Price + spouse
// ══════════════════════════════════════════════════════════════════════════

test("price plus spouse signoff retains both and blocks offer progression", async () => {
  const turn = await runTurn("I'd take $300,000 but my wife would have to agree.", {
    known_facts: { ownership_status: "confirmed", condition_summary: "roof:standard", occupancy_status: "vacant" },
    stage_before: "property_condition",
    ade_snapshot: { recommended_cash_offer: 240000, investor_ceiling_mid: 250000 },
    underwriting: { recommended_cash_offer: 240000, max_allowable_offer: 250000 },
  });

  // Price retained.
  assert.equal(turn.conversation_state.acquisition.asking_price.resolution, FACT_RESOLUTION.KNOWN);
  assert.equal(turn.conversation_state.acquisition.asking_price.value.value, 300000);
  // Signoff retained, with NO fabricated title claim.
  const signers = turn.authority_state.additional_signers_claimed;
  assert.equal(signers.length, 1);
  assert.equal(signers[0].relationship, "spouse");
  assert.equal(signers[0].basis, "claimed_decision_maker_approval");
  assert.equal(turn.authority_state.can_execute_alone, false);
  assert.equal(turn.authority_state.authority_verified, false);
  // Progression blocked everywhere, coherently.
  assert.equal(turn.authority_state.offer_progression_allowed, false);
  assert.equal(turn.conversation_state.safety.offer_permission, false);
  assert.equal(turn.response_strategy.offer_allowed, false);
  assert.notEqual(turn.transition.stage_after, "offer");
  assert.notEqual(turn.transition.next_action, NEXT_ACTIONS.GENERATE_OFFER);
  assert.equal(turn.transition.required_template_use_case, null);
  assert.ok(turn.response_strategy.prohibited_actions.includes("assume_sole_signing_authority"));
  // No duplicate price discovery.
  assert.notEqual(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE);
});

// ══════════════════════════════════════════════════════════════════════════
// 5. Ownership contradiction
// ══════════════════════════════════════════════════════════════════════════

test("later contradictory identity cannot leave stale owner-confirmed authority active", async () => {
  const turn = await runTurn("Actually it's my brother's.", {
    known_facts: { ownership_status: "confirmed", ownership_claim: "confirmed", interest: "interested" },
    stage_before: "offer_interest",
  });
  const state = turn.conversation_state;
  assert.notEqual(state.identity.state, IDENTITY_STATES.OWNER_CONFIRMED);
  assert.equal(state.safety.offer_permission, false);
  assert.ok(
    state.safety.human_review_required || state.safety.suppression_required,
    "contradictory identity must fail closed"
  );
});

test("explicit denial after a persisted confirmation resolves to conflicting identity", () => {
  const state = resolveSellerConversationState({
    contract: { normalized_intent: "unclear", ownership_signal: "unknown" },
    known_facts: { ownership_status: "confirmed" },
    new_facts: { ownership_claim: "denied" },
    now: NOW,
  });
  assert.equal(state.identity.state, IDENTITY_STATES.CONFLICTING);
  assert.equal(state.identity.owner_confirmed, false);
  assert.equal(resolveSellerNextBestAction(state).objective, ACQUISITION_OBJECTIVES.CLARIFY_IDENTITY);
});

// ══════════════════════════════════════════════════════════════════════════
// 6-7. Former owner / renter
// ══════════════════════════════════════════════════════════════════════════

test("former owner suppresses and produces no acquisition objective", async () => {
  const turn = await runTurn("I sold it last year.", { stage_before: "ownership_confirmation" });
  assert.equal(turn.conversation_state.identity.state, IDENTITY_STATES.FORMER_OWNER);
  assert.equal(turn.conversation_state.safety.suppression_required, true);
  assert.equal(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.SUPPRESS);
  assert.equal(turn.next_best_action.no_reply, true);
  assert.equal(turn.response_strategy.template_use_case, null);
  assert.equal(turn.response_strategy.no_reply, true);
});

test("renter does not enter the owner acquisition flow", async () => {
  const turn = await runTurn("I rent here.", { stage_before: "ownership_confirmation" });
  assert.equal(turn.conversation_state.identity.owner_confirmed, false);
  assert.equal(turn.conversation_state.safety.offer_permission, false);
  assert.ok(
    [ACQUISITION_OBJECTIVES.SUPPRESS, ACQUISITION_OBJECTIVES.HUMAN_REVIEW,
     ACQUISITION_OBJECTIVES.CLARIFY_IDENTITY, ACQUISITION_OBJECTIVES.VERIFY_OWNERSHIP]
      .includes(turn.next_best_action.objective),
    `renter routed to acquisition: ${turn.next_best_action.objective}`
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 8. Follow up later
// ══════════════════════════════════════════════════════════════════════════

test("requested later contact is honoured over immediate qualification", async () => {
  const turn = await runTurn("Maybe after the holidays.", {
    known_facts: { ownership_status: "confirmed" },
    stage_before: "offer_interest",
  });
  assert.equal(turn.conversation_state.interest, INTEREST_STATES.FOLLOW_UP_LATER);
  assert.equal(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.FOLLOW_UP_LATER);
  assert.notEqual(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE);
});

test("conversation state is deterministic and never reads the wall clock", () => {
  const inputs = {
    contract: { normalized_intent: "asking_price_provided", ownership_signal: "confirmed" },
    known_facts: { ownership_status: "confirmed", asking_price: { value: 300000 } },
    now: NOW,
  };
  const a = resolveSellerConversationState(inputs);
  const b = resolveSellerConversationState(inputs);
  assert.deepEqual(
    JSON.parse(JSON.stringify({ ...a, facts_snapshot: null })),
    JSON.parse(JSON.stringify({ ...b, facts_snapshot: null }))
  );
  assert.deepEqual(resolveSellerNextBestAction(a), resolveSellerNextBestAction(b));
});

// ══════════════════════════════════════════════════════════════════════════
// 9. Agent involved
// ══════════════════════════════════════════════════════════════════════════

test("listing/agent evidence is retained and blocks blind owner acquisition", async () => {
  const turn = await runTurn("It's listed with an agent.", {
    known_facts: { ownership_status: "confirmed", interest: "interested" },
    stage_before: "offer_interest",
  });
  assert.equal(turn.conversation_state.listing_status, "listed_with_agent");
  assert.equal(turn.conversation_state.agent_involved, true);
  assert.ok(
    [ACQUISITION_OBJECTIVES.HANDLE_AGENT_INVOLVEMENT, ACQUISITION_OBJECTIVES.HUMAN_REVIEW]
      .includes(turn.next_best_action.objective)
  );
  assert.equal(turn.response_strategy.offer_allowed, false);
});

test("listed/agent ready deal cannot persist contradictory automated-offer lifecycle", async () => {
  const supabase = makeAcquisitionOpportunityStore();
  const known_facts = {
    ownership_status: "confirmed",
    interest: "interested",
    asking_price: { value: 285000 },
    condition_summary: "roof:standard",
    occupancy_status: "vacant",
    listing_status: "listed_with_agent",
  };
  const ade = { recommended_cash_offer: 240000, sufficient_facts: true, underwriting_ready: true };

  const turn = await runTurn("The roof is fine, house is vacant.", {
    known_facts,
    stage_before: "asking_price",
    ade_snapshot: ade,
    underwriting: ade,
    source_message_id: "msg-listed-1",
  });

  // Conversation / NBA / strategy agree: agent path, no automated offer.
  assert.equal(turn.conversation_state.listing_status, "listed_with_agent");
  assert.equal(turn.conversation_state.agent_involved, true);
  assert.equal(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.HANDLE_AGENT_INVOLVEMENT);
  assert.equal(turn.next_best_action.offer_allowed, false);
  assert.equal(turn.next_best_action.human_review_required, true);
  assert.equal(turn.response_strategy.offer_allowed, false);
  assert.equal(turn.response_strategy.human_review_required, true);

  // Raw resolver must not leave GENERATE_OFFER / offer stage when listed.
  assert.notEqual(turn.transition.stage_after, "offer");
  assert.notEqual(turn.transition.next_action, NEXT_ACTIONS.GENERATE_OFFER);
  assert.ok(
    !["offer_reveal_cash", "initial_offer", "conditional_offer", "counter_offer", "final_offer"]
      .includes(turn.transition.required_template_use_case),
    `raw template must not be offer-bearing — got ${turn.transition.required_template_use_case}`
  );
  assert.equal(turn.transition.review_required, true);
  assert.equal(turn.effective_template_use_case, null, "V2 withholds outbound under agent review");
  assert.ok(turn.transition.listing_gate?.applied, "listing_gate must apply");

  await persistSellerTransitionArtifacts({
    transition: turn.transition,
    threadKey: THREAD, propertyId: "prop-listed", ownerId: "own-listed",
    intent: turn.contract.normalized_intent,
    inboundEventId: "msg-listed-1",
    supabaseClient: supabase,
    priceSignal: turn.price_signal,
  });

  const reloaded = await loadSellerDealState({
    threadKey: THREAD, propertyId: "prop-listed", ownerId: "own-listed", supabaseClient: supabase,
  });
  assert.equal(reloaded.known_facts.listing_status, "listed_with_agent");
  assert.equal(reloaded.known_facts.ownership_status, "confirmed");
  assert.ok(reloaded.known_facts.asking_price?.value > 0);

  // Effective transition that was persisted must agree with non-offer policy.
  // Storage mirror: opportunity stage / metadata must not claim GENERATE_OFFER.
  const rows = supabase.__rows();
  const opp = rows.find((r) => r.primary_property_id === "prop-listed" || r.property_id === "prop-listed") || rows[0];
  assert.ok(opp, "opportunity must be persisted");
  if (opp.acquisition_stage != null) {
    assert.notEqual(opp.acquisition_stage, "offer");
  }
  const metaNext = opp.metadata?.negotiation_state?.next_action || opp.metadata?.next_action;
  if (metaNext != null) {
    assert.notEqual(metaNext, NEXT_ACTIONS.GENERATE_OFFER);
  }
  assert.equal(turn.transition.next_action, NEXT_ACTIONS.HUMAN_REVIEW);
});

// ══════════════════════════════════════════════════════════════════════════
// 10. Probate / estate
// ══════════════════════════════════════════════════════════════════════════

test("probate is retained, authority stays unresolved and contract cannot progress", async () => {
  const turn = await runTurn("My mom passed away and the house is in probate.", {
    known_facts: { ownership_status: "confirmed", asking_price: { value: 300000 }, condition_summary: "roof:standard", occupancy_status: "vacant" },
    stage_before: "property_condition",
    ade_snapshot: { recommended_cash_offer: 240000 },
  });

  assert.equal(turn.authority_state.probate_detected, true);
  assert.equal(turn.authority_state.estate_context, true);
  assert.equal(turn.authority_state.can_execute_alone, false);
  assert.equal(turn.authority_state.authority_verified, false);
  assert.equal(turn.authority_state.offer_progression_allowed, false);
  assert.equal(turn.authority_state.contract_progression_allowed, false);
  assert.equal(turn.conversation_state.safety.contract_progression_permission, false);
  assert.notEqual(turn.transition.stage_after, "offer");
  assert.notEqual(turn.transition.next_action, NEXT_ACTIONS.GENERATE_CONTRACT);
  // Probate is an authority signal, never a suppression signal.
  assert.equal(turn.conversation_state.safety.suppression_required, false);
  assert.ok(turn.response_strategy.prohibited_actions.includes("assume_individual_estate_authority"));
  // Probate context is DURABLE — the next turn will not repeat the word.
  assert.equal(extractionToResolverFacts(turn.extraction).probate_detected, true);
});

test("deceased-owner phrasing variants all preserve estate authority context", async () => {
  const variants = [
    "my mother passed away",
    "my dad died",
    "it was my mom's house",
    "the owner passed away",
    "it's in probate",
    "That's my mom's house, she passed away.",
  ];
  for (const message of variants) {
    const turn = await runTurn(message, { stage_before: "ownership_confirmation" });
    assert.equal(turn.authority_state.estate_context, true, `no estate context for: ${message}`);
    assert.equal(turn.authority_state.offer_progression_allowed, false, `offer allowed for: ${message}`);
    assert.equal(turn.authority_state.can_execute_alone, false, `sole authority assumed for: ${message}`);
    const projected = extractionToResolverFacts(turn.extraction);
    assert.equal(
      projected.probate_detected === true || projected.heirship_detected === true,
      true,
      `estate context not durable for: ${message}`
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 11. Offer rejection
// ══════════════════════════════════════════════════════════════════════════

test("prior offer state survives a rejection and drives negotiation policy", async () => {
  const turn = await runTurn("That's way too low.", {
    known_facts: {
      ownership_status: "confirmed", interest: "interested",
      asking_price: { value: 300000 }, condition_summary: "roof:standard", occupancy_status: "vacant",
    },
    negotiation_state: { offers_made: 1, latest_offer: 240000, recommended_offer: 240000, authorized_offer_ceiling: 250000 },
    stage_before: "offer",
    ade_snapshot: { recommended_cash_offer: 240000 },
  });

  assert.equal(turn.conversation_state.negotiation.offer_already_made, true);
  assert.equal(turn.conversation_state.negotiation.last_offer, 240000);
  assert.equal(turn.conversation_state.negotiation.offer_rejected, true);
  assert.equal(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.HANDLE_PRICE_OBJECTION);
  assert.equal(turn.response_strategy.acquisition_context.recommended_cash_offer, 240000);
  assert.equal(turn.response_strategy.acquisition_context.seller_ask, 300000);
});

// ══════════════════════════════════════════════════════════════════════════
// 12. Multi-signal
// ══════════════════════════════════════════════════════════════════════════

test("one positive signal never erases conflicting ownership/authority/occupancy evidence", async () => {
  const turn = await runTurn("I'd sell for $300k but it's rented and my brother owns half.", {
    known_facts: { ownership_status: "confirmed" },
    stage_before: "offer_interest",
  });

  assert.equal(turn.conversation_state.acquisition.asking_price.resolution, FACT_RESOLUTION.KNOWN);
  assert.equal(turn.conversation_state.acquisition.asking_price.value.value, 300000);
  assert.equal(turn.conversation_state.acquisition.occupancy.value, "tenant_occupied");
  assert.equal(turn.authority_state.ownership_structure, "multiple_owners");
  assert.equal(turn.authority_state.can_execute_alone, false);
  assert.equal(turn.authority_state.offer_progression_allowed, false);
  assert.equal(turn.conversation_state.interest, INTEREST_STATES.INTERESTED);
  assert.equal(turn.conversation_state.safety.offer_permission, false);
});

test("ownership evidence survives when a different signal becomes primary", async () => {
  const turn = await runTurn("Yeah that's mine but I'm not interested.");
  // Ownership evidence retained structurally...
  assert.equal(extractionToResolverFacts(turn.extraction).ownership_claim, "confirmed");
  assert.notEqual(turn.contract.ownership_signal, "unknown");
  // ...alongside the not-interested disposition.
  assert.equal(turn.contract.interest_signal, "not_interested");
  assert.equal(turn.conversation_state.interest, INTEREST_STATES.NOT_INTERESTED);
});

// ══════════════════════════════════════════════════════════════════════════
// Ambiguous vs explicit money
// ══════════════════════════════════════════════════════════════════════════

test("ambiguous money is evidence only and never a canonical asking price", async () => {
  const turn = await runTurn("I'd want 285.", {
    known_facts: { ownership_status: "confirmed", interest: "interested" },
    stage_before: "asking_price",
  });

  assert.equal(turn.price_signal.asking_price, null);
  assert.equal(turn.price_signal.needs_clarification, true);
  // Evidence retained.
  assert.equal(turn.extraction.facts.asking_price_mention.value.raw_text, "285");
  assert.equal(turn.extraction.facts.asking_price_mention.value.canonical_asking_price, false);
  // Not canonical, clarification required, no offer readiness.
  const price = turn.conversation_state.acquisition.asking_price;
  assert.equal(price.resolution, FACT_RESOLUTION.MISSING);
  assert.equal(price.clarification_required, true);
  assert.equal(price.raw_mention, "285");
  assert.equal(turn.conversation_state.safety.offer_permission, false);
  assert.equal(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.CLARIFY_ASKING_PRICE);
  // The refused amount cannot satisfy the S3 milestone.
  assert.notEqual(turn.transition.stage_after, "offer");
  assert.equal(turn.transition.facts_patch.asking_price ?? null, null);
});

test("explicit money is canonical with no clarification", async () => {
  for (const message of ["I'd want $285,000.", "I'd want 285k."]) {
    const turn = await runTurn(message, {
      known_facts: { ownership_status: "confirmed", interest: "interested" },
      stage_before: "asking_price",
    });
    assert.equal(turn.price_signal.asking_price.value, 285000, message);
    assert.equal(turn.price_signal.needs_clarification, false, message);
    const price = turn.conversation_state.acquisition.asking_price;
    assert.equal(price.resolution, FACT_RESOLUTION.KNOWN, message);
    assert.equal(price.value.value, 285000, message);
    assert.notEqual(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.CLARIFY_ASKING_PRICE, message);
    assert.notEqual(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.DISCOVER_ASKING_PRICE, message);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Coherence: one turn, one effective business decision
// ══════════════════════════════════════════════════════════════════════════

test("authority block yields a single coherent decision across all layers", async () => {
  const turn = await runTurn("I'd take $300,000 but my wife would have to agree.", {
    known_facts: { ownership_status: "confirmed", condition_summary: "roof:standard", occupancy_status: "vacant" },
    stage_before: "property_condition",
    ade_snapshot: { recommended_cash_offer: 240000 },
    underwriting: { recommended_cash_offer: 240000 },
  });

  const objectiveWithholdsOffer = turn.next_best_action.objective !== ACQUISITION_OBJECTIVES.PREPARE_OFFER;
  assert.equal(objectiveWithholdsOffer, true);
  assert.notEqual(turn.transition.next_action, NEXT_ACTIONS.GENERATE_OFFER);
  assert.notEqual(turn.transition.required_template_use_case, "offer_reveal_cash");
  assert.equal(turn.response_strategy.template_use_case, null);
  assert.equal(turn.response_strategy.offer_allowed, false);
  assert.equal(turn.response_strategy.price_mention_allowed, false);
  assert.equal(turn.transition.review_required, true);
  assert.equal(turn.transition.authority_gate.applied, true);
  assert.equal(turn.transition.authority_gate.block_reason, "waiting_on_spouse");
});

test("a clean deal with full facts and resolved authority still reaches offer readiness", async () => {
  // A confidently-classified message, so this isolates the authority gate
  // rather than the classifier's low-confidence review path.
  const turn = await runTurn("Yes I own it.", {
    known_facts: {
      ownership_status: "confirmed", interest: "interested",
      asking_price: { value: 300000 }, condition_summary: "roof:standard",
      occupancy_status: "vacant", timeline: "soon", reason_for_selling: "relocating",
    },
    stage_before: "property_condition",
    ade_snapshot: { recommended_cash_offer: 240000, investor_ceiling_mid: 250000 },
    underwriting: { recommended_cash_offer: 240000, max_allowable_offer: 250000 },
  });

  assert.equal(turn.authority_state.offer_progression_allowed, true);
  assert.equal(turn.conversation_state.safety.offer_permission, true);
  assert.equal(turn.next_best_action.objective, ACQUISITION_OBJECTIVES.PREPARE_OFFER);
  assert.equal(turn.response_strategy.offer_allowed, true);
  assert.equal(turn.response_strategy.template_use_case, "offer_reveal_cash");
  assert.equal(turn.transition.authority_gate, null);
});

// ══════════════════════════════════════════════════════════════════════════
// Suppression precedence
// ══════════════════════════════════════════════════════════════════════════

test("suppression dominates every acquisition objective", () => {
  const state = resolveSellerConversationState({
    contract: { normalized_intent: "opt_out", opt_out_signal: true, ownership_signal: "confirmed" },
    known_facts: {
      ownership_status: "confirmed", interest: "interested",
      asking_price: { value: 300000 }, condition_summary: "roof:standard", occupancy_status: "vacant",
    },
    negotiation_state: { offers_made: 1, latest_offer: 240000 },
    ade_snapshot: { recommended_cash_offer: 240000 },
    now: NOW,
  });
  const nba = resolveSellerNextBestAction(state);
  assert.equal(nba.objective, ACQUISITION_OBJECTIVES.SUPPRESS);
  assert.equal(nba.suppression_required, true);
  assert.equal(nba.offer_allowed, false);
  const strategy = resolveSellerResponseStrategy({ conversation_state: state, next_best_action: nba });
  assert.equal(strategy.no_reply, true);
  assert.equal(strategy.template_use_case, null);
});

// ══════════════════════════════════════════════════════════════════════════
// Cross-layer consistency invariants
//
// The scenario tests above assert coherence one situation at a time. These
// assert the three forbidden disagreements DIRECTLY, as named invariants, over
// a matrix of situations — so a future change that makes any layer disagree
// fails here regardless of which scenario introduced it.
// ══════════════════════════════════════════════════════════════════════════

/** Objectives that mean "authority is not resolved yet". */
const AUTHORITY_OBJECTIVES = [
  ACQUISITION_OBJECTIVES.CLARIFY_AUTHORITY,
  ACQUISITION_OBJECTIVES.CLARIFY_REQUIRED_SIGNER,
];

/** Lifecycle stages at or beyond the first offer-bearing stage (S5). */
const OFFER_BEARING_STAGES = ["offer", "formal_contract", "disposition", "under_contract", "prepared_to_close", "closed"];

/** Actions that bind the company to an offer or a contract. */
const OFFER_BEARING_ACTIONS = [
  NEXT_ACTIONS.GENERATE_OFFER,
  NEXT_ACTIONS.GENERATE_CONTRACT,
  NEXT_ACTIONS.NEGOTIATE,
  NEXT_ACTIONS.AWAIT_SIGNATURE,
];

/** Template families that reveal or advance a monetary offer. */
const OFFER_TEMPLATES = ["offer_reveal_cash", "initial_offer", "conditional_offer", "counter_offer", "final_offer"];

const FULL_FACTS = {
  ownership_status: "confirmed",
  interest: "interested",
  asking_price: { value: 300000 },
  condition_summary: "roof:standard",
  occupancy_status: "vacant",
  timeline: "soon",
  reason_for_selling: "relocating",
};
const FULL_UNDERWRITING = {
  ade_snapshot: { recommended_cash_offer: 240000, investor_ceiling_mid: 250000 },
  underwriting: { recommended_cash_offer: 240000, max_allowable_offer: 250000 },
};

/**
 * Situations chosen to span every path that can reach an offer decision:
 * authority blocks of each kind, ambiguous money, suppression, review, an
 * already-advanced deal (monotonicity), and the clean authorized case.
 */
const INVARIANT_SCENARIOS = [
  { name: "spouse signoff", message: "I'd take $300,000 but my wife would have to agree.", known_facts: FULL_FACTS, stage_before: "property_condition", ...FULL_UNDERWRITING },
  { name: "spouse signoff already at offer stage", message: "I'd take $300,000 but my wife would have to agree.", known_facts: FULL_FACTS, stage_before: "offer", ...FULL_UNDERWRITING },
  { name: "probate", message: "My mom passed away and the house is in probate.", known_facts: FULL_FACTS, stage_before: "property_condition", ...FULL_UNDERWRITING },
  { name: "co-owner half", message: "My brother owns half of it.", known_facts: FULL_FACTS, stage_before: "property_condition", ...FULL_UNDERWRITING },
  { name: "trust", message: "The property is held in a family trust.", known_facts: FULL_FACTS, stage_before: "property_condition", ...FULL_UNDERWRITING },
  { name: "llc", message: "It's owned by my LLC.", known_facts: FULL_FACTS, stage_before: "property_condition", ...FULL_UNDERWRITING },
  { name: "ambiguous money", message: "I'd want 285.", known_facts: { ownership_status: "confirmed", interest: "interested" }, stage_before: "asking_price" },
  { name: "seller requests offer early", message: "Just make me an offer.", known_facts: { ownership_status: "confirmed" }, stage_before: "offer_interest" },
  { name: "opt out with full facts", message: "Stop texting me.", known_facts: FULL_FACTS, stage_before: "offer", ...FULL_UNDERWRITING },
  { name: "renter", message: "I rent here.", known_facts: {}, stage_before: "ownership_confirmation" },
  { name: "agent listed", message: "It's listed with an agent.", known_facts: FULL_FACTS, stage_before: "property_condition", ...FULL_UNDERWRITING },
  {
    name: "listed_with_agent durable facts ready",
    message: "Yes still interested.",
    known_facts: { ...FULL_FACTS, listing_status: "listed_with_agent" },
    stage_before: "property_condition",
    ...FULL_UNDERWRITING,
  },
  {
    name: "agent_involved durable facts ready",
    message: "Ok.",
    known_facts: { ...FULL_FACTS, listing_status: "agent_involved" },
    stage_before: "property_condition",
    ...FULL_UNDERWRITING,
  },
  { name: "offer rejected", message: "That's way too low.", known_facts: FULL_FACTS, stage_before: "offer", negotiation_state: { offers_made: 1, latest_offer: 240000, authorized_offer_ceiling: 250000 }, ...FULL_UNDERWRITING },
  { name: "clean authorized deal", message: "Yes I own it.", known_facts: FULL_FACTS, stage_before: "property_condition", ...FULL_UNDERWRITING },
];

test("INVARIANT: an authority-clarification objective never coexists with an offer-bearing transition action", async () => {
  for (const scenario of INVARIANT_SCENARIOS) {
    const { name, message, ...opts } = scenario;
    const turn = await runTurn(message, opts);
    if (!AUTHORITY_OBJECTIVES.includes(turn.next_best_action.objective)) continue;
    assert.ok(
      !OFFER_BEARING_ACTIONS.includes(turn.transition.next_action),
      `[${name}] next_best_action=${turn.next_best_action.objective} but transition.next_action=${turn.transition.next_action}`
    );
  }
});

test("INVARIANT: unresolved authority never advances the lifecycle into an offer-bearing stage", async () => {
  for (const scenario of INVARIANT_SCENARIOS) {
    const { name, message, ...opts } = scenario;
    const turn = await runTurn(message, opts);
    if (turn.authority_state.offer_progression_allowed !== false) continue;

    const enteredOfferStage =
      OFFER_BEARING_STAGES.includes(turn.transition.stage_after) &&
      !OFFER_BEARING_STAGES.includes(String(opts.stage_before || ""));
    assert.equal(
      enteredOfferStage, false,
      `[${name}] authority unresolved but stage advanced ${opts.stage_before} -> ${turn.transition.stage_after}`
    );

    // Monotonicity case: a deal already at S5+ cannot regress, so the ACTION
    // and TEMPLATE must be withheld instead.
    if (OFFER_BEARING_STAGES.includes(turn.transition.stage_after)) {
      assert.ok(
        !OFFER_BEARING_ACTIONS.includes(turn.transition.next_action),
        `[${name}] authority unresolved at ${turn.transition.stage_after} but action=${turn.transition.next_action}`
      );
      assert.ok(
        !OFFER_TEMPLATES.includes(turn.transition.required_template_use_case),
        `[${name}] authority unresolved but template=${turn.transition.required_template_use_case}`
      );
    }
    // Nothing offer-bearing may reach the outbound directive either.
    assert.ok(
      !OFFER_TEMPLATES.includes(turn.effective_template_use_case),
      `[${name}] authority unresolved but effective template=${turn.effective_template_use_case}`
    );
  }
});

test("INVARIANT: listed/agent state never coexists with automated-offer lifecycle persistence", async () => {
  for (const scenario of INVARIANT_SCENARIOS) {
    const { name, message, ...opts } = scenario;
    const turn = await runTurn(message, opts);
    const listed =
      turn.conversation_state.agent_involved === true ||
      ["listed_with_agent", "agent_involved"].includes(String(turn.conversation_state.listing_status || "")) ||
      ["listed_with_agent", "agent_involved"].includes(String(opts.known_facts?.listing_status || ""));
    if (!listed) continue;

    assert.equal(
      turn.response_strategy.offer_allowed, false,
      `[${name}] listed/agent but response_strategy.offer_allowed=true`
    );
    assert.notEqual(
      turn.transition.next_action, NEXT_ACTIONS.GENERATE_OFFER,
      `[${name}] listed/agent but next_action=GENERATE_OFFER`
    );
    assert.ok(
      !OFFER_BEARING_ACTIONS.includes(turn.transition.next_action),
      `[${name}] listed/agent but offer-bearing action=${turn.transition.next_action}`
    );
    assert.ok(
      !OFFER_TEMPLATES.includes(turn.transition.required_template_use_case),
      `[${name}] listed/agent but raw template=${turn.transition.required_template_use_case}`
    );
    assert.ok(
      !OFFER_TEMPLATES.includes(turn.effective_template_use_case),
      `[${name}] listed/agent but effective template=${turn.effective_template_use_case}`
    );
    // Must not newly enter offer stage from a pre-offer stage under listing policy.
    const enteredOfferStage =
      OFFER_BEARING_STAGES.includes(turn.transition.stage_after) &&
      !OFFER_BEARING_STAGES.includes(String(opts.stage_before || ""));
    assert.equal(
      enteredOfferStage, false,
      `[${name}] listed/agent advanced into offer stage ${opts.stage_before} -> ${turn.transition.stage_after}`
    );
  }
});

test("INVARIANT: offer_allowed=false never coexists with an offer-revealing template", async () => {
  for (const scenario of INVARIANT_SCENARIOS) {
    const { name, message, ...opts } = scenario;
    const turn = await runTurn(message, opts);
    if (turn.response_strategy.offer_allowed !== false) continue;
    assert.ok(
      !OFFER_TEMPLATES.includes(turn.response_strategy.template_use_case),
      `[${name}] offer_allowed=false but response template=${turn.response_strategy.template_use_case}`
    );
    // The effective directive is what production actually ships downstream.
    assert.ok(
      !OFFER_TEMPLATES.includes(turn.effective_template_use_case),
      `[${name}] offer_allowed=false but effective template=${turn.effective_template_use_case}`
    );
    assert.equal(
      turn.response_strategy.price_mention_allowed, false,
      `[${name}] offer_allowed=false but price_mention_allowed=true`
    );
  }
});

test("INVARIANT: every layer agrees on offer permission for the same turn", async () => {
  for (const scenario of INVARIANT_SCENARIOS) {
    const { name, message, ...opts } = scenario;
    const turn = await runTurn(message, opts);
    const { conversation_state: state, next_best_action: nba, response_strategy: rs } = turn;

    // Authority is the floor: nothing above it may exceed it.
    if (turn.authority_state.offer_progression_allowed === false) {
      assert.equal(state.safety.offer_permission, false, `[${name}] conversation state exceeded authority`);
      assert.equal(nba.offer_allowed, false, `[${name}] NBA exceeded authority`);
      assert.equal(rs.offer_allowed, false, `[${name}] strategy exceeded authority`);
      assert.notEqual(nba.objective, ACQUISITION_OBJECTIVES.PREPARE_OFFER, `[${name}] NBA prepared an offer without authority`);
    }
    // The strategy may only ever NARROW the NBA, never widen it.
    if (nba.offer_allowed === false) {
      assert.equal(rs.offer_allowed, false, `[${name}] strategy widened NBA offer permission`);
    }
    // Suppression is absolute at every layer.
    if (state.safety.suppression_required) {
      assert.equal(nba.suppression_required, true, `[${name}] NBA dropped suppression`);
      assert.equal(rs.no_reply, true, `[${name}] strategy replied under suppression`);
      assert.equal(rs.template_use_case, null, `[${name}] strategy selected a template under suppression`);
    }
    // PREPARE_OFFER is the only objective that may carry offer permission.
    if (rs.offer_allowed === true) {
      assert.ok(
        [ACQUISITION_OBJECTIVES.PREPARE_OFFER, ACQUISITION_OBJECTIVES.NEGOTIATE, ACQUISITION_OBJECTIVES.HANDLE_PRICE_OBJECTION,
         ACQUISITION_OBJECTIVES.CONTRACT_NEXT_STEP].includes(nba.objective),
        `[${name}] offer permitted for non-offer objective ${nba.objective}`
      );
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// No AI anywhere in the V2 decision path
// ══════════════════════════════════════════════════════════════════════════

test("the V2 decision chain runs with network access removed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network access is forbidden in the deterministic seller path");
  };
  try {
    const turn = await runTurn("I'd take $300,000 but my wife would have to agree.", {
      known_facts: { ownership_status: "confirmed" },
      stage_before: "offer_interest",
    });
    assert.equal(turn.classification.source, "heuristic");
    assert.equal(turn.authority_state.offer_progression_allowed, false);
    assert.ok(turn.next_best_action.objective);
    assert.ok(turn.response_strategy.version);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
