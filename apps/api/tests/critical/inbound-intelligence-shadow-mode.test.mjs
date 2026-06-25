import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { runInboundIntelligencePhase } from "@/lib/domain/seller-flow/run-inbound-intelligence-phase.js";
import { extractSellerReferral, buildReferralDedupeKey } from "@/lib/domain/seller-flow/extract-seller-referral.js";
import {
  resolveInboundRelationship,
  isGlobalSuppressionRelationship,
} from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";
import { buildIntelligenceMessageEventPatch } from "@/lib/domain/seller-flow/persist-inbound-intelligence.js";
import { runShadowStageEngine } from "@/lib/domain/seller-flow/shadow-stage-engine-runner.js";
import { resolveFollowUpPlan } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";
import {
  makeInboundWebhookBaseDeps,
  makeInboundLifecycleSupabase,
} from "../helpers/chainable-supabase.mjs";
import { createInMemoryIdempotencyLedger, createPodioItem } from "../helpers/test-helpers.js";

afterEach(() => {
  __resetTextgridInboundTestDeps();
});

function baseClassification(overrides = {}) {
  return {
    primary_intent: "ownership_confirmed",
    detected_intent: "ownership_confirmed",
    confidence: 0.94,
    language: "English",
    automation_decision: { auto_reply_allowed: true },
    ...overrides,
  };
}

function baseContext() {
  return {
    found: true,
    ids: {
      brain_item_id: 201,
      master_owner_id: 21,
      prospect_id: 31,
      property_id: "234334277",
      phone_item_id: 51,
    },
    items: {
      brain_item: createPodioItem(201),
      phone_item: createPodioItem(51),
      master_owner_item: createPodioItem(21),
      property_item: createPodioItem(41),
    },
    summary: {
      conversation_stage: "Ownership Confirmation",
      language_preference: "English",
      property_address: "123 Main St",
    },
  };
}

test("applyInboundAutomationDecision runs while autopilot mode is disabled", async () => {
  const decision = applyInboundAutomationDecision({
    message: "Yes I own it",
    threadKey: "+16318047551",
    propertyId: "234334277",
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification: baseClassification(),
    latestThreadContext: baseContext(),
  });

  assert.equal(decision.canonical_intent, "ownership_confirmed");
  assert.ok(decision.safety_status);
  assert.ok(decision.contact_identity);
});

test("runInboundIntelligencePhase blocks execution but preserves intelligence", async () => {
  const result = await runInboundIntelligencePhase({
    message: "Yes I own it",
    threadKey: "+16318047551",
    propertyId: "234334277",
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification: baseClassification(),
    latestThreadContext: baseContext(),
    context: baseContext(),
    route: { stage: "Ownership Confirmation", use_case: "ownership_check" },
    inboundFrom: "+16318047551",
    inboundEventId: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e",
    auto_reply_mode: "disabled",
    execution_allowed: false,
  });

  assert.equal(result.intelligence_snapshot.automation_execution_status, "shadow_only");
  assert.equal(result.intelligence_snapshot.execution_blocked_reason, "auto_reply_mode_disabled");
  assert.equal(result.intelligence_snapshot.canonical_intent, "ownership_confirmed");
  assert.equal(result.seller_stage_reply.queued, false);
});

test("Sharon event resolves non_owner_referral without global wrong-number semantics", async () => {
  const message = "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622";
  const classification = {
    primary_intent: "wrong_number",
    objection: "wrong_number",
    confidence: 0.91,
  };

  const relationship = resolveInboundRelationship({
    message,
    classification,
    source_event_id: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e",
    source_thread_key: "+16318047551",
    source_contact_phone: "+16318047551",
    property_id: "234334277",
    master_owner_id: "21",
  });

  assert.equal(relationship.canonical_intent, "non_owner_referral");
  assert.equal(relationship.identity_class, "respondent_non_owner");
  assert.equal(relationship.relationship_outcome, "property_specific_non_owner_with_referral");
  assert.equal(relationship.suppression_scope, "property");
  assert.equal(relationship.suppression_property_id, "234334277");
  assert.equal(relationship.invalidate_phone_globally, false);
  assert.equal(relationship.invalidate_person_globally, false);
  assert.equal(relationship.referred_name, "Sharon Schwartz");
  assert.equal(relationship.referred_phone_e164, "+15617064622");
  assert.equal(relationship.referred_contact_proposed_stage, "ownership_confirmation");
  assert.equal(relationship.automatic_send_allowed, false);
  assert.equal(relationship.human_review_required, true);
  assert.equal(isGlobalSuppressionRelationship(relationship), false);

  const intelligence = await runInboundIntelligencePhase({
    message,
    threadKey: "+16318047551",
    propertyId: "234334277",
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification,
    latestThreadContext: baseContext(),
    context: baseContext(),
    route: { stage: "Ownership Confirmation", use_case: "ownership_check" },
    inboundFrom: "+16318047551",
    inboundEventId: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e",
    auto_reply_mode: "disabled",
    execution_allowed: false,
  });

  const snap = intelligence.intelligence_snapshot;
  assert.equal(snap.canonical_intent, "non_owner_referral");
  assert.equal(snap.identity_class, "respondent_non_owner");
  assert.notEqual(snap.identity_class, "wrong_number");
  assert.equal(snap.canonical_decision.should_suppress_contact, false);
  assert.equal(snap.human_review_required, true);

  const patch = buildIntelligenceMessageEventPatch(snap);
  assert.equal(patch.metadata.suppression_scope, "property");
  assert.equal(patch.metadata.invalidate_phone_globally, false);
  assert.equal(patch.routing_allowed, false);
});

test("referral proposal is idempotent by dedupe key", () => {
  const key_a = buildReferralDedupeKey({
    source_event_id: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e",
    referred_phone_e164: "+15617064622",
    property_id: "234334277",
  });
  const key_b = buildReferralDedupeKey({
    source_event_id: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e",
    referred_phone_e164: "+15617064622",
    property_id: "234334277",
  });
  assert.equal(key_a, key_b);
});

test("shadow stage engine persists comparison without execution authority", () => {
  const shadow = runShadowStageEngine({
    message: "Yes I own it",
    classification: baseClassification(),
    context: baseContext(),
    canonical_decision: {
      canonical_intent: "ownership_confirmed",
      route_hint: "consider_selling",
    },
    legacy_decision: {
      inbound_intent: "ownership_confirmed",
      next_stage: "consider_selling",
    },
  });

  assert.equal(shadow.shadow_mode, true);
  assert.equal(shadow.execution_authority, false);
  assert.ok(shadow.shadow_stage_engine);
});

test("follow-up recommendation is produced without dispatchable send for active intents", () => {
  const plan = resolveFollowUpPlan("ownership_confirmed", {
    thread_key: "+16318047551",
    is_suppressed: false,
  });
  assert.equal(plan.followup_created, false);
  assert.match(plan.reason, /active_workflow/);
});

test("actual wrong number remains globally suppressible", () => {
  const relationship = resolveInboundRelationship({
    message: "You have the wrong number",
    classification: { primary_intent: "wrong_number", objection: "wrong_number" },
    property_id: "234334277",
  });
  assert.equal(relationship.canonical_intent, "wrong_number");
  assert.equal(relationship.identity_class, "wrong_number");
  assert.equal(relationship.suppression_scope, "phone");
  assert.equal(relationship.invalidate_phone_globally, true);
  assert.equal(isGlobalSuppressionRelationship(relationship), true);
});

test("referred child thread proposal never merges parent and child timelines", () => {
  const referral = extractSellerReferral({
    message: "Not the owner. His name is Sharon Schwartz Tel 561-706-4622",
    classification: { primary_intent: "wrong_number" },
    source_contact_phone: "+16318047551",
    property_id: "234334277",
  });
  const child = referral.proposed_operations.find((op) => op.op === "propose_child_thread");
  assert.equal(child.merge_with_parent_timeline, false);
  assert.notEqual(child.child_phone_e164, child.parent_thread_key);
});

test("opt-out remains permanently suppressed for follow-up recommendation", () => {
  const plan = resolveFollowUpPlan("opt_out", { thread_key: "+16318047551" });
  assert.equal(plan.suppressed, true);
  assert.match(plan.reason, /permanent_suppression/);
});

test("hostile_or_legal is not misclassified as referral from contact-me phrasing", () => {
  const relationship = resolveInboundRelationship({
    message: "I will sue you if you contact me again",
    classification: { primary_intent: "hostile_or_legal", confidence: 0.6 },
    property_id: "1013",
  });

  assert.equal(relationship.canonical_intent, "hostile_or_legal");
  assert.equal(relationship.referral_detected, false);
  assert.equal(relationship.referred_name, null);
  assert.equal(relationship.suppression_scope, "incident");
  assert.equal(relationship.should_suppress_contact, true);
});

test("referral name extraction strips trailing Tel token", () => {
  const relationship = resolveInboundRelationship({
    message: "Not the owner. His name is John Smith Tel 561-555-1212",
    classification: { primary_intent: "wrong_number", objection: "wrong_number" },
    property_id: "1014",
  });
  assert.equal(relationship.referred_name, "John Smith");
  assert.equal(relationship.referred_phone_e164, "+15615551212");
});

function installShadowInboundDeps(overrides = {}) {
  const ledger = createInMemoryIdempotencyLedger();
  __setTextgridInboundTestDeps({
    ...makeInboundWebhookBaseDeps(overrides),
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (value) => value,
    info: () => {},
    warn: () => {},
    loadContext: async () => baseContext(),
    createBrain: async () => null,
    updateBrainAfterInbound: async () => ({ ok: true }),
    updateMasterOwnerAfterInbound: async () => ({ ok: true }),
    updateBrainStage: async () => ({ ok: true }),
    findLatestOpenOffer: async () => null,
    maybeProgressOfferStatus: async () => ({ ok: true, updated: false }),
    maybeCreateOfferFromContext: async () => ({ ok: true, created: false }),
    maybeUpsertUnderwritingFromInbound: async () => ({ ok: true, extracted: false }),
    maybeQueueUnderwritingFollowUp: async () => ({ ok: true, queued: false }),
    maybeCreateContractFromAcceptedOffer: async () => ({ ok: true, created: false }),
    syncPipelineState: async () => ({ ok: true, reason: "pipeline_not_created" }),
    routeInboundOffer: async () => ({ ok: true, offer_route: "manual_review", reason: "test" }),
    postInboundSmsDiscordCard: async () => ({ ok: true }),
    findInboundAutopilotQueue: async () => null,
    buildInboundAutopilotSchedule: () => ({ scheduled_for: new Date().toISOString() }),
    notifyDiscordOps: async () => ({ ok: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    isNegativeReply: () => false,
    cancelPendingQueueItemsForOwner: async () => ({ canceled_count: 0 }),
    buildInboundConversationState: () => ({}),
    extractUnderwritingSignals: () => ({}),
    transferDealToUnderwriting: async () => null,
    runInboundIntelligencePhase: async (args) => {
      const { runInboundIntelligencePhase: real } = await import(
        "@/lib/domain/seller-flow/run-inbound-intelligence-phase.js"
      );
      return real({ ...args, supabaseClient: null });
    },
    persistInboundIntelligenceSnapshot: async () => ({ ok: true, dry_run: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    ...overrides,
  });
}

test("handleTextgridInbound enriches canonical event without queue row when autopilot disabled", async () => {
  const supabase_updates = [];
  const queue_inserts = [];

  installShadowInboundDeps({
    getSupabaseClient: () => makeInboundLifecycleSupabase(),
    logInboundMessageEventSupabase: async (payload) => {
      supabase_updates.push(payload);
      return { ok: true, id: "evt-enriched" };
    },
    classify: async () => baseClassification(),
    resolveRoute: async () => ({ stage: "Ownership Confirmation", use_case: "ownership_check" }),
    resolveSellerAutoReplyPlan: async () => ({
      ok: true,
      inbound_intent: "ownership_confirmed",
      detected_intent: "ownership_confirmed",
      should_queue_reply: true,
      selected_use_case: "consider_selling",
      safety_tier: "auto_send",
    }),
    executeInboundAutomationDecision: async () => {
      queue_inserts.push("should_not_run");
      return { ok: true, queued: true };
    },
    scheduleFollowUp: async () => {
      queue_inserts.push("followup_should_not_run");
      return { ok: true, followup_created: true };
    },
    getSystemFlags: async () => ({ auto_reply_enabled: false, followup_enabled: false }),
    getSystemValue: async (key) => {
      if (key === "auto_reply_mode") return "disabled";
      if (key === "queue_emergency_stop_at") return new Date().toISOString();
      return null;
    },
    logInboundMessageEvent: async (fields) => {
      if (fields.record_item_id) supabase_updates.push({ authoritative: true, ...fields });
      return { item_id: 9001 };
    },
  });

  const result = await handleTextgridInboundWebhook({
    message_id: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e",
    from: "+16318047551",
    to: "+15551234567",
    body: "Yes I own it",
  });

  assert.equal(result.ok, true);
  assert.equal(queue_inserts.length, 0);

  const authoritative = supabase_updates.find((row) => row.authoritative);
  assert.ok(authoritative);
  assert.equal(authoritative.detected_intent, "ownership_confirmed");
  assert.notEqual(authoritative.safety_status, "pending");
});

test("Sharon referral inbound enriches intelligence without queue or SMS", async () => {
  const queue_inserts = [];

  installShadowInboundDeps({
    getSupabaseClient: () => makeInboundLifecycleSupabase(),
    classify: async () => ({
      primary_intent: "wrong_number",
      detected_intent: "wrong_number",
      objection: "wrong_number",
      confidence: 0.9,
      language: "English",
    }),
    resolveRoute: async () => ({ stage: "Ownership Confirmation", use_case: "wrong_person" }),
    resolveSellerAutoReplyPlan: async () => ({
      inbound_intent: "wrong_person",
      should_queue_reply: false,
      safety_tier: "suppress",
    }),
    persistSellerContactReferral: async () => ({ ok: true, referral_id: "ref-1" }),
    executeInboundAutomationDecision: async () => {
      queue_inserts.push("blocked");
      return { queued: true };
    },
    scheduleFollowUp: async () => {
      queue_inserts.push("followup");
      return { followup_created: true };
    },
    getSystemFlags: async () => ({ auto_reply_enabled: false, followup_enabled: false }),
    getSystemValue: async (key) => {
      if (key === "auto_reply_mode") return "disabled";
      if (key === "queue_emergency_stop_at") return new Date().toISOString();
      return null;
    },
    logInboundMessageEvent: async () => ({ item_id: 9002 }),
  });

  const result = await handleTextgridInboundWebhook({
    message_id: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e",
    from: "+16318047551",
    to: "+15551234567",
    body: "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622",
  });

  assert.equal(result.ok, true);
  assert.equal(queue_inserts.length, 0);

  const referral = extractSellerReferral({
    message: "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622",
    classification: { primary_intent: "wrong_number", objection: "wrong_number" },
    property_id: "234334277",
  });
  assert.equal(referral.referred_name, "Sharon Schwartz");
});