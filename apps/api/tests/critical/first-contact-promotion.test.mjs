/**
 * first-contact-promotion.test.mjs
 *
 * Defect A (2026-09-08): 150 provider-accepted campaign first touches left
 * every inbox_thread_state row at conversation_status 'not_contacted'. These
 * pin the repaired contract at the successful-send seam:
 *   enqueue / scheduled / claimed / failed  -> untouched (never reach the seam)
 *   provider accepted (SID present)         -> not_contacted -> waiting_on_seller, S1 if no stage
 *   later-stage thread                      -> never regressed
 *   re-finalization                         -> idempotent no-op
 *   'contacted' literal                     -> would invert; the code must not use it
 * and prove the inbound policy answers from a contacted S1 thread.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  decideFirstContactPromotion,
  promoteFirstContactOnProviderAcceptance,
  FIRST_CONTACT_REASON,
} from "@/lib/domain/lead-state/promote-first-contact-on-send.js";
import {
  LIFECYCLE_STAGE_CODES,
  OPERATIONAL_STATUS_CODES,
  normalizeOperationalStatus,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";

const THREAD = "+13055550142";

function acceptedRow(overrides = {}) {
  return {
    id: "q-1",
    thread_key: THREAD,
    to_phone_number: THREAD,
    provider_message_id: "SM-accepted-1",
    queue_key: "campaign_target_one:t-1:t1",
    touch_number: 1,
    metadata: {},
    ...overrides,
  };
}

function harness(previousRow) {
  const calls = [];
  const deps = {
    fetchCurrentLeadState: async () => previousRow,
    patchUniversalLeadState: async (args) => { calls.push(args); return { ok: true, thread_key: args.threadKey }; },
  };
  return { deps, calls };
}

// ── pure decision ──────────────────────────────────────────────────────────

test("a brand-new thread (no row) is promoted to waiting_on_seller at S1", () => {
  const d = decideFirstContactPromotion(null);
  assert.equal(d.promote, true);
  assert.equal(d.patch.operational_status, OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER);
  assert.equal(d.patch.lifecycle_stage, LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION);
});

test("not_contacted and scheduled are both 'never reached' and promote", () => {
  for (const status of ["not_contacted", "scheduled"]) {
    const d = decideFirstContactPromotion({ operational_status: status });
    assert.equal(d.promote, true, status);
  }
});

test("an existing stage is preserved -- a send never moves stage", () => {
  const d = decideFirstContactPromotion({ operational_status: "not_contacted", lifecycle_stage: "offer_interest" });
  assert.equal(d.promote, true);
  assert.equal(d.patch.operational_status, OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER);
  assert.equal("lifecycle_stage" in d.patch, false, "must not overwrite an existing stage");
});

test("later-stage conversations are never regressed (monotonic)", () => {
  for (const status of ["waiting_on_seller", "new_reply", "active_communication", "needs_review", "snoozed", "paused", "follow_up_due"]) {
    const d = decideFirstContactPromotion({ operational_status: status, lifecycle_stage: "asking_price" });
    assert.equal(d.promote, false, status);
    assert.match(d.reason, /^already_engaged:/);
  }
});

test("legacy conversation_status column is honoured when operational_status is absent", () => {
  assert.equal(decideFirstContactPromotion({ conversation_status: "not_contacted" }).promote, true);
  assert.equal(decideFirstContactPromotion({ conversation_status: "active_communication" }).promote, false);
});

test("the literal 'contacted' would silently invert -- the code never uses it", () => {
  // This is the trap the fix had to avoid: the registry has no 'contacted'.
  assert.equal(normalizeOperationalStatus("contacted"), OPERATIONAL_STATUS_CODES.NOT_CONTACTED);
  const d = decideFirstContactPromotion(null);
  assert.notEqual(d.patch.operational_status, "contacted");
});

// ── seam behaviour with injected state ─────────────────────────────────────

test("no provider SID => not promoted (queued / claimed / failed rows never count)", async () => {
  const { deps, calls } = harness({ operational_status: "not_contacted" });
  const r = await promoteFirstContactOnProviderAcceptance({ queue_row: acceptedRow({ provider_message_id: null }), supabase: {}, deps });
  assert.equal(r.promoted, false);
  assert.equal(r.reason, "no_provider_sid");
  assert.equal(calls.length, 0);
});

test("provider accepted on a not_contacted thread => exactly one canonical patch with provenance", async () => {
  const { deps, calls } = harness({ operational_status: "not_contacted" });
  const r = await promoteFirstContactOnProviderAcceptance({
    queue_row: acceptedRow(), outbound_event: { item_id: "me-1" }, supabase: {}, now: "2026-09-08T18:24:50.000Z", deps,
  });
  assert.equal(r.ok, true); assert.equal(r.promoted, true);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.threadKey, THREAD);
  assert.equal(c.patch.operational_status, OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER);
  assert.equal(c.patch.lifecycle_stage, LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION);
  assert.equal(c.meta.change_source, "system");
  assert.equal(c.meta.reason, FIRST_CONTACT_REASON);
  assert.equal(c.meta.message_event_id, "me-1");
  assert.equal(c.meta.metadata.provider_message_id, "SM-accepted-1");
});

test("re-finalizing the same outbound is idempotent: second pass is a no-op", async () => {
  let row = { operational_status: "not_contacted" };
  const calls = [];
  const deps = {
    fetchCurrentLeadState: async () => row,
    patchUniversalLeadState: async (args) => { calls.push(args); row = { ...row, ...args.patch }; return { ok: true }; },
  };
  const first = await promoteFirstContactOnProviderAcceptance({ queue_row: acceptedRow(), supabase: {}, deps });
  const second = await promoteFirstContactOnProviderAcceptance({ queue_row: acceptedRow(), supabase: {}, deps });
  assert.equal(first.promoted, true);
  assert.equal(second.promoted, false);
  assert.match(second.reason, /^already_engaged:waiting_on_seller/);
  assert.equal(calls.length, 1, "one durable promotion, no duplicate stage event");
});

test("a later outbound to an S2+ thread never touches state", async () => {
  const { deps, calls } = harness({ operational_status: "active_communication", lifecycle_stage: "offer_interest" });
  const r = await promoteFirstContactOnProviderAcceptance({ queue_row: acceptedRow({ touch_number: 3 }), supabase: {}, deps });
  assert.equal(r.promoted, false); assert.equal(calls.length, 0);
});

test("non-canonical thread keys and proof rows are skipped, never thrown", async () => {
  const { deps, calls } = harness(null);
  const a = await promoteFirstContactOnProviderAcceptance({ queue_row: acceptedRow({ thread_key: "owner:abc", to_phone_number: "" }), supabase: {}, deps });
  const b = await promoteFirstContactOnProviderAcceptance({ queue_row: acceptedRow({ metadata: { no_send: true } }), supabase: {}, deps });
  assert.equal(a.promoted, false); assert.equal(a.reason, "non_canonical_thread_key");
  assert.equal(b.promoted, false); assert.equal(b.reason, "proof_row");
  assert.equal(calls.length, 0);
});

test("a blocked canonical patch is reported, not thrown (bookkeeping never fails the send)", async () => {
  const deps = {
    fetchCurrentLeadState: async () => null,
    patchUniversalLeadState: async () => ({ ok: false, blocked: true, reason: "unsupported_suppression_rejected" }),
  };
  const r = await promoteFirstContactOnProviderAcceptance({ queue_row: acceptedRow(), supabase: {}, deps });
  assert.equal(r.ok, false); assert.equal(r.promoted, false);
  assert.equal(r.reason, "unsupported_suppression_rejected");
});

test("a thrown dependency is contained", async () => {
  const deps = { fetchCurrentLeadState: async () => { throw new Error("db down"); } };
  const r = await promoteFirstContactOnProviderAcceptance({ queue_row: acceptedRow(), supabase: {}, deps });
  assert.equal(r.ok, false); assert.match(r.reason, /first_contact_promotion_failed:db down/);
});

// ── A5: inbound policy answers from a contacted S1 thread ─────────────────

const IDENTITY = {
  threadKey: THREAD, inboundFrom: THREAD, inboundTo: "+13055552999",
  ownerId: "owner-1", propertyId: "prop-1", prospectId: "prospect-1",
  inboundReceivedAt: "2026-09-08T18:31:57.000Z",
  latestThreadContext: {
    disposition: null, last_intent: null,
    lifecycle_stage: LIFECYCLE_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    operational_status: OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER,
    conversation_status: OPERATIONAL_STATUS_CODES.WAITING_ON_SELLER,
  },
};
async function decide(message) {
  const classification = await classify(message, null, { heuristicOnly: true });
  return { classification, decision: await applyInboundAutomationDecision({ ...IDENTITY, message, classification }) };
}

test("A5: 'yes I own it' after a contacted S1 is a reply-worthy ownership confirmation", async () => {
  const { classification, decision } = await decide("Yes I own it");
  assert.equal(classification.primary_intent, "ownership_confirmed");
  assert.equal(decision.should_queue_reply, true, JSON.stringify(decision));
});

test("A5: 'who is this?' after a contacted S1 gets the identity response path", async () => {
  const { classification, decision } = await decide("Who is this?");
  assert.equal(classification.primary_intent, "who_is_this");
  assert.equal(decision.should_queue_reply, true, JSON.stringify(decision));
});

test("A5: 'not interested' still declines without an unnecessary reply", async () => {
  const { classification, decision } = await decide("Not interested");
  assert.equal(classification.primary_intent, "not_interested");
  assert.equal(decision.should_queue_reply, false);
  assert.ok(decision.next_action || decision.should_suppress_contact || decision.should_mark_human_review, "a decline must resolve to an explicit non-reply outcome");
});
