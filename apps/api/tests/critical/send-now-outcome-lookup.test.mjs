/**
 * "DID MY SEND GO OUT?" IS ANSWERED FROM THE DURABLE ROW, READ-ONLY.
 *
 * When the composer loses the send-now response it must confirm by
 * client_send_id instead of declaring failure (2026-09-30: a delivered send was
 * shown as "Send Failed" with a Retry button). These pin the lookup contract:
 * the most advanced row wins, "could not look" is never "not found", the query
 * stays on the indexed thread, and the route validates before touching the DB.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SEND_OUTCOME_STATES,
  classifyManualSendRow,
  lookupManualSendOutcome,
  summarizeManualSendOutcome,
} from "@/lib/domain/inbox/send-now-outcome.js";
import { GET as sendStatusGet } from "@/app/api/cockpit/inbox/send-status/route.js";

const CLIENT_SEND_ID = "15bab2b9-3fe0-462a-aa77-0a2a8bf10c3e";
const THREAD = "+16125550123";

function makeQuerySupabase(result) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, select: null, filters: [], order: null, limit: null };
      calls.push(call);
      const builder = {
        select(columns) {
          call.select = columns;
          return builder;
        },
        eq(column, value) {
          call.filters.push([column, value]);
          return builder;
        },
        order(column, options) {
          call.order = [column, options];
          return builder;
        },
        limit(n) {
          call.limit = n;
          return Promise.resolve(result);
        },
      };
      return builder;
    },
  };
}

test("classifyManualSendRow maps queue states to operator outcomes", () => {
  assert.equal(classifyManualSendRow({ queue_status: "delivered" }), SEND_OUTCOME_STATES.DELIVERED);
  assert.equal(classifyManualSendRow({ queue_status: "sent" }), SEND_OUTCOME_STATES.SENT);
  for (const status of ["queued", "processing", "sending", "scheduled", "pending", "ready"]) {
    assert.equal(classifyManualSendRow({ queue_status: status }), SEND_OUTCOME_STATES.IN_FLIGHT, status);
  }
  for (const status of ["failed", "failed_transport", "cancelled", "blocked", "expired", "paused_invalid_queue_row"]) {
    assert.equal(classifyManualSendRow({ queue_status: status }), SEND_OUTCOME_STATES.FAILED, status);
  }
});

test("summarize: the most advanced row of one click wins; ties go to the newest", () => {
  const summary = summarizeManualSendOutcome(
    [
      { id: "blocked-first", queue_status: "cancelled", created_at: "2026-09-30T14:51:10Z" },
      { id: "override-sent", queue_status: "sent", provider_message_id: "SMabc", sent_at: "2026-09-30T14:51:20Z", created_at: "2026-09-30T14:51:19Z" },
    ],
    CLIENT_SEND_ID
  );
  assert.equal(summary.found, true);
  assert.equal(summary.state, SEND_OUTCOME_STATES.SENT);
  assert.equal(summary.terminal, true);
  assert.equal(summary.queue_row_id, "override-sent");
  assert.equal(summary.provider_message_id, "SMabc");
  assert.equal(summary.row_count, 2);

  const in_flight = summarizeManualSendOutcome([{ id: "p", queue_status: "processing" }], CLIENT_SEND_ID);
  assert.equal(in_flight.state, SEND_OUTCOME_STATES.IN_FLIGHT);
  assert.equal(in_flight.terminal, false, "still working: the client must keep confirming, not give up");

  const newest = summarizeManualSendOutcome(
    [
      { id: "old", queue_status: "failed", created_at: "2026-09-30T14:00:00Z" },
      { id: "new", queue_status: "failed", created_at: "2026-09-30T14:05:00Z" },
    ],
    CLIENT_SEND_ID
  );
  assert.equal(newest.queue_row_id, "new");

  const none = summarizeManualSendOutcome([], CLIENT_SEND_ID);
  assert.equal(none.found, false);
  assert.equal(none.state, SEND_OUTCOME_STATES.NOT_FOUND);
  assert.equal(none.terminal, false);
});

test("lookup reads one thread's rows by client_send_id, read-only, bounded", async () => {
  const supabase = makeQuerySupabase({
    data: [{ id: "fc39b22b", queue_status: "delivered", provider_message_id: "SMO7", created_at: "2026-09-30T14:51:19Z" }],
    error: null,
  });
  const result = await lookupManualSendOutcome({ client_send_id: CLIENT_SEND_ID, thread_key: THREAD }, { supabase });

  assert.equal(result.ok, true);
  assert.equal(result.state, SEND_OUTCOME_STATES.DELIVERED);
  assert.equal(result.queue_row_id, "fc39b22b");
  assert.equal(supabase.calls.length, 1);
  const [call] = supabase.calls;
  assert.equal(call.table, "send_queue");
  assert.deepEqual(call.filters, [
    ["thread_key", THREAD],
    ["metadata->>client_send_id", CLIENT_SEND_ID],
  ]);
  assert.equal(call.limit, 10);
  assert.ok(!call.select.split(",").includes("metadata"), "never returns row metadata (PII-bearing) to the browser");
});

test("lookup: a database error is 'unknown' (503), never 'not found'", async () => {
  const supabase = makeQuerySupabase({ data: null, error: { message: "canceling statement due to statement timeout" } });
  const result = await lookupManualSendOutcome({ client_send_id: CLIENT_SEND_ID, thread_key: THREAD }, { supabase });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, "send_outcome_lookup_failed");
  assert.equal(result.state, undefined);
});

test("lookup validates before querying", async () => {
  const supabase = makeQuerySupabase({ data: [], error: null });
  const bad_id = await lookupManualSendOutcome({ client_send_id: "not-a-uuid", thread_key: THREAD }, { supabase });
  assert.equal(bad_id.status, 400);
  assert.equal(bad_id.error, "invalid_client_send_id");
  const bad_thread = await lookupManualSendOutcome({ client_send_id: CLIENT_SEND_ID, thread_key: "6125550123" }, { supabase });
  assert.equal(bad_thread.status, 400);
  assert.equal(bad_thread.error, "invalid_thread_key");
  assert.equal(supabase.calls.length, 0);
});

test("GET /api/cockpit/inbox/send-status requires dashboard auth and validates input", async () => {
  const unauthenticated = await sendStatusGet(
    new Request(`http://localhost/api/cockpit/inbox/send-status?client_send_id=${CLIENT_SEND_ID}&thread_key=%2B16125550123`)
  );
  assert.equal(unauthenticated.status, 401);

  const invalid = await sendStatusGet(
    new Request("http://localhost/api/cockpit/inbox/send-status?client_send_id=nope&thread_key=%2B16125550123", {
      headers: { "x-ops-dashboard-secret": "test" },
    })
  );
  assert.equal(invalid.status, 400);
  const body = await invalid.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "invalid_client_send_id");
  assert.equal(invalid.headers.get("cache-control"), "no-store");
});
