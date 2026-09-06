import test from "node:test";
import assert from "node:assert/strict";
import { resolveBulkScheduleMode, zonedWallClockToUtc, parseClockToMinutes }
  from "@/lib/domain/inbox/resolve-bulk-schedule-mode.js";

const NOW = new Date("2026-09-07T15:00:00Z");
const R = (over = {}) => ({ thread_key: "+15555550100", routing_timezone: "Central",
  best_contact_window: "9AM-8PM CT", ...over });

// ── 2 + 8: same local wall clock, different UTC per timezone ────────────────

test("EXACT: 2:00 PM local resolves to a DIFFERENT UTC per timezone", () => {
  const zones = [
    ["Eastern",  "18:00"],
    ["Central",  "19:00"],
    ["Mountain", "20:00"],
    ["Pacific",  "21:00"],
  ];
  const seen = new Set();
  for (const [tz, expectedHHMM] of zones) {
    const r = resolveBulkScheduleMode({
      mode: "exact", date: "2026-09-10", time: "2:00 PM",
      recipient: R({ routing_timezone: tz, best_contact_window: null }), now: NOW,
    });
    assert.equal(r.ok, true, `${tz}: ${r.reason || ""}`);
    assert.equal(r.local_send_hour, 14, `${tz} must be 2 PM seller local`);
    const utc = r.scheduled_for_utc.slice(11, 16);
    assert.equal(utc, expectedHHMM, `${tz} expected ${expectedHHMM}Z, got ${utc}`);
    seen.add(r.scheduled_for_utc);
  }
  assert.equal(seen.size, 4, "a batch must not collapse to one universal instant");
});

// ── 3: DST via canonical zone data, not hard-coded offsets ─────────────────

test("DST is handled by the zone, not a fixed offset", () => {
  // 2:00 PM Central in September (CDT, UTC-5) vs January (CST, UTC-6).
  const summer = resolveBulkScheduleMode({ mode: "exact", date: "2026-09-10", time: "2:00 PM",
    recipient: R({ best_contact_window: null }), now: NOW });
  const winter = resolveBulkScheduleMode({ mode: "exact", date: "2027-01-10", time: "2:00 PM",
    recipient: R({ best_contact_window: null }), now: NOW });
  assert.equal(summer.scheduled_for_utc.slice(11, 16), "19:00", "CDT");
  assert.equal(winter.scheduled_for_utc.slice(11, 16), "20:00", "CST");
  // Both are still 2 PM to the seller.
  assert.equal(summer.local_send_hour, 14);
  assert.equal(winter.local_send_hour, 14);
});

// ── 4 + 10: contact-window adjustment surfaces truthfully ──────────────────

test("EXACT: a quiet-hours request reports the EFFECTIVE time, not the request", () => {
  const r = resolveBulkScheduleMode({
    mode: "exact", date: "2026-09-10", time: "7:15 AM",
    recipient: R({ best_contact_window: "9AM-8PM CT" }), now: NOW,
  });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.requested_local_hour, 7, "the request is preserved for display");
  assert.equal(r.deferred, true, "the adjustment must be visible");
  // evaluateContactWindow enforces a HARD 08:00-21:00 local rail and reports
  // its next opening; the row-level 9AM window is an additional constraint,
  // not the source of next_open_at. 8 AM is the canonical effective time.
  assert.equal(r.local_send_hour, 8, "effective time is the canonical window opening");
  assert.notEqual(r.requested_local_label, r.effective_local_label);
});

// ── 5 + 6 + 7: deterministic distribution ──────────────────────────────────

test("STARTING AT: times are recipient-specific and STABLE across renders", () => {
  const opts = { mode: "starting_at", date: "2026-09-10", time: "12:00 PM", now: NOW };
  const a1 = resolveBulkScheduleMode({ ...opts, recipient: R({ thread_key: "+15555550101" }) });
  const a2 = resolveBulkScheduleMode({ ...opts, recipient: R({ thread_key: "+15555550101" }) });
  const b1 = resolveBulkScheduleMode({ ...opts, recipient: R({ thread_key: "+15555550202" }) });

  assert.equal(a1.scheduled_for_utc, a2.scheduled_for_utc, "same input must resolve identically");
  assert.notEqual(a1.scheduled_for_utc, b1.scheduled_for_utc, "different recipients must stagger");
  for (const r of [a1, b1]) {
    assert.ok(r.local_send_hour >= 12, `must be at or after the 12:00 PM start, got ${r.local_send_hour}`);
  }
});

test("WINDOW: each recipient lands INSIDE the requested local window, stably", () => {
  const opts = { mode: "window", date: "2026-09-10", window_start: "2:00 PM",
    window_end: "5:00 PM", now: NOW };
  const keys = ["+15555550101", "+15555550202", "+15555550303", "+15555550404"];
  const first = keys.map((k) => resolveBulkScheduleMode({ ...opts, recipient: R({ thread_key: k }) }));
  const again = keys.map((k) => resolveBulkScheduleMode({ ...opts, recipient: R({ thread_key: k }) }));

  first.forEach((r, i) => {
    assert.equal(r.ok, true, r.reason || "");
    assert.ok(r.local_send_hour >= 14 && r.local_send_hour < 17,
      `must sit in 2-5 PM local, got ${r.local_send_hour}`);
    assert.equal(r.scheduled_for_utc, again[i].scheduled_for_utc, "must be stable across renders");
  });
});

test("no nondeterminism: 25 resolutions of one recipient are identical", () => {
  const out = new Set();
  for (let i = 0; i < 25; i += 1) {
    out.add(resolveBulkScheduleMode({ mode: "window", date: "2026-09-10",
      window_start: "2:00 PM", window_end: "5:00 PM", recipient: R(), now: NOW }).scheduled_for_utc);
  }
  assert.equal(out.size, 1, "scheduling must not vary between reads");
});

// ── 8 + 9: validation ──────────────────────────────────────────────────────

test("invalid manual configurations are rejected with explicit reasons", () => {
  const base = { recipient: R(), now: NOW };
  assert.equal(resolveBulkScheduleMode({ ...base, mode: "exact" }).reason, "missing_date");
  assert.equal(resolveBulkScheduleMode({ ...base, mode: "exact", date: "2026-09-10" }).reason, "missing_time");
  assert.equal(resolveBulkScheduleMode({ ...base, mode: "window", date: "2026-09-10" }).reason, "missing_window_bounds");
  assert.equal(
    resolveBulkScheduleMode({ ...base, mode: "window", date: "2026-09-10",
      window_start: "5:00 PM", window_end: "2:00 PM" }).reason,
    "window_end_before_start",
  );
});

test("a window with no valid overlap is unschedulable, not silently moved", () => {
  // Operator asks 5-7 AM; the seller's canonical window opens at 9 AM.
  const r = resolveBulkScheduleMode({
    mode: "window", date: "2026-09-10", window_start: "5:00 AM", window_end: "7:00 AM",
    recipient: R({ best_contact_window: "9AM-8PM CT" }), now: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_valid_window_overlap");
  assert.equal(r.scheduled_for_utc, undefined, "nothing may be scheduled outside the chosen range");
});

// ── 1: Best Contact Time uses master-owner intelligence ────────────────────

test("BEST CONTACT TIME reads routing_timezone + best_contact_window", () => {
  const r = resolveBulkScheduleMode({
    mode: "best_contact_time",
    recipient: R({ routing_timezone: "Eastern", best_contact_window: "12PM-1PM ET" }),
    now: NOW,
  });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.timezone_iana, "America/New_York", "must use the routing timezone");
  assert.equal(r.contact_window_used, "12PM-1PM ET");
  assert.ok(r.local_send_hour >= 8 && r.local_send_hour <= 21);
});

test("BEST CONTACT TIME resolves independently per seller", () => {
  const a = resolveBulkScheduleMode({ mode: "best_contact_time",
    recipient: R({ thread_key: "+1a", routing_timezone: "Eastern", best_contact_window: "12PM-1PM ET" }), now: NOW });
  const b = resolveBulkScheduleMode({ mode: "best_contact_time",
    recipient: R({ thread_key: "+1b", routing_timezone: "Pacific", best_contact_window: "9AM-11AM PT" }), now: NOW });
  assert.notEqual(a.timezone_iana, b.timezone_iana);
  assert.notEqual(a.scheduled_for_utc, b.scheduled_for_utc);
});

// ── wall-clock helper ──────────────────────────────────────────────────────

test("zonedWallClockToUtc lands on the exact local wall clock", () => {
  const d = zonedWallClockToUtc("2026-09-10", 14 * 60 + 30, "America/Chicago");
  assert.equal(d.toISOString().slice(11, 16), "19:30", "2:30 PM CDT = 19:30Z");
  assert.equal(parseClockToMinutes("2:30 PM"), 14 * 60 + 30);
  assert.equal(parseClockToMinutes("14:30"), 14 * 60 + 30);
  assert.equal(parseClockToMinutes(""), null);
});
