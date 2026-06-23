import test from "node:test";
import assert from "node:assert/strict";

import { handleQueueRunRequest } from "@/lib/domain/queue/queue-run-request.js";
import { runSendQueue } from "@/lib/domain/queue/run-send-queue.js";
import {
  buildSupabaseQueueRow,
  makeLiveQueueSystemValue,
  makeRunSendQueueDeps,
} from "../helpers/queue-run-test-harness.js";

const NOW = "2026-04-04T12:00:00.000Z";

function revisionSkipResult(queue_row_id) {
  return {
    ok: true,
    skipped: true,
    reason: "queue_item_revision_limit_exceeded",
    failure_bucket: "revision_limit_exceeded",
    manual_review_required: true,
    queue_row_id,
    final_queue_status: "paused_review",
  };
}

test("runSendQueue skips revision-capped queue items and continues later work", async () => {
  const poisoned = buildSupabaseQueueRow(3281484514, {
    scheduled_for: NOW,
    scheduled_for_utc: NOW,
  });
  const healthy = buildSupabaseQueueRow(3281484515, {
    scheduled_for: NOW,
    scheduled_for_utc: NOW,
  });
  const processed_ids = [];

  const { deps } = makeRunSendQueueDeps({
    rows: [poisoned, healthy],
    now: NOW,
    processImpl: async (row) => {
      processed_ids.push(row.id);
      if (row.id === 3281484514) return revisionSkipResult(row.id);
      return { ok: true, sent: true, provider_message_id: "msg-ok" };
    },
  });

  const result = await runSendQueue({ limit: 10, now: NOW }, deps);

  assert.deepEqual(processed_ids, [3281484514, 3281484515]);
  assert.equal(result.ok, true);
  assert.equal(result.processed_count, 2);
  assert.equal(result.sent_count, 1);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.deepEqual(result.results[0], {
    ok: true,
    skipped: true,
    queue_item_id: 3281484514,
    reason: "queue_item_revision_limit_exceeded",
    final_queue_status: "paused_review",
  });
  assert.equal(result.results[1].queue_item_id, 3281484515);
  assert.equal(result.results[1].ok, true);
});

test("runSendQueue succeeds when later items are healthy after revision-limit skips", async () => {
  const rows = [3281484515, 3281484516].map((id) =>
    buildSupabaseQueueRow(id, {
      scheduled_for: NOW,
      scheduled_for_utc: NOW,
    })
  );
  const { deps } = makeRunSendQueueDeps({
    rows,
    now: NOW,
    processResult: { ok: true, sent: true, provider_message_id: "msg-ok" },
  });

  const result = await runSendQueue({ limit: 2, now: NOW }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.sent_count, 2);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
});

test("runSendQueue returns skipped summary when no runnable rows are available", async () => {
  const { deps } = makeRunSendQueueDeps({ rows: [], now: NOW });
  const result = await runSendQueue({ limit: 1, now: NOW }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.processed_count, 0);
  assert.equal(result.sent_count, 0);
  assert.deepEqual(result.results, []);
});

test("runSendQueue skips first item at process phase and processes second item", async () => {
  const poisoned = buildSupabaseQueueRow(3281484514, {
    scheduled_for: NOW,
    scheduled_for_utc: NOW,
  });
  const healthy = buildSupabaseQueueRow(3281484517, {
    scheduled_for: NOW,
    scheduled_for_utc: NOW,
  });
  const processed_ids = [];
  const { deps } = makeRunSendQueueDeps({
    rows: [poisoned, healthy],
    now: NOW,
    processImpl: async (row) => {
      processed_ids.push(row.id);
      if (row.id === 3281484514) return revisionSkipResult(row.id);
      return { ok: true, sent: true, provider_message_id: "msg-ok" };
    },
  });

  const result = await runSendQueue({ limit: 5, now: NOW }, deps);

  assert.deepEqual(processed_ids, [3281484514, 3281484517]);
  assert.equal(result.ok, true);
  assert.equal(result.processed_count, 2);
  assert.equal(result.sent_count, 1);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 1);

  const skipped = result.results.find((entry) => entry.queue_item_id === 3281484514);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "queue_item_revision_limit_exceeded");
  assert.equal(skipped.final_queue_status, "paused_review");

  const sent = result.results.find((entry) => entry.queue_item_id === 3281484517);
  assert.equal(sent.ok, true);
  assert.equal(sent.status, "sent");
});

test("queue run route returns success when run summary contains revision-limit skips", async () => {
  const response = await handleQueueRunRequest(
    new Request("http://localhost/api/internal/queue/run?limit=2"),
    "GET",
    {
      requireCronAuth: () => ({
        authorized: true,
        auth: {
          authenticated: true,
          is_vercel_cron: false,
        },
      }),
      getSystemValue: makeLiveQueueSystemValue(),
      runSendQueue: async () => ({
        ok: true,
        processed_count: 2,
        sent_count: 1,
        failed_count: 0,
        skipped_count: 1,
        results: [
          {
            queue_item_id: 3281484514,
            ok: true,
            skipped: true,
            reason: "queue_item_revision_limit_exceeded",
            failure_bucket: "revision_limit_exceeded",
            final_queue_status: "paused_review",
          },
          {
            queue_item_id: 3281484515,
            ok: true,
            status: "sent",
          },
        ],
      }),
      logger: {
        info: () => {},
        error: () => {},
      },
    }
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.route, "internal/queue/run");
  assert.equal(payload.result.skipped_count, 1);
  assert.equal(payload.result.failed_count, 0);
  assert.equal(payload.result.results[0].reason, "queue_item_revision_limit_exceeded");
});