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

export default buildDispatchRefusalBackoff;
