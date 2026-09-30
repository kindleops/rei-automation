/**
 * post-send-projection.js
 *
 * THE OPERATOR'S RESPONSE MUST NOT WAIT FOR PROJECTIONS.
 *
 * 2026-09-30 14:51Z. An operator pressed Send in the phone Inbox and was told
 * "backend_network_error ... Load failed" for a message the seller received.
 * The send itself had been durable (send_queue row `sent` with the provider SID,
 * §11 attempt `provider_accepted`) well before the request finished: after the
 * provider call, executeManualInboxSendNow still awaited the message_events
 * write, a full classified thread-state resync (every message_events row for the
 * thread, then a re-classification of the latest inbound that may call an LLM),
 * a second thread-state upsert and the first-contact promotion. Under the DB
 * saturation that afternoon those awaits cost ~6.5s of a ~34s request, and a
 * phone that gives up on a slow request reports a failure for a send that went
 * out, which invites a duplicate SMS.
 *
 * WHAT THIS MODULE DOES
 *   Runs the post-send projection work and waits for it for at most a small
 *   budget. Inside the budget the result is identical to before. Past the
 *   budget the caller answers the operator immediately and the work continues.
 *
 * WHY "CONTINUES" IS SAFE ON THIS RUNTIME
 *   Production is the Next.js standalone server in a long-lived Cloudflare
 *   Container (node apps/api/server.js), not a serverless invocation that is
 *   frozen once it responds. The projection work runs at exactly the moment it
 *   ran before -- immediately after finalizeSendQueueSuccess -- and only the HTTP
 *   response is released earlier. A process crash in that window loses the same
 *   work it always would have lost; nothing new becomes droppable. On a platform
 *   that CAN freeze after the response (Vercel / Lambda) the budget is infinite,
 *   i.e. the old fully-awaited behaviour.
 *
 * WHAT IT MUST NOT DO
 *   Nothing here touches the send: the provider call, the §11 ledger and the
 *   durable queue finalization all complete BEFORE the caller gets here. This
 *   only decides how long the operator waits for bookkeeping that follows them.
 *
 * ORDERING
 *   Two deferred projections for one thread must not interleave: each writes
 *   latest_message_* and read-modify-writes outbound_count on inbox_thread_state,
 *   so a slow first send landing after a fast second one would regress the
 *   thread. Projections are therefore chained per key (thread), with a cap so a
 *   hung projection (e.g. an LLM call with a long timeout) cannot stall the next
 *   send's bookkeeping forever.
 */

import { child } from "@/lib/logging/logger.js";

const logger = child({ module: "domain.inbox.post_send_projection" });

/** How long the operator's request may wait for projections after the send is durable. */
export const DEFAULT_POST_SEND_BUDGET_MS = 1500;

/** Longest a projection waits for the previous projection on the same thread. */
export const SAME_THREAD_WAIT_CAP_MS = 30_000;

const in_flight = new Set();
const tails_by_key = new Map();

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Resolve the response budget.
 *   explicit (tests / callers)   -> that value (>= 0; Infinity allowed)
 *   serverless platform          -> Infinity (must finish inside the request)
 *   INBOX_SEND_POST_SEND_BUDGET_MS -> that value
 *   otherwise                    -> DEFAULT_POST_SEND_BUDGET_MS
 */
export function resolvePostSendBudgetMs({ budget_ms, env = process.env } = {}) {
  if (budget_ms !== undefined && budget_ms !== null && clean(budget_ms) !== "") {
    const explicit = Number(budget_ms);
    if (explicit === Infinity) return Infinity;
    if (Number.isFinite(explicit)) return Math.max(0, explicit);
  }
  if (clean(env?.VERCEL) === "1" || clean(env?.AWS_LAMBDA_FUNCTION_NAME)) return Infinity;
  const configured_raw = clean(env?.INBOX_SEND_POST_SEND_BUDGET_MS);
  if (configured_raw) {
    const configured = Number(configured_raw);
    if (Number.isFinite(configured) && configured >= 0) return configured;
  }
  return DEFAULT_POST_SEND_BUDGET_MS;
}

/**
 * Resolve `promise` or give up after `ms`, whichever is first. Never rejects
 * on the timeout path. The timer is cleared as soon as either side settles; it
 * is deliberately NOT unref'd -- a caller is actively waiting on it.
 */
function settleWithin(promise, ms) {
  if (ms === Infinity) return promise;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run `task` (the post-send projections) and wait for it at most `budget_ms`.
 *
 * Never rejects. Resolves to one of:
 *   { state: "completed", value, elapsed_ms }
 *   { state: "failed", error, elapsed_ms }
 *   { state: "deferred", elapsed_ms }   still running; finishes after the response
 *
 * @param {object}   input
 * @param {Function} input.task        async () => value
 * @param {string}   [input.key]       serialization key (the thread)
 * @param {number}   [input.budget_ms] from resolvePostSendBudgetMs
 * @param {object}   [input.context]   log context (ids only, never PII)
 * @param {Function} [input.on_background_settled] called once if deferred work later settles
 * @param {number}   [input.same_thread_wait_cap_ms] test seam for SAME_THREAD_WAIT_CAP_MS
 */
export async function runPostSendProjection({
  task,
  key = null,
  budget_ms = DEFAULT_POST_SEND_BUDGET_MS,
  context = {},
  on_background_settled = null,
  same_thread_wait_cap_ms = SAME_THREAD_WAIT_CAP_MS,
} = {}) {
  const started_at = Date.now();
  const serial_key = clean(key) || null;
  const previous = serial_key ? tails_by_key.get(serial_key) : null;

  const run = async () => {
    if (previous) await settleWithin(previous, same_thread_wait_cap_ms);
    return task();
  };

  // `outcome` never rejects: a projection failure is data, not an exception
  // that could surface as an unhandled rejection after the response is gone.
  const outcome = run().then(
    (value) => ({ state: "completed", value }),
    (error) => ({ state: "failed", error })
  );

  in_flight.add(outcome);
  if (serial_key) tails_by_key.set(serial_key, outcome);
  outcome.then(() => {
    in_flight.delete(outcome);
    if (serial_key && tails_by_key.get(serial_key) === outcome) tails_by_key.delete(serial_key);
  });

  const budget = budget_ms === Infinity ? Infinity : Math.max(0, Number(budget_ms) || 0);
  const settled = await settleWithin(outcome, budget);
  if (settled) return { ...settled, elapsed_ms: Date.now() - started_at };

  logger.warn("post_send_projection.deferred", { ...context, budget_ms: budget });
  outcome.then((late) => {
    const elapsed_ms = Date.now() - started_at;
    if (late.state === "completed") {
      logger.info("post_send_projection.completed_after_response", { ...context, elapsed_ms });
    } else {
      logger.error("post_send_projection.failed_after_response", {
        ...context,
        elapsed_ms,
        message: late.error?.message || String(late.error || "unknown_error"),
      });
    }
    if (typeof on_background_settled === "function") {
      try {
        on_background_settled({ ...late, elapsed_ms });
      } catch {
        // observers must never break the background completion
      }
    }
  });

  return { state: "deferred", elapsed_ms: Date.now() - started_at };
}

/** Projections still running (deferred past a response, or chained behind one). */
export function pendingPostSendProjectionCount() {
  return in_flight.size;
}

/** Wait until every in-flight projection has settled (tests, graceful shutdown). */
export async function drainPostSendProjections() {
  while (in_flight.size > 0) {
    await Promise.all([...in_flight]);
  }
}
