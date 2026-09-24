import test from "node:test";
import assert from "node:assert/strict";

import { fetchCampaignMessages, normalizeMessageBucket } from "@/lib/domain/campaigns/campaign-messages.js";
import { fetchCampaignActivity } from "@/lib/domain/campaigns/campaign-activity.js";
import { fetchCampaignResponses } from "@/lib/domain/campaigns/campaign-responses.js";
import { fetchCampaignSendsSince, parseSince } from "@/lib/domain/campaigns/campaign-sends-since.js";

const CAMPAIGN_ID = "320c798a-84c9-45b8-a7c9-d166ddd7bd46";

/** PostgREST-shaped fake: eq / neq / in filters, order, limit, head counts. */
function fakeSupabase(tables) {
  const calls = [];
  function from(table) {
    const state = { table, columns: null, options: null, filters: [], orders: [], limit: null };
    calls.push(state);
    const rows = () => {
      let out = (tables[table] || []).filter((row) =>
        state.filters.every(([op, column, value]) => {
          if (op === "eq") return row[column] === value;
          if (op === "neq") return row[column] !== value;
          if (op === "gte") return String(row[column] ?? "") >= String(value);
          if (op === "not") return row[column] !== value && row[column] !== undefined;
          return value.includes(row[column]);
        }));
      for (const { column, ascending } of [...state.orders].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[column] ?? null;
          const bv = b[column] ?? null;
          if (av === bv) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      return out;
    };
    const chain = {
      select(columns, options) { state.columns = columns; state.options = options ?? null; return chain; },
      eq(column, value) { state.filters.push(["eq", column, value]); return chain; },
      neq(column, value) { state.filters.push(["neq", column, value]); return chain; },
      in(column, values) { state.filters.push(["in", column, values]); return chain; },
      not(column, op, value) { state.filters.push(["not", column, value]); return chain; },
      order(column, opts = {}) { state.orders.push({ column, ascending: opts.ascending !== false }); return chain; },
      limit(n) { state.limit = n; return chain; },
      then(resolve, reject) {
        const all = rows();
        const result = state.options?.head
          ? { data: null, count: all.length, error: null }
          : { data: state.limit != null ? all.slice(0, state.limit) : all, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from, calls };
}

let seq = 0;
const row = (overrides) => {
  seq += 1;
  return {
    id: `q-${String(seq).padStart(4, "0")}`,
    campaign_id: CAMPAIGN_ID,
    queue_status: "delivered",
    scheduled_for: null,
    sent_at: null,
    delivered_at: null,
    updated_at: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
    campaign_target_id: null,
    master_owner_id: null,
    ...overrides,
  };
};

test("counts come from send_queue, not from planning windows", async () => {
  const supabase = fakeSupabase({
    send_queue: [
      ...Array.from({ length: 351 }, () => row({ queue_status: "delivered" })),
      ...Array.from({ length: 3 }, () => row({ queue_status: "sent" })),
      ...Array.from({ length: 595 }, () => row({ queue_status: "expired" })),
      ...Array.from({ length: 1765 }, () => row({ queue_status: "cancelled" })),
    ],
  });
  const result = await fetchCampaignMessages(CAMPAIGN_ID, { bucket: "upcoming" }, { supabase });
  assert.deepEqual(result.counts, { upcoming: 0, sending: 0, sent: 354, delivered: 351, not_sent: 595 });
  assert.deepEqual(result.messages, []);
  assert.ok(!supabase.calls.some((c) => c.table === "campaign_send_windows"), "planning windows are not the queue");
});

test("upcoming lists the next message first; sent lists the latest first", async () => {
  const supabase = fakeSupabase({
    send_queue: [
      row({ queue_status: "scheduled", scheduled_for: "2026-09-26T15:00:00Z" }),
      row({ queue_status: "scheduled", scheduled_for: "2026-09-25T15:00:00Z" }),
      row({ queue_status: "delivered", sent_at: "2026-09-10T01:00:00Z" }),
      row({ queue_status: "delivered", sent_at: "2026-09-10T17:00:00Z" }),
    ],
  });
  const upcoming = await fetchCampaignMessages(CAMPAIGN_ID, { bucket: "upcoming" }, { supabase });
  assert.deepEqual(upcoming.messages.map((m) => m.scheduled_for), ["2026-09-25T15:00:00Z", "2026-09-26T15:00:00Z"]);
  const sent = await fetchCampaignMessages(CAMPAIGN_ID, { bucket: "sent" }, { supabase });
  assert.deepEqual(sent.messages.map((m) => m.sent_at), ["2026-09-10T17:00:00Z", "2026-09-10T01:00:00Z"]);
});

test("names come from the target snapshot, then the owner record", async () => {
  const supabase = fakeSupabase({
    send_queue: [
      row({ queue_status: "delivered", sent_at: "2026-09-10T02:00:00Z", campaign_target_id: "t-1", master_owner_id: "o-1" }),
      row({ queue_status: "delivered", sent_at: "2026-09-10T01:00:00Z", campaign_target_id: null, master_owner_id: "o-2" }),
    ],
    campaign_targets: [{ id: "t-1", owner_name: "Juvette Trouillot", property_address: "9400 Nw 4th Ave", market: "Miami, FL" }],
    master_owners: [
      { master_owner_id: "o-1", display_name: "Should not be used" },
      { master_owner_id: "o-2", display_name: "Noel A Edwards Rev Liv Tr" },
    ],
  });
  const result = await fetchCampaignMessages(CAMPAIGN_ID, { bucket: "sent" }, { supabase });
  assert.deepEqual(result.messages.map((m) => m.seller_name), ["Juvette Trouillot", "Noel A Edwards Rev Liv Tr"]);
});

test("a proof row is marked test-only", async () => {
  const supabase = fakeSupabase({
    send_queue: [row({ queue_status: "scheduled", scheduled_for: "2026-09-25T15:00:00Z", meta_no_send: "true" })],
  });
  const result = await fetchCampaignMessages(CAMPAIGN_ID, { bucket: "upcoming" }, { supabase });
  assert.equal(result.messages[0].test_only, true);
});

test("an unknown bucket reads as upcoming, and the page selects no whole metadata document", async () => {
  assert.equal(normalizeMessageBucket("everything"), "upcoming");
  assert.equal(normalizeMessageBucket("SENT"), "sent");
  const supabase = fakeSupabase({ send_queue: [] });
  await fetchCampaignMessages(CAMPAIGN_ID, { bucket: "nope" }, { supabase });
  const page = supabase.calls.find((c) => c.table === "send_queue" && !c.options?.head);
  const expressions = String(page.columns).split(",").map((p) => p.trim().split(":").pop());
  assert.ok(!expressions.includes("metadata"));
});

test("activity keeps real events that 10,000 scheduler ticks would have pushed out", async () => {
  const ticks = Array.from({ length: 150 }, (_, i) => ({
    id: `tick-${i}`,
    campaign_id: CAMPAIGN_ID,
    event_type: "campaign.launch_scheduled",
    severity: "success",
    title: "Campaign launch planned",
    description: "0 targets planned; 0 queue rows created.",
    created_at: new Date(Date.UTC(2026, 8, 17, 6, 30) - i * 300_000).toISOString(),
  }));
  const real = [
    { id: "activated", campaign_id: CAMPAIGN_ID, event_type: "campaign.activated", severity: "success", title: "Campaign activated", description: "", created_at: "2026-06-20T19:14:00Z" },
    { id: "blocked", campaign_id: CAMPAIGN_ID, event_type: "campaign.launch_blocked", severity: "warning", title: "Campaign launch blocked", description: "Blocked by campaign_status_not_queueable:paused", created_at: "2026-09-24T00:41:17Z" },
  ];
  const supabase = fakeSupabase({ campaign_events: [...ticks, ...real] });
  const result = await fetchCampaignActivity(CAMPAIGN_ID, { limit: 100 }, { supabase });

  const ids = result.events.map((e) => e.id);
  assert.ok(ids.includes("activated"), "the June activation survives");
  assert.equal(ids[0], "blocked", "newest first");
  assert.equal(result.events.filter((e) => e.event_type === "campaign.launch_scheduled").length, 20);
  assert.deepEqual(result.planning_ticks, { total: 150, shown: 20 });
});

// ── responses ──────────────────────────────────────────────────────────────

/** Adds range() and gte() to the shared fake, which the responses scan needs. */
function fakeWithRange(tables) {
  const base = fakeSupabase(tables);
  return {
    calls: base.calls,
    from(table) {
      const chain = base.from(table);
      const state = base.calls[base.calls.length - 1];
      chain.gte = (column, value) => { state.filters.push(["gte", column, value]); return chain; };
      chain.range = async (fromIndex, toIndex) => {
        const all = await new Promise((resolve) => chain.then(resolve));
        const rows = (all.data || []).slice(fromIndex, toIndex + 1);
        return { data: rows, count: state.options?.count === "exact" ? (all.data || []).length : null, error: null };
      };
      return chain;
    },
  };
}

test("a reply counts only when it's to the number that messaged the seller, after it did", async () => {
  const SENDER = "+17865550000";
  const OTHER_SENDER = "+17865559999";
  const supabase = fakeWithRange({
    send_queue: [
      row({ queue_status: "delivered", to_phone_number: "+13055550001", from_phone_number: SENDER, sent_at: "2026-09-09T15:00:00Z" }),
      row({ queue_status: "delivered", to_phone_number: "+13055550002", from_phone_number: SENDER, sent_at: "2026-09-09T15:00:00Z" }),
      row({ queue_status: "delivered", to_phone_number: "+13055550003", from_phone_number: SENDER, sent_at: "2026-09-09T15:00:00Z" }),
    ],
    message_events: [
      // counted: right number, after the send
      { id: "m1", direction: "inbound", from_phone_number: "+13055550001", to_phone_number: SENDER, created_at: "2026-09-09T16:00:00Z", message_body: "yes", detected_intent: "ownership_confirmed", is_opt_out: false, thread_key: "t1", seller_display_name: "Juvette" },
      { id: "m2", direction: "inbound", from_phone_number: "+13055550001", to_phone_number: SENDER, created_at: "2026-09-09T17:00:00Z", message_body: "how much?", detected_intent: "asks_offer", is_opt_out: false, thread_key: "t1", seller_display_name: "Juvette" },
      // counted, and asked to stop
      { id: "m3", direction: "inbound", from_phone_number: "+13055550002", to_phone_number: SENDER, created_at: "2026-09-10T09:00:00Z", message_body: "STOP", detected_intent: "opt_out", is_opt_out: false, thread_key: "t2", seller_display_name: null },
      // not counted: before the send
      { id: "m4", direction: "inbound", from_phone_number: "+13055550003", to_phone_number: SENDER, created_at: "2026-09-08T09:00:00Z", message_body: "old", detected_intent: null, is_opt_out: false, thread_key: "t3", seller_display_name: null },
      // not counted: to a different number (another campaign's conversation)
      { id: "m5", direction: "inbound", from_phone_number: "+13055550003", to_phone_number: OTHER_SENDER, created_at: "2026-09-10T09:00:00Z", message_body: "hi", detected_intent: null, is_opt_out: false, thread_key: "t4", seller_display_name: null },
    ],
  });
  const result = await fetchCampaignResponses(CAMPAIGN_ID, { supabase });

  assert.equal(result.sellers_messaged, 3);
  assert.equal(result.sellers_replied, 2);
  assert.equal(result.reply_messages, 3);
  assert.equal(result.sellers_asked_to_stop, 1);
  // Each seller once, by their latest message.
  assert.deepEqual(result.intents, { asks_offer: 1, opt_out: 1 });
  assert.deepEqual(result.latest.map((r) => r.thread_key), ["t2", "t1"]);
  assert.equal(result.latest[1].message, "how much?");
});

test("no sends means no replies, without querying messages", async () => {
  const supabase = fakeWithRange({ send_queue: [], message_events: [] });
  const result = await fetchCampaignResponses(CAMPAIGN_ID, { supabase });
  assert.equal(result.sellers_messaged, 0);
  assert.equal(result.sellers_replied, 0);
  assert.ok(!supabase.calls.some((c) => c.table === "message_events"));
});


// ── sends since ────────────────────────────────────────────────────────────

test("sent today counts messages that went out since the given moment, not lifetime totals", async () => {
  const now = Date.parse("2026-09-24T18:00:00Z");
  const midnight = "2026-09-24T05:00:00.000Z";
  const supabase = fakeWithRange({
    send_queue: [
      // Miami's lifetime sends: all before today.
      ...Array.from({ length: 354 }, () => row({ campaign_id: "miami", queue_status: "delivered", sent_at: "2026-09-10T17:00:00Z" })),
      // Today: two campaign sends and one inbox send (no campaign).
      row({ campaign_id: "la", queue_status: "sent", sent_at: "2026-09-24T14:00:00Z" }),
      row({ campaign_id: "la", queue_status: "delivered", sent_at: "2026-09-24T15:00:00Z" }),
      row({ campaign_id: null, queue_status: "delivered", sent_at: "2026-09-24T16:00:00Z" }),
      // Today, but it didn't go out.
      row({ campaign_id: "la", queue_status: "failed", sent_at: "2026-09-24T16:30:00Z" }),
    ],
  });
  const result = await fetchCampaignSendsSince(midnight, { supabase, now });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.deepEqual(result.by_campaign, { la: 2 });
});

test("since must be a real moment within the last week", () => {
  const now = Date.parse("2026-09-24T18:00:00Z");
  assert.equal(parseSince("2026-09-24T05:00:00Z", now), "2026-09-24T05:00:00.000Z");
  assert.equal(parseSince("garbage", now), null);
  assert.equal(parseSince("2026-09-25T05:00:00Z", now), null, "future");
  assert.equal(parseSince("2026-09-01T05:00:00Z", now), null, "older than a week");
});
