// ─── inbound-clarifier-queue-authority.test.mjs ─────────────────────────────
//
// Regression lock for the clarifier queue-authority defect found by the
// post-hardening adversarial audit: every layer of the safe-fallback clarifier
// worked (gate → synthetic template → render) but the orchestrator computed
// should_queue_live from the canonical decision's should_queue_reply=false and
// revoked queue authority BEFORE the executor could convert the turn — the
// clarifier rendered and was dropped (queued:false) on every ambiguous turn.
//
// These tests drive the REAL orchestrator + REAL executor end-to-end and prove:
//   (+) an ambiguous unclear inbound on a clean, id-resolved English thread
//       inserts exactly ONE safe_clarifier queue row, and the clarifier text is
//       the coverage-net question for the PERSISTED stage (not the S1 default);
//   (-) the same turn with a probate objection stays human-review — no row;
//   (-) a compliance-flagged turn stays suppressed — no row.
// All identifiers are synthetic.

import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { buildSafeFallback } from "@/lib/domain/seller-flow/coverage-net/safe-fallback.js";
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

test("POSITIVE: ambiguous unclear inbound queues exactly one stage-aware clarifier row", async () => {
  const supabase = makeInboundRealPathSupabase({
    send_queue: [sentS1Row()],
    sms_templates: [],
  });
  __setSellerInboundOrchestratorDeps(baseStubs(supabase));

  const result = await runInbound(supabase, { classification: unclearClassification() });

  const rows = supabase.inserted.send_queue;
  assert.equal(rows.length, 1, `exactly one clarifier row (got ${rows.length})`);
  assert.equal(rows[0].use_case_template, "safe_clarifier");
  assert.equal(rows[0].type, "auto_reply");
  // Stage-awareness: the thread is at S3 (asking_price) — the clarifier must
  // ask the S3 question, NOT the classifier stage_hint's S1 ownership default.
  // prepareRenderedSmsForQueue normalizes to GSM-7 (em-dash → hyphen), so
  // compare with the same normalization.
  const gsm = (t) => String(t).replace(/\u2014/g, "-").replace(/\u2019/g, "'");
  const expected = buildSafeFallback({ stage: "asking_price", uncertainty_type: "intent" });
  assert.equal(gsm(rows[0].message_body), gsm(expected.suggested_text));
  assert.notEqual(
    gsm(rows[0].message_body),
    gsm(buildSafeFallback({ stage: "ownership_confirmation", uncertainty_type: "intent" }).suggested_text),
    "must not fall back to the S1 clarifier"
  );
  assert.equal(result.execution?.queued, true, "executor must report queued");
});

test("NEGATIVE: probate-objection unclear stays human review — no clarifier row", async () => {
  const supabase = makeInboundRealPathSupabase({
    send_queue: [sentS1Row()],
    sms_templates: [],
  });
  __setSellerInboundOrchestratorDeps(baseStubs(supabase));

  await runInbound(supabase, {
    classification: unclearClassification({
      objection: "probate",
      automation_decision: {
        auto_reply_allowed: false,
        queue_action: "none",
        suppression_action: "none",
        human_review_required: true,
        risk_level: "high",
      },
    }),
  });

  assert.equal(
    supabase.inserted.send_queue.length,
    0,
    "probate turns must never receive an automated clarifier"
  );
});

test("NEGATIVE: compliance-flagged turn stays suppressed — no clarifier row", async () => {
  const supabase = makeInboundRealPathSupabase({
    send_queue: [sentS1Row()],
    sms_templates: [],
  });
  __setSellerInboundOrchestratorDeps(baseStubs(supabase));

  await runInbound(supabase, {
    classification: unclearClassification({
      primary_intent: "opt_out",
      detected_intent: "opt_out",
      canonical_intent: "opt_out",
      compliance_flag: "stop_texting",
      automation_decision: {
        auto_reply_allowed: false,
        queue_action: "none",
        suppression_action: "opt_out",
        human_review_required: false,
        risk_level: "high",
      },
    }),
  });

  assert.equal(supabase.inserted.send_queue.length, 0, "opt-out must never clarifier-send");
});
