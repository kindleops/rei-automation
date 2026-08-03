// ─── compound-intent-preservation.test.mjs ───────────────────────────────────
// WS3 golden + adversarial multi-turn coverage: compound messages must never
// be flattened to a single label. The canonical case —
//   "Property is in probate, my sister is executor, and we want 150k"
// — must preserve: probate/authority state, executor identity, the asking
// price, sale interest, and a defined next action; plus multi-turn goldens
// for still-interested re-engagement, old-campaign resurrection, and
// seller-initiated contact after STOP.
//
// Deterministic only: heuristicOnly classification, no network, no AI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";
import {
  resolveLatestIntentPrecedence,
  resolvePriorThreadState,
} from "@/lib/domain/seller-flow/latest-intent-precedence.js";

async function classifyHeuristic(body) {
  return classify(body, null, { heuristicOnly: true });
}

const CANONICAL_COMPOUND =
  "Property is in probate, my sister is executor, and we want 150k for it";

describe("compound intent preservation", () => {
  it("canonical probate+executor+price message preserves every component", async () => {
    const r = await classifyHeuristic(CANONICAL_COMPOUND);

    // Price is primary (INTENT_PRIORITY) and parsed to the exact figure.
    assert.equal(r.primary_intent, "asking_price_provided");
    const parsed_price =
      r.price_parse?.amount ??
      r.price_parse?.value ??
      r.seller_state?.price_mentioned ??
      null;
    assert.equal(Number(parsed_price), 150000, JSON.stringify(r.price_parse));

    // Authority state: the probate objection is set (HIGH_RISK family).
    assert.equal(r.objection, "probate");

    // Components survive: ownership/authority component + compound marker.
    assert.ok(r.matched_intents.includes("ownership_confirmed"), JSON.stringify(r.matched_intents));
    assert.ok(r.secondary_intents.includes("compound_intent"), JSON.stringify(r.secondary_intents));

    // Executor identity via the relationship layer.
    const rel = resolveInboundRelationship({
      message: CANONICAL_COMPOUND,
      classification: r,
    });
    assert.equal(rel.relationship_claim, "executor_heir");
    assert.equal(rel.identity_class, "executor_or_heir");

    // Decision: never suppression, and a defined next action exists. The
    // authority question (executor ≠ this respondent) keeps a human in the
    // loop via the executor_heir relationship lane downstream.
    const decision = applyInboundAutomationDecision({
      message: CANONICAL_COMPOUND,
      threadKey: "+15550100001",
      propertyId: "prop-77",
      classification: r,
    });
    assert.equal(decision.should_suppress_contact, false);
    assert.ok(decision.next_action && decision.next_action !== "none");
    // Sale interest preserved on seller_state.
    assert.ok(r.seller_state.seller_interest !== "none");
  });

  it("interest + IRS lien: legal tier wins routing, interest survives as a component", async () => {
    const r = await classifyHeuristic("I want to sell but there is an IRS lien on it");
    assert.equal(r.primary_intent, "lien_tax_issue");
    assert.ok(
      r.matched_intents.includes("seller_interested") ||
        r.matched_intents.includes("latent_interest"),
      JSON.stringify(r.matched_intents)
    );
    assert.ok(r.secondary_intents.includes("compound_intent"));

    const decision = applyInboundAutomationDecision({
      message: "I want to sell but there is an IRS lien on it",
      threadKey: "+15550100002",
      propertyId: "prop-78",
      classification: r,
    });
    assert.equal(decision.should_mark_human_review, true);
    assert.equal(decision.human_review_reason, "lien_tax_issue");
    assert.equal(decision.should_suppress_contact, false);
  });

  it("Spanish continuation + ownership: content wins, language switch preserved", async () => {
    const r = await classifyHeuristic("no hablo ingles. es mi casa");
    assert.equal(r.primary_intent, "ownership_confirmed");
    assert.equal(r.language, "Spanish");
    assert.ok(r.secondary_intents.includes("language_switch"));
    assert.ok(r.secondary_intents.includes("compound_intent"));
  });

  it("trust + negated ownership: negation scope beats the trust frame's ownership read", async () => {
    const r = await classifyHeuristic(
      "That's not my house, it's in my brother's family trust"
    );
    // Ownership disconnect routes to wrong_number for suppression; the trust
    // component may remain as evidence but can never flip the identity lane.
    assert.equal(r.primary_intent, "wrong_number");
    assert.ok(!r.matched_intents.includes("ownership_confirmed"));
  });

  it("golden multi-turn: decline → 'Are you still interested in buying?' reopens (buyer-still-interested family)", async () => {
    const turn2 = await classifyHeuristic("Are you still interested in buying?");
    // The finer ontology label rides along with asks_offer when phrased as an
    // offer-status question; the re-engagement decision comes from precedence.
    const decision = resolveLatestIntentPrecedence({
      classification: turn2,
      message_body: "Are you still interested in buying?",
      prior_state: { disposition: "not_interested", last_intent: "not_interested" },
      active_suppressions: [{ suppression_reason: "not_interested" }],
    });
    assert.equal(decision.re_engagement_detected, true);
    assert.equal(decision.supersedes_prior_state, true);
    assert.equal(decision.state_patch.reopen_conversation, true);
    assert.equal(decision.state_patch.contextual_reply_required, true);
  });

  it("golden: 'is the offer still on the table' carries the asks_buyer_still_interested component", async () => {
    const r = await classifyHeuristic("Hey is that offer still on the table?");
    assert.equal(r.primary_intent, "asks_offer");
    assert.ok(
      r.matched_intents.includes("asks_buyer_still_interested"),
      JSON.stringify(r.matched_intents)
    );
  });

  it("golden multi-turn: old-campaign resurrection — stale thread cannot silently supersede; fresh positive still re-engages", async () => {
    // A reordered/stale message (older than the last recorded inbound) must
    // not supersede state.
    const stale = resolvePriorThreadState({
      latestThreadContext: {
        summary: {
          disposition: "not_interested",
          last_intent: "not_interested",
          last_inbound_at: "2026-07-02T00:00:00.000Z",
        },
      },
      inboundReceivedAt: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(stale.message_is_stale, true);
    const staleDecision = resolveLatestIntentPrecedence({
      classification: { primary_intent: "latent_interest", confidence: 0.7 },
      message_body: "are you still interested in buying?",
      prior_state: stale.prior_state,
      active_suppressions: [],
      message_is_stale: stale.message_is_stale,
    });
    assert.equal(staleDecision.supersedes_prior_state, false);
    assert.ok(staleDecision.reason_codes.includes("stale_message_cannot_supersede"));

    // The same text arriving FRESH months after the campaign (thread is old,
    // message is new) is a legitimate resurrection and re-engages.
    const fresh = resolvePriorThreadState({
      latestThreadContext: {
        summary: {
          disposition: "not_interested",
          last_intent: "not_interested",
          last_inbound_at: "2026-01-15T00:00:00.000Z",
        },
      },
      inboundReceivedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(fresh.message_is_stale, false);
    const freshDecision = resolveLatestIntentPrecedence({
      classification: { primary_intent: "latent_interest", confidence: 0.7 },
      message_body: "are you still interested in buying?",
      prior_state: fresh.prior_state,
      active_suppressions: [],
      message_is_stale: fresh.message_is_stale,
    });
    assert.equal(freshDecision.supersedes_prior_state, true);
    assert.equal(freshDecision.state_patch.reopen_conversation, true);
  });

  it("golden multi-turn: seller-initiated contact after STOP routes to a human only — never auto-reply, never auto-clear", async () => {
    const r = await classifyHeuristic("Actually I changed my mind, what would you offer?");
    const decision = resolveLatestIntentPrecedence({
      classification: r,
      message_body: "Actually I changed my mind, what would you offer?",
      prior_state: { disposition: "suppressed", last_intent: "opt_out" },
      active_suppressions: [{ suppression_reason: "opt_out" }],
    });
    assert.equal(decision.blocked_by_binding_suppression, true);
    assert.equal(decision.human_review_required, true);
    assert.equal(decision.supersedes_prior_state, false);
    assert.equal(decision.clear_soft_suppression, false);
  });
});
