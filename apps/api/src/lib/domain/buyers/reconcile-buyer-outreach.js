/**
 * THE OUTREACH TARGET LEARNS WHAT THE QUEUE ALREADY KNOWS (§1, §2, §3).
 *
 * `buyer_outreach_targets` records intent; `send_queue` records execution. Left
 * unwired, a target would say `queued` forever while the queue had long since
 * recorded sent, delivered, blocked or failed — an operator reading the
 * disposition would be looking at a lie with a timestamp on it.
 *
 * This does NOT introduce a second delivery system. It has no polling, no
 * provider calls and no opinions: the queue row is the authority and this
 * mirrors its terminal state across, keyed by the `dedupe_key` both sides
 * already share. Canonical delivery reconciliation stays exactly where it is.
 *
 * §3 — BLOCKED BEFORE THE PROVIDER IS NOT A PROVIDER FAILURE. A suppressed
 * destination, an ineligible sender, a contact-window hold and a duplicate touch
 * all mean the provider was never contacted. Collapsing those into "failed"
 * would tell an operator TextGrid rejected a message that was never sent, and
 * would put a retry count on work that has nothing to retry. They map to their
 * own states and carry their own reason.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { isBuyerDispositionSend } from "@/lib/domain/buyers/buyer-send-kind.js";

const OUTREACH_TABLE = "buyer_outreach_targets";

const clean = (value) => String(value ?? "").trim();

/**
 * Queue state → outreach state.
 *
 * Deliberately NOT a 1:1 copy. The queue's vocabulary describes a unit of work;
 * the outreach target describes what happened to an attempt to reach a buyer,
 * and the difference is exactly the blocked/failed distinction above.
 */
export function outreachStatusForQueueRow(queue_row = {}) {
  const status = clean(queue_row.queue_status).toLowerCase();

  // Nothing reached the provider in any of these. Keep them separable from
  // transport failure, and keep the reason the queue recorded.
  if (status === "blocked_sender_ineligible") return { status: "blocked", blocked_reason: "sender_ineligible" };
  if (status === "paused_sender_eligibility_unavailable") return { status: "deferred", blocked_reason: "sender_eligibility_unavailable" };
  if (status === "blocked_by_health_guard") return { status: "blocked", blocked_reason: "health_guard" };
  if (status === "duplicate_blocked") return { status: "blocked", blocked_reason: "duplicate_touch" };
  if (status.startsWith("paused_")) return { status: "deferred", blocked_reason: status };
  if (status === "cancelled") return { status: "cancelled", blocked_reason: null };

  if (status === "delivered") return { status: "delivered", blocked_reason: null };
  if (status === "sent") return { status: "sent", blocked_reason: null };
  if (status === "sending") return { status: "sending", blocked_reason: null };
  if (status === "scheduled") return { status: "scheduled", blocked_reason: null };
  if (status === "queued" || status === "ready" || status === "runnable") return { status: "queued", blocked_reason: null };

  // A genuine transport failure — the provider WAS contacted and refused.
  if (status === "failed" || status === "failed_transport") {
    return { status: "failed", blocked_reason: null };
  }

  return null;
}

/**
 * Mirror one queue row onto its outreach target.
 *
 * Returns `{ ok, skipped }` rather than throwing: reconciliation must never be
 * able to fail a send that already happened. A target that briefly lags is
 * recoverable; a dispatch that threw because a bookkeeping write failed is not.
 */
export async function reconcileBuyerOutreachFromQueueRow(queue_row = {}, deps = {}) {
  if (!isBuyerDispositionSend(queue_row)) return { ok: true, skipped: "not_buyer_traffic" };

  const dedupe_key = clean(queue_row.dedupe_key) || clean(queue_row.queue_key);
  const target_id = clean(queue_row?.metadata?.buyer_outreach_target_id);
  if (!dedupe_key && !target_id) return { ok: true, skipped: "no_outreach_linkage" };

  const mapped = outreachStatusForQueueRow(queue_row);
  if (!mapped) return { ok: true, skipped: "unmapped_queue_status" };

  const db = deps.supabase || defaultSupabase;
  const now = deps.now || new Date().toISOString();

  const patch = {
    status: mapped.status,
    blocked_reason: mapped.blocked_reason,
    updated_at: now,
  };

  // Only ever fills the join in — never blanks an existing one. A row matched
  // by `metadata.buyer_outreach_target_id` alone carries no dedupe key, and
  // writing null there would erase the link the materializer already stored.
  if (dedupe_key) patch.send_queue_key = dedupe_key;

  const provider_message_id = clean(queue_row.provider_message_id);
  if (provider_message_id) patch.provider_message_id = provider_message_id;

  const delivery = clean(queue_row.delivery_confirmed) || clean(queue_row.delivery_status);
  if (delivery) patch.delivery_status = delivery;

  try {
    if (typeof deps.updateOutreachTarget === "function") {
      await deps.updateOutreachTarget({ dedupe_key, target_id, patch });
      return { ok: true, status: mapped.status };
    }

    const query = db.from(OUTREACH_TABLE).update(patch);
    await (target_id ? query.eq("id", target_id) : query.eq("dedupe_key", dedupe_key));
    return { ok: true, status: mapped.status };
  } catch (error) {
    // Logged by the caller if it cares. Never rethrow — see above.
    return { ok: false, reason: error?.message || "outreach_reconcile_failed" };
  }
}
