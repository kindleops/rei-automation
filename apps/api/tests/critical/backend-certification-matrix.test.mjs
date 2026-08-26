// ─── backend-certification-matrix.test.mjs ───────────────────────────────────
// PERMANENT backend certification harness (established 2026-08-25).
//
// Runs the deterministic in-process inbound pipeline — classify →
// applyInboundAutomationDecision (± ownership-probe stage context) →
// resolveSellerStageTransition — over the adversarial seller-message matrix
// and asserts BOTH halves of every scenario:
//   A. what Reivesti UNDERSTANDS (intents, extracted price/addresses), and
//   B. what Reivesti DOES (reply/review/no-reply decision, suppression scope,
//      resolver disposition/contactability, coverage guarantees).
//
// Global invariants enforced across EVERY scenario:
//   1. No silent terminals: every decision carries a coverage_state other
//      than missing_coverage and a concrete scheduled_next_action.
//   2. Suppression allowlist: should_suppress_contact may only be true for
//      audit_reason opt_out or wrong_number — never for sold/not-interested/
//      compound/new-property messages (wrong-scope suppression = 0).
//   3. Price hygiene: seller_state.price_mentioned is null unless the
//      scenario states a real price (street numbers/times/phones are never
//      monetary values).
//
// Stages that need infrastructure (queue claim/dispatch/delivery/retries/
// bursts/idempotency ledger) are certified by their own critical suites —
// queue-*, delivery-*, burst-*, campaign-*, inbound-cancellation-policy-scope,
// supabase-compliance-send-boundary — this file is the semantic spine.
//
// Deterministic only: heuristicOnly classification, no network, no AI, no DB.
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";

const THREAD = "+15550100777";
const S1_CONTEXT = {
  latestThreadContext: { summary: { conversation_stage: "ownership_check" } },
};

const SUPPRESSION_AUDIT_ALLOWLIST = new Set(["opt_out", "wrong_number"]);

/**
 * Scenario schema:
 *   id            — stable identifier (brief scenario numbers where mapped)
 *   message       — inbound seller SMS body
 *   s1            — run with ownership-probe stage context
 *   expect:
 *     primary_any     — allowed primary_intent values
 *     matched_incl    — intents that must appear in matched_intents
 *     price           — exact seller_state.price_mentioned (default null)
 *     addresses_min   — minimum extracted address candidates
 *     suppress        — required should_suppress_contact (default false)
 *     review          — required should_mark_human_review (when stated)
 *     queue           — required should_queue_reply (when stated)
 *     engaged         — review OR queue must be true (never a bare drop)
 *     audit_any       — allowed audit_reason values
 *     next_any        — allowed next_action values
 */
const SCENARIOS = [
  // ── Declines / not-for-sale family (brief 1, 7, 11) ───────────────────────
  { id: "S01_not_for_sale", message: "Not for sale.", s1: true,
    expect: { primary_any: ["not_interested"], audit_any: ["s1_not_for_sale_advance_with_followup", "not_interested"], next_any: ["schedule_later_followup", "do_not_reply"] } },
  { id: "S07_not_interested", message: "Not interested, thanks",
    expect: { primary_any: ["not_interested"], audit_any: ["s1_not_for_sale_advance_with_followup", "not_interested"] } },
  { id: "S08_not_now_next_year", message: "Not right now, maybe next year",
    expect: { primary_any: ["need_time", "not_interested"], engaged_or_followup: true } },

  // ── The reported defect family (brief 2, 3, 49) ───────────────────────────
  { id: "S02_decline_plus_new_address", message: "No that property is not for sale. But what would you pay for 456 Oak Ave?",
    expect: { primary_any: ["not_interested"], matched_incl: ["asks_offer"], addresses_min: 1, review: true, audit_any: ["new_property_opportunity"] } },
  { id: "S02b_decline_plus_new_address_S1", message: "No that property is not for sale. But what would you pay for 456 Oak Ave?", s1: true,
    expect: { review: true, audit_any: ["new_property_opportunity"] } },
  { id: "S02c_decline_offer_same_property", message: "Not for sale. But what would you pay for it?",
    expect: { matched_incl: ["asks_offer"], engaged: true, audit_any: ["declined_but_asks_offer"] } },
  { id: "S03_sold_plus_other_property", message: "I sold 123 Main, but I own 456 Oak and might sell that one",
    expect: { primary_any: ["sold_property"], review: true, audit_any: ["sold_with_new_opportunity"] } },
  { id: "S03b_sold_plain", message: "I already sold that house",
    expect: { primary_any: ["sold_property"], audit_any: ["property_sold"], next_any: ["disposition_property_sold"] } },
  { id: "S03c_sold_year", message: "Sold it in 2019",
    expect: { primary_any: ["sold_property"], audit_any: ["property_sold"] } },

  // ── Wrong person / wrong property (brief 4, 5, 6) ─────────────────────────
  { id: "S04_wrong_property_corrected", message: "You have the wrong property. Mine is 2711 Degen Dr. Bonita CA 91902",
    expect: { primary_any: ["property_correction", "wrong_number"], engaged_or_suppressed: true, addresses_min: 1 } },
  { id: "S05_wrong_person", message: "You have the wrong person",
    expect: { primary_any: ["wrong_number"], suppress: true, audit_any: ["wrong_number"], next_any: ["archive_wrong_number"] } },
  { id: "S06_wrong_person_seller_signal", message: "Wrong person, but I might sell 123 Oak Street myself",
    expect: { review: true, audit_any: ["wrong_person_with_seller_signal"] } },

  // ── Short/ambiguous replies (brief 9-12, 41-44, 61) ───────────────────────
  { id: "S09_maybe", message: "Maybe", expect: { engaged: true } },
  { id: "S10_yes", message: "Yes", expect: { engaged: true } },
  { id: "S11_no", message: "No", expect: { not_silent_only: true } },
  { id: "S12_sure", message: "Sure", expect: { engaged: true } },
  { id: "S42_emoji", message: "👍", expect: { not_silent_only: true } },
  { id: "S43_typos", message: "am intrested in seling the hosue", expect: { not_silent_only: true } },
  { id: "S44_sarcasm", message: "sure, I'll just GIVE you my house lol", expect: { engaged: true } },
  { id: "S62_conflicting", message: "Yes and no. Not interested but maybe.", expect: { not_silent_only: true } },

  // ── Identity questions (brief 13, 14) ─────────────────────────────────────
  { id: "S13_who_is_this", message: "Who is this?", expect: { primary_any: ["who_is_this"], engaged: true } },
  { id: "S14_how_got_number", message: "How did you get my number?", expect: { primary_any: ["who_is_this", "info_request"], engaged: true } },

  // ── Offers / prices (brief 15-19) ─────────────────────────────────────────
  { id: "S15_what_pay", message: "What will you pay?", expect: { primary_any: ["asks_offer"], engaged: true } },
  { id: "S16_make_offer", message: "Make me an offer", expect: { primary_any: ["asks_offer"], engaged: true } },
  { id: "S17_price_given", message: "I want 150k for it",
    expect: { primary_any: ["asking_price_provided"], price: 150000, engaged: true } },
  { id: "S18_counter_floor", message: "Can't take less than 200k",
    expect: { primary_any: ["asking_price_provided"], price: 200000, engaged: true } },
  { id: "S18b_would_take", message: "I'd take 250,000",
    expect: { primary_any: ["asking_price_provided"], price: 250000, engaged: true } },

  // ── Contact preferences / timing (brief 20-23) ────────────────────────────
  { id: "S20_call_me", message: "Call me", expect: { primary_any: ["callback_requested"], engaged: true } },
  { id: "S21_call_tomorrow", message: "Call me tomorrow", expect: { primary_any: ["callback_requested"], engaged: true } },
  { id: "S22_text_next_month", message: "Text me next month", expect: { primary_any: ["need_time", "callback_requested"], engaged_or_followup: true } },
  { id: "S23_spouse_handles", message: "My wife handles the sale, talk to her", expect: { not_silent_only: true } },

  // ── Listing / occupancy / estate (brief 24-30) ────────────────────────────
  { id: "S25_listed", message: "It's listed with a realtor already", expect: { not_silent_only: true } },
  { id: "S26_under_contract", message: "It's under contract already", expect: { not_silent_only: true } },
  { id: "S27_vacant", message: "The house has been vacant for a year", expect: { not_silent_only: true } },
  { id: "S28_tenant", message: "Tenants live there right now", expect: { primary_any: ["tenant_occupied"], engaged: true } },
  { id: "S29_inherited", message: "I inherited it from my mother last year", expect: { engaged: true } },
  { id: "S30_portfolio", message: "I own several rentals in that area, might sell a couple", expect: { engaged_or_followup: true } },

  // ── Addresses (brief 31-35) ───────────────────────────────────────────────
  { id: "S31_partial_address", message: "I'm on Oak Street", expect: { not_silent_only: true } },
  { id: "S34_multiple_addresses", message: "I want to sell 123 Main St and 456 Oak Ave",
    expect: { addresses_min: 2, engaged_or_followup: true } },

  // ── Compliance (brief 36-38, 46; Cases C/D) ───────────────────────────────
  { id: "S36_stop", message: "STOP",
    expect: { primary_any: ["opt_out"], suppress: true, audit_any: ["opt_out"] } },
  { id: "S37_stop_texting", message: "Stop texting me",
    expect: { primary_any: ["opt_out"], suppress: true } },
  { id: "S37b_stop_about_property", message: "Stop texting me about 123 Main",
    expect: { primary_any: ["opt_out"], suppress: true } },
  { id: "S38_remove_me", message: "Remove me from your list",
    expect: { primary_any: ["opt_out"], suppress: true } },
  { id: "S46_optout_plus_info", message: "STOP. Also I own 456 Oak Ave",
    expect: { primary_any: ["opt_out"], suppress: true } },

  // ── Hostility (brief 39, 40) ──────────────────────────────────────────────
  { id: "S39_profanity", message: "Fuck off with these texts",
    expect: { suppress_any: true, no_reply: true } },
  { id: "S40_threat", message: "I'll sue you if you text me again",
    expect: { primary_any: ["hostile_or_legal", "opt_out"], no_reply: true } },

  // ── Legal / authority lanes ───────────────────────────────────────────────
  { id: "L01_irs_lien", message: "I want to sell but there is an IRS lien on it",
    expect: { primary_any: ["lien_tax_issue"], review: true } },
  { id: "L02_probate_compound", message: "Property is in probate, my sister is executor, and we want 150k for it",
    expect: { price: 150000, engaged: true } },
];

function decisionEngaged(decision) {
  return decision.should_queue_reply === true || decision.should_mark_human_review === true;
}

function decisionHasFollowup(decision) {
  return ["schedule_later_followup"].includes(decision.next_action);
}

const results = [];

for (const scenario of SCENARIOS) {
  test(`matrix ${scenario.id}: "${scenario.message}"`, async () => {
    const classification = await classify(scenario.message, null, { heuristicOnly: true });
    const decision = applyInboundAutomationDecision({
      message: scenario.message,
      threadKey: THREAD,
      propertyId: "prop-cert",
      classification,
      ...(scenario.s1 ? S1_CONTEXT : {}),
    });
    const expect = scenario.expect || {};
    results.push({ id: scenario.id, classification, decision });

    // ── A. interpretation ────────────────────────────────────────────────
    if (expect.primary_any) {
      assert.ok(
        expect.primary_any.includes(classification.primary_intent),
        `primary ${classification.primary_intent} not in ${expect.primary_any}`
      );
    }
    for (const intent of expect.matched_incl || []) {
      assert.ok(
        classification.matched_intents.includes(intent) ||
          (classification.secondary_intents || []).includes(intent),
        `expected component ${intent} in ${JSON.stringify(classification.matched_intents)}`
      );
    }
    const price = classification.seller_state?.price_mentioned ?? null;
    if ("price" in expect) assert.equal(Number(price), expect.price, `price ${price}`);
    else assert.equal(price, null, `unexpected price ${price} for "${scenario.message}"`);
    if (expect.addresses_min) {
      assert.ok(
        (classification.address_signals || []).length >= expect.addresses_min,
        `addresses ${JSON.stringify(classification.address_signals)}`
      );
    }

    // ── B. action ────────────────────────────────────────────────────────
    const expected_suppress = expect.suppress === true;
    if (!expect.suppress_any) {
      assert.equal(
        decision.should_suppress_contact,
        expected_suppress,
        `suppress=${decision.should_suppress_contact}, audit=${decision.audit_reason}`
      );
    }
    if (expect.review === true) assert.equal(decision.should_mark_human_review, true, decision.audit_reason);
    if (expect.queue === true) assert.equal(decision.should_queue_reply, true, decision.audit_reason);
    if (expect.no_reply === true) assert.equal(decision.should_queue_reply, false, decision.audit_reason);
    if (expect.engaged === true) {
      assert.ok(decisionEngaged(decision), `expected engagement, got ${JSON.stringify(decision.next_action)}`);
    }
    if (expect.engaged_or_followup === true) {
      assert.ok(
        decisionEngaged(decision) || decisionHasFollowup(decision),
        `expected engagement or follow-up, got ${decision.next_action}`
      );
    }
    if (expect.engaged_or_suppressed === true) {
      assert.ok(
        decisionEngaged(decision) || decision.should_suppress_contact,
        `expected engagement or suppression, got ${decision.next_action}`
      );
    }
    if (expect.audit_any) {
      assert.ok(
        expect.audit_any.includes(decision.audit_reason),
        `audit ${decision.audit_reason} not in ${expect.audit_any}`
      );
    }
    if (expect.next_any) {
      assert.ok(
        expect.next_any.includes(decision.next_action),
        `next ${decision.next_action} not in ${expect.next_any}`
      );
    }

    // ── Global invariants (every scenario, including not_silent_only) ────
    assert.ok(decision.coverage_state, "coverage_state missing");
    assert.notEqual(decision.coverage_state, "missing_coverage", "silent terminal");
    assert.ok(decision.scheduled_next_action, "scheduled_next_action missing");
    if (decision.should_suppress_contact) {
      assert.ok(
        SUPPRESSION_AUDIT_ALLOWLIST.has(decision.audit_reason),
        `wrong-scope suppression: ${decision.audit_reason}`
      );
    }
  });
}

// ── Resolver scope matrix: state mutations per blocking/disengaging intent ──
test("matrix resolver: suppression scope + nurture windows", () => {
  const cases = [
    { intent: "opt_out", contactability: "opted_out" },
    { intent: "wrong_number", contactability: "invalid_number", disposition: "wrong_number" },
    { intent: "wrong_person", contactability: "do_not_text", disposition: "wrong_person" },
    { intent: "sold_property", contactability: null, disposition: "sold" },
    { intent: "former_owner_respondent", contactability: null, disposition: "sold" },
    { intent: "property_specific_non_owner", contactability: null, disposition: "unqualified" },
  ];
  for (const c of cases) {
    const t = resolveSellerStageTransition({ intent: c.intent, stage_before: "S1_OWNERSHIP_CONFIRMATION" });
    if (c.contactability === null) {
      assert.equal(t.contactability_patch, null, `${c.intent} must not touch contactability`);
    } else {
      assert.equal(t.contactability_patch?.contactability_status, c.contactability, c.intent);
    }
    if (c.disposition) assert.equal(t.disposition, c.disposition, c.intent);
    assert.equal(t.advanced, false, c.intent);
  }

  // Disengaging intents nurture (never suppress, never regress stage).
  const nurture = resolveSellerStageTransition({ intent: "not_interested", stage_before: "S2_OFFER_INTEREST" });
  assert.equal(nurture.contactability_patch ?? null, null);
  assert.ok(nurture.follow_up?.create === true, JSON.stringify(nurture.follow_up));
  assert.ok(nurture.stage_after_number >= 2, "no stage regression on decline");
});

// ── Certification metrics summary (printed for the report) ──────────────────
test("matrix metrics summary", () => {
  const total = results.length;
  const suppressed = results.filter((r) => r.decision.should_suppress_contact).length;
  const review = results.filter((r) => r.decision.should_mark_human_review).length;
  const replied = results.filter((r) => r.decision.should_queue_reply).length;
  const deliberate_no_reply = results.filter(
    (r) =>
      !r.decision.should_suppress_contact &&
      !r.decision.should_mark_human_review &&
      !r.decision.should_queue_reply
  ).length;
  const silent = results.filter(
    (r) => !r.decision.coverage_state || !r.decision.scheduled_next_action
  ).length;
  const wrong_scope_suppressions = results.filter(
    (r) => r.decision.should_suppress_contact && !SUPPRESSION_AUDIT_ALLOWLIST.has(r.decision.audit_reason)
  ).length;

  console.log(
    `CERTIFICATION_MATRIX_METRICS ${JSON.stringify({
      total,
      replied,
      review,
      suppressed,
      deliberate_no_reply,
      silent_drops: silent,
      wrong_scope_suppressions,
    })}`
  );
  assert.equal(silent, 0, "silent drops must be zero");
  assert.equal(wrong_scope_suppressions, 0, "wrong-scope suppressions must be zero");
  assert.equal(total, SCENARIOS.length);
});
