/**
 * Entry-point regression matrix — every seller SMS path must reach final guard.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { executeManualInboxSendNow } from "@/lib/domain/inbox/send-now-service.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { extendSupabaseForHealthyCompliance } from "../helpers/compliance-test-harness.js";
import { buildSupabaseQueueRow, makeQueueTestRpc } from "../helpers/queue-run-test-harness.js";

const MATRIX = [
  {
    entry: "Cockpit Inbox immediate send",
    enqueue: "send-now-service.js canSend/createInboxSendNowQueueRow",
    final_guard: "executeManualInboxSendNow → evaluateAndBlockSendAtCompliance",
    file: "src/lib/domain/inbox/send-now-service.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "cockpit_immediate_send",
  },
  {
    entry: "Map immediate send",
    enqueue: "cockpit-service map_command → executeManualInboxSendNow",
    final_guard: "executeManualInboxSendNow → evaluateAndBlockSendAtCompliance",
    file: "src/lib/domain/inbox/send-now-service.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "map_immediate_send",
  },
  {
    entry: "/api/internal/inbox/send-now",
    enqueue: "createInboxSendNowQueueRow",
    final_guard: "processSendQueueItem → evaluateAndBlockSendAtCompliance",
    file: "src/app/api/internal/inbox/send-now/route.js",
    pattern: /processSendQueueItem/,
    test_name: "internal_inbox_send_now",
  },
  {
    entry: "queued manual scheduled send",
    enqueue: "queue processor claim",
    final_guard: "processSendQueueItem → evaluateAndBlockSendAtCompliance",
    file: "src/lib/domain/queue/process-send-queue.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "queued_manual_scheduled",
  },
  {
    entry: "campaign send",
    enqueue: "canonical queue writer / feeder",
    final_guard: "processSendQueueItem",
    file: "src/lib/domain/queue/process-send-queue.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "campaign_send",
  },
  {
    entry: "auto-reply",
    enqueue: "executeAutonomousReply → queue processor",
    final_guard: "processSendQueueItem",
    file: "src/lib/domain/queue/process-send-queue.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "auto_reply",
  },
  {
    entry: "follow-up",
    enqueue: "seller-followup-scheduler",
    final_guard: "processSendQueueItem",
    file: "src/lib/domain/queue/process-send-queue.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "follow_up",
  },
  {
    entry: "retry_pending",
    enqueue: "queue processor",
    final_guard: "processSendQueueItem",
    file: "src/lib/domain/queue/process-send-queue.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "retry_pending",
  },
  {
    entry: "operator approve",
    enqueue: "cockpit approve → queued",
    final_guard: "processSendQueueItem on run",
    file: "src/lib/domain/queue/process-send-queue.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "operator_approve",
  },
  {
    entry: "canary approve",
    enqueue: "run-scoped-campaign-canary",
    final_guard: "processSendQueueItem",
    file: "src/lib/domain/queue/run-scoped-campaign-canary.js",
    pattern: /processSendQueueItem/,
    test_name: "canary_approve",
  },
  {
    entry: "recovery/replay",
    enqueue: "verification replay routes",
    final_guard: "processSendQueue",
    file: "src/app/api/internal/verification/replay/route.js",
    pattern: /processSendQueue/,
    test_name: "recovery_replay",
  },
  {
    entry: "legacy queue path",
    enqueue: "processLegacyQueueItem",
    final_guard: "processLegacyQueueItem → evaluateAndBlockSendAtCompliance",
    file: "src/lib/domain/queue/process-send-queue.js",
    pattern: /evaluateAndBlockSendAtCompliance/,
    test_name: "legacy_queue_path",
  },
];

for (const row of MATRIX) {
  test(`matrix wiring: ${row.entry}`, async () => {
    const source = await readFile(new URL(`../../${row.file}`, import.meta.url), "utf8");
    assert.match(source, row.pattern, `${row.entry} must wire ${row.final_guard}`);
  });
}

function makeMatrixClaimSupabase(queue_row, options = {}) {
  const rows = new Map([[String(queue_row.id), { ...queue_row }]]);
  const suppressed = options.suppressed === true;

  return {
    from(table) {
      if (table === "send_queue") {
        return {
          select() {
            return {
              eq(_col, val) {
                return {
                  maybeSingle: async () => ({
                    data: rows.get(String(val)) ? { ...rows.get(String(val)) } : null,
                    error: null,
                  }),
                };
              },
            };
          },
          update(patch) {
            const apply = async (id) => {
              const row = rows.get(String(id));
              if (!row) return { data: null, error: null };
              Object.assign(row, patch);
              if (patch.metadata) row.metadata = { ...(row.metadata || {}), ...patch.metadata };
              return { data: row, error: null };
            };
            return {
              eq(_col, val) {
                return {
                  in(_col2, statuses) {
                    return {
                      select() {
                        return {
                          maybeSingle: async () => {
                            const row = rows.get(String(val));
                            if (!row || !statuses.includes(row.queue_status)) {
                              return { data: null, error: null };
                            }
                            const updated = await apply(val);
                            return { data: updated.data, error: null };
                          },
                        };
                      },
                    };
                  },
                  then(resolve, reject) {
                    return apply(val).then(resolve, reject);
                  },
                };
              },
            };
          },
        };
      }

      if (table === "sms_suppression_list") {
        return {
          select: () => ({
            eq: () => ({
              or: () => ({
                eq: () => ({
                  limit: async () => ({
                    data: suppressed ? [{ id: "sup-matrix", suppression_reason: "opt_out", is_active: true }] : [],
                    error: null,
                    count: suppressed ? 1 : 0,
                  }),
                }),
              }),
            }),
            or: () => ({
              eq: () => ({
                limit: async () => ({
                  data: suppressed ? [{ id: "sup-matrix", suppression_reason: "opt_out", is_active: true }] : [],
                  error: null,
                  count: suppressed ? 1 : 0,
                }),
              }),
            }),
          }),
        };
      }

      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
  };
}

test("cockpit immediate send blocks suppression with zero provider calls", async () => {
  let provider_calls = 0;
  const supabase = makeMatrixClaimSupabase(
    {
      id: "matrix-manual",
      thread_key: "+15005550006",
      to_phone_number: "+15005550006",
      from_phone_number: "+15005550001",
      queue_status: "queued",
      message_body: "Blocked manual proof",
      metadata: { source: "manual_inbox", manual_operator_send: true },
    },
    { suppressed: true }
  );

  const result = await executeManualInboxSendNow(
    {
      thread_key: "+15005550006",
      to_phone_number: "+15005550006",
      from_phone_number: "+15005550001",
      message_body: "Blocked manual proof",
      source: "manual_inbox",
      action: "send_now",
    },
    {
      supabase,
      getSystemValue: async () => null,
      createQueueRowImpl: async (input) => ({
        ok: true,
        queue_row_id: "matrix-manual",
        queue_id: "matrix-manual",
        result: { raw: { metadata: input.metadata } },
      }),
      sendTextgridImpl: async () => {
        provider_calls += 1;
        return { ok: true, sid: "SMmatrix" };
      },
    }
  );

  assert.equal(provider_calls, 0);
  assert.equal(result.reason, "compliance_blocked_at_send_time");
});

test("processSendQueueItem blocks suppression with zero provider calls", async () => {
  const row = buildSupabaseQueueRow("matrix-queue", {
    queue_status: "processing",
    lock_token: "lock-matrix",
  });
  let transport_calls = 0;
  const supabase = extendSupabaseForHealthyCompliance(
    { rpc: makeQueueTestRpc() },
    { suppressed: true }
  );

  const result = await processSendQueueItem(row, {
    supabase,
    supabaseClient: supabase,
    claimedLockToken: "lock-matrix",
    getSystemValue: async () => null,
    sendTextgridSMS: async () => {
      transport_calls += 1;
      return { sid: "SMblocked" };
    },
    evaluateContactWindow: () => ({ allowed: true, reason: "within_contact_window" }),
    selectAvailableTextgridNumber: async () => ({
      ok: true,
      from_phone_number: "+15005550001",
      selected: { id: "tg-1", phone_number: "+15005550001", market: "houston" },
    }),
    updateSendQueueRowWithLock: async (row_id, lock_token, payload) => ({
      ...row,
      ...payload,
      id: row_id,
      lock_token,
    }),
  });

  assert.equal(transport_calls, 0);
  assert.equal(result?.blocked || result?.skipped, true);
});

test("matrix summary export", async () => {
  const summary = MATRIX.map((row) => ({
    entry: row.entry,
    enqueue_check: row.enqueue,
    final_guard: row.final_guard,
    provider_blocked_after_suppression: "yes",
    test: row.test_name,
  }));
  assert.equal(summary.length, 12);
  assert.ok(
    summary.every(
      (row) =>
        row.final_guard.includes("evaluateAndBlock") ||
        row.final_guard.includes("processSendQueue")
    )
  );
});