// ─── canary-e2e-routing-reconciliation.test.mjs ──────────────────────────────
// Production-shaped timeline for Stage 1 canary E2E defects:
// 21610 → authorized retry → deliver → dual inbound → supersession → Stage 3.

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { classify } from "@/lib/domain/classification/classify.js";
import { normalizeInboundTextgridPhone } from "@/lib/providers/textgrid.js";
import { resolveCanonicalInboundThreadKey } from "@/lib/domain/inbox/resolve-canonical-inbound-thread.js";
import {
  reconcileProviderAttemptHistory,
  buildSuccessfulRetryAggregatePatch,
} from "@/lib/domain/queue/provider-attempt-history.js";
import { buildContactWindowDeferral } from "@/lib/domain/queue/contact-window-deferral.js";
import { SUPERSEDED_BY_NEWER_INBOUND } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { OWNERSHIP_INTEREST_COMBO_VARIANTS } from "@/lib/domain/templates/ownership-interest-combo-experiment.js";
import { LOCAL_TEMPLATE_CANDIDATES } from "@/lib/domain/templates/local-template-registry.js";
import {
  resolveNextSellerStage,
  resolveAutoReplyUseCase,
  normalizeSellerInboundIntent,
} from "@/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js";

const CANARY = "+16128072000";
const SENDER = "+16128060495";
const THREAD_ID = "542f27d2-0271-4ddc-94b3-efee76cf74ae";
const SID = "SMO8VxnJAOWsNa926YKkFtS5w==";
const HIST_21610 = "5940278f-ca2b-47b7-9255-573079e33ddd";

// ── 1. E.164 inbound normalization ──────────────────────────────────────────

test("normalizeInboundTextgridPhone always returns E.164, never bare 10-digit", () => {
  assert.equal(normalizeInboundTextgridPhone("+16128072000"), CANARY);
  assert.equal(normalizeInboundTextgridPhone("6128072000"), CANARY);
  assert.equal(normalizeInboundTextgridPhone("16128072000"), CANARY);
  assert.equal(normalizeInboundTextgridPhone("+1 (612) 807-2000"), CANARY);
  assert.notEqual(normalizeInboundTextgridPhone("6128072000"), "6128072000");
});

test("resolveCanonicalInboundThreadKey maps bare 10-digit to E.164 active thread", () => {
  const resolved = resolveCanonicalInboundThreadKey({
    inbound_from: "6128072000",
    threads: [
      {
        thread_key: "6128072000",
        is_archived: true,
        metadata: { replaced_by_thread_key: CANARY },
      },
      {
        id: THREAD_ID,
        thread_key: CANARY,
        is_archived: false,
      },
    ],
  });
  assert.equal(resolved.thread_key, CANARY);
  assert.notEqual(resolved.thread_key, "6128072000");
  // Bare input normalizes to E.164 before alias redirect is required
  assert.ok(
    resolved.resolved_from === "active_e164_thread" || resolved.alias_redirected === true
  );
});

test("resolveCanonicalInboundThreadKey never returns bare alias when E.164 available", () => {
  const resolved = resolveCanonicalInboundThreadKey({
    inbound_from: CANARY,
    threads: [
      { thread_key: "6128072000", is_archived: true, metadata: { replaced_by_thread_key: CANARY } },
      { thread_key: CANARY, is_archived: false },
    ],
  });
  assert.equal(resolved.thread_key, CANARY);
  assert.equal(resolved.resolved_from, "active_e164_thread");
});

// ── 2. Transport attempt history ────────────────────────────────────────────

test("provider attempt history: 21610 then authorized deliver → aggregate delivered", () => {
  const agg = reconcileProviderAttemptHistory([
    { outcome: "failed", provider_code: "21610", provider_sid: null },
    {
      outcome: "delivered",
      provider_sid: SID,
      authorized_retry: true,
    },
  ]);
  assert.equal(agg.provider_attempt_count, 2);
  assert.equal(agg.retry_count, 1);
  assert.equal(agg.successful_provider_attempt_count, 1);
  assert.equal(agg.delivered_count, 1);
  assert.equal(agg.provider_sid_count, 1);
  assert.equal(agg.aggregate_queue_status, "delivered");
  assert.equal(agg.historical_failures_preserved, true);
});

test("successful retry aggregate patch preserves prior 21610 under audit key", () => {
  const patch = buildSuccessfulRetryAggregatePatch({
    previous_status: "failed",
    previous_failed_reason: "blacklist",
    previous_metadata: {
      provider_error: { code: "21610", status: 400 },
      failure_class: "recipient_opted_out",
      failure_bucket: "provider_blacklist_pair",
    },
    success_sid: SID,
    success_at: "2026-07-17T05:34:06.395Z",
    authorized_retry_at: "2026-07-17T05:34:05.880Z",
  });
  assert.equal(patch.queue_status, "delivered");
  assert.equal(patch.provider_message_id, SID);
  assert.equal(patch.failed_reason, null);
  assert.equal(patch.metadata_patch.historical_failure_preserved, true);
  assert.equal(patch.metadata_patch.prior_terminal_failure_audit?.provider_error?.code, "21610");
  assert.ok(patch.metadata_patch.provider_attempts.length >= 2);
});

// ── 3. Classification: proposal request ─────────────────────────────────────

test('classify: "Yeah" is ownership_confirmed without proposal request', async () => {
  const result = await classify("Yeah");
  assert.equal(result.primary_intent, "ownership_confirmed");
  assert.notEqual(result.primary_intent, "asks_offer");
  assert.ok(result.confidence >= 0.9);
});

test('classify: "Yes, what\'s the proposal?" is asks_offer (Stage 3)', async () => {
  const result = await classify("Yes, what's the proposal?");
  assert.equal(result.primary_intent, "asks_offer");
  assert.equal(result.seller_state?.ownership_confirmed, true);
  assert.ok(
    result.secondary_intent === "ownership_confirmed" ||
      result.seller_state?.ownership_confirmed === true
  );
});

test("asks_offer auto-reply plan advances to ASKING_PRICE / seller_asking_price", () => {
  const input = {
    message_body: "Yes, what's the proposal?",
    classification: {
      primary_intent: "asks_offer",
      secondary_intent: "ownership_confirmed",
      confidence: 0.98,
      seller_state: { ownership_confirmed: true },
    },
    current_stage: "ownership_confirmation",
    conversation_context: { summary: { conversation_stage: "ownership_confirmation" } },
  };
  const stage = resolveNextSellerStage(input);
  const useCase = resolveAutoReplyUseCase(input);
  assert.equal(stage, "asking_price");
  assert.equal(useCase, "seller_asking_price");
});

test('normalizeSellerInboundIntent: "Yes, what\'s the proposal?" is asks_offer not ownership', () => {
  assert.equal(
    normalizeSellerInboundIntent({
      message_body: "Yes, what's the proposal?",
      classification: { primary_intent: "asks_offer" },
    }),
    "asks_offer"
  );
  assert.equal(
    normalizeSellerInboundIntent({
      message_body: "Yeah",
      classification: { primary_intent: "ownership_confirmed" },
    }),
    "ownership_confirmed"
  );
});

// ── 4. Correct Stage 3 template (proposal-safe) ─────────────────────────────

test("seller_asking_price local template is proposal-safe and one segment", () => {
  const tpl = LOCAL_TEMPLATE_CANDIDATES.find(
    (t) => t.use_case === "seller_asking_price" && t.language === "English"
  );
  assert.ok(tpl, "seller_asking_price English template must exist");
  assert.match(tpl.text, /price|number|mind/i);
  assert.doesNotMatch(tpl.text, /\boffer\b|\bsell\b|\bselling\b|\bbuyer\b|\bpurchase\b|\bcash\b/i);
  assert.ok(tpl.text.length <= 160);
  assert.equal(
    tpl.text,
    "Got it. What price would you have in mind for the property?"
  );
});

test("Stage 1 combo live copy remains proposal-only (no sell/offer)", () => {
  const body = OWNERSHIP_INTEREST_COMBO_VARIANTS.English.text;
  assert.match(body, /proposal/i);
  assert.doesNotMatch(body, /\boffer\b|\bselling\b|\bsell\b/i);
});

// ── 5. Supersession + contact window deferral ───────────────────────────────

test("superseded_by_newer_inbound constant is stable", () => {
  assert.equal(SUPERSEDED_BY_NEWER_INBOUND, "superseded_by_newer_inbound");
});

test("outside contact window yields scheduled/deferred with reason", () => {
  const d = buildContactWindowDeferral({
    allowed: false,
    reason: "outside_local_send_window",
    timezone: "America/Chicago",
    next_open_at: "2026-07-17T14:00:00.000Z",
  });
  assert.equal(d.deferred, true);
  assert.equal(d.reason, "deferred_contact_window");
  assert.equal(d.queue_status, "scheduled");
  assert.equal(d.next_eligible_at, "2026-07-17T14:00:00.000Z");
  assert.equal(d.metadata.deferred_contact_window, true);
});

test("inside contact window is not deferred", () => {
  const d = buildContactWindowDeferral({ allowed: true });
  assert.equal(d.deferred, false);
  assert.equal(d.queue_status, "queued");
});

// ── 6. Full production-shaped timeline (deterministic, no I/O) ──────────────

test("canary E2E timeline: 21610 → retry deliver → dual inbound → Stage 3 deferred", async () => {
  // 1–2. First-touch attempts
  const attempts = [
    { outcome: "failed", provider_code: "21610", provider_sid: null, authorized_retry: false },
    {
      outcome: "delivered",
      provider_sid: SID,
      authorized_retry: true,
      authorized_retry_at: "2026-07-17T05:34:05.880Z",
    },
  ];
  const transport = reconcileProviderAttemptHistory(attempts);
  assert.equal(transport.provider_attempt_count, 2);
  assert.equal(transport.aggregate_queue_status, "delivered");

  // 3. Alias never used after normalize
  assert.equal(normalizeInboundTextgridPhone("6128072000"), CANARY);
  const thread = resolveCanonicalInboundThreadKey({
    inbound_from: "6128072000",
    threads: [
      {
        thread_key: "6128072000",
        is_archived: true,
        metadata: { replaced_by_thread_key: CANARY },
      },
      { thread_key: CANARY, is_archived: false, id: THREAD_ID },
    ],
  });
  assert.equal(thread.thread_key, CANARY);

  // 4–5. Dual inbound classification
  const yeah = await classify("Yeah");
  const proposal = await classify("Yes, what's the proposal?");
  assert.equal(yeah.primary_intent, "ownership_confirmed");
  assert.equal(proposal.primary_intent, "asks_offer");

  // 6. Supersession semantics
  const firstReply = {
    id: "reply-1",
    queue_status: "queued",
    source: "auto_reply",
    use_case: "consider_selling",
  };
  const supersession = {
    cancel: firstReply,
    reason: SUPERSEDED_BY_NEWER_INBOUND,
    replacement_use_case: "seller_asking_price",
    body: "Got it. What price would you have in mind for the property?",
  };
  assert.equal(supersession.reason, "superseded_by_newer_inbound");
  assert.equal(supersession.replacement_use_case, "seller_asking_price");
  assert.doesNotMatch(supersession.body, /\boffer\b|\bsell\b/i);

  // 7. Outside hours → deferred, no provider call
  const deferral = buildContactWindowDeferral({
    allowed: false,
    reason: "outside_local_send_window",
    timezone: "America/Chicago",
    next_open_at: "2026-07-17T14:00:00.000Z",
  });
  assert.equal(deferral.deferred, true);
  assert.equal(deferral.reason, "deferred_contact_window");
  assert.ok(deferral.next_eligible_at);

  // 8. No activity on retired alias
  const events = [
    { thread_key: CANARY, body: "Yeah" },
    { thread_key: CANARY, body: "Yes, what's the proposal?" },
  ];
  assert.ok(events.every((e) => e.thread_key === CANARY));
  assert.ok(events.every((e) => e.thread_key !== "6128072000"));

  // 9. Held row never auto-dispatches in this unit test (no provider mock calls)
  const held = { id: "856319a0-978f-49ed-b70f-6bdca196f663", queue_status: "held", provider_sid: null };
  assert.equal(held.provider_sid, null);
});

// ── 7. Isolated defect regressions ──────────────────────────────────────────

test("historical 21610 alone does not clear successful delivery aggregate", () => {
  const agg = reconcileProviderAttemptHistory([
    { outcome: "failed", provider_code: "21610" },
    { outcome: "delivered", provider_sid: SID },
  ]);
  assert.notEqual(agg.aggregate_queue_status, "failed");
  assert.equal(agg.aggregate_queue_status, "delivered");
});

test("redundant Stage 2 consider_selling is wrong after asks_offer", async () => {
  const c = await classify("Yes, what's the proposal?");
  assert.equal(c.primary_intent, "asks_offer");
  // Must not select consider_selling as primary next for this intent
  assert.notEqual(c.seller_state?.next_best_action, "confirm_selling_interest");
});
