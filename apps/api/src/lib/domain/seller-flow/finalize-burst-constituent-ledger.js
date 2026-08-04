// Finalizes every inbound ledger row belonging to a burst once that burst
// reaches a terminal result.
//
// While a burst is in flight its constituent inbounds sit at status='processing'
// with an `awaiting_burst_finalization` marker in disposition_detail — they are
// intentionally unfinished, not silently dropped. When the burst finishes, each
// of those rows must receive the REAL outcome. A completed burst may never leave
// a constituent row awaiting: that is the 2026-08-03 failure shape (a decision
// nobody ever recorded) in a different disguise.
//
// Idempotent by construction: completion is fenced on status='processing', so a
// repeated worker invocation is a no-op rather than a conflicting disposition.

import { TERMINAL_DISPOSITIONS } from "@/lib/domain/inbound/terminal-disposition.js";

/**
 * Maps a burst's terminal result onto the ledger disposition vocabulary.
 * Safety outcomes keep precedence over reply generation.
 */
export function resolveBurstConstituentDisposition(result = {}) {
  const suppression = String(result.suppression_kind ?? result.safety_kind ?? "")
    .trim()
    .toLowerCase();

  if (suppression.includes("opt_out") || suppression === "stop") {
    return TERMINAL_DISPOSITIONS.SUPPRESSED_OPT_OUT;
  }
  if (suppression.includes("wrong_number") || suppression.includes("wrong_person")) {
    return TERMINAL_DISPOSITIONS.SUPPRESSED_WRONG_NUMBER;
  }
  if (result.suppressed === true) return TERMINAL_DISPOSITIONS.SUPPRESSED_POLICY;

  if (result.ok === false) {
    return result.retriable === false
      ? TERMINAL_DISPOSITIONS.FAILED_TERMINAL
      : TERMINAL_DISPOSITIONS.FAILED_RETRIABLE;
  }

  if (result.queued === true || result.queue_row_id) return TERMINAL_DISPOSITIONS.REPLY_SENT;
  if (result.human_review_required === true) {
    return TERMINAL_DISPOSITIONS.HUMAN_REVIEW_REQUIRED;
  }
  if (result.contact_window_deferred === true) {
    return TERMINAL_DISPOSITIONS.REPLY_DEFERRED_COMPLIANCE;
  }
  return TERMINAL_DISPOSITIONS.NO_REPLY_REQUIRED;
}

/**
 * @param {object} args
 * @param {object} args.supabase
 * @param {object} args.burst              the completed burst row
 * @param {object} args.result             the burst's terminal result
 * @param {Function} [args.completeClaim]  completeInboundProcessingClaim
 * @param {Function} [args.alert]          launchAlerts.burstFlushFailure
 */
export async function finalizeBurstConstituentLedger({
  supabase,
  burst,
  result = {},
  completeClaim = null,
  alert = null,
  logger = null,
} = {}) {
  const burst_id = burst?.burst_id || burst?.id || null;
  const event_ids = Array.isArray(burst?.constituent_event_ids)
    ? burst.constituent_event_ids.filter(Boolean)
    : [];

  if (!supabase || !burst_id) {
    return { ok: false, reason: "missing_supabase_or_burst", finalized: 0, pending: 0 };
  }

  const disposition = resolveBurstConstituentDisposition(result);

  let rows;
  try {
    const { data, error } = await supabase
      .from("inbound_processing_ledger")
      .select("id,idempotency_key,processing_run_id,status,disposition_detail")
      .eq("thread_key", burst.thread_key)
      .eq("status", "processing");
    if (error) {
      return { ok: false, reason: "ledger_lookup_failed", message: error.message, finalized: 0, pending: 0 };
    }
    // Exact match only. Adopting rows with a missing/other burst_id would let
    // one burst finalize another burst's constituents with the wrong outcome.
    rows = (data || []).filter(
      (row) =>
        row?.disposition_detail?.awaiting_burst_finalization === true &&
        row.disposition_detail.burst_id === burst_id
    );
  } catch (lookup_error) {
    return {
      ok: false,
      reason: "ledger_lookup_failed",
      message: lookup_error?.message || "unknown_error",
      finalized: 0,
      pending: 0,
    };
  }

  if (!rows.length) {
    // Already finalized by a prior invocation, or the burst had no pending
    // constituents. Both are legitimately a no-op.
    return { ok: true, disposition, finalized: 0, pending: 0, event_ids: event_ids.length };
  }

  const complete = completeClaim;
  if (typeof complete !== "function") {
    return { ok: false, reason: "missing_complete_claim", finalized: 0, pending: rows.length };
  }

  let finalized = 0;
  const failures = [];
  for (const row of rows) {
    try {
      const outcome = await complete({
        idempotency_key: row.idempotency_key,
        processing_run_id: row.processing_run_id,
        disposition,
        // Structural cross-references only — never the seller's message body.
        detail: {
          burst_id,
          burst_status: burst.status || null,
          finalized_by: "burst_completion",
          queue_row_id: result.queue_row_id || null,
          provider_message_id: result.provider_message_id || null,
        },
      });
      if (outcome?.ok === false) failures.push({ key: row.idempotency_key, reason: outcome.reason });
      else finalized += 1;
    } catch (error) {
      failures.push({ key: row.idempotency_key, reason: error?.message || "unknown_error" });
    }
  }

  const pending = rows.length - finalized;
  if (pending > 0) {
    // Partial finalization must be loud AND retryable: the untouched rows keep
    // status='processing' with their marker, so a later invocation retries them.
    logger?.warn?.("seller_inbound_burst.partial_ledger_finalization", {
      burst_id,
      finalized,
      pending,
      failures: failures.slice(0, 5),
    });
    await alert?.({
      partial_ledger_finalization: true,
      burst_id,
      finalized_count: finalized,
      pending_count: pending,
      failures: failures.slice(0, 5),
    })?.catch?.(() => {});
  }

  return {
    ok: pending === 0,
    disposition,
    finalized,
    pending,
    failures,
    event_ids: event_ids.length,
  };
}

export default finalizeBurstConstituentLedger;
