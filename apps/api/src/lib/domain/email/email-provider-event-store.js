/**
 * email-provider-event-store.js
 *
 * The durable side of the provider-event seam: the only module that reads or
 * writes the tables the reconciler reasons about.
 *
 * Thin on purpose, exactly like seller-communication-store.js. Every interesting
 * decision -- may this advance, is it stale, does it suppress -- lives in the
 * reconciler and the lattice. A store that also decided policy would be a second
 * place for the rules to drift, and it is the place least likely to be read.
 */

import { child } from "@/lib/logging/logger.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { deliveryPossibilityFor } from "@/lib/domain/email/email-provider-outcome-lattice.js";

const logger = child({ module: "domain.email.event_store" });

function clean(value) {
  return String(value ?? "").trim();
}

export function createEmailProviderEventStore(deps = {}) {
  const supabase = deps.supabase || defaultSupabase;

  return {
    /**
     * Record the event. Idempotency is the UNIQUE index on event_key, not a
     * read-then-write: two workers handling the same redelivery would interleave
     * between the read and the write, and the second would insert a duplicate.
     */
    async recordEvent(event = {}) {
      const row = {
        event_key: event.event_key,
        provider: "brevo",
        provider_event_id: event.provider_event_id || null,
        provider_message_id: event.provider_message_id || null,
        direction: "outbound",
        event_type: event.event_type || "unknown",
        event_kind: event.event_kind || null,
        provider_outcome: event.provider_outcome || null,
        suppression_reason: event.suppression_reason || null,
        to_email: event.email_address || null,
        subject: event.subject || null,
        trust_class: event.trust_class || null,
        logical_communication_id: event.logical_communication_id || null,
        attempt_id: event.attempt_id || null,
        processing_status: event.processing_status || null,
        processing_reason: event.processing_reason || null,
        raw_payload: event.raw_payload && typeof event.raw_payload === "object" ? event.raw_payload : {},
        event_at: event.event_at || null,
        updated_at: event.recorded_at || new Date().toISOString(),
      };

      const { error } = await supabase
        .from("email_events")
        .upsert(row, { onConflict: "event_key", ignoreDuplicates: true });

      if (error) {
        // Losing the audit row does not undo the decision, but it must be loud:
        // an unrecorded event is a question an operator cannot answer later.
        logger.error("email_event.record_failed", {
          event_key: event.event_key, reason: clean(error.message) || "unknown",
        });
        return { ok: false, reason: "email_event_record_failed" };
      }
      return { ok: true };
    },

    /**
     * Which send does this provider message id describe?
     *
     * Reads the append-only attempt ledger, never the queue projection. The
     * queue can be repaired; the ledger is the record of what actually happened.
     */
    async resolveAttempt({ provider_message_id } = {}) {
      const id = clean(provider_message_id);
      if (!id) return { ok: false, reason: "missing_provider_message_id" };

      const { data, error } = await supabase
        .from("seller_communication_attempts")
        .select("id, logical_communication_id, provider_message_id, outcome_class, delivery_possibility")
        .eq("provider_message_id", id)
        .order("attempt_number", { ascending: false })
        .limit(1);

      if (error) {
        logger.error("email_event.resolve_failed", { reason: clean(error.message) || "unknown" });
        return { ok: false, reason: "attempt_lookup_failed" };
      }

      const attempt = Array.isArray(data) ? data[0] : null;
      if (!attempt) return { ok: false, reason: "no_attempt_for_provider_message_id" };

      // Read the CURRENT provider outcome from the communication, because the
      // lattice compares against what we already believe, not against what this
      // one attempt happened to record.
      const { data: comm } = await supabase
        .from("seller_logical_communications")
        .select("id, state, delivery_possibility, retry_authority")
        .eq("id", attempt.logical_communication_id)
        .maybeSingle();

      return {
        ok: true,
        attempt_id: attempt.id,
        logical_communication_id: attempt.logical_communication_id,
        provider_outcome: clean(attempt.outcome_class) || null,
        communication: comm || null,
      };
    },

    /**
     * Apply an authorised delivery outcome.
     *
     * Ledger first, projection last, and a projection failure never undoes the
     * ledger write: reconciliation repairs projections, it never re-sends.
     */
    async applyOutcome(input = {}) {
      const delivery_possibility =
        input.delivery_possibility || deliveryPossibilityFor(input.provider_outcome);

      const { error } = await supabase
        .from("seller_logical_communications")
        .update({
          delivery_possibility,
          // `delivered` is the only state a provider event may set, and only
          // because it is the strongest and most terminal thing a provider can
          // tell us. Every other outcome leaves state alone: an event increases
          // certainty about delivery, it does not re-drive the send lifecycle.
          ...(input.provider_outcome === "delivered" ? { state: "delivered", retry_authority: "terminal" } : {}),
          updated_at: input.at || new Date().toISOString(),
        })
        .eq("id", input.logical_communication_id);

      if (error) {
        logger.error("email_event.apply_failed", {
          logical_communication_id: input.logical_communication_id,
          reason: clean(error.message) || "unknown",
        });
        return { ok: false, reason: "outcome_apply_failed" };
      }

      // Projection. Best effort, and explicitly not authority.
      try {
        const patch = {
          provider_outcome: input.provider_outcome,
          last_event_at: input.event_at || null,
          updated_at: input.at || new Date().toISOString(),
        };
        if (input.event_type === "delivered") patch.delivered_at_event = input.event_at;
        if (input.event_type === "hard_bounce" || input.event_type === "soft_bounce") {
          patch.bounced_at = input.event_at;
        }
        await supabase
          .from("email_queue")
          .update(patch)
          .eq("logical_communication_id", input.logical_communication_id);
      } catch (error_projection) {
        logger.warn("email_event.projection_repair_needed", {
          logical_communication_id: input.logical_communication_id,
          error: clean(error_projection?.message) || "projection_failed",
        });
      }

      return { ok: true };
    },

    /**
     * Add or strengthen a suppression.
     *
     * Keyed on the NORMALIZED address, and also written against the folded
     * mailbox identity when they differ, so a seller who unsubscribed as
     * bob+house@gmail.com is not emailed at bob@gmail.com tomorrow.
     */
    async applySuppression(input = {}) {
      const addresses = [...new Set([
        clean(input.email_address),
        clean(input.mailbox_identity),
      ].filter(Boolean))];

      if (!addresses.length) return { ok: false, reason: "missing_email_address" };

      const at = input.event_at || new Date().toISOString();
      const rows = addresses.map((email_address) => ({
        email_address,
        reason: input.reason,
        source: input.source || "brevo_webhook",
        is_active: true,
        provider: "brevo",
        provider_message_id: input.provider_message_id || null,
        event_key: input.event_key || null,
        raw_payload: input.raw_payload && typeof input.raw_payload === "object" ? input.raw_payload : {},
        last_event_at: at,
        updated_at: at,
      }));

      const { error } = await supabase
        .from("email_suppression")
        .upsert(rows, { onConflict: "email_address" });

      if (error) {
        // A failed suppression write is the one storage failure that can put a
        // message in front of someone who asked us to stop, so it is an error
        // rather than a warning even though nothing here can undo it.
        logger.error("email_event.suppression_failed", {
          reason: clean(error.message) || "unknown", suppression_reason: input.reason,
        });
        return { ok: false, reason: "suppression_write_failed" };
      }
      return { ok: true, addresses };
    },

    /** Telemetry counters. Deliberately separate from every delivery write. */
    async recordTelemetry(input = {}) {
      const id = clean(input.provider_message_id);
      if (!id) return { ok: true, skipped: true };
      try {
        await supabase.rpc("email_queue_record_telemetry", {
          p_provider_message_id: id,
          p_event_type: input.event_type,
          p_event_at: input.event_at,
        });
      } catch {
        // Telemetry is the least important thing this system stores. It must
        // never be able to fail a webhook that also carried a suppression.
      }
      return { ok: true };
    },
  };
}

export default createEmailProviderEventStore;
