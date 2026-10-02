/**
 * NEW REPLIES CLEANUP 7.2 — planner (preview) and repair executor.
 *
 * Every authority is a test double: nothing touches a database. Pins:
 *   - wrong person: relationship-scoped (contact x property + owner-scoped
 *     phone flag), NEVER the global DNC list, next contact only PREVIEWED;
 *   - next-contact gates: DNC/suppression, wrong-number history, landline,
 *     prior/active contact, government/work email; email never sends;
 *   - sold -> closed/lost + archive; not interested -> 30-day nurture;
 *     hostile -> archive/cool, no nurture, no DNC;
 *   - compare-and-set + idempotent re-run; old values preserved;
 *   - the evaluation export and regression text are de-identified.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLEANUP_CATEGORY,
  CLEANUP_SOURCE,
  categorizeReply,
  planThreadCleanup,
  planNextContact,
  planNewRepliesCleanup,
  summarizeCleanup,
  deidentifyPair,
  buildEvaluationExport,
  maskPhone,
} from "@/lib/domain/inbox/new-replies-cleanup.js";
import { applyNewRepliesCleanupPlan } from "@/lib/domain/inbox/new-replies-cleanup-apply.js";
import { applyClassifierCorrection } from "@/lib/domain/inbox/reconcile-inbox-thread-state.js";

const THREAD = { id: "11111111-aaaa-bbbb-cccc-000000000001", thread_key: "+16125550111", property_id: "prop-1", master_owner_id: "mo-1", prospect_id: "pr-1", inbox_bucket: "new_replies", last_intent: "unclear", disposition: null, updated_at: "2026-10-01T10:00:00.000Z", metadata: {} };

function deps(overrides = {}) {
  const calls = [];
  const rec = (name, result = { ok: true }) => async (...args) => {
    calls.push({ name, args });
    return typeof result === "function" ? result(...args) : result;
  };
  return {
    calls,
    deps: {
      supabase: { tag: "db" },
      now: "2026-10-02T00:00:00.000Z",
      applyClassifierCorrection: rec("applyClassifierCorrection", { ok: true, written: true }),
      patchUniversalLeadState: rec("patchUniversalLeadState"),
      recordContactOutcome: rec("recordContactOutcome"),
      applyInboundSuppression: rec("applyInboundSuppression"),
      transitionOpportunityStage: rec("transitionOpportunityStage"),
      cancelPendingFollowUpsForThread: rec("cancelPendingFollowUpsForThread"),
      scheduleFollowUp: rec("scheduleFollowUp"),
      ...overrides,
    },
  };
}

const plan = (category, extra = {}) =>
  planThreadCleanup({ thread: THREAD, classification: { primary_intent: extra.intent || "unclear", confidence: 0.9, classifier_version: "v3" }, category, ...extra });

test("wrong person: relationship-scoped, archived, and never a global DNC write", async () => {
  const { calls, deps: d } = deps();
  const p = plan(CLEANUP_CATEGORY.WRONG_PERSON, { intent: "wrong_number" });
  const res = await applyNewRepliesCleanupPlan(p, { thread: THREAD, next_contact_plan: { channel: "email" } }, d);
  assert.equal(res.ok, true);
  const names = calls.map((c) => c.name);
  assert.deepEqual(names, ["applyClassifierCorrection", "recordContactOutcome", "applyInboundSuppression", "patchUniversalLeadState"]);
  const outcome = calls.find((c) => c.name === "recordContactOutcome").args[1];
  assert.equal(outcome.outcome, "not_owner");
  assert.equal(outcome.suppression_scope, "contact_property_pair");
  const suppression = calls.find((c) => c.name === "applyInboundSuppression").args[0];
  assert.equal(suppression.reason, "wrong_number", "never opt_out: a wrong person did not opt out");
  assert.equal(suppression.ownerId, "mo-1", "scoped to THIS owner");
  const archive = calls.find((c) => c.name === "patchUniversalLeadState").args[0];
  assert.equal(archive.patch.disposition, "wrong_person");
  assert.equal(archive.patch.is_archived, true);
  assert.equal(archive.meta.source_view, CLEANUP_SOURCE);
  assert.ok(res.steps.some((s) => s.reason === "pending_email_recorded_email_sending_off"), "email next contact is recorded, never sent");
});

test("wrong person without a known owner: no phone flag at all (the pair record carries it)", async () => {
  const { calls, deps: d } = deps();
  const p = planThreadCleanup({ thread: { ...THREAD, master_owner_id: null }, classification: { primary_intent: "wrong_number" }, category: CLEANUP_CATEGORY.WRONG_PERSON });
  await applyNewRepliesCleanupPlan(p, { thread: { ...THREAD, master_owner_id: null } }, d);
  assert.equal(calls.some((c) => c.name === "applyInboundSuppression"), false);
  assert.equal(calls.some((c) => c.name === "recordContactOutcome"), true);
});

test("sold: closed/lost through the opportunity authority, follow-ups cancelled, thread archived", async () => {
  const { calls, deps: d } = deps();
  const p = plan(CLEANUP_CATEGORY.SOLD, { intent: "sold_property", opportunity: { id: "opp-1", acquisition_stage: "offer_interest", opportunity_status: "active" } });
  await applyNewRepliesCleanupPlan(p, { thread: THREAD, opportunity: { id: "opp-1", acquisition_stage: "offer_interest" } }, d);
  const close = calls.find((c) => c.name === "transitionOpportunityStage");
  assert.equal(close.args[0], "opp-1");
  assert.equal(close.args[1].to_stage, "closed");
  assert.equal(close.args[1].outcome, "lost");
  assert.ok(calls.some((c) => c.name === "cancelPendingFollowUpsForThread"));
  assert.equal(calls.find((c) => c.name === "patchUniversalLeadState").args[0].patch.disposition, "sold");
  assert.equal(calls.some((c) => c.name === "applyInboundSuppression"), false, "sold is never a suppression");
});

test("not interested / not for sale: 30-day nurture through the canonical scheduler, never suppression", async () => {
  for (const category of [CLEANUP_CATEGORY.NOT_INTERESTED, CLEANUP_CATEGORY.NOT_FOR_SALE]) {
    const { calls, deps: d } = deps();
    await applyNewRepliesCleanupPlan(plan(category, { intent: "not_interested" }), { thread: THREAD }, d);
    const nurture = calls.find((c) => c.name === "patchUniversalLeadState").args[0].patch;
    assert.equal(nurture.disposition, "not_interested");
    assert.equal(nurture.follow_up_at, "2026-11-01T00:00:00.000Z");
    assert.deepEqual(calls.find((c) => c.name === "scheduleFollowUp").args.slice(0, 2), ["not_interested", THREAD.thread_key]);
    assert.equal(calls.some((c) => c.name === "applyInboundSuppression"), false);
  }
});

test("hostile without opt-out: archived/cooled, no automatic nurture, no DNC", async () => {
  const { calls, deps: d } = deps();
  await applyNewRepliesCleanupPlan(plan(CLEANUP_CATEGORY.HOSTILE, { intent: "hostile_or_legal" }), { thread: THREAD }, d);
  assert.equal(calls.some((c) => c.name === "scheduleFollowUp"), false);
  assert.equal(calls.some((c) => c.name === "applyInboundSuppression"), false);
  const archive = calls.find((c) => c.name === "patchUniversalLeadState").args[0].patch;
  assert.equal(archive.is_archived, true);
  assert.equal(archive.archive_reason, "hostile_no_opt_out");
});

test("emoji clarification / call request / keep: no archive, no follow-up row, nothing sent by the repair", async () => {
  for (const category of [CLEANUP_CATEGORY.EMOJI_CLARIFY, CLEANUP_CATEGORY.CALL_REQUEST, CLEANUP_CATEGORY.KEEP, CLEANUP_CATEGORY.AUTO_REPLY]) {
    const { calls, deps: d } = deps();
    await applyNewRepliesCleanupPlan(plan(category), { thread: THREAD }, d);
    assert.equal(calls.some((c) => ["scheduleFollowUp", "transitionOpportunityStage", "applyInboundSuppression"].includes(c.name)), false, category);
  }
});

test("a thread that changed since the preview is left alone; a second run is a no-op", async () => {
  const conflict = deps({ applyClassifierCorrection: async () => ({ ok: false, reason: "conflict_thread_changed_since_preview" }) });
  const r1 = await applyNewRepliesCleanupPlan(plan(CLEANUP_CATEGORY.SOLD, { intent: "sold_property" }), { thread: THREAD }, conflict.deps);
  assert.equal(r1.ok, false);
  assert.equal(conflict.calls.length, 0, "nothing after a failed compare-and-set");
  const again = deps({ applyClassifierCorrection: async () => ({ ok: true, skipped: true, reason: "already_applied" }) });
  const r2 = await applyNewRepliesCleanupPlan(plan(CLEANUP_CATEGORY.NOT_INTERESTED, { intent: "not_interested" }), { thread: THREAD }, again.deps);
  assert.equal(r2.ok, true);
  assert.equal(again.calls.length, 0, "an already-applied thread schedules no second follow-up");
});

test("the classifier correction is compare-and-set and preserves the old classification", async () => {
  const writes = [];
  const supabase = {
    from: () => {
      const q = {
        _patch: null,
        _filters: [],
        update(p) { q._patch = p; return q; },
        eq(c, v) { q._filters.push([c, v]); return q; },
        select: async () => {
          writes.push({ patch: q._patch, filters: q._filters });
          return { data: [{ thread_key: THREAD.thread_key }], error: null };
        },
      };
      return q;
    },
  };
  const res = await applyClassifierCorrection(supabase, {
    thread: THREAD,
    source: CLEANUP_SOURCE,
    now: "2026-10-02T00:00:00.000Z",
    correction: { last_intent: "not_interested", inbox_bucket: "follow_up", classifier_version: "v3", category: "NOT FOR SALE", reason: "decline" },
  });
  assert.equal(res.ok, true);
  const { patch, filters } = writes[0];
  assert.deepEqual(filters, [["thread_key", THREAD.thread_key], ["updated_at", THREAD.updated_at]]);
  assert.equal(patch.previous_inbox_bucket, "new_replies");
  assert.equal(patch.metadata[CLEANUP_SOURCE].old.last_intent, "unclear");
  assert.equal(patch.metadata[CLEANUP_SOURCE].new.last_intent, "not_interested");
  assert.ok(patch.reason_codes.includes(CLEANUP_SOURCE));
  const second = await applyClassifierCorrection(supabase, { thread: { ...THREAD, metadata: patch.metadata }, source: CLEANUP_SOURCE, correction: {} });
  assert.equal(second.skipped, true);
});

// ── Next contact: the existing waterfall, every gate visible, nothing sent ──

test("next contact refuses DNC, wrong-number history, landlines, prior contact and work/government email", () => {
  const thread = { thread_key: "+16125550111", property_id: "prop-1", master_owner_id: "mo-1" };
  const phones = [
    { phone_e164: "+16125550201", phone_type: "W", best_phone_score: 99, dnc: true },
    { phone_e164: "+16125550202", phone_type: "W", best_phone_score: 90, wrong_number_at: "2026-09-01" },
    { phone_e164: "+16125550203", phone_type: "L", best_phone_score: 80 },
    { phone_e164: "+16125550204", phone_type: "W", best_phone_score: 70 },
    { phone_e164: "+16125550205", phone_type: "W", best_phone_score: 60 },
  ];
  const r = planNextContact({ thread, phones, suppressed_phones: [], active_thread_phones: ["+16125550204"] });
  assert.equal(r.channel, "phone");
  assert.equal(r.candidate, maskPhone("+16125550205"));
  const reasons = Object.fromEntries(r.considered.map((c) => [c.phone, c.reason]));
  assert.equal(reasons[maskPhone("+16125550201")], "suppressed_or_dnc");
  assert.equal(reasons[maskPhone("+16125550202")], "wrong_number_history");
  assert.equal(reasons[maskPhone("+16125550203")], "not_sms_capable");
  assert.equal(reasons[maskPhone("+16125550204")], "already_active_thread");
  assert.match(r.would_send, /queue/, "a phone next contact goes through the queue gates, after approval");

  const emailOnly = planNextContact({ thread, phones: [], emails: [{ email: "someone@agency.state.mn.us" }, { email: "owner@example.com" }] });
  assert.equal(emailOnly.channel, "email");
  assert.match(emailOnly.eligibility, /email sending is OFF/);
  assert.match(emailOnly.would_send, /nothing now/);
  assert.ok(emailOnly.email_considered.some((e) => e.reason === "work_or_government_address_held"));

  const none = planNextContact({ thread, phones: [], emails: [] });
  assert.equal(none.channel, "none");
  assert.match(none.would_send, /no further contact/);
});

// ── Planner end to end on a synthetic snapshot ──────────────────────────────

test("the planner reclassifies with context from OUR outbound and summarizes honestly", async () => {
  const mk = (id, outbound, reply, extra = {}) => ({
    thread: { id, thread_key: `+1612555${id.padStart(4, "0")}`, property_id: `p${id}`, master_owner_id: `mo${id}`, last_intent: "unclear", inbox_bucket: "new_replies", ...extra },
    message_events: [
      { id: `${id}-o`, direction: "outbound", message_body: outbound, created_at: "2026-09-29T15:00:00.000Z" },
      { id: `${id}-i`, direction: "inbound", message_body: reply, created_at: "2026-09-29T15:05:00.000Z", detected_intent: "unclear" },
    ],
    opportunities: [],
  });
  const snapshot = [
    mk("1", "Hey Pat, this is Sam. Is 123 Main St yours?", "Not Pat"),
    mk("2", "Hey Pat, this is Sam. Is 123 Main St yours?", "Sold"),
    mk("3", "Hey Pat, this is Sam. Is 123 Main St yours?", "What's a fair price"),
    mk("4", "Hey Pat, this is Sam. Is 123 Main St yours?", "👍"),
  ];
  const plans = await planNewRepliesCleanup(snapshot, { loadNextContact: async () => ({ channel: "none", why: "test" }) });
  assert.deepEqual(plans.map((p) => p.category), [
    CLEANUP_CATEGORY.WRONG_PERSON,
    CLEANUP_CATEGORY.SOLD,
    CLEANUP_CATEGORY.KEEP,
    CLEANUP_CATEGORY.EMOJI_CLARIFY,
  ]);
  const summary = summarizeCleanup(plans);
  assert.equal(summary.remain_in_new_replies, 2);
  assert.equal(summary.leave_new_replies, 2);
  for (const p of plans) assert.equal(p.provenance.source, CLEANUP_SOURCE);
});

test("categories map from the corrected classification", () => {
  assert.equal(categorizeReply({ classification: { primary_intent: "not_interested" }, body: "No esta ala venta." }), CLEANUP_CATEGORY.NOT_FOR_SALE);
  assert.equal(categorizeReply({ classification: { primary_intent: "not_interested" }, body: "Not intested" }), CLEANUP_CATEGORY.NOT_INTERESTED);
  assert.equal(categorizeReply({ classification: { primary_intent: "not_interested", matched_rule_ids: ["competitor_investor"] }, body: "I buy houses too" }), CLEANUP_CATEGORY.NOT_INTERESTED);
  assert.equal(categorizeReply({ classification: { primary_intent: "reaction_only", matched_rule_ids: ["auto_reply_driving"] }, body: "I'm driving" }), CLEANUP_CATEGORY.AUTO_REPLY);
  assert.equal(categorizeReply({ classification: { primary_intent: "reaction_only", matched_rule_ids: ["noise_single_character"] }, body: "g" }), CLEANUP_CATEGORY.NOISE);
  assert.equal(categorizeReply({ classification: { primary_intent: "reaction_only" }, body: "ok", }, ), CLEANUP_CATEGORY.AUTO_REPLY);
  assert.equal(categorizeReply({ classification: { primary_intent: "acknowledgement" }, body: "ok", open_engagement: true }), CLEANUP_CATEGORY.KEEP, "an earlier open question keeps it");
  assert.equal(categorizeReply({ classification: { primary_intent: "who_is_this" }, body: "Who is this?" }), CLEANUP_CATEGORY.KEEP);
  assert.equal(categorizeReply({ classification: { primary_intent: "unclear" }, body: "I am" }), CLEANUP_CATEGORY.OTHER_AMBIGUOUS);
});

test("the evaluation export and the regression text are de-identified and deterministic", () => {
  const pair = deidentifyPair({
    previous_outbound: "Hey Jamie, this is Alex. Is 4130 Aldrich Ave N yours? Call 612-555-0199 or jamie@example.com",
    reply: "Not Jamie",
    names: ["Jamie", "Alex"],
  });
  assert.equal(/Jamie|Alex|4130|Aldrich|612|example\.com/.test(pair.previous_outbound + pair.reply), false, JSON.stringify(pair));
  assert.match(pair.reply, /^Not <NAME_\d>$/);
  const rows = [
    { thread_id: "b", current_classification: "unclear", correct_classification: "wrong_number", category: "WRONG PERSON", apply: ["write_reclassification"], _texts: { previous_outbound: "Hey Jamie, this is Alex.", reply: "Not Jamie" } },
    { thread_id: "a", current_classification: "unclear", correct_classification: "sold_property", category: "SOLD", apply: [], _texts: { previous_outbound: "Hi Kim, this is Lee.", reply: "Sold" } },
  ];
  const out = buildEvaluationExport(rows, { namesFor: () => ["Jamie", "Alex", "Kim", "Lee"] });
  assert.deepEqual(out.map((r) => r.example_id), ["nr20261001-a", "nr20261001-b"]);
  assert.equal(JSON.stringify(out).includes("Jamie"), false);
  assert.deepEqual(buildEvaluationExport(rows, { namesFor: () => ["Jamie", "Alex", "Kim", "Lee"] }), out, "deterministic");
});
