// ─── deterministic-launch-lifecycle-core.test.mjs ───────────────────────────
// Deterministic, local, no-network proof of the CORE outbound automation
// lifecycle: eligible owner selected -> send_queue creation -> owner/
// suppression guards -> campaign-live gating -> send-eligibility -> fake-
// provider dispatch -> canonical inbox thread state -> simulated inbound
// reply -> deterministic classification -> stage/bucket/temperature/
// follow-up sync -> no double queue/send -> opt-out/wrong-number/renter/
// non-owner fail closed.
//
// SCOPE — read before extending this file's claims:
//   - "Campaign scheduling" here means runSendQueue's live-campaign gate
//     (filterRowsByLiveCampaigns, real code) holding a queued row back until
//     its campaign is live. It does NOT exercise the full campaign hydration
//     path (createCampaignQueuePlan / activateCampaignWithHydration in
//     campaign-automation-service.js), which independently resolves ready
//     campaign_targets, chooses a TextGrid number, renders a template, groups
//     targets into per-timezone send windows, and bulk-inserts send_queue
//     rows directly (bypassing enqueueSendQueueItem's canonical dedupe
//     wrapper). That path is real, Supabase-only (no Podio calls found), and
//     plausibly testable with fixtures for campaign_targets/campaign_send_
//     windows/sms_templates/textgrid_numbers — it was not attempted here
//     because it is a substantially larger, separate proof, not a hardening
//     pass on this one. Treat "scheduled campaign -> candidate selection ->
//     canonical send_queue insertion" as UNPROVEN until that function
//     actually executes in a test.
//
// Every step that IS covered below calls the REAL production function for
// that stage (no reimplemented business logic). The only fakes are an
// in-memory Supabase substitute (tests/helpers/lifecycle-integration-store.mjs)
// and a fake TextGrid provider — no real SMS/email is ever sent and no
// production data is read. All timestamps are fixed; nothing here depends on
// wall-clock time.
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePreSendEligibility,
} from "@/lib/domain/outbound/presend-eligibility-engine.js";
import { evaluateCandidateEligibility } from "@/lib/domain/outbound/supabase-candidate-feeder.js";
import {
  buildSendQueueDedupeKey,
  enqueueSendQueueItem,
} from "@/lib/supabase/sms-engine.js";
import { runSendQueue } from "@/lib/domain/queue/run-send-queue.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import {
  threadMatchesBucketFilter,
  threadMatchesWaitingFacts,
} from "@/lib/domain/inbox/inbox-bucket-predicates.js";
import { resolveEffectiveInboxBucket } from "@/lib/domain/inbox/inbox-thread-state-contract.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { normalizeClassificationContract } from "@/lib/domain/seller-flow/normalize-classification-contract.js";
import { buildThreadStatePatchFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { resolveSellerStageTransition } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import {
  resolveFollowUpPlan,
  scheduleFollowUp,
} from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import {
  CONTACTABILITY_CODES,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";

import {
  makeLifecycleStore,
  makeLifecycleWriteDeps,
  makeLifecycleQueueRunDeps,
} from "../helpers/lifecycle-integration-store.mjs";

// 10:00 AM America/Chicago on 2026-04-04 — inside the 8am-9pm local send
// window enforced by evaluateContactWindow(). Fixed throughout; no test in
// this file reads the real wall clock.
const NOW = "2026-04-04T15:00:00.000Z";
const REPLY_AT = "2026-04-04T16:00:00.000Z";
const OUR_NUMBER = "+15559990001";

function buildEligibleCandidate(overrides = {}) {
  return {
    master_owner_id: "mo_e2e_1",
    property_id: "prop_e2e_1",
    phone_id: "ph_e2e_1",
    best_phone_id: "ph_e2e_1",
    canonical_e164: "+15551230001",
    owner_display_name: "John Smith",
    prospect_full_name: "John Smith",
    phone_full_name: "John Smith",
    seller_full_name: "John Smith",
    seller_first_name: "John",
    likely_owner: true,
    likely_renting: false,
    property_address_full: "123 Main St, Austin, TX",
    ...overrides,
  };
}

function buildQueuePayload(candidate, { campaign_id = null, touch_number = 1, use_case = "consider_selling", scheduled_for = NOW } = {}) {
  const dedupe_key = buildSendQueueDedupeKey({
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    to_phone_number: candidate.canonical_e164,
    template_use_case: use_case,
    touch_number,
    campaign_session_id: null,
  });
  const message_body = `Hi ${candidate.seller_first_name}, are you open to selling ${candidate.property_address_full}? Reply STOP to opt out.`;
  return {
    queue_key: dedupe_key,
    queue_id: dedupe_key,
    dedupe_key,
    queue_status: "queued",
    scheduled_for,
    scheduled_for_utc: scheduled_for,
    scheduled_for_local: scheduled_for,
    message_body,
    message_text: message_body,
    to_phone_number: candidate.canonical_e164,
    from_phone_number: OUR_NUMBER,
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
    phone_id: candidate.phone_id,
    touch_number,
    use_case_template: use_case,
    seller_first_name: candidate.seller_first_name,
    campaign_id,
    metadata: { source: "e2e_launch_automation_proof" },
  };
}

/** Selection guard every real caller applies before a row is ever queued. */
async function selectAndQueue(candidate, writeDeps, queueOptions = {}) {
  const eligibility = await evaluateCandidateEligibility(candidate, {}, writeDeps);
  if (!eligibility.ok) {
    return { queued: false, eligibility };
  }
  const insert = await enqueueSendQueueItem(buildQueuePayload(candidate, queueOptions), writeDeps);
  return { queued: insert.ok !== false, eligibility, insert };
}

test("core lifecycle: guard -> campaign-gated queue -> send -> inbox -> reply -> classify -> stage/bucket/followup sync, no double-queue/send", async () => {
  const store = makeLifecycleStore();
  const CAMPAIGN_ID = "campaign_e2e_1";
  store.setCampaign(CAMPAIGN_ID, "draft"); // not live yet

  const candidate = buildEligibleCandidate();

  // ── 1 & 4. Eligible owner lead selected — real pre-send guard ───────────
  const presend = evaluatePreSendEligibility(candidate, {});
  assert.equal(presend.eligible, true, `expected eligible candidate to pass: ${presend.reason}`);
  assert.equal(presend.hard_block, false);

  // ── 2 & 3. send_queue row created (real canonical writer), carrying a
  // campaign_id — NOT the full createCampaignQueuePlan scheduling/hydration
  // path (see file header). ────────────────────────────────────────────────
  const writeDeps = makeLifecycleWriteDeps(store, NOW);
  const first = await selectAndQueue(candidate, writeDeps, { campaign_id: CAMPAIGN_ID });
  assert.equal(first.queued, true, JSON.stringify(first.insert));
  assert.equal(store.sendQueueRows.size, 1);
  const queueRowId = first.insert.queue_row_id;

  // ── 11. No lead may be double-queued: re-selecting the same candidate/touch
  // hits the DB-equivalent unique dedupe_key constraint and replays idempotently.
  const second = await selectAndQueue(candidate, writeDeps, { campaign_id: CAMPAIGN_ID });
  assert.equal(second.insert.idempotent_replay, true);
  assert.equal(second.insert.queue_row_id, queueRowId);
  assert.equal(store.sendQueueRows.size, 1, "duplicate candidate selection must not create a second row");

  // ── 5. Campaign gates send-eligibility (real runSendQueue) ───────────────
  const textgridCalls = [];
  const runDeps = makeLifecycleQueueRunDeps(store, {
    now: NOW,
    sendTextgridSMS: async ({ to, from, body }) => {
      textgridCalls.push({ to, from, body });
      return { sid: "SMfakeprovidersid0001" };
    },
  });

  const blockedRun = await runSendQueue({ limit: 10, now: NOW }, runDeps);
  assert.equal(blockedRun.sent_count, 0, "row must be held back while its campaign is not live");
  assert.equal(textgridCalls.length, 0, "no provider call while campaign-gated");
  assert.equal(store.sendQueueRows.get(queueRowId).queue_status, "queued");

  store.setCampaign(CAMPAIGN_ID, "active");

  // ── 6. Fake/local provider records a successful outbound send ───────────
  const liveRun = await runSendQueue({ limit: 10, now: NOW }, runDeps);
  assert.equal(liveRun.sent_count, 1, JSON.stringify(liveRun.results));
  assert.equal(textgridCalls.length, 1);
  assert.equal(textgridCalls[0].to, candidate.canonical_e164);

  const sentRow = store.sendQueueRows.get(queueRowId);
  assert.equal(sentRow.queue_status, "sent");
  assert.ok(sentRow.provider_message_id, "queue row must carry the provider message id after send");

  assert.equal(store.messageEvents.length, 1);
  const outboundEvent = store.messageEvents[0];
  assert.equal(outboundEvent.direction, "outbound", "outbound send must never be recorded as inbound");
  assert.equal(outboundEvent.to_phone_number, candidate.canonical_e164);

  // ── 11 (retry idempotency). Re-processing the already-sent row must not
  // call the provider again and must not write a second message event.
  const retryResult = await processSendQueueItem(sentRow, { ...runDeps, now: NOW });
  assert.equal(retryResult.sent, true);
  assert.equal(retryResult.reason, "idempotency_blocked_sid_exists");
  assert.equal(textgridCalls.length, 1, "retrying an already-sent row must not re-invoke the provider");
  assert.equal(store.messageEvents.length, 1, "retrying an already-sent row must not duplicate the message event");

  // ── 7. Outbound message appears in the canonical inbox thread ("Waiting") ─
  // Computed entirely by the real bucket-derivation chain
  // (buildThreadStatePatchFromClassification -> resolveInboxBucketFromClassification
  // -> resolveOutboundReplyState) with a fixed `now` injected — never manually
  // assigned. See inbox-waiting-bucket-determinism.test.mjs for focused
  // coverage of that chain's determinism.
  const afterSendMs = new Date(NOW).getTime();
  const outboundPatch = buildThreadStatePatchFromClassification({
    messageEvent: { direction: "outbound", sent_at: outboundEvent.sent_at },
    classification: {},
    existingState: {},
    now: afterSendMs,
  });
  assert.equal(outboundPatch.inbox_bucket, "waiting", "the real derivation chain must compute waiting from outbound evidence");

  let threadState = {
    thread_key: candidate.canonical_e164,
    ...outboundPatch,
    master_owner_id: candidate.master_owner_id,
    property_id: candidate.property_id,
  };
  assert.equal(threadMatchesWaitingFacts(threadState, afterSendMs), true);
  assert.equal(threadMatchesBucketFilter(threadState, "waiting", afterSendMs), true);
  assert.equal(resolveEffectiveInboxBucket(threadState, afterSendMs), "waiting");
  assert.equal(threadMatchesBucketFilter(threadState, "dead", afterSendMs), false);
  assert.equal(threadMatchesBucketFilter(threadState, "suppressed", afterSendMs), false);

  // ── 8 & 9. Simulated inbound owner reply ingested + classified deterministically ─
  const replyText = "Yes I'm the owner, I might sell, what's your offer for the house?";
  store.recordMessageEvent({
    direction: "inbound",
    thread_key: candidate.canonical_e164,
    to_phone_number: OUR_NUMBER,
    from_phone_number: candidate.canonical_e164,
    message_body: replyText,
    created_at: REPLY_AT,
  });

  const classification = await classify(replyText, null, { heuristicOnly: true });
  assert.equal(classification.compliance_flag, null);
  assert.notEqual(classification.primary_intent, "opt_out");
  assert.notEqual(classification.primary_intent, "wrong_number");

  const messageEvent = { direction: "inbound", message_body: replyText, received_at: REPLY_AT };
  const afterReplyMs = new Date(REPLY_AT).getTime();

  // ── 10. Thread bucket / status / temperature update correctly (real resolver) ─
  const patch = buildThreadStatePatchFromClassification({
    messageEvent,
    classification,
    existingState: threadState,
    now: afterReplyMs,
  });
  assert.equal(patch.opt_out, false);
  assert.equal(patch.wrong_number, false);
  assert.notEqual(patch.inbox_bucket, "suppressed");
  assert.notEqual(patch.disposition, "wrong_number");

  threadState = {
    ...threadState,
    ...patch,
    last_inbound_at: REPLY_AT,
  };
  assert.equal(
    threadMatchesWaitingFacts(threadState, afterReplyMs),
    false,
    "a thread with a live inbound reply must leave the Waiting bucket"
  );

  // Message-level integrity: the outbound send is never re-labelled inbound,
  // and the inbound reply is never displayed as a delivered outbound send.
  assert.equal(outboundEvent.direction, "outbound");
  const inboundEvent = store.messageEvents.find((e) => e.direction === "inbound");
  assert.ok(inboundEvent);
  assert.notEqual(inboundEvent.direction, "outbound");

  // ── Seller stage / follow-up sync (real resolvers, fed through the same
  // classification -> canonical-intent bridge production code uses) ────────
  const { contract } = normalizeClassificationContract({
    classification,
    message: replyText,
    threadId: candidate.canonical_e164,
    phone: candidate.canonical_e164,
    propertyId: candidate.property_id,
  });

  const transition = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: contract.normalized_intent,
    classification_confidence: classification.confidence,
    now: REPLY_AT,
  });
  assert.equal(transition.stage_before, "ownership_confirmation");
  assert.notEqual(transition.next_action, "no_action_contact_blocked");
  assert.ok(
    transition.stage_after !== "ownership_confirmation" || transition.review_required === true,
    "a clearly engaged reply must either advance the lifecycle stage or route to human review, never sit silently"
  );

  const followupPlan = resolveFollowUpPlan(contract.normalized_intent, {
    thread_key: candidate.canonical_e164,
  });
  assert.equal(followupPlan.suppressed, false, "an engaged, non-suppressed reply must not be permanently suppressed");
});

test("E2E: opt-out reply suppresses this thread's bucket/follow-up and fails closed on future sends", async () => {
  const store = makeLifecycleStore();
  const candidate = buildEligibleCandidate({ master_owner_id: "mo_e2e_optout" });
  const writeDeps = makeLifecycleWriteDeps(store, NOW);

  const first = await selectAndQueue(candidate, writeDeps, { touch_number: 1 });
  assert.equal(first.queued, true);

  // A second, later touch is already queued when the STOP reply lands.
  const pending = await selectAndQueue(candidate, writeDeps, { touch_number: 2 });
  assert.equal(pending.queued, true);
  const pendingRowId = pending.insert.queue_row_id;

  const replyText = "STOP";
  store.recordMessageEvent({
    direction: "inbound",
    thread_key: candidate.canonical_e164,
    to_phone_number: OUR_NUMBER,
    from_phone_number: candidate.canonical_e164,
    message_body: replyText,
    is_opt_out: true,
    created_at: REPLY_AT,
  });

  const classification = await classify(replyText, null, { heuristicOnly: true });
  assert.equal(classification.compliance_flag, "stop_texting");

  const messageEvent = { direction: "inbound", message_body: replyText, received_at: REPLY_AT };
  const patch = buildThreadStatePatchFromClassification({
    messageEvent,
    classification,
    existingState: {},
    now: new Date(REPLY_AT).getTime(),
  });
  assert.equal(patch.opt_out, true);
  assert.equal(patch.inbox_bucket, "suppressed");
  assert.equal(patch.disposition, "suppressed");
  assert.equal(patch.universal_status, "suppressed");

  const { contract } = normalizeClassificationContract({
    classification,
    message: replyText,
    threadId: candidate.canonical_e164,
    phone: candidate.canonical_e164,
  });
  assert.equal(contract.opt_out_signal, true);

  const transition = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: contract.normalized_intent,
    now: REPLY_AT,
  });
  assert.equal(transition.next_action, "no_action_contact_blocked");
  assert.equal(transition.contactability_patch.contactability_status, CONTACTABILITY_CODES.OPTED_OUT);
  assert.equal(transition.follow_up.cancel, true);
  assert.equal(transition.advanced, false, "opt-out must never advance the lifecycle stage");

  const followupPlan = resolveFollowUpPlan(contract.normalized_intent, { thread_key: candidate.canonical_e164 });
  assert.equal(followupPlan.suppressed, true);
  assert.equal(followupPlan.followup_created, false);

  const scheduleAttempt = await scheduleFollowUp(contract.normalized_intent, candidate.canonical_e164, {}, writeDeps.supabase);
  assert.equal(scheduleAttempt.ok, false);
  assert.equal(scheduleAttempt.skipped, true);
  assert.equal(store.sendQueueRows.size, 2, "opt-out must never enqueue a new follow-up row");

  // ── Fail-closed proof: the already-queued second touch must be blocked at
  // send time by the real compliance gate, using the persisted opt-out signal.
  const runDeps = makeLifecycleQueueRunDeps(store, {
    now: REPLY_AT,
    sendTextgridSMS: async () => {
      throw new Error("provider must never be called for a suppressed thread");
    },
  });
  const pendingRow = store.sendQueueRows.get(pendingRowId);
  const blockResult = await processSendQueueItem(pendingRow, { ...runDeps, now: REPLY_AT });
  assert.equal(blockResult.sent, false);
  assert.equal(blockResult.final_queue_status, "cancelled");
  assert.equal(store.sendQueueRows.get(pendingRowId).queue_status, "cancelled");
});

test("E2E: wrong-number reply fails closed and blocks future sends", async () => {
  // Text chosen to hit exactly the "actual_wrong_number" relationship claim
  // (see resolve-inbound-relationship.js's ACTUAL_WRONG_NUMBER_PHRASES).
  // "Sold the property"/"not the owner"/"never owned" resolve to distinct
  // canonical intents (former_owner_respondent / property_specific_non_owner)
  // — see seller-followup-suppression-drift.test.mjs for dedicated,
  // precisely-worded coverage of each.
  const store = makeLifecycleStore();
  const candidate = buildEligibleCandidate({ master_owner_id: "mo_e2e_wrongnum" });
  const writeDeps = makeLifecycleWriteDeps(store, NOW);

  const first = await selectAndQueue(candidate, writeDeps, { touch_number: 1 });
  assert.equal(first.queued, true);
  const pending = await selectAndQueue(candidate, writeDeps, { touch_number: 2 });
  assert.equal(pending.queued, true);
  const pendingRowId = pending.insert.queue_row_id;

  const replyText = "You have the wrong number, this isn't me.";
  const classification = await classify(replyText, null, { heuristicOnly: true });
  assert.equal(classification.objection, "wrong_number");

  const messageEvent = { direction: "inbound", message_body: replyText, received_at: REPLY_AT };
  const patch = buildThreadStatePatchFromClassification({
    messageEvent,
    classification,
    existingState: {},
    now: new Date(REPLY_AT).getTime(),
  });
  assert.equal(patch.wrong_number, true);
  assert.equal(patch.disposition, "wrong_number");

  const { contract } = normalizeClassificationContract({
    classification,
    message: replyText,
    threadId: candidate.canonical_e164,
    phone: candidate.canonical_e164,
  });
  assert.equal(contract.wrong_number_signal, true);

  const transition = resolveSellerStageTransition({
    stage_before: "ownership_confirmation",
    intent: contract.normalized_intent,
    now: REPLY_AT,
  });
  assert.equal(transition.next_action, "no_action_contact_blocked");
  assert.equal(transition.ownership_patch?.ownership_status, "not_owner");
  assert.equal(transition.follow_up.cancel, true);
  assert.equal(transition.evaluate_alternate_contact, true);

  // Persist exactly what the transition emitted, as production code would,
  // then prove the send-time compliance gate independently blocks future sends.
  store.setThreadState(candidate.canonical_e164, {
    contactability_status: transition.contactability_patch.contactability_status,
  });
  assert.equal(transition.contactability_patch.contactability_status, CONTACTABILITY_CODES.INVALID_NUMBER);

  const runDeps = makeLifecycleQueueRunDeps(store, {
    now: REPLY_AT,
    sendTextgridSMS: async () => {
      throw new Error("provider must never be called for a wrong-number thread");
    },
  });
  const pendingRow = store.sendQueueRows.get(pendingRowId);
  const blockResult = await processSendQueueItem(pendingRow, { ...runDeps, now: REPLY_AT });
  assert.equal(blockResult.sent, false);
  assert.equal(blockResult.final_queue_status, "cancelled");
});

test("E2E: renter and unverified-identity candidates never become send-eligible (fail closed, pre-send)", async () => {
  const store = makeLifecycleStore();
  const writeDeps = makeLifecycleWriteDeps(store, NOW);

  // renter_flag=true must never establish owner eligibility, even with likely_owner absent.
  const renter = buildEligibleCandidate({
    master_owner_id: "mo_e2e_renter",
    likely_owner: false,
    likely_renting: true,
  });
  const renterPresend = evaluatePreSendEligibility(renter, {});
  assert.equal(renterPresend.eligible, false);
  assert.equal(renterPresend.hard_block, true);
  assert.equal(renterPresend.block_reason, "RENTER_NOT_OWNER");

  const renterSelection = await selectAndQueue(renter, writeDeps);
  assert.equal(renterSelection.queued, false);
  assert.equal(renterSelection.eligibility.reason_code, "RENTER_NOT_OWNER");

  // Missing / ambiguous identity (no name-match signals at all) must fail
  // closed by default rather than defaulting to eligible.
  const ambiguous = {
    master_owner_id: "mo_e2e_ambiguous",
    property_id: "prop_e2e_ambiguous",
    phone_id: "ph_e2e_ambiguous",
    best_phone_id: "ph_e2e_ambiguous",
    canonical_e164: "+15551230099",
    likely_owner: null,
    likely_renting: null,
  };
  const ambiguousPresend = evaluatePreSendEligibility(ambiguous, {});
  assert.equal(ambiguousPresend.eligible, false);
  assert.equal(ambiguousPresend.reason, "identity_not_verified");

  const ambiguousSelection = await selectAndQueue(ambiguous, writeDeps);
  assert.equal(ambiguousSelection.queued, false);

  assert.equal(store.sendQueueRows.size, 0, "no ineligible candidate may ever reach send_queue");
});

test("E2E: duplicate provider webhook event does not double-send", async () => {
  const store = makeLifecycleStore();
  const candidate = buildEligibleCandidate({ master_owner_id: "mo_e2e_dupe_provider" });
  const writeDeps = makeLifecycleWriteDeps(store, NOW);
  const queued = await selectAndQueue(candidate, writeDeps);
  assert.equal(queued.queued, true);

  const textgridCalls = [];
  const runDeps = makeLifecycleQueueRunDeps(store, {
    now: NOW,
    sendTextgridSMS: async ({ to, from, body }) => {
      textgridCalls.push({ to, from, body });
      return { sid: "SMfakeprovidersid0002" };
    },
  });

  const runResult = await runSendQueue({ limit: 10, now: NOW }, runDeps);
  assert.equal(runResult.sent_count, 1);
  assert.equal(textgridCalls.length, 1);

  // Simulate the provider (or an operator) replaying the same delivery event /
  // re-triggering processing for the same already-sent row.
  const sentRow = store.sendQueueRows.get(queued.insert.queue_row_id);
  const replay1 = await processSendQueueItem(sentRow, { ...runDeps, now: NOW });
  const replay2 = await processSendQueueItem(sentRow, { ...runDeps, now: NOW });

  assert.equal(replay1.reason, "idempotency_blocked_sid_exists");
  assert.equal(replay2.reason, "idempotency_blocked_sid_exists");
  assert.equal(textgridCalls.length, 1, "duplicate provider events must never trigger a second real send");
  assert.equal(store.messageEvents.length, 1, "duplicate provider events must never duplicate the message event");
});
