#!/usr/bin/env node
import "../../tests/register-aliases.mjs";
import { classify } from "@/lib/domain/classification/classify.js";
import { runInboundIntelligencePhase } from "@/lib/domain/seller-flow/run-inbound-intelligence-phase.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";

const FIXTURES = [
  { id: "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e", thread: "+16318047551", property_id: "234334277", message: "Never been the owner / His name is Sharon Schwartz / Tel (561)706-4622", stage: "Ownership Confirmation" },
  { id: "own-yes-01", thread: "+15550000001", property_id: "1001", message: "Yes I own it", stage: "Ownership Confirmation" },
  { id: "own-no-01", thread: "+15550000002", property_id: "1002", message: "No, I do not own it", stage: "Ownership Confirmation" },
  { id: "never-owned-01", thread: "+15550000003", property_id: "1003", message: "I never owned that property", stage: "Ownership Confirmation" },
  { id: "former-owner-01", thread: "+15550000004", property_id: "1004", message: "I sold it years ago", stage: "Ownership Confirmation" },
  { id: "tenant-01", thread: "+15550000005", property_id: "1005", message: "I am just a tenant here on a lease", stage: "Ownership Confirmation" },
  { id: "pm-01", thread: "+15550000006", property_id: "1006", message: "I am the property manager for this building", stage: "Ownership Confirmation" },
  { id: "agent-01", thread: "+15550000007", property_id: "1007", message: "I am the listing agent for this home", stage: "Ownership Confirmation" },
  { id: "spouse-01", thread: "+15550000008", property_id: "1008", message: "My wife owns it but I can answer questions", stage: "Ownership Confirmation" },
  { id: "executor-01", thread: "+15550000009", property_id: "1009", message: "I am the executor of the estate", stage: "Ownership Confirmation" },
  { id: "llc-01", thread: "+15550000010", property_id: "1010", message: "I am the LLC representative for the owner", stage: "Ownership Confirmation" },
  { id: "wrong-num-01", thread: "+15550000011", property_id: "1011", message: "Wrong number you have the wrong number", stage: "Ownership Confirmation" },
  { id: "opt-out-01", thread: "+15550000012", property_id: "1012", message: "STOP texting me", stage: "Ownership Confirmation" },
  { id: "hostile-01", thread: "+15550000013", property_id: "1013", message: "I will sue you if you contact me again", stage: "Ownership Confirmation" },
  { id: "referral-full-01", thread: "+15550000014", property_id: "1014", message: "Not the owner. His name is John Smith Tel 561-555-1212", stage: "Ownership Confirmation" },
  { id: "referral-phone-01", thread: "+15550000015", property_id: "1015", message: "Never been the owner call 561-555-3434", stage: "Ownership Confirmation" },
  { id: "referral-name-01", thread: "+15550000016", property_id: "1016", message: "I do not own it. His name is Maria Garcia", stage: "Ownership Confirmation" },
  { id: "referral-multi-name-01", thread: "+15550000017", property_id: "1017", message: "Not the owner. His name is Tom Wilson or His name is Jerry Lee", stage: "Ownership Confirmation" },
  { id: "referral-multi-phone-01", thread: "+15550000018", property_id: "1018", message: "Not mine. Call 561-555-1111 or 561-555-2222", stage: "Ownership Confirmation" },
  { id: "referral-bad-phone-01", thread: "+15550000019", property_id: "1019", message: "Not the owner. Tel 123", stage: "Ownership Confirmation" },
  { id: "referral-known-01", thread: "+15550000020", property_id: "1020", message: "Not the owner. Sharon Schwartz 561-706-4622", stage: "Ownership Confirmation" },
  { id: "price-01", thread: "+15550000021", property_id: "1021", message: "I want 250k for it", stage: "Asking Price" },
  { id: "condition-01", thread: "+15550000022", property_id: "1022", message: "Needs a new roof and plumbing work", stage: "Condition Probe" },
  { id: "timeline-01", thread: "+15550000023", property_id: "1023", message: "Maybe in 6 months if the price is right", stage: "Consider Selling" },
  { id: "unclear-01", thread: "+15550000024", property_id: "1024", message: "Hmm", stage: "Ownership Confirmation" },
  { id: "spanish-01", thread: "+15550000025", property_id: "1025", message: "No soy el dueño. Llame a Carlos 561-555-9090", stage: "Ownership Confirmation" },
  { id: "interest-01", thread: "+15550000026", property_id: "1026", message: "Maybe, depends on the price", stage: "Consider Selling" },
];

function buildContext(fixture) {
  return {
    found: true,
    ids: {
      master_owner_id: "21",
      prospect_id: "31",
      property_id: fixture.property_id,
      phone_item_id: "51",
    },
    summary: {
      conversation_stage: fixture.stage,
      property_address: "123 Main St",
      language_preference: "English",
      property_type: "Single Family",
    },
  };
}

async function replayFixture(fixture) {
  const context = buildContext(fixture);
  const classification = await classify(fixture.message, null);
  const relationship = resolveInboundRelationship({
    message: fixture.message,
    classification,
    source_event_id: fixture.id,
    source_thread_key: fixture.thread,
    source_contact_phone: fixture.thread,
    property_id: fixture.property_id,
    master_owner_id: "21",
  });

  const intelligence = await runInboundIntelligencePhase({
    message: fixture.message,
    threadKey: fixture.thread,
    propertyId: fixture.property_id,
    prospectId: "31",
    ownerId: "21",
    phoneId: "51",
    classification,
    latestThreadContext: context,
    context,
    route: { stage: fixture.stage, use_case: null },
    inboundFrom: fixture.thread,
    inboundEventId: fixture.id,
    legacy_plan: {
      inbound_intent: classification.primary_intent,
      should_queue_reply: false,
      safety_tier: "review",
    },
    auto_reply_mode: "disabled",
    execution_allowed: false,
    supabaseClient: null,
  });

  const snap = intelligence.intelligence_snapshot;
  const shadow = intelligence.shadow_stage;

  return {
    event_id: fixture.id,
    message_preview: fixture.message.slice(0, 90),
    classifier_output: {
      primary_intent: classification.primary_intent,
      objection: classification.objection || null,
      confidence: classification.confidence ?? null,
    },
    canonical_intent: snap.canonical_intent,
    identity_class: snap.identity_class,
    relationship_outcome: snap.relationship_outcome,
    suppression_scope: snap.suppression_scope,
    suppression_property_id: snap.suppression_property_id,
    invalidate_phone_globally: snap.invalidate_phone_globally,
    universal_stage: snap.universal_stage,
    granular_stage: snap.granular_stage,
    referral_extraction: snap.referral_detected
      ? {
          referred_name: snap.referral?.referred_name || null,
          referred_phone_e164: snap.referral?.referred_phone_e164 || null,
          referred_contact_proposed_stage: snap.referred_contact_proposed_stage,
        }
      : null,
    recommended_template: snap.recommended_use_case,
    follow_up_recommendation: snap.follow_up_recommendation,
    human_review_required: snap.human_review_required,
    automatic_send_allowed: snap.automatic_send_allowed,
    shadow_agreement: shadow?.canonical_agreement,
    shadow_disagreement_reason: shadow?.canonical_disagreement_reason || null,
    canonical_decision_summary: {
      should_suppress_contact: snap.canonical_decision?.should_suppress_contact,
      should_mark_human_review: snap.canonical_decision?.should_mark_human_review,
      next_action: snap.canonical_decision?.next_action,
    },
    stage_engine_summary: {
      engine: shadow?.shadow_stage_engine?.engine || null,
      granular_stage: shadow?.shadow_stage_engine?.granular_stage || null,
      proposed_outcome: shadow?.shadow_stage_engine?.proposed_decision?.outcome || null,
    },
    dispatchable_queue_rows: 0,
    provider_calls: 0,
    relationship_resolver: {
      relationship_claim: relationship.relationship_claim,
      is_property_scoped: relationship.is_property_scoped,
      is_global_suppression: relationship.is_global_suppression,
    },
  };
}

const results = [];
for (const fixture of FIXTURES) {
  results.push(await replayFixture(fixture));
}

const disagreements = results.filter((row) => row.shadow_agreement === false);

const output = {
  replay_count: results.length,
  dispatchable_queue_rows: 0,
  provider_calls: 0,
  production_writes: 0,
  sharon_event: results.find((r) => r.event_id === "e8bcfa53-5eba-41f6-b0f7-84b8cba80b3e"),
  shadow_disagreements: disagreements,
  results,
};

// INFO logs from runInboundIntelligencePhase go to stderr so stdout stays pure JSON.
process.stderr.write(
  `[replay-proof] cases=${results.length} disagreements=${disagreements.length}\n`
);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);