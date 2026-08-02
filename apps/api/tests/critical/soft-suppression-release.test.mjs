// ─── soft-suppression-release.test.mjs ───────────────────────────────────────
// Soft-suppression release correctness: lookups use the writers' canonical
// E.164 format, a zero-row release is a FAILED release (fail closed — the
// thread must not reopen on an unreleased suppression), binding STOP rows are
// never cleared by inbound text, and seller-initiated contact after STOP
// routes to human review only.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveLatestIntentPrecedence,
  releaseSoftSuppressions,
  SOFT_SUPPRESSION_REASONS,
} from "@/lib/domain/seller-flow/latest-intent-precedence.js";
import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const NOT_INTERESTED_PRIOR = { disposition: "not_interested", last_intent: "not_interested" };

/** Reopen decision over a soft not_interested suppression. */
function softReopenDecision() {
  return resolveLatestIntentPrecedence({
    classification: { primary_intent: "latent_interest", confidence: 0.7 },
    message_body: "are you still interested in buying?",
    prior_state: NOT_INTERESTED_PRIOR,
    active_suppressions: [{ suppression_reason: "not_interested" }],
  });
}

/**
 * Supabase double with filter fidelity for sms_suppression_list: eq/in
 * predicates run against the stored rows, updates mutate them and are
 * recorded, other tables resolve empty.
 */
function makeSuppressionSupabase({ suppressions = [], templates = [] } = {}) {
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

/** Minimal live nested context shape — prior state under `.summary`. */
function nestedContext(summaryOverrides = {}) {
  return {
    found: true,
    inbound_from: "+15551234567",
    ids: {
      phone_item_id: "phone-51",
      master_owner_id: "mo-21",
      prospect_id: "pros-31",
      property_id: "prop-227",
    },
    recent: { recent_events: [] },
    summary: {
      conversation_stage: null,
      property_address: "123 Main St",
      seller_first_name: "Jane",
      language_preference: "English",
      disposition: "not_interested",
      last_intent: "not_interested",
      automation_status: "paused",
      ...summaryOverrides,
    },
  };
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

test("release normalizes a formatted input phone to the stored E.164 before matching", async () => {
  const supabase = makeSuppressionSupabase({
    suppressions: [
      {
        id: "s1",
        phone_number: "+15551234567",
        suppression_reason: "not_interested",
        is_active: true,
      },
    ],
  });

  const result = await releaseSoftSuppressions(
    { supabase, phone_number: "555-123-4567", decision: softReopenDecision() },
    {}
  );

  assert.equal(result.ok, true);
  assert.equal(result.released, 1);
  assert.equal(supabase.updates.length, 1);
  // The query used the writers' canonical E.164, not the raw formatted input.
  assert.equal(supabase.updates[0].filters.phone_number, "+15551234567");
});

test("a zero-row release returns failure, not success", async () => {
  const supabase = makeSuppressionSupabase({
    suppressions: [
      {
        id: "s-other",
        phone_number: "+15550000000",
        suppression_reason: "not_interested",
        is_active: true,
      },
    ],
  });

  const result = await releaseSoftSuppressions(
    { supabase, phone_number: "+15551234567", decision: softReopenDecision() },
    {}
  );

  assert.equal(result.ok, false);
  assert.equal(result.released, 0);
  assert.equal(result.reason, "no_active_soft_suppression_released");
});

test("an active soft suppression is deactivated through the allow-listed reasons only", async () => {
  const row = {
    id: "s1",
    phone_number: "+15551234567",
    suppression_reason: "not_interested",
    is_active: true,
  };
  const supabase = makeSuppressionSupabase({ suppressions: [row] });

  const result = await releaseSoftSuppressions(
    { supabase, phone_number: "+15551234567", decision: softReopenDecision() },
    {}
  );

  assert.equal(result.ok, true);
  assert.equal(result.released, 1);
  assert.equal(row.is_active, false);
  assert.deepEqual(supabase.updates[0].patch, { is_active: false });
  // Allow-listed on the soft reasons, never deny-listed on binding ones.
  assert.deepEqual(new Set(supabase.updates[0].in_filter[1]), SOFT_SUPPRESSION_REASONS);
});

test("binding STOP suppression is never cleared", async () => {
  const stop_row = {
    id: "s-stop",
    phone_number: "+15551234567",
    suppression_reason: "stop",
    is_active: true,
  };
  const supabase = makeSuppressionSupabase({ suppressions: [stop_row] });

  // The resolver never asks for a release over a binding row …
  const binding_decision = resolveLatestIntentPrecedence({
    classification: { primary_intent: "seller_interested", confidence: 0.9 },
    message_body: "Actually I want to sell now, are you still interested?",
    prior_state: NOT_INTERESTED_PRIOR,
    active_suppressions: [{ suppression_reason: "stop" }],
  });
  assert.equal(binding_decision.clear_soft_suppression, false);
  const not_applicable = await releaseSoftSuppressions(
    { supabase, phone_number: "+15551234567", decision: binding_decision },
    {}
  );
  assert.equal(not_applicable.released, 0);
  assert.equal(not_applicable.reason, "not_applicable");
  assert.equal(supabase.updates.length, 0);

  // … and even a forged clear-decision cannot touch it: the soft allow-list
  // matches zero rows, which now reports failure.
  const forged = await releaseSoftSuppressions(
    {
      supabase,
      phone_number: "+15551234567",
      decision: {
        version: "forged",
        clear_soft_suppression: true,
        supersedes_prior_state: true,
      },
    },
    {}
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.released, 0);
  assert.equal(stop_row.is_active, true);
});

test("integration: zero-row release keeps the thread suppressed (no reopen on unreleased suppression)", async () => {
  // Lookup finds the active soft row via the phone_e164 column, but the
  // release keys on phone_number — zero rows update, so the reopen must not
  // survive. This is the schema/format-drift case the fail-safe exists for.
  const supabase = makeSuppressionSupabase({
    suppressions: [
      {
        id: "s-soft-e164col",
        phone_e164: "+16125551234",
        suppression_reason: "not_interested",
        is_active: true,
      },
    ],
    templates: [ASKING_PRICE_TEMPLATE],
  });
  const context = nestedContext();

  const result = await executeInboundAutomationDecision({
    message: "Are you still interested in buying?",
    threadKey: "+16125551234",
    inboundFrom: "+16125551234",
    inboundTo: "+16125550000",
    ownerId: "mo-21",
    latestThreadContext: context,
    context,
    classification: {
      primary_intent: "latent_interest",
      confidence: 0.64,
      automation_decision: { auto_reply_allowed: true },
    },
    dryRun: false,
    autoReplyMode: "dry_run",
    supabaseClient: supabase,
  });

  const precedence = result.automation_decision.latest_intent_precedence;
  assert.equal(precedence.supersedes_prior_state, false);
  assert.equal(precedence.clear_soft_suppression, false);
  assert.equal(precedence.state_patch, null);
  assert.ok(precedence.reason_codes.includes("soft_release_failed_fail_safe"));
  assert.equal(result.queued, false);
  assert.equal(result.automation_decision.should_suppress_contact, true);
  assert.equal(result.audit_reason, "not_interested");
});

test("integration: active soft suppression actually deactivated allows the reopen to proceed", async () => {
  const row = {
    id: "s-soft-live",
    phone_number: "+16125551234",
    suppression_reason: "not_interested",
    is_active: true,
  };
  const supabase = makeSuppressionSupabase({
    suppressions: [row],
    templates: [ASKING_PRICE_TEMPLATE],
  });
  const context = nestedContext();

  const result = await executeInboundAutomationDecision({
    message: "Are you still interested in buying?",
    threadKey: "+16125551234",
    inboundFrom: "+16125551234",
    inboundTo: "+16125550000",
    ownerId: "mo-21",
    latestThreadContext: context,
    context,
    classification: {
      primary_intent: "latent_interest",
      confidence: 0.64,
      automation_decision: { auto_reply_allowed: true },
    },
    dryRun: false,
    autoReplyMode: "dry_run",
    supabaseClient: supabase,
  });

  const precedence = result.automation_decision.latest_intent_precedence;
  assert.equal(precedence.supersedes_prior_state, true);
  assert.equal(row.is_active, false);
  assert.equal(result.automation_decision.should_suppress_contact, false);
  assert.equal(result.automation_decision.should_queue_reply, true);
  assert.ok(result.rendered_message_text);
});

test("integration: seller-initiated contact after STOP routes to human review only", async () => {
  const stop_row = {
    id: "s-optout",
    phone_number: "+16125551234",
    suppression_reason: "opt_out",
    is_active: true,
  };
  const supabase = makeSuppressionSupabase({
    suppressions: [stop_row],
    templates: [ASKING_PRICE_TEMPLATE],
  });
  const context = nestedContext();

  const result = await executeInboundAutomationDecision({
    message: "Actually yes, are you still interested in buying my house?",
    threadKey: "+16125551234",
    inboundFrom: "+16125551234",
    inboundTo: "+16125550000",
    ownerId: "mo-21",
    latestThreadContext: context,
    context,
    classification: {
      primary_intent: "seller_interested",
      confidence: 0.9,
      automation_decision: { auto_reply_allowed: true },
    },
    dryRun: false,
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
  // The binding row was never touched.
  assert.equal(supabase.updates.length, 0);
  assert.equal(stop_row.is_active, true);
});
