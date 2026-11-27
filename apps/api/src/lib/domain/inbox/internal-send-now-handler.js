// ─── internal-send-now-handler.js ────────────────────────────────────────────
// The body of POST /api/internal/inbox/send-now, after the route's auth and
// dashboard_live_enabled gates. Extracted so the path can be tested with
// injected collaborators (review task_e46cf83a: the route with action
// "queue_reply" skipped the content-filter lock and the attempt cap, and the
// route then dispatched the row).
//
// Whatever `input.action` is, createInboxSendNowQueueRow applies the lock and
// the per-thread attempt cap before any row exists. A refused request creates
// no row, so nothing is dispatched. A created row is dispatched through
// processSendQueueItem, whose final dispatch gate re-checks the lock.

import { createInboxSendNowQueueRow } from "@/lib/domain/inbox/send-now-service.js";
import { classifyQueueBusinessOutcome } from "@/lib/domain/queue/failure-classifier.js";

/**
 * @param {object} input  the request body, with the route-stamped actor
 *                        (repeat_ask_override_actor from x-ops-user-id)
 * @param {object} deps   { processSendQueueItem (required), createQueueRow,
 *                          queueRowDeps, now }
 * @returns {Promise<{ result, row_result, payload }>}
 */
export async function handleInternalInboxSendNow(input = {}, deps = {}) {
  const create = deps.createQueueRow || createInboxSendNowQueueRow;
  const result = deps.queueRowDeps ? await create(input, deps.queueRowDeps) : await create(input);
  let row_result = null;
  const dry_run = input?.dry_run === true;
  if (result?.ok === true && result?.queue_created && result?.queue_row_id && !dry_run) {
    if (typeof deps.processSendQueueItem !== "function") {
      throw new Error("internal_send_now_dispatcher_missing");
    }
    row_result = await deps.processSendQueueItem(result.queue_row_id, { now: deps.now || new Date().toISOString() });
  }
  const payload = {
    ok: true,
    handled: true,
    outcome: result?.ok ? "queued" : "blocked",
    error: result?.error || null,
    queue_id: result?.queue_id || null,
    queue_key: result?.queue_key || null,
    queue_row_id: result?.queue_row_id || null,
    row_result,
    failure: result?.ok
      ? null
      : {
          reason: result?.error || "send_now_blocked",
          detail_reason: result?.detail_reason || null,
          hard_block: result?.hard_block === true,
          failure_bucket: classifyQueueBusinessOutcome({ reason: result?.error })?.failure_bucket || null,
        },
  };
  return { result, row_result, payload };
}

export default handleInternalInboxSendNow;
