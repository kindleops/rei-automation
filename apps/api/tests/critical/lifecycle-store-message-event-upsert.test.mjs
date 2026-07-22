// ─── lifecycle-store-message-event-upsert.test.mjs ──────────────────────────
// Regression coverage for a CodeRabbit finding on PR #49: the fake
// message_events.upsert() in tests/helpers/lifecycle-integration-store.mjs
// always appended a new row, never modeling production's
// `.upsert(payload, { onConflict: "message_event_key" })` replay-idempotency
// path (see writeOutboundSuccessMessageEvent in sms-engine.js). Proves the
// fake now honors that conflict rule while leaving every other behavior
// (plain insert, upserts without a message_event_key) unchanged.
import test from "node:test";
import assert from "node:assert/strict";

import {
  makeLifecycleStore,
  makeLifecycleFakeSupabase,
} from "../helpers/lifecycle-integration-store.mjs";

test("two upserts with the same message_event_key produce exactly one stored event", async () => {
  const store = makeLifecycleStore();
  const supabase = makeLifecycleFakeSupabase(store);
  const table = supabase.from("message_events");

  await table
    .upsert({ message_event_key: "outbound_queue-1", message_body: "first attempt", provider_message_sid: "SM1" }, { onConflict: "message_event_key" })
    .select()
    .maybeSingle();
  await table
    .upsert({ message_event_key: "outbound_queue-1", message_body: "retry replay", provider_message_sid: "SM1" }, { onConflict: "message_event_key" })
    .select()
    .maybeSingle();

  assert.equal(store.messageEvents.length, 1, "conflicting message_event_key must collapse to one row, not two");
});

test("the second upsert updates the existing event and preserves its id", async () => {
  const store = makeLifecycleStore();
  const supabase = makeLifecycleFakeSupabase(store);
  const table = supabase.from("message_events");

  const first = await table
    .upsert({ message_event_key: "outbound_queue-2", message_body: "first attempt", delivery_status: "sent" }, { onConflict: "message_event_key" })
    .select()
    .maybeSingle();
  const originalId = first.data.id;
  assert.ok(originalId);

  const second = await table
    .upsert({ message_event_key: "outbound_queue-2", message_body: "first attempt", delivery_status: "delivered" }, { onConflict: "message_event_key" })
    .select()
    .maybeSingle();

  assert.equal(second.data.id, originalId, "the upserted row must keep its original id, not mint a new one");
  assert.equal(second.data.delivery_status, "delivered", "the upsert must merge the new payload into the existing row");
  assert.equal(store.messageEvents[0].id, originalId);
  assert.equal(store.messageEvents[0].delivery_status, "delivered");
});

test("two different message_event_key values produce two events", async () => {
  const store = makeLifecycleStore();
  const supabase = makeLifecycleFakeSupabase(store);
  const table = supabase.from("message_events");

  await table.upsert({ message_event_key: "outbound_queue-3", message_body: "a" }, { onConflict: "message_event_key" }).select().maybeSingle();
  await table.upsert({ message_event_key: "outbound_queue-4", message_body: "b" }, { onConflict: "message_event_key" }).select().maybeSingle();

  assert.equal(store.messageEvents.length, 2);
  assert.deepEqual(
    store.messageEvents.map((e) => e.message_event_key).sort(),
    ["outbound_queue-3", "outbound_queue-4"]
  );
});

test("normal insert behavior still appends events", async () => {
  const store = makeLifecycleStore();
  const supabase = makeLifecycleFakeSupabase(store);
  const table = supabase.from("message_events");

  await table.insert({ message_event_key: "outbound_queue-5", message_body: "a" }).select().single();
  await table.insert({ message_event_key: "outbound_queue-5", message_body: "b" }).select().single();

  assert.equal(store.messageEvents.length, 2, "insert() must never conflict-check — that is upsert()-only behavior");
});

test("an upsert with no message_event_key preserves the existing append behavior", async () => {
  const store = makeLifecycleStore();
  const supabase = makeLifecycleFakeSupabase(store);
  const table = supabase.from("message_events");

  await table.upsert({ message_body: "no key a" }, { onConflict: "message_event_key" }).select().maybeSingle();
  await table.upsert({ message_body: "no key b" }, { onConflict: "message_event_key" }).select().maybeSingle();

  assert.equal(store.messageEvents.length, 2, "an upsert payload with no message_event_key must fall back to plain append");
});

test("an upsert declaring a different onConflict column also falls back to plain append", async () => {
  const store = makeLifecycleStore();
  const supabase = makeLifecycleFakeSupabase(store);
  const table = supabase.from("message_events");

  await table.upsert({ message_event_key: "outbound_queue-6", message_body: "a" }, { onConflict: "id" }).select().maybeSingle();
  await table.upsert({ message_event_key: "outbound_queue-6", message_body: "b" }, { onConflict: "id" }).select().maybeSingle();

  assert.equal(store.messageEvents.length, 2, "only onConflict: \"message_event_key\" triggers the conflict-aware merge");
});

test("duplicate provider/message replay in the lifecycle harness still creates no duplicate event", async () => {
  const store = makeLifecycleStore();
  const supabase = makeLifecycleFakeSupabase(store);

  // Mirrors the shape writeOutboundSuccessMessageEvent's buildSuccessMessageEvent
  // produces (sms-engine.js): message_event_key = `outbound_${queue_key}`.
  const replayPayload = () => ({
    message_event_key: "outbound_queue-replay-1",
    direction: "outbound",
    provider_message_sid: "SMreplaysid0001",
    to_phone_number: "+15551230001",
    message_body: "Hi John, are you open to selling?",
    delivery_status: "sent",
    created_at: "2026-04-04T15:00:00.000Z",
  });

  // Simulates the provider (or an upstream retry) redelivering the same
  // outbound-send confirmation twice through the canonical upsert path.
  await supabase.from("message_events").upsert(replayPayload(), { onConflict: "message_event_key" }).select().maybeSingle();
  await supabase.from("message_events").upsert(replayPayload(), { onConflict: "message_event_key" }).select().maybeSingle();
  await supabase.from("message_events").upsert(replayPayload(), { onConflict: "message_event_key" }).select().maybeSingle();

  assert.equal(store.messageEvents.length, 1, "replaying the same provider message event must never duplicate the row");
  assert.equal(store.messageEvents[0].message_event_key, "outbound_queue-replay-1");
});
