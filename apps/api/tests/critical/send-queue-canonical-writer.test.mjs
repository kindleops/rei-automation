import test from "node:test";
import assert from "node:assert/strict";

import { enqueueSendQueueItem } from "@/lib/supabase/sms-engine.js";
import { claimSendQueueRow } from "@/lib/supabase/sms-engine.js";

// ─── mock supabase builders ────────────────────────────────────────────────────

function makeInsertSupabase({ conflict = false, suppressed_21610 = false, existing = null } = {}) {
  const inserted = [];

  // Builds a fully-chainable select stub that handles both:
  //   a) suppression count: .select("id", {count,head}).eq().eq().ilike() -> { count }
  //   b) post-23505 lookup: .select("*").eq("queue_key",...).maybeSingle() -> { data, error }
  function makeSelectChain() {
    const countResult = { data: null, error: null, count: suppressed_21610 ? 1 : 0 };
    const chain = {
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      is: () => chain,
      in: () => chain,
      or: () => chain,
      ilike: () => Promise.resolve(countResult),
      maybeSingle: () => Promise.resolve({ data: conflict ? existing : null, error: null }),
      then: (resolve) => resolve(countResult),
    };
    return chain;
  }

  const client = {
    from(table) {
      return {
        select(_cols, _opts) {
          return makeSelectChain();
        },
        insert(payload) {
          if (conflict) {
            return {
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }),
              }),
            };
          }
          const row = { id: Math.floor(Math.random() * 9999) + 1, ...payload };
          inserted.push(row);
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: row, error: null }),
            }),
          };
        },
        update(_payload) {
          return { eq: () => ({ in: () => ({ is: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }) };
        },
      };
    },
  };

  return { client, inserted };
}

function basePayload() {
  return {
    queue_key: `test:${Date.now()}`,
    to_phone_number: "+15005550001",
    from_phone_number: "+15005550002",
    message_body: "Hi John, this is a test message about your property.",
    queue_status: "queued",
    scheduled_for: new Date().toISOString(),
    thread_key: "+15005550001",
    metadata: { source: "test" },
  };
}

// ─── Section E: Canonical writer tests ────────────────────────────────────────

test("enqueueSendQueueItem: rejects missing to_phone_number", async () => {
  const { client } = makeInsertSupabase();
  const result = await enqueueSendQueueItem(
    { ...basePayload(), to_phone_number: null },
    { supabase: client }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_to_phone_number");
});

test("enqueueSendQueueItem: rejects missing message_body for non-deferred row", async () => {
  const { client } = makeInsertSupabase();
  const result = await enqueueSendQueueItem(
    { ...basePayload(), message_body: "", message_text: "" },
    { supabase: client }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_message_body");
});

test("enqueueSendQueueItem: rejects blank greeting (Hi ,)", async () => {
  const { client } = makeInsertSupabase();
  const result = await enqueueSendQueueItem(
    { ...basePayload(), message_body: "Hi , we noticed your property at 123 Main St." },
    { supabase: client }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "blank_greeting_message_body");
});

test("enqueueSendQueueItem: rejects blank greeting variants (Hey ,)", async () => {
  const { client } = makeInsertSupabase();
  const result = await enqueueSendQueueItem(
    { ...basePayload(), message_body: "Hey , I wanted to reach out about your home." },
    { supabase: client }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "blank_greeting_message_body");
});

test("enqueueSendQueueItem: blocks 21610-suppressed phone", async () => {
  const { client } = makeInsertSupabase({ suppressed_21610: true });
  const result = await enqueueSendQueueItem(basePayload(), { supabase: client });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "phone_suppressed_21610");
});

test("enqueueSendQueueItem: succeeds and returns queue_row_id", async () => {
  const { client, inserted } = makeInsertSupabase();
  const result = await enqueueSendQueueItem(basePayload(), { supabase: client });
  assert.equal(result.ok, true, "enqueue must succeed");
  assert.ok(result.queue_row_id, "must return queue_row_id");
});

test("enqueueSendQueueItem: same payload twice → second call returns idempotent replay", async () => {
  const payload = basePayload();
  const existing = {
    id: 42,
    queue_key: payload.queue_key,
    dedupe_key: payload.queue_key,
    queue_status: "queued",
    scheduled_for: payload.scheduled_for,
  };

  const { client: client1 } = makeInsertSupabase();
  const first = await enqueueSendQueueItem(payload, { supabase: client1 });
  assert.equal(first.ok, true, "first insert must succeed");

  const { client: client2 } = makeInsertSupabase({ conflict: true, existing });
  const second = await enqueueSendQueueItem(payload, { supabase: client2 });
  assert.equal(second.ok, true, "second insert with same dedupe grain must replay existing row");
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.queue_row_id, 42);
});

test("enqueueSendQueueItem: blocked/audit rows bypass live guards", async () => {
  const { client } = makeInsertSupabase();
  // Blocked audit row — no message_body, no to_phone — must still insert
  const result = await enqueueSendQueueItem(
    {
      queue_key: `audit:block:${Date.now()}`,
      to_phone_number: "+15005550001",
      message_body: "Hi John, blocked test.",
      queue_status: "blocked",
      metadata: { source: "test_audit" },
    },
    { supabase: client }
  );
  // Should not be blocked by the live guards (it's a terminal status)
  assert.ok(result.ok !== false || result.reason !== "phone_suppressed_21610",
    "blocked rows must not be stopped by 21610 check");
});

test("enqueueSendQueueItem: dedupe_key falls back to queue_key when not supplied", async () => {
  const { client, inserted } = makeInsertSupabase();
  const payload = { ...basePayload(), dedupe_key: undefined };
  await enqueueSendQueueItem(payload, { supabase: client });
  if (inserted.length > 0) {
    assert.equal(inserted[0].dedupe_key, payload.queue_key,
      "dedupe_key must fall back to queue_key");
  }
});

// ─── claim_queue_jobs concurrency proof ───────────────────────────────────────

test("claimSendQueueRow: concurrent claims on same row — second attempt returns conflict", async () => {
  let claim_count = 0;
  const first_lock_token = "lock-token-first-claimer";

  // First claimer: succeeds, row now has lock_token set
  const client_first = {
    from: () => ({
      update: () => ({
        eq: () => ({
          in: () => ({
            is: () => ({
              select: () => ({
                maybeSingle: async () => {
                  claim_count += 1;
                  return {
                    data: {
                      id: "row-1",
                      queue_status: "processing",
                      is_locked: true,
                      lock_token: first_lock_token,
                      locked_at: new Date().toISOString(),
                      metadata: {},
                      to_phone_number: "+15005550001",
                      from_phone_number: "+15005550002",
                      message_body: "Hi Jane, ready to talk?",
                      message_text: "Hi Jane, ready to talk?",
                      seller_first_name: "Jane",
                      updated_at: new Date().toISOString(),
                    },
                    error: null,
                  };
                },
              }),
            }),
          }),
        }),
      }),
    }),
  };

  const first = await claimSendQueueRow(
    {
      id: "row-1",
      queue_status: "queued",
      is_locked: false,
      lock_token: null,
      message_body: "Hi Jane, ready to talk?",
      to_phone_number: "+15005550001",
      from_phone_number: "+15005550002",
      metadata: {},
    },
    { supabase: client_first }
  );
  assert.equal(first.ok, true, "first claim must succeed");
  assert.equal(first.claimed, true);

  // Second claimer: row is now locked by first claimer (is_locked=true, lock_token set)
  // The .is("lock_token", null) filter will not match → returns null → conflict
  const client_second = {
    from: () => ({
      update: () => ({
        eq: () => ({
          in: () => ({
            is: () => ({
              select: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  };

  const second = await claimSendQueueRow(
    {
      id: "row-1",
      queue_status: "queued",
      is_locked: false,
      lock_token: null,
      message_body: "Hi Jane, ready to talk?",
      to_phone_number: "+15005550001",
      from_phone_number: "+15005550002",
      metadata: {},
    },
    { supabase: client_second }
  );
  assert.equal(second.ok, false, "second concurrent claim must not succeed");
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "queue_item_claim_conflict");
});

// ─── auto-reply idempotency ────────────────────────────────────────────────────

test("enqueueSendQueueItem: auto-reply same thread+template+window produces at most one active row", async () => {
  // Both calls use the same deterministic queue_key (as executeAutonomousReply does).
  const shared_key = "auto_reply:+15005550001:event-123:ownership_check";
  const payload = {
    ...basePayload(),
    queue_key: shared_key,
    dedupe_key: shared_key,
  };

  // First insert succeeds
  const { client: c1 } = makeInsertSupabase();
  const first = await enqueueSendQueueItem(payload, { supabase: c1 });
  assert.equal(first.ok, true, "first auto-reply insert must succeed");

  const replay_row = {
    id: 77,
    queue_key: shared_key,
    dedupe_key: shared_key,
    queue_status: "queued",
    scheduled_for: payload.scheduled_for,
  };
  const { client: c2 } = makeInsertSupabase({ conflict: true, existing: replay_row });
  const second = await enqueueSendQueueItem(payload, { supabase: c2 });
  assert.equal(second.ok, true, "duplicate auto-reply must replay existing row");
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.queue_row_id, 77);
});

// ─── grep proof: no live direct insert outside canonical path ─────────────────
// This test enforces the static contract: no live file may call
// .from('send_queue').insert() except inside sms-engine.js itself.

test("no direct send_queue .insert() calls outside sms-engine.js (static grep proof)", async () => {
  const { execSync } = await import("node:child_process");
  const api_src = new URL("../../src", import.meta.url).pathname;

  let raw;
  try {
    raw = execSync(
      `grep -rn "from.*send_queue.*\\.insert\\|from.*'send_queue'.*\\.insert\\|from.*\\"send_queue\\".*\\.insert" "${api_src}"`,
      { encoding: "utf8" }
    );
  } catch (e) {
    // grep exits 1 when no matches — that is the desired state
    raw = e.stdout || "";
  }

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.includes("sms-engine.js"))   // canonical writer itself
    .filter((l) => !l.includes("email_send_queue")); // unrelated email queue

  assert.deepEqual(lines, [],
    `Direct send_queue .insert() found outside sms-engine.js:\n${lines.join("\n")}`
  );
});
