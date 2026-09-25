// ─── inbound-auto-reply-invariant.test.mjs ──────────────────────────────────
// HARD INVARIANT: auto_reply_allowed=false OR human_review_required=true ⇒ no
// automatic seller-response queue row. Drives the REAL orchestrator + executor.
// All identifiers synthetic.

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import {
  classifierForbidsAutoReply,
  resolveSafeFallbackClarifierDispatch,
} from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { makeInboundRealPathSupabase } from "../helpers/inbound-real-path-supabase.mjs";

const THREAD = "+15550007171";
const TEXTGRID = "+15550008181";
const CUTOFF = "2030-06-01T00:00:00.000Z";
const S1_SENT_AT = "2030-06-10T01:19:32.741Z";
const INBOUND_AT = "2030-06-10T01:20:08.000Z";
const INBOUND_EVENT_ID = "00000000-0000-4000-8000-0000000000c1";
const OWNER_ID = "clarifier_owner_1";
const PROSPECT_ID = "clarifier_prospect_1";
const PROPERTY_ID = "clarifier_property_1";

function sentS1Row() {
  return {
    id: "clarifier-queue-s1",
    queue_status: "sent",
    source: "internal_canary",
    provider_message_id: "FIXTURE-CLARIFIER-S1-1",
    message_type: "ownership_check",
    template_id: null,
    master_owner_id: OWNER_ID,
    prospect_id: PROSPECT_ID,
    property_id: PROPERTY_ID,
    message_body: "Quick question about the property — do you still own it?",
    to_phone_number: THREAD,
    from_phone_number: TEXTGRID,
    sent_at: S1_SENT_AT,
    created_at: S1_SENT_AT,
  };
}

function unclearClassification(overrides = {}) {
  return {
    primary_intent: "unclear",
    detected_intent: "unclear",
    canonical_intent: "unclear",
    confidence: 0.6,
    language: "English",
    stage_hint: "Ownership", // the terse-message default the fix must NOT trust
    compliance_flag: null,
    objection: null,
    automation_decision: {
      auto_reply_allowed: false,
      queue_action: "none",
      suppression_action: "none",
      human_review_required: true,
      risk_level: "medium",
    },
    ...overrides,
  };
}

function baseStubs(supabase) {
  return {
    getSupabaseClient: () => supabase,
    patchUniversalLeadState: async ({ patch }) => ({ ok: true, patch }),
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async () => ({ ok: true, followup_created: false, skipped: true }),
    cancelPendingFollowUpsForThread: async () => ({ ok: true, cancelled: 0 }),
  };
}

async function getSystemValue(key) {
  if (key === "auto_reply_mode") return "live_limited";
  if (key === "auto_reply_eligibility_cutoff_at") return CUTOFF;
  if (key === "auto_reply_thread_allowlist") return THREAD;
  return null;
}

async function runInbound(supabase, { classification, stageBefore = "asking_price" } = {}) {
  return processSellerInboundMessage({
    message: "hmm",
    threadKey: THREAD,
    propertyId: PROPERTY_ID,
    prospectId: PROSPECT_ID,
    ownerId: OWNER_ID,
    phoneId: null,
    classification,
    context: null,
    conversationBrain: null,
    route: null,
    inboundFrom: THREAD,
    inboundTo: TEXTGRID,
    inboundEventId: INBOUND_EVENT_ID,
    inboundReceivedAt: INBOUND_AT,
    providerMessageId: "FIXTURE-CLARIFIER-INBOUND-1",
    stageBefore,
    autoReplyMode: "live_limited",
    executionAllowed: true,
    supabaseClient: supabase,
    getSystemValue,
    applySuppression: true,
    skipNotifications: true,
    dryRun: false,
  });
}

afterEach(() => {
  __resetSellerInboundOrchestratorDeps();
});


// ── Invariant: a classifier human-review verdict is never overridden ─────────
// Production 2026-09-25: "Do you want to tour the house? We can meet at it."
// → unclear 0.6, auto_reply_allowed=false, human_review_required=true, and the
// safe-fallback clarifier still queued safe_clarifier_intent_asking_price.

const TOUR = "Do you want to tour the house? We can meet at it.";

async function runMessage(supabase, message, classification, stageBefore = "asking_price") {
  return processSellerInboundMessage({
    message,
    threadKey: THREAD,
    propertyId: PROPERTY_ID,
    prospectId: PROSPECT_ID,
    ownerId: OWNER_ID,
    phoneId: null,
    classification,
    context: null,
    conversationBrain: null,
    route: null,
    inboundFrom: THREAD,
    inboundTo: TEXTGRID,
    inboundEventId: INBOUND_EVENT_ID,
    inboundReceivedAt: INBOUND_AT,
    providerMessageId: "FIXTURE-INVARIANT-INBOUND-1",
    stageBefore,
    autoReplyMode: "live_limited",
    executionAllowed: true,
    supabaseClient: supabase,
    getSystemValue,
    applySuppression: true,
    skipNotifications: true,
    dryRun: false,
  });
}

function freshSupabase() {
  const supabase = makeInboundRealPathSupabase({ send_queue: [sentS1Row()], sms_templates: [] });
  __setSellerInboundOrchestratorDeps(baseStubs(supabase));
  return supabase;
}

test("A: auto_reply_allowed=false → no outbound queue row", async () => {
  const supabase = freshSupabase();
  await runMessage(supabase, "hmm", unclearClassification({
    automation_decision: { auto_reply_allowed: false, queue_action: "none", suppression_action: "none", human_review_required: false, risk_level: "medium" },
  }));
  assert.equal(supabase.inserted.send_queue.length, 0);
});

test("B: human_review_required=true → no outbound queue row", async () => {
  const supabase = freshSupabase();
  await runMessage(supabase, "hmm", unclearClassification({
    automation_decision: { auto_reply_allowed: true, queue_action: "none", suppression_action: "none", human_review_required: true, risk_level: "medium" },
  }));
  assert.equal(supabase.inserted.send_queue.length, 0);
});

test("C: the safe fallback cannot override a classifier review verdict (the production contradiction)", async () => {
  const supabase = freshSupabase();
  const result = await runMessage(supabase, "hmm", unclearClassification());
  assert.equal(supabase.inserted.send_queue.length, 0, "no clarifier row may exist");
  const decision = result?.execution?.automation_decision || result?.automation_decision || null;
  if (decision) {
    assert.notEqual(decision.reply_mode, "auto_clarifier");
    assert.notEqual(decision.next_action, "send_safe_clarifier");
    assert.notEqual(decision.should_queue_reply, true);
  }
  assert.notEqual(result?.execution?.queued, true);
});

test("D: a classifier-authorized path still queues normally", async () => {
  const supabase = freshSupabase();
  const result = await runMessage(supabase, "hmm", unclearClassification({
    automation_decision: { auto_reply_allowed: true, queue_action: "queue_auto_reply", suppression_action: "none", human_review_required: false, risk_level: "low" },
  }));
  const rows = supabase.inserted.send_queue;
  assert.equal(rows.length, 1, `authorized turn must still queue exactly one row (got ${rows.length})`);
  assert.equal(result.execution?.queued, true);
});

test("E: a tour / meeting message falls to human review, never the asking-price clarifier", async () => {
  const supabase = freshSupabase();
  const result = await runMessage(supabase, TOUR, unclearClassification(), "asking_price");
  assert.equal(supabase.inserted.send_queue.length, 0);
  const all = JSON.stringify(result ?? {});
  assert.ok(!all.includes("safe_clarifier_intent_asking_price"), "the asking-price clarifier must not be selected");
});

test("E (unit): the dispatch gate itself refuses when the classifier forbids", () => {
  const decision = { should_queue_reply: false, should_mark_human_review: true, should_suppress_contact: false, human_review_reason: "unclear_low_confidence", audit_reason: "unclear_low_confidence" };
  assert.equal(resolveSafeFallbackClarifierDispatch({ decision, classification: unclearClassification(), message: TOUR, stage: "asking_price" }), null);
  assert.deepEqual(classifierForbidsAutoReply(unclearClassification()), { forbidden: true, reason: "classifier_human_review_required" });
  assert.deepEqual(classifierForbidsAutoReply({ automation_decision: { auto_reply_allowed: true, human_review_required: false } }), { forbidden: false, reason: null });
});
