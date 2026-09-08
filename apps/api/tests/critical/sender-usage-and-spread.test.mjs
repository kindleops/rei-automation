/**
 * sender-usage-and-spread.test.mjs
 *
 * Defect C (2026-09-08): all 150 sends left ONE number in ~5 minutes.
 * Two repaired contracts:
 *   1. incrementTextgridNumberUsage must increment the LIVE counter. The queue
 *      path hands it a `selected` without messages_sent_today, and the old
 *      `asNumber(undefined,0)+1` wrote an absolute 1 on every send, so usage
 *      ordering could never rotate senders.
 *   2. resolveSenderSpreadInstant paces a sender by the campaign's EXISTING
 *      send_interval_seconds: no interval => due now (no invented cap); with an
 *      interval, no earlier than the sender's last scheduled send + interval;
 *      outside the contact window => deferred to the next window open.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { incrementTextgridNumberUsage } from "@/lib/supabase/sms-engine.js";
import { resolveSenderSpreadInstant } from "@/lib/domain/campaigns/enqueue-campaign-target-one.js";

// ── 1. live-read counter ────────────────────────────────────────────────────

function fakeNumbersTable({ live = 150 } = {}) {
  const writes = [];
  const supabase = {
    from(table) {
      assert.equal(table, "textgrid_numbers");
      return {
        select() { return { eq() { return { maybeSingle: async () => ({ data: { messages_sent_today: live }, error: null }) }; } }; },
        update(payload) { writes.push(payload); return { eq() { return { select() { return { maybeSingle: async () => ({ data: { id: "n-1", ...payload }, error: null }) }; } }; } }; },
      };
    },
  };
  return { supabase, writes };
}

test("counter: selected WITHOUT messages_sent_today reads the live value and increments it", async () => {
  const { supabase, writes } = fakeNumbersTable({ live: 150 });
  const out = await incrementTextgridNumberUsage({ selected: { id: "n-1", phone_number: "+13055552999", metadata: {} } }, { supabase, now: "2026-09-08T18:30:31.000Z" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].messages_sent_today, 151, "must be live+1, not an absolute 1");
  assert.equal(out.messages_sent_today, 151);
});

test("counter: selected WITH messages_sent_today increments that value without a read", async () => {
  let reads = 0;
  const writes = [];
  const supabase = { from() { return {
    select() { reads += 1; return { eq() { return { maybeSingle: async () => ({ data: { messages_sent_today: 999 }, error: null }) }; } }; },
    update(payload) { writes.push(payload); return { eq() { return { select() { return { maybeSingle: async () => ({ data: payload, error: null }) }; } }; } }; },
  }; } };
  await incrementTextgridNumberUsage({ selected: { id: "n-1", messages_sent_today: 41 } }, { supabase });
  assert.equal(reads, 0); assert.equal(writes[0].messages_sent_today, 42);
});

test("counter: an injected implementation still wins", async () => {
  let called = null;
  await incrementTextgridNumberUsage({ selected: { id: "n-1" } }, { incrementTextgridNumberUsage: async (sel) => { called = sel; return sel; } });
  assert.equal(called.id, "n-1");
});

// ── 2. per-sender spread ────────────────────────────────────────────────────

const MIAMI_TZ = "America/New_York";
const NOW = "2026-09-08T18:24:13.000Z"; // 14:24 ET, inside the 08:00-21:00 window
function fakeQueue(lastScheduledFor) {
  return { from(table) { assert.equal(table, "send_queue"); return {
    select() { return this; }, eq() { return this; }, in() { return this; }, not() { return this; }, order() { return this; },
    limit: async () => ({ data: lastScheduledFor ? [{ scheduled_for: lastScheduledFor }] : [], error: null }),
  }; } };
}

test("spread: no send_interval_seconds configured => due now, nothing invented", async () => {
  const r = await resolveSenderSpreadInstant(fakeQueue("2026-09-08T18:24:00.000Z"), { campaign: { send_interval_seconds: null }, senderPhone: "+13055552999", nowIso: NOW, tz: MIAMI_TZ });
  assert.equal(r.scheduled_for, NOW); assert.equal(r.spread_applied, false); assert.equal(r.interval_seconds, null);
});

test("spread: with a 60s interval the row lands 60s after the sender's last scheduled send", async () => {
  const r = await resolveSenderSpreadInstant(fakeQueue("2026-09-08T18:24:00.000Z"), { campaign: { send_interval_seconds: 60 }, senderPhone: "+13055552999", nowIso: NOW, tz: MIAMI_TZ });
  assert.equal(r.scheduled_for, "2026-09-08T18:25:00.000Z"); assert.equal(r.spread_applied, true); assert.equal(r.interval_seconds, 60);
});

test("spread: a sender idle longer than the interval is due now", async () => {
  const r = await resolveSenderSpreadInstant(fakeQueue("2026-09-08T17:00:00.000Z"), { campaign: { send_interval_seconds: 60 }, senderPhone: "+13055552999", nowIso: NOW, tz: MIAMI_TZ });
  assert.equal(r.scheduled_for, NOW); assert.equal(r.spread_applied, false);
});

test("spread: a sender with no prior rows is due now", async () => {
  const r = await resolveSenderSpreadInstant(fakeQueue(null), { campaign: { send_interval_seconds: 45 }, senderPhone: "+13055552999", nowIso: NOW, tz: MIAMI_TZ });
  assert.equal(r.scheduled_for, NOW);
});

test("spread: 150 rows for one sender at 60s spread across 150 minutes, never the same minute", async () => {
  let last = null; const seen = new Set();
  for (let i = 0; i < 150; i += 1) {
    const r = await resolveSenderSpreadInstant(fakeQueue(last), { campaign: { send_interval_seconds: 60 }, senderPhone: "+13055552999", nowIso: NOW, tz: MIAMI_TZ });
    assert.ok(!seen.has(r.scheduled_for), `collision at ${r.scheduled_for}`); seen.add(r.scheduled_for); last = r.scheduled_for;
  }
  const spanMin = (Date.parse(last) - Date.parse(NOW)) / 60000;
  assert.equal(spanMin, 149, "150 rows => 149 intervals of 60s");
});

test("spread: a candidate outside the contact window is deferred, not sent at night", async () => {
  // last scheduled at 20:59:30 ET => candidate 21:00:30 ET, past the 21:00 close
  const lateNow = "2026-09-09T00:59:30.000Z"; // 20:59:30 ET
  const r = await resolveSenderSpreadInstant(fakeQueue("2026-09-09T00:59:30.000Z"), { campaign: { send_interval_seconds: 60, contact_window_start: "08:00", contact_window_end: "21:00" }, senderPhone: "+13055552999", nowIso: lateNow, tz: MIAMI_TZ });
  assert.ok(Date.parse(r.scheduled_for) > Date.parse("2026-09-09T01:00:30.000Z"), `expected deferral past the window close, got ${r.scheduled_for}`);
});
