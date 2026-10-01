import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  DESK_CONTRACT,
  WRITE_MIN_LEAD_MINUTES,
  buildFollowUpEvents,
  buildQueueEvents,
  campaignRoster,
  dayAggregates,
  decorateEvent,
  getCalendarTimeline,
  telemetryFor,
  writeAuthority,
} from "@/lib/domain/calendar/calendar-timeline-service.js";
import { scenarioDb } from "../fixtures/calendar-timeline-scenarios.mjs";

/**
 * CALENDAR 5.0 (desk contract v5). Each rule comes from the production read
 * of 2026-10-01: an exhausted active campaign that silently had no window,
 * thirteen thread follow-ups on suppressed deals that vanished, a review
 * overdue since Sep 10 that the 14-day lookback hid, and the queue
 * reschedule action that resets ANY row to 'scheduled'.
 */

const NOW = Date.parse("2026-10-01T12:10:00Z"); // 7:10 AM CDT
const CT = "America/Chicago";
const MIN = 60_000;
const H = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

const queueRow = (over = {}) => ({
  id: "q-1", thread_key: "+13055550131", queue_status: "scheduled", message_type: "manual_scheduled_reply", source: "inbox",
  scheduled_for: iso(NOW + 3 * H), property_address_state: "FL", property_address_zip: "33133", seller_display_name: "Evelyn Brooks", ...over,
});
const decorated = (row) => buildQueueEvents([row], { tz: CT, now: NOW, history: true }).map((e) => decorateEvent(e, { tz: CT, now: NOW }))[0];

/* ── write authority: only your still-waiting message, never near its send ── */

test("a message YOU scheduled, still waiting and hours away, can be rescheduled or cancelled through the queue", () => {
  const e = decorated(queueRow());
  assert.equal(e.type, "scheduled_message");
  assert.deepEqual(e.actions, {
    reschedule: { via: "queue.reschedule", queue_id: "q-1", min_lead_minutes: WRITE_MIN_LEAD_MINUTES },
    cancel: { via: "queue.cancel", queue_id: "q-1" },
  });
  assert.equal(e.editable.mode, "reschedulable");
  assert.match(e.editable.how, /same queue action/);
});

test("no write authority close to the send time, or on any row that is not waiting", () => {
  assert.equal(decorated(queueRow({ scheduled_for: iso(NOW + (WRITE_MIN_LEAD_MINUTES - 1) * MIN) })).actions, null, "inside the lead time the dispatcher may hold it");
  for (const queue_status of ["sending", "processing", "held", "blocked_sender_number", "failed_transport", "cancelled", "delivered", "sent"]) {
    const e = decorated(queueRow({ queue_status, sent_at: queue_status === "sent" || queue_status === "delivered" ? iso(NOW - H) : null }));
    assert.equal(e.actions, null, `${queue_status} must never be offered a reschedule (the action resets the row to 'scheduled')`);
  }
});

test("automation's sends are never movable from the calendar — the owning app decides", () => {
  const followUp = decorated(queueRow({ message_type: "followup", source: "seller_inbound_orchestrator" }));
  assert.equal(followUp.type, "seller_follow_up");
  assert.equal(followUp.actions, null);
  assert.equal(followUp.editable.mode, "read_only");
  const auto = decorated(queueRow({ message_type: "Follow-Up", source: "auto_reply" }));
  assert.equal(auto.actions, null);
  assert.equal(writeAuthority({ type: "campaign_window", source: "campaigns.contact_window", start: iso(NOW + 5 * H) }, NOW), null);
});

/* ── campaign send density: the queue's own times, per 30-minute slot ── */

test("a campaign day carries its send density per slot (operator zone) — sent, waiting, failed; cancelled rows never count", () => {
  const rows = [
    { id: "a", campaign_id: "c-1", queue_status: "delivered", scheduled_for: "2026-10-01T13:05:00.000Z", sent_at: "2026-10-01T13:05:04.000Z" }, // 8:05 CT → slot 16
    { id: "b", campaign_id: "c-1", queue_status: "sent", scheduled_for: "2026-10-01T13:20:00.000Z", sent_at: "2026-10-01T13:20:03.000Z" }, // 8:20 → 16
    { id: "c", campaign_id: "c-1", queue_status: "failed_transport", scheduled_for: "2026-10-01T13:40:00.000Z" }, // 8:40 → 17
    { id: "d", campaign_id: "c-1", queue_status: "queued", scheduled_for: "2026-10-01T14:10:00.000Z" }, // 9:10 → 18
    { id: "e", campaign_id: "c-1", queue_status: "cancelled", scheduled_for: "2026-10-01T14:15:00.000Z" },
  ];
  const [g] = buildQueueEvents(rows, { tz: CT, now: NOW, campaigns: new Map([["c-1", { name: "Map area · Minneapolis, MN", status: "active", tz: CT }]]) });
  assert.equal(g.type, "campaign_sends");
  assert.equal(g.detail.slot_minutes, 30);
  assert.deepEqual(g.detail.slots, [[16, 2, 0, 0], [17, 0, 0, 1], [18, 0, 1, 0]]);
});

/* ── follow-ups on suppressed deals: history, never silently dropped ── */

test("a follow-up recorded on a suppressed deal is history on the desk and absent on the phone", () => {
  const people = new Map([["+13053454008", { opportunity_status: "suppressed", seller: "R. Diaz", opportunity_id: "opp-1" }]]);
  const row = { thread_key: "+13053454008", next_action: "schedule_follow_up", follow_up_at: "2026-10-11T14:08:49.120Z", next_action_at: "2026-10-11T14:08:50.143Z", status: "scheduled" };
  assert.equal(buildFollowUpEvents([row], { now: NOW, people }).length, 0, "the phone contract is unchanged");
  const desk = buildFollowUpEvents([row], { now: NOW, people, history: true, tz: CT });
  assert.equal(desk.length, 1, "one event per recorded follow-up time");
  const [e] = desk;
  assert.equal(e.status, "cancelled");
  assert.equal(e.history_only, true);
  assert.equal(e.attention, false);
  assert.match(e.reason, /Not queued — the deal is suppressed/);
  assert.equal(decorateEvent(e, { tz: CT, now: NOW }).state, "cancelled");
});

/* ── the campaign roster: why each campaign has (or has no) window ── */

const campaign = (over = {}) => ({ id: "c-1", name: "Map area · Minneapolis, MN", status: "active", market: null, contact_window_start: "08:00", contact_window_end: "21:00", metadata: { timezone: CT }, ...over });

test("roster: an active campaign with nobody left to text is EXHAUSTED and has no window today", () => {
  const stats = new Map([["c-1", { audience: 0, eligible: 0, held: 0, committed: 0, remaining: 0, scheduled: 0, sent: 9 }]]);
  const [r] = campaignRoster([campaign({ metadata: { timezone: CT, feeder_last: { reason: "cohort_exhausted", at: iso(NOW - 5 * MIN) } } })], { stats, now: NOW });
  assert.equal(r.situation, "exhausted");
  assert.equal(r.window_today, null);
  assert.equal(r.feeder.reason, "cohort_exhausted");
});

test("roster: today's window state comes from the campaign's own zone and window, not the viewed range", () => {
  const stats = new Map([["c-1", { audience: 563, eligible: 503, held: 60, committed: 488, remaining: 15, scheduled: 0, sent: 438 }]]);
  const before = campaignRoster([campaign()], { stats, now: NOW })[0]; // 7:10 AM CT
  assert.equal(before.situation, "window_ahead");
  assert.equal(before.window_today.opens_at, "2026-10-01T13:00:00.000Z");
  assert.equal(before.window_today.closes_at, "2026-10-02T02:00:00.000Z");
  assert.deepEqual(before.counts, { audience: 563, eligible: 503, held: 60, committed: 488, sent: 438, remaining: 15, queued: 0 });
  assert.equal(campaignRoster([campaign()], { stats, now: NOW + 2 * H })[0].situation, "sending");
  assert.equal(campaignRoster([campaign()], { stats, now: Date.parse("2026-10-02T02:30:00Z") })[0].situation, "window_closed");
  // An Eastern campaign's window opens at 8 AM ET = 7 AM CT: already sending at 7:10 AM CT.
  assert.equal(campaignRoster([campaign({ metadata: { timezone: "America/New_York" } })], { stats, now: NOW })[0].situation, "sending");
});

test("roster: a stale scheduled start is MISSED (never running); no zone is stated, not guessed; a halted processor is named", () => {
  const stats = new Map([["c-1", { audience: 146, remaining: 84, held: 62, scheduled: 0 }]]);
  const missed = campaignRoster([campaign({ status: "scheduled", scheduled_for: "2026-09-30T16:11:00Z" })], { stats, now: NOW })[0];
  assert.equal(missed.situation, "missed");
  assert.equal(missed.window_today, null);
  assert.equal(campaignRoster([campaign({ metadata: {} })], { stats, now: NOW })[0].situation, "no_timezone");
  const halted = campaignRoster([campaign()], { stats, now: NOW, system: { processor: "safe", emergency_stop: false } })[0];
  assert.equal(halted.halted, "queue_processor_safe");
});

/* ── day volumes: real activity, history included, cancellations excluded ── */

test("day volumes count what happened and what is ahead — never what was cancelled", () => {
  const day = "2026-10-01";
  const at = "2026-10-01T15:00:00.000Z";
  const events = [
    { start: at, type: "campaign_sends", count: 120, detail: { counts: { cancelled: 20 } }, state: "completed", history: true, lane: "campaign", owner: "system" },
    { start: at, type: "seller_follow_up", state: "upcoming", history: false, lane: "automation", owner: "system" },
    { start: at, type: "seller_follow_up", state: "completed", history: true, lane: "automation", owner: "system" },
    { start: at, type: "seller_follow_up", state: "cancelled", history: true, lane: "automation", owner: "system" },
    { start: at, type: "seller_follow_up", state: "overdue", history: false, lane: "manual", owner: "you", attention: true },
    { start: at, date: day, all_day: true, type: "closing_milestone", state: "upcoming", history: false, lane: "closing", owner: "you" },
  ];
  const d = dayAggregates(events, { from: day, to: day, tz: CT })[day];
  assert.equal(d.texts, 100);
  assert.equal(d.follow_ups, 3, "upcoming + completed + yours; the cancelled one does not count");
  assert.equal(d.operator, 2);
  assert.equal(d.closings, 1);
  assert.equal(d.attention, 1);
  assert.equal(d.total, 6);
  assert.equal(d.completed, 3);
});

/* ── next for you: only when something real waits on you ── */

test("telemetry names the next item that is yours — and nothing when nothing is", () => {
  const base = { history: false, all_day: false, undated: false, state: "upcoming", end: null };
  const sys = { ...base, id: "s", owner: "system", type: "seller_follow_up", title: "Seller follow-up", start: iso(NOW + H) };
  const you = { ...base, id: "y", owner: "you", type: "seller_follow_up", title: "Review seller", start: iso(NOW + 3 * H) };
  assert.equal(telemetryFor([sys], [], { now: NOW, today: "2026-10-01", tz: CT }).next_you, null);
  const t = telemetryFor([sys, you], [], { now: NOW, today: "2026-10-01", tz: CT });
  assert.equal(t.next_you.id, "y");
  assert.equal(t.next_system.id, "s");
});

/* ── through the loader: a review overdue for weeks is still attention ── */

test("loader: a review that is yours stays in attention past the 14-day lookback; the response is the v5 contract", async () => {
  const tables = {
    inbox_thread_state: [{ thread_key: "+19549807015", next_action: "human_review", next_action_at: "2026-09-10T11:59:17.221Z", status: "needs_review", last_inbound_at: "2026-09-10T12:15:33.670Z", last_outbound_at: "2026-09-10T12:01:30.740Z" }],
    acquisition_opportunities: [{ id: "opp-2b3c", primary_thread_key: "+19549807015", seller_display_name: "Seller 7015", opportunity_status: "active", acquisition_stage: "asking_price" }],
    campaigns: [campaign()], campaign_targets: [{ campaign_id: "c-1", target_status: "ready" }], send_queue: [], system_control: [{ key: "queue_processor_mode", value: "live" }],
    wf_runs: [], email_queue: [], seller_offers: [], properties: [],
  };
  const out = await getCalendarTimeline({ from: "2026-09-27", to: "2026-10-31", tz: CT, view: "desk" }, { supabase: scenarioDb(tables), now: NOW, getClosingPortfolio: async () => ({ items: [] }) });
  assert.equal(out.contract, DESK_CONTRACT);
  assert.equal(out.contract, "calendar.desk/v5");
  const review = out.attention.find((e) => e.links.thread_key === "+19549807015");
  assert.ok(review, "the Sep 10 review is attention");
  assert.equal(review.owner, "you");
  assert.equal(review.state, "overdue");
  assert.ok(out.board.overdue.includes(review.id));
  assert.equal(out.source_status.inbox_thread_state_reviews, "ok");
  assert.equal(out.campaigns.length, 1);
  assert.equal(out.campaigns[0].situation, "window_ahead");
  assert.equal(out.authority.write_min_lead_minutes, WRITE_MIN_LEAD_MINUTES);
  assert.ok(out.events.every((e) => "actions" in e && "market" in e), "every desk event states its write authority and market");
});
