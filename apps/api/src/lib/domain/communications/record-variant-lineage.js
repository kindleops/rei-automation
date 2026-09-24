/**
 * VARIANT LINEAGE — the canonical-store half of adaptive template delivery.
 *
 * Lives here, not beside the selector, because `seller_communication_attempts`
 * has a single-writer rule: only `lib/domain/communications/` may write it,
 * enforced by direct-callback-state-contract.test.mjs. That rule is what keeps
 * attempt state — including provider SIDs — from being stamped by whichever
 * module happens to be holding the row, so the selector asks this module
 * rather than reaching into the table itself.
 *
 * Writes only the variant columns. It never touches provider_message_id,
 * outcome_class, delivery_possibility or retry_authority: those are the
 * transport seam's to own, and a template concern must not be able to move a
 * communication's delivery state.
 */

import { child } from "@/lib/logging/logger.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";

const logger = child({ module: "domain.communications.variant_lineage" });
const clean = (value) => String(value ?? "").trim();

/**
 * Record which approved body an attempt used, and what it fell back from.
 *
 * BEST-EFFORT BY DESIGN. Observability must never be the reason a seller
 * message fails to send, so a failed write is logged and swallowed. The "one
 * body once" guarantee does not depend on this succeeding: it is held by the
 * unique index on (logical_communication_id, template_id), which the database
 * enforces whether or not this call lands.
 */
export async function recordVariantLineage(attemptId, lineage = {}, deps = {}) {
  const id = clean(attemptId);
  if (!id) return { ok: false, reason: "missing_attempt_id" };

  const supabase = deps.supabase || defaultSupabase;

  const { error } = await supabase
    .from("seller_communication_attempts")
    .update({
      template_id: clean(lineage.template_id) || null,
      variant_group_key: clean(lineage.variant_group_key) || null,
      variant_attempt_number: lineage.variant_attempt_number ?? null,
      fallback_from_template_id: clean(lineage.fallback_from_template_id) || null,
      fallback_reason: clean(lineage.fallback_reason) || null,
      template_selection_reason: clean(lineage.template_selection_reason) || null,
    })
    .eq("id", id);

  if (error) {
    logger.warn("variant_lineage.write_failed", { attempt_id: id, error: clean(error.message) });
    return { ok: false, reason: "lineage_write_failed" };
  }

  return { ok: true };
}

/**
 * Which approved bodies has this logical communication already used?
 *
 * Read from the durable ledger rather than held in memory: a fallback chain
 * spans asynchronous queue execution, so the process handling attempt 2 is
 * usually not the one that sent attempt 1.
 *
 * FAILS CLOSED. Not knowing which bodies a seller has already received is
 * precisely the state in which choosing another one is unsafe.
 */
export async function readVariantHistory(logicalCommunicationId, deps = {}) {
  const id = clean(logicalCommunicationId);
  if (!id) return { ok: true, attempted: [], attemptCount: 0, succeeded: false };

  const supabase = deps.supabase || defaultSupabase;
  const { data, error } = await supabase
    .from("seller_communication_attempts")
    .select("template_id,variant_attempt_number,outcome_class,delivery_possibility")
    .eq("logical_communication_id", id)
    .order("attempt_number", { ascending: true });

  if (error) {
    logger.error("variant_lineage.history_unreadable", {
      logical_communication_id: id,
      error: clean(error.message),
    });
    return { ok: false, reason: "attempt_history_unreadable", attempted: [], attemptCount: 0, succeeded: false };
  }

  const rows = data ?? [];

  /*
   * Success is read from the transport seam's own vocabulary. `provider_accepted`
   * counts: TextGrid accepting a message means it may already have reached the
   * seller, and sending a second wording on top of that is the duplicate this
   * whole mechanism exists to avoid. Only a content-filter verdict — which
   * proves the opposite — reopens the chain, and that check lives in the
   * fallback authority.
   */
  const succeeded = rows.some(
    (row) =>
      ["delivered", "provider_accepted"].includes(clean(row.delivery_possibility)) ||
      ["delivered", "accepted", "success"].includes(clean(row.outcome_class)),
  );

  return {
    ok: true,
    attempted: rows.map((row) => clean(row.template_id)).filter(Boolean),
    attemptCount: rows.length,
    succeeded,
  };
}

export default recordVariantLineage;
