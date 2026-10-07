// ─── dispatch-refusal-backoff.js ─────────────────────────────────────────────
// A row the canonical seam refuses BEFORE the wire goes back to `queued`. It
// used to go back with its original scheduled_for, so it was again the oldest
// due row on the very next run. On 2026-09-29/30, 50 retries that the ledger
// refused every time filled every 50-row claim batch for ~25 hours
// (~2,800 claims an hour) and the other 116 due rows were never reached.
//
// So each consecutive refusal pushes the row back 1, 2, 4 ... 60 minutes. The
// first step behaves like before (the next run), a transient refusal such as
// an attempt still in flight clears on its own, and a row that can never pass
// stops starving the rows behind it. Nothing here consumes a retry or records
// a delivery attempt: the seam never called the provider.

const MAX_BACKOFF_MINUTES = 60;

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * @param {object} queue_row  the claimed send_queue row (metadata carries the count)
 * @param {string|Date} [now]
 * @returns {{ next_eligible_at: string, delay_minutes: number, metadata: object }}
 */
export function buildDispatchRefusalBackoff(queue_row = {}, now = new Date()) {
  const md = queue_row?.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  const previous = Math.max(0, Math.trunc(Number(md.dispatch_refusal_count) || 0));
  const count = previous + 1;
  const delay_minutes = Math.min(MAX_BACKOFF_MINUTES, 2 ** Math.min(count - 1, 6));
  const base = now instanceof Date ? now : new Date(now);
  const at = Number.isFinite(base.getTime()) ? base : new Date();
  const next_eligible_at = new Date(at.getTime() + delay_minutes * 60_000).toISOString();
  return {
    next_eligible_at,
    delay_minutes,
    metadata: {
      dispatch_refusal_count: count,
      dispatch_refusal_last_at: at.toISOString(),
      ...(clean(md.dispatch_refusal_first_at) ? {} : { dispatch_refusal_first_at: at.toISOString() }),
    },
  };
}

// ─── terminal refusals ──────────────────────────────────────────────────────
// Backoff bounds how often a refused row is retried, not whether it ever
// stops. Some refusals can never clear on their own: a row whose identity the
// seam cannot derive (no action anchor) will be refused on every attempt
// forever (send_queue 51c8ae5c…, Indianapolis: 62 refusals over five days).
// After `limit` consecutive refusals for such a reason the row is terminalized
// (blocked, with the reason) and ops are told once, instead of looping.

/** Refusal reasons that cannot clear by waiting. */
export const TERMINAL_REFUSAL_REASONS = Object.freeze(new Set(["queue_row_identity_underivable"]));

/** Consecutive refusals before a permanently-refused row is terminalized. */
export const DEFAULT_TERMINAL_REFUSAL_LIMIT = 10;

/** system_control key that overrides the limit (positive integer). */
export const TERMINAL_REFUSAL_LIMIT_KEY = "queue_terminal_refusal_limit";

export function resolveTerminalRefusalLimit(value) {
  const n = Math.trunc(Number(clean(value)));
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_TERMINAL_REFUSAL_LIMIT;
}

/**
 * @param {string} reason          the seam's refusal reason
 * @param {number} refusal_count   the count INCLUDING this refusal
 * @param {number} [limit]
 */
export function shouldTerminalizeRefusal(reason, refusal_count, limit = DEFAULT_TERMINAL_REFUSAL_LIMIT) {
  if (!TERMINAL_REFUSAL_REASONS.has(clean(reason))) return false;
  return Math.trunc(Number(refusal_count) || 0) >= resolveTerminalRefusalLimit(limit);
}

/**
 * The update that ends a permanently-refused row. Terminal `blocked` (not
 * `failed`: the provider was never contacted, nothing was attempted), unlocked,
 * with the reason on the row and the refusal history kept in metadata.
 */
export function buildTerminalRefusalUpdate(queue_row = {}, reason, backoff_metadata = {}, now = new Date()) {
  const md = queue_row?.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const why = clean(reason);
  return {
    queue_status: "blocked",
    guard_status: "blocked",
    guard_reason: why,
    blocked_reason: why,
    is_locked: false,
    locked_at: null,
    lock_token: null,
    updated_at: at,
    metadata: {
      ...md,
      ...backoff_metadata,
      skip_reason: why,
      final_queue_status: "blocked",
      blocked_by: "process_send_queue_terminal_refusal",
      terminal_refusal: {
        reason: why,
        refusal_count: backoff_metadata.dispatch_refusal_count ?? md.dispatch_refusal_count ?? null,
        first_refused_at: md.dispatch_refusal_first_at || backoff_metadata.dispatch_refusal_first_at || null,
        terminalized_at: at,
      },
      blocked_at: at,
      finalized_at: at,
    },
  };
}

export default buildDispatchRefusalBackoff;
