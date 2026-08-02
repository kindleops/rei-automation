// ─── latest-intent-precedence.test.mjs ───────────────────────────────────────
// Launch-required behavior: the newest clear seller intent supersedes stale
// negative state; binding opt-outs never auto-clear; positive-after-opt-out
// routes to a human as seller_initiated_after_stop.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveLatestIntentPrecedence,
  resolvePriorThreadState,
  releaseSoftSuppressions,
  matchReEngagementPatterns,
  SOFT_SUPPRESSION_REASONS,
} from "@/lib/domain/seller-flow/latest-intent-precedence.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const NOT_INTERESTED_PRIOR = { disposition: "not_interested", last_intent: "not_interested" };

/**
 * The EXACT live nested shape: loadContext() returns
 * { found, inbound_from, ids, items, flags, recent, summary } and the
 * orchestrator forwards it verbatim as `latestThreadContext: context` —
 * prior state lives under `.summary`, never flat.
 */
function liveNestedThreadContext(summaryOverrides = {}) {
  return {
    found: true,
    inbound_from: "+16125551234",
    ids: {
      phone_item_id: "phone-51",
      brain_item_id: 201,
      master_owner_id: "mo-21",
      owner_id: "own-11",
      prospect_id: "pros-31",
      property_id: "prop-227",
      assigned_agent_id: null,
      market_id: null,
    },
    items: {
      phone_item: null,
      brain_item: null,
      master_owner_item: null,
      owner_item: null,
      prospect_item: null,
      property_item: null,
      agent_item: null,
      market_item: null,
    },
    flags: {
      do_not_call: "FALSE",
      dnc_source: null,
      engagement_tier: null,
      phone_activity_status: "Active",
      follow_up_trigger_state: null,
      status_ai_managed: null,
    },
    recent: {
      recently_used_template_ids: [],
      touch_count: 3,
      last_template_id: null,
      last_inbound_message: "Not interested.",
      last_outbound_message: "",
      recent_events: [],
    },
    summary: {
      conversation_stage: "ownership_confirmation",
      seller_stage: "ownership_confirmation",
      property_address: "123 Main St",
      seller_first_name: "Jane",
      language_preference: "English",
      disposition: "not_interested",
      last_intent: "not_interested",
      automation_status: "paused",
      last_inbound_at: "2026-05-01T12:00:00.000Z",
      ...summaryOverrides,
    },
  };
}

/**
 * Supabase double with filter fidelity for sms_suppression_list (eq/in
 * predicates are applied against the stored rows, updates mutate them and
 * are recorded) plus a template catalog for the live reply path.
 */
function makeSuppressionAwareSupabase({ suppressions = [], templates = [] } = {}) {
  const updates = [];
  function makeChain(table) {
    const call = { op: "select", filters: [], in_filter: null, patch: null };
    function resolveRows() {
      if (table === "sms_templates") return [...templates];
      if (table !== "sms_suppression_list") return [];
      let rows = suppressions;
      for (const [col, val] of call.filters) {
        rows = rows.filter((row) => String(row[col] ?? "") === String(val));
      }
      if (call.in_filter) {
        const [col, values] = call.in_filter;
        rows = rows.filter((row) => values.includes(row[col]));
      }
      if (call.op === "update") {
        updates.push({
          table,
          patch: call.patch,
          filters: Object.fromEntries(call.filters),
          in_filter: call.in_filter,
          matched: rows.map((row) => row.id),
        });
        for (const row of rows) Object.assign(row, call.patch);
        return rows.map((row) => ({ id: row.id, suppression_reason: row.suppression_reason }));
      }
      return rows;
    }
    const chain = {
      select: () => chain,
      eq: (col, val) => {
        call.filters.push([col, val]);
        return chain;
      },
      in: (col, values) => {
        call.in_filter = [col, values];
        return chain;
      },
      is: () => chain,
      gte: () => chain,
      lte: () => chain,
      lt: () => chain,
      or: () => chain,
      order: () => chain,
      update: (patch) => {
        call.op = "update";
        call.patch = patch;
        return chain;
      },
      insert: () => chain,
      upsert: () => chain,
      limit: async () => ({ data: resolveRows(), error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) =>
        Promise.resolve({ data: resolveRows(), error: null }).then(resolve, reject),
    };
    return chain;
  }
  return { from: (table) => makeChain(table), updates };
}

const ASKING_PRICE_TEMPLATE = {
  id: "tpl-seller-asking-price",
  template_id: "tpl-seller-asking-price",
  use_case: "seller_asking_price",
  stage_code: "seller_asking_price",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto_reply",
  template_body:
    "Hi {{seller_first_name}}, what were you hoping to get for {{property_address}}? Reply STOP to opt out.",
  property_type_scope: "any",
};

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
  assert.equal(decision.state_patch.contextual_reply_required, true);
});

test("resolvePriorThreadState reads the live nested summary, context.summary, then flat fallback", () => {
  const nested = resolvePriorThreadState({
    latestThreadContext: liveNestedThreadContext(),
    context: null,
    inboundReceivedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(nested.prior_state.disposition, "not_interested");
  assert.equal(nested.prior_state.last_intent, "not_interested");
  assert.equal(nested.prior_state.automation_paused, true);
  assert.equal(nested.prior_state.last_inbound_at, "2026-05-01T12:00:00.000Z");
  assert.equal(nested.message_is_stale, false);

  const from_context = resolvePriorThreadState({
    latestThreadContext: null,
    context: liveNestedThreadContext({ automation_state: "paused", automation_status: null }),
    inboundReceivedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(from_context.prior_state.disposition, "not_interested");
  assert.equal(from_context.prior_state.automation_paused, true);

  // Flat latestThreadContext (replay engine, older harnesses) stays supported
  // as the compatibility fallback only.
  const flat = resolvePriorThreadState({
    latestThreadContext: { disposition: "interested", last_intent: "seller_interested" },
    context: null,
    inboundReceivedAt: null,
  });
  assert.equal(flat.prior_state.disposition, "interested");
  assert.equal(flat.prior_state.last_intent, "seller_interested");
  assert.equal(flat.prior_state.automation_paused, false);
  assert.equal(flat.message_is_stale, false);
});

test("resolvePriorThreadState derives staleness from the nested summary's last_inbound_at", () => {
  const stale = resolvePriorThreadState({
    latestThreadContext: liveNestedThreadContext({
      last_inbound_at: "2026-07-02T00:00:00.000Z",
    }),
    inboundReceivedAt: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(stale.message_is_stale, true);

  const decision = resolveLatestIntentPrecedence({
    classification: { primary_intent: "latent_interest", confidence: 0.7 },
    message_body: "are you still interested in buying?",
    prior_state: stale.prior_state,
    active_suppressions: [],
    message_is_stale: stale.message_is_stale,
  });
  assert.equal(decision.supersedes_prior_state, false);
  assert.ok(decision.reason_codes.includes("stale_message_cannot_supersede"));
});

test("live nested shape end-to-end: 'Not interested' history then 'Are you still interested in buying?' reopens", async () => {
  const supabase = makeSuppressionAwareSupabase({
    suppressions: [
      {
        id: "s-soft-1",
        phone_number: "+16125551234",
        suppression_reason: "not_interested",
        is_active: true,
      },
    ],
    templates: [ASKING_PRICE_TEMPLATE],
  });
  const context = liveNestedThreadContext();

  const result = await executeInboundAutomationDecision({
    message: "Are you still interested in buying?",
    threadKey: "+16125551234",
    inboundFrom: "+16125551234",
    inboundTo: "+16125550000",
    ownerId: "mo-21",
    // EXACT live wiring (process-seller-inbound-message.js): the loaded
    // context object is forwarded as BOTH latestThreadContext and context.
    latestThreadContext: context,
    context,
    classification: {
      primary_intent: "latent_interest",
      confidence: 0.64,
      automation_decision: { auto_reply_allowed: true },
    },
    inboundReceivedAt: "2026-08-01T12:00:00.000Z",
    dryRun: true,
    autoReplyMode: "dry_run",
    supabaseClient: supabase,
  });

  const precedence = result.automation_decision.latest_intent_precedence;
  assert.equal(precedence.re_engagement_detected, true);
  assert.equal(precedence.supersedes_prior_state, true);
  assert.equal(precedence.clear_soft_suppression, true);
  assert.equal(precedence.blocked_by_binding_suppression, false);
  // Automation resumed with the reopen patch: new_reply, temperature raised
  // from the cold prior state, lifecycle reopened, contextual reply required.
  assert.equal(precedence.state_patch.automation, "continue");
  assert.equal(precedence.state_patch.operational_status, "new_reply");
  assert.equal(precedence.state_patch.lead_temperature, "warm");
  assert.equal(precedence.state_patch.reopen_conversation, true);
  assert.equal(precedence.state_patch.contextual_reply_required, true);
  // The suppression block did NOT fire — the reply pipeline continued.
  assert.equal(result.automation_decision.should_suppress_contact, false);
  assert.equal(result.automation_decision.should_queue_reply, true);
  assert.notEqual(result.audit_reason, "seller_initiated_after_stop");
  assert.ok(result.rendered_message_text);
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
