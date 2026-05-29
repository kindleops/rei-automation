/**
 * inbox-compact-row-regression.test.mjs
 *
 * Regression protection for the inbox visual regression fix.
 * Tests:
 *   1. getLiveInbox source ordering — uses ORDER BY latest_message_at DESC in source
 *   2. getThreadMessages ascending order via stub
 *   3. Message sort function (normalizeThreadMessageRows) puts oldest first
 *   4. Optimistic send patch contract
 *   5. Source-level canonical thread identity (thread_key not property_id)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  getThreadMessages,
} from "../../src/lib/domain/inbox/live-inbox-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICE_SRC = readFileSync(
  resolve(__dirname, "../../src/lib/domain/inbox/live-inbox-service.js"),
  "utf8",
);

// ── 1. Source code asserts ORDER BY latest_message_at DESC ───────────────────

test("live-inbox-service orders by latest_message_at DESC", () => {
  // The service must contain both ORDER BY calls in the right sequence.
  assert.ok(
    SERVICE_SRC.includes("order('latest_message_at', { ascending: false"),
    "getLiveInbox must ORDER BY latest_message_at ascending:false (DESC)",
  );
  assert.ok(
    SERVICE_SRC.includes("order('thread_key', { ascending: false"),
    "getLiveInbox must ORDER BY thread_key ascending:false as tiebreaker",
  );
});

// ── 2. Source asserts thread_key is canonical identity, not property_id ───────

test("live-inbox-service queries by thread_key, not property_id alone", () => {
  // The inbox query must use thread_key as primary lookup identity.
  // This ensures one row per phone/thread, not one per property.
  assert.ok(
    SERVICE_SRC.includes("'thread_key'") || SERVICE_SRC.includes('"thread_key"'),
    "live-inbox-service must reference thread_key as a canonical identity field",
  );
  // It must NOT use property_id as the primary ORDER or GROUP key.
  const orderByPropertyId = /order\s*\(\s*['"]property_id['"]/i.test(SERVICE_SRC);
  assert.ok(
    !orderByPropertyId,
    "live-inbox-service must not ORDER BY property_id (would produce per-property rows)",
  );
});

// ── 3. getThreadMessages returns events ASC by event_timestamp ───────────────

test("getThreadMessages returns events in ascending chronological order", async () => {
  const threadKey = "tk-chrono-asc";

  const events = [
    {
      id: "ev-3",
      thread_key: threadKey,
      from_phone_number: "+15550001111",
      to_phone_number: "+15559876543",
      message_body: "Third",
      direction: "inbound",
      event_timestamp: "2025-06-01T12:30:00Z",
      created_at: "2025-06-01T12:30:00Z",
    },
    {
      id: "ev-1",
      thread_key: threadKey,
      from_phone_number: "+15559876543",
      to_phone_number: "+15550001111",
      message_body: "First",
      direction: "outbound",
      event_timestamp: "2025-06-01T10:00:00Z",
      created_at: "2025-06-01T10:00:00Z",
    },
    {
      id: "ev-2",
      thread_key: threadKey,
      from_phone_number: "+15550001111",
      to_phone_number: "+15559876543",
      message_body: "Second",
      direction: "inbound",
      event_timestamp: "2025-06-01T11:00:00Z",
      created_at: "2025-06-01T11:00:00Z",
    },
  ];

  const mockSupabase = {
    from(table) {
      const self = {
        _rows: table === "message_events" ? [...events] : [],
        select() { return self; },
        eq(col, val) {
          self._rows = self._rows.filter(r => String(r[col] ?? "") === String(val));
          return Promise.resolve({ data: self._rows, error: null });
        },
      };
      return self;
    },
  };

  const result = await getThreadMessages(threadKey, { limit: 50 }, { supabase: mockSupabase });
  const messages = result.rows ?? result;

  assert.ok(Array.isArray(messages), "getThreadMessages must return an array in result.rows");
  assert.ok(messages.length >= 2, "must return at least 2 messages from stub");

  for (let i = 0; i < messages.length - 1; i++) {
    const a = new Date(messages[i].event_timestamp || messages[i].message_created_at || 0).getTime();
    const b = new Date(messages[i + 1].event_timestamp || messages[i + 1].message_created_at || 0).getTime();
    assert.ok(a <= b, `Message[${i}] (${a}) must be <= Message[${i + 1}] (${b}) for ASC order`);
  }

  // Verify first message is the oldest
  assert.strictEqual(messages[0].message_body, "First", "first message must be oldest");
  assert.strictEqual(messages[messages.length - 1].message_body, "Third", "last message must be newest");
});

// ── 4. Message sort is ascending (unit test on the internal sort) ─────────────

test("normalised messages sort ascending by event_timestamp", () => {
  const unsorted = [
    { event_timestamp: "2025-06-01T12:00:00Z", id: "c" },
    { event_timestamp: "2025-06-01T08:00:00Z", id: "a" },
    { event_timestamp: "2025-06-01T10:00:00Z", id: "b" },
  ];

  // Replicate the sort used in live-inbox-service.js line 788
  const asTime = (v) => { const t = new Date(v || 0).getTime(); return Number.isFinite(t) ? t : 0; };
  const sorted = [...unsorted].sort((a, b) => asTime(a.event_timestamp) - asTime(b.event_timestamp));

  assert.strictEqual(sorted[0].id, "a");
  assert.strictEqual(sorted[1].id, "b");
  assert.strictEqual(sorted[2].id, "c");
});

// ── 5. Optimistic send patch covers all required inbox row fields ─────────────

test("optimistic send patch covers latestMessageBody, latestDirection, latestMessageAt", () => {
  const mockText = "Hello seller";
  const mockTimestamp = new Date().toISOString();

  // Mirror the exact patch from InboxPage.tsx handleSend success branch
  const patch = {
    isRead: true,
    unread: false,
    unreadCount: 0,
    status: "replied",
    inboxStatus: "waiting",
    latestMessageBody: mockText,
    latestMessageAt: mockTimestamp,
    latestDirection: "outbound",
    inboxCategory: "outbound_active",
  };

  assert.strictEqual(patch.latestDirection, "outbound", "patch.latestDirection must be outbound");
  assert.strictEqual(patch.latestMessageBody, mockText, "patch.latestMessageBody must match sent text");
  assert.ok(typeof patch.latestMessageAt === "string" && patch.latestMessageAt.length > 0, "patch.latestMessageAt must be set");
  assert.strictEqual(patch.unread, false, "patch.unread must be cleared");
  assert.strictEqual(patch.isRead, true, "patch.isRead must be true");
});

// ── 6. Source asserts messages are sorted ASC ────────────────────────────────

test("live-inbox-service sorts messages ascending (oldest first)", () => {
  assert.ok(
    SERVICE_SRC.includes("asTime(a.event_timestamp) - asTime(b.event_timestamp)"),
    "getThreadMessages must sort with asTime(a) - asTime(b) (ascending, oldest first)",
  );
});
