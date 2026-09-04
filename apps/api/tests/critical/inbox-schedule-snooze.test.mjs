import test from "node:test";
import assert from "node:assert/strict";

import { resolveInboxSchedule, resolveIanaTimezone } from "@/lib/domain/inbox/resolve-inbox-schedule.js";
import { threadMatchesInboxTab } from "@/lib/domain/inbox/inbox-thread-state-contract.js";

const NOW = new Date("2026-09-07T12:00:00Z");

// ── FIX 1: timezone-correct scheduling ──────────────────────────────────────

test("resolveIanaTimezone maps labels and preserves valid IANA input", () => {
  assert.equal(resolveIanaTimezone("Central"), "America/Chicago");
  assert.equal(resolveIanaTimezone("Eastern"), "America/New_York");
  assert.equal(resolveIanaTimezone("Pacific"), "America/Los_Angeles");
  // Already-IANA rows must not be flattened to the Central default.
  assert.equal(resolveIanaTimezone("America/New_York"), "America/New_York");
  assert.equal(resolveIanaTimezone("America/Denver"), "America/Denver");
  // Garbage falls back rather than throwing.
  assert.equal(resolveIanaTimezone("Not/AZone"), "America/Chicago");
  assert.equal(resolveIanaTimezone(""), "America/Chicago");
});

test("in-window request is preserved exactly and local fields are truthful", () => {
  const cases = [
    { tz: "Central", iana: "America/Chicago",     hour: 13 },
    { tz: "Eastern", iana: "America/New_York",    hour: 14 },
    { tz: "Pacific", iana: "America/Los_Angeles", hour: 11 },
  ];
  for (const { tz, iana, hour } of cases) {
    const r = resolveInboxSchedule({
      requested_at: "2026-09-08T18:30:00Z", timezone: tz, now: NOW,
    });
    assert.equal(r.ok, true, tz);
    assert.equal(r.deferred, false, `${tz} must not defer an in-window time`);
    assert.equal(r.timezone_iana, iana);
    // The operator's instant survives untouched.
    assert.equal(r.scheduled_for_utc, "2026-09-08T18:30:00.000Z");
    // All three instant columns agree.
    assert.equal(r.scheduled_for, r.scheduled_for_utc);
    assert.equal(r.scheduled_for_local, r.scheduled_for_utc);
    // Local truth.
    assert.equal(r.local_send_date, "2026-09-08");
    assert.equal(r.local_send_hour, hour);
    assert.equal(r.effective_local_minute, 30);
  }
});

test("local_send_hour differs per zone for one identical instant", () => {
  const at = "2026-09-08T18:30:00Z";
  const hours = ["Central", "Eastern", "Pacific"].map(
    (tz) => resolveInboxSchedule({ requested_at: at, timezone: tz, now: NOW }).local_send_hour
  );
  // Central 13, Eastern 14, Pacific 11 — proves the field is not just UTC.
  assert.deepEqual(hours, [13, 14, 11]);
});

test("scheduled_for_local stays a true instant, never a naive wall clock", () => {
  // Regression guard. normalizeSendQueueRow resolves the due-time gate via
  // scheduled_for -> scheduled_for_utc -> scheduled_for_local. A naive local
  // string parked in that column is read back as UTC and can make a message
  // due HOURS EARLY (9:17 AM Pacific stored naive = 2:17 AM Pacific).
  const r = resolveInboxSchedule({
    requested_at: "2026-09-08T18:30:00Z", timezone: "Pacific", now: NOW,
  });
  assert.equal(new Date(r.scheduled_for_local).getTime(),
               new Date(r.scheduled_for_utc).getTime());
  assert.match(r.scheduled_for_local, /Z$/);
});

// ── FIX 2: contact window resolved AT SCHEDULE TIME ─────────────────────────

test("quiet-hours request is shifted to the next eligible local window", () => {
  const cases = [
    { tz: "Central", req: "2026-09-08T08:42:00Z", utc: "2026-09-08T13:00:00.000Z" },
    { tz: "Eastern", req: "2026-09-08T07:42:00Z", utc: "2026-09-08T12:00:00.000Z" },
    { tz: "Pacific", req: "2026-09-08T10:42:00Z", utc: "2026-09-08T15:00:00.000Z" },
  ];
  for (const { tz, req, utc } of cases) {
    const r = resolveInboxSchedule({ requested_at: req, timezone: tz, now: NOW });
    assert.equal(r.ok, true, tz);
    assert.equal(r.deferred, true, `${tz} 3:42 AM must defer`);
    assert.equal(r.deferral_reason, "outside_local_send_window");
    // Requested was 3:42 AM local; effective is 8:00 AM local, same day.
    assert.equal(r.requested_local_hour, 3);
    assert.equal(r.local_send_hour, 8, `${tz} must land at local 08:00`);
    assert.equal(r.scheduled_for_utc, utc);
    assert.equal(r.local_send_date, "2026-09-08");
    assert.equal(r.effective_local_label, "8:00 AM");
  }
});

test("late-night request rolls to the NEXT day's window", () => {
  // 2026-09-08T03:30Z = 10:30 PM CT on 09-07 (after the 21:00 close).
  const r = resolveInboxSchedule({
    requested_at: "2026-09-08T03:30:00Z", timezone: "Central", now: NOW,
  });
  assert.equal(r.deferred, true);
  assert.equal(r.requested_local_hour, 22);
  assert.equal(r.local_send_hour, 8);
  assert.equal(r.local_send_date, "2026-09-08", "must roll forward to the next day");
});

test("the effective time returned to the UI is the one persisted", () => {
  const r = resolveInboxSchedule({
    requested_at: "2026-09-08T08:42:00Z", timezone: "Central", now: NOW,
  });
  // What the client renders and what the DB stores must be the same instant.
  assert.equal(r.effective_local_label, "8:00 AM");
  assert.notEqual(r.requested_local_label, r.effective_local_label);
  assert.equal(new Date(r.scheduled_for_utc).getTime(),
               new Date(r.scheduled_for).getTime());
});

test("invalid and past schedules are refused, not silently coerced", () => {
  assert.equal(resolveInboxSchedule({ requested_at: "", now: NOW }).reason, "invalid_requested_at");
  assert.equal(resolveInboxSchedule({ requested_at: "nonsense", now: NOW }).reason, "invalid_requested_at");
  assert.equal(
    resolveInboxSchedule({ requested_at: "2026-09-06T12:00:00Z", now: NOW }).reason,
    "requested_at_in_past"
  );
});

test("a window authority that declines without a next opening is refused", () => {
  // Never persist a quiet-hours instant just because the authority was vague.
  const r = resolveInboxSchedule({
    requested_at: "2026-09-08T08:42:00Z",
    timezone: "Central",
    now: NOW,
    evaluate: () => ({ allowed: false, reason: "outside_local_send_window", next_open_at: null }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "contact_window_unresolvable");
});

// ── FIX 3: snooze bucket semantics ──────────────────────────────────────────

const FUTURE = "2026-09-10T15:00:00Z";
const PAST   = "2026-09-05T15:00:00Z";
const nowMs  = NOW.getTime();

// Timestamps are recent relative to NOW so the row genuinely satisfies the
// real new_replies predicate. Without them the row matches nothing and every
// "snoozed thread is excluded" assertion below would pass vacuously.
const RECENT = "2026-09-07T10:00:00Z";
const thread = (over = {}) => ({
  thread_key: "t1",
  inbox_bucket: "new_replies",
  latest_direction: "inbound",
  latest_message_direction: "inbound",
  latest_message_at: RECENT,
  last_inbound_at: RECENT,
  last_outbound_at: "2026-09-07T09:00:00Z",
  pending_queue_count: 0,
  is_archived: false,
  ...over,
});

// Guard: the baseline fixture MUST be actionable, or the exclusion tests lie.
test("fixture sanity: the baseline thread really is in new_replies", () => {
  assert.equal(threadMatchesInboxTab(thread(), "new_replies", nowMs), true,
    "baseline fixture must match new_replies or every exclusion test is vacuous");
});

test("an actively snoozed thread leaves the actionable buckets", () => {
  const row = thread({ snoozed_until: FUTURE });
  for (const tab of ["new_replies", "priority", "needs_review", "follow_up"]) {
    assert.equal(threadMatchesInboxTab(row, tab, nowMs), false,
      `snoozed thread must not appear in ${tab}`);
  }
});

test("a snoozed thread stays discoverable and complete", () => {
  const row = thread({ snoozed_until: FUTURE });
  assert.equal(threadMatchesInboxTab(row, "snoozed", nowMs), true, "Snoozed view");
  assert.equal(threadMatchesInboxTab(row, "all", nowMs), true, "All Threads = full history");
});

test("snooze does NOT leak into Waiting", () => {
  // Waiting means "we sent, the seller has not answered". Snoozed threads are
  // deliberately kept out so the one bucket reporting real outstanding outbound
  // stays unambiguous; the Snoozed sub-view is where they surface instead.
  const outboundWaiting = thread({
    inbox_bucket: "waiting",
    latest_direction: "outbound",
    latest_message_direction: "outbound",
    last_outbound_at: RECENT,
    last_inbound_at: null,
    snoozed_until: FUTURE,
  });
  assert.equal(threadMatchesInboxTab(outboundWaiting, "waiting", nowMs), false);
  assert.equal(threadMatchesInboxTab(outboundWaiting, "snoozed", nowMs), true);
});

test("snooze expiry returns the thread with no sweeper", () => {
  const expired = thread({ snoozed_until: PAST });
  // Same row, clock simply moved past snoozed_until.
  assert.equal(threadMatchesInboxTab(expired, "new_replies", nowMs), true,
    "an expired snooze must restore the canonical bucket");
  assert.equal(threadMatchesInboxTab(expired, "snoozed", nowMs), false,
    "an expired snooze must leave the Snoozed view");
});

test("unsnooze (cleared timestamp) restores the canonical bucket", () => {
  const row = thread({ snoozed_until: null });
  assert.equal(threadMatchesInboxTab(row, "new_replies", nowMs), true);
  assert.equal(threadMatchesInboxTab(row, "snoozed", nowMs), false);
});

test("a never-snoozed thread is unaffected", () => {
  const row = thread();
  assert.equal(threadMatchesInboxTab(row, "new_replies", nowMs), true);
  assert.equal(threadMatchesInboxTab(row, "snoozed", nowMs), false);
});

test("archived still wins over snooze", () => {
  const row = thread({ is_archived: true, snoozed_until: FUTURE });
  assert.equal(threadMatchesInboxTab(row, "archived", nowMs), true);
  assert.equal(threadMatchesInboxTab(row, "new_replies", nowMs), false);
});

// ── CONTAINMENT ─────────────────────────────────────────────────────────────

import { runInboxAction } from "@/lib/cockpit/cockpit-service.js";

// A Supabase double that records every write. Any insert/update here would be a
// containment breach, so the assertions below are on an EMPTY log.
function recordingSupabase() {
  const writes = [];
  const chain = (table) => {
    const self = {
      select: () => self, eq: () => self, gt: () => self, not: () => self,
      order: () => self, limit: () => self,
      maybeSingle: async () => ({ data: null, error: null }),
      then: undefined,
      insert: (payload) => { writes.push({ table, op: "insert", payload }); return self; },
      update: (payload) => { writes.push({ table, op: "update", payload }); return self; },
      upsert: (payload) => { writes.push({ table, op: "upsert", payload }); return self; },
    };
    return self;
  };
  return { writes, from: (table) => chain(table) };
}

test("CONTAINMENT: schedule-reply is refused while followups are internal_only", async () => {
  const supabase = recordingSupabase();
  const result = await runInboxAction({
    action: "schedule-reply",
    supabase,
    // Mirrors production: followup_automation_mode = internal_only.
    getFlags: async () => ({
      queue_runner_enabled: true,
      followup_enabled: false,
      auto_reply_enabled: false,
      outbound_sms_enabled: true,
    }),
    payload: {
      thread_key: "+15555550100",
      to_phone_number: "+15555550100",
      from_phone_number: "+15555550111",
      message_body: "canary — must never be queued or sent",
      scheduled_for: "2026-09-08T18:30:00Z",
      dry_run: false,
    },
  });

  assert.equal(result.ok, false, "containment must refuse the action");
  assert.equal(result.reason, "followup_disabled");
  assert.equal(
    supabase.writes.length, 0,
    `containment breach: ${JSON.stringify(supabase.writes)}`
  );
});

test("CONTAINMENT: the refusal happens before any queue row is built", async () => {
  const supabase = recordingSupabase();
  const result = await runInboxAction({
    action: "schedule-reply",
    supabase,
    getFlags: async () => ({ queue_runner_enabled: true, followup_enabled: false }),
    // Deliberately a quiet-hours time: even the resolver must not run.
    payload: {
      thread_key: "+15555550100",
      to_phone_number: "+15555550100",
      from_phone_number: "+15555550111",
      message_body: "canary",
      scheduled_for: "2026-09-08T08:42:00Z",
      dry_run: false,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(supabase.writes.length, 0);
  // No effective-time fields leak out of a blocked action.
  assert.equal(result.effective_send_at_utc, undefined);
});
