/**
 * Tests for P0 queue send-failure safety guards:
 *
 * 1. isNonRetryableProviderError detection (via finalizeSendQueueFailure behavior)
 *    - 21610 in message → terminal failed on first attempt
 *    - "blacklist rule" in message → terminal
 *    - error.retryable === false → terminal
 *    - Retryable errors (network) → still re-queued until max_retries
 *
 * 2. shouldSuppressDeliveryFailedRecipient
 *    - Same pair >= 2 delivery_failed in 24h → suppress
 *    - Same recipient >= 3 delivery_failed in 7d (any sender) → suppress
 *    - Below thresholds → no suppress
 *    - DB error → no suppress (non-fatal)
 *
 * 3. checkBlacklistPriorFailure
 *    - Prior 21610 row for same pair → blocked
 *    - No prior 21610 → not blocked
 *    - DB error → not blocked (non-fatal)
 *
 * 4. createInboxSendNowQueueRow guard
 *    - Prior 21610 → returns provider_blacklist_pair, no row created
 *    - Repeated delivery_failed → returns recent_delivery_failures, no row created
 *    - Clean number → row created normally
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  finalizeSendQueueFailure,
  checkBlacklistPriorFailure,
  shouldSuppressDeliveryFailedRecipient,
} from "../../src/lib/supabase/sms-engine.js";
import { createInboxSendNowQueueRow } from "../../src/lib/domain/inbox/send-now-service.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const BASE_ROW = {
  id: "test-row-uuid-001",
  queue_status: "sending",
  retry_count: 0,
  max_retries: 3,
  from_phone_number: "+13235589881",
  to_phone_number: "+16023329348",
  message_body: "Hi there",
  metadata: {},
};

const LOCK_TOKEN = "test-lock-token";

function makeUpdateSendQueueRowWithLock(captured) {
  return async (row_id, lock_token, payload) => {
    captured.push({ row_id, lock_token, payload });
    return { ...BASE_ROW, ...payload, id: row_id };
  };
}

// ─── P0-1: finalizeSendQueueFailure — non-retryable detection ────────────────

test("finalizeSendQueueFailure: 21610 in message → terminal failed on first attempt", async () => {
  const captured = [];
  const deps = { updateSendQueueRowWithLock: makeUpdateSendQueueRowWithLock(captured) };
  const error = new Error(
    'TextGrid HTTP failure: {"status":"400","code":"21610","message":"The message From/To pair violates a blacklist rule."}'
  );

  const result = await finalizeSendQueueFailure(BASE_ROW, LOCK_TOKEN, error, deps);

  assert.equal(captured.length, 1, "should call updateSendQueueRowWithLock once");
  const { payload } = captured[0];

  assert.equal(payload.queue_status, "failed", "must be failed — not queued");
  assert.equal(payload.next_retry_at, null, "no retry scheduled");
  assert.equal(payload.retry_count, 1, "retry_count incremented");
  assert.equal(payload.metadata.provider_error.retryable, false);
  assert.equal(
    payload.metadata.provider_error.non_retryable_reason,
    "textgrid_21610_blacklist"
  );
  assert.equal(payload.metadata.failure_bucket, "provider_blacklist_pair");
  assert.equal(payload.metadata.final_failure, true);
  assert.equal(result.queue_status, "failed");
});

test("finalizeSendQueueFailure: 'blacklist rule' phrase → terminal failed on first attempt", async () => {
  const captured = [];
  const deps = { updateSendQueueRowWithLock: makeUpdateSendQueueRowWithLock(captured) };
  const error = new Error("The message From/To pair violates a blacklist rule.");

  const result = await finalizeSendQueueFailure(BASE_ROW, LOCK_TOKEN, error, deps);

  const { payload } = captured[0];
  assert.equal(payload.queue_status, "failed");
  assert.equal(payload.next_retry_at, null);
  assert.equal(payload.metadata.failure_bucket, "provider_blacklist_pair");
});

test("finalizeSendQueueFailure: error.retryable=false → terminal failed on first attempt", async () => {
  const captured = [];
  const deps = { updateSendQueueRowWithLock: makeUpdateSendQueueRowWithLock(captured) };
  const error = Object.assign(new Error("provider rejected"), { retryable: false });

  const result = await finalizeSendQueueFailure(BASE_ROW, LOCK_TOKEN, error, deps);

  const { payload } = captured[0];
  assert.equal(payload.queue_status, "failed");
  assert.equal(payload.next_retry_at, null);
});

test("finalizeSendQueueFailure: retryable network error → re-queued with backoff on first attempt", async () => {
  const captured = [];
  const deps = { updateSendQueueRowWithLock: makeUpdateSendQueueRowWithLock(captured) };
  const error = new Error("Network error: connection timed out");

  const result = await finalizeSendQueueFailure(BASE_ROW, LOCK_TOKEN, error, deps);

  const { payload } = captured[0];
  assert.equal(payload.queue_status, "queued", "retryable error must re-queue");
  assert.ok(payload.next_retry_at !== null, "next_retry_at must be set");
  assert.equal(payload.metadata.provider_error.retryable, true);
  assert.equal(payload.metadata.failure_bucket, undefined, "no failure_bucket for retryable");
});

test("finalizeSendQueueFailure: retryable error exhausted at max_retries → terminal failed", async () => {
  const captured = [];
  const deps = { updateSendQueueRowWithLock: makeUpdateSendQueueRowWithLock(captured) };
  const error = new Error("Network error");

  const exhausted_row = { ...BASE_ROW, retry_count: 2, max_retries: 3 };
  await finalizeSendQueueFailure(exhausted_row, LOCK_TOKEN, error, deps);

  const { payload } = captured[0];
  assert.equal(payload.queue_status, "failed", "must fail after max retries");
  assert.equal(payload.next_retry_at, null);
  assert.equal(payload.retry_count, 3);
});

test("finalizeSendQueueFailure: 21610 at retry_count=0 never becomes queued (regression)", async () => {
  const captured = [];
  const deps = { updateSendQueueRowWithLock: makeUpdateSendQueueRowWithLock(captured) };

  // Simulate all 3 retry positions — each must be terminal
  for (let retry_count = 0; retry_count < 3; retry_count++) {
    captured.length = 0;
    const row = { ...BASE_ROW, retry_count };
    const error = new Error('TextGrid HTTP failure: {"code":"21610","message":"The message From/To pair violates a blacklist rule."}');
    await finalizeSendQueueFailure(row, LOCK_TOKEN, error, deps);
    const { payload } = captured[0];
    assert.equal(
      payload.queue_status,
      "failed",
      `retry_count=${retry_count} should be terminal, not ${payload.queue_status}`
    );
  }
});

// ─── P0-2: shouldSuppressDeliveryFailedRecipient ──────────────────────────────

function makeSupabaseCount(count) {
  return {
    from: () => ({
      select: () => ({
        eq: function () { return this; },
        ilike: function () { return this; },
        gte: function () { return this; },
        then: (resolve) => resolve({ count, error: null }),
        // make chainable .eq/.gte return same object
      }),
    }),
  };
}

// Helper that returns different counts for pair vs recipient queries
function makeSupabaseCountSequence(counts) {
  let call_index = 0;
  const makeChain = (count) => {
    const chain = {
      eq: function () { return this; },
      ilike: function () { return this; },
      gte: function () { return this; },
      then: (resolve) => resolve({ count, error: null }),
    };
    // Thenable support for await
    chain[Symbol.asyncIterator] = undefined;
    return chain;
  };

  return {
    from: () => ({
      select: () => {
        const c = counts[call_index] ?? 0;
        call_index++;
        return makeChain(c);
      },
    }),
  };
}

test("shouldSuppressDeliveryFailedRecipient: same pair >= 2 in 24h → suppress", async () => {
  // pair_count=2, so the first check fires
  const supabase = makeSupabaseCountSequence([2]);
  const result = await shouldSuppressDeliveryFailedRecipient(
    { to_phone_number: "+12523143567", from_phone_number: "+19804589889" },
    { supabase }
  );
  assert.equal(result.suppress, true);
  assert.equal(result.reason, "repeated_delivery_failed_same_pair");
  assert.equal(result.window, "24h");
});

test("shouldSuppressDeliveryFailedRecipient: pair < 2 but recipient >= 3 in 7d → suppress", async () => {
  // pair_count=1 (no pair block), recipient_count=4 (block)
  const supabase = makeSupabaseCountSequence([1, 4]);
  const result = await shouldSuppressDeliveryFailedRecipient(
    { to_phone_number: "+12523143567", from_phone_number: "+19804589889" },
    { supabase }
  );
  assert.equal(result.suppress, true);
  assert.equal(result.reason, "repeated_delivery_failed_recipient");
  assert.equal(result.window, "7d");
});

test("shouldSuppressDeliveryFailedRecipient: below all thresholds → no suppress", async () => {
  // pair=1, recipient=2 — neither threshold met
  const supabase = makeSupabaseCountSequence([1, 2]);
  const result = await shouldSuppressDeliveryFailedRecipient(
    { to_phone_number: "+12523143567", from_phone_number: "+19804589889" },
    { supabase }
  );
  assert.equal(result.suppress, false);
});

test("shouldSuppressDeliveryFailedRecipient: missing to_phone → no suppress", async () => {
  const result = await shouldSuppressDeliveryFailedRecipient(
    { to_phone_number: "", from_phone_number: "+19804589889" },
    {}
  );
  assert.equal(result.suppress, false);
});

test("shouldSuppressDeliveryFailedRecipient: DB error → non-fatal, no suppress", async () => {
  const supabase = {
    from: () => ({ select: () => { throw new Error("DB unavailable"); } }),
  };
  const result = await shouldSuppressDeliveryFailedRecipient(
    { to_phone_number: "+12523143567", from_phone_number: "+19804589889" },
    { supabase }
  );
  assert.equal(result.suppress, false, "DB error must not suppress");
});

// ─── P0-3: checkBlacklistPriorFailure ────────────────────────────────────────

test("checkBlacklistPriorFailure: prior 21610 row found → blocked", async () => {
  const supabase = makeSupabaseCountSequence([1]);
  const result = await checkBlacklistPriorFailure(
    { to_phone_number: "+16023329348", from_phone_number: "+13235589881" },
    { supabase }
  );
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "prior_blacklist_21610");
  assert.equal(result.count, 1);
});

test("checkBlacklistPriorFailure: no prior 21610 → not blocked", async () => {
  const supabase = makeSupabaseCountSequence([0]);
  const result = await checkBlacklistPriorFailure(
    { to_phone_number: "+16023329348", from_phone_number: "+13235589881" },
    { supabase }
  );
  assert.equal(result.blocked, false);
});

test("checkBlacklistPriorFailure: missing from_phone → not blocked (no check possible)", async () => {
  const result = await checkBlacklistPriorFailure(
    { to_phone_number: "+16023329348", from_phone_number: "" },
    {}
  );
  assert.equal(result.blocked, false);
});

test("checkBlacklistPriorFailure: DB error → non-fatal, not blocked", async () => {
  const supabase = {
    from: () => ({ select: () => { throw new Error("timeout"); } }),
  };
  const result = await checkBlacklistPriorFailure(
    { to_phone_number: "+16023329348", from_phone_number: "+13235589881" },
    { supabase }
  );
  assert.equal(result.blocked, false);
});

// ─── P0-4: createInboxSendNowQueueRow guards ────────────────────────────────

const VALID_PAYLOAD = {
  thread_key: "+12146072916",
  to_phone_number: "+12146072916",
  from_phone_number: "+18885551212",
  message_body: "Test message",
};

test("createInboxSendNowQueueRow: prior 21610 → blocked with provider_blacklist_pair, no row inserted", async () => {
  let insert_called = false;

  // blacklist check returns 1 prior failure, suppression returns clean
  const supabase = makeSupabaseCountSequence([1, 0, 0]);

  const result = await createInboxSendNowQueueRow(VALID_PAYLOAD, {
    insertImpl: async () => { insert_called = true; return { ok: true }; },
    resolveFromImpl: async () => null,
    supabase,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_blacklist_pair");
  assert.equal(result.queue_created, false);
  assert.equal(insert_called, false, "must not insert when blacklist blocked");
});

test("createInboxSendNowQueueRow: repeated delivery_failed → blocked with recent_delivery_failures, no row inserted", async () => {
  let insert_called = false;

  // blacklist=0, pair delivery_failed=3 → suppressed
  const supabase = makeSupabaseCountSequence([0, 3]);

  const result = await createInboxSendNowQueueRow(VALID_PAYLOAD, {
    insertImpl: async () => { insert_called = true; return { ok: true }; },
    resolveFromImpl: async () => null,
    supabase,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "recent_delivery_failures");
  assert.equal(result.queue_created, false);
  assert.equal(insert_called, false, "must not insert when delivery suppressed");
});

test("createInboxSendNowQueueRow: clean number → row inserted normally", async () => {
  let insert_called = false;

  // blacklist=0, pair=0, recipient=0 → clean
  const supabase = makeSupabaseCountSequence([0, 0, 0]);

  const result = await createInboxSendNowQueueRow(VALID_PAYLOAD, {
    insertImpl: async (row) => {
      insert_called = true;
      return { ok: true, queue_id: row.queue_id || row.queue_key };
    },
    resolveFromImpl: async () => null,
    supabase,
  });

  assert.equal(result.ok, true);
  assert.equal(result.queue_created, true);
  assert.equal(insert_called, true, "must insert when checks pass");
});

test("createInboxSendNowQueueRow: guard DB failure → row still inserted (non-fatal)", async () => {
  let insert_called = false;

  // Supabase that throws on the guard query
  const supabase = {
    from: () => ({
      select: () => { throw new Error("DB offline"); },
      eq: function () { return this; },
      maybeSingle: async () => ({ data: null }),
    }),
  };

  const result = await createInboxSendNowQueueRow(VALID_PAYLOAD, {
    insertImpl: async (row) => {
      insert_called = true;
      return { ok: true, queue_id: row.queue_key };
    },
    resolveFromImpl: async () => null,
    supabase,
  });

  assert.equal(result.ok, true, "guard failure must not block the send");
  assert.equal(insert_called, true);
});
