import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCampaignEvents,
  buildClosingEvents,
  buildFollowUpEvents,
  buildOpportunityEvents,
  buildQueueEvents,
  collapseSingles,
  dailyPace,
  dedupeEvents,
  localDate,
  zonedInstant,
} from "@/lib/domain/calendar/calendar-timeline-service.js";

/**
 * CALENDAR TIMELINE — the read projection the phone Calendar renders. Every
 * rule here is one the production data proved necessary (2026-09-28).
 */

const NOW = Date.parse("2026-09-28T15:00:00Z"); // 10:00 CDT

test("zone math: wall clock in the campaign's zone, across DST", () => {
  assert.equal(new Date(zonedInstant("2026-09-29", "08:00", "America/Chicago")).toISOString(), "2026-09-29T13:00:00.000Z");
  assert.equal(new Date(zonedInstant("2026-11-02", "08:00", "America/Chicago")).toISOString(), "2026-11-02T14:00:00.000Z");
  assert.equal(localDate(Date.parse("2026-09-29T03:30:00Z"), "America/Chicago"), "2026-09-28");
});

test("campaign sends are ONE group per campaign per day, never a row per message", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, campaign_id: "mpls", queue_status: "scheduled", scheduled_for: new Date(Date.parse("2026-09-29T14:10:00Z") + i * 45_000).toISOString() }));
  const events = buildQueueEvents(rows, { tz: "America/Chicago", now: NOW, campaigns: new Map([["mpls", { name: "Minneapolis", status: "scheduled" }]]) });
  assert.equal(events.length, 1);
  assert.equal(events[0].count, 50);
  assert.equal(events[0].type, "campaign_sends");
  assert.equal(events[0].actor, "system");
});

test("rows of a non-live campaign past their send time are HELD, with the real reason", () => {
  const rows = [{ id: "a", campaign_id: "eg", queue_status: "scheduled", scheduled_for: "2026-09-25T17:10:00Z" }];
  const [e] = buildQueueEvents(rows, { tz: "America/Chicago", now: NOW, campaigns: new Map([["eg", { name: "EG", status: "scheduled" }]]) });
  assert.equal(e.status, "held");
  assert.ok(e.attention);
  assert.match(e.reason, /campaign is scheduled/);
});

test("cancelled sends are not events; many failures collapse into one group", () => {
  const cancelled = buildQueueEvents([{ id: "c", queue_status: "cancelled", scheduled_for: "2026-10-10T12:00:00Z" }], { tz: "America/Chicago", now: NOW });
  assert.equal(cancelled.length, 0);
  const fails = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, queue_status: "failed_transport", failed_reason: "delivery_failed", scheduled_for: "2026-09-23T13:00:00Z", thread_key: `t${i}` }));
  const out = buildQueueEvents(fails, { tz: "America/Chicago", now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "scheduled_message_group");
  assert.equal(out[0].count, 6);
  assert.equal(out[0].detail.members.length, 6);
  assert.equal(collapseSingles(out.slice(0, 0)).length, 0);
});

test("a system follow-up that passed is 'automation has not acted', not an operator overdue", () => {
  const [sys] = buildFollowUpEvents([{ thread_key: "t1", next_action: "schedule_follow_up", follow_up_at: "2026-09-20T12:00:00Z", next_action_at: "2026-09-20T12:00:00Z" }], { now: NOW });
  assert.equal(sys.actor, "system");
  assert.equal(sys.status, "not_acted");
  assert.equal(sys.overdue, false);
  const [op] = buildFollowUpEvents([{ thread_key: "t2", next_action: "human_review", follow_up_at: "2026-09-20T12:00:00Z" }], { now: NOW });
  assert.equal(op.actor, "operator");
  assert.equal(op.overdue, true);
});

test("follow_up_at and next_action_at at the same instant are one event; suppressed threads are none", () => {
  assert.equal(buildFollowUpEvents([{ thread_key: "t", follow_up_at: "2026-10-01T12:00:00Z", next_action_at: "2026-10-01T12:00:01Z" }], { now: NOW }).length, 1);
  assert.equal(buildFollowUpEvents([{ thread_key: "t", is_suppressed: true, follow_up_at: "2026-10-01T12:00:00Z" }], { now: NOW }).length, 0);
});

test("dead / suppressed opportunities are not calendar work", () => {
  const rows = [
    { id: 1, opportunity_status: "suppressed", next_action_due: "2026-10-01T12:00:00Z" },
    { id: 2, opportunity_status: "active", next_action: "human_review", next_action_due: "2026-10-01T12:00:00Z" },
  ];
  const out = buildOpportunityEvents(rows, { now: NOW });
  assert.deepEqual(out.map((e) => e.links.opportunity_id), ["2"]);
  assert.equal(out[0].actor, "operator");
});

test("send windows are in the CAMPAIGN's zone and projected only for the days its real pace needs", () => {
  const c = { id: "mpls", name: "Minneapolis", status: "scheduled", scheduled_for: "2026-09-29T14:10:00Z", contact_window_start: "08:00", contact_window_end: "21:00", daily_cap: 750, per_sender_cap: 150, metadata: { timezone: "America/Chicago" } };
  const stats = new Map([["mpls", { remaining: 453, scheduled: 50, senders: 1 }]]);
  assert.equal(dailyPace(c, stats.get("mpls")), 150);
  const out = buildCampaignEvents([c], { from: "2026-09-28", to: "2026-10-11", now: NOW, stats });
  const windows = out.filter((e) => e.type === "campaign_window");
  assert.equal(windows.length, 4, "503 at 150/day = 4 days");
  assert.equal(windows[0].start, "2026-09-29T14:10:00.000Z", "day one opens at the scheduled start");
  assert.equal(windows[1].start, "2026-09-30T13:00:00.000Z", "08:00 CT, not device time");
  assert.equal(windows[1].time_kind, "expected");
  assert.equal(out.find((e) => e.type === "campaign_start").status, "scheduled");
});

test("a stale scheduled start is MISSED and projects no windows", () => {
  const c = { id: "eg", name: "EG", status: "scheduled", scheduled_for: "2026-09-25T17:10:00Z", metadata: { timezone: "America/Chicago" } };
  const out = buildCampaignEvents([c], { from: "2026-09-28", to: "2026-10-11", now: NOW, stats: new Map([["eg", { remaining: 37, scheduled: 34 }]]) });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "missed");
  assert.ok(out[0].attention);
});

test("closing deadlines are all-day DUE dates with no invented clock time; met milestones are not overdue", () => {
  const cases = [{ id: 9, emd_due_date: "2026-09-26", escrow_status: "pending", scheduled_closing_date: "2026-10-05", closing_status: "open" }];
  const out = buildClosingEvents(cases, { from: "2026-09-14", to: "2026-10-11", today: "2026-09-28" });
  const emd = out.find((e) => e.title === "EMD due");
  assert.equal(emd.all_day, true);
  assert.equal(emd.overdue, true);
  const met = buildClosingEvents([{ ...cases[0], escrow_status: "received" }], { from: "2026-09-14", to: "2026-10-11", today: "2026-09-28" });
  assert.equal(met.find((e) => e.title === "EMD due").overdue, false);
});

test("one real closing date is one event: the closing case wins over the offer", () => {
  const events = dedupeEvents([
    { id: "o", type: "closing", title: "Closing", all_day: true, date: "2026-10-05", source: "seller_offers.closing_date", links: { opportunity_id: "7" } },
    { id: "c", type: "closing", title: "Closing", all_day: true, date: "2026-10-05", source: "closing_cases.scheduled_closing_date", links: { opportunity_id: "7" } },
  ]);
  assert.deepEqual(events.map((e) => e.id), ["c"]);
});

test("a pipeline action mirroring the thread's follow-up is dropped for the thread's", () => {
  const events = dedupeEvents([
    { id: "f", type: "seller_follow_up", start: "2026-09-26T03:52:00Z", links: { thread_key: "t" } },
    { id: "p", type: "pipeline_action", start: "2026-09-26T03:52:30Z", links: { thread_key: "t" } },
  ]);
  assert.deepEqual(events.map((e) => e.id), ["f"]);
});
