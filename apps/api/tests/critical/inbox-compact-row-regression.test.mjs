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
const DASHBOARD_INBOX_DATA_SRC = readFileSync(
  resolve(__dirname, "../../../dashboard/src/lib/data/inboxData.ts"),
  "utf8",
);
const LIVE_V2_MIGRATION_SRC = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20260529181259_inbox_live_v2_canonical_threads.sql"),
  "utf8",
);
const INBOX_PAGE_SRC = readFileSync(
  resolve(__dirname, "../../../dashboard/src/modules/inbox/InboxPage.tsx"),
  "utf8",
);

function clean(value) {
  return String(value ?? "").trim();
}

function splitOrClauses(clause = "") {
  const parts = [];
  let current = "";
  let inQuotes = false;

  for (const char of clause) {
    if (char === "\"") inQuotes = !inQuotes;
    if (char === "," && !inQuotes) {
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

function makeMessageEventSupabaseStub(rows = []) {
  return {
    from(table) {
      const state = {
        table,
        rows: table === "message_events" ? [...rows] : [],
        filters: [],
        orClauses: [],
        orders: [],
        range: null,
        limit: null,
      };

      const api = {
        select() { return api; },
        eq(column, value) {
          state.filters.push((row) => clean(row?.[column]) === clean(value));
          return api;
        },
        or(clause) {
          state.orClauses = splitOrClauses(clause);
          return api;
        },
        order(column, options = {}) {
          state.orders.push({
            column,
            ascending: options.ascending !== false,
          });
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
            let data = [...state.rows];

            for (const filter of state.filters) {
              data = data.filter((row) => filter(row));
            }

            if (state.orClauses.length > 0) {
              data = data.filter((row) => state.orClauses.some((clause) => {
                const [column, operator, ...rest] = clause.split(".");
                const rawValue = rest.join(".");
                if (operator !== "eq") return false;
                return clean(row?.[column]) === decodeSupabaseValue(rawValue);
              }));
            }

            data.sort((left, right) => {
              for (const order of state.orders) {
                const leftValue = clean(left?.[order.column]);
                const rightValue = clean(right?.[order.column]);
                if (leftValue === rightValue) continue;
                if (order.ascending) return leftValue.localeCompare(rightValue);
                return rightValue.localeCompare(leftValue);
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

test("live inbox service reads canonical v2 sources", () => {
  assert.match(SERVICE_SRC, /const THREAD_SOURCE = "v_inbox_threads_live_v2";/);
  assert.match(SERVICE_SRC, /const COUNT_SOURCE = "v_inbox_thread_counts_live_v2";/);
});

test("canonical inbox migration partitions by canonical_thread_key and keeps one latest row per thread", () => {
  assert.match(
    LIVE_V2_MIGRATION_SRC,
    /ROW_NUMBER\(\) OVER \(\s*PARTITION BY be\.canonical_thread_key/s,
    "migration must rank rows per canonical thread",
  );
  assert.match(
    LIVE_V2_MIGRATION_SRC,
    /WHERE re\.thread_row_number = 1/,
    "migration must keep only the latest ranked row per thread",
  );
  assert.match(
    LIVE_V2_MIGRATION_SRC,
    /COALESCE\(\s*NULLIF\(me\.thread_key, ''\),\s*NULLIF\(me\.to_phone_number, ''\),\s*NULLIF\(me\.from_phone_number, ''\),\s*NULLIF\(me\.canonical_e164, ''\)\s*\) AS canonical_thread_key/s,
    "migration must derive canonical_thread_key from message_events",
  );
});

test("live inbox service orders threads by latest_message_at DESC with thread_key tie breaker", () => {
  assert.match(
    SERVICE_SRC,
    /order\("latest_message_at", \{ ascending: false, nullsFirst: false \}\)/,
    "getLiveInbox must order newest thread activity first",
  );
  assert.match(
    SERVICE_SRC,
    /order\("thread_key", \{ ascending: false \}\)/,
    "getLiveInbox must use thread_key as deterministic tie breaker",
  );
});

test("getThreadMessages returns canonical message_events in ascending chronological order", async () => {
  const threadKey = "tk-chrono-asc";
  const events = [
    {
      id: "ev-3",
      thread_key: threadKey,
      from_phone_number: "+15550001111",
      to_phone_number: "+15559876543",
      message_body: "Third",
      direction: "inbound",
      event_timestamp: "2026-05-01T12:30:00.000Z",
      created_at: "2026-05-01T12:30:00.000Z",
      canonical_e164: "+15559876543",
    },
    {
      id: "ev-1",
      thread_key: threadKey,
      from_phone_number: "+15559876543",
      to_phone_number: "+15550001111",
      message_body: "First",
      direction: "outbound",
      event_timestamp: "2026-05-01T10:00:00.000Z",
      created_at: "2026-05-01T10:00:00.000Z",
      canonical_e164: "+15559876543",
      delivery_status: "sent",
      provider_delivery_status: "sent",
    },
    {
      id: "ev-2",
      thread_key: threadKey,
      from_phone_number: "+15550001111",
      to_phone_number: "+15559876543",
      message_body: "Second",
      direction: "inbound",
      event_timestamp: "2026-05-01T11:00:00.000Z",
      created_at: "2026-05-01T11:00:00.000Z",
      canonical_e164: "+15559876543",
    },
  ];

  const result = await getThreadMessages(
    { selected_thread_key: threadKey, canonical_e164: "+15559876543" },
    { limit: 50 },
    { supabase: makeMessageEventSupabaseStub(events) },
  );

  assert.equal(result.rows.length, 3);
  assert.deepEqual(
    result.rows.map((row) => row.message_body),
    ["First", "Second", "Third"],
  );
  assert.equal(result.rows[0].source_table, "message_events");
  assert.equal(result.rows.at(-1)?.canonical_thread_key, threadKey);
  assert.equal(result.rows[0].body, "First");
  assert.equal(result.rows[0].normalized_body, "first");
  assert.equal(result.rows[0].is_outbound, true);
  assert.equal(result.rows[1].is_inbound, true);
  assert.equal(result.rows[0].provider_status, "sent");
  assert.equal(result.rows[0].lifecycle_status, "sent");
});

test("optimistic send patch marks replied threads as follow_up and refreshes live inbox", () => {
  assert.match(
    INBOX_PAGE_SRC,
    /latestDirection:\s*'outbound'/,
    "send success must patch latestDirection to outbound",
  );
  assert.match(
    INBOX_PAGE_SRC,
    /inboxCategory:\s*'follow_up'/,
    "send success must move the thread out of new_replies immediately",
  );
  assert.match(
    INBOX_PAGE_SRC,
    /_force:\s*true/,
    "send success must force an immediate live inbox refresh",
  );
  assert.match(
    INBOX_PAGE_SRC,
    /_timeoutMode:\s*'manual_bucket_switch'/,
    "send success refresh must use the fast manual bucket timeout mode",
  );
});

test("delivery status UI maps outbound receipts to Sent, Delivered, or Failed only", () => {
  assert.match(
    DASHBOARD_INBOX_DATA_SRC,
    /if \(validDelivered\) return 'delivered'/,
    "outbound receipts must surface Delivered when delivery is confirmed",
  );
  assert.match(
    DASHBOARD_INBOX_DATA_SRC,
    /if \(terminalFailure && !providerSidExists && !outboundEventExists && !hasLaterInboundReply\) return 'failed'/,
    "outbound receipts must surface Failed for terminal failures without success evidence",
  );
  assert.match(
    DASHBOARD_INBOX_DATA_SRC,
    /return 'sent'/,
    "outbound receipts must fall back to Sent rather than exposing raw carrier states",
  );
});
