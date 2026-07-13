// ─── stage1-canary-matrix.test.mjs ──────────────────────────────────────────
// Permanent Stage 1 ownership canary matrix (promoted from the post-merge
// PR #17 validation run). Drives the CANONICAL inbound orchestrator with IO
// boundaries mocked, auto_reply_mode=internal_only, the approved internal
// test phone as sender, and a production-derived sms_templates snapshot
// (tests/fixtures/stage1-template-catalog.json).
//
// Each case asserts the full decision surface: classification, extracted
// facts, language, stage before/after, operational status, temperature,
// relationship lane, suppression, next best action, template use case,
// outbound attribution (immutable template_version_id), follow-up
// cancellation, and (case 20) duplicate-webhook idempotency.

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";

const INTERNAL_PHONE = "+16127433952"; // approved internal test phone
const OUR_NUMBER = "+16125550100";
const TEMPLATES = JSON.parse(
  fs.readFileSync(new URL("../fixtures/stage1-template-catalog.json", import.meta.url), "utf8")
);

afterEach(() => {
  __resetSellerInboundOrchestratorDeps();
});

function baseContext(caseId, { language_preference = "English" } = {}) {
  return {
    found: true,
    ids: {
      brain_item_id: 900 + caseId,
      master_owner_id: `mo-stage1-${caseId}`,
      prospect_id: `pros-stage1-${caseId}`,
      property_id: `prop-stage1-${caseId}`,
      phone_item_id: `phone-stage1-${caseId}`,
    },
    summary: {
      conversation_stage: "ownership_check",
      seller_stage: "ownership_check",
      property_address: "4157 Pillsbury Ave S",
      seller_first_name: "Ryan",
      city: "Minneapolis",
      ...(language_preference ? { language_preference } : {}),
    },
  };
}

async function runCase(caseId, message, { language_preference = "English", eventSuffix = null, existingQueueRows = [] } = {}) {
  const inserted_queue_rows = [];
  const recorded = { cancellations: [], workflow_events: [] };
  const supabase = makeSellerOrchestrationSupabase({
    templates: TEMPLATES,
    sendQueueRows: existingQueueRows,
    insertedQueueRows: inserted_queue_rows,
  });

  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => supabase,
    patchUniversalLeadState: async ({ patch }) => ({ ok: true, patch, dry_run: true }),
    emitAutomationEvent: async (event) => {
      recorded.workflow_events.push(event.event_type);
      return { ok: true };
    },
    persistInboundIntelligenceSnapshot: async () => ({ ok: true, dry_run: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async (intent) => ({
      ok: true,
      followup_created: true,
      scheduled_for: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      reason: `nurture_followup:${intent}`,
    }),
    cancelPendingFollowUpsForThread: async ({ thread_key }) => {
      recorded.cancellations.push(thread_key);
      return { ok: true, cancelled: 1, reason: "inbound_takeover" };
    },
  });

  const suffix = eventSuffix || String(caseId);
  const classification = await classify(message, null, { heuristicOnly: true });
  const result = await processSellerInboundMessage({
    message,
    threadKey: INTERNAL_PHONE,
    propertyId: `prop-stage1-${caseId}`,
    prospectId: `pros-stage1-${caseId}`,
    ownerId: `mo-stage1-${caseId}`,
    phoneId: `phone-stage1-${caseId}`,
    classification,
    context: baseContext(caseId, { language_preference }),
    route: { stage: "ownership_check", use_case: "ownership_check" },
    inboundFrom: INTERNAL_PHONE,
    inboundTo: OUR_NUMBER,
    inboundEventId: `evt-stage1-${suffix}`,
    providerMessageId: `SM-stage1-${suffix}`,
    stageBefore: "ownership_check",
    autoReplyMode: "internal_only",
    supabaseClient: supabase,
  });

  const provenance =
    inserted_queue_rows[0]?.metadata?.automation_provenance ||
    inserted_queue_rows[0]?.payload?.metadata?.automation_provenance ||
    null;

  return { result, inserted_queue_rows, provenance, recorded };
}

function assertInboundCancelledFollowups(result, recorded) {
  assert.equal(result.followup_cancellation?.ok, true, "inbound must run follow-up cancellation");
  assert.ok(Number(result.followup_cancellation?.cancelled) >= 1, "pending follow-up must be cancelled");
  assert.ok(recorded.cancellations.includes(INTERNAL_PHONE));
}

function assertQueuedWithAttribution({ result, provenance }, { use_case, language, stage_code }) {
  assert.equal(result.queued, true, "reply must queue");
  assert.equal(result.execution?.selected_template?.use_case, use_case);
  assert.equal(result.execution?.selected_template?.language, language);
  if (stage_code) assert.equal(result.execution?.selected_template?.stage_code, stage_code);
  assert.ok(provenance, "queued send must carry automation_provenance");
  assert.match(String(provenance.template_version_id), /^sha1:[0-9a-f]{40}$/, "immutable template version required");
  assert.equal(provenance.language, language);
  assert.equal(provenance.automation_origin, "autopilot_inbound_reply");
}

// ── 1. Owner confirmation (EN) ──────────────────────────────────────────────
test("matrix#1: 'Yes, I own it' → S1→S2, consider_selling EN queued", async () => {
  const run = await runCase(1, "Yes, I own it");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "ownership_confirmed");
  assert.equal(result.fact_extraction.facts.ownership.value.ownership_claim, "confirmed");
  assert.equal(result.decision.stage_before, "ownership_confirmation");
  assert.equal(result.decision.stage_after, "offer_interest");
  assert.equal(result.transition.lead_temperature, "warm");
  assert.equal(result.universal_state_patch.patch.operational_status, "active_communication");
  assert.equal(result.decision.next_action, "send_message_now");
  assertQueuedWithAttribution(run, { use_case: "consider_selling", language: "English", stage_code: "S2" });
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 2. Ownership + interest in one reply (EN) ───────────────────────────────
test("matrix#2: 'Yes, what's your offer?' → S1→S3, condition probe, no Stage 2 re-ask", async () => {
  const run = await runCase(2, "Yes, what's your offer?");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "asks_offer");
  assert.equal(result.fact_extraction.facts.offer_interest.value.wants_offer, true);
  assert.equal(result.decision.stage_after, "asking_price");
  assert.equal(result.transition.lead_temperature, "hot");
  assert.equal(result.transition.disposition, "interested");
  // The reply must move the conversation forward — NEVER the S2 interest question.
  assert.notEqual(result.execution?.selected_template?.use_case, "consider_selling");
  assertQueuedWithAttribution(run, { use_case: "condition_probe", language: "English", stage_code: "S4" });
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 3. Ownership + interest + price in one reply (EN) ───────────────────────
test("matrix#3: 'Yes, I own it and want 120k' → S1→S4, price captured, condition probe EN", async () => {
  const run = await runCase(3, "Yes, I own it and want 120k");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "ownership_confirmed");
  assert.equal(result.fact_extraction.facts.ownership.value.ownership_claim, "confirmed");
  assert.equal(result.fact_extraction.facts.asking_price.value.amount, 120000);
  assert.equal(result.decision.stage_after, "property_condition");
  assert.equal(result.transition.lead_temperature, "hot");
  // Ownership, interest, and price already answered → S2/S3 questions skipped.
  assert.notEqual(result.execution?.selected_template?.use_case, "consider_selling");
  assert.notEqual(result.execution?.selected_template?.use_case, "seller_asking_price");
  assertQueuedWithAttribution(run, { use_case: "condition_probe", language: "English", stage_code: "S4" });
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 4. Wrong number ─────────────────────────────────────────────────────────
test("matrix#4: 'No, wrong number' → blocked, invalid_number, no reply", async () => {
  const run = await runCase(4, "No, wrong number");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "wrong_number");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.transition.contactability_patch?.contactability_status, "invalid_number");
  assert.equal(result.universal_state_patch.patch.operational_status, "paused");
  assert.equal(result.decision.next_action, "no_action_contact_blocked");
  assert.equal(result.queued, false);
  assert.equal(result.execution?.selected_template, null);
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 5. Not the owner ────────────────────────────────────────────────────────
test("matrix#5: 'I am not the owner' → non-owner hold, no reply", async () => {
  const run = await runCase(5, "I am not the owner");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "property_specific_non_owner");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false);
  assert.equal(result.decision.block_reason, "property_relationship_review_required");
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 6. Former owner ─────────────────────────────────────────────────────────
test("matrix#6: 'I sold it years ago' → former-owner hold, no reply", async () => {
  const run = await runCase(6, "I sold it years ago");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "former_owner_respondent");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false);
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 7. Tenant lane ──────────────────────────────────────────────────────────
test("matrix#7: tenant reply → tenant lane, contact preserved, no owner flow", async () => {
  const run = await runCase(7, "I am the tenant, I just rent here");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "tenant_respondent");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false);
  assert.equal(result.universal_state_patch.patch.contactability_status, "contactable");
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 8. Family member lane (EN) ──────────────────────────────────────────────
test("matrix#8: 'This is her son' → family_member lane, review, contact preserved, no ownership", async () => {
  const run = await runCase(8, "This is her son, my mom owns the house");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "family_member_respondent");
  assert.equal(result.intelligence_snapshot?.identity_class, "family_member");
  // A relative is NOT the owner and has NO implied signing authority.
  assert.equal(result.contract.ownership_signal, "unknown");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false, "family lane must not auto-send without an approved template");
  assert.equal(result.universal_state_patch.patch.contactability_status, "contactable");
  assert.ok(result.decision.next_action, "deterministic next action required");
  assert.equal(result.decision.block_reason, "property_relationship_review_required");
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 9. Property manager lane (EN) ───────────────────────────────────────────
test("matrix#9: 'I manage the property' → property_manager lane, review, contact preserved", async () => {
  const run = await runCase(9, "I manage the property for the owner");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "property_manager_respondent");
  assert.equal(result.intelligence_snapshot?.identity_class, "property_manager");
  assert.equal(result.contract.ownership_signal, "unknown");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false, "manager lane must not auto-send without an approved template");
  assert.equal(result.universal_state_patch.patch.contactability_status, "contactable");
  assert.ok(result.decision.next_action, "deterministic next action required");
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 10. Co-owner ────────────────────────────────────────────────────────────
test("matrix#10: 'My wife and I own it' → ownership confirmed, no authority implied", async () => {
  const run = await runCase(10, "My wife and I own it together");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "ownership_confirmed");
  assert.equal(result.decision.stage_after, "offer_interest");
  assertQueuedWithAttribution(run, { use_case: "consider_selling", language: "English", stage_code: "S2" });
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 11. Listing agent lane ──────────────────────────────────────────────────
test("matrix#11: listing agent → agent lane, review, no owner flow", async () => {
  const run = await runCase(11, "I am the listing agent for this property");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "agent_representative_respondent");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false);
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 12/13. Identity questions hold stage and answer identity ────────────────
test("matrix#12: 'Who is this?' → identity template, stage held", async () => {
  const run = await runCase(12, "Who is this?");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "who_is_this");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assertQueuedWithAttribution(run, { use_case: "who_is_this", language: "English", stage_code: "SP" });
  assertInboundCancelledFollowups(result, run.recorded);
});

test("matrix#13: 'Maybe, what is this regarding?' → identity template, stage held", async () => {
  const run = await runCase(13, "Maybe, what is this regarding?");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "who_is_this");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assertQueuedWithAttribution(run, { use_case: "who_is_this", language: "English", stage_code: "SP" });
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 14/15. Opt-out and hostile/legal stop the owner flow ────────────────────
test("matrix#14: 'Stop' → opted_out, blocked, no reply", async () => {
  const run = await runCase(14, "Stop");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "opt_out");
  assert.equal(result.transition.contactability_patch?.contactability_status, "opted_out");
  assert.equal(result.universal_state_patch.patch.operational_status, "paused");
  assert.equal(result.queued, false);
  assertInboundCancelledFollowups(result, run.recorded);
});

test("matrix#15: hostile/legal → suppressed, owner flow stopped", async () => {
  const run = await runCase(15, "Stop harassing me or I will call my lawyer and report you");
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "opt_out");
  assert.equal(result.transition.contactability_patch?.contactability_status, "opted_out");
  assert.equal(result.queued, false);
  assert.equal(result.decision.next_action, "no_action_contact_blocked");
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 16. Spanish ownership stays Spanish ─────────────────────────────────────
test("matrix#16: Spanish owner confirmation → Spanish consider_selling", async () => {
  const run = await runCase(16, "Sí, soy el dueño de la propiedad", { language_preference: null });
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "ownership_confirmed");
  assert.equal(result.decision.stage_after, "offer_interest");
  assertQueuedWithAttribution(run, { use_case: "consider_selling", language: "Spanish", stage_code: "S2" });
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 17. Spanish owner + price: EN/ES parity, no redundant question ──────────
test("matrix#17: Spanish owner + price → S1→S4, Spanish condition probe (no S2/S3 re-ask)", async () => {
  const run = await runCase(17, "Sí, soy el propietario y quiero 150000 por la casa", { language_preference: null });
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "ownership_confirmed");
  assert.equal(result.fact_extraction.facts.asking_price.value.amount, 150000);
  assert.equal(result.decision.stage_after, "property_condition");
  assert.equal(result.transition.lead_temperature, "hot");
  // Redundant-question regression (Stage 1 canary defect): ownership,
  // interest, and price arrived in ONE message — the reply must be the S4
  // condition question, never the S2 interest or S3 price question.
  assert.notEqual(result.execution?.selected_template?.use_case, "consider_selling");
  assert.notEqual(result.execution?.selected_template?.use_case, "seller_asking_price");
  assertQueuedWithAttribution(run, { use_case: "condition_probe", language: "Spanish", stage_code: "S4" });
  assertInboundCancelledFollowups(result, run.recorded);
});

test("matrix#3/#17 parity: EN and ES owner+price replies select the same use case", async () => {
  const en = await runCase(3, "Yes, I own it and want 120k", { eventSuffix: "3-parity" });
  const es = await runCase(17, "Sí, soy el propietario y quiero 150000 por la casa", {
    language_preference: null,
    eventSuffix: "17-parity",
  });
  assert.equal(en.result.execution?.selected_template?.use_case, es.result.execution?.selected_template?.use_case);
  assert.equal(en.result.execution?.selected_template?.language, "English");
  assert.equal(es.result.execution?.selected_template?.language, "Spanish");
  assert.equal(en.result.decision.stage_after, es.result.decision.stage_after);
});

// ── 18. Unsupported language fails closed ───────────────────────────────────
test("matrix#18: unsupported language → fail closed to human review, no template", async () => {
  const run = await runCase(18, "Oui, je suis le propriétaire de cette maison", { language_preference: null });
  const { result } = run;
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false);
  assert.equal(result.execution?.selected_template, null);
  assert.equal(result.decision.next_action, "human_review");
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 19. Contradictory ownership cannot advance the lifecycle ────────────────
test("matrix#19: contradictory ownership → conflict flagged, stage HELD at S1, review, no send", async () => {
  const run = await runCase(19, "Yes I own it. Well actually I sold it last year.");
  const { result } = run;
  assert.equal(result.fact_extraction.facts.ownership.value.ownership_claim, "contradictory");
  assert.ok(
    (result.fact_extraction.conflicts || []).some((c) => c.field === "ownership"),
    "extraction conflict must be flagged"
  );
  // Transition-validator guard: unresolved contradictory ownership evidence
  // must never advance the lifecycle or persist ownership as settled truth.
  assert.equal(result.transition.stage_after, "ownership_confirmation");
  assert.equal(result.transition.advanced, false);
  assert.equal(result.transition.reasoning_code, "S1_HOLD_OWNERSHIP_CONFLICT");
  assert.equal(result.transition.ownership_patch, null);
  assert.equal(result.transition.review_required, true);
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.universal_state_patch.patch.lifecycle_stage, "ownership_confirmation");
  assert.equal(result.universal_state_patch.patch.operational_status, "needs_review");
  assert.equal(result.universal_state_patch.patch.next_action, "human_review");
  assert.equal(result.queued, false);
  assertInboundCancelledFollowups(result, run.recorded);
});

// ── 20. Duplicate webhook delivery is idempotent ────────────────────────────
test("matrix#20: duplicate webhook delivery → suppressed, no second queue row", async () => {
  const first = await runCase(20, "Yes, I own it", { eventSuffix: "20-dup" });
  assert.equal(first.result.queued, true);
  assert.equal(first.inserted_queue_rows.length, 1);

  const existing = first.inserted_queue_rows.map((row) => ({
    ...row,
    source_event_id: row.source_event_id || row.payload?.source_event_id || "evt-stage1-20-dup",
    type: row.type || "auto_reply",
    status: "queued",
  }));

  const replay = await runCase(20, "Yes, I own it", {
    eventSuffix: "20-dup",
    existingQueueRows: existing,
  });
  assert.equal(replay.result.idempotent.duplicate_suppressed, true, "replay must be suppressed");
  assert.equal(replay.inserted_queue_rows.length, 0, "replay must not insert a second queue row");
  // State evaluation stays deterministic on replay.
  assert.equal(replay.result.decision.stage_after, first.result.decision.stage_after);
  assertInboundCancelledFollowups(replay.result, replay.recorded);
});

// ── Representative Spanish lane fixtures (family / property manager) ────────
test("lanes-es: 'Soy su hijo…' → family_member lane, review, contact preserved", async () => {
  const run = await runCase(21, "Soy su hijo, mi mamá es la dueña de la casa", { language_preference: null, eventSuffix: "21-es-family" });
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "family_member_respondent");
  assert.equal(result.intelligence_snapshot?.identity_class, "family_member");
  assert.equal(result.contract.ownership_signal, "unknown");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false);
  assertInboundCancelledFollowups(result, run.recorded);
});

test("lanes-es: 'Administro la propiedad…' → property_manager lane, review, contact preserved", async () => {
  const run = await runCase(22, "Administro la propiedad del dueño", { language_preference: null, eventSuffix: "22-es-pm" });
  const { result } = run;
  assert.equal(result.contract.normalized_intent, "property_manager_respondent");
  assert.equal(result.intelligence_snapshot?.identity_class, "property_manager");
  assert.equal(result.decision.stage_after, "ownership_confirmation");
  assert.equal(result.queued, false);
  assertInboundCancelledFollowups(result, run.recorded);
});
