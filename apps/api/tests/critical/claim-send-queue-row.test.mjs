import test from "node:test";
import assert from "node:assert/strict";

import { claimSendQueueRow } from "@/lib/supabase/sms-engine.js";

function makeLegacyClaimHook(accepted_statuses) {
  const accepted = new Set(
    (Array.isArray(accepted_statuses) ? accepted_statuses : [accepted_statuses]).map((s) =>
      String(s).toLowerCase()
    )
  );

  return async (row, patch) => {
    const matched = accepted.has(String(row.queue_status).toLowerCase());
    if (!matched) {
      return { ok: false, claimed: false, reason: "queue_item_claim_conflict", row };
    }
    return {
      ok: true,
      claimed: true,
      reason: "claimed",
      row: { ...row, ...patch },
      lock_token: patch.lock_token,
    };
  };
}

function makeRow(queue_status) {
  return {
    id: "test-row-id",
    queue_status,
    is_locked: false,
    lock_token: null,
    locked_at: null,
    metadata: {},
    to_phone_number: "+15005550006",
    from_phone_number: "+15005550001",
    message_body: "Hello test",
    message_text: "Hello test",
    seller_first_name: "Test",
  };
}

test("claimSendQueueRow succeeds for queue_status=scheduled (regression: was missing from WHERE)", async () => {
  const result = await claimSendQueueRow(makeRow("scheduled"), {
    claimSendQueueRow: makeLegacyClaimHook("scheduled"),
  });

  assert.equal(result.ok, true, "scheduled row must be claimable");
  assert.equal(result.claimed, true);
  assert.equal(result.reason, "claimed");
  assert.ok(result.lock_token, "lock_token must be returned");
});

test("claimSendQueueRow returns queue_item_claim_conflict when WHERE does not match (simulates pre-fix behavior)", async () => {
  const result = await claimSendQueueRow(makeRow("scheduled"), {
    claimSendQueueRow: makeLegacyClaimHook("queued"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "queue_item_claim_conflict");
});

test("claimSendQueueRow succeeds for queue_status=queued (existing behavior preserved)", async () => {
  const result = await claimSendQueueRow(makeRow("queued"), {
    claimSendQueueRow: makeLegacyClaimHook("queued"),
  });
  assert.equal(result.ok, true, "queued row must still be claimable");
  assert.equal(result.claimed, true);
});

test("claimSendQueueRow succeeds for queue_status=pending", async () => {
  const result = await claimSendQueueRow(makeRow("pending"), {
    claimSendQueueRow: makeLegacyClaimHook("pending"),
  });
  assert.equal(result.ok, true, "pending row must be claimable");
});

test("claimSendQueueRow accepts all statuses loaded by loadRunnableSendQueueRows", async () => {
  const runnable_statuses = ["queued", "Queued", "scheduled", "pending", "approved", "ready"];
  for (const status of runnable_statuses) {
    const result = await claimSendQueueRow(makeRow(status), {
      claimSendQueueRow: makeLegacyClaimHook(status),
    });
    assert.equal(result.ok, true, `status="${status}" must be claimable`);
  }
});

test("claimSendQueueRow returns missing_queue_row_id when row has no id", async () => {
  const result = await claimSendQueueRow(
    { queue_status: "scheduled" },
    { claimSendQueueRow: makeLegacyClaimHook("scheduled") }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_queue_row_id");
});