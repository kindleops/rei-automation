import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionBoard,
  buildClosingModelEvents,
  buildEmailEvents,
  buildFollowUpEvents,
  buildOfferEvents,
  buildQueueEvents,
  buildWorkflowEvents,
  contactWindowFor,
  decorateEvent,
  dedupeEvents,
  eventState,
  followUpOutcome,
  getCalendarTimeline,
  normThreadKey,
  telemetryFor,
} from "@/lib/domain/calendar/calendar-timeline-service.js";
import { deriveClosingExecution } from "@/lib/domain/closings/closing-execution-model.js";
import { closingScenarios } from "../fixtures/closing-execution-scenarios.mjs";

/**
 * CALENDAR 3.0 (desk contract). Every rule is one the production data of
 * 2026-09-30 proved necessary; the rows mirror real shapes.
 */

const NOW = Date.parse("2026-09-30T12:20:00Z"); // 7:20 AM CDT
const CT = "America/Chicago";

/* ── follow-up outcomes: read from the thread's own message clock ── */

test("a follow-up whose time passed is completed when a message went out after it", () => {
  const at = Date.parse("2026-09-28T15:13:20.821Z");
  assert.equal(followUpOutcome({ at, now: NOW, lastOutbound: "2026-09-28T15:14:23.499Z", lastInbound: "2026-09-28T14:55:12Z" }).state, "completed");
  // the trigger inbound lands seconds after the brain's stamp — not "wrote again"
  assert.equal(followUpOutcome({ at, now: NOW, lastOutbound: "2026-09-28T15:00:00Z", lastInbound: "2026-09-28T15:13:33Z" }).state, "not_acted");
  assert.equal(followUpOutcome({ at, now: NOW, lastOutbound: null, lastInbound: "2026-09-29T10:00:00Z" }).state, "superseded");
  assert.equal(followUpOutcome({ at: NOW + 60_000, now: NOW }).state, "upcoming");
});

test("prod shape: 'reply due' markers that were answered are history, not attention", () => {
  const rows = [
    // +16122351065 — seller 2:39 PM, reply out 2:40 PM
    { thread_key: "+16122351065", next_action: "", next_action_at: "2026-09-28T19:39:16.555Z", last_inbound_at: "2026-09-28T19:39:20.111Z", last_outbound_at: "2026-09-28T19:40:23.535Z" },
    // +16125886543 — seller 3:33 PM, nothing went out
    { thread_key: "+16125886543", next_action: "", next_action_at: "2026-09-28T20:33:29.030Z", last_inbound_at: "2026-09-28T20:33:36.437Z", last_outbound_at: "2026-09-28T20:23:23.201Z" },
  ];
  const phone = buildFollowUpEvents(rows, { now: NOW });
  assert.deepEqual(phone.map((e) => e.links.thread_key), ["+16125886543"], "the answered one is not an event for the phone");
  assert.equal(phone[0].title, "Reply due");
  assert.equal(phone[0].status, "not_acted");
  assert.ok(phone[0].attention);
  const desk = buildFollowUpEvents(rows, { now: NOW, history: true, tz: CT });
  const done = desk.find((e) => e.links.thread_key === "+16122351065");
  assert.equal(done.status, "completed");
  assert.equal(done.attention, false);
  assert.equal(done.history_only, true);
  assert.match(done.reason, /went out Sep 28 2:40 PM/);
});

test("thread keys join as E.164: a suppressed deal stored as 10 digits hides its follow-up", () => {
  assert.equal(normThreadKey("8323258938"), "+18323258938");
  assert.equal(normThreadKey("18323258938"), "+18323258938");
  assert.equal(normThreadKey("+18323258938"), "+18323258938");
  const people = new Map([[normThreadKey("8323258938"), { opportunity_status: "suppressed" }]]);
  const out = buildFollowUpEvents([{ thread_key: "+18323258938", next_action: "schedule_follow_up", follow_up_at: "2026-10-11T14:13:00.537Z" }], { now: NOW, people });
  assert.equal(out.length, 0);
});

test("the queue row owns a follow-up: a thread mirror of a CANCELLED row is cancelled, never upcoming", () => {
  const queue = buildQueueEvents([{
    id: "q1", thread_key: "+16122232473", queue_status: "cancelled", message_type: "followup", source: "seller_inbound_orchestrator",
    scheduled_for: "2026-10-30T04:28:01.614Z", failed_reason: "not_interested", followup_reason: "nurture_followup:not_interested",
  }], { tz: CT, now: NOW, history: true });
  const thread = buildFollowUpEvents([{ thread_key: "+16122232473", next_action: "schedule_follow_up", follow_up_at: "2026-10-30T04:28:01.221Z", next_action_at: "2026-10-30T04:28:01.503Z" }], { now: NOW, history: true });
  const events = dedupeEvents([...queue, ...thread]);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "send_queue");
  assert.equal(events[0].status, "cancelled");
  assert.equal(events[0].type, "seller_follow_up");
  assert.equal(events[0].detail.followup_reason, "Nurture follow-up after “not interested”");
  assert.equal(events[0].history_only, true, "the phone never receives it");
  // Without history the cancelled row is not built at all.
  assert.equal(buildQueueEvents([{ id: "q1", queue_status: "cancelled", message_type: "followup", scheduled_for: "2026-10-30T04:28:01Z" }], { tz: CT, now: NOW }).length, 0);
});

test("a message YOU scheduled is distinguished from a follow-up automation planned", () => {
  const out = buildQueueEvents([
    { id: "m", thread_key: "+1", queue_status: "scheduled", message_type: "manual_scheduled_reply", source: "inbox_bulk_follow_up", scheduled_for: "2026-10-01T15:00:00Z" },
    { id: "f", thread_key: "+2", queue_status: "scheduled", message_type: "followup", source: "seller_inbound_orchestrator", scheduled_for: "2026-10-01T15:00:00Z" },
  ], { tz: CT, now: NOW });
  const m = out.find((e) => e.id === "queue:m");
  const f = out.find((e) => e.id === "queue:f");
  assert.equal(m.type, "scheduled_message");
  assert.equal(m.owner, "system", "the queue has the ball");
  assert.equal(m.manual, true, "…but you scheduled it");
  assert.equal(decorateEvent(m, { tz: CT, now: NOW }).lane, "manual");
  assert.equal(f.type, "seller_follow_up");
  assert.equal(f.owner, "system");
  assert.equal(f.detail.scheduled_by, "Seller Conversation (inbound orchestrator)");
});

test("a 'reply due' the system attempted — and the send was blocked — is ONE fact, named by the queue row", () => {
  const thread = buildFollowUpEvents([{ thread_key: "+14047518576", next_action: "", next_action_at: "2026-09-26T03:52:14.738Z", last_inbound_at: "2026-09-26T03:52:19.365Z", last_outbound_at: "2026-09-24T00:05:58Z" }], { now: NOW, history: true });
  const queue = buildQueueEvents([{ id: "b1", thread_key: "+14047518576", queue_status: "blocked_sender_number", blocked_reason: "blocked_sender_number", message_type: "Follow-Up", source: "auto_reply", scheduled_for: "2026-09-26T03:53:14.810Z" }], { tz: CT, now: NOW, history: true });
  const out = dedupeEvents([...thread, ...queue]);
  assert.deepEqual(out.map((e) => e.id), ["queue:b1"]);
  assert.equal(out[0].title, "Auto-reply");
  assert.equal(out[0].reason, "blocked_sender_number");
});

test("a live campaign day names its next queued send (the queue's schedule, not a forecast)", () => {
  const rows = [
    { id: "a", campaign_id: "dal", queue_status: "delivered", scheduled_for: "2026-09-30T13:40:00Z" },
    { id: "b", campaign_id: "dal", queue_status: "queued", scheduled_for: "2026-09-30T12:50:00Z" },
    { id: "c", campaign_id: "dal", queue_status: "queued", scheduled_for: "2026-09-30T12:45:00Z" },
  ];
  const [g] = buildQueueEvents(rows, { tz: CT, now: NOW, campaigns: new Map([["dal", { name: "Dallas", status: "active" }]]) });
  assert.equal(g.detail.next_send_at, "2026-09-30T12:45:00.000Z");
  const t = telemetryFor([decorateEvent(g, { tz: CT, now: NOW })], [], { now: NOW, today: "2026-09-30", tz: CT });
  assert.equal(t.next_system.at, "2026-09-30T12:45:00.000Z");
});

/* ── contact window vs planned action, in the SELLER's zone ── */

test("contact window: planned 7:15 AM CT → earliest send 8:00 AM CT", () => {
  const at = Date.parse("2026-10-01T12:15:00Z"); // 7:15 CDT
  const w = contactWindowFor(at, CT, { now: NOW });
  assert.equal(w.planned_within, false);
  assert.equal(w.earliest_at, "2026-10-01T13:00:00.000Z");
  assert.equal(w.deferred, true);
  assert.equal(w.abbr, "CT");
});

test("contact window: ET after 9 PM rolls to 8 AM the next local day (midnight boundary)", () => {
  const at = Date.parse("2026-10-02T03:59:00Z"); // 11:59 PM EDT Oct 1
  const w = contactWindowFor(at, "America/New_York", { now: NOW });
  assert.equal(w.earliest_at, "2026-10-02T12:00:00.000Z"); // 8:00 EDT Oct 2
});

test("contact window: MT, PT and Arizona (no DST) resolve their own 8 AM", () => {
  assert.equal(contactWindowFor(Date.parse("2026-10-01T12:00:00Z"), "America/Denver", { now: NOW }).earliest_at, "2026-10-01T14:00:00.000Z");
  assert.equal(contactWindowFor(Date.parse("2026-10-01T12:00:00Z"), "America/Los_Angeles", { now: NOW }).earliest_at, "2026-10-01T15:00:00.000Z");
  // Phoenix is UTC-7 all year: 8 AM = 15:00Z in July and in January.
  assert.equal(contactWindowFor(Date.parse("2026-07-01T10:00:00Z"), "America/Phoenix", { now: 0 }).earliest_at, "2026-07-01T15:00:00.000Z");
  assert.equal(contactWindowFor(Date.parse("2027-01-05T10:00:00Z"), "America/Phoenix", { now: 0 }).earliest_at, "2027-01-05T15:00:00.000Z");
});

test("contact window: across DST end (Nov 1 2026) 8 AM CT moves from 13:00Z to 14:00Z", () => {
  const before = contactWindowFor(Date.parse("2026-10-31T11:00:00Z"), CT, { now: 0 });
  const after = contactWindowFor(Date.parse("2026-11-02T11:00:00Z"), CT, { now: 0 });
  assert.equal(before.earliest_at, "2026-10-31T13:00:00.000Z");
  assert.equal(after.earliest_at, "2026-11-02T14:00:00.000Z");
});

test("contact window: a past-due item can only go out from now on; no zone → no guess", () => {
  const w = contactWindowFor(Date.parse("2026-09-29T02:30:00Z"), CT, { now: NOW }); // due 9:30 PM yesterday
  assert.equal(w.earliest_at, "2026-09-30T13:00:00.000Z");
  assert.equal(contactWindowFor(Date.now(), null), null);
});

/* ── campaign days ── */

test("a finished campaign day with failures is done — not 'scheduled', not an alarm", () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, campaign_id: "mpls", queue_status: "delivered", scheduled_for: "2026-09-28T15:00:00Z" })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `f${i}`, campaign_id: "mpls", queue_status: "failed_transport", failed_reason: "delivery_failed", scheduled_for: "2026-09-28T16:00:00Z" })),
  ];
  const [g] = buildQueueEvents(rows, { tz: CT, now: NOW, campaigns: new Map([["mpls", { name: "Minneapolis", status: "active" }]]) });
  assert.equal(g.status, "sent");
  assert.equal(g.actor, "completed");
  assert.equal(g.attention, false);
  assert.equal(g.detail.delivered, 3);
  assert.equal(g.reason, "2 of 5 did not go out");
  const cancelled = buildQueueEvents([{ id: "c", campaign_id: "mpls", queue_status: "cancelled", scheduled_for: "2026-09-28T15:00:00Z" }], { tz: CT, now: NOW, campaigns: new Map([["mpls", { status: "active" }]]) });
  assert.equal(cancelled[0].status, "cancelled");
  const failed = buildQueueEvents([{ id: "x", campaign_id: "mpls", queue_status: "failed", scheduled_for: "2026-09-28T15:00:00Z" }], { tz: CT, now: NOW, campaigns: new Map([["mpls", { status: "active" }]]) });
  assert.equal(failed[0].status, "failed");
  assert.equal(eventState(failed[0]), "completed");
});

/* ── workflow orchestrator ── */

const GRAPH = {
  name: "Seller review escalation",
  nodes: [
    { id: "grace", kind: "wait", label: "Give the team 4 hours", config: { mode: "duration", anchor: "trigger", duration_hours: 4 } },
    { id: "still_open", kind: "condition", label: "Still needs a human?" },
    { id: "escalate", kind: "action", label: "Escalate to operator" },
  ],
  edges: [{ from: "grace", to: "still_open" }, { from: "still_open", to: "escalate", exit: "Open" }],
};
const versions = new Map([["seller_review_escalation:1", { workflow_key: "seller_review_escalation", version: 1, graph: GRAPH }]]);

test("a waiting run is a timer at wake_at, labelled from its PINNED version", () => {
  const run = { id: "r1", workflow_key: "seller_review_escalation", version: 1, state: "waiting", cursor: "grace", wake_at: "2026-09-30T23:32:00Z", context: { event: { at: "2026-09-30T19:32:00Z" }, trigger: { thread_key: "+17637679806", property_id: "273502999", opportunity_id: "+17637679806" } }, started_at: "2026-09-30T19:35:00Z" };
  const [e] = buildWorkflowEvents([run], { now: NOW, versions });
  assert.equal(e.type, "workflow_timer");
  assert.equal(e.start, "2026-09-30T23:32:00.000Z");
  assert.equal(e.title, "Seller review escalation");
  assert.equal(e.subtitle, "Give the team 4 hours");
  assert.deepEqual(e.detail.next_nodes.map((n) => n.label), ["Still needs a human?"]);
  assert.equal(e.detail.duration_hours, 4);
  assert.equal(e.links.opportunity_id, null, "a phone number is not an opportunity id");
  assert.equal(e.attention, false);
  const d = decorateEvent(e, { tz: CT, now: NOW });
  assert.equal(d.kind, "timer");
  assert.equal(d.lane, "workflow");
  assert.equal(d.editable.mode, "read_only");
  assert.match(d.deep_link.path, /^\/workflow-studio\?studio=seller_review_escalation&run=r1&node=grace$/);
});

test("a timer that ran out without the run resuming is WAITING TOO LONG; finished runs are history", () => {
  const stalled = { id: "r2", workflow_key: "seller_review_escalation", version: 1, state: "waiting", cursor: "grace", wake_at: "2026-09-30T11:00:00Z", context: {} };
  const done = { id: "r3", workflow_key: "seller_review_escalation", version: 1, state: "completed", outcome: "escalated", cursor: "escalated", finished_at: "2026-09-29T22:20:45Z", context: {} };
  const [s, h] = buildWorkflowEvents([stalled, done], { now: NOW, versions }).map((e) => decorateEvent(e, { tz: CT, now: NOW }));
  assert.equal(s.attention_category, "waiting_too_long");
  assert.equal(s.state, "overdue");
  assert.equal(h.state, "completed");
  assert.equal(h.reason, "Escalated to the operator");
});

/* ── closings from the Closing Desk model ── */

test("closings project the Closing Desk derivation: timed in the property's zone, date-only stays all-day", () => {
  const now = Date.parse("2026-09-29T15:00:00Z");
  const items = closingScenarios(now).map((s) => deriveClosingExecution({ ...s, now }));
  const events = buildClosingModelEvents(items, { from: "2026-09-01", to: "2026-11-30", today: "2026-09-29" });
  const closings = events.filter((e) => e.type === "closing");
  assert.ok(closings.length > 0);
  for (const e of closings) {
    if (e.all_day) { assert.equal(e.tz, null); assert.match(e.start, /T00:00:00\.000Z$/); }
    else assert.ok(e.tz, "a timed closing carries the property zone");
    assert.equal(e.source, "closing_cases.scheduled_closing_date");
  }
  // Every event keeps a link back to its case.
  assert.ok(events.every((e) => e.links.closing_case_id));
});

test("one closing date is one event: the Closing Desk beats the offer by dedupe key", () => {
  const model = buildClosingModelEvents([{ id: "closing:c1", opportunityId: "opp1", closing: { at: "2026-10-09T00:00:00.000Z", date: "2026-10-09", time: null, tz: null, confirmed: true, past: false }, deadlines: [], state: { tone: "active" } }], { from: "2026-09-01", to: "2026-11-30", today: "2026-09-30" });
  const offer = buildOfferEvents([{ id: "o1", opportunity_id: "opp1", status: "accepted", closing_date: "2026-10-09" }], { from: "2026-09-01", to: "2026-11-30", today: "2026-09-30" });
  const out = dedupeEvents([...offer, ...model]);
  assert.deepEqual(out.filter((e) => e.type === "closing").map((e) => e.source), ["closing_cases.scheduled_closing_date"]);
});

/* ── email ── */

test("a scheduled email while sending is off is WAITING, never a failure", () => {
  const [e] = buildEmailEvents([{ id: "e1", queue_status: "scheduled", scheduled_for: "2026-09-30T10:00:00Z", subject: "Title intro" }], { now: NOW, sendingEnabled: false });
  const d = decorateEvent(e, { tz: CT, now: NOW });
  assert.equal(d.state, "waiting");
  assert.equal(d.attention, false);
});

/* ── state vocabulary, editability, board, telemetry ── */

test("editability: history and system follow-ups are read-only; your message is manual; a closing is reschedulable", () => {
  const base = { links: {}, detail: {}, start: "2026-10-01T15:00:00Z" };
  assert.equal(decorateEvent({ ...base, type: "seller_follow_up", actor: "system", status: "upcoming", owner: "system" }).editable.mode, "read_only");
  assert.equal(decorateEvent({ ...base, type: "scheduled_message", actor: "system", status: "scheduled", owner: "system", manual: true }).editable.mode, "manual");
  assert.equal(decorateEvent({ ...base, type: "scheduled_message", actor: "completed", status: "sent", owner: "system", manual: true }).editable.mode, "read_only");
  assert.equal(decorateEvent({ ...base, type: "closing", actor: "operator", status: "upcoming", owner: "you", app: "closing", links: { closing_case_id: "c" } }).editable.mode, "reschedulable");
});

test("the attention board and the header counts reconcile to the same events", () => {
  const today = "2026-09-30";
  const raw = [
    { id: "a", type: "seller_follow_up", actor: "system", owner: "system", status: "not_acted", attention: true, start: "2026-09-28T20:33:29Z", links: {}, detail: {} },
    { id: "b", type: "campaign_sends", actor: "system", owner: "system", status: "past_due", overdue: true, attention: true, start: "2026-09-29T13:00:00Z", links: {}, detail: {} },
    { id: "c", type: "campaign_window", actor: "system", owner: "system", status: "upcoming", attention: false, start: "2026-09-30T13:00:00Z", end: "2026-10-01T02:00:00Z", links: {}, detail: {} },
    { id: "d", type: "seller_follow_up", actor: "operator", owner: "you", status: "upcoming", attention: false, start: "2026-09-30T20:00:00Z", links: {}, detail: {} },
    { id: "e", type: "seller_follow_up", actor: "completed", owner: "system", status: "completed", attention: false, start: "2026-09-30T12:00:00Z", links: {}, detail: {} },
  ].map((e) => decorateEvent(e, { tz: CT, now: NOW }));
  const attention = raw.filter((e) => e.attention);
  const board = attentionBoard(attention, raw, { today, tomorrow: "2026-10-01", tz: CT });
  assert.deepEqual(board.stale_follow_up, ["a"]);
  assert.deepEqual(board.missed_campaign_schedule, ["b"]);
  assert.deepEqual(board.due_today, ["d"]);
  const t = telemetryFor(raw, attention, { now: NOW, today, tz: CT });
  assert.equal(t.today.total, 2, "the window and your item — the completed one is history");
  assert.equal(t.today.system, 1);
  assert.equal(t.today.you, 1);
  assert.equal(t.attention.total, 2);
  assert.equal(t.next.id, "c");
  assert.equal(t.next_system.id, "c");
});

test("day aggregates bucket by the OPERATOR's day: 11:30 PM CT is the same day in Chicago, the next day in UTC", async () => {
  const { dayAggregates } = await import("@/lib/domain/calendar/calendar-timeline-service.js");
  const late = decorateEvent({ id: "l", type: "seller_follow_up", actor: "system", owner: "system", status: "upcoming", start: "2026-10-01T04:30:00Z", links: {}, detail: {} }, { tz: CT, now: NOW });
  const ct = dayAggregates([late], { from: "2026-09-30", to: "2026-10-01", tz: CT });
  assert.equal(ct["2026-09-30"].total, 1);
  assert.equal(ct["2026-10-01"].total, 0);
  const et = dayAggregates([late], { from: "2026-09-30", to: "2026-10-01", tz: "America/New_York" });
  assert.equal(et["2026-10-01"].total, 1, "12:30 AM ET is already Oct 1");
  // A date-only deadline never moves with the zone.
  const due = decorateEvent({ id: "d", type: "closing_milestone", actor: "operator", owner: "you", status: "upcoming", all_day: true, date: "2026-10-01", start: "2026-10-01T00:00:00.000Z", links: {}, detail: {} }, { tz: CT, now: NOW });
  assert.equal(dayAggregates([due], { from: "2026-09-30", to: "2026-10-01", tz: "Pacific/Honolulu" })["2026-10-01"].total, 1);
});

/* ── the loader: phone contract unchanged, desk contract complete ── */

function fakeDb(tables) {
  return {
    from(table) {
      const rows = tables[table] || [];
      const q = { select: () => q, or: () => q, in: () => q, eq: () => q, gte: () => q, lt: () => q, limit: () => q, order: () => q,
        maybeSingle: async () => ({ data: rows[0] || null, error: null }), single: async () => ({ data: rows[0] || null, error: null }),
        then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej) };
      return q;
    },
  };
}

test("the phone gets its old contract (no history, no desk types); the desk gets the full contract", async () => {
  const db = fakeDb({
    send_queue: [
      { id: "c1", thread_key: "+16122232473", queue_status: "cancelled", message_type: "followup", scheduled_for: "2026-10-05T04:28:01Z" },
      { id: "s1", thread_key: "+15550001111", queue_status: "scheduled", message_type: "manual_scheduled_reply", scheduled_for: "2026-10-01T15:00:00Z", property_address_state: "MN", property_address_zip: "55401" },
    ],
    inbox_thread_state: [
      { thread_key: "+16122351065", next_action: "", next_action_at: "2026-09-28T19:39:16.555Z", last_inbound_at: "2026-09-28T19:39:20.111Z", last_outbound_at: "2026-09-28T19:40:23.535Z" },
    ],
    wf_runs: [{ id: "r1", workflow_key: "seller_review_escalation", version: 1, state: "waiting", cursor: "grace", wake_at: "2026-09-30T23:32:00Z", context: {} }],
    wf_versions: [{ workflow_key: "seller_review_escalation", version: 1, graph: GRAPH }],
    system_control: [{ key: "queue_processor_mode", value: "live" }, { key: "email_enabled", value: "false" }],
  });
  const deps = { supabase: db, now: NOW, getClosingPortfolio: async () => ({ items: [] }) };
  const phone = await getCalendarTimeline({ from: "2026-09-27", to: "2026-10-10", tz: CT }, deps);
  assert.ok(phone.events.every((e) => !e.history_only));
  assert.ok(!phone.events.some((e) => e.type === "workflow_timer"));
  assert.equal(phone.contract, undefined);
  assert.deepEqual(phone.events.map((e) => e.id), ["queue:s1"]);
  const desk = await getCalendarTimeline({ from: "2026-09-27", to: "2026-10-10", tz: CT, view: "desk" }, deps);
  assert.equal(desk.contract, "calendar.desk/v3");
  const ids = desk.events.map((e) => e.id);
  assert.ok(ids.includes("queue:c1"), "cancelled follow-up kept as history");
  assert.ok(ids.includes("wf:r1:wake"), "workflow timer projected");
  const msg = desk.events.find((e) => e.id === "queue:s1");
  assert.equal(msg.contact_window.tz, "America/Chicago", "MN property → Central, from geography");
  assert.equal(msg.state, "upcoming");
  assert.equal(msg.lane, "manual");
  assert.ok(desk.days["2026-09-30"]);
  assert.equal(desk.system.processor, "live");
  assert.equal(desk.system.email_sending, false);
  assert.ok(desk.board && desk.telemetry && desk.definitions);
});
