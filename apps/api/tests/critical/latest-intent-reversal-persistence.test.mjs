// ─── latest-intent-reversal-persistence.test.mjs ─────────────────────────────
// Reversal lifecycle contract, end-to-end through the canonical orchestrator:
// a new not_interested over a prior POSITIVE state supersedes it (pause,
// disposition=not_interested, status=paused, temperature=cold) and must NEVER
// advance lifecycle_stage to offer_interest — only a true reopen with
// reopen_conversation=true may advance to an interest stage. Asserted on the
// authoritative universal-lead-state patch the orchestrator persists.

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";

afterEach(() => {
  __resetSellerInboundOrchestratorDeps();
});

/**
 * The EXACT live nested context shape (loadContext() return): prior state
 * lives under `.summary` and the orchestrator forwards the whole object as
 * `latestThreadContext: context`. conversation_stage stays null so the S1
 * ownership-probe overlay cannot mask the precedence lifecycle gate.
 */
function nestedContext(summaryOverrides = {}) {
  return {
    found: true,
    inbound_from: "+15551234567",
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
      last_inbound_message: "",
      last_outbound_message: "",
      recent_events: [],
    },
    summary: {
      conversation_stage: null,
      seller_stage: null,
      property_address: "123 Main St",
      seller_first_name: "Jane",
      language_preference: "English",
      ...summaryOverrides,
    },
  };
}

function installPersistenceCapture() {
  const captured = { patches: [] };
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => makeSellerOrchestrationSupabase(),
    patchUniversalLeadState: async ({ patch }) => {
      captured.patches.push(patch);
      return { ok: true, patch, dry_run: true };
    },
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true, dry_run: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async () => ({
      ok: true,
      followup_created: true,
      scheduled_for: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      reason: "nurture_followup:test",
    }),
  });
  return captured;
}

test("reversal e2e: not_interested over prior positive persists paused/cold and never advances to offer_interest", async () => {
  const captured = installPersistenceCapture();

  // Prior POSITIVE state under the nested summary. conversation_stage is a
  // non-ownership stage so the S1 ownership-probe overlay stays silent (it
  // would otherwise stamp offer_interest itself via classify's stage_hint),
  // while ownership stays denied so the lifecycle resolver holds at
  // ownership_confirmation — the exact state where the un-gated precedence
  // block used to force offer_interest onto a declining lead.
  const context = nestedContext({
    conversation_stage: "offer_interest",
    seller_stage: "offer_interest",
    disposition: "interested",
    last_intent: "seller_interested",
    automation_status: "active",
    ownership_status: "denied",
    last_inbound_at: "2026-05-01T12:00:00.000Z",
  });

  const classification = await classify("Not interested.", null, { heuristicOnly: true });
  assert.equal(classification.primary_intent, "not_interested");

  const result = await processSellerInboundMessage({
    message: "Not interested.",
    threadKey: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification,
    context,
    route: { stage: "ownership_check", use_case: "ownership_check" },
    inboundFrom: "+15551234567",
    inboundTo: "+15559876543",
    inboundEventId: "evt-reversal-1",
    inboundReceivedAt: "2026-08-01T12:00:00.000Z",
    stageBefore: "ownership_check",
    autoReplyMode: "live_limited",
    executionAllowed: true,
    dryRun: true,
  });

  assert.equal(result.ok, true);

  const precedence = result.execution?.automation_decision?.latest_intent_precedence;
  assert.ok(precedence, "precedence decision missing from execution");
  assert.equal(precedence.supersedes_prior_state, true);
  assert.equal(precedence.state_patch.reversal, true);
  assert.equal(precedence.state_patch.reopen_conversation, false);
  assert.equal(precedence.state_patch.automation, "pause");

  assert.equal(captured.patches.length, 1);
  const patch = captured.patches[0];
  assert.equal(patch.disposition, "not_interested");
  assert.equal(patch.operational_status, "paused");
  assert.equal(patch.lead_temperature, "cold");
  // The reversal must never advance the lifecycle to an interest stage.
  assert.notEqual(patch.lifecycle_stage, "offer_interest");
  assert.equal(patch.lifecycle_stage, "ownership_confirmation");
});

test("reopen e2e: re-engagement with reopen_conversation=true advances lifecycle to offer_interest", async () => {
  const captured = installPersistenceCapture();

  // Prior NEGATIVE state under the nested summary — "Not interested." …
  // months later … a re-engagement phrasing the classifier still misses
  // (unclear), so the pattern detector is the live reopen authority and the
  // lifecycle advance can only come from the precedence reopen gate.
  const context = nestedContext({
    disposition: "not_interested",
    last_intent: "not_interested",
    automation_status: "paused",
    last_inbound_at: "2026-05-01T12:00:00.000Z",
  });

  const classification = await classify("You still buying houses?", null, {
    heuristicOnly: true,
  });
  assert.equal(classification.primary_intent, "unclear");

  const result = await processSellerInboundMessage({
    message: "You still buying houses?",
    threadKey: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification,
    context,
    route: { stage: "ownership_check", use_case: "ownership_check" },
    inboundFrom: "+15551234567",
    inboundTo: "+15559876543",
    inboundEventId: "evt-reopen-1",
    inboundReceivedAt: "2026-08-01T12:00:00.000Z",
    stageBefore: "ownership_check",
    autoReplyMode: "live_limited",
    executionAllowed: true,
    dryRun: true,
  });

  assert.equal(result.ok, true);

  const precedence = result.execution?.automation_decision?.latest_intent_precedence;
  assert.ok(precedence, "precedence decision missing from execution");
  assert.equal(precedence.re_engagement_detected, true);
  assert.equal(precedence.supersedes_prior_state, true);
  assert.equal(precedence.state_patch.reopen_conversation, true);
  assert.equal(precedence.state_patch.contextual_reply_required, true);

  assert.equal(captured.patches.length, 1);
  const patch = captured.patches[0];
  assert.equal(patch.disposition, "interested");
  assert.equal(patch.operational_status, "new_reply");
  assert.equal(patch.lead_temperature, "warm");
  // Only a true reopen advances the lifecycle to the interest stage.
  assert.equal(patch.lifecycle_stage, "offer_interest");
});
