import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { normalizeClassificationContract } from "@/lib/domain/seller-flow/normalize-classification-contract.js";
import { buildSellerFlowDecision } from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { recoverUnprocessedInboundMessages } from "@/lib/domain/seller-flow/recover-unprocessed-inbound-messages.js";
import { runSellerInboundProofCases } from "@/lib/domain/seller-flow/run-seller-inbound-proof-cases.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";

afterEach(() => {
  __resetSellerInboundOrchestratorDeps();
});

function baseContext(overrides = {}) {
  return {
    found: true,
    ids: {
      brain_item_id: 201,
      master_owner_id: "mo-21",
      prospect_id: "pros-31",
      property_id: "prop-227",
      phone_item_id: "phone-51",
    },
    summary: {
      conversation_stage: "ownership_check",
      seller_stage: "ownership_check",
      property_address: "123 Main St",
      seller_first_name: "Jane",
      language_preference: "English",
    },
    ...overrides,
  };
}

function installIoBoundaryMocks(overrides = {}) {
  const supabase = overrides.supabase || makeSellerOrchestrationSupabase();
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => supabase,
    patchUniversalLeadState: async ({ patch }) => ({ ok: true, patch, dry_run: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true, dry_run: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async (intent) => ({
      ok: true,
      followup_created: true,
      scheduled_for: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      reason: `nurture_followup:${intent}`,
    }),
    ...overrides,
  });
  return supabase;
}

test("classify.js connects: Yes → ownership_confirmed", async () => {
  const result = await classify("Yes", null, { heuristicOnly: true });
  assert.equal(result.primary_intent, "ownership_confirmed");
  assert.ok(result.confidence >= 0.8);
  assert.equal(result.automation_decision?.auto_reply_allowed, true);
});

test("classify.js connects: Not for sale!!!! → not_interested", async () => {
  const result = await classify("Not for sale!!!!", null, { heuristicOnly: true });
  assert.equal(result.primary_intent, "not_interested");
});

test("classify.js connects: Yes, he's the owner → ownership_confirmed", async () => {
  const result = await classify("Yes, he's the owner.", null, { heuristicOnly: true });
  assert.equal(result.primary_intent, "ownership_confirmed");
});

test("normalizeClassificationContract maps ownership and review fields", async () => {
  const classification = await classify("Yes", null, { heuristicOnly: true });
  const { ok, contract } = normalizeClassificationContract({
    classification,
    message: "Yes",
    threadId: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    phone: "+15551234567",
    context: baseContext(),
    inboundEventId: "evt-1",
  });

  assert.equal(ok, true);
  assert.equal(contract.normalized_intent, "ownership_confirmed");
  assert.equal(contract.ownership_signal, "confirmed");
  assert.equal(contract.phone, "+15551234567");
  assert.equal(contract.ambiguity_review_required, false);
});

test("S1 not-for-sale applies ownership-probe overlay in automation decision", () => {
  const decision = applyInboundAutomationDecision({
    message: "Not for sale!!!!",
    threadKey: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification: {
      primary_intent: "not_interested",
      confidence: 0.91,
      automation_decision: { auto_reply_allowed: false },
    },
    latestThreadContext: baseContext(),
  });

  assert.equal(decision.next_action, "schedule_later_followup");
  assert.equal(decision.route_hint, "consider_selling");
  assert.equal(decision.should_queue_reply, false);
  assert.equal(decision.ownership_status, "inferred");
  assert.equal(decision.disposition, "not_interested");
  assert.equal(decision.lead_temperature, "cold");
  assert.ok(decision.follow_up_at);
});

test("processSellerInboundMessage runs real intelligence + execution for ownership confirmation", async () => {
  installIoBoundaryMocks();

  const classification = await classify("Yes", null, { heuristicOnly: true });
  const result = await processSellerInboundMessage({
    message: "Yes",
    threadKey: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification,
    context: baseContext(),
    route: { stage: "ownership_check", use_case: "ownership_check" },
    inboundFrom: "+15551234567",
    inboundTo: "+15559876543",
    inboundEventId: "evt-yes-1",
    autoReplyMode: "live_limited",
    executionAllowed: true,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.contract.normalized_intent, "ownership_confirmed");
  assert.equal(result.contract.ownership_signal, "confirmed");
  assert.equal(result.intelligence_snapshot?.canonical_intent, "ownership_confirmed");
  assert.equal(result.decision.stage_after, "offer_interest");
  assert.equal(result.execution.automation_decision.should_queue_reply, true);
  assert.ok(result.execution.rendered_message_text);
  assert.equal(result.queued, true);
  assert.equal(result.execution.queued, true);
  assert.equal(result.queue_row_created, false);
  assert.equal(result.execution.queue_row_created, false);
  assert.equal(result.effective_action, "queue_planned");
  assert.equal(result.auto_reply_mode, "live_limited");
  assert.equal(result.writes_suppressed, true);
  assert.equal(result.side_effects?.notifications_dispatched, false);
  assert.ok(result.side_effects?.workflow_events_count > 0);
  assert.ok(result.side_effects?.notification_events_count > 0);
  assert.ok(result.side_effects?.intelligence_message_event_patch);
  assert.ok(result.side_effects?.universal_state_patch);
});

test("processSellerInboundMessage schedules follow-up for S1 not-for-sale without immediate queue", async () => {
  let followup_called = false;
  installIoBoundaryMocks({
    scheduleFollowUp: async () => {
      followup_called = true;
      return {
        ok: true,
        followup_created: true,
        scheduled_for: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        reason: "nurture_followup:not_interested",
      };
    },
  });

  const classification = await classify("Not for sale!!!!", null, { heuristicOnly: true });
  const result = await processSellerInboundMessage({
    message: "Not for sale!!!!",
    threadKey: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification,
    context: baseContext(),
    route: { stage: "ownership_check", use_case: "ownership_check" },
    inboundFrom: "+15551234567",
    inboundTo: "+15559876543",
    inboundEventId: "evt-nfs-1",
    autoReplyMode: "live_limited",
    executionAllowed: true,
    dryRun: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.writes_suppressed, true);
  assert.equal(result.side_effects?.notifications_dispatched, false);
  assert.ok(result.side_effects?.workflow_events_count > 0);
  assert.equal(result.contract.ownership_signal, "inferred");
  assert.equal(result.contract.interest_signal, "not_interested");
  assert.equal(result.execution.automation_decision.should_queue_reply, false);
  assert.equal(followup_called, false);
  assert.equal(result.followup_scheduled, true);
  assert.equal(result.follow_up.followup_scheduled, true);
  assert.equal(result.followup_created, false);
  assert.equal(result.follow_up.followup_created, false);
  assert.equal(result.effective_action, "followup_planned");
  assert.ok(result.follow_up.scheduled_for || result.decision.follow_up_at);
  assert.equal(result.follow_up.shadow_only, true);
  assert.equal(result.decision.disposition, "not_interested");
  assert.equal(result.decision.temperature, "cold");
});

test("processSellerInboundMessage is idempotent on duplicate queue suppression", async () => {
  installIoBoundaryMocks({
    supabase: makeSellerOrchestrationSupabase({
      sendQueueRows: [
        {
          id: "queue-existing",
          source_event_id: "evt-dup-1",
          queue_status: "queued",
          type: "auto_reply",
          thread_key: "+15551234567",
          created_at: new Date().toISOString(),
        },
      ],
    }),
  });

  const result = await processSellerInboundMessage({
    message: "Yes",
    threadKey: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification: {
      primary_intent: "ownership_confirmed",
      detected_intent: "ownership_confirmed",
      confidence: 0.94,
      language: "English",
      automation_decision: { auto_reply_allowed: true },
    },
    context: baseContext(),
    route: { stage: "ownership_check", use_case: "ownership_check" },
    inboundFrom: "+15551234567",
    inboundEventId: "evt-dup-1",
    autoReplyMode: "live_limited",
    executionAllowed: true,
    dryRun: true,
  });

  assert.equal(result.idempotent.duplicate_suppressed, true);
  assert.equal(result.idempotent.queue_row_id, "queue-existing");
});

test("buildSellerFlowDecision returns standardized shape", () => {
  const decision = buildSellerFlowDecision({
    contract: {
      normalized_intent: "ownership_confirmed",
      ownership_signal: "confirmed",
      participant_id: "pros-31",
      extracted_facts: {},
    },
    automation_decision: {
      should_queue_reply: true,
      next_action: "queue_auto_reply",
      route_hint: "consider_selling",
    },
    execution: {
      queued: true,
      rendered_message_text: "Are you open to selling?",
      queue_row_id: "q-1",
    },
    stage_before: "ownership_check",
    auto_reply_mode: "live_limited",
    execution_allowed: true,
  });

  assert.equal(decision.stage_before, "ownership_confirmation");
  assert.equal(decision.stage_after, "offer_interest");
  assert.equal(decision.immediate_next_action, "queue_auto_reply");
  assert.equal(decision.template_key, "consider_selling");
  assert.equal(decision.execution_mode, "full_autopilot");
  assert.ok(Array.isArray(decision.workflow_events));
  assert.ok(Array.isArray(decision.notification_events));
});

test("runSellerInboundProofCases exercises representative Yes and Not-for-sale flows", async () => {
  installIoBoundaryMocks();

  const proof = await runSellerInboundProofCases({
    dryRun: true,
    proofRun: true,
    autoReplyMode: "live_limited",
  });

  assert.equal(proof.ok, true);
  assert.equal(proof.proof_run, true);
  assert.equal(proof.proof_count, 2);

  const yes_case = proof.proof_results.find((row) => row.proof_case === "ownership_confirmed_yes");
  const nfs_case = proof.proof_results.find((row) => row.proof_case === "s1_not_for_sale");

  assert.ok(yes_case);
  assert.equal(yes_case.normalized_intent, "ownership_confirmed");
  assert.equal(yes_case.decision.stage_after, "offer_interest");
  assert.equal(yes_case.execution.automation_decision.should_queue_reply, true);
  assert.equal(yes_case.queued, true);
  assert.equal(yes_case.execution.queued, true);
  assert.equal(yes_case.queue_row_created, false);
  assert.equal(yes_case.effective_action, "queue_planned");
  assert.ok(yes_case.execution_preview_message);
  assert.equal(yes_case.writes_suppressed, true);
  assert.equal(yes_case.side_effects?.notifications_dispatched, false);
  assert.ok(yes_case.side_effects?.workflow_events_count > 0);
  assert.ok(yes_case.side_effects?.notification_events_count > 0);
  assert.ok(yes_case.side_effects?.universal_state_patch);

  assert.ok(nfs_case);
  assert.equal(nfs_case.normalized_intent, "not_interested");
  assert.equal(nfs_case.execution.automation_decision.should_queue_reply, false);
  assert.equal(nfs_case.followup_scheduled, true);
  assert.equal(nfs_case.follow_up.followup_scheduled, true);
  assert.equal(nfs_case.followup_created, false);
  assert.equal(nfs_case.effective_action, "followup_planned");
  assert.equal(nfs_case.writes_suppressed, true);
  assert.equal(nfs_case.side_effects?.notifications_dispatched, false);
});

test("recovery worker reprocesses incomplete inbound rows through canonical orchestration", async () => {
  const orchestrationSupabase = makeSellerOrchestrationSupabase();
  const proofContext = baseContext();
  const mockSupabase = {
    from(table) {
      if (table === "message_events") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          gte() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return Promise.resolve({
              data: [
                {
                  id: "evt-recover-1",
                  provider_message_sid: "sid-1",
                  from_phone_number: "+15551234567",
                  to_phone_number: "+15559876543",
                  message_body: "Yes",
                  received_at: new Date().toISOString(),
                  detected_intent: null,
                  metadata: {},
                  master_owner_id: "mo-21",
                  prospect_id: "pros-31",
                  property_id: "prop-227",
                },
              ],
              error: null,
            });
          },
        };
      }
      return orchestrationSupabase.from(table);
    },
  };

  installIoBoundaryMocks({ supabase: orchestrationSupabase });

  const result = await recoverUnprocessedInboundMessages({
    supabaseClient: mockSupabase,
    limit: 5,
    dryRun: true,
    autoReplyMode: "live_limited",
    loadContextImpl: async () => proofContext,
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidate_count, 1);
  assert.equal(result.recovered_count, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].normalized_intent, "ownership_confirmed");
  assert.equal(result.results[0].decision.stage_after, "offer_interest");
  assert.ok(result.results[0].side_effects?.workflow_events_count > 0);
  assert.ok(result.results[0].side_effects?.notification_events_count > 0);
  assert.equal(result.results[0].side_effects?.notifications_dispatched, false);
});

test("recovery worker can target Yes ownership inbound via body_contains filter", async () => {
  const orchestrationSupabase = makeSellerOrchestrationSupabase();
  const proofContext = baseContext();
  const rows = [
    {
      id: "evt-stop-1",
      provider_message_sid: "sid-stop",
      from_phone_number: "+19012812981",
      to_phone_number: "+15559876543",
      message_body: "STOP",
      received_at: new Date().toISOString(),
      detected_intent: "opt_out",
      metadata: { detected_intent: "opt_out" },
      master_owner_id: "mo-21",
      prospect_id: "pros-31",
      property_id: "prop-227",
    },
    {
      id: "evt-yes-1",
      provider_message_sid: "sid-yes",
      from_phone_number: "+15551234567",
      to_phone_number: "+15559876543",
      message_body: "Yes",
      received_at: new Date().toISOString(),
      detected_intent: null,
      metadata: {},
      master_owner_id: "mo-21",
      prospect_id: "pros-31",
      property_id: "prop-227",
    },
  ];
  const mockSupabase = {
    from(table) {
      if (table === "message_events") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          gte() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return Promise.resolve({ data: rows, error: null });
          },
        };
      }
      return orchestrationSupabase.from(table);
    },
  };

  installIoBoundaryMocks({ supabase: orchestrationSupabase });

  const result = await recoverUnprocessedInboundMessages({
    supabaseClient: mockSupabase,
    limit: 1,
    dryRun: true,
    autoReplyMode: "live_limited",
    bodyContains: "Yes",
    loadContextImpl: async () => proofContext,
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidate_count, 1);
  assert.equal(result.results[0].message, "Yes");
  assert.equal(result.results[0].normalized_intent, "ownership_confirmed");
  assert.equal(result.results[0].queued, true);
  assert.equal(result.results[0].queue_row_created, false);
});