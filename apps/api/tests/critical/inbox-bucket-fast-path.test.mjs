import test from "node:test";
import assert from "node:assert/strict";
import { makeLiveInboxThreadSupabase } from "../helpers/chainable-supabase.mjs";
import { getLiveInbox } from "../../src/lib/domain/inbox/live-inbox-service.js";

test("manual bucket switch uses authoritative inbox_thread_state for non-all filters", async () => {
  const supabase = makeLiveInboxThreadSupabase([], {
    stateRows: [
      {
        thread_key: "+15551230001",
        seller_phone: "+15551230001",
        canonical_e164: "+15551230001",
        inbox_bucket: "new_replies",
        latest_message_body: "Yes I still own it",
        latest_message_at: "2026-06-27T12:00:00.000Z",
        latest_direction: "inbound",
        is_read: false,
        is_suppressed: false,
        message_count: 2,
        inbound_count: 1,
        outbound_count: 1,
      },
      {
        thread_key: "+15551230002",
        seller_phone: "+15551230002",
        canonical_e164: "+15551230002",
        inbox_bucket: "priority",
        latest_message_body: "What's your offer",
        latest_message_at: "2026-06-27T11:00:00.000Z",
        latest_direction: "inbound",
        is_read: false,
        is_suppressed: false,
        message_count: 3,
        inbound_count: 2,
        outbound_count: 1,
      },
    ],
  });

  const newReplies = await getLiveInbox(
    {
      filter: "new_replies",
      timeout_mode: "manual_bucket_switch",
      limit: 10,
      skip_counts: "1",
      skip_delivery: "1",
    },
    { listOnly: true, skipCounts: true, skipDelivery: true },
    { supabase },
  );

  assert.equal(newReplies.threads.length, 1, "new_replies bucket must return matching rows");
  assert.equal(newReplies.threads[0].thread_key, "+15551230001");

  const priority = await getLiveInbox(
    {
      filter: "priority",
      timeout_mode: "manual_bucket_switch",
      limit: 10,
      skip_counts: "1",
      skip_delivery: "1",
    },
    { listOnly: true, skipCounts: true, skipDelivery: true },
    { supabase },
  );

  assert.equal(priority.threads.length, 1, "priority bucket must return matching rows");
  assert.equal(priority.threads[0].thread_key, "+15551230002");
});