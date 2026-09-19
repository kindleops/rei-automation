/**
 * RECONCILING AN ATTEMPT THAT PROVABLY NEVER REACHED THE PROVIDER (§1, §2).
 *
 * `isAmbiguousSendRow` is deliberately pessimistic: when a send fails without
 * transport evidence, the only safe reading is "the human may have seen it", so
 * the row blocks any further contact with that person forever. That is correct
 * as a default and it is the right bias.
 *
 * But it is a default, not a verdict. An attempt can later be PROVEN never to
 * have left the process — and when it has, leaving it ambiguous is no longer
 * caution, it is a false record that permanently bars a legitimate recipient.
 *
 * THE CASE THIS WAS BUILT FOR. `sendTextgridSMS` carries its own runtime brake
 * that refuses lexically before `fetch`. When it fires, it throws a bare error
 * with no transport evidence; the classifier sees `unknown_failure` and the
 * outcome mapper fail-closes to `ambiguous / may_have_been_sent`. A message
 * that never left the process is recorded as possibly-delivered. The row's
 * "SEND FAILED - NO SID" is not provider evidence at all — it is a synthetic
 * error minted by the queue runner after the seam's real verdict was discarded.
 *
 * WHAT THIS REFUSES TO DO. It is not "mark it failed". It will not touch a row
 * unless the durable evidence itself shows NO transport ever occurred: no
 * provider message id, no HTTP status, no provider status, and no callback ever
 * seen for that destination. If any of those exist, the attempt genuinely might
 * have been received and the ambiguity must stand. It also requires a written
 * evidence reference and a named actor, so the reconciliation is auditable back
 * to the finding that justified it.
 *
 * NOTHING IS DELETED. The original classification is preserved under
 * `superseded_evidence`, and the reconciliation is appended with its own
 * before/after record. The logical communication identity is NOT reused or
 * retried — this clears the recipient for NEW work, it does not resurrect the
 * old attempt.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { isAmbiguousSendRow } from "@/lib/domain/messaging/ambiguous-send-evidence.js";

export const NEVER_DISPATCHED_FAILURE_CLASS = "local_refusal_never_dispatched";
export const NEVER_DISPATCHED_REASON = "never_reached_provider";
export const RECONCILIATION_POLICY_VERSION = "never_dispatched_v1";

const clean = (value) => String(value ?? "").trim();

/**
 * Does the durable evidence show that no transport ever happened?
 *
 * Every one of these is a POSITIVE absence — a field the transport layer would
 * have populated had it run. Absence of a callback alone would not be enough
 * (a callback can be lost); absence of every transport artefact together, plus
 * an attempt row that never advanced past `request_started`, is.
 */
export function evaluateNeverDispatchedEvidence({ queue_row = {}, attempt = null, callback_count = 0 } = {}) {
  const blockers = [];

  if (clean(queue_row.provider_message_id) || clean(queue_row.textgrid_message_id)) {
    blockers.push("queue_row_holds_provider_message_id");
  }
  if (clean(queue_row.sent_at)) blockers.push("queue_row_has_sent_at");
  if (Number(callback_count) > 0) blockers.push("provider_callback_exists_for_destination");

  if (attempt) {
    if (clean(attempt.provider_message_id)) blockers.push("attempt_holds_provider_message_id");
    if (attempt.http_status !== null && attempt.http_status !== undefined) blockers.push("attempt_has_http_status");
    if (clean(attempt.provider_status)) blockers.push("attempt_has_provider_status");
    // Anything past the request having been started means bytes may have moved.
    const phase = clean(attempt.transport_phase);
    if (phase && !["request_started", "not_started", "refused_pre_transport"].includes(phase)) {
      blockers.push(`attempt_transport_phase_${phase}`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}

/**
 * Apply the reconciliation.
 *
 * Returns the audit record rather than a bare boolean, so the caller can print
 * exactly what changed and on what grounds.
 */
export async function reconcileNeverDispatchedAttempt({
  queue_row_id,
  evidence_reference,
  actor,
  reason = "proven_never_reached_provider",
  supabase = defaultSupabase,
  now = new Date().toISOString(),
  loadQueueRow = null,
  loadAttempt = null,
  countCallbacks = null,
  applyPatch = null,
} = {}) {
  if (!clean(queue_row_id)) return { ok: false, reason: "queue_row_id_required" };
  // An unreferenced reconciliation is an unauditable one.
  if (!clean(evidence_reference)) return { ok: false, reason: "evidence_reference_required" };
  if (!clean(actor)) return { ok: false, reason: "actor_required" };

  let queue_row = null;
  let attempt = null;
  let callback_count = 0;
  try {
    if (loadQueueRow) {
      queue_row = await loadQueueRow(queue_row_id);
    } else {
      const { data, error } = await supabase
        .from("send_queue")
        .select("id,queue_status,to_phone_number,provider_message_id,textgrid_message_id,sent_at,metadata")
        .eq("id", queue_row_id)
        .maybeSingle();
      if (error) throw error;
      queue_row = data;
    }
    if (!queue_row) return { ok: false, reason: "queue_row_not_found" };

    if (loadAttempt) {
      attempt = await loadAttempt(queue_row_id);
    } else {
      const { data } = await supabase
        .from("seller_communication_attempts")
        .select("id,provider_message_id,http_status,provider_status,transport_phase,outcome_class,delivery_possibility")
        .eq("queue_row_id", queue_row_id)
        .maybeSingle();
      attempt = data || null;
    }

    if (countCallbacks) {
      callback_count = await countCallbacks(clean(queue_row.to_phone_number));
    } else {
      const { count } = await supabase
        .from("seller_provider_callback_events")
        .select("id", { count: "exact", head: true })
        .eq("to_phone_number", clean(queue_row.to_phone_number));
      callback_count = Number(count || 0);
    }
  } catch (error) {
    return { ok: false, reason: "evidence_read_failed", detail: error?.message || null };
  }

  // Reconciling a row that is not ambiguous would be a no-op at best and a
  // rewrite of real provider truth at worst.
  if (!isAmbiguousSendRow(queue_row)) {
    return { ok: false, reason: "row_is_not_ambiguous" };
  }

  const evidence = evaluateNeverDispatchedEvidence({ queue_row, attempt, callback_count });
  if (!evidence.ok) {
    return { ok: false, reason: "transport_evidence_present", blockers: evidence.blockers };
  }

  const metadata = queue_row.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  const provider_error = metadata.provider_error && typeof metadata.provider_error === "object"
    ? metadata.provider_error
    : {};

  const before = {
    failure_class: clean(provider_error.failure_class) || null,
    normalized_reason: clean(provider_error.normalized_reason) || null,
    delivery_possibility: attempt ? clean(attempt.delivery_possibility) || null : null,
    outcome_class: attempt ? clean(attempt.outcome_class) || null : null,
  };

  const patch = {
    metadata: {
      ...metadata,
      provider_error: {
        ...provider_error,
        failure_class: NEVER_DISPATCHED_FAILURE_CLASS,
        normalized_reason: NEVER_DISPATCHED_REASON,
        // The original verdict is kept verbatim. It was the honest reading of
        // the evidence available at the time.
        superseded_evidence: {
          ...provider_error,
          superseded_at: now,
        },
      },
      ambiguity_reconciliation: {
        policy_version: RECONCILIATION_POLICY_VERSION,
        evidence_reference: clean(evidence_reference),
        actor: clean(actor),
        reason: clean(reason),
        reconciled_at: now,
        before,
        after: {
          failure_class: NEVER_DISPATCHED_FAILURE_CLASS,
          normalized_reason: NEVER_DISPATCHED_REASON,
        },
        /**
         * Explicitly recorded so nothing later mistakes this for permission to
         * retry the original attempt. The logical identity stays consumed; only
         * the RECIPIENT is cleared for new work.
         */
        logical_attempt_retryable: false,
      },
    },
  };

  try {
    if (applyPatch) {
      await applyPatch(queue_row_id, patch);
    } else {
      const { error } = await supabase.from("send_queue").update(patch).eq("id", queue_row_id);
      if (error) throw error;
    }
  } catch (error) {
    return { ok: false, reason: "reconciliation_write_failed", detail: error?.message || null };
  }

  return {
    ok: true,
    queue_row_id,
    destination: clean(queue_row.to_phone_number),
    before,
    after: patch.metadata.ambiguity_reconciliation.after,
    evidence_reference: clean(evidence_reference),
    actor: clean(actor),
    reconciled_at: now,
  };
}


/**
 * THE SECOND SHAPE: THE LEDGER ALREADY KNOWS, AND THE QUEUE ROW DISAGREES.
 *
 * `seller_communication_attempts` is the purpose-built record of what the
 * transport actually did — it holds the HTTP status, the provider status and
 * the outcome lattice's verdict. The `send_queue` row holds whatever the queue
 * runner wrote, and the runner mints a synthetic `Error("SEND FAILED - NO SID")`
 * that discards the seam's real verdict one frame above.
 *
 * So the two records can disagree, and when they do the ledger is right. A row
 * whose ledger entry says `definitely_not_sent` with a real HTTP status is not
 * ambiguous at all: the provider answered and refused. Leaving the queue row's
 * synthetic ambiguity in place bars a recipient on the strength of a record we
 * know to be wrong.
 *
 * This is NOT the never-dispatched path and does not share its evidence rules —
 * there, the proof is that nothing left the process; here, the proof is that
 * something did and came back rejected. Both refuse the moment a provider
 * message id or a delivery callback exists, because either would mean the
 * message may have landed.
 */
export const LEDGER_SUPERSEDED_FAILURE_CLASS = "provider_rejected_terminal";
export const LEDGER_SUPERSEDED_REASON = "canonical_attempt_ledger_definitely_not_sent";

export function evaluateLedgerTerminalEvidence({ queue_row = {}, attempt = null, callback_count = 0 } = {}) {
  const blockers = [];
  if (!attempt) blockers.push("no_canonical_attempt_record");
  if (attempt && clean(attempt.delivery_possibility) !== "definitely_not_sent") {
    blockers.push(`ledger_delivery_possibility_${clean(attempt.delivery_possibility) || "absent"}`);
  }
  if (attempt && clean(attempt.outcome_class) !== "failed_terminal") {
    blockers.push(`ledger_outcome_class_${clean(attempt.outcome_class) || "absent"}`);
  }
  // Either of these means the message may have reached the human regardless of
  // what the ledger concluded.
  if (clean(queue_row.provider_message_id) || clean(queue_row.textgrid_message_id)) {
    blockers.push("queue_row_holds_provider_message_id");
  }
  if (attempt && clean(attempt.provider_message_id)) blockers.push("attempt_holds_provider_message_id");
  if (clean(queue_row.sent_at)) blockers.push("queue_row_has_sent_at");
  if (Number(callback_count) > 0) blockers.push("provider_callback_exists_for_destination");

  return { ok: blockers.length === 0, blockers };
}

export async function reconcileFromCanonicalAttemptVerdict({
  queue_row_id,
  evidence_reference,
  actor,
  reason = "canonical_attempt_ledger_supersedes_synthetic_ambiguity",
  supabase = defaultSupabase,
  now = new Date().toISOString(),
  loadQueueRow = null,
  loadAttempt = null,
  countCallbacks = null,
  applyPatch = null,
} = {}) {
  if (!clean(queue_row_id)) return { ok: false, reason: "queue_row_id_required" };
  if (!clean(evidence_reference)) return { ok: false, reason: "evidence_reference_required" };
  if (!clean(actor)) return { ok: false, reason: "actor_required" };

  let queue_row = null;
  let attempt = null;
  let callback_count = 0;
  try {
    if (loadQueueRow) {
      queue_row = await loadQueueRow(queue_row_id);
    } else {
      const { data, error } = await supabase
        .from("send_queue")
        .select("id,queue_status,to_phone_number,provider_message_id,textgrid_message_id,sent_at,metadata")
        .eq("id", queue_row_id)
        .maybeSingle();
      if (error) throw error;
      queue_row = data;
    }
    if (!queue_row) return { ok: false, reason: "queue_row_not_found" };

    if (loadAttempt) {
      attempt = await loadAttempt(queue_row_id);
    } else {
      const { data } = await supabase
        .from("seller_communication_attempts")
        .select("id,provider_message_id,http_status,provider_status,transport_phase,outcome_class,delivery_possibility")
        .eq("queue_row_id", queue_row_id)
        .maybeSingle();
      attempt = data || null;
    }

    if (countCallbacks) {
      callback_count = await countCallbacks(clean(queue_row.to_phone_number));
    } else {
      const { count } = await supabase
        .from("seller_provider_callback_events")
        .select("id", { count: "exact", head: true })
        .eq("to_phone_number", clean(queue_row.to_phone_number));
      callback_count = Number(count || 0);
    }
  } catch (error) {
    return { ok: false, reason: "evidence_read_failed", detail: error?.message || null };
  }

  if (!isAmbiguousSendRow(queue_row)) return { ok: false, reason: "row_is_not_ambiguous" };

  const evidence = evaluateLedgerTerminalEvidence({ queue_row, attempt, callback_count });
  if (!evidence.ok) return { ok: false, reason: "ledger_verdict_not_terminal", blockers: evidence.blockers };

  const metadata = queue_row.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  const provider_error = metadata.provider_error && typeof metadata.provider_error === "object"
    ? metadata.provider_error
    : {};

  const before = {
    failure_class: clean(provider_error.failure_class) || null,
    normalized_reason: clean(provider_error.normalized_reason) || null,
    delivery_possibility: clean(attempt.delivery_possibility) || null,
    outcome_class: clean(attempt.outcome_class) || null,
    http_status: attempt.http_status ?? null,
  };

  const patch = {
    metadata: {
      ...metadata,
      provider_error: {
        ...provider_error,
        failure_class: LEDGER_SUPERSEDED_FAILURE_CLASS,
        normalized_reason: LEDGER_SUPERSEDED_REASON,
        superseded_evidence: { ...provider_error, superseded_at: now },
      },
      ambiguity_reconciliation: {
        policy_version: RECONCILIATION_POLICY_VERSION,
        path: "canonical_attempt_ledger",
        evidence_reference: clean(evidence_reference),
        actor: clean(actor),
        reason: clean(reason),
        reconciled_at: now,
        before,
        after: {
          failure_class: LEDGER_SUPERSEDED_FAILURE_CLASS,
          normalized_reason: LEDGER_SUPERSEDED_REASON,
        },
        logical_attempt_retryable: false,
      },
    },
  };

  try {
    if (applyPatch) {
      await applyPatch(queue_row_id, patch);
    } else {
      const { error } = await supabase.from("send_queue").update(patch).eq("id", queue_row_id);
      if (error) throw error;
    }
  } catch (error) {
    return { ok: false, reason: "reconciliation_write_failed", detail: error?.message || null };
  }

  return {
    ok: true,
    queue_row_id,
    destination: clean(queue_row.to_phone_number),
    before,
    after: patch.metadata.ambiguity_reconciliation.after,
    evidence_reference: clean(evidence_reference),
    actor: clean(actor),
    reconciled_at: now,
  };
}
