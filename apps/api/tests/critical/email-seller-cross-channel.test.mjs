/**
 * ONE SELLER BRAIN, TWO TRANSPORTS (§3–6, §17–19, §96–97, §100, §109).
 *
 * Seller email runs the SAME orchestrator as seller SMS. These tests pin:
 *   - parity: every phrase yields identical intent, facts, stage and next
 *     action on both channels (one fact/state model),
 *   - transport: an email reply goes to email_queue, never send_queue; the
 *     SMS path is unchanged,
 *   - cross-channel stop: an email reply cancels pending SMS follow-ups (by the
 *     SMS thread key) and pending seller email; an SMS reply supersedes a
 *     scheduled email at dispatch (the 9:59:59 race),
 *   - channel policy: SMS opt-out does not license email; "email me instead"
 *     does; an opt-out by email suppresses the address.
 */
import "../helpers/critical-test-environment.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { processSellerInboundMessage, __setSellerInboundOrchestratorDeps, __resetSellerInboundOrchestratorDeps } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { makeSellerOrchestrationSupabase } from "../helpers/seller-orchestration-test-supabase.mjs";
import { makeEmailDb, BRAND_SENDER, SEND_ENV, makeTransport } from "../helpers/email-db-mock.mjs";
import { ingestInboundEmail } from "@/lib/domain/email/email-inbound.js";
import { handleSellerEmail, revalidateSellerEmail } from "@/lib/domain/email/email-seller-channel.js";
import { runEmailDispatch } from "@/lib/domain/email/email-dispatch.js";
import { cancelPendingSellerEmails } from "@/lib/domain/email/email-seller-cancel.js";

const TEMPLATES = JSON.parse(fs.readFileSync(new URL("../fixtures/stage1-template-catalog.json", import.meta.url), "utf8"));
const SMS_KEY = "+16127433952"; // approved internal test phone (internal_only autopilot may queue)
afterEach(() => __resetSellerInboundOrchestratorDeps());

function context(stage) {
  return { found: true, ids: { master_owner_id: "mo-x", property_id: "prop-x", prospect_id: "pros-x", phone_item_id: "ph-x" }, summary: { conversation_stage: stage, seller_stage: stage, property_address: "123 Main St", seller_first_name: "David", language_preference: "English" } };
}

async function runBrain(message, stage, channel) {
  const smsRows = [];
  const emails = [];
  const followups = [];
  const smsCancels = [];
  const emailCancels = [];
  const supabase = makeSellerOrchestrationSupabase({ templates: TEMPLATES, insertedQueueRows: smsRows });
  __setSellerInboundOrchestratorDeps({
    getSupabaseClient: () => supabase,
    patchUniversalLeadState: async ({ patch }) => ({ ok: true, patch, dry_run: true }),
    emitAutomationEvent: async () => ({ ok: true }),
    persistInboundIntelligenceSnapshot: async () => ({ ok: true }),
    persistSellerContactReferral: async () => ({ ok: true, skipped: true }),
    executeReferralAutomation: async () => ({ ok: true, skipped: true }),
    scheduleFollowUp: async (intent) => { followups.push({ channel: "sms", intent }); return { ok: true, followup_created: true } },
    cancelPendingFollowUpsForThread: async (a) => { smsCancels.push(a.thread_key); return { ok: true, cancelled: 1 } },
    cancelPendingSellerEmails: async (a) => { emailCancels.push(a); return { ok: true, cancelled: 0 } },
  });
  const r = await processSellerInboundMessage({
    message, threadKey: SMS_KEY, propertyId: "prop-x", prospectId: "pros-x", ownerId: "mo-x", phoneId: "ph-x",
    context: context(stage), inboundFrom: channel === "sms" ? SMS_KEY : "", inboundTo: channel === "sms" ? "+16125550100" : "",
    inboundEventId: `${channel}:evt-1`, inboundReceivedAt: new Date().toISOString(), stageBefore: stage, autoReplyMode: "internal_only", supabaseClient: supabase,
    ...(channel === "email" ? {
      channel: "email",
      emailReplyImpl: async (a) => { emails.push(a); return { ok: true, queue_row_id: "eq-1", queue_item_id: "eq-1" } },
      emailFollowUpImpl: async (a) => { followups.push({ channel: "email", ...a }); return { ok: true, followup_created: true } },
      channelSuppressionCheck: async () => ({ suppressed: false, reason: "none" }),
    } : {}),
  });
  return { r, smsRows, emails, followups, smsCancels, emailCancels };
}

const view = (r) => ({
  intent: r.classification?.primary_intent || null,
  asking: r.fact_extraction?.facts?.asking_price?.value?.amount ?? null,
  facts: Object.keys(r.fact_extraction?.facts || {}).sort(),
  stage_after: r.decision?.stage_after || null,
  next: r.decision?.next_best_action || r.decision?.next_action || null,
  use_case: r.execution?.selected_template?.use_case || null,
  reply: r.execution?.rendered_message_text || null,
});

// §96 — the exact pattern.
test("§96 seller at S2 answers an SMS question BY EMAIL: facts, stage, next question, email reply, SMS follow-up cancelled", async () => {
  const { r, smsRows, emails, smsCancels, emailCancels } = await runBrain("Yes, but I'd need around $315k.", "offer_interest", "email");
  const v = view(r);
  assert.equal(v.intent, "asking_price_provided");
  assert.equal(v.asking, 315000, "asking price captured in the canonical fact store");
  assert.equal(v.stage_after, "property_condition", "canonical stage advances");
  assert.equal(v.use_case, "condition_probe", "next unresolved = property condition");
  assert.doesNotMatch(v.reply, /asking|what (would|do) you (want|need)|price/i, "never re-asks the price");
  assert.equal(emails.length, 1, "reply went through the email transport");
  assert.equal(smsRows.length, 0, "no SMS was queued");
  assert.deepEqual(smsCancels, [SMS_KEY], "pending SMS follow-ups cancelled on the seller's SMS thread");
  assert.equal(emailCancels.length, 1);
  assert.equal(emailCancels[0].reason, "seller_replied_email");
});

test("SMS path unchanged: same message by SMS queues to send_queue, not email", async () => {
  const { r, smsRows, emails, emailCancels } = await runBrain("Yes, but I'd need around $315k.", "offer_interest", "sms");
  assert.equal(view(r).use_case, "condition_probe");
  assert.equal(smsRows.length, 1);
  assert.equal(emails.length, 0);
  assert.equal(emailCancels[0].reason, "seller_replied_sms", "an SMS reply also withdraws pending seller email");
});

// §100 — phrase matrix: identical understanding on both channels.
const MATRIX = [
  ["I am", "ownership_check"],
  ["I am and I am selling it now", "ownership_check"],
  ["315", "asking_price"],
  ["$315k firm", "asking_price"],
  ["Not trying to sale", "offer_interest"],
  ["Property needs everything", "property_condition"],
  ["Email me instead", "offer_interest"],
  ["Stop texting me", "offer_interest"],
  ["Send me the contract", "offer"],
];
for (const [phrase, stage] of MATRIX) {
  test(`§100 parity — "${phrase}" (${stage}) is understood identically by SMS and email`, async () => {
    const sms = await runBrain(phrase, stage, "sms");
    const email = await runBrain(phrase, stage, "email");
    const a = view(sms.r);
    const b = view(email.r);
    assert.deepEqual({ ...b, reply: undefined }, { ...a, reply: undefined }, "one fact/state model");
    assert.equal(b.reply, a.reply, "same words chosen");
    assert.equal(email.smsRows.length, 0, "email channel never writes send_queue");
    if (a.reply) assert.equal(email.emails.length, 1)
  });
}

// ── Email Command integration (inbound → seller brain → email_queue → dispatch) ──

function sellerSeed(extra = {}) {
  return {
    system_control: [{ key: "email_enabled", value: "true" }],
    email_senders: [{ ...BRAND_SENDER }],
    emails: [{ master_owner_id: "mo-x", email_normalized: "david@example.com", owner_display_name: "David Larson", email_role: "primary", is_best_email_for_owner: true }],
    inbox_thread_state: [{ thread_key: SMS_KEY, master_owner_id: "mo-x", prospect_id: "pros-x", property_id: "prop-x", seller_stage: "offer_interest", lifecycle_stage: "offer_interest", contactability_status: "contactable", is_suppressed: false, seller_display_name: "David Larson", last_outbound_at: "2026-09-29T14:02:00Z", last_inbound_at: null }],
    properties: [{ property_id: "prop-x", property_address_full: "123 Main St, Dallas, TX 75201" }],
    ...extra,
  };
}

function brainWith(result) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (typeof result === "function") return result(args);
    return result;
  };
  return { calls, fn };
}

test("inbound seller email resolves to the same seller/property and runs the seller brain with the SMS thread key", async () => {
  const db = makeEmailDb(sellerSeed());
  const brain = brainWith(async (args) => {
    const q = await args.emailReplyImpl({ rendered_message_text: "Thanks David. Is anyone living there right now, and does it need any major repairs?", selected_use_case: "condition_probe", selected_template: { template_id: "tpl-cond" }, decision: { audit_reason: "asking_price_provided" }, language: "English" });
    return { ok: true, classification: { primary_intent: "asking_price_provided" }, execution: { queued: q.ok, automation_decision: {} } };
  });
  const res = await ingestInboundEmail({ MessageId: "<m1@gmail.com>", From: { Name: "David Larson", Address: "David@Example.com" }, To: [{ Address: "ryan@reivesti.com" }], Subject: "Re: 123 Main St", RawTextBody: "Yes, but I'd need around $315k.\n\nOn Mon, Sep 28, 2026 Ryan wrote:\n> Would you consider an offer?", SentAtDate: "2026-09-29T15:41:00Z" }, { supabase: db, handleSellerEmail, processSeller: brain.fn, notify: async () => ({}) });
  assert.equal(res.category, "seller");
  assert.equal(res.resolution, "seller_graph");
  const args = brain.calls[0];
  assert.equal(args.threadKey, SMS_KEY, "seller brain runs on the SMS conversation");
  assert.equal(args.ownerId, "mo-x");
  assert.equal(args.propertyId, "prop-x");
  assert.equal(args.channel, "email");
  assert.equal(args.message, "Yes, but I'd need around $315k.", "quoted history stripped before understanding");
  const q = db.state.email_queue[0];
  assert.equal(q.source, "seller");
  assert.equal(q.to_email, "david@example.com");
  assert.equal(q.thread_id, db.state.email_threads[0].id);
  assert.match(q.text_body, /Hi David,/);
  assert.match(q.subject, /^Re: 123 Main St/);
  assert.equal(db.state.email_threads[0].sms_thread_key, SMS_KEY);
  // replay of the same inbound is ignored
  const again = await ingestInboundEmail({ MessageId: "<m1@gmail.com>", From: { Address: "david@example.com" }, RawTextBody: "Yes" }, { supabase: db, handleSellerEmail, processSeller: brain.fn });
  assert.equal(again.duplicate, true);
  assert.equal(brain.calls.length, 1);
});

test("§97 race: scheduled seller email due 10:00, seller TEXTS at 9:59:59 → dispatch supersedes it; seller never gets the stale question", async () => {
  const db = makeEmailDb(sellerSeed());
  db.state.email_threads.push({ id: "th-s", thread_key: "seller:mo-x:prop-x", category: "seller", sms_thread_key: SMS_KEY, automation_state: "active", resolution_status: "resolved", reply_token: "bbbbbbbbbbbbbbbb", counterparty_email: "david@example.com", master_owner_id: "mo-x", property_id: "prop-x", inbound_count: 0, outbound_count: 0, attachment_count: 0 });
  db.state.email_queue.push({ id: "eq-f", queue_key: "seller_followup:email:th-s:nudge:2026-09-30", queue_status: "scheduled", scheduled_for: "2026-09-30T15:00:00Z", created_at: "2026-09-28T15:00:00Z", to_email: "david@example.com", subject: "Re: 123 Main St", text_body: "Just checking back", html_body: "<p>Just checking back</p>", thread_id: "th-s", source: "seller", source_ref: "followup:th-s:nudge", action_key: "seller.followup", sequence: 2, approval_status: "not_required", master_owner_id: "mo-x", property_id: "prop-x", reason: { sms_thread_key: SMS_KEY } });
  db.state.inbox_thread_state[0].last_inbound_at = "2026-09-30T14:59:59Z";
  const tx = makeTransport();
  const s = await runEmailDispatch({ now: Date.parse("2026-09-30T15:00:05Z") }, { supabase: db, send: tx.send, env: SEND_ENV, notify: async () => ({}) });
  assert.equal(tx.calls.length, 0);
  assert.equal(s.superseded, 1);
  assert.equal(db.state.email_queue[0].cancel_reason, "seller_replied_sms");
});

test("an SMS reply withdraws pending seller email immediately (orchestrator hook)", async () => {
  const db = makeEmailDb();
  db.state.email_queue.push({ id: "e1", queue_key: "k1", queue_status: "scheduled", source: "seller", master_owner_id: "mo-x", property_id: "prop-x", to_email: "a@b.com", subject: "s" });
  db.state.email_queue.push({ id: "e2", queue_key: "k2", queue_status: "scheduled", source: "closing", master_owner_id: "mo-x", property_id: "prop-x", to_email: "t@t.com", subject: "s" });
  const r = await cancelPendingSellerEmails({ master_owner_id: "mo-x", property_id: "prop-x", reason: "seller_replied_sms", supabase: db });
  assert.equal(r.cancelled, 1);
  assert.equal(db.state.email_queue[0].queue_status, "superseded");
  assert.equal(db.state.email_queue[1].queue_status, "scheduled", "closing email untouched");
});

test("channel policy: SMS opt-out does not license email automation; 'email me instead' does", async () => {
  const db = makeEmailDb(sellerSeed());
  db.state.inbox_thread_state[0].contactability_status = "opted_out";
  let check = null;
  const brain = brainWith(async (args) => { check = await args.channelSuppressionCheck({}); return { ok: true, classification: { primary_intent: "unclear" }, execution: { automation_decision: {} } } });
  await ingestInboundEmail({ MessageId: "<p1@x>", From: { Address: "david@example.com" }, Subject: "house", RawTextBody: "What would you pay?" }, { supabase: db, handleSellerEmail, processSeller: brain.fn });
  assert.equal(check.suppressed, true);
  assert.equal(check.reason, "sms_opt_out_blocks_email_automation");

  await ingestInboundEmail({ MessageId: "<p2@x>", From: { Address: "david@example.com" }, Subject: "house", RawTextBody: "Stop texting me. Email me instead." }, { supabase: db, handleSellerEmail, processSeller: brain.fn });
  assert.equal(db.state.email_threads[0].contact_preference, "email");
  assert.equal(check.suppressed, false, "explicit email preference permits email");
});

test("opt-out received by email suppresses that address; later seller email automation is refused", async () => {
  const db = makeEmailDb(sellerSeed());
  const brain = brainWith({ ok: true, classification: { primary_intent: "opt_out" }, execution: { automation_decision: {} } });
  await ingestInboundEmail({ MessageId: "<o1@x>", From: { Address: "david@example.com" }, Subject: "stop", RawTextBody: "Please remove me. Stop contacting me." }, { supabase: db, handleSellerEmail, processSeller: brain.fn });
  const sup = db.state.email_suppression.find((s) => s.email_address === "david@example.com");
  assert.ok(sup && sup.is_active);
  assert.equal(sup.reason, "opt_out");
});

test("email bounce stops repeated seller follow-up (suppression gate at dispatch)", async () => {
  const db = makeEmailDb(sellerSeed({ email_suppression: [{ email_address: "david@example.com", reason: "hard_bounce", is_active: true }] }));
  db.state.email_threads.push({ id: "th-s", thread_key: "seller:mo-x:prop-x", category: "seller", sms_thread_key: SMS_KEY, automation_state: "active", resolution_status: "resolved", reply_token: "cccccccccccccccc", inbound_count: 0, outbound_count: 0, attachment_count: 0 });
  db.state.email_queue.push({ id: "eq-b", queue_key: "kb", queue_status: "scheduled", scheduled_for: "2026-09-30T15:00:00Z", created_at: "2026-09-30T14:00:00Z", to_email: "david@example.com", subject: "Re: x", text_body: "t", thread_id: "th-s", source: "seller", action_key: "seller.followup", sequence: 2, approval_status: "not_required" });
  const tx = makeTransport();
  await runEmailDispatch({ now: Date.parse("2026-09-30T15:01:00Z") }, { supabase: db, send: tx.send, env: SEND_ENV, notify: async () => ({}) });
  assert.equal(tx.calls.length, 0);
  assert.equal(db.state.email_queue[0].cancel_reason, "recipient_suppressed");
});

test("revalidator: conversation closed / opted out cancels a pending seller email", async () => {
  const db = makeEmailDb(sellerSeed());
  db.state.inbox_thread_state[0].lifecycle_stage = "closed";
  const r = await revalidateSellerEmail(db, { created_at: "2026-09-30T10:00:00Z", reason: { sms_thread_key: SMS_KEY } }, { thread: { sms_thread_key: SMS_KEY } });
  assert.equal(r.state, "cancelled");
});
