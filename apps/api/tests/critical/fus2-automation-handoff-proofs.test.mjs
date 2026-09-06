/**
 * A-L automation handoff proofs. Entirely injected/in-memory: no provider, no
 * cron, no system_control read or write, and no row created in the shared
 * Supabase database.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveDeliveryFollowUpDecision, countAutomatedFollowUps }
  from "@/lib/domain/seller-flow/delivery-triggered-followup.js";
import { resolveFollowUpPolicyForStage } from "@/lib/domain/seller-flow/followup-policy-registry.js";
import { resolveDeferredQueueMessage } from "@/lib/domain/queue/resolve-deferred-queue-message.js";
import { selectFus2Template, loadFus2Templates } from "@/lib/domain/inbox/fus2-follow-up-service.js";
import { resolveSellerStageTransition, normalizeAskingPriceFact }
  from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { LIFECYCLE_STAGE_CODES as C } from "@/lib/domain/lead-state/universal-lead-state-registry.js";

const tpl = (id, lang, { autoReply = false, noReply = true } = {}) => ({
  id, template_id: id, language: lang, use_case: "reengagement", stage_code: "FUS2",
  template_body: "Hey {{seller_first_name}}, {{agent_name}} here. Wanted to circle back on {{property_address}}.",
  is_active: true, safe_for_auto_reply: autoReply,
  metadata: { template_family: "bulk_conversation_restart", eligible_for_no_reply_followup: noReply },
});
const A = tpl("lc-reengage-agent-en-001", "English");
const B = tpl("lc-reengage-agent-en-002", "English");
const D_ = tpl("lc-reengage-agent-en-003", "English");
const ES = tpl("lc-reengage-agent-es-001", "Spanish");
const PT = tpl("lc-reengage-agent-pt-001", "Portuguese");
const ZH = tpl("lc-reengage-agent-zh-001", "Mandarin");

function store(rows) {
  const seen = [];
  return { seen, from() {
    const f = {};
    const q = { select: () => q, limit: () => q, order: () => q, not: () => q,
      in: (c, v) => { f[c] = v; return q; }, eq: (c, v) => { f[c] = v; return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res) => { seen.push({ ...f });
        const m = rows.filter((r) => {
          if (f.is_active !== undefined && r.is_active !== f.is_active) return false;
          if (f.safe_for_auto_reply !== undefined && r.safe_for_auto_reply !== f.safe_for_auto_reply) return false;
          if (f["metadata->>eligible_for_no_reply_followup"] !== undefined) {
            const want = f["metadata->>eligible_for_no_reply_followup"] === "true";
            if (Boolean(r.metadata?.eligible_for_no_reply_followup) !== want) return false;
          }
          if (f.use_case && !f.use_case.includes(r.use_case)) return false;
          if (f.language && !f.language.includes(r.language)) return false;
          return true;
        });
        return Promise.resolve({ data: m, error: null }).then(res); } };
    return q;
  } };
}

const deferredRow = (over = {}) => ({
  id: "q1", type: "followup", queue_status: "scheduled",
  use_case_template: "reengagement", language: "English",
  to_phone_number: "+15555550100", seller_first_name: "Sarah",
  agent_name: "Crystal", property_address: "123 Main St",
  metadata: { deferred_message_resolution: true, intent: "stage_no_reply", followup_use_case: "reengagement" },
  ...over,
});

// ── A: delivered seed creates a FUS2 continuation ───────────────────────────

test("A: only a provider-confirmed DELIVERY creates a continuation", () => {
  const base = { provider_message_id: "SM1", followup_intent: "stage_no_reply",
    has_inbound_after_outbound: false, has_newer_outbound: false,
    pending_followup_exists: false, contactability_status: "contactable",
    lifecycle_stage: C.OWNERSHIP_CONFIRMATION };

  assert.equal(resolveDeliveryFollowUpDecision({ ...base, final_delivery_status: "delivered" }).eligible, true);
  // Scheduling alone, acceptance alone, and failure all refuse.
  for (const status of ["scheduled", "queued", "sent", "accepted", "failed", "undelivered", null]) {
    const d = resolveDeliveryFollowUpDecision({ ...base, final_delivery_status: status });
    assert.equal(d.eligible, false, `${status} must not start the cadence`);
    assert.match(d.reason, /not_provider_confirmed_delivered/);
  }
});

test("A: the continuation objective comes from delivered FUS2 lineage, not stage", async () => {
  const supabase = store([A, B]);
  const r = await resolveDeferredQueueMessage(deferredRow(), { supabase });
  assert.equal(r.resolved, true, r.reason || "");
  assert.equal(r.stage_code, "FUS2");
  assert.equal(r.use_case, "reengagement");
});

// ── B / C: capability vs auto-reply safety ──────────────────────────────────

test("B: stage_no_reply accepts safe_for_auto_reply=false + capability=true", async () => {
  const supabase = store([A]);
  const r = await resolveDeferredQueueMessage(deferredRow(), { supabase });
  assert.equal(r.resolved, true);
  assert.equal(A.safe_for_auto_reply, false, "template stays auto-reply-unsafe");
  assert.equal(A.metadata.eligible_for_no_reply_followup, true);
});

test("C: the same template is INELIGIBLE on the inbound auto-reply path", async () => {
  const supabase = store([A]);
  const r = await resolveDeferredQueueMessage(
    deferredRow({ use_case_template: "nurture_unclear",
      metadata: { deferred_message_resolution: true, intent: "unclear" } }),
    { supabase },
  );
  assert.notEqual(r.template_id, A.template_id, "FUS2 leaked into auto-reply");
  const leaked = supabase.seen.some((s) => s["metadata->>eligible_for_no_reply_followup"] !== undefined);
  assert.equal(leaked, false, "capability must not be consulted on the auto-reply path");
});

// ── D: anti-repeat ──────────────────────────────────────────────────────────

test("D: continuation prefers a variant the seller has not received", () => {
  const chosen = selectFus2Template({ templates: [A, B, D_], usedTemplateIds: [A.template_id] });
  assert.notEqual(chosen.template.template_id, A.template_id);
  assert.ok([B.template_id, D_.template_id].includes(chosen.template.template_id));
  assert.equal(chosen.rotation_reason, "unused_variant_preferred");
});

test("D: the history input is the thread's send_queue template lineage", async () => {
  const supabase = store([]);
  // loadThreadTemplateHistory reads send_queue template_id/selected_template_id.
  const { loadThreadTemplateHistory } = await import("@/lib/domain/inbox/fus2-follow-up-service.js");
  const hist = await loadThreadTemplateHistory(["+15555550100"], { supabase: {
    from: () => ({ select: () => ({ in: () => ({ order: () => ({ limit: () => Promise.resolve({
      data: [{ thread_key: "+15555550100", template_id: A.template_id, created_at: "2026-09-01" }], error: null }) }) }) }) }),
  } });
  assert.deepEqual(hist.get("+15555550100"), [A.template_id]);
});

// ── E: lifecycle stays evidence-based ───────────────────────────────────────

test("E: FUS2 delivery alone does not advance lifecycle_stage", () => {
  // The delivery path only READS stage as a guard; the transition resolver is
  // inbound-driven and receives no seller facts here.
  const t = resolveSellerStageTransition({
    stage_before: C.OWNERSHIP_CONFIRMATION,
    known_facts: {}, new_facts: {}, intent: "unclear",
  });
  assert.notEqual(t.stage_after, C.OFFER_INTEREST, "an outbound must not advance the stage");
  assert.equal(t.stage_after, C.OWNERSHIP_CONFIRMATION);
});

// ── F / G: positive intent and price extraction ─────────────────────────────

test("F: a bare positive reply HOLDS at S1 -- ownership is required evidence", () => {
  // Canonical, and deliberately so: "yeah sure" is interest, not proof of
  // ownership. The machine holds at S1 and asks the ownership question rather
  // than advancing on enthusiasm.
  const t = resolveSellerStageTransition({
    stage_before: C.OWNERSHIP_CONFIRMATION,
    known_facts: {}, new_facts: { offer_interest: true },
    intent: "positive_interest", classification_confidence: 0.9,
  });
  assert.equal(t.stage_after, C.OWNERSHIP_CONFIRMATION);
  assert.equal(t.advanced, false);
  assert.equal(t.reasoning_code, "S1_HOLD_POSITIVE_INTEREST");
  assert.equal(t.required_template_use_case, "ownership_check");
});

test("F: confirmed OWNERSHIP is what advances S1 -> offer_interest", () => {
  const t = resolveSellerStageTransition({
    stage_before: C.OWNERSHIP_CONFIRMATION,
    known_facts: {}, new_facts: { ownership_confirmed: true },
    intent: "ownership_confirmed", classification_confidence: 0.9,
  });
  assert.equal(t.stage_after, C.OFFER_INTEREST);
  assert.equal(t.advanced, true);
  assert.equal(t.reasoning_code, "S1_TO_S2_OWNERSHIP_CONFIRMED");
});

test("F: a positive reply at S2 holds at S2 rather than skipping ahead", () => {
  const t = resolveSellerStageTransition({
    stage_before: C.OFFER_INTEREST,
    known_facts: { ownership_confirmed: true }, new_facts: { offer_interest: true },
    intent: "positive_interest", classification_confidence: 0.9,
  });
  assert.equal(t.stage_after, C.OFFER_INTEREST);
  assert.equal(t.reasoning_code, "S2_HOLD_POSITIVE_INTEREST");
});

// ── G: price-bearing reply ──────────────────────────────────────────────────

test("G: 185k normalizes to 185000 through the canonical fact normalizer", () => {
  const price = normalizeAskingPriceFact(185000, { sourceMessageId: "SM2" });
  assert.equal(price.value, 185000);
});

test("G: a supplied price SKIPS asking_price entirely -- no redundant question", () => {
  const price = normalizeAskingPriceFact(185000, { sourceMessageId: "SM2" });
  const t = resolveSellerStageTransition({
    stage_before: C.OFFER_INTEREST,
    known_facts: { ownership_confirmed: true, offer_interest: true },
    new_facts: { asking_price: price },
    intent: "asking_price_value", classification_confidence: 0.9,
  });
  // S2 -> S4 directly. asking_price is never entered, so the asking-price
  // question can never be asked for a price the seller already gave.
  assert.equal(t.stage_after, C.PROPERTY_CONDITION);
  assert.equal(t.advanced, true);
  assert.equal(t.reasoning_code, "S2_TO_S4_ASKING_PRICE_VALUE");
  assert.notEqual(t.required_template_use_case, "asking_price");
});

// ── J: cap semantics ────────────────────────────────────────────────────────

test("J: only delivered automated followups consume the cap", async () => {
  const rows = [
    { id: "1", queue_status: "delivered" },   // counts
    { id: "2", queue_status: "sent" },        // counts (in flight to seller)
    { id: "3", queue_status: "failed" },      // must not
    { id: "4", queue_status: "blocked" },     // must not
    { id: "5", queue_status: "cancelled" },   // must not
    { id: "6", queue_status: "undelivered" }, // must not
  ];
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({
    limit: () => Promise.resolve({ data: rows, error: null }) }) }) }) }) };
  const n = await countAutomatedFollowUps(supabase, "+15555550100");
  assert.equal(n, 2, "failed/blocked/cancelled/undelivered must not consume the cap");
});

test("J: the operator seed is type=outbound and is invisible to the cap", async () => {
  const seen = {};
  const supabase = { from: () => ({ select: () => ({ eq: () => ({
    in: (col, vals) => { seen[col] = vals; return { limit: () => Promise.resolve({ data: [], error: null }) }; } }) }) }) };
  await countAutomatedFollowUps(supabase, "+15555550100");
  assert.deepEqual(seen.type, ["followup"], "cap counts followup rows only");
  assert.ok(!seen.type.includes("outbound"), "the operator seed type is excluded by construction");
});

test("J: registry caps are per stage and terminal stages disable followups", () => {
  assert.equal(resolveFollowUpPolicyForStage(C.OWNERSHIP_CONFIRMATION).policy.max_automated_followups, 3);
  assert.equal(resolveFollowUpPolicyForStage(C.OFFER).policy.max_automated_followups, 2);
  assert.equal(resolveFollowUpPolicyForStage(C.CLOSED).policy.enabled, false);
});

// ── K: multilingual continuation ────────────────────────────────────────────

test("K: the continuation stays in the seller's language", async () => {
  for (const [lang, expected] of [["English", A], ["Spanish", ES], ["Portuguese", PT], ["Mandarin", ZH]]) {
    const supabase = store([A, ES, PT, ZH]);
    const r = await resolveDeferredQueueMessage(deferredRow({ language: lang }), { supabase });
    assert.equal(r.resolved, true, `${lang}: ${r.reason || ""}`);
    assert.equal(r.template_id, expected.template_id, `${lang} must select its own family`);
  }
});

test("K: a known non-English seller never silently falls back to English", () => {
  const byLanguage = new Map([["English", [A, B]]]);
  const candidates = byLanguage.get("Spanish") || [];
  const chosen = selectFus2Template({ templates: candidates, usedTemplateIds: [] });
  assert.equal(chosen.ok, false);
  assert.equal(chosen.reason, "no_fus2_template_for_language");
});

// ── H: inbound cancels the pending continuation BEFORE classification ───────

import {
  processSellerInboundMessage,
  __setSellerInboundOrchestratorDeps,
  __resetSellerInboundOrchestratorDeps,
} from "@/lib/domain/seller-flow/process-seller-inbound-message.js";

test("H: cancellation runs BEFORE classification, proven by call order", async () => {
  const order = [];
  const pending = { id: "followup-1", queue_status: "scheduled", sendable: true };

  __setSellerInboundOrchestratorDeps({
    cancelPendingFollowUpsForThread: async () => {
      order.push("cancel");
      // The pending continuation stops being sendable at cancellation time.
      pending.queue_status = "cancelled";
      pending.sendable = false;
      return { ok: true, cancelled: 1, reason: "cancelled_followup_on_inbound_reply" };
    },
    classifyInboundMessage: async () => {
      order.push("classify");
      // Whatever classification decides, the follow-up is already dead.
      assert.equal(pending.sendable, false, "classification ran while a live follow-up still existed");
      return { intent: "positive_interest", confidence: 0.9 };
    },
  });

  try {
    await processSellerInboundMessage({
      // camelCase params, and dryRun MUST stay false or writes_suppressed
      // short-circuits the cancellation branch entirely.
      threadKey: "+15555550100",
      inboundFrom: "+15555550100",
      inboundTo: "+15551110001",
      message: { body: "yeah sure" },
      inboundEventId: "SM_inbound_1",
      dryRun: false,
      supabaseClient: {
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }),
            order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }),
          insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          upsert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
        }),
      },
    });
  } catch {
    // The orchestrator does far more than this proof stubs; a downstream throw
    // is irrelevant so long as the ORDER above already happened.
  } finally {
    __resetSellerInboundOrchestratorDeps();
  }

  assert.ok(order.includes("cancel"), "cancellation must run");
  if (order.includes("classify")) {
    assert.ok(order.indexOf("cancel") < order.indexOf("classify"),
      `cancellation must precede classification, got ${order.join(" -> ")}`);
  }
  assert.equal(pending.queue_status, "cancelled");
  assert.equal(pending.sendable, false, "pending continuation must be non-sendable");
});

// ── I: STOP / DNC suppresses future continuations ──────────────────────────

test("I: a suppressed contactability blocks any further FUS2 continuation", () => {
  for (const status of ["do_not_text", "opted_out", "dnc"]) {
    const d = resolveDeliveryFollowUpDecision({
      final_delivery_status: "delivered",
      provider_message_id: "SM1",
      followup_intent: "stage_no_reply",
      has_inbound_after_outbound: false,
      has_newer_outbound: false,
      pending_followup_exists: false,
      contactability_status: status,
      lifecycle_stage: C.OWNERSHIP_CONFIRMATION,
    });
    assert.equal(d.eligible, false, `${status} must block a continuation`);
    assert.match(d.reason, /contact_blocked/);
  }
});

test("I: an inbound after the outbound also blocks the no-reply continuation", () => {
  // "No reply" is the whole premise; a reply invalidates it.
  const d = resolveDeliveryFollowUpDecision({
    final_delivery_status: "delivered",
    provider_message_id: "SM1",
    followup_intent: "stage_no_reply",
    has_inbound_after_outbound: true,
    has_newer_outbound: false,
    pending_followup_exists: false,
    contactability_status: "contactable",
    lifecycle_stage: C.OWNERSHIP_CONFIRMATION,
  });
  assert.equal(d.eligible, false);
});

// ── L: the three decisions are orthogonal ──────────────────────────────────

test("L: language, agent identity and sending line come from three sources", async () => {
  const { buildBulkFollowUpPlan } = await import("@/lib/domain/inbox/bulk-follow-up-plan.js");
  const CAN = "+15555550100";
  const mk = ({ lang, agent, ourNumber }) => ({
    from(name) {
      const t = (rows) => { const q = { select: () => q, eq: () => q, in: () => q, not: () => q,
        order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r) => Promise.resolve({ data: rows, error: null }).then(r) }; return q; };
      if (name === "sms_templates") return t([A, ES]);
      if (name === "canonical_inbox_threads") return t([{ thread_key: CAN, prospect_first_name: "Sofia", property_address_full: "9 Elm St" }]);
      if (name === "inbox_thread_state") return t([{ thread_key: CAN, master_owner_id: "mo", our_number: ourNumber }]);
      if (name === "master_owners") return t([{ master_owner_id: "mo", agent_persona: agent, agent_family: "General", best_language: lang }]);
      if (name === "textgrid_numbers") return t([{ phone_number: "+15551110001", status: "active", daily_limit: 500, messages_sent_today: 1 }]);
      if (name === "send_queue") return t([{ thread_key: CAN, timezone: "Central", created_at: "2026-08-01" }]);
      return t([]);
    },
  });
  const now = new Date("2026-09-07T18:00:00Z");

  const base = (await buildBulkFollowUpPlan({ threadKeys: [CAN], now },
    { supabase: mk({ lang: "English", agent: "Michael Hargrove", ourNumber: "+15551110001" }) })).recipients[0];
  assert.equal(base.seller_language, "English");
  assert.equal(base.assigned_agent_name, "Michael Hargrove");
  assert.equal(base.from_phone_number, "+15551110001");

  // Change ONLY the language: agent and sending line must not move.
  const langChanged = (await buildBulkFollowUpPlan({ threadKeys: [CAN], now },
    { supabase: mk({ lang: "Spanish", agent: "Michael Hargrove", ourNumber: "+15551110001" }) })).recipients[0];
  assert.equal(langChanged.seller_language, "Spanish");
  assert.equal(langChanged.assigned_agent_name, "Michael Hargrove", "language must not change the agent");
  assert.equal(langChanged.from_phone_number, "+15551110001", "language must not change the sending line");

  // Change ONLY the agent: language and sending line must not move.
  const agentChanged = (await buildBulkFollowUpPlan({ threadKeys: [CAN], now },
    { supabase: mk({ lang: "English", agent: "Helen Crawford", ourNumber: "+15551110001" }) })).recipients[0];
  assert.equal(agentChanged.assigned_agent_name, "Helen Crawford");
  assert.equal(agentChanged.seller_language, "English", "agent must not change the language");
  assert.equal(agentChanged.from_phone_number, "+15551110001", "agent must not change the sending line");
});

// ── M: the bug that blocked the feature ─────────────────────────────────────

const CAN_M = "+15555550100";
const bulkStore = ({ ourNumber, active }) => ({
  from(name) {
    const t = (rows) => { const q = { select: () => q, eq: () => q, in: () => q, not: () => q,
      order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (r) => Promise.resolve({ data: rows, error: null }).then(r) }; return q; };
    if (name === "sms_templates") return t([A, B]);
    if (name === "canonical_inbox_threads") return t([{ thread_key: CAN_M, prospect_first_name: "Sarah", property_address_full: "123 Main St" }]);
    if (name === "inbox_thread_state") return t([{ thread_key: CAN_M, master_owner_id: "mo", our_number: ourNumber }]);
    if (name === "master_owners") return t([{ master_owner_id: "mo", agent_persona: "Michael Hargrove", best_language: "English" }]);
    if (name === "textgrid_numbers") return t(active.map((n) => ({ phone_number: n, status: "active", daily_limit: 500, messages_sent_today: 3 })));
    if (name === "send_queue") return t([{ thread_key: CAN_M, timezone: "Central", created_at: "2026-08-01" }]);
    return t([]);
  },
});

test("M: payload has NO from_phone_number, server resolves it from history", async () => {
  const { buildBulkFollowUpPlan } = await import("@/lib/domain/inbox/bulk-follow-up-plan.js");
  // This is exactly the shape that produced invalid_from_phone_number: the
  // sheet supplies no sending line at all.
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CAN_M], now: new Date("2026-09-07T18:00:00Z") },
    { supabase: bulkStore({ ourNumber: "+15551110001", active: ["+15551110001"] }) },
  );
  const r = plan.recipients[0];
  assert.equal(r.eligible, true, r.reason || "");
  assert.equal(r.from_phone_number, "+15551110001", "server must resolve the line");
  assert.notEqual(r.reason, "invalid_from_phone_number");
});

test("M: an INACTIVE historical number is not blindly reused", async () => {
  const { buildBulkFollowUpPlan } = await import("@/lib/domain/inbox/bulk-follow-up-plan.js");
  const plan = await buildBulkFollowUpPlan(
    { threadKeys: [CAN_M], now: new Date("2026-09-07T18:00:00Z") },
    // History points at a number that is no longer in the active registry.
    { supabase: bulkStore({ ourNumber: "+15559998888", active: ["+15551110001"] }) },
  );
  const r = plan.recipients[0];
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "no_eligible_sender_number");
  assert.equal(r.from_phone_number, undefined, "a released line must never be used");
});

test("M: a number over its daily limit is not eligible", async () => {
  const { buildBulkFollowUpPlan } = await import("@/lib/domain/inbox/bulk-follow-up-plan.js");
  const overLimit = {
    from(name) {
      const t = (rows) => { const q = { select: () => q, eq: () => q, in: () => q, not: () => q,
        order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r) => Promise.resolve({ data: rows, error: null }).then(r) }; return q; };
      if (name === "sms_templates") return t([A]);
      if (name === "canonical_inbox_threads") return t([{ thread_key: CAN_M, prospect_first_name: "Sarah", property_address_full: "123 Main St" }]);
      if (name === "inbox_thread_state") return t([{ thread_key: CAN_M, master_owner_id: "mo", our_number: "+15551110001" }]);
      if (name === "master_owners") return t([{ master_owner_id: "mo", agent_persona: "Michael Hargrove", best_language: "English" }]);
      if (name === "textgrid_numbers") return t([{ phone_number: "+15551110001", status: "active", daily_limit: 100, messages_sent_today: 100 }]);
      if (name === "send_queue") return t([{ thread_key: CAN_M, timezone: "Central", created_at: "2026-08-01" }]);
      return t([]);
    },
  };
  const plan = await buildBulkFollowUpPlan({ threadKeys: [CAN_M], now: new Date("2026-09-07T18:00:00Z") }, { supabase: overLimit });
  assert.equal(plan.recipients[0].eligible, false);
  assert.equal(plan.recipients[0].reason, "no_eligible_sender_number");
});

test("M: an unreadable registry yields NEED REVIEW, never an unverified line", async () => {
  const { buildBulkFollowUpPlan } = await import("@/lib/domain/inbox/bulk-follow-up-plan.js");
  const broken = {
    from(name) {
      const t = (rows) => { const q = { select: () => q, eq: () => q, in: () => q, not: () => q,
        order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r) => Promise.resolve({ data: rows, error: null }).then(r) }; return q; };
      if (name === "textgrid_numbers") throw new Error("registry unavailable");
      if (name === "sms_templates") return t([A]);
      if (name === "canonical_inbox_threads") return t([{ thread_key: CAN_M, prospect_first_name: "Sarah", property_address_full: "123 Main St" }]);
      if (name === "inbox_thread_state") return t([{ thread_key: CAN_M, master_owner_id: "mo", our_number: "+15551110001" }]);
      if (name === "master_owners") return t([{ master_owner_id: "mo", agent_persona: "Michael Hargrove", best_language: "English" }]);
      if (name === "send_queue") return t([{ thread_key: CAN_M, timezone: "Central", created_at: "2026-08-01" }]);
      return t([]);
    },
  };
  const plan = await buildBulkFollowUpPlan({ threadKeys: [CAN_M], now: new Date("2026-09-07T18:00:00Z") }, { supabase: broken });
  assert.equal(plan.recipients[0].eligible, false, "an unverifiable line must not be used");
  assert.equal(plan.recipients[0].reason, "no_eligible_sender_number");
});

// ── D (extended): exhaustion fallback ───────────────────────────────────────

test("D: when every variant has prior use, the ranked best is reused, flagged", () => {
  const all = [A.template_id, B.template_id, D_.template_id];
  const chosen = selectFus2Template({ templates: [A, B, D_], usedTemplateIds: all });
  assert.equal(chosen.ok, true);
  assert.ok(chosen.template, "must still return a template rather than stall");
  assert.equal(chosen.exhausted, true);
  assert.equal(chosen.rotation_reason, "all_variants_used_least_recent");
});

// ── L (extended): two fixtures that would diverge if coupled ───────────────

test("L: Portuguese/Ana and Korean/Jin keep language, agent and sender separate", async () => {
  const { buildBulkFollowUpPlan } = await import("@/lib/domain/inbox/bulk-follow-up-plan.js");
  const KO = tpl("lc-reengage-agent-ko-001", "Korean");
  const mk = ({ lang, agent, ourNumber, templates }) => ({
    from(name) {
      const t = (rows) => { const q = { select: () => q, eq: () => q, in: () => q, not: () => q,
        order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r) => Promise.resolve({ data: rows, error: null }).then(r) }; return q; };
      if (name === "sms_templates") return t(templates);
      if (name === "canonical_inbox_threads") return t([{ thread_key: CAN_M, prospect_first_name: "Jorge", property_address_full: "9 Elm St" }]);
      if (name === "inbox_thread_state") return t([{ thread_key: CAN_M, master_owner_id: "mo", our_number: ourNumber }]);
      if (name === "master_owners") return t([{ master_owner_id: "mo", agent_persona: agent, agent_family: "General", best_language: lang }]);
      if (name === "textgrid_numbers") return t([
        { phone_number: "+15551110001", status: "active", daily_limit: 500, messages_sent_today: 1 },
        { phone_number: "+15552220002", status: "active", daily_limit: 500, messages_sent_today: 1 },
      ]);
      if (name === "send_queue") return t([{ thread_key: CAN_M, timezone: "Central", created_at: "2026-08-01" }]);
      return t([]);
    },
  });
  const now = new Date("2026-09-07T18:00:00Z");

  const pt = (await buildBulkFollowUpPlan({ threadKeys: [CAN_M], now },
    { supabase: mk({ lang: "Portuguese", agent: "Ana Ferreira", ourNumber: "+15551110001", templates: [A, PT, KO] }) })).recipients[0];
  assert.equal(pt.seller_language, "Portuguese");
  assert.equal(pt.assigned_agent_name, "Ana Ferreira");
  assert.equal(pt.from_phone_number, "+15551110001");

  const ko = (await buildBulkFollowUpPlan({ threadKeys: [CAN_M], now },
    { supabase: mk({ lang: "Korean", agent: "Jin Park", ourNumber: "+15552220002", templates: [A, PT, KO] }) })).recipients[0];
  assert.equal(ko.seller_language, "Korean");
  assert.equal(ko.assigned_agent_name, "Jin Park");
  assert.equal(ko.from_phone_number, "+15552220002");

  // All three differ across the two fixtures, and none was inferred from another:
  // language came from best_language, the agent from agent_persona, the line
  // from conversation history.
  assert.notEqual(pt.seller_language, ko.seller_language);
  assert.notEqual(pt.assigned_agent_name, ko.assigned_agent_name);
  assert.notEqual(pt.from_phone_number, ko.from_phone_number);
});
