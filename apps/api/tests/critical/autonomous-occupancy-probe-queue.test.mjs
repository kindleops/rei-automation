import test from "node:test";
import assert from "node:assert/strict";

import { executeInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

// Regression for the autonomous-execution gap: an ownership_confirmed inbound
// advances the seller flow to the occupancy-discovery stage (MISSING_OCCUPANCY_FACT).
// The deterministic negotiation-strategy router returns an OCCUPANCY_DISCOVERY
// directive whose next_action is send_message_now (template use-case
// "occupancy_probe"). Previously the strategy-directive branch rewrote the route
// but never AUTHORIZED the queue, so should_queue_reply stayed at the base intent
// value (false once ownership is confirmed) and the send was silently dropped
// before template selection ever ran — no autonomous reply was created.
//
// The fix authorizes the queue for immediate-send strategy directives. These
// tests run the REAL executeInboundAutomationDecision with a mocked template
// catalog; only INPUTS are built here.

const OCCUPANCY_PROBE_TEMPLATE = {
  id: "lc-occupancy-probe-en-1",
  template_id: "lc-occupancy-probe-en-1",
  use_case: "occupancy_probe",
  stage_code: "S4",
  stage_label: "Occupancy Discovery",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto",
  template_body:
    "Quick question so I can be accurate, is the property currently occupied or vacant? Reply STOP to opt out.",
  property_type_scope: "Any Residential",
};

function makeSupabase() {
  function makeChain(table) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      gte: () => chain,
      lte: () => chain,
      lt: () => chain,
      or: () => chain,
      order: () => chain,
      update: () => chain,
      insert: () => chain,
      upsert: () => chain,
      limit: async () => ({
        data: table === "sms_templates" ? [OCCUPANCY_PROBE_TEMPLATE] : [],
        error: null,
      }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) =>
        Promise.resolve({ data: [], error: null }).then(resolve, reject),
    };
    return chain;
  }
  return { from: (table) => makeChain(table) };
}

function context() {
  return {
    found: true,
    inbound_from: "+16125551234",
    ids: { master_owner_id: "mo-21", prospect_id: "pros-31", property_id: "prop-227" },
    items: {},
    flags: { do_not_call: "FALSE", phone_activity_status: "Active" },
    recent: { recently_used_template_ids: [], touch_count: 2, recent_events: [] },
    summary: {
      conversation_stage: "ownership_confirmation",
      seller_stage: "ownership_confirmation",
      property_address: "123 Main St",
      property_type: "Single Family",
      seller_first_name: "Jane",
      language_preference: "English",
      last_intent: "ownership_confirmed",
      last_inbound_at: "2026-08-27T00:00:00.000Z",
    },
  };
}

const OCCUPANCY_DIRECTIVE = {
  strategy: "occupancy_discovery",
  reason_code: "MISSING_OCCUPANCY_FACT",
  template_use_case: "occupancy_probe",
  allowed_template_use_cases: ["occupancy_probe"],
  next_action: "send_message_now",
  review_required: false,
};

function runDecision({ strategyDirective }) {
  const ctx = context();
  return executeInboundAutomationDecision({
    message: "Yeah, I still own it",
    threadKey: "+16125551234",
    inboundFrom: "+16125551234",
    inboundTo: "+16125550000",
    ownerId: "mo-21",
    propertyId: "prop-227",
    prospectId: "pros-31",
    latestThreadContext: ctx,
    context: ctx,
    classification: {
      primary_intent: "ownership_confirmed",
      confidence: 0.95,
      language: "English",
      // Base intent decision does NOT auto-queue (ownership already confirmed —
      // nothing to reply about ownership itself). This isolates the fix: only the
      // immediate-send strategy directive should authorize the queue.
      automation_decision: { auto_reply_allowed: false },
    },
    strategyDirective,
    inboundReceivedAt: "2026-08-27T00:00:00.000Z",
    dryRun: true,
    autoReplyMode: "dry_run",
    supabaseClient: makeSupabase(),
  });
}

test("immediate-send strategy directive (OCCUPANCY_DISCOVERY) authorizes the autonomous queue + selects the occupancy_probe template", async () => {
  const result = await runDecision({ strategyDirective: OCCUPANCY_DIRECTIVE });

  const decision = result.automation_decision;
  assert.equal(
    decision.should_queue_reply,
    true,
    "immediate-send strategy directive must authorize the queue (was silently dropped before the fix)"
  );
  assert.equal(decision.should_mark_human_review, false);
  assert.equal(decision.route_hint, "occupancy_probe");
  assert.ok(
    (decision.allowed_template_stages || []).includes("occupancy_probe"),
    "route must target the occupancy_probe stage"
  );
  // The selector must actually resolve the occupancy_probe template (dry run: no insert).
  const selected = result.selected_template || result.rendered_template || null;
  assert.ok(selected, "a template must be selected for the occupancy_probe send");
  assert.equal(clean(selected.use_case), "occupancy_probe");
});

test("schedule_follow_up strategy directive (FUTURE_NURTURE) is NOT force-queued as an immediate reply", async () => {
  const result = await runDecision({
    strategyDirective: {
      strategy: "future_nurture",
      reason_code: "FUTURE_NURTURE",
      template_use_case: "future_nurture",
      allowed_template_use_cases: ["future_nurture"],
      next_action: "schedule_follow_up",
      review_required: false,
    },
  });
  // The fix must not turn a nurture/schedule directive into an immediate send;
  // it defers to the follow-up scheduler. With a base that does not auto-queue,
  // should_queue_reply must stay false (the fix only authorizes immediate-send
  // next_actions: send_message_now / generate_offer / collect_contract_facts).
  assert.equal(
    result.automation_decision.should_queue_reply,
    false,
    "schedule_follow_up must not be force-queued as an immediate reply"
  );
});

function clean(value) {
  return String(value ?? "").trim();
}
