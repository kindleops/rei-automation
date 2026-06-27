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
  ALWAYS_MATERIAL_FIELDS,
  compareNormalizedDecisionShapes,
} from "@/lib/domain/seller-flow/shadow-comparison-contract.js";
import {
  compareTransitionShapes,
  mapCanonicalTransitionShape,
  mapShadowTransitionShape,
} from "@/lib/domain/seller-flow/shadow-stage-transition.js";
import { enforceRelationshipTemplatePolicy } from "@/lib/domain/seller-flow/relationship-template-policy.js";
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
  assert.equal(result.intelligence_snapshot.identity_class, "confirmed_owner");
  assert.equal(result.intelligence_snapshot.relationship_outcome, "confirmed_owner");
  assert.equal(result.intelligence_snapshot.universal_stage, "offer_interest");
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
  assert.equal(relationship.referred_automatic_send_allowed, true);
  assert.equal(relationship.human_review_required, false);
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
  assert.equal(snap.referred_automatic_send_allowed, true);
  assert.equal(snap.human_review_required, false);

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
  const message = "Not the owner. His name is Sharon Schwartz Tel 561-706-4622";
  const relationship = resolveInboundRelationship({
    message,
    classification: { primary_intent: "wrong_number" },
    source_contact_phone: "+16318047551",
    property_id: "234334277",
  });
  const referral = extractSellerReferral({ message, relationship });
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
    processSellerInboundMessage: async (args) => {
      const { runInboundIntelligencePhase: real } = await import(
        "@/lib/domain/seller-flow/run-inbound-intelligence-phase.js"
      );
      const intelligence = await real({ ...args, supabaseClient: null });
      const execution_allowed = Boolean(args.executionAllowed);
      let execution = { ok: true, queued: false, seller_stage_reply: intelligence.seller_stage_reply };
      if (execution_allowed && overrides.executeInboundAutomationDecision) {
        execution = await overrides.executeInboundAutomationDecision(args);
      }
      return {
        ok: true,
        intelligence,
        intelligence_snapshot: intelligence.intelligence_snapshot,
        seller_stage_reply: {
          ...(intelligence.seller_stage_reply || {}),
          ...(execution?.seller_stage_reply || {}),
        },
        execution,
        follow_up: { ok: true, skipped: true, reason: "test_shadow_skip" },
        decision: null,
        contract: null,
        auto_reply_mode: args.autoReplyMode,
        execution_allowed,
      };
    },
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
    executeInboundAutomationDecision: async () => {
      queue_inserts.push("should_not_run");
      return { ok: true, queued: true };
    },
    getSystemFlags: async () => ({ auto_reply_enabled: false, followup_enabled: false }),
    getSystemValue: async (key) => {
      if (key === "auto_reply_mode") return "disabled";
      if (key === "podio_sync_enabled") return "true";
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
    executeInboundAutomationDecision: async () => {
      queue_inserts.push("blocked");
      return { queued: true };
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

  const message = "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622";
  const relationship = resolveInboundRelationship({
    message,
    classification: { primary_intent: "wrong_number", objection: "wrong_number" },
    property_id: "234334277",
  });
  const referral = extractSellerReferral({ message, relationship });
  assert.equal(referral.referred_name, "Sharon Schwartz");
  assert.equal(referral.referrals.length, 1);
});

test("confirmed owner messages resolve confirmed_owner identity and offer_interest stage", async () => {
  for (const message of ["Yes I own it", "I'm the owner", "Yes, that's my property"]) {
    const relationship = resolveInboundRelationship({
      message,
      classification: { primary_intent: "ownership_confirmed", confidence: 0.9 },
      property_id: "1001",
    });
    assert.equal(relationship.canonical_intent, "ownership_confirmed", message);
    assert.equal(relationship.identity_class, "confirmed_owner", message);
    assert.equal(relationship.relationship_outcome, "confirmed_owner", message);
    assert.equal(relationship.suppression_scope, "none", message);
    assert.equal(relationship.universal_stage, "offer_interest", message);
  }
});

test("co-owner spouse is authorized_spouse not respondent_non_owner", () => {
  const relationship = resolveInboundRelationship({
    message: "My wife owns it but I can answer questions",
    classification: { primary_intent: "unclear", confidence: 0.6 },
    property_id: "1008",
  });
  assert.equal(relationship.identity_class, "authorized_spouse");
  assert.equal(relationship.canonical_intent, "co_owner_respondent");
  assert.equal(relationship.relationship_outcome, "co_owner");
  assert.equal(relationship.human_review_required, true);
  assert.notEqual(relationship.identity_class, "respondent_non_owner");
});

test("specialist identities remain distinct from wrong_number", () => {
  const cases = [
    { message: "I am the executor of the estate", identity: "executor_or_heir", intent: "executor_heir_respondent" },
    { message: "I am the LLC representative for the owner", identity: "entity_representative", intent: "entity_representative_respondent" },
    { message: "I am the listing agent for this home", identity: "agent_representative", intent: "agent_representative_respondent" },
    { message: "I am the property manager for this building", identity: "property_manager", intent: "property_manager_respondent" },
  ];
  for (const row of cases) {
    const relationship = resolveInboundRelationship({
      message: row.message,
      classification: { primary_intent: "unclear" },
      property_id: "1000",
    });
    assert.equal(relationship.identity_class, row.identity, row.message);
    assert.equal(relationship.canonical_intent, row.intent, row.message);
    assert.equal(relationship.suppression_scope, "property", row.message);
    assert.equal(relationship.invalidate_phone_globally, false, row.message);
  }
});

test("property-scoped non-owner never becomes global wrong-number suppression", () => {
  const cases = [
    "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622",
    "No, I do not own it",
    "I never owned that property",
  ];
  for (const message of cases) {
    const relationship = resolveInboundRelationship({
      message,
      classification: { primary_intent: "wrong_number", objection: "wrong_number" },
      property_id: "234334277",
    });
    assert.equal(relationship.invalidate_phone_globally, false, message);
    assert.notEqual(relationship.identity_class, "wrong_number", message);
    assert.equal(isGlobalSuppressionRelationship(relationship), false, message);
  }
});

test("multi-name referral extracts all candidates", () => {
  const message = "Not the owner. His name is Tom Wilson or His name is Jerry Lee";
  const relationship = resolveInboundRelationship({ message, classification: { primary_intent: "wrong_number" }, property_id: "1017" });
  const referral = extractSellerReferral({ message, relationship });
  assert.equal(referral.referrals.length, 2);
  assert.deepEqual(
    referral.referrals.map((r) => r.name).sort(),
    ["Jerry Lee", "Tom Wilson"]
  );
  assert.equal(referral.ambiguous_pairing, true);
  assert.equal(referral.human_review_required, true);
});

test("multi-phone referral extracts all phone candidates", () => {
  const message = "Not mine. Call 561-555-1111 or 561-555-2222";
  const relationship = resolveInboundRelationship({ message, classification: { primary_intent: "wrong_number" }, property_id: "1018" });
  const referral = extractSellerReferral({ message, relationship });
  const phones = referral.referrals.map((r) => r.phone_e164).filter(Boolean).sort();
  assert.deepEqual(phones, ["+15615551111", "+15615552222"]);
});

test("condition disclosure resolves condition_disclosed at condition stage", async () => {
  const result = await runInboundIntelligencePhase({
    message: "Needs a new roof and plumbing work",
    threadKey: "+15550000022",
    propertyId: "1022",
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification: { primary_intent: "unclear", confidence: 0.4 },
    latestThreadContext: {
      ...baseContext(),
      summary: { ...baseContext().summary, conversation_stage: "Condition Probe" },
    },
    context: {
      ...baseContext(),
      summary: { ...baseContext().summary, conversation_stage: "Condition Probe" },
    },
    route: { stage: "Condition Probe", use_case: null },
    inboundFrom: "+15550000022",
    inboundEventId: "condition-01",
    auto_reply_mode: "disabled",
    execution_allowed: false,
  });
  assert.equal(result.intelligence_snapshot.canonical_intent, "condition_disclosed");
  assert.equal(result.intelligence_snapshot.canonical_intent, "condition_disclosed");
  assert.equal(
    result.intelligence_snapshot.decision_layers.recommendation.recommended_use_case,
    "price_high_condition_probe"
  );
});

test("non_owner_referral follow-up policy suppresses source nurture but proposes referred stage 1", () => {
  const plan = resolveFollowUpPlan("non_owner_referral", {
    thread_key: "+16318047551",
    property_id: "234334277",
    referrals: [{ name: "Sharon Schwartz", phone_e164: "+15617064622" }],
  });
  assert.equal(plan.followup_created, false);
  assert.equal(plan.dispatchable, false);
  assert.match(plan.reason, /referral_source_no_property_nurture/);
  assert.equal(plan.referral_policy.referred_contacts[0].automatic_send_allowed, false);
  assert.equal(plan.referral_policy.referred_contacts[0].review_required, true);
});

test("shadow comparison produces per-field agreement metadata", async () => {
  const result = await runInboundIntelligencePhase({
    message: "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622",
    threadKey: "+16318047551",
    propertyId: "234334277",
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification: { primary_intent: "wrong_number", objection: "wrong_number", confidence: 0.9 },
    latestThreadContext: baseContext(),
    context: baseContext(),
    route: { stage: "Ownership Confirmation", use_case: "ownership_check" },
    inboundFrom: "+16318047551",
    inboundEventId: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e",
    auto_reply_mode: "disabled",
    execution_allowed: false,
  });
  const comparison = result.intelligence_snapshot.three_layer_comparison;
  assert.ok(comparison);
  assert.ok(comparison.layers?.semantic);
  assert.ok(comparison.layers?.recommendation);
  assert.ok(comparison.layers?.execution);
  assert.ok(comparison.comparison_class);
  assert.equal(result.intelligence_snapshot.decision_layers.execution.shadow_only, true);
});

test("stage 1 shadow uses relationship override not raw wrong_number classifier", () => {
  const relationship = resolveInboundRelationship({
    message: "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622",
    classification: { primary_intent: "wrong_number" },
    property_id: "234334277",
  });
  const shadow = runShadowStageEngine({
    message: "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622",
    classification: { primary_intent: "wrong_number" },
    context: baseContext(),
    canonical_decision: { canonical_intent: "non_owner_referral", next_action: "mark_human_review" },
    relationship,
    identity_class: relationship.identity_class,
    relationship_outcome: relationship.relationship_outcome,
    suppression_scope: relationship.suppression_scope,
    universal_stage: "ownership_confirmation",
    granular_stage: "referral_review",
    human_review_required: true,
  });
  assert.notEqual(shadow.stage_domain_recommendation.recommended_use_case, "consider_selling");
  assert.equal(
    shadow.stage_domain_recommendation.recommended_action,
    relationship.referred_automatic_send_allowed ? "referral_auto_outreach" : "referral_review"
  );
  assert.ok(
    ["full_agreement", "expected_execution_block_difference"].includes(
      shadow.three_layer_comparison.comparison_class
    )
  );
});

test("transition-aware ownership confirmation agrees on offer_interest advance", () => {
  const context = baseContext();
  const canonical = mapCanonicalTransitionShape({
    context,
    route: { stage: "Ownership Confirmation" },
    canonical_decision: { canonical_intent: "ownership_confirmed" },
    relationship: {
      canonical_intent: "ownership_confirmed",
      ownership_confirmed: true,
      universal_stage: "offer_interest",
    },
    classification: baseClassification(),
  });
  const shadow = mapShadowTransitionShape({
    context,
    shadow_engine: {
      universal_stage: "offer_interest",
      proposed_decision: { inbound_intent: "ownership_confirmed", next_stage: "consider_selling" },
    },
    relationship: {
      canonical_intent: "ownership_confirmed",
      ownership_confirmed: true,
    },
    canonical_decision: { canonical_intent: "ownership_confirmed" },
    classification: baseClassification(),
  });
  const result = compareTransitionShapes(canonical, shadow);
  assert.equal(canonical.stage_before_message, "ownership_confirmation");
  assert.equal(canonical.proposed_next_stage, "offer_interest");
  assert.equal(result.comparison_class, "full_agreement");
});

test("transition-aware asking-price progression preserves stage_after_decision", () => {
  const context = {
    ...baseContext(),
    summary: { ...baseContext().summary, conversation_stage: "Asking Price" },
  };
  const canonical = mapCanonicalTransitionShape({
    context,
    route: { stage: "Asking Price" },
    canonical_decision: { canonical_intent: "asking_price_provided" },
    classification: { primary_intent: "asking_price_provided", confidence: 0.9 },
  });
  const shadow = mapShadowTransitionShape({
    context,
    shadow_engine: {
      universal_stage: "asking_price",
      granular_stage: "asking_price",
      proposed_decision: { inbound_intent: "asking_price_provided", next_stage: "asking_price" },
    },
    canonical_decision: { canonical_intent: "asking_price_provided" },
    classification: { primary_intent: "asking_price_provided", confidence: 0.9 },
  });
  const result = compareTransitionShapes(canonical, shadow);
  assert.equal(canonical.event_intent, "asking_price_provided");
  assert.equal(canonical.stage_after_decision, "asking_price");
  assert.equal(result.comparison_class, "full_agreement");
});

test("transition-aware condition progression holds condition_justification", () => {
  const context = {
    ...baseContext(),
    summary: { ...baseContext().summary, conversation_stage: "Condition Probe" },
  };
  const canonical = mapCanonicalTransitionShape({
    context,
    route: { stage: "Condition Probe" },
    canonical_decision: { canonical_intent: "condition_disclosed" },
    classification: { primary_intent: "condition_disclosed", confidence: 0.85 },
  });
  const shadow = mapShadowTransitionShape({
    context,
    shadow_engine: {
      universal_stage: "condition_justification",
      granular_stage: "condition_disclosed",
      proposed_decision: { inbound_intent: "condition_disclosed", next_stage: "condition_disclosed" },
    },
    canonical_decision: { canonical_intent: "condition_disclosed" },
    classification: { primary_intent: "condition_disclosed", confidence: 0.85 },
  });
  const result = compareTransitionShapes(canonical, shadow);
  assert.equal(canonical.proposed_next_stage, "condition_justification");
  assert.equal(result.comparison_class, "full_agreement");
});

test("referral name-only template selection blocks seller-interest use cases", async () => {
  const message = "I do not own it. His name is Maria Garcia";
  const relationship = resolveInboundRelationship({
    message,
    classification: { primary_intent: "wrong_number" },
    property_id: "1016",
  });
  const policy = enforceRelationshipTemplatePolicy({
    relationship,
    canonical_intent: relationship.canonical_intent,
    template_use_case: "consider_selling",
  });
  assert.equal(policy.blocked, true);
  assert.equal(policy.use_case, "referral_review");
  assert.notEqual(policy.use_case, "consider_selling");

  const intelligence = await runInboundIntelligencePhase({
    message,
    threadKey: "+15550000016",
    propertyId: "1016",
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification: { primary_intent: "wrong_number", confidence: 0.8 },
    latestThreadContext: baseContext(),
    context: baseContext(),
    route: { stage: "Ownership Confirmation", use_case: "ownership_check" },
    inboundFrom: "+15550000016",
    inboundEventId: "referral-name-01",
    auto_reply_mode: "disabled",
    execution_allowed: false,
  });
  assert.equal(intelligence.intelligence_snapshot.recommended_use_case, "referral_review");
  assert.notEqual(intelligence.intelligence_snapshot.recommended_use_case, "consider_selling");
});

test("safety disposition disagreement is always material", () => {
  const comparison = compareNormalizedDecisionShapes(
    {
      canonical_intent: "hostile_or_legal",
      identity_class: "unknown",
      relationship_outcome: null,
      suppression_scope: "incident",
      universal_stage: "ownership_confirmation",
      granular_stage: "hostile_or_legal",
      safety_disposition: "review",
      proposed_action: "human_review",
      selected_use_case: null,
      follow_up_policy: "suppressed",
      human_review_required: true,
    },
    {
      canonical_intent: "hostile_or_legal",
      identity_class: "unknown",
      relationship_outcome: null,
      suppression_scope: "incident",
      universal_stage: "ownership_confirmation",
      granular_stage: "hostile_or_legal",
      safety_disposition: "suppressed",
      proposed_action: "suppress_globally",
      selected_use_case: null,
      follow_up_policy: "suppressed",
      human_review_required: true,
    }
  );
  assert.ok(ALWAYS_MATERIAL_FIELDS.includes("safety_disposition"));
  assert.ok(comparison.material_disagreement_fields.includes("safety_disposition"));
  assert.equal(comparison.comparison_class, "material_disagreement");
});

test("three-layer contract separates recommendation from execution", async () => {
  const result = await runInboundIntelligencePhase({
    message: "Yes I own it",
    threadKey: "+15550000001",
    propertyId: "1001",
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification: baseClassification(),
    latestThreadContext: baseContext(),
    context: baseContext(),
    route: { stage: "Ownership Confirmation", use_case: "ownership_check" },
    inboundFrom: "+15550000001",
    inboundEventId: "own-yes-01",
    auto_reply_mode: "disabled",
    execution_allowed: false,
  });

  const layers = result.intelligence_snapshot.decision_layers;
  assert.equal(layers.semantic.canonical_intent, "ownership_confirmed");
  assert.equal(layers.recommendation.recommended_action, "ask_offer_interest");
  assert.equal(layers.recommendation.recommended_human_review, false);
  assert.equal(layers.execution.effective_action, "shadow_only");
  assert.equal(layers.execution.queue_row_created, false);
  assert.notEqual(layers.recommendation.recommended_action, layers.execution.effective_action);
});

test("persistInboundIntelligenceSnapshot classifies missing schema errors", async () => {
  const { persistInboundIntelligenceSnapshot } = await import(
    "@/lib/domain/seller-flow/persist-inbound-intelligence.js"
  );
  const result = await persistInboundIntelligenceSnapshot({
    supabaseClient: {
      from: () => ({
        upsert: () => ({
          select: () => ({
            maybeSingle: async () => {
              throw new Error('relation "public.inbound_intelligence_audit" does not exist');
            },
          }),
        }),
      }),
    },
    intelligence_snapshot: {
      source_event_id: "schema-test-01",
      canonical_intent: "ownership_confirmed",
      decision_version: "test",
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "schema_missing");
  assert.equal(result.schema_missing, true);
  assert.equal(result.deployment_order, "apply_schema_before_code_deploy");
});

test("unapproved follow-up policy returns explicit review_required_no_schedule", () => {
  for (const intent of ["condition_disclosed", "latent_interest"]) {
    const plan = resolveFollowUpPlan(intent, { thread_key: "+15550000022" });
    assert.equal(plan.reason, "follow_up_policy_not_approved");
    assert.equal(plan.follow_up_policy, "review_required_no_schedule");
    assert.equal(plan.dispatchable, false);
    assert.equal(plan.followup_created, false);
    assert.notEqual(plan.reason, "no_followup_rule_for_intent:" + intent);
  }
});