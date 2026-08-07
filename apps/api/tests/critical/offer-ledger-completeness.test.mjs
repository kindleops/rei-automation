import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  executeInboundAutomationDecision,
  templateCarriesOfferAmount,
  resolveAuthorizedOfferAmount,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { applyNegotiationTurn } from "@/lib/domain/seller-flow/negotiation-state.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";

// A template whose use_case is OUTSIDE the canonical 5-name offer set but
// whose body carries the offer amount — exactly the G8 escape.
const NON_CANONICAL_OFFER_TEMPLATE = {
  id: "tpl-mf-offer",
  template_id: "tpl-mf-offer",
  use_case: "mf_offer_reveal",
  stage_code: "mf_offer_reveal",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto_reply",
  template_body:
    "Based on the rent roll we can purchase {{property_address}} for {{offer_price}}, as-is. Interested?",
  property_type_scope: "any",
};

const ADE_AUTHORITY = {
  recommended_offer: 1_050_000,
  authorized_offer_amount: 1_050_000,
  authorized_offer_ceiling: 1_200_000,
};

// ─── template-body detection is the accounting key ─────────────────────────

test("G8: offer placeholders are detected from the template body, any use case", () => {
  assert.equal(templateCarriesOfferAmount("Offer: {{offer_price}}"), true);
  assert.equal(templateCarriesOfferAmount("Offer: {{ smart_cash_offer_display }}"), true);
  assert.equal(templateCarriesOfferAmount("What condition is the roof in?"), false);
  assert.equal(templateCarriesOfferAmount("Asking {{asking_price}}?"), false, "the seller's own price is not OUR offer");
});

test("G8: resolveAuthorizedOfferAmount matches the renderer's authority rules", () => {
  assert.equal(resolveAuthorizedOfferAmount(ADE_AUTHORITY), 1_050_000);
  assert.equal(
    resolveAuthorizedOfferAmount({ recommended_offer: 80000, authorized_offer_ceiling: 90000 }),
    80000,
    "recommended offer renders when strategy amount is absent but bounded"
  );
  assert.equal(
    resolveAuthorizedOfferAmount({ authorized_offer_amount: 99000, authorized_offer_ceiling: 90000 }),
    null,
    "over-ceiling fails closed"
  );
  assert.equal(
    resolveAuthorizedOfferAmount({ authorized_offer_amount: 80000, authorized_offer_ceiling: null }),
    null,
    "no ceiling authority fails closed"
  );
});

// ─── execution reports offer accounting for non-canonical use cases ────────

test("G8: a queued-path render through a NON-canonical use case reports the carried offer amount", async () => {
  const supabase = makeSellerOrchestrationSupabase({ templates: [NON_CANONICAL_OFFER_TEMPLATE] });
  const result = await executeInboundAutomationDecision({
    message: "Send me your number for the building",
    threadKey: "+15551239999",
    propertyId: "prop-mf",
    prospectId: "pros-mf",
    ownerId: "mo-mf",
    phoneId: "phone-mf",
    classification: {
      primary_intent: "asking_price_value",
      confidence: 0.92,
      automation_decision: { auto_reply_allowed: true },
    },
    context: {
      found: true,
      summary: {
        conversation_stage: "offer",
        property_address: "500 Ocean Dr",
        language_preference: "English",
      },
    },
    inboundFrom: "+15551239999",
    inboundTo: "+15559990000",
    inboundEventId: "evt-ledger-1",
    // Preview path: accounting must ride the result even before live queueing.
    enableQueueInsert: false,
    dryRun: true,
    autoReplyMode: "dry_run",
    strategyDirective: {
      strategy: "initial_offer",
      reason_code: "NEAR_GAP_INITIAL_OFFER",
      template_use_case: "mf_offer_reveal",
      allowed_template_use_cases: ["mf_offer_reveal"],
      review_required: false,
    },
    dealAuthority: ADE_AUTHORITY,
    supabaseClient: supabase,
  });

  assert.ok(result.rendered_message_text.includes("$1,050,000"));
  assert.equal(result.offer_amount_rendered, true);
  assert.equal(result.rendered_offer_amount, 1_050_000);
});

// ─── the ledger records template-carried offers and survives replay ────────

const PRIOR_STATE_WITH_AUTHORITY = {
  current_asking_price: 1_500_000,
  initial_asking_price: 1_500_000,
  recommended_offer: 1_050_000,
  authorized_offer_floor: 1_000_000,
  authorized_offer_ceiling: 1_200_000,
};

test("G8: an offer sent via a non-canonical template lands in offers_made", () => {
  const next = applyNegotiationTurn(PRIOR_STATE_WITH_AUTHORITY, {
    offer_execution: {
      queued: true,
      amount: 1_050_000,
      template_use_case: "mf_offer_reveal",
      queue_row_id: "q-mf-1",
    },
    now: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(next.offers_made.length, 1);
  assert.equal(next.offers_made[0].amount, 1_050_000);
  assert.equal(next.offers_made[0].template_use_case, "mf_offer_reveal");
  assert.equal(next.offers_made[0].within_authority, true);
  assert.equal(next.latest_offer, 1_050_000);
});

test("G8: replaying the same queued send never double-appends the ledger", () => {
  const offer_execution = {
    queued: true,
    amount: 1_050_000,
    template_use_case: "mf_offer_reveal",
    queue_row_id: "q-mf-1",
  };
  const once = applyNegotiationTurn(PRIOR_STATE_WITH_AUTHORITY, {
    offer_execution,
    now: "2026-08-07T00:00:00.000Z",
  });
  const replayed = applyNegotiationTurn(once, {
    offer_execution,
    now: "2026-08-07T00:05:00.000Z",
  });
  assert.equal(replayed.offers_made.length, 1, "same queue row must not append twice");
  assert.equal(replayed.negotiation_round, once.negotiation_round, "replay must not consume a monetary turn");
  assert.equal(replayed.latest_offer, 1_050_000);

  // A genuinely NEW queued send still appends.
  const second = applyNegotiationTurn(replayed, {
    offer_execution: { ...offer_execution, amount: 1_125_000, queue_row_id: "q-mf-2" },
    now: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(second.offers_made.length, 2);
  assert.equal(second.latest_offer, 1_125_000);
});
