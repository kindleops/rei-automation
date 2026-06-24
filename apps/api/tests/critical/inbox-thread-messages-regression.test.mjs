import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { getThreadMessages } from "../../src/lib/domain/inbox/live-inbox-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../src/lib/domain/inbox/live-inbox-service.js"),
  "utf8",
);

const FIXTURE_THREAD_KEY = "ct:property:239192584|owner:mo_f7ab76c09b1c4b01458b378a|phone:+12482274246";
const FIXTURE_PHONE = "+12482274246";
const FIXTURE_PROPERTY_ID = "239192584";
const FIXTURE_OWNER_ID = "mo_f7ab76c09b1c4b01458b378a";

function makeFixtureEvents() {
  return [
    {
      id: "659e7cd5-928b-4514-9724-b7d15b8cc7fd",
      thread_key: FIXTURE_PHONE,
      direction: "inbound",
      message_body: "Please DO NOT contact me again!",
      to_phone_number: "+14704920588",
      from_phone_number: FIXTURE_PHONE,
      property_id: FIXTURE_PROPERTY_ID,
      master_owner_id: FIXTURE_OWNER_ID,
      is_opt_out: true,
      event_timestamp: "2026-05-28T18:42:00.000Z",
      created_at: "2026-05-28T18:42:00.000Z",
    },
    {
      id: "57a4482d-eedb-4fa5-9009-9ca4cf885268",
      thread_key: FIXTURE_PHONE,
      direction: "outbound",
      message_body: "Hey Daisy, this is Andre. I am a local real estate investor in Atlanta. Just checking, do you own 3245 Amhurst Dr Nw?",
      to_phone_number: FIXTURE_PHONE,
      from_phone_number: "+14704920588",
      property_id: FIXTURE_PROPERTY_ID,
      master_owner_id: FIXTURE_OWNER_ID,
      event_timestamp: "2026-05-27T15:10:00.000Z",
      created_at: "2026-05-27T15:10:00.000Z",
      delivery_status: "delivered",
      provider_delivery_status: "delivered",
    },
  ];
}

function makeMessageEventSupabaseStub(rows = []) {
  return {
    from(table) {
      const state = {
        table,
        rows: table === "message_events" ? [...rows] : [],
        filters: [],
        orders: [],
        range: null,
        limit: null,
      };

      const api = {
        select() { return api; },
        eq(column, value) {
          state.filters.push((row) => String(row?.[column] ?? "").trim() === String(value ?? "").trim());
          return api;
        },
        order() { return api; },
        range(start, end) {
          state.range = [start, end];
          return api;
        },
        limit(value) {
          state.limit = value;
          return api;
        },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            let data = state.rows.filter((row) => state.filters.every((fn) => fn(row)));
            if (state.range) data = data.slice(state.range[0], state.range[1] + 1);
            else if (state.limit != null) data = data.slice(0, state.limit);
            resolve({ data, error: null, count: data.length });
          }).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

test("message_events lookup columns exclude non-existent schema fields", () => {
  const block = SERVICE_SRC.slice(
    SERVICE_SRC.indexOf("const MESSAGE_EVENT_LOOKUP_COLUMNS"),
    SERVICE_SRC.indexOf("].join(\",\");", SERVICE_SRC.indexOf("const MESSAGE_EVENT_LOOKUP_COLUMNS")) + 10,
  );
  assert.match(block, /MESSAGE_EVENT_LOOKUP_COLUMNS/);
  assert.doesNotMatch(block, /"message_event_id"/);
  assert.doesNotMatch(block, /"conversation_thread_id"/);
  assert.doesNotMatch(block, /"owner_id"/);
});

test("compound thread key fixture returns inbound opt-out and outbound history", async () => {
  const result = await getThreadMessages(
    {
      selected_thread_key: FIXTURE_THREAD_KEY,
      conversation_thread_id: FIXTURE_THREAD_KEY,
      property_id: FIXTURE_PROPERTY_ID,
      master_owner_id: FIXTURE_OWNER_ID,
      normalized_phone: FIXTURE_PHONE,
    },
    { limit: 50 },
    { supabase: makeMessageEventSupabaseStub(makeFixtureEvents()) },
  );

  assert.equal(result.integrityBlocked, false);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map((row) => row.message_body),
    [
      "Hey Daisy, this is Andre. I am a local real estate investor in Atlanta. Just checking, do you own 3245 Amhurst Dr Nw?",
      "Please DO NOT contact me again!",
    ],
  );
  assert.equal(result.rows.at(-1)?.direction, "inbound");
  assert.match(result.rows.at(-1)?.message_body || "", /DO NOT contact me again/i);
  assert.ok(result.diagnostics.strategy_match_counts);
  assert.ok(Object.values(result.diagnostics.strategy_match_counts).some((count) => count > 0));
  assert.notEqual(result.diagnostics.lookup_strategy_used, "message_events:empty");
});

test("phone-only thread tolerates stale property_id when owner and phone match message_events", async () => {
  const events = [
    {
      id: "6b1d4e04-dfc9-42e0-acb6-bce919f6aba5",
      thread_key: "+19014258564",
      direction: "outbound",
      message_body: "Hello Marcus, this is Jake. I invest in Memphis. Are you still the owner of 1475 Havana St?",
      to_phone_number: "+19014258564",
      from_phone_number: "+14704920588",
      property_id: "2124356029",
      master_owner_id: "mo_621d92819c84f09881aa8e1e",
      event_timestamp: "2026-06-19T18:41:45.352Z",
      created_at: "2026-06-19T18:41:45.352Z",
    },
  ];

  const result = await getThreadMessages(
    {
      selected_thread_key: "+19014258564",
      property_id: "2124334131",
      master_owner_id: "mo_621d92819c84f09881aa8e1e",
      normalized_phone: "+19014258564",
    },
    { limit: 50 },
    { supabase: makeMessageEventSupabaseStub(events) },
  );

  assert.equal(result.rows.length, 1);
  assert.match(result.rows[0].message_body, /Hello Marcus/i);
});

test("continues through strategies when first strategy returns zero rows", async () => {
  const events = [
    {
      id: "owner-only-inbound",
      thread_key: "legacy-key-only",
      direction: "inbound",
      message_body: "Not interested",
      from_phone_number: "+15550001234",
      to_phone_number: "+15550009999",
      master_owner_id: "owner-x",
      property_id: "prop-x",
      event_timestamp: "2026-05-29T12:00:00.000Z",
      created_at: "2026-05-29T12:00:00.000Z",
    },
  ];

  const result = await getThreadMessages(
    {
      selected_thread_key: "ct:property:prop-x|owner:owner-x|phone:+15550001234",
      conversation_thread_id: "ct:property:prop-x|owner:owner-x|phone:+15550001234",
      property_id: "prop-x",
      master_owner_id: "owner-x",
      normalized_phone: "+15550001234",
    },
    { limit: 50 },
    { supabase: makeMessageEventSupabaseStub(events) },
  );

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].message_body, "Not interested");
  assert.ok((result.diagnostics.strategies_tried || []).length > 1);
});