/**
 * textgrid-status-delivery-guard.test.mjs
 *
 * Tests for:
 * 1. TEXTGRID_STATUS_CALLBACK_ENABLED feature flag — outbound send payload must
 *    NOT include StatusCallback when the flag is false (default).
 * 2. Intermediate delivery status normalization — queued/pending/awaiting_response
 *    must NOT be written as delivery_status on message_events rows; only
 *    delivered/failed/undelivered are final delivery states.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildTextgridSendPayload } from "@/lib/providers/textgrid.js";
import { syncDeliveryEvent } from "@/lib/supabase/sms-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSyncDeliveryDeps({ existing_delivery_status = "sent", sent_at = null } = {}) {
  const message_events_rows = [
    {
      id: 9001,
      thread_key: "5551234567",
      queue_id: null,
      metadata: {},
      delivery_status: existing_delivery_status,
      sent_at: sent_at || "2026-05-27T10:00:00.000Z",
      delivered_at: null,
      failed_at: null,
    },
  ];

  const updates = [];
  const queue_updates = [];

  function makeChain(table, row_data) {
    let update_payload = null;
    let is_update = false;
    let filter_or_clause = null;
    let is_single = false;

    const resolve_value = () => {
      if (is_update) {
        if (table === "message_events") updates.push({ table, payload: update_payload });
        if (table === "send_queue") queue_updates.push({ table, payload: update_payload, or: filter_or_clause });
        return is_single ? { data: null, error: null } : { data: [], error: null };
      }
      return is_single
        ? { data: row_data[0] ?? null, error: null }
        : { data: row_data, error: null };
    };

    const chain = {
      select: () => chain,
      not: () => chain,
      is: () => chain,
      neq: () => chain,
      eq: () => chain,
      limit: () => chain,
      maybeSingle() {
        is_single = true;
        return chain;
      },
      single() {
        is_single = true;
        return chain;
      },
      or(clause) {
        filter_or_clause = clause;
        return chain;
      },
      update(payload) {
        is_update = true;
        update_payload = payload;
        return chain;
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(resolve_value()).then(onFulfilled, onRejected);
      },
      catch(onRejected) {
        return Promise.resolve(resolve_value()).catch(onRejected);
      },
    };
    return chain;
  }

  const supabase = {
    from(table) {
      if (table === "message_events") return makeChain(table, message_events_rows);
      if (table === "send_queue") return makeChain(table, []);
      if (table === "inbox_thread_state") return makeChain(table, []);
      return makeChain(table, []);
    },
  };

  return { supabase, updates, queue_updates };
}

// ---------------------------------------------------------------------------
// Feature flag tests — buildTextgridSendPayload
// ---------------------------------------------------------------------------

test("buildTextgridSendPayload: does NOT include StatusCallback by default", () => {
  const payload = buildTextgridSendPayload({ body: "Hello", from: "+15550001111", to: "+15550002222" });
  assert.ok(!("StatusCallback" in payload), "StatusCallback must not be present when not provided");
  assert.equal(payload.body, "Hello");
  assert.equal(payload.from, "+15550001111");
  assert.equal(payload.to, "+15550002222");
});

test("buildTextgridSendPayload: does NOT include StatusCallback when statusCallback is null", () => {
  const payload = buildTextgridSendPayload({
    body: "Hello",
    from: "+15550001111",
    to: "+15550002222",
    statusCallback: null,
  });
  assert.ok(!("StatusCallback" in payload), "StatusCallback must not be present when null");
});

test("buildTextgridSendPayload: does NOT include StatusCallback when statusCallback is empty string", () => {
  const payload = buildTextgridSendPayload({
    body: "Hello",
    from: "+15550001111",
    to: "+15550002222",
    statusCallback: "",
  });
  assert.ok(!("StatusCallback" in payload), "StatusCallback must not be present when empty string");
});

test("buildTextgridSendPayload: DOES include StatusCallback when a URL is provided", () => {
  const callback_url = "https://example.com/webhooks/textgrid/delivery";
  const payload = buildTextgridSendPayload({
    body: "Hello",
    from: "+15550001111",
    to: "+15550002222",
    statusCallback: callback_url,
  });
  assert.equal(payload.StatusCallback, callback_url, "StatusCallback must equal the provided URL");
});

// ---------------------------------------------------------------------------
// syncDeliveryEvent: intermediate statuses must not overwrite delivery_status
// ---------------------------------------------------------------------------

test("syncDeliveryEvent: queued provider status does not write 'queued' to delivery_status", async () => {
  const { supabase, updates } = makeSyncDeliveryDeps({ existing_delivery_status: "sent" });

  await syncDeliveryEvent(
    { message_id: "SM_test_queued", status: "queued" },
    { supabase, now: "2026-05-27T10:05:00.000Z" }
  );

  const me_update = updates.find((u) => u.table === "message_events");
  if (me_update) {
    assert.notEqual(
      me_update.payload.delivery_status,
      "queued",
      "delivery_status must NOT be set to 'queued'"
    );
    assert.ok(
      ["sent", "delivered", "failed", "undelivered", undefined].includes(me_update.payload.delivery_status),
      `delivery_status must be a canonical value, got: ${me_update.payload.delivery_status}`
    );
  }
  // provider_delivery_status may still store the raw value
  if (me_update) {
    assert.equal(me_update.payload.provider_delivery_status, "queued", "raw provider_delivery_status should preserve 'queued'");
  }
});

test("syncDeliveryEvent: pending provider status does not write 'pending' to delivery_status", async () => {
  const { supabase, updates } = makeSyncDeliveryDeps({ existing_delivery_status: "sent" });

  await syncDeliveryEvent(
    { message_id: "SM_test_pending", status: "pending" },
    { supabase, now: "2026-05-27T10:05:00.000Z" }
  );

  const me_update = updates.find((u) => u.table === "message_events");
  if (me_update) {
    assert.notEqual(me_update.payload.delivery_status, "pending", "delivery_status must NOT be 'pending'");
    assert.ok(
      ["sent", "delivered", "failed", "undelivered", undefined].includes(me_update.payload.delivery_status),
      `got unexpected delivery_status: ${me_update.payload.delivery_status}`
    );
  }
});

test("syncDeliveryEvent: awaiting_response provider status does not write 'awaiting_response' to delivery_status", async () => {
  const { supabase, updates } = makeSyncDeliveryDeps({ existing_delivery_status: "sent" });

  await syncDeliveryEvent(
    { message_id: "SM_test_awaiting", status: "awaiting_response" },
    { supabase, now: "2026-05-27T10:05:00.000Z" }
  );

  const me_update = updates.find((u) => u.table === "message_events");
  if (me_update) {
    assert.notEqual(
      me_update.payload.delivery_status,
      "awaiting_response",
      "delivery_status must NOT be 'awaiting_response'"
    );
  }
});

test("syncDeliveryEvent: delivered callback promotes delivery_status to 'delivered'", async () => {
  const { supabase, updates } = makeSyncDeliveryDeps({ existing_delivery_status: "sent" });

  await syncDeliveryEvent(
    { message_id: "SM_test_delivered", status: "delivered" },
    { supabase, now: "2026-05-27T10:10:00.000Z" }
  );

  const me_update = updates.find((u) => u.table === "message_events");
  assert.ok(me_update, "must have written an update to message_events");
  assert.equal(me_update.payload.delivery_status, "delivered", "delivery_status must be 'delivered'");
});

test("syncDeliveryEvent: failed callback sets delivery_status to 'failed'", async () => {
  const { supabase, updates } = makeSyncDeliveryDeps({ existing_delivery_status: "sent" });

  await syncDeliveryEvent(
    { message_id: "SM_test_failed", status: "failed", error_message: "Carrier rejected", error_status: "30003" },
    { supabase, now: "2026-05-27T10:10:00.000Z" }
  );

  const me_update = updates.find((u) => u.table === "message_events");
  assert.ok(me_update, "must have written an update to message_events");
  assert.equal(me_update.payload.delivery_status, "failed", "delivery_status must be 'failed'");
});

test("syncDeliveryEvent: undelivered callback sets delivery_status to 'failed'", async () => {
  const { supabase, updates } = makeSyncDeliveryDeps({ existing_delivery_status: "sent" });

  await syncDeliveryEvent(
    { message_id: "SM_test_undelivered", status: "undelivered" },
    { supabase, now: "2026-05-27T10:10:00.000Z" }
  );

  const me_update = updates.find((u) => u.table === "message_events");
  assert.ok(me_update, "must have written an update to message_events");
  assert.equal(me_update.payload.delivery_status, "failed", "undelivered must map to 'failed'");
});

test("syncDeliveryEvent: does not downgrade delivery_status from 'delivered' when intermediate status arrives", async () => {
  const { supabase, updates } = makeSyncDeliveryDeps({ existing_delivery_status: "delivered" });

  await syncDeliveryEvent(
    { message_id: "SM_test_no_downgrade", status: "queued" },
    { supabase, now: "2026-05-27T10:15:00.000Z" }
  );

  const me_update = updates.find((u) => u.table === "message_events");
  if (me_update) {
    assert.equal(
      me_update.payload.delivery_status,
      "delivered",
      "delivery_status must stay 'delivered' even when a late 'queued' webhook arrives"
    );
  }
});

test("syncDeliveryEvent: returns early with skipped reason when message_id is missing", async () => {
  const { supabase } = makeSyncDeliveryDeps();

  const result = await syncDeliveryEvent(
    { status: "delivered" },
    { supabase, now: "2026-05-27T10:20:00.000Z" }
  );

  assert.equal(result.skipped, "missing_provider_message_sid");
  assert.equal(result.message_events_count, 0);
});
