/**
 * RC 7.1 owner decision 1 — sender "sent today" is DERIVED from actual sends in
 * the sender's own day, not read from the never-reset
 * textgrid_numbers.messages_sent_today counter. Routing policy (caps,
 * least-used ordering, eligibility) is unchanged; only the count it reads is.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDerivedSentToday,
  loadSenderSentToday,
  senderDayStart,
  senderOperatingTimezone,
  withDerivedSentToday,
} from "@/lib/domain/delivery/sender-sent-today.js";
import {
  evaluateOutboundNumberEligibility,
  incrementTextgridNumberUsage,
  selectAvailableTextgridNumber,
} from "@/lib/supabase/sms-engine.js";
import { chooseTextgridNumber, loadTextgridNumberFleet } from "@/lib/domain/outbound/supabase-candidate-feeder.js";

// 2026-10-01 15:00 Chicago (20:00Z): Chicago day began 05:00Z, LA day 07:00Z.
const NOW = new Date("2026-10-01T20:00:00.000Z");

function fakeSupabase(tables) {
  const calls = [];
  return {
    calls,
    from(table) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        gte: (col, value) => { calls.push({ table, gte: [col, value] }); return builder; },
        order: () => builder,
        limit: () => builder,
        range: () => builder,
        then: (resolve, reject) => Promise.resolve({ data: tables[table] || [], error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
}

const MSP_BUSY_COUNTER = {
  id: "msp-1", phone_number: "+16125092623", market: "Minneapolis, MN", status: "active",
  daily_limit: 800, messages_sent_today: 281, last_used_at: "2026-09-30T19:00:00Z",
};
const MSP_QUIET_COUNTER = {
  id: "msp-2", phone_number: "+16128060495", market: "Minneapolis, MN", status: "active",
  daily_limit: 800, messages_sent_today: 2, last_used_at: "2026-10-01T14:00:00Z",
};

const sendsAt = (phone, n, iso) => Array.from({ length: n }, (_, i) => ({ id: `${phone}-${iso}-${i}`, from_phone_number: phone, sent_at: iso }));

test("the sender's day starts at its own local midnight", () => {
  assert.equal(senderOperatingTimezone({ market: "Minneapolis, MN" }), "America/Chicago");
  assert.equal(senderOperatingTimezone({ market: "Los Angeles, CA" }), "America/Los_Angeles");
  assert.equal(senderOperatingTimezone({ market: "Boise, ID" }), "America/Boise");
  assert.equal(senderOperatingTimezone({ market: "Dallas, TX", metadata: { timezone: "America/Denver" } }), "America/Denver");
  assert.equal(senderOperatingTimezone({ market: null }), "America/New_York");
  assert.equal(senderDayStart(NOW, "America/Chicago").toISOString(), "2026-10-01T05:00:00.000Z");
  assert.equal(senderDayStart(NOW, "America/Los_Angeles").toISOString(), "2026-10-01T07:00:00.000Z");
  // Just after Chicago midnight the day is the new one, not yesterday.
  assert.equal(senderDayStart(new Date("2026-10-01T05:00:01Z"), "America/Chicago").toISOString(), "2026-10-01T05:00:00.000Z");
});

test("counts only sends since each sender's own midnight", async () => {
  const la = { phone_number: "+13235589881", market: "Los Angeles, CA" };
  const supabase = fakeSupabase({
    send_queue: [
      ...sendsAt(MSP_BUSY_COUNTER.phone_number, 3, "2026-10-01T04:59:00Z"), // yesterday in Chicago
      ...sendsAt(MSP_BUSY_COUNTER.phone_number, 4, "2026-10-01T05:00:00Z"),
      ...sendsAt(la.phone_number, 2, "2026-10-01T06:00:00Z"), // yesterday in LA
      ...sendsAt(la.phone_number, 1, "2026-10-01T08:00:00Z"),
    ],
  });
  const counts = await loadSenderSentToday(supabase, [MSP_BUSY_COUNTER, la], { now: NOW });
  assert.equal(counts.get(MSP_BUSY_COUNTER.phone_number), 4);
  assert.equal(counts.get(la.phone_number), 1);
  // One scan from the earliest day start.
  assert.deepEqual(supabase.calls[0].gte, ["sent_at", "2026-10-01T05:00:00.000Z"]);
});

test("derived rows replace the counter and keep it for diagnostics; unreadable ledger keeps the counter", async () => {
  const [derived] = applyDerivedSentToday([MSP_BUSY_COUNTER], new Map([[MSP_BUSY_COUNTER.phone_number, 0]]));
  assert.equal(derived.messages_sent_today, 0);
  assert.equal(derived.messages_sent_today_counter, 281);
  assert.equal(derived.sent_today_basis, "send_queue");

  const [fallback] = await withDerivedSentToday(null, [MSP_BUSY_COUNTER], {
    loadSenderSentToday: async () => { throw new Error("ledger down"); },
  });
  assert.equal(fallback.messages_sent_today, 281);
  assert.equal(fallback.sent_today_basis, "counter_fallback");
});

test("dispatch rotation ranks least-used by TRUE sends today (the never-reset counter no longer decides)", async () => {
  const supabase = fakeSupabase({ textgrid_numbers: [MSP_QUIET_COUNTER, MSP_BUSY_COUNTER] });
  const selection = await selectAvailableTextgridNumber(
    { id: "q1", to_phone_number: "+16125550100", message_body: "hi" },
    {
      supabase,
      now: NOW,
      loadSenderSentToday: async () => new Map([
        [MSP_BUSY_COUNTER.phone_number, 0], // counter 281, but nothing today
        [MSP_QUIET_COUNTER.phone_number, 12],
      ]),
    }
  );
  assert.equal(selection.ok, true);
  assert.equal(selection.from_phone_number, MSP_BUSY_COUNTER.phone_number);
});

test("least-used ordering is unchanged when true counts agree with the counter", async () => {
  const supabase = fakeSupabase({ textgrid_numbers: [MSP_BUSY_COUNTER, MSP_QUIET_COUNTER] });
  const selection = await selectAvailableTextgridNumber(
    { id: "q1", to_phone_number: "+16125550100", message_body: "hi" },
    {
      supabase,
      now: NOW,
      loadSenderSentToday: async () => new Map([
        [MSP_BUSY_COUNTER.phone_number, 281],
        [MSP_QUIET_COUNTER.phone_number, 2],
      ]),
    }
  );
  assert.equal(selection.from_phone_number, MSP_QUIET_COUNTER.phone_number);
});

test("the daily cap compares TRUE sends: a stale counter at the cap does not block, real sends at the cap do", async () => {
  const row = { id: "q1", to_phone_number: "+16125550100", from_phone_number: MSP_BUSY_COUNTER.phone_number, message_body: "hi" };
  const staleAtCap = { ...MSP_BUSY_COUNTER, messages_sent_today: 800 };
  const allowed = await selectAvailableTextgridNumber(row, {
    loadOutboundNumberByPhone: async () => staleAtCap,
    loadSenderSentToday: async () => new Map([[MSP_BUSY_COUNTER.phone_number, 5]]),
  });
  assert.equal(allowed.ok, true);

  const refused = await selectAvailableTextgridNumber(row, {
    loadOutboundNumberByPhone: async () => ({ ...MSP_BUSY_COUNTER, messages_sent_today: 3 }),
    loadSenderSentToday: async () => new Map([[MSP_BUSY_COUNTER.phone_number, 800]]),
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "outbound_number_daily_limit_reached");
  // The cap rule itself is untouched.
  assert.equal(evaluateOutboundNumberEligibility({ ...MSP_BUSY_COUNTER, messages_sent_today: 799 }).ok, true);
  assert.equal(evaluateOutboundNumberEligibility({ ...MSP_BUSY_COUNTER, messages_sent_today: 800 }).ok, false);
});

test("campaign router fleet reads derived counts; caps and least-used selection use them", async () => {
  const supabase = fakeSupabase({
    textgrid_numbers: [MSP_BUSY_COUNTER, MSP_QUIET_COUNTER],
    send_queue: [
      ...sendsAt(MSP_QUIET_COUNTER.phone_number, 9, "2026-10-01T15:00:00Z"),
      ...sendsAt(MSP_BUSY_COUNTER.phone_number, 50, "2026-09-30T15:00:00Z"), // yesterday
    ],
  });
  const fleet = await loadTextgridNumberFleet({ supabase });
  const byPhone = Object.fromEntries(fleet.map((r) => [r.phone_number, r]));
  // "now" is real time here; only the relative ranking is asserted.
  assert.equal(byPhone[MSP_BUSY_COUNTER.phone_number].messages_sent_today_counter, 281);
  assert.equal(byPhone[MSP_BUSY_COUNTER.phone_number].sent_today_basis, "send_queue");

  const routed = await chooseTextgridNumber(
    { market: "Minneapolis, MN", state: "MN" },
    {},
    { textgridNumberRows: applyDerivedSentToday([MSP_BUSY_COUNTER, MSP_QUIET_COUNTER], new Map([
      [MSP_BUSY_COUNTER.phone_number, 0], [MSP_QUIET_COUNTER.phone_number, 9],
    ])) }
  );
  assert.equal(routed.ok, true);
  assert.equal(routed.selected_textgrid_number, MSP_BUSY_COUNTER.phone_number);

  const capped = await chooseTextgridNumber(
    { market: "Minneapolis, MN", state: "MN" },
    {},
    { textgridNumberRows: applyDerivedSentToday([MSP_BUSY_COUNTER, MSP_QUIET_COUNTER], new Map([
      [MSP_BUSY_COUNTER.phone_number, 800], [MSP_QUIET_COUNTER.phone_number, 9],
    ])) }
  );
  assert.equal(capped.selected_textgrid_number, MSP_QUIET_COUNTER.phone_number);
});

test("usage bookkeeping keeps incrementing the RAW counter, not the derived count", async () => {
  let written = null;
  const supabase = {
    from: () => {
      const b = {
        update: (payload) => { written = payload; return b; },
        eq: () => b,
        select: () => b,
        maybeSingle: async () => ({ data: { id: "msp-1" }, error: null }),
      };
      return b;
    },
  };
  const [derived] = applyDerivedSentToday([MSP_BUSY_COUNTER], new Map([[MSP_BUSY_COUNTER.phone_number, 4]]));
  await incrementTextgridNumberUsage({ selected: derived }, { supabase, now: NOW.toISOString() });
  assert.equal(written.messages_sent_today, 282);
});
