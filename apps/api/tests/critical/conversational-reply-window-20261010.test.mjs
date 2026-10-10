// ─── conversational-reply-window-20261010.test.mjs ───────────────────────────
// OWNER DECISION 2026-10-10 (binding): replies to a seller who just texted us
// send immediately at any hour; first texts, follow-ups and nurture touches we
// start stay inside the 08:00–21:00 recipient-local window.
//
// Incident shape: Dallas seller texted 9:36pm CT (2026-10-10T02:36Z); the
// auto-reply (template 1009) was queued at 02:36:17Z and re-planned to 08:22
// local by the resume drain. These tests pin both sides of the rule at every
// layer the decision touches.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTACT_WINDOW_BYPASS_IN_SESSION,
  CONVERSATIONAL_REPLY_WINDOW_KEY,
  DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES,
  buildQueueTimeConversationalReplyMetadata,
  evaluateInSessionReply,
  isOutreachTouch,
  loadConversationalReplyWindowMinutes,
  resolveConversationalReplyWindowMinutes,
} from "@/lib/domain/queue/conversational-reply-window.js";
import { planResumeDrain } from "@/lib/domain/queue/resume-drain-policy.js";
import { revalidateBeforeDispatch } from "@/lib/domain/queue/queue-authority.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { loadRunnableSendQueueRows, normalizeSendQueueRow } from "@/lib/supabase/sms-engine.js";
import { extendSupabaseForHealthyCompliance } from "../helpers/compliance-test-harness.js";
import { makeQueueTestRpc, makeSendQueueRowsSupabase } from "../helpers/queue-run-test-harness.js";
import { maybeQueueSellerStageReply } from "@/lib/domain/seller-flow/maybe-queue-seller-stage-reply.js";
import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { createPodioItem, numberField } from "../helpers/test-helpers.js";

// 9:36pm CDT on 2026-10-09 local == 2026-10-10T02:36Z.
const INBOUND_AT = "2026-10-10T02:36:00.000Z";
const QUEUED_AT = "2026-10-10T02:36:17.838Z";
const DISPATCH_AT = "2026-10-10T02:37:23.294Z"; // when the drain re-planned it
const EVT = "0a7fa9fc-f92d-4f6c-8d0c-78a2f1dc53d2";
const SELLER = "+15005550006"; // test number, never a real seller
const SENDER = "+15005550001";

function inSessionReply(over = {}) {
  const { metadata: meta_over, ...rest } = over;
  return {
    id: "crw-reply-1",
    queue_key: `inbound_auto_reply:${EVT}:1009:${SELLER}`,
    queue_id: `inbound_auto_reply:${EVT}:1009:${SELLER}`,
    queue_status: "queued",
    type: "auto_reply",
    message_type: "Follow-Up", // seller-flow replies carry this label; it is not a kind
    timezone: "America/Chicago",
    created_at: QUEUED_AT,
    scheduled_for: "2026-10-10T02:37:17.433Z",
    scheduled_for_utc: "2026-10-10T02:37:17.433Z",
    to_phone_number: SELLER,
    from_phone_number: SENDER,
    thread_key: SELLER,
    seller_first_name: "John",
    template_id: "1009",
    message_body: "Hi John, this is about the house. Who am I speaking with?",
    message_text: "Hi John, this is about the house. Who am I speaking with?",
    source_event_id: EVT,
    inbound_message_id: EVT,
    retry_count: 0,
    max_retries: 3,
    metadata: {
      source: "auto_reply",
      action_type: "autopilot_inbound_reply",
      decision_id: EVT,
      inbound_message_event_id: EVT,
      inbound_received_at: INBOUND_AT,
      selected_template_id: "1009",
      automation_provenance: { template_id: "1009", touch_number: 0 },
      ...(meta_over || {}),
    },
    ...rest,
  };
}

function followUpRow(over = {}) {
  const { metadata: meta_over, ...rest } = over;
  return {
    id: "crw-followup-1",
    queue_key: `acq-followup:${EVT}:s2`,
    queue_status: "queued",
    type: "followup",
    message_type: "Follow-Up",
    timezone: "America/Chicago",
    created_at: QUEUED_AT,
    scheduled_for: QUEUED_AT,
    scheduled_for_utc: QUEUED_AT,
    to_phone_number: SELLER,
    from_phone_number: SENDER,
    thread_key: SELLER,
    seller_first_name: "John",
    template_id: "2001",
    message_body: "Hi John, just following up on the house.",
    source_event_id: EVT,
    metadata: {
      source: "seller_followup_scheduler",
      followup_reason: "s2_no_answer_24h",
      candidate_snapshot: { seller_first_name: "John" },
      inbound_message_event_id: EVT,
      inbound_received_at: INBOUND_AT,
      ...(meta_over || {}),
    },
    ...rest,
  };
}

// ── system_control value (read-only, code default) ──────────────────────────

test("window: system_control conversational_reply_window_minutes, defaulting to 30", async () => {
  assert.equal(CONVERSATIONAL_REPLY_WINDOW_KEY, "conversational_reply_window_minutes");
  assert.equal(DEFAULT_CONVERSATIONAL_REPLY_WINDOW_MINUTES, 30);
  assert.equal(await loadConversationalReplyWindowMinutes({}), 30, "no reader -> code default");
  assert.equal(await loadConversationalReplyWindowMinutes({ getSystemValue: async () => null }), 30);
  assert.equal(await loadConversationalReplyWindowMinutes({ getSystemValue: async () => "45" }), 45);
  assert.equal(await loadConversationalReplyWindowMinutes({ getSystemValue: async () => "junk" }), 30);
  assert.equal(await loadConversationalReplyWindowMinutes({ getSystemValue: async () => { throw new Error("db down"); } }), 30);
  assert.equal(resolveConversationalReplyWindowMinutes("0"), 30);
  assert.equal(resolveConversationalReplyWindowMinutes("100000"), 120, "capped: never 'all night'");
  const keys = [];
  await loadConversationalReplyWindowMinutes({ getSystemValue: async (k) => { keys.push(k); return null; } });
  assert.deepEqual(keys, ["conversational_reply_window_minutes"]);
});

// ── the predicate ───────────────────────────────────────────────────────────

test("predicate: the 9:36pm Dallas auto-reply is in session (inbound-linked, queued 17s after, not a touch)", () => {
  const v = evaluateInSessionReply(inSessionReply(), { now: DISPATCH_AT });
  assert.equal(v.in_session, true);
  assert.equal(v.reason, CONTACT_WINDOW_BYPASS_IN_SESSION);
  assert.equal(v.inbound_message_event_id, EVT);
  assert.ok(v.inbound_age_minutes > 1 && v.inbound_age_minutes < 2);
});

test("predicate: a reply queued 45 minutes after the inbound is NOT in session", () => {
  const late = inSessionReply({ created_at: "2026-10-10T03:21:00.000Z" });
  const v = evaluateInSessionReply(late, { now: "2026-10-10T03:21:30.000Z" });
  assert.equal(v.in_session, false);
  assert.equal(v.reason, "queued_after_session_window");
});

test("predicate: a reply queued in time but dispatched 45 minutes after the inbound is backlog, not in session", () => {
  const v = evaluateInSessionReply(inSessionReply(), { now: "2026-10-10T03:21:00.000Z" });
  assert.equal(v.in_session, false);
  assert.equal(v.reason, "session_window_elapsed_before_dispatch");
});

test("predicate: the window value moves the boundary", () => {
  const late = inSessionReply({ created_at: "2026-10-10T03:21:00.000Z" });
  assert.equal(evaluateInSessionReply(late, { now: "2026-10-10T03:21:30.000Z", window_minutes: 60 }).in_session, true);
});

test("predicate: follow-ups, nurture and campaign touches are never in session", () => {
  assert.equal(isOutreachTouch(followUpRow()), true);
  assert.equal(evaluateInSessionReply(followUpRow(), { now: DISPATCH_AT }).reason, "outreach_touch");
  const nurture = followUpRow({ type: "nurture", queue_key: "nurture:x", metadata: { followup_reason: null, source: "nurture_cadence" } });
  assert.equal(evaluateInSessionReply(nurture, { now: DISPATCH_AT }).in_session, false);
  const campaign = {
    id: "crw-campaign", queue_key: "campaign:abc:1", campaign_target_id: "11111111-1111-4111-8111-111111111111",
    touch_number: 1, created_at: QUEUED_AT, metadata: { inbound_received_at: INBOUND_AT, inbound_message_event_id: EVT },
  };
  assert.equal(evaluateInSessionReply(campaign, { now: DISPATCH_AT }).in_session, false);
  // The bulk "Conversation Restart" shape (manual_scheduled_reply) is outreach.
  const restart = { id: "r", message_type: "manual_scheduled_reply", metadata: { source: "inbox", inbound_message_event_id: EVT, inbound_received_at: INBOUND_AT }, created_at: QUEUED_AT };
  assert.equal(evaluateInSessionReply(restart, { now: DISPATCH_AT }).in_session, false);
});

test("predicate: no inbound linkage, or no inbound time on a non-immediate shape, fails closed", () => {
  const unlinked = inSessionReply({ queue_key: "x", queue_id: "x", source_event_id: null, inbound_message_id: null, metadata: { inbound_message_event_id: null, decision_id: null } });
  assert.equal(evaluateInSessionReply(unlinked, { now: DISPATCH_AT }).reason, "no_inbound_linkage");
  const manual_no_time = { id: "m", metadata: { source: "inbox", inbound_message_event_id: EVT }, created_at: QUEUED_AT };
  assert.equal(evaluateInSessionReply(manual_no_time, { now: DISPATCH_AT }).reason, "inbound_time_unknown");
  // An operator manual reply that carries the inbound id + time IS in session.
  const manual = { id: "m2", metadata: { source: "inbox", inbound_message_event_id: EVT, inbound_received_at: INBOUND_AT }, created_at: QUEUED_AT };
  assert.equal(evaluateInSessionReply(manual, { now: DISPATCH_AT }).in_session, true);
});

test("queue-time stamp: inbound time + contact_window_bypass marker (inbound id + age) when outside the local window", () => {
  const night = buildQueueTimeConversationalReplyMetadata({
    inbound_message_event_id: EVT, inbound_received_at: INBOUND_AT, queued_at: QUEUED_AT, timezone: "America/Chicago",
  });
  assert.equal(night.evaluation.in_session, true);
  assert.equal(night.outside_contact_window, true);
  assert.equal(night.metadata.contact_window_bypass, "in_session_reply");
  assert.equal(night.metadata.contact_window_bypass_inbound_message_event_id, EVT);
  assert.equal(typeof night.metadata.contact_window_bypass_inbound_age_minutes, "number");
  assert.equal(night.metadata.inbound_received_at, INBOUND_AT);
  // Daytime: no bypass marker, the verdict is still recorded.
  const day = buildQueueTimeConversationalReplyMetadata({
    inbound_message_event_id: EVT, inbound_received_at: "2026-10-09T18:00:00.000Z", queued_at: "2026-10-09T18:00:20.000Z", timezone: "America/Chicago",
  });
  assert.equal(day.metadata.contact_window_bypass, undefined);
  assert.equal(day.metadata.conversational_reply.in_session, true);
  // Released from review 45 minutes later: not in session, no marker.
  const late = buildQueueTimeConversationalReplyMetadata({
    inbound_message_event_id: EVT, inbound_received_at: INBOUND_AT, queued_at: "2026-10-10T03:21:00.000Z", timezone: "America/Chicago",
  });
  assert.equal(late.evaluation.in_session, false);
  assert.equal(late.metadata.contact_window_bypass, undefined);
});

// ── resume drain (the layer that re-planned the incident row) ──────────────

test("resume drain: the in-session 9:36pm reply is sent, not re-planned to the morning", () => {
  const now = Date.parse(DISPATCH_AT);
  const [d] = planResumeDrain([inSessionReply()], { now });
  assert.equal(d.action, "send");
  assert.equal(d.reason, "in_session_reply");
  assert.equal(d.scheduled_for_utc, undefined);
});

test("resume drain: a follow-up at 9:36pm is still re-planned into the window", () => {
  const now = Date.parse(DISPATCH_AT);
  const [d] = planResumeDrain([followUpRow({ scheduled_for_utc: "2026-10-10T02:37:00.000Z" })], { now });
  assert.equal(d.action, "replan");
  assert.equal(d.reason, "outside_local_window");
});

test("resume drain: a reply queued 45 minutes after its inbound is re-planned", () => {
  const late = inSessionReply({ created_at: "2026-10-10T03:21:00.000Z", scheduled_for_utc: "2026-10-10T03:21:10.000Z" });
  const [d] = planResumeDrain([late], { now: Date.parse("2026-10-10T03:21:30.000Z") });
  assert.equal(d.action, "replan");
});

// ── revalidateBeforeDispatch ────────────────────────────────────────────────

test("queue authority: in-session lifts only the contact-window blocker", () => {
  assert.deepEqual(revalidateBeforeDispatch({ row: {}, inside_contact_window: false }).blockers, ["outside_contact_window"]);
  assert.equal(revalidateBeforeDispatch({ row: {}, inside_contact_window: false, in_session_reply: true }).ok, true);
  const v = revalidateBeforeDispatch({ row: {}, inside_contact_window: false, in_session_reply: true, suppressed: true, template_governed: false });
  assert.deepEqual(v.blockers, ["suppressed", "template_not_governed"]);
});

// ── pre-claim (runner) ──────────────────────────────────────────────────────

test("pre-claim: the in-session reply is runnable at 9:37pm; a 45-minute-old reply and a follow-up are excluded", async () => {
  const late = inSessionReply({ id: "crw-late", created_at: "2026-10-10T02:00:00.000Z", to_phone_number: "+15005550007", thread_key: "+15005550007", queue_key: "inbound_auto_reply:evt-late:1009:+15005550007", metadata: { inbound_received_at: "2026-10-10T01:52:00.000Z", inbound_message_event_id: "evt-late" } });
  const fu = followUpRow({ to_phone_number: "+15005550008", thread_key: "+15005550008" });
  const result = await loadRunnableSendQueueRows(10, {
    now: DISPATCH_AT,
    stale_lock_recovery_enabled: false,
    supabaseClient: makeSendQueueRowsSupabase([inSessionReply(), late, fu]),
    getSystemValue: async () => null,
    pauseInvalidQueueRow: async (n, p) => ({ ...n, ...p }),
  });
  assert.deepEqual(result.rows.map((r) => r.id), ["crw-reply-1"]);
  const window_skips = result.skipped.filter((s) => s.reason === "outside_local_send_window").map((s) => s.id).sort();
  assert.deepEqual(window_skips, ["crw-followup-1", "crw-late"]);
});

// ── dispatch (process-send-queue) ───────────────────────────────────────────

function dispatchDeps(over = {}) {
  const lock_updates = [];
  const deps = {
    now: DISPATCH_AT,
    claimedLockToken: "lock-crw",
    getSystemValue: async (key) => {
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_execution_mode") return "normal";
      return null;
    },
    loadOutboundNumberByPhone: async (phone_number) => ({
      id: `fleet-${phone_number}`, phone_number, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0,
    }),
    loadCampaignStatus: async () => "active",
    updateQueueRow: async (id, payload) => ({ ok: true, id, payload }),
    updateSendQueueRowWithLock: async (id, lock_token, payload) => {
      lock_updates.push({ id, lock_token, payload });
      return normalizeSendQueueRow({ id, ...payload });
    },
    info: () => {},
    warn: () => {},
    supabase: { from() { throw new Error("unexpected_supabase_access_in_test"); } },
    ...over,
  };
  return { deps, lock_updates };
}

test("dispatch: the in-session 9:36pm-local reply crosses the window now and records why", async () => {
  // provider_message_sid evidence stops the row at the idempotency guard right
  // after the window branch — proof it crossed the window, with no provider call.
  const row = normalizeSendQueueRow(inSessionReply({ lock_token: "lock-crw", is_locked: true, queue_status: "processing", metadata: { provider_message_sid: "SMevidence-crw" } }));
  const { deps, lock_updates } = dispatchDeps();
  const result = await processSendQueueItem(row, deps);
  assert.notEqual(result.reason, "deferred_contact_window");
  assert.equal(result.reason, "idempotency_blocked_sid_exists");
  assert.ok(!lock_updates.some((u) => u.payload?.queue_status === "scheduled"), "never deferred");
  const stamp = lock_updates.find((u) => u.payload?.metadata?.contact_window_bypass === "in_session_reply");
  assert.ok(stamp, "contact_window_bypass recorded on the row");
  assert.equal(stamp.payload.metadata.contact_window_bypass_inbound_message_event_id, EVT);
  assert.ok(stamp.payload.metadata.contact_window_bypass_inbound_age_minutes > 1);
  assert.equal(stamp.payload.metadata.contact_window_bypass_underlying_reason, "outside_local_send_window");
});

test("dispatch: a 45-minute-old reply defers to the window", async () => {
  const row = normalizeSendQueueRow(inSessionReply({ lock_token: "lock-crw", is_locked: true, queue_status: "processing", created_at: "2026-10-10T03:21:00.000Z" }));
  const { deps, lock_updates } = dispatchDeps({ now: "2026-10-10T03:21:30.000Z" });
  const result = await processSendQueueItem(row, deps);
  assert.equal(result.reason, "deferred_contact_window");
  assert.equal(result.final_queue_status, "scheduled");
  assert.ok(!lock_updates.some((u) => u.payload?.metadata?.contact_window_bypass === "in_session_reply"));
});

test("dispatch: a follow-up at 9:36pm defers to the window", async () => {
  const row = normalizeSendQueueRow(followUpRow({ lock_token: "lock-crw", is_locked: true, queue_status: "processing" }));
  const { deps } = dispatchDeps();
  const result = await processSendQueueItem(row, deps);
  assert.equal(result.reason, "deferred_contact_window");
  assert.equal(result.final_queue_status, "scheduled");
});

test("dispatch: an in-session reply to an opted-out seller at 2am is still blocked (compliance, zero provider calls)", async () => {
  // 2026-10-10T07:00Z = 02:00 CDT.
  const row = normalizeSendQueueRow(inSessionReply({
    lock_token: "lock-crw", is_locked: true, queue_status: "processing",
    created_at: "2026-10-10T07:00:05.000Z",
    metadata: { inbound_received_at: "2026-10-10T06:59:40.000Z" },
  }));
  let transport_calls = 0;
  const supabase = extendSupabaseForHealthyCompliance({ rpc: makeQueueTestRpc() }, { suppressed: true });
  const result = await processSendQueueItem(row, {
    now: "2026-10-10T07:00:30.000Z",
    supabase,
    supabaseClient: supabase,
    claimedLockToken: "lock-crw",
    getSystemValue: async (key) => {
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_execution_mode") return "normal";
      return null;
    },
    sendTextgridSMS: async () => { transport_calls += 1; return { sid: "SM_must_never_send" }; },
    selectAvailableTextgridNumber: async () => ({
      ok: true, from_phone_number: SENDER, selected: { id: "tg-1", phone_number: SENDER, market: "dallas" },
    }),
    loadOutboundNumberByPhone: async (phone_number) => ({
      id: `fleet-${phone_number}`, phone_number, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0,
    }),
    loadCampaignStatus: async () => "active",
    updateSendQueueRowWithLock: async (row_id, lock_token, payload) => normalizeSendQueueRow({ ...row, ...payload, id: row_id, lock_token }),
  });
  assert.equal(transport_calls, 0, "TextGrid is never called");
  assert.notEqual(result?.reason, "deferred_contact_window", "the window was crossed — the block is compliance");
  assert.equal(result?.blocked || result?.skipped, true);
  assert.notEqual(result?.sent, true);
  assert.equal(result?.reason, "opted_out_at_send_time");
  assert.equal(result?.final_queue_status, "cancelled");
});

// ── scheduling layer (seller-flow stage reply) ──────────────────────────────


function stageReplyContext() {
  return {
    ids: { master_owner_id: 201, phone_item_id: 401, property_id: 601 },
    items: {
      agent_item: createPodioItem(501, { "latency-neutral-min": numberField(1), "latency-neutral-max": numberField(1) }),
      master_owner_item: createPodioItem(201),
      property_item: createPodioItem(601, { "smart-cash-offer-2": numberField(155000) }),
    },
    summary: { market_timezone: "Central", total_messages_sent: 1, language_preference: "English" },
    recent: {
      touch_count: 1,
      recent_events: [{ direction: "Outbound", metadata: { selected_use_case: "ownership_check", next_expected_stage: SELLER_FLOW_STAGES.OWNERSHIP_CHECK, selected_tone: "Warm" } }],
    },
  };
}

async function queueStageReply({ inbound_received_at, now }) {
  const calls = [];
  const result = await maybeQueueSellerStageReply({
    inbound_from: SELLER,
    context: stageReplyContext(),
    classification: { language: "English", emotion: "calm" },
    message: "Yes, I own it.",
    now,
    contact_window_override: "8AM-9PM CT",
    inbound_received_at,
    extra_queue_context: { inbound_message_event_id: EVT },
    queue_message: async (payload) => { calls.push(payload); return { ok: true, queue_item_id: 1 }; },
  });
  return { result, call: calls[0] };
}

test("scheduling: an in-session 9:36pm reply is not deferred by a restrictive contact-window override", async () => {
  const { result, call } = await queueStageReply({ inbound_received_at: INBOUND_AT, now: QUEUED_AT });
  assert.equal(result.queued, true);
  assert.equal(call.contact_window, "12AM-11:59PM CT");
  assert.ok(String(call.scheduled_for_utc).startsWith("2026-10-10 02:3"), `sends tonight, got ${call.scheduled_for_utc}`);
  assert.equal(call.extra_queue_context.contact_window_bypass, "in_session_reply");
  assert.equal(call.extra_queue_context.contact_window_bypass_inbound_message_event_id, EVT);
  assert.equal(call.extra_queue_context.inbound_received_at, INBOUND_AT);
});

test("scheduling: a reply queued 45 minutes after its inbound keeps the window (rolls to the morning)", async () => {
  const { call } = await queueStageReply({ inbound_received_at: INBOUND_AT, now: "2026-10-10T03:21:00.000Z" });
  assert.equal(call.contact_window, "8AM-9PM CT");
  assert.ok(String(call.scheduled_for_utc).startsWith("2026-10-10 13:"), `morning, got ${call.scheduled_for_utc}`);
  assert.equal(call.extra_queue_context.contact_window_bypass, undefined);
});

test("scheduling: the live seller-flow auto-reply insert stamps the inbound time + in-session verdict", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js", import.meta.url), "utf8");
  assert.match(src, /buildQueueTimeConversationalReplyMetadata\(\{\s*inbound_message_event_id: inboundEventId \|\| null,\s*inbound_received_at: inboundReceivedAt \|\| null,\s*queued_at: now,/);
  assert.match(src, /inbound_message_event_id: inboundEventId \|\| null,\s*\.\.\.conversational_reply\.metadata,/);
});

test("dispatch: an in-session 2am reply carrying code-registry copy is still refused (template_not_in_supabase)", async () => {
  const row = normalizeSendQueueRow(inSessionReply({
    lock_token: "lock-crw", is_locked: true, queue_status: "processing",
    template_id: "local-template:who_is_this",
    created_at: "2026-10-10T07:00:05.000Z",
    metadata: { inbound_received_at: "2026-10-10T06:59:40.000Z", selected_template_id: "local-template:who_is_this" },
  }));
  let transport_calls = 0;
  const supabase = extendSupabaseForHealthyCompliance({ rpc: makeQueueTestRpc() }, { suppressed: false });
  const result = await processSendQueueItem(row, {
    now: "2026-10-10T07:00:30.000Z",
    supabase,
    supabaseClient: supabase,
    claimedLockToken: "lock-crw",
    getSystemValue: async (key) => {
      if (key === "queue_processor_mode") return "live";
      if (key === "queue_execution_mode") return "normal";
      return null;
    },
    sendTextgridSMS: async () => { transport_calls += 1; return { sid: "SM_must_never_send" }; },
    selectAvailableTextgridNumber: async () => ({
      ok: true, from_phone_number: SENDER, selected: { id: "tg-1", phone_number: SENDER, market: "dallas" },
    }),
    loadOutboundNumberByPhone: async (phone_number) => ({
      id: `fleet-${phone_number}`, phone_number, status: "active", health_state: "unverified", daily_limit: 800, messages_sent_today: 0,
    }),
    loadCampaignStatus: async () => "active",
    updateSendQueueRowWithLock: async (row_id, lock_token, payload) => normalizeSendQueueRow({ ...row, ...payload, id: row_id, lock_token }),
  });
  assert.equal(transport_calls, 0, "TextGrid is never called");
  assert.notEqual(result?.reason, "deferred_contact_window");
  assert.equal(result?.reason, "template_not_in_supabase");
  assert.notEqual(result?.sent, true);
});
