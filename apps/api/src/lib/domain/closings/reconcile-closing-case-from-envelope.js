// ─── reconcile-closing-case-from-envelope.js ────────────────────────────────
// Supabase-native DocuSign signature reconciliation.
//
// The DocuSign webhook resolves a closing case BY ENVELOPE ID (the unique index
// uq_closing_cases_envelope guarantees at most one case per envelope) and folds
// the signature status into Supabase. This is the back half of the closing
// continuity chain and the counterpart to
// create-docusign-envelope-from-closing-case.js.
//
// Reuses the EXISTING webhook parsing (extractWebhookPayload +
// normalizeDocusignStatus) rather than re-implementing DocuSign semantics; only
// the record source/sink changes from Podio to Supabase. HMAC verification stays
// at the route, unchanged.
//
// SCOPE: this reconciles INTERNAL state only (contract/closing status on the
// case + an append-only activity event). It performs NO external effect — no
// title routing, no closing artifact, no email. Those remain behind the
// closing-execution containment boundary and are Slice 2.
//
// IDEMPOTENCY: every reconciliation writes an activity event keyed by
// (envelope, event, status). A replayed webhook hits the unique idempotency_key
// and becomes a no-op. Status is additionally monotonic: a lower-signal event
// (a late "sent") can never regress a fully-executed contract.

import {
  extractWebhookPayload,
  normalizeDocusignStatus,
} from "@/lib/domain/contracts/handle-docusign-webhook.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

// DocuSign normalized status -> closing-case contract status + stage.
// rank enforces monotonic progression (never regress a signed contract).
const STATUS_MAP = Object.freeze({
  Created: { contract_status: "draft", rank: 1 },
  Sent: { contract_status: "sent_for_signature", rank: 2 },
  Delivered: { contract_status: "viewed", rank: 3 },
  "Seller Signed": { contract_status: "seller_signed", rank: 4 },
  "Buyer Signed": { contract_status: "buyer_signed", rank: 5 },
  Completed: { contract_status: "fully_executed", rank: 6, universal_stage: "under_contract" },
  // Terminal negatives are always applied (rank 0 bypasses the monotonic gate):
  // a void/decline is authoritative regardless of prior progress.
  Declined: { contract_status: "declined", rank: 0, terminal: true },
  Voided: { contract_status: "cancelled", rank: 0, terminal: true },
});

const RANK_BY_CONTRACT_STATUS = Object.freeze(
  Object.fromEntries(
    Object.values(STATUS_MAP).map((entry) => [entry.contract_status, entry.rank])
  )
);

export function resolveClosingStatusTransition({
  normalized_status = null,
  current_contract_status = null,
} = {}) {
  const target = STATUS_MAP[clean(normalized_status)];
  if (!target) return { ok: false, reason: "unmapped_status" };

  // Terminal negatives always apply.
  if (target.terminal) return { ok: true, apply: true, target };

  const current_rank = RANK_BY_CONTRACT_STATUS[clean(current_contract_status)] ?? 0;
  if (target.rank <= current_rank) {
    return { ok: true, apply: false, reason: "status_not_advancing", target };
  }
  return { ok: true, apply: true, target };
}

/**
 * Reconcile a DocuSign webhook payload into the Supabase closing case.
 *
 * Returns { ok, reconciled, closing_case_id, normalized_status, reason }.
 * ok:false only for a malformed payload or a DB failure; an unknown envelope is
 * ok:true / reconciled:false (a webhook for an envelope we do not own is not an
 * error, and must not be treated as one).
 */
export async function reconcileClosingCaseFromEnvelope({
  payload = {},
  // Closing-execution boundary. State reconciliation ALWAYS runs; outward
  // effects (the seller closing SMS the workflow earns) only run when the
  // caller is authorized. Defaults to the dormant, contained posture.
  allowExternalEffects = false,
  supabase: injected = null,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, reconciled: false, reason: "missing_supabase" };

  const extracted = extractWebhookPayload(payload);
  const envelope_id = clean(extracted.envelope_id);
  if (!envelope_id) {
    return { ok: false, reconciled: false, reason: "missing_envelope_id" };
  }

  const normalized_status = normalizeDocusignStatus({
    status: extracted.status,
    recipient_status: extracted.recipient_status,
    recipients: extracted.recipients,
  });

  // Envelope id is the resolution key.
  const { data: closing_case, error: lookup_error } = await supabase
    .from("closing_cases")
    .select("*")
    .eq("docusign_envelope_id", envelope_id)
    .maybeSingle();

  if (lookup_error) {
    warn("[CLOSING_RECONCILE_LOOKUP_FAILED]", {
      envelope_id,
      error: lookup_error?.message || "lookup_failed",
    });
    return { ok: false, reconciled: false, reason: "lookup_failed" };
  }

  if (!closing_case) {
    // Not ours (or not yet persisted). Never an error.
    return {
      ok: true,
      reconciled: false,
      envelope_id,
      normalized_status,
      reason: "closing_case_not_found",
    };
  }

  const closing_case_id = clean(closing_case.closing_case_id);

  // Append-only audit first: the unique idempotency_key makes a replayed
  // webhook a no-op for BOTH the event and the state update below.
  const idempotency_key = `docusign:${envelope_id}:${clean(extracted.event_id) || normalized_status}`;
  const { error: event_error } = await supabase.from("closing_activity_events").insert({
    closing_case_id,
    event_type: "docusign_status",
    source: "docusign_webhook",
    idempotency_key,
    detail: {
      envelope_id,
      normalized_status,
      event_id: extracted.event_id || null,
    },
  });

  if (event_error) {
    const duplicate =
      /duplicate key|unique constraint|23505/i.test(clean(event_error.message)) ||
      clean(event_error.code) === "23505";
    if (duplicate) {
      return {
        ok: true,
        reconciled: false,
        closing_case_id,
        envelope_id,
        normalized_status,
        reason: "duplicate_event",
      };
    }
    warn("[CLOSING_RECONCILE_EVENT_FAILED]", {
      closing_case_id,
      envelope_id,
      error: event_error?.message || "event_insert_failed",
    });
    return { ok: false, reconciled: false, closing_case_id, reason: "event_insert_failed" };
  }

  const transition = resolveClosingStatusTransition({
    normalized_status,
    current_contract_status: closing_case.contract_status,
  });

  if (!transition.ok || !transition.apply) {
    return {
      ok: true,
      reconciled: false,
      closing_case_id,
      envelope_id,
      normalized_status,
      reason: transition.reason || "unmapped_status",
    };
  }

  const now_iso = new Date().toISOString();
  const patch = {
    docusign_status: normalized_status,
    contract_status: transition.target.contract_status,
    last_activity_at: now_iso,
  };
  if (transition.target.universal_stage) {
    patch.universal_stage = transition.target.universal_stage;
  }
  if (normalized_status === "Completed") {
    patch.contract_signed_date = clean(extracted.completed_at) || now_iso;
  }

  const { data: updated, error: update_error } = await supabase
    .from("closing_cases")
    .update(patch)
    .eq("closing_case_id", closing_case_id)
    .select("*")
    .maybeSingle();

  if (update_error) {
    warn("[CLOSING_RECONCILE_UPDATE_FAILED]", {
      closing_case_id,
      envelope_id,
      error: update_error?.message || "update_failed",
    });
    return { ok: false, reconciled: false, closing_case_id, reason: "update_failed" };
  }

  // A FULLY EXECUTED signature is the authoritative event that starts the
  // closing workflow. The workflow's own milestone key makes this idempotent,
  // so a replayed completion cannot double-advance or double-message. External
  // effects stay gated by the closing-execution boundary.
  let workflow = null;
  if (normalized_status === "Completed") {
    try {
      const { advanceClosingWorkflow, CLOSING_EVENTS } = await import(
        "@/lib/domain/closings/advance-closing-workflow.js"
      );
      workflow = await advanceClosingWorkflow({
        closing_case: updated || closing_case,
        event_type: CLOSING_EVENTS.CONTRACT_FULLY_EXECUTED,
        event_at: patch.contract_signed_date,
        source_event_id: clean(extracted.event_id) || envelope_id,
        detail: { envelope_id },
        allowExternalEffects,
        supabase,
      });
    } catch (error) {
      warn("[CLOSING_WORKFLOW_ADVANCE_FAILED]", {
        closing_case_id,
        envelope_id,
        error: error?.message || "workflow_advance_failed",
      });
    }
  }

  info("[CLOSING_CASE_RECONCILED]", {
    closing_case_id,
    envelope_id,
    normalized_status,
    contract_status: transition.target.contract_status,
    workflow_advanced: Boolean(workflow?.advanced),
  });

  return {
    ok: true,
    reconciled: true,
    closing_case_id,
    envelope_id,
    normalized_status,
    contract_status: transition.target.contract_status,
    closing_case: updated || null,
    workflow,
    reason: "reconciled",
  };
}

export default reconcileClosingCaseFromEnvelope;
