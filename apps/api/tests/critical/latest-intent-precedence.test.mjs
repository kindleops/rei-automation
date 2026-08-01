// ─── latest-intent-precedence.test.mjs ───────────────────────────────────────
// Launch-required behavior: the newest clear seller intent supersedes stale
// negative state; binding opt-outs never auto-clear; positive-after-opt-out
// routes to a human as seller_initiated_after_stop.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveLatestIntentPrecedence,
  releaseSoftSuppressions,
  matchReEngagementPatterns,
  SOFT_SUPPRESSION_REASONS,
} from "@/lib/domain/seller-flow/latest-intent-precedence.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const NOT_INTERESTED_PRIOR = { disposition: "not_interested", last_intent: "not_interested" };

test("required scenario: 'Are you still interested in buying?' supersedes prior not-interested", () => {
  const decision = resolveLatestIntentPrecedence({
    classification: { primary_intent: "latent_interest", confidence: 0.64 },
    message_body: "Are you still interested in buying?",
    prior_state: NOT_INTERESTED_PRIOR,
    active_suppressions: [{ suppression_reason: "not_interested" }],
  });
  assert.equal(decision.re_engagement_detected, true);
  assert.equal(decision.supersedes_prior_state, true);
  assert.equal(decision.clear_soft_suppression, true);
  assert.equal(decision.blocked_by_binding_suppression, false);
  assert.equal(decision.state_patch.disposition, "interested");
  assert.equal(decision.state_patch.operational_status, "new_reply");
  assert.equal(decision.state_patch.lead_temperature, "warm");
  assert.equal(decision.state_patch.reopen_conversation, true);
});

test("pattern detector covers phrasing the classifier misses", () => {
  // Ground truth: classify() returns 'unclear' for this phrasing today.
  for (const body of [
    "You still buying houses?",
    "Is your offer still on the table?",
    "I changed my mind, I might sell after all",
    "¿Todavía le interesa la casa?",
  ]) {
    assert.equal(matchReEngagementPatterns(body).matched, true, body);
  }
  assert.equal(matchReEngagementPatterns("Not interested in selling.").matched, false);
});

test("binding opt-out is never superseded and demands a human", () => {
  const decision = resolveLatestIntentPrecedence({
    classification: { primary_intent: "seller_interested", confidence: 0.9 },
    message_body: "Actually I want to sell now, are you still interested?",
    prior_state: NOT_INTERESTED_PRIOR,
    active_suppressions: [{ suppression_reason: "opt_out" }],
  });
  assert.equal(decision.supersedes_prior_state, false);
  assert.equal(decision.clear_soft_suppression, false);
  assert.equal(decision.blocked_by_binding_suppression, true);
  assert.equal(decision.human_review_required, true);
});

test("unrecognized suppression reasons fail closed like binding ones", () => {
  const decision = resolveLatestIntentPrecedence({
    classification: { primary_intent: "seller_interested", confidence: 0.9 },
    message_body: "still interested?",
    prior_state: NOT_INTERESTED_PRIOR,
    active_suppressions: [{ suppression_reason: "mystery_new_reason" }],
  });
  assert.equal(decision.supersedes_prior_state, false);
  assert.equal(decision.blocked_by_binding_suppression, true);
});

test("a new negative or compliance message never re-engages", () => {
  for (const [intent, body] of [
    ["opt_out", "STOP"],
    ["wrong_number", "wrong number"],
    ["not_interested", "Still not interested, please move on"],
    ["hostile_or_legal", "stop harassing me or I call my lawyer"],
  ]) {
    const decision = resolveLatestIntentPrecedence({
      classification: { primary_intent: intent, confidence: 0.95 },
      message_body: body,
      prior_state: NOT_INTERESTED_PRIOR,
      active_suppressions: [],
    });
    assert.equal(decision.re_engagement_detected, false, intent);
    assert.equal(decision.supersedes_prior_state, false, intent);
  }
});

test("positive message with no stale negative prior is normal flow, not supersession", () => {
  const decision = resolveLatestIntentPrecedence({
    classification: { primary_intent: "seller_interested", confidence: 0.9 },
    message_body: "Yes I'd like to hear an offer",
    prior_state: { disposition: "interested" },
    active_suppressions: [],
  });
  assert.equal(decision.re_engagement_detected, true);
  assert.equal(decision.supersedes_prior_state, false);
});

test("hot intents raise temperature to hot on supersession", () => {
  const decision = resolveLatestIntentPrecedence({
    classification: { primary_intent: "asks_offer", confidence: 0.9 },
    message_body: "Changed my mind — what would you offer?",
    prior_state: NOT_INTERESTED_PRIOR,
    active_suppressions: [],
  });
  assert.equal(decision.supersedes_prior_state, true);
  assert.equal(decision.state_patch.lead_temperature, "hot");
});

test("releaseSoftSuppressions only touches allow-listed soft reasons", async () => {
  const updates = [];
  const supabase = {
    from(table) {
      const call = { table, filters: {}, in_values: null };
      const chain = {
        update(patch) {
          call.patch = patch;
          return chain;
        },
        eq(col, val) {
          call.filters[col] = val;
          return chain;
        },
        in(col, values) {
          call.in_values = { col, values };
          return chain;
        },
        select: async () => {
          updates.push(call);
          return { data: [{ id: "s1", suppression_reason: "not_interested" }], error: null };
        },
      };
      return chain;
    },
  };
  const decision = resolveLatestIntentPrecedence({
    classification: { primary_intent: "latent_interest", confidence: 0.7 },
    message_body: "are you still interested in buying?",
    prior_state: NOT_INTERESTED_PRIOR,
    active_suppressions: [{ suppression_reason: "not_interested" }],
  });
  const result = await releaseSoftSuppressions(
    { supabase, phone_number: "+16125551234", decision },
    {}
  );
  assert.equal(result.ok, true);
  assert.equal(result.released, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.is_active, false);
  assert.deepEqual(new Set(updates[0].in_values.values), SOFT_SUPPRESSION_REASONS);
  assert.equal(updates[0].filters.phone_number, "+16125551234");
  assert.equal(updates[0].filters.is_active, true);
});

test("integration: positive reply after binding opt-out returns seller_initiated_after_stop with human review", async () => {
  const supabase = {
    from(table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: async () => ({
          data:
            table === "sms_suppression_list"
              ? [{ id: "s-optout", suppression_reason: "opt_out", is_active: true }]
              : [],
          error: null,
        }),
        maybeSingle: async () => ({ data: null, error: null }),
        order: () => chain,
        in: () => chain,
        gte: () => chain,
        update: () => chain,
      };
      return chain;
    },
  };

  const result = await executeInboundAutomationDecision({
    message: "Actually yes, are you still interested in buying my house?",
    threadKey: "+16125551234",
    inboundFrom: "+16125551234",
    inboundTo: "+16125550000",
    ownerId: "mo_test",
    latestThreadContext: { disposition: "not_interested", last_intent: "not_interested" },
    classification: {
      primary_intent: "seller_interested",
      confidence: 0.9,
      automation_decision: { auto_reply_allowed: true },
    },
    dryRun: true,
    autoReplyMode: "dry_run",
    supabaseClient: supabase,
  });

  assert.equal(result.queued, false);
  assert.equal(result.audit_reason, "seller_initiated_after_stop");
  assert.equal(result.automation_decision.should_mark_human_review, true);
  assert.equal(
    result.automation_decision.latest_intent_precedence.blocked_by_binding_suppression,
    true
  );
});
