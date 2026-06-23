import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveInboxBucketFromClassification,
  resolveThreadFlagsFromClassification,
} from "../../src/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import { getLiveInbox } from "../../src/lib/domain/inbox/live-inbox-service.js";

function makeSupabaseStub(rows = []) {
  const countForBucket = (bucket) =>
    rows.filter((row) => row.inbox_bucket === bucket).length;

  return {
    from(table) {
      const state = { table, filters: [], head: false, countMode: null, range: null };
      const api = {
        select(cols, opts = {}) {
          if (opts?.count) state.countMode = opts.count;
          if (opts?.head) state.head = true;
          return api;
        },
        eq(col, val) {
          state.filters.push({ type: "eq", col, val });
          return api;
        },
        not() { return api; },
        neq() { return api; },
        is(col, val) {
          state.filters.push({ type: "is", col, val });
          return api;
        },
        range(start, end) {
          state.range = [start, end];
          return api;
        },
        in() { return api; },
        lt() { return api; },
        or() { return api; },
        order() { return api; },
        limit() { return api; },
        async then(resolve) {
          if (table === "inbox_thread_state" && state.head && state.countMode === "exact") {
            const bucketFilter = state.filters.find((f) => f.type === "eq" && f.col === "inbox_bucket");
            const laneFilter = state.filters.find((f) => f.type === "eq" && f.col === "automation_lane");
            const unlinkedFilter = state.filters.find((f) => f.type === "is" && f.col === "property_id");
            let count = rows.length;
            if (bucketFilter) count = countForBucket(bucketFilter.val);
            if (laneFilter?.val === "cold_reactivation") {
              count = rows.filter((row) => row.automation_lane === "cold_reactivation").length;
            }
            if (unlinkedFilter) {
              count = rows.filter((row) => row.property_id == null).length;
            }
            return resolve({ count, data: null, error: null });
          }

          let data = table === "canonical_inbox_threads" || table === "v_inbox_threads_live_v2"
            ? [...rows]
            : table === "inbox_thread_state"
              ? [...rows]
              : [];

          for (const filter of state.filters) {
            if (filter.type === "eq") {
              data = data.filter((row) => String(row[filter.col] ?? "") === String(filter.val ?? ""));
            }
            if (filter.type === "is" && filter.val === null) {
              data = data.filter((row) => row[filter.col] == null);
            }
          }

          if (state.range) {
            data = data.slice(state.range[0], state.range[1] + 1);
          }

          return resolve({ data, count: data.length, error: null });
        },
      };
      return api;
    },
  };
}

test("outbound sent → Waiting", () => {
  const existingState = {
    inbox_bucket: "new_replies",
    primary_intent: "who_is_this",
    last_inbound_at: "2026-06-20T12:00:00.000Z",
  };
  const bucket = resolveInboxBucketFromClassification(
    {},
    { direction: "outbound", sent_at: "2026-06-23T12:00:00.000Z" },
    existingState,
  );
  assert.equal(bucket, "waiting");
});

test("inbound reply → New Replies", () => {
  const bucket = resolveInboxBucketFromClassification(
    { primary_intent: "who_is_this" },
    { direction: "inbound" },
    {},
  );
  assert.equal(bucket, "new_replies");
});

test("urgent negotiation → Priority", () => {
  const bucket = resolveInboxBucketFromClassification(
    { primary_intent: "asking_price_provided" },
    { direction: "inbound" },
    {},
  );
  assert.equal(bucket, "priority");
});

test("terminal opt-out → suppressed flags and bucket", () => {
  const flags = resolveThreadFlagsFromClassification({ compliance_flag: "stop_texting" });
  const bucket = resolveInboxBucketFromClassification(
    { compliance_flag: "stop_texting" },
    { direction: "inbound" },
    {},
  );
  assert.equal(flags.opt_out, true);
  assert.equal(bucket, "suppressed");
});

test("system failure after retry exhaustion → Needs Review", () => {
  const bucket = resolveInboxBucketFromClassification(
    {
      primary_intent: "unclear",
      automation_decision: { system_failure: true, retry_exhausted: true },
    },
    { direction: "inbound" },
    {},
  );
  assert.equal(bucket, "needs_review");
});

test("count/list equality for waiting bucket", async () => {
  const rows = [
    {
      thread_key: "+15550000001",
      canonical_thread_key: "+15550000001",
      canonical_e164: "+15550000001",
      latest_message_at: "2026-06-23T10:00:00.000Z",
      latest_message_direction: "outbound",
      latest_message_body: "Following up",
      inbox_bucket: "waiting",
      property_id: "prop-1",
    },
    {
      thread_key: "+15550000002",
      canonical_thread_key: "+15550000002",
      canonical_e164: "+15550000002",
      latest_message_at: "2026-06-23T09:00:00.000Z",
      latest_message_direction: "outbound",
      latest_message_body: "Checking in",
      inbox_bucket: "waiting",
      property_id: "prop-2",
    },
    {
      thread_key: "+15550000003",
      canonical_thread_key: "+15550000003",
      canonical_e164: "+15550000003",
      latest_message_at: "2026-06-23T08:00:00.000Z",
      latest_message_direction: "inbound",
      latest_message_body: "Yes",
      inbox_bucket: "new_replies",
      property_id: "prop-3",
    },
  ];

  const supabase = makeSupabaseStub(rows);
  const result = await getLiveInbox(
    { filter: "waiting", skip_delivery: "true", limit: 50 },
    { supabase, preferredThreadSource: "canonical_inbox_threads" },
  );

  assert.equal(result.counts.waiting, 2);
  assert.equal(result.threads.length, 2);
  assert.ok(result.threads.every((thread) => thread.inbox_bucket === "waiting"));
});