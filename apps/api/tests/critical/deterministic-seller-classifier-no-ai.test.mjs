/**
 * Auto Reply Intelligence V2 prerequisite: seller-inbound classification must
 * never depend on live model inference. classify.js still contains an
 * AI-assist branch (aiAssistClassification -> gpt-4o-mini) used by other
 * features (Discord operator tooling), but both seller-inbound call sites
 * must force { heuristicOnly: true } so that branch is unreachable from real
 * seller traffic.
 */
import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import {
  makeInboundWebhookBaseDeps,
  makeInboundLifecycleSupabase,
} from "../helpers/chainable-supabase.mjs";
import {
  handleTextgridInboundWebhook,
  __setTextgridInboundTestDeps,
  __resetTextgridInboundTestDeps,
} from "@/lib/flows/handle-textgrid-inbound.js";
import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { createInMemoryIdempotencyLedger, createPodioItem } from "../helpers/test-helpers.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";

afterEach(() => {
  __resetTextgridInboundTestDeps();
  __resetSellerInboundOrchestratorDeps();
});

// ── 1/2. Both seller-inbound call sites force heuristicOnly ────────────────

test("handleTextgridInboundWebhook passes heuristicOnly:true to classify()", async () => {
  const calls = [];
  const ledger = createInMemoryIdempotencyLedger();

  __setTextgridInboundTestDeps({
    ...makeInboundWebhookBaseDeps({ getSupabaseClient: () => makeInboundLifecycleSupabase() }),
    beginIdempotentProcessing: ledger.begin,
    completeIdempotentProcessing: ledger.complete,
    failIdempotentProcessing: ledger.fail,
    hashIdempotencyPayload: ledger.hash,
    normalizeInboundTextgridPhone: (value) => value,
    info: () => {},
    warn: () => {},
    loadContext: async () => ({
      found: true,
      ids: { brain_item_id: null, master_owner_id: 21, prospect_id: 31, property_id: 41, phone_item_id: 51 },
      items: { brain_item: null, phone_item: createPodioItem(51), master_owner_item: createPodioItem(21), property_item: createPodioItem(41) },
      summary: { conversation_stage: "Ownership Confirmation", language_preference: "English" },
    }),
    createBrain: async () => null,
    classify: async (message, brain, options) => {
      calls.push({ message, brain, options });
      return { language: "English", primary_intent: "unclear", source: "heuristic" };
    },
    resolveRoute: () => ({ stage: "Ownership", use_case: "ownership_check", seller_profile: null }),
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
    postInboundSmsDiscordCard: async () => ({ ok: true, discord_message_id: "discord-msg-1" }),
    findInboundAutopilotQueue: async () => null,
    buildInboundAutopilotSchedule: (delay_seconds = 60) => {
      const scheduled_for = new Date(Date.now() + delay_seconds * 1000).toISOString();
      return { scheduled_for, scheduled_for_utc: scheduled_for, scheduled_for_local: scheduled_for };
    },
  });

  const result = await handleTextgridInboundWebhook({
    message_id: "sms-classifier-hardening-1",
    from: "+15550000001",
    to: "+15550000002",
    body: "maybe, not sure",
    status: "received",
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.heuristicOnly, true);
});

test("processSellerInboundMessage's internal classify fallback forces heuristicOnly:true", async () => {
  const calls = [];
  const supabase = makeSellerOrchestrationSupabase();

  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => supabase,
    patchUniversalLeadState: async ({ patch }) => ({ ok: true, patch, dry_run: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true, dry_run: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async () => ({ ok: true, skipped: true, reason: "not_attempted" }),
    classify: async (message, brain, options) => {
      calls.push({ message, brain, options });
      return { language: "English", primary_intent: "unclear", confidence: 0.5, source: "heuristic" };
    },
  });

  // No `classification` supplied — exercises the fallback branch at
  // process-seller-inbound-message.js's `if (!classification) { ... }`.
  await processSellerInboundMessage({
    message: "hmm",
    threadKey: "+15550000003",
    inboundFrom: "+15550000003",
    inboundTo: "+15550000004",
    inboundEventId: "evt-classifier-hardening-1",
    dryRun: true,
  }).catch(() => {
    // Only the classify() call arguments matter for this assertion; later
    // orchestration steps may fail against the minimal mock context.
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.heuristicOnly, true);
});

// ── 3. classify(heuristicOnly) never returns source:"ai" ────────────────────
// Corpus verified against real classify.js output (see probe run in PR
// description) — every row asserts BOTH the canonical intent AND
// source === "heuristic", proving no AI branch executed even for messages
// well below the 0.82 AI-assist confidence threshold.

const CANONICAL_CORPUS = [
  // ownership safety
  { label: "owner_confirmed", text: "Yes I own it", primary_intent: "ownership_confirmed" },
  { label: "owner_confirmed_casual", text: "yea thats mine", primary_intent: "ownership_confirmed" },
  { label: "wrong_number", text: "Wrong number", primary_intent: "wrong_number" },
  { label: "not_owner", text: "I don't own that house", primary_intent: "wrong_number" },
  { label: "never_owned", text: "I've never owned that property", primary_intent: "wrong_number" },
  { label: "former_owner", text: "I sold that house last year", primary_intent: "wrong_number" },

  // seller interest / offer
  { label: "seller_requests_offer", text: "Just make me an offer", primary_intent: "asks_offer" },
  { label: "not_interested", text: "Not interested, not for sale", primary_intent: "not_interested" },
  { label: "who_is_this", text: "who is this?", primary_intent: "who_is_this" },
  { label: "callback_requested", text: "just call me", primary_intent: "callback_requested" },

  // suppression (compliance-critical, must stay deterministic)
  { label: "opt_out_stop", text: "STOP", primary_intent: "opt_out", compliance_flag: "stop_texting" },
  { label: "opt_out_remove", text: "remove me from your list", primary_intent: "opt_out", compliance_flag: "stop_texting" },
  { label: "hostile_legal", text: "I will sue you, stop texting me", primary_intent: "opt_out", compliance_flag: "stop_texting" },

  // ambiguous — must resolve to unclear/latent_interest, never a guess
  { label: "ambiguous_maybe", text: "maybe", primary_intent: "unclear" },
  { label: "ambiguous_what", text: "what", primary_intent: "unclear" },

  // monetary preservation
  { label: "price_bottom_line", text: "285k is my bottom line", primary_intent: "asking_price_provided" },
  { label: "price_asking", text: "asking 300000", primary_intent: "asking_price_provided" },
  {
    label: "multi_price_spouse",
    text: "I'd sell but I need 300k and my wife would have to agree",
    primary_intent: "asking_price_provided",
  },
];

test("canonical seller corpus classifies deterministically with zero AI calls", async (t) => {
  for (const row of CANONICAL_CORPUS) {
    await t.test(`${row.label}: "${row.text}"`, async () => {
      const result = await classify(row.text, null, { heuristicOnly: true });
      assert.equal(result.primary_intent, row.primary_intent, `intent mismatch for "${row.text}"`);
      assert.equal(result.source, "heuristic", `expected heuristic source for "${row.text}"`);
      if (row.compliance_flag) {
        assert.equal(result.compliance_flag, row.compliance_flag);
      }
    });
  }
});

// ── 4. Repeated identical input is byte-equivalent (no hidden nondeterminism)

test("classify(heuristicOnly) is byte-equivalent across repeated identical input", async () => {
  const a = await classify("I own it, might sell", null, { heuristicOnly: true });
  const b = await classify("I own it, might sell", null, { heuristicOnly: true });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ── 5. Network-disabled environment still classifies successfully ──────────
// critical-test-environment.mjs installs a fetch guard that throws on any
// non-localhost network call for the whole file. A low-confidence message
// with heuristicOnly:true must resolve without ever attempting that call.

test("low-confidence heuristicOnly classification succeeds under the network-blocked test environment", async () => {
  const result = await classify("depends", null, { heuristicOnly: true });
  assert.ok(result.confidence < 0.82, "fixture must be below the AI-assist threshold to be meaningful");
  assert.equal(result.source, "heuristic");
});

// ── 6. End-to-end proof through the real orchestration boundary ────────────
// No `classification` is supplied and `classify` is NOT stubbed in deps, so
// processSellerInboundMessage exercises its real internal fallback
// (`if (!classification) classification = await runtimeDeps.classify(...)`)
// against the actual classify.js, under the file-wide network-blocked test
// environment. "maybe" is below the 0.82 AI-assist threshold (confidence
// 0.6) — proving the full webhook-adjacent boundary resolves deterministically
// with zero model/network dependency, and that the existing downstream
// automation-decision layer (unmodified by this branch) already fails closed
// to human review rather than fabricating a confident intent.

test("genuinely low-confidence message resolves deterministically end-to-end with no AI call and routes to human review", async () => {
  const supabase = makeSellerOrchestrationSupabase();
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
      scheduled_for: new Date().toISOString(),
      reason: `nurture_followup:${intent}`,
    }),
    // classify intentionally left as the real production implementation.
  });

  const result = await processSellerInboundMessage({
    message: "maybe",
    threadKey: "+15551234599",
    propertyId: "prop-227",
    prospectId: "pros-31",
    ownerId: "mo-21",
    phoneId: "phone-51",
    context: {
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
    },
    route: { stage: "ownership_check", use_case: "ownership_check" },
    inboundFrom: "+15551234599",
    inboundTo: "+15559876543",
    inboundEventId: "evt-lowconf-1",
    autoReplyMode: "live_limited",
    executionAllowed: true,
    dryRun: true,
  });

  // classify() returned successfully with a deterministic, heuristic-sourced
  // contract — never an AI-fabricated confident guess.
  assert.equal(result.ok, true);
  assert.equal(result.classification.source, "heuristic");
  assert.ok(
    result.classification.confidence < 0.82,
    "fixture must be below the AI-assist threshold to prove the branch was skipped, not merely unreached"
  );
  assert.equal(result.contract.normalized_intent, "unclear");

  // Low confidence did not become a fabricated high-confidence intent, and
  // the lifecycle decision still records the ambiguous hold for review. The
  // executor now treats this LOW-INFORMATION ambiguous turn (short "maybe") as
  // clarifier-eligible (activation-hardening item 2) — and because this
  // fixture's live_limited mode has no cutoff configured, the MODE AUTHORITY
  // fail-closes the send exactly as it does for any auto-reply: nothing
  // queues, deterministic reason, no AI anywhere. The clarifier's live path
  // (queued row, stage-aware text) and its protected exclusions are pinned in
  // inbound-clarifier-queue-authority.test.mjs / inbound-safe-clarifier.test.mjs.
  assert.equal(result.decision.review_required, true);
  assert.equal(result.execution.automation_decision.should_queue_reply, false);
  assert.equal(result.execution.queued, false);
  assert.equal(
    result.execution.automation_decision.audit_reason,
    "auto_reply_cutoff_not_configured"
  );
  assert.equal(result.execution.automation_decision.reply_mode, "none");

  __resetSellerInboundOrchestratorDeps();
});
