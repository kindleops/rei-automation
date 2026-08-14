// ─── inbound-context-supabase-hydration.test.mjs ─────────────────────────────
//
// Regression lock for the Podio-cutover inbound-context outage.
//
// After Podio was contained, loadContextWithFallback short-circuits its Podio
// identity leg (podio_skipped) and inbound seller replies reached the seller
// orchestrator with null property/owner/prospect ids. hasUsableContext then
// returned false, the decision engine emitted missing_context /
// safe_fallback_coverage, should_queue_reply stayed false, and NO automated
// reply was ever queued — for every real seller since ~2026-08-03.
//
// The fix hydrates the missing ids from the canonical Supabase resolver
// (getDealContextByThread → deal_thread_state + message_events + properties/
// master_owners/prospects) inside processSellerInboundMessage, before the
// decision phase. These tests drive the REAL orchestrator + decision and prove:
//   (+) Podio-absent inbound + Supabase deal context resolves ⇒ ids hydrate ⇒
//       an automated consider_selling reply is queued, classification + the
//       deterministic stage transition intact.
//   (-) Podio-absent inbound + Supabase resolves nothing ⇒ fail-closed:
//       ids stay null, no automated reply is queued.
// All identifiers are synthetic.

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { makeInboundRealPathSupabase } from "../helpers/inbound-real-path-supabase.mjs";

const THREAD = "+15550007777";
const TEXTGRID = "+15550008888";
const CUTOFF = "2030-06-01T00:00:00.000Z";
const S1_SENT_AT = "2030-06-10T01:19:32.741Z";
const INBOUND_AT = "2030-06-10T01:20:08.000Z";
const INBOUND_EVENT_ID = "00000000-0000-4000-8000-0000000000f1";
const INBOUND_PROVIDER_ID = "FIXTURE-HYDRATION-INBOUND-1";
const S1_PROVIDER_ID = "FIXTURE-HYDRATION-S1-1";
const OWNER_ID = "hydration_owner_1";
const PROSPECT_ID = "hydration_prospect_1";
const PROPERTY_ID = "hydration_property_1";

const CONSIDER_SELLING_TEMPLATE = {
  id: "400065",
  template_id: "400065",
  use_case: "consider_selling",
  stage_code: "consider_selling",
  language: "English",
  is_active: true,
  safe_for_auto_reply: true,
  reply_mode: "auto_reply",
  template_body:
    "Thanks for confirming. If I ran some numbers and sent you a proposal, would you take a look? Reply STOP to opt out.",
  property_type_scope: "any",
};

// A genuinely-sent S1 opening with NO owner/property ids of its own — the exact
// shape that, post-Podio, leaves the orchestrator without usable context.
function freshS1QueueRowNullIds() {
  return {
    id: "hydration-queue-s1",
    queue_status: "sent",
    source: "internal_canary",
    provider_message_id: S1_PROVIDER_ID,
    message_type: "ownership_check",
    template_id: null,
    master_owner_id: null,
    prospect_id: null,
    property_id: null,
    message_body: "Hi, do you still own the property?",
    to_phone_number: THREAD,
    from_phone_number: TEXTGRID,
    sent_at: S1_SENT_AT,
    created_at: S1_SENT_AT,
  };
}

function ownershipConfirmedClassification() {
  return {
    primary_intent: "ownership_confirmed",
    detected_intent: "ownership_confirmed",
    canonical_intent: "ownership_confirmed",
    confidence: 0.88,
    language: "English",
    stage_hint: "ownership_check",
    matched_rule: "ctx_yes_after_ownership_check",
    context_source_id: S1_PROVIDER_ID,
    automation_decision: { auto_reply_allowed: true, risk_level: "low" },
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

// Drives the genuine orchestrator exactly as the burst coordinator does, but
// with NO upstream-resolved ids (the post-Podio state).
async function runInbound(supabase) {
  return processSellerInboundMessage({
    message: "Yeah",
    threadKey: THREAD,
    propertyId: null,
    prospectId: null,
    ownerId: null,
    phoneId: null,
    classification: ownershipConfirmedClassification(),
    context: null,
    conversationBrain: null,
    route: null,
    inboundFrom: THREAD,
    inboundTo: TEXTGRID,
    inboundEventId: INBOUND_EVENT_ID,
    inboundReceivedAt: INBOUND_AT,
    providerMessageId: INBOUND_PROVIDER_ID,
    stageBefore: "ownership_check",
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

test("POSITIVE: Podio-absent inbound hydrates ids from Supabase deal context and reaches an automated reply", async () => {
  const supabase = makeInboundRealPathSupabase({
    send_queue: [freshS1QueueRowNullIds()],
    sms_templates: [CONSIDER_SELLING_TEMPLATE],
  });

  let hydration_called_with = null;
  let hydration_as_of = undefined;
  __setSellerInboundOrchestratorDeps({
    ...baseStubs(supabase),
    getDealContextByThread: async (threadKey, deps) => {
      hydration_called_with = threadKey;
      hydration_as_of = deps?.asOfTimestamp;
      return {
        thread_key: threadKey,
        property_id: PROPERTY_ID,
        master_owner_id: OWNER_ID,
        prospect_id: PROSPECT_ID,
      };
    },
  });

  const result = await runInbound(supabase);

  // The canonical Supabase resolver was consulted for this thread.
  assert.equal(hydration_called_with, THREAD, "getDealContextByThread called with the thread key");
  // Resolution is bound to the inbound's received-at instant, so a multi-context
  // thread (or a replayed/recovered historical inbound) resolves the campaign
  // context in force at reply time — never a later or unrelated property.
  assert.equal(hydration_as_of, INBOUND_AT, "hydration must pass asOfTimestamp = inboundReceivedAt");

  // Classification + deterministic stage transition are unaffected by the fix.
  assert.equal(result.intelligence_snapshot?.canonical_intent, "ownership_confirmed");
  assert.equal(result.decision?.stage_after, "offer_interest");

  // Coverage reached queue-eligibility: an automated consider_selling reply row exists.
  assert.equal(result.queue_permission?.allowed, true, JSON.stringify(result.queue_permission));
  const rows = supabase.inserted.send_queue;
  assert.equal(rows.length, 1, "exactly one automated reply row");
  assert.equal(rows[0].use_case_template, "consider_selling");
  assert.equal(rows[0].type, "auto_reply");
  // The hydrated identity flows onto the reply row.
  assert.equal(rows[0].master_owner_id, OWNER_ID);
  assert.equal(rows[0].property_id, PROPERTY_ID);
});

test("NEGATIVE: Podio-absent inbound with no Supabase deal context stays fail-closed (no automated reply)", async () => {
  const supabase = makeInboundRealPathSupabase({
    send_queue: [freshS1QueueRowNullIds()],
    sms_templates: [CONSIDER_SELLING_TEMPLATE],
  });

  let hydration_called = false;
  __setSellerInboundOrchestratorDeps({
    ...baseStubs(supabase),
    getDealContextByThread: async () => {
      hydration_called = true;
      return null; // Supabase cannot resolve sufficient context.
    },
  });

  const result = await runInbound(supabase);

  assert.equal(hydration_called, true, "hydration was attempted");
  // Fail-closed: the decision falls to missing_context and NO reply is queued.
  assert.equal(
    result.intelligence_snapshot?.canonical_decision?.audit_reason,
    "missing_context",
    "unresolved context must fail closed at missing_context"
  );
  assert.equal(
    supabase.inserted.send_queue.length,
    0,
    "no automated reply row when context is unresolved"
  );
});
