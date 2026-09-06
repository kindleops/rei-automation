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

// ── HARD RAIL vs PREFERENCE WINDOW ─────────────────────────────────────────
// best_contact_window is inferred seller INTELLIGENCE that optimises Best
// Contact Time. It is NOT a permission boundary. Only the canonical
// 08:00-21:00 local rail (plus compliance) binds a manual operator choice.

const PREF = (over = {}) => ({ thread_key: "+15555550100", routing_timezone: "Central",
  best_contact_window: "9AM-11AM CT", ...over });

test("EXACT: an operator time outside the PREFERENCE window is still honoured", () => {
  const r = resolveBulkScheduleMode({ mode: "exact", date: "2026-09-10", time: "2:00 PM",
    recipient: PREF(), now: NOW });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.local_send_hour, 14, "2 PM must remain 2 PM");
  assert.equal(r.deferred, false, "a preference mismatch is not a deferral");
  assert.equal(r.honours_preference, false, "manual deliberately overrides preference");
});

test("EXACT: the HARD rail still binds a manual choice", () => {
  const r = resolveBulkScheduleMode({ mode: "exact", date: "2026-09-10", time: "7:15 AM",
    recipient: PREF(), now: NOW });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.requested_local_hour, 7);
  assert.equal(r.deferred, true, "before the 08:00 rail must adjust");
  assert.equal(r.local_send_hour, 8);
});

test("WINDOW: a range outside the preference window is schedulable", () => {
  const r = resolveBulkScheduleMode({ mode: "window", date: "2026-09-10",
    window_start: "2:00 PM", window_end: "5:00 PM", recipient: PREF(), now: NOW });
  assert.equal(r.ok, true, r.reason || "");
  assert.ok(r.local_send_hour >= 14 && r.local_send_hour < 17,
    `must land in 2-5 PM, got ${r.local_send_hour}`);
});

test("WINDOW: no_valid_window_overlap means no HARD overlap, not a preference miss", () => {
  // 5-7 AM is entirely before the 08:00 hard opening.
  const hard = resolveBulkScheduleMode({ mode: "window", date: "2026-09-10",
    window_start: "5:00 AM", window_end: "7:00 AM", recipient: PREF(), now: NOW });
  assert.equal(hard.ok, false);
  assert.equal(hard.reason, "no_valid_window_overlap");
  assert.deepEqual(hard.hard_window, [8 * 60, 21 * 60]);

  // Same range, but a seller whose preference happens to be 9-11 AM: still the
  // HARD rail doing the rejecting, never the preference.
  const pref = resolveBulkScheduleMode({ mode: "window", date: "2026-09-10",
    window_start: "12:00 PM", window_end: "3:00 PM",
    recipient: PREF({ best_contact_window: "9AM-11AM CT" }), now: NOW });
  assert.equal(pref.ok, true, "a preference mismatch must remain schedulable");
});

test("STARTING AT: staggering is bounded by the hard close, not the preference end", () => {
  const r = resolveBulkScheduleMode({ mode: "starting_at", date: "2026-09-10", time: "2:00 PM",
    recipient: PREF(), now: NOW });
  assert.equal(r.ok, true, r.reason || "");
  assert.ok(r.local_send_hour >= 14, "must not be pulled back into the 9-11 AM preference");
  assert.ok(r.local_send_hour < 21, "must stay inside the hard close");
});

test("BEST CONTACT TIME still optimises INSIDE the preference window", () => {
  const r = resolveBulkScheduleMode({ mode: "best_contact_time",
    recipient: PREF({ best_contact_window: "9AM-11AM CT" }), now: NOW });
  assert.equal(r.ok, true, r.reason || "");
  assert.equal(r.contact_window_used, "9AM-11AM CT");
  assert.ok(r.local_send_hour >= 9 && r.local_send_hour <= 11,
    `best contact time must sit in the preference window, got ${r.local_send_hour}`);
});

// ── DST EDGES ──────────────────────────────────────────────────────────────

test("DST spring-forward: a NONEXISTENT wall clock resolves deterministically", () => {
  // 2026-03-08 America/Chicago: 02:00 CST jumps to 03:00 CDT, so 02:30 never
  // occurs. The helper must still yield one real instant, not NaN, and must not
  // silently land on a different DAY.
  const d = zonedWallClockToUtc("2026-03-08", 2 * 60 + 30, "America/Chicago");
  assert.ok(d instanceof Date && Number.isFinite(d.getTime()), "must be a real instant");
  assert.equal(d.toISOString(), "2026-03-08T07:30:00.000Z");
  const again = zonedWallClockToUtc("2026-03-08", 2 * 60 + 30, "America/Chicago");
  assert.equal(d.toISOString(), again.toISOString(), "must be stable");
});

test("DST fall-back: an AMBIGUOUS wall clock resolves to one stable instant", () => {
  // 2026-11-01 America/Chicago: 01:00-02:00 occurs twice. Either choice is
  // defensible; repeating it must not oscillate.
  const first = zonedWallClockToUtc("2026-11-01", 90, "America/Chicago");
  const second = zonedWallClockToUtc("2026-11-01", 90, "America/Chicago");
  assert.equal(first.toISOString(), "2026-11-01T06:30:00.000Z");
  assert.equal(first.toISOString(), second.toISOString(), "must not oscillate");
});

test("DST: a normal afternoon on both transition days uses the correct offset", () => {
  const spring = zonedWallClockToUtc("2026-03-08", 14 * 60, "America/Chicago");
  const fall = zonedWallClockToUtc("2026-11-01", 14 * 60, "America/Chicago");
  assert.equal(spring.toISOString().slice(11, 16), "19:00", "CDT after the jump");
  assert.equal(fall.toISOString().slice(11, 16), "20:00", "CST after the fall back");
});

test("DST: scheduling across a transition keeps the seller's wall clock", () => {
  for (const [date, expectedUtc] of [["2026-03-08", "19:00"], ["2026-11-01", "20:00"]]) {
    const r = resolveBulkScheduleMode({ mode: "exact", date, time: "2:00 PM",
      recipient: PREF({ best_contact_window: null }), now: new Date("2026-03-01T15:00:00Z") });
    assert.equal(r.ok, true, `${date}: ${r.reason || ""}`);
    assert.equal(r.local_send_hour, 14, `${date} must stay 2 PM to the seller`);
    assert.equal(r.scheduled_for_utc.slice(11, 16), expectedUtc, `${date} offset`);
  }
});
