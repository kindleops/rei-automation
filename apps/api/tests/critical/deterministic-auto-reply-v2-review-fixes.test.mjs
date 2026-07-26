/**
 * PR #53 CodeRabbit review-fix regressions.
 * Each case maps to a verified finding; production functions only.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
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
import { transitionQualifiesForOpportunity } from "@/lib/domain/seller-flow/persist-seller-transition.js";
import { resolveV2ReplyWithhold } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { OPERATIONAL_STATUS_CODES as OPS } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

const NOW = "2026-07-24T00:00:00.000Z";

// ══════════════════════════════════════════════════════════════════════════
// Finding 1 — Negated seller interest never becomes durable positive interest
// ══════════════════════════════════════════════════════════════════════════

test("F1: negated sell language never extracts durable interested/conditional interest", () => {
  const negatives = [
    "I don't want to sell.",
    "I do not want to sell.",
    "I never want to sell.",
    "I'm not looking to sell.",
    "I wouldn't consider selling.",
    "I am not considering selling.",
  ];
  for (const message of negatives) {
    const extraction = extractSellerFacts({ message, sourceMessageId: "n1", now: NOW });
    const projected = extractionToResolverFacts(extraction);
    assert.ok(
      !projected.interest || !["interested", "conditional"].includes(projected.interest),
      `negated phrase leaked interest=${projected.interest}: ${message}`
    );
  }
});

test("F1: positive controls still extract durable interest", () => {
  const positives = [
    { message: "I want to sell.", expect: "interested" },
    { message: "I'd consider selling.", expect: "conditional" },
    { message: "I might sell.", expect: "conditional" },
    { message: "I'd sell for the right price.", expect: ["interested", "conditional"] },
  ];
  for (const { message, expect } of positives) {
    const projected = extractionToResolverFacts(
      extractSellerFacts({ message, sourceMessageId: "p1", now: NOW })
    );
    const allowed = Array.isArray(expect) ? expect : [expect];
    assert.ok(
      allowed.includes(projected.interest),
      `"${message}" expected interest in ${allowed.join("|")}, got ${projected.interest}`
    );
  }
});

test("F1: negated interest does not imply ownership via engagement", () => {
  const state = resolveSellerConversationState({
    contract: { normalized_intent: "not_interested", ownership_signal: "unknown" },
    new_facts: extractionToResolverFacts(
      extractSellerFacts({ message: "I don't want to sell.", sourceMessageId: "n1", now: NOW })
    ),
    now: NOW,
  });
  assert.equal(state.interest, INTEREST_STATES.NOT_INTERESTED);
  assert.equal(state.identity.owner_confirmed, false);
});

// ══════════════════════════════════════════════════════════════════════════
// Finding 2 — Stale not-owner vs new positive ownership → conflict/review
// ══════════════════════════════════════════════════════════════════════════

test("F2: durable not_owner + later positive ownership claim is CONFLICTING, not silent NON_OWNER", () => {
  // Turn 1 durable denial (as would reload from seller_facts).
  const facts1 = extractionToResolverFacts(
    extractSellerFacts({
      message: "That's my brother's house.",
      sourceMessageId: "msg-1",
      now: NOW,
    })
  );
  assert.equal(facts1.ownership_claim, "denied");
  assert.equal(facts1.ownership_status, "not_owner");

  const known = { ownership_status: "not_owner", ownership_claim: "denied" };

  // Turn 2: explicit positive claim
  const t2facts = extractionToResolverFacts(
    extractSellerFacts({ message: "Actually I own it.", sourceMessageId: "msg-2", now: NOW })
  );
  assert.equal(t2facts.ownership_claim, "confirmed");

  const state = resolveSellerConversationState({
    contract: { normalized_intent: "ownership_confirmed", ownership_signal: "confirmed" },
    known_facts: known,
    new_facts: t2facts,
    now: NOW,
  });
  assert.equal(state.identity.state, IDENTITY_STATES.CONFLICTING);
  assert.equal(state.identity.owner_confirmed, false);
  assert.equal(state.identity.review_required, true);
  assert.equal(state.safety.human_review_required, true);

  const transition2 = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    known_facts: known,
    new_facts: t2facts,
    intent: "ownership_confirmed",
    classification_confidence: 0.9,
    source_message_id: "msg-2",
    now: NOW,
  });
  assert.equal(transition2.facts_patch.ownership_conflict, true);
  assert.equal(transition2.review_required, true);
  assert.notEqual(transition2.next_action, NEXT_ACTIONS.GENERATE_OFFER);
});

test("F2: wrong-number suppression is not auto-cleared by a later positive ownership claim", () => {
  // Prior wrong-number identity + durable denial remains suppressed path.
  // A later positive claim creates conflict/review — never auto-unsuppresses.
  const state = resolveSellerConversationState({
    contract: {
      normalized_intent: "ownership_confirmed",
      ownership_signal: "confirmed",
      wrong_number_signal: false,
    },
    known_facts: { ownership_status: "not_owner", ownership_claim: "denied" },
    new_facts: { ownership_claim: "confirmed" },
    now: NOW,
  });
  assert.equal(state.identity.state, IDENTITY_STATES.CONFLICTING);
  // No owner_confirmed → no offer permission; acquisition does not auto-progress.
  assert.equal(state.identity.owner_confirmed, false);
  assert.equal(state.safety.offer_permission, false);
});

// ══════════════════════════════════════════════════════════════════════════
// Finding 3 — Secondary opt-out must suppress
// ══════════════════════════════════════════════════════════════════════════

test("F3: secondary_signals.opt_out sets opt_out_signal and suppresses", () => {
  const contract = normalizeClassificationContract({
    classification: {
      primary_intent: "ownership_confirmed",
      secondary_intents: ["opt_out"],
      confidence: 0.9,
      compliance_flag: null,
    },
    message: "Yeah that's mine but please remove me",
    messageId: "m1",
    threadId: "+15550001111",
  }).contract;

  assert.equal(contract.ownership_signal, "confirmed");
  assert.equal(contract.opt_out_signal, true);
  assert.equal(contract.secondary_signals.opt_out, true);

  const state = resolveSellerConversationState({
    contract,
    new_facts: { ownership_claim: "confirmed" },
    now: NOW,
  });
  assert.equal(state.safety.suppression_required, true);
  const nba = resolveSellerNextBestAction(state);
  assert.equal(nba.suppression_required, true);
  assert.equal(nba.offer_allowed, false);
  const strategy = resolveSellerResponseStrategy({ conversation_state: state, next_best_action: nba });
  assert.equal(strategy.no_reply, true);
  assert.equal(strategy.suppression_required, true);
  assert.equal(strategy.template_use_case, null);
});

// ══════════════════════════════════════════════════════════════════════════
// Finding 4 — Denial facts must not create acquisition opportunities
// ══════════════════════════════════════════════════════════════════════════

test("F4: wrong-number / not-owner durable facts do not qualify a new opportunity", () => {
  const denialCases = [
    { ownership_status: "not_owner", ownership_claim: "denied" },
    { ownership_status: "wrong_number" },
    { ownership_status: "former_owner" },
    { ownership_status: "tenant" },
    { ownership_claim: "denied" },
  ];
  for (const facts of denialCases) {
    assert.equal(
      transitionQualifiesForOpportunity({
        facts_patch: facts,
        advanced: false,
        stage_after_number: 1,
      }),
      false,
      `denial facts should not create opportunity: ${JSON.stringify(facts)}`
    );
  }
  // Contactability patch (blocking intent path) also disqualifies.
  assert.equal(
    transitionQualifiesForOpportunity({
      facts_patch: { ownership_status: "confirmed" },
      contactability_patch: { contactability: "opted_out" },
      advanced: true,
      stage_after_number: 2,
    }),
    false
  );
});

test("F4: legitimate owner early-turn durable facts still qualify", () => {
  assert.equal(
    transitionQualifiesForOpportunity({
      facts_patch: { ownership_status: "confirmed", interest: "interested" },
      advanced: false,
      stage_after_number: 1,
    }),
    true
  );
  assert.equal(
    transitionQualifiesForOpportunity({
      facts_patch: { asking_price: { value: 250000 } },
      advanced: false,
      stage_after_number: 1,
    }),
    true
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Finding 5 — Strategy exception / null NBA fail closed
// ══════════════════════════════════════════════════════════════════════════

test("F5: suppression safety withholds even when response_strategy is null (throw path)", () => {
  const conversation_state = {
    safety: { suppression_required: true, human_review_required: false, no_reply_required: true },
  };
  assert.equal(
    resolveV2ReplyWithhold({ conversation_state, response_strategy: null }),
    true
  );
});

test("F5: human_review safety withholds even when response_strategy is null", () => {
  const conversation_state = {
    safety: { suppression_required: false, human_review_required: true, no_reply_required: false },
  };
  assert.equal(
    resolveV2ReplyWithhold({ conversation_state, response_strategy: null }),
    true
  );
});

test("F5: next_best_action-null equivalent (no strategy) withholds when safety says so", () => {
  assert.equal(
    resolveV2ReplyWithhold({
      conversation_state: { safety: { suppression_required: true } },
      response_strategy: null,
    }),
    true
  );
});

test("F5: safe state + successful strategy does not withhold solely from missing safety", () => {
  const conversation_state = {
    safety: { suppression_required: false, human_review_required: false, no_reply_required: false },
  };
  const response_strategy = {
    no_reply: false,
    human_review_required: false,
    suppression_required: false,
  };
  assert.equal(
    resolveV2ReplyWithhold({ conversation_state, response_strategy }),
    false
  );
  // Strategy still may withhold on its own.
  assert.equal(
    resolveV2ReplyWithhold({
      conversation_state,
      response_strategy: { no_reply: true, human_review_required: false, suppression_required: false },
    }),
    true
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Finding 6 — Inferred ownership signal honored
// ══════════════════════════════════════════════════════════════════════════

test("F6: secondary ownership_confirmed projects inferred and is honored as owner", () => {
  const contract = normalizeClassificationContract({
    classification: {
      primary_intent: "not_interested",
      secondary_intents: ["ownership_confirmed"],
      confidence: 0.9,
    },
    message: "Yeah that's mine but I'm not interested",
    messageId: "m1",
    threadId: "+15550002222",
  }).contract;

  assert.equal(contract.ownership_signal, "inferred");
  assert.equal(contract.interest_signal, "not_interested");

  const state = resolveSellerConversationState({
    contract,
    new_facts: { ownership_claim: "confirmed" },
    now: NOW,
  });
  assert.equal(state.identity.owner_confirmed, true);
  assert.equal(state.identity.state, IDENTITY_STATES.OWNER_CONFIRMED);
  assert.equal(state.interest, INTEREST_STATES.NOT_INTERESTED);

  const nba = resolveSellerNextBestAction(state);
  // Not-interested / nurture path — not re-asking ownership.
  assert.notEqual(nba.objective, ACQUISITION_OBJECTIVES.VERIFY_OWNERSHIP);
  assert.ok(
    [ACQUISITION_OBJECTIVES.FOLLOW_UP_LATER, ACQUISITION_OBJECTIVES.SUPPRESS, ACQUISITION_OBJECTIVES.HUMAN_REVIEW]
      .includes(nba.objective) || nba.objective === ACQUISITION_OBJECTIVES.FOLLOW_UP_LATER,
    `unexpected NBA for not-interested owner: ${nba.objective}`
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Finding 7 — review_required ⇔ NEEDS_REVIEW operational status
// ══════════════════════════════════════════════════════════════════════════

test("F7: authority / low-confidence / listing review transitions use NEEDS_REVIEW operational status", () => {
  // Spouse authority gate
  const spouse = resolveSellerStageTransition({
    stage_before: "property_condition",
    known_facts: {
      ownership_status: "confirmed",
      interest: "interested",
      asking_price: { value: 300000 },
      condition_summary: "roof:standard",
      occupancy_status: "vacant",
    },
    new_facts: {
      authority_claims: {
        authority_type: "spouse",
        can_execute_alone: false,
        requires_authority_review: true,
        additional_signers_claimed: [{ relationship: "spouse" }],
      },
    },
    intent: "asking_price_provided",
    classification_confidence: 0.95,
    ade_result: { sufficient_facts: true, underwriting_ready: true },
    authority_state: resolveSellerAuthorityState({
      message: "my wife would have to agree",
      new_facts: {
        authority_claims: {
          authority_type: "spouse",
          can_execute_alone: false,
          requires_authority_review: true,
          additional_signers_claimed: [{ relationship: "spouse" }],
        },
      },
    }),
    now: NOW,
  });
  if (spouse.review_required) {
    assert.equal(spouse.operational_status, OPS.NEEDS_REVIEW);
    assert.equal(spouse.next_action, NEXT_ACTIONS.HUMAN_REVIEW);
  }

  // Listing review
  const listed = resolveSellerStageTransition({
    stage_before: "asking_price",
    known_facts: {
      ownership_status: "confirmed",
      interest: "interested",
      asking_price: { value: 285000 },
      condition_summary: "ok",
      occupancy_status: "vacant",
      listing_status: "listed_with_agent",
    },
    new_facts: { listing_status: "listed_with_agent" },
    intent: "condition_disclosed",
    classification_confidence: 0.9,
    ade_result: { sufficient_facts: true, underwriting_ready: true },
    now: NOW,
  });
  assert.equal(listed.review_required, true);
  assert.equal(listed.operational_status, OPS.NEEDS_REVIEW);
  assert.equal(listed.next_action, NEXT_ACTIONS.HUMAN_REVIEW);

  // Ownership conflict
  const conflict = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    known_facts: { ownership_status: "not_owner" },
    new_facts: { ownership_claim: "confirmed", ownership_conflict: true },
    intent: "ownership_confirmed",
    classification_confidence: 0.9,
    now: NOW,
  });
  assert.equal(conflict.review_required, true);
  assert.equal(conflict.operational_status, OPS.NEEDS_REVIEW);
});

// ══════════════════════════════════════════════════════════════════════════
// Finding 8 — External authority verification clears conversational deadlock
// ══════════════════════════════════════════════════════════════════════════

test("F8: spouse/co-owner conversational block clears when signer gap is closed", () => {
  const claims = {
    authority_type: "spouse",
    authority_claimed: true,
    can_execute_alone: false,
    requires_authority_review: true,
    additional_signers_claimed: [{ relationship: "spouse", basis: "claimed_decision_maker_approval" }],
  };
  const blocked = resolveSellerAuthorityState({
    message: "my wife would have to agree",
    new_facts: { authority_claims: claims },
  });
  assert.equal(blocked.offer_progression_allowed, false);
  assert.equal(blocked.can_execute_alone, false);
  assert.ok(blocked.signer_gap > 0);

  const cleared = resolveSellerAuthorityState({
    message: "ok",
    known_facts: { authority_claims: claims },
    contract_state: { signer_count_confirmed: 2 },
  });
  assert.equal(cleared.offer_progression_allowed, true);
  assert.equal(cleared.can_execute_alone, true);
  assert.equal(cleared.signer_gap, 0);
});

test("F8: probate context remains while external authority verification clears progression block", () => {
  const blocked = resolveSellerAuthorityState({
    message: "My mom passed away and the house is in probate. I am the executor.",
    new_facts: {
      probate_detected: true,
      authority_claims: {
        authority_type: "executor",
        authority_claimed: true,
        requires_authority_review: true,
        can_execute_alone: false,
      },
    },
  });
  assert.equal(blocked.probate_detected, true);
  assert.equal(blocked.offer_progression_allowed, false);

  const verified = resolveSellerAuthorityState({
    message: "any update?",
    known_facts: {
      probate_detected: true,
      authority_claims: {
        authority_type: "executor",
        authority_claimed: true,
        requires_authority_review: true,
        can_execute_alone: false,
      },
    },
    contract_state: { authority_verified: true },
  });
  assert.equal(verified.probate_detected, true, "historical probate context must remain");
  assert.equal(verified.authority_verified, true);
  assert.equal(verified.offer_progression_allowed, true);
  assert.equal(verified.contract_progression_allowed, true);
  assert.equal(verified.block_reason, null);
});

test("F8: trust/LLC conversational risk clears only with external verification", () => {
  const claims = {
    authority_type: "trustee",
    authority_claimed: true,
    requires_authority_review: true,
    can_execute_alone: false,
  };
  const blocked = resolveSellerAuthorityState({
    message: "the property is in a trust and I am the trustee",
    new_facts: { authority_claims: claims },
  });
  assert.equal(blocked.offer_progression_allowed, false);

  const verified = resolveSellerAuthorityState({
    message: "docs attached",
    known_facts: { authority_claims: claims },
    contract_state: { authority_verified: true, authority_doc: true },
  });
  assert.equal(verified.offer_progression_allowed, true);
  assert.equal(verified.can_execute_alone, true);
});

// ══════════════════════════════════════════════════════════════════════════
// Finding 9 — invalid ADE offer must not leak NaN
// ══════════════════════════════════════════════════════════════════════════

test("F9: non-numeric ADE recommended_cash_offer falls through; never NaN", () => {
  const state = resolveSellerConversationState({
    contract: { normalized_intent: "asking_price_provided", ownership_signal: "confirmed" },
    known_facts: {
      ownership_status: "confirmed",
      interest: "interested",
      asking_price: { value: 300000 },
      condition_summary: "ok",
      occupancy_status: "vacant",
    },
    negotiation_state: { recommended_offer: 240000 },
    now: NOW,
  });
  const nba = resolveSellerNextBestAction(state);
  const strategy = resolveSellerResponseStrategy({
    conversation_state: state,
    next_best_action: nba,
    ade_snapshot: { recommended_cash_offer: "not-a-number" },
  });
  assert.notEqual(strategy.acquisition_context.recommended_cash_offer, Number.NaN);
  assert.ok(
    strategy.acquisition_context.recommended_cash_offer === null ||
      Number.isFinite(strategy.acquisition_context.recommended_cash_offer)
  );
  // Falls through to negotiation recommended_offer.
  assert.equal(strategy.acquisition_context.recommended_cash_offer, 240000);
});

test("F9: missing offer sources yield null, not NaN", () => {
  const state = resolveSellerConversationState({
    contract: { normalized_intent: "unclear", ownership_signal: "unknown" },
    now: NOW,
  });
  const nba = resolveSellerNextBestAction(state);
  const strategy = resolveSellerResponseStrategy({
    conversation_state: state,
    next_best_action: nba,
    ade_snapshot: { recommended_cash_offer: undefined },
  });
  assert.equal(strategy.acquisition_context.recommended_cash_offer, null);
});
