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
    },
    ...overrides,
  };
}

function ownershipClassification(overrides = {}) {
  return {
    primary_intent: "ownership_confirmed",
    detected_intent: "ownership_confirmed",
    confidence: 0.94,
    language: "English",
    automation_decision: { auto_reply_allowed: true },
    ...overrides,
  };
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

test("processSellerInboundMessage orchestrates ownership confirmation under live_limited", async () => {
  const queued_rows = [];
  __setSellerInboundOrchestratorDeps({
    executeInboundAutomationDecision: async () => ({
      ok: true,
      automation_decision: {
        should_queue_reply: true,
        next_action: "queue_auto_reply",
        route_hint: "consider_selling",
        audit_reason: "ownership_confirmed",
      },
      selected_template: {
        use_case: "consider_selling",
        stage_code: "consider_selling",
        template_id: "tpl-s2",
        language: "English",
      },
      rendered_message_text: "Are you open to selling 123 Main St?",
      queued: true,
      queue_row_id: "queue-99",
      queue_result: { ok: true, raw: { scheduled_for: new Date().toISOString() } },
      seller_stage_reply: {
        ok: true,
        queued: true,
        handled: true,
        reason: "auto_reply_queued",
        brain_stage: "consider_selling",
        rendered_text: "Are you open to selling 123 Main St?",
      },
    }),
    patchUniversalLeadState: async () => ({ ok: true, thread_key: "+15551234567" }),
    emitAutomationEvent: async () => ({ ok: true }),
    scheduleFollowUp: async () => ({ ok: true, skipped: true, reason: "active_workflow_no_nurture" }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true }),
    getSupabaseClient: () => null,
  });

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
    skipNotifications: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.contract.normalized_intent, "ownership_confirmed");
  assert.equal(result.contract.ownership_signal, "confirmed");
  assert.equal(result.decision.stage_after, "offer_interest");
  assert.equal(result.execution.queued, true);
  assert.equal(result.execution.rendered_message_text, "Are you open to selling 123 Main St?");
  assert.equal(result.auto_reply_mode, "live_limited");
  assert.equal(result.execution_allowed, true);
});

test("processSellerInboundMessage schedules follow-up for S1 not-for-sale without immediate queue", async () => {
  let followup_intent = null;
  __setSellerInboundOrchestratorDeps({
    executeInboundAutomationDecision: async () => ({
      ok: true,
      automation_decision: {
        should_queue_reply: false,
        next_action: "schedule_later_followup",
        route_hint: "consider_selling",
        audit_reason: "s1_not_for_sale_advance_with_followup",
        ownership_status: "inferred",
        disposition: "not_interested",
        lead_temperature: "cold",
      },
      queued: false,
      seller_stage_reply: { ok: true, queued: false, handled: true },
    }),
    scheduleFollowUp: async (intent) => {
      followup_intent = intent;
      return {
        ok: true,
        followup_created: true,
        scheduled_for: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        reason: "nurture_followup:not_interested",
      };
    },
    patchUniversalLeadState: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true }),
    getSupabaseClient: () => null,
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
    skipNotifications: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.contract.ownership_signal, "inferred");
  assert.equal(result.contract.interest_signal, "not_interested");
  assert.equal(result.execution.queued, false);
  assert.equal(followup_intent, "not_interested");
  assert.equal(result.follow_up.followup_created, true);
  assert.equal(result.decision.disposition, "not_interested");
  assert.equal(result.decision.temperature, "cold");
});

test("processSellerInboundMessage is idempotent on duplicate queue suppression", async () => {
  __setSellerInboundOrchestratorDeps({
    executeInboundAutomationDecision: async () => ({
      ok: true,
      automation_decision: { should_queue_reply: false, audit_reason: "duplicate_source_event" },
      duplicate_suppressed: true,
      queue_row_id: "queue-existing",
      queued: false,
      seller_stage_reply: { ok: true, queued: false, handled: true, reason: "duplicate_source_event" },
    }),
    patchUniversalLeadState: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true }),
    scheduleFollowUp: async () => ({ ok: true, skipped: true }),
    getSupabaseClient: () => null,
  });

  const result = await processSellerInboundMessage({
    message: "Yes",
    threadKey: "+15551234567",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    classification: ownershipClassification(),
    context: baseContext(),
    inboundFrom: "+15551234567",
    inboundEventId: "evt-dup-1",
    autoReplyMode: "live_limited",
    executionAllowed: true,
    skipNotifications: true,
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

test("recovery worker identifies incomplete inbound rows", async () => {
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
      if (table === "inbox_thread_state") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      return {
        update() {
          return this;
        },
        eq() {
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  const result = await recoverUnprocessedInboundMessages({
    supabaseClient: mockSupabase,
    limit: 5,
    dryRun: true,
    autoReplyMode: "dry_run",
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidate_count, 1);
});