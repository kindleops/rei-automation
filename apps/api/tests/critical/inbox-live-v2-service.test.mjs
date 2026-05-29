import test from "node:test";
import assert from "node:assert/strict";

import { getLiveInbox, getThreadMessages } from "../../src/lib/domain/inbox/live-inbox-service.js";

function clean(value) {
  return String(value ?? "").trim();
}

function asTime(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function splitOrClauses(clause = "") {
  const parts = [];
  let current = "";
  let inQuotes = false;
  let depth = 0;

  for (const char of clause) {
    if (char === "\"") inQuotes = !inQuotes;
    if (!inQuotes && char === "(") depth += 1;
    if (!inQuotes && char === ")") depth -= 1;
    if (char === "," && !inQuotes && depth === 0) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function decodeSupabaseValue(value = "") {
  const trimmed = clean(value);
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replaceAll("\"\"", "\"");
  }
  return trimmed;
}

function buildCountRow(rows = []) {
  const byBucket = (bucket) => rows.filter((row) => row.inbox_bucket === bucket).length;
  return {
    all: rows.length,
    priority: byBucket("priority"),
    new_replies: byBucket("new_replies"),
    needs_review: byBucket("needs_review"),
    follow_up: byBucket("follow_up"),
    cold: byBucket("cold"),
    dead: byBucket("dead"),
    suppressed: byBucket("suppressed"),
    active: rows.filter((row) => ["priority", "new_replies", "needs_review", "follow_up"].includes(row.inbox_bucket)).length,
    waiting: rows.filter((row) => row.latest_message_direction === "outbound" && !["dead", "suppressed"].includes(row.inbox_bucket)).length,
    unlinked: rows.filter((row) => row.property_id == null).length,
  };
}

function applyOrClause(rows, clause) {
  const orClauses = splitOrClauses(clause);
  return rows.filter((row) => orClauses.some((entry) => {
    if (entry.startsWith("and(")) return true;
    const [column, operator, ...rest] = entry.split(".");
    const rawValue = rest.join(".");
    const value = decodeSupabaseValue(rawValue);
    if (operator === "eq") return clean(row?.[column]) === clean(value);
    if (operator === "lt") return clean(row?.[column]) < clean(value);
    if (operator === "ilike") {
      const needle = value.replaceAll("%", "").toLowerCase();
      return clean(row?.[column]).toLowerCase().includes(needle);
    }
    return false;
  }));
}

function createCanonicalInboxSupabase(seed = {}) {
  const threadRows = [...(seed.threadRows || [])];
  const messageEvents = [...(seed.messageEvents || [])];

  function getRowsForTable(table) {
    if (table === "v_inbox_threads_live_v2") return [...threadRows];
    if (table === "v_inbox_thread_counts_live_v2") return [buildCountRow(threadRows)];
    if (table === "message_events") return [...messageEvents];
    return [];
  }

  return {
    threadRows,
    messageEvents,
    from(table) {
      const state = {
        table,
        filters: [],
        orClause: null,
        orderBy: [],
        range: null,
        limit: null,
        countRequested: false,
      };

      const api = {
        select(_columns, options = {}) {
          state.countRequested = options.count === "exact";
          return api;
        },
        eq(column, value) {
          state.filters.push((row) => clean(row?.[column]) === clean(value));
          return api;
        },
        in(column, values = []) {
          state.filters.push((row) => values.map((value) => clean(value)).includes(clean(row?.[column])));
          return api;
        },
        is(column, value) {
          if (value === null) {
            state.filters.push((row) => row?.[column] == null);
          }
          return api;
        },
        or(clause) {
          state.orClause = clause;
          return api;
        },
        order(column, options = {}) {
          state.orderBy.push({ column, ascending: options.ascending !== false });
          return api;
        },
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
            let data = getRowsForTable(state.table);

            for (const filter of state.filters) {
              data = data.filter((row) => filter(row));
            }

            if (state.orClause) {
              data = applyOrClause(data, state.orClause);
            }

            data.sort((left, right) => {
              for (const order of state.orderBy) {
                const leftValue = left?.[order.column];
                const rightValue = right?.[order.column];
                const leftSortable = order.column.includes("_at") ? asTime(leftValue) : clean(leftValue);
                const rightSortable = order.column.includes("_at") ? asTime(rightValue) : clean(rightValue);
                if (leftSortable === rightSortable) continue;
                if (typeof leftSortable === "number" && typeof rightSortable === "number") {
                  return order.ascending ? leftSortable - rightSortable : rightSortable - leftSortable;
                }
                return order.ascending
                  ? String(leftSortable).localeCompare(String(rightSortable))
                  : String(rightSortable).localeCompare(String(leftSortable));
              }
              return 0;
            });

            const count = data.length;
            if (state.range) {
              data = data.slice(state.range[0], state.range[1] + 1);
            } else if (typeof state.limit === "number") {
              data = data.slice(0, state.limit);
            }

            return { data, count, error: null };
          }).then(resolve, reject);
        },
      };

      return api;
    },
  };
}

function makeThread(overrides = {}) {
  const threadKey = overrides.thread_key || overrides.canonical_thread_key || overrides.canonical_e164;
  return {
    thread_key: threadKey,
    canonical_thread_key: threadKey,
    canonical_e164: threadKey,
    seller_phone: threadKey,
    best_phone: threadKey,
    phone: threadKey,
    owner_name: "Seller",
    property_address_full: "123 Test St",
    latest_message_source: "message_events",
    thread_row_number: 1,
    latest_message_event_id: `${threadKey}-latest`,
    latest_message_body: "Test message",
    latest_message_direction: "outbound",
    latest_message_at: "2026-05-29T12:00:00.000Z",
    last_message_at: "2026-05-29T12:00:00.000Z",
    inbox_bucket: "cold",
    property_id: `prop-${threadKey}`,
    master_owner_id: `owner-${threadKey}`,
    duplicate_property_count: 1,
    selected_property_reason: "latest_event_property_id",
    unread_count: 0,
    opt_out: false,
    wrong_number: false,
    not_interested: false,
    needs_review: false,
    ...overrides,
  };
}

function makeEvent(overrides = {}) {
  const threadKey = overrides.thread_key || overrides.canonical_e164 || "+15550000000";
  return {
    id: overrides.id || `${threadKey}-${Math.random().toString(36).slice(2, 8)}`,
    thread_key: threadKey,
    canonical_e164: overrides.canonical_e164 || threadKey,
    from_phone_number: overrides.from_phone_number || "+16128060495",
    to_phone_number: overrides.to_phone_number || threadKey,
    message_body: overrides.message_body || "Message",
    direction: overrides.direction || "outbound",
    event_timestamp: overrides.event_timestamp || "2026-05-29T12:00:00.000Z",
    created_at: overrides.created_at || overrides.event_timestamp || "2026-05-29T12:00:00.000Z",
    property_id: overrides.property_id || null,
    master_owner_id: overrides.master_owner_id || null,
    prospect_id: overrides.prospect_id || null,
    delivery_status: overrides.delivery_status || "sent",
    provider_delivery_status: overrides.provider_delivery_status || overrides.delivery_status || "sent",
    ...overrides,
  };
}

test("latest outbound message appears at the top of the inbox and duplicate-property threads stay single-row", async () => {
  const supabase = createCanonicalInboxSupabase({
    threadRows: [
      makeThread({
        thread_key: "+15550000001",
        latest_message_at: "2026-05-29T12:05:00.000Z",
        latest_message_body: "Newest outbound",
        latest_message_direction: "outbound",
        inbox_bucket: "follow_up",
        duplicate_property_count: 3,
        property_id: "prop-101",
      }),
      makeThread({
        thread_key: "+15550000002",
        latest_message_at: "2026-05-29T11:55:00.000Z",
        latest_message_body: "Older inbound",
        latest_message_direction: "inbound",
        inbox_bucket: "new_replies",
      }),
    ],
  });

  const result = await getLiveInbox({ filter: "all", limit: 20 }, { supabase });

  assert.equal(result.threads.length, 2);
  assert.equal(result.threads[0].thread_key, "+15550000001");
  assert.equal(result.threads[0].latest_message_body, "Newest outbound");
  assert.equal(result.threads.filter((thread) => thread.thread_key === "+15550000001").length, 1);
  assert.equal(result.threads[0].duplicate_property_count, 3);
});

test("latest inbound message appears at the top of the inbox when it is the newest thread activity", async () => {
  const supabase = createCanonicalInboxSupabase({
    threadRows: [
      makeThread({
        thread_key: "+15550000011",
        latest_message_at: "2026-05-29T12:10:00.000Z",
        latest_message_body: "Newest inbound",
        latest_message_direction: "inbound",
        inbox_bucket: "new_replies",
        unread_count: 1,
      }),
      makeThread({
        thread_key: "+15550000012",
        latest_message_at: "2026-05-29T12:02:00.000Z",
        latest_message_body: "Earlier outbound",
        latest_message_direction: "outbound",
        inbox_bucket: "follow_up",
      }),
    ],
  });

  const result = await getLiveInbox({ filter: "all", limit: 20 }, { supabase });

  assert.equal(result.threads[0].thread_key, "+15550000011");
  assert.equal(result.threads[0].latest_message_direction, "inbound");
  assert.equal(result.threads[0].inbox_bucket, "new_replies");
});

test("send event inserted into message_events becomes the latest thread row", async () => {
  const supabase = createCanonicalInboxSupabase({
    threadRows: [
      makeThread({
        thread_key: "+15550000021",
        latest_message_at: "2026-05-29T11:58:00.000Z",
        latest_message_body: "Earlier reply",
        latest_message_direction: "inbound",
        inbox_bucket: "new_replies",
        unread_count: 1,
      }),
      makeThread({
        thread_key: "+15550000022",
        latest_message_at: "2026-05-29T12:01:00.000Z",
        latest_message_body: "Current top thread",
        latest_message_direction: "outbound",
        inbox_bucket: "follow_up",
      }),
    ],
    messageEvents: [
      makeEvent({
        id: "me-old-1",
        thread_key: "+15550000021",
        canonical_e164: "+15550000021",
        from_phone_number: "+15550000021",
        to_phone_number: "+16128060495",
        direction: "inbound",
        message_body: "Earlier reply",
        event_timestamp: "2026-05-29T11:58:00.000Z",
      }),
    ],
  });

  const before = await getLiveInbox({ filter: "all", limit: 20 }, { supabase });
  assert.equal(before.threads[0].thread_key, "+15550000022");

  supabase.messageEvents.push(
    makeEvent({
      id: "me-new-send",
      thread_key: "+15550000021",
      canonical_e164: "+15550000021",
      from_phone_number: "+16128060495",
      to_phone_number: "+15550000021",
      direction: "outbound",
      message_body: "Fresh outbound follow-up",
      event_timestamp: "2026-05-29T12:12:00.000Z",
      delivery_status: "sent",
    }),
  );

  supabase.threadRows.splice(0, 1, makeThread({
    thread_key: "+15550000021",
    latest_message_event_id: "me-new-send",
    latest_message_at: "2026-05-29T12:12:00.000Z",
    latest_message_body: "Fresh outbound follow-up",
    latest_message_direction: "outbound",
    inbox_bucket: "follow_up",
    unread_count: 0,
  }));

  const after = await getLiveInbox({ filter: "all", limit: 20 }, { supabase });
  const threadMessages = await getThreadMessages(
    { selected_thread_key: "+15550000021", canonical_e164: "+15550000021" },
    { limit: 20 },
    { supabase },
  );

  assert.equal(after.threads[0].thread_key, "+15550000021");
  assert.equal(after.threads[0].latest_message_body, "Fresh outbound follow-up");
  assert.equal(threadMessages.rows.at(-1)?.message_body, "Fresh outbound follow-up");
  assert.equal(threadMessages.rows.at(-1)?.direction, "outbound");
});

test("counts come from the same canonical v2 source and match filter results", async () => {
  const threadRows = [
    makeThread({
      thread_key: "+15550000031",
      latest_message_direction: "inbound",
      inbox_bucket: "priority",
      latest_message_at: "2026-05-29T12:30:00.000Z",
      unread_count: 1,
    }),
    makeThread({
      thread_key: "+15550000032",
      latest_message_direction: "inbound",
      inbox_bucket: "new_replies",
      latest_message_at: "2026-05-29T12:20:00.000Z",
      unread_count: 1,
    }),
    makeThread({
      thread_key: "+15550000033",
      latest_message_direction: "outbound",
      inbox_bucket: "follow_up",
      latest_message_at: "2026-05-29T12:10:00.000Z",
    }),
    makeThread({
      thread_key: "+15550000034",
      latest_message_direction: "outbound",
      inbox_bucket: "cold",
      latest_message_at: "2026-05-29T12:00:00.000Z",
      property_id: null,
    }),
    makeThread({
      thread_key: "+15550000035",
      latest_message_direction: "inbound",
      inbox_bucket: "needs_review",
      latest_message_at: "2026-05-29T11:50:00.000Z",
      needs_review: true,
    }),
    makeThread({
      thread_key: "+15550000036",
      latest_message_direction: "outbound",
      inbox_bucket: "suppressed",
      latest_message_at: "2026-05-29T11:40:00.000Z",
      property_id: null,
      opt_out: true,
    }),
    makeThread({
      thread_key: "+15550000037",
      latest_message_direction: "inbound",
      inbox_bucket: "dead",
      latest_message_at: "2026-05-29T11:30:00.000Z",
      property_id: null,
      wrong_number: true,
    }),
  ];

  const supabase = createCanonicalInboxSupabase({ threadRows });
  const allResult = await getLiveInbox({ filter: "all", limit: 50 }, { supabase });

  assert.equal(allResult.counts.all, threadRows.length);
  assert.equal(allResult.counts.priority, 1);
  assert.equal(allResult.counts.new_replies, 1);
  assert.equal(allResult.counts.needs_review, 1);
  assert.equal(allResult.counts.follow_up, 1);
  assert.equal(allResult.counts.cold, 1);
  assert.equal(allResult.counts.dead, 1);
  assert.equal(allResult.counts.suppressed, 1);
  assert.equal(allResult.counts.active, 4);
  assert.equal(allResult.counts.waiting, 2);
  assert.equal(allResult.counts.unlinked, 3);

  const expectations = [
    ["priority", 1],
    ["new_replies", 1],
    ["needs_review", 1],
    ["follow_up", 1],
    ["cold", 1],
    ["dead", 1],
    ["suppressed", 1],
    ["active", 4],
    ["waiting", 2],
    ["unlinked", 3],
  ];

  for (const [filter, expectedCount] of expectations) {
    const filtered = await getLiveInbox({ filter, limit: 50 }, { supabase });
    assert.equal(
      filtered.threads.length,
      expectedCount,
      `filter ${filter} should return the same count advertised by the v2 counts source`,
    );
  }
});
