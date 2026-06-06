// ─── suppress-contact.js ─────────────────────────────────────────────────────
// P0 single suppression action (launch-stabilization-20260606).
//
// sms_suppression_list is the ONE suppression source of truth. It is read by:
//   * canonical_inbox_threads  -> the inbox "Suppressed" bucket (EXISTS join)
//   * evaluateComplianceHardStop (suppression-guard) -> invoked by textgrid.js
//     before EVERY outbound send, so a row here blocks all future sends,
//     including campaign sends ("removed from campaigns").
//
// Writing here on an inbound STOP therefore makes the UI and the sender agree and
// guarantees no further outbound touches the contact.

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { normalizePhone } from "@/lib/utils/phones.js";
import { info, warn } from "@/lib/logging/logger.js";

function quotePostgrestValue(value) {
  return `"${String(value ?? "").trim().replaceAll('"', '""')}"`;
}

/**
 * Idempotently record a phone number on the canonical suppression list.
 *
 * @param {{ phone_number?: string|null, reason?: string, source?: string, supabase?: any }} options
 * @returns {Promise<{ ok: boolean, phone_number?: string, already_suppressed?: boolean, reason?: string, error?: string }>}
 */
export async function suppressContactOnStop({
  phone_number = null,
  reason = "inbound_opt_out",
  source = "textgrid_inbound",
  supabase = defaultSupabase,
} = {}) {
  const normalized = normalizePhone(phone_number);
  if (!normalized) return { ok: false, reason: "no_phone" };
  if (!supabase?.from) return { ok: false, reason: "no_supabase" };

  try {
    // Idempotent: don't stack duplicate active rows for the same number.
    const phoneFilter = [
      `phone_e164.eq.${quotePostgrestValue(normalized)}`,
      `phone_number.eq.${quotePostgrestValue(normalized)}`,
    ].join(",");

    const { data: existing, error: existingError } = await supabase
      .from("sms_suppression_list")
      .select("id")
      .or(phoneFilter)
      .eq("is_active", true)
      .limit(1);

    if (!existingError && Array.isArray(existing) && existing.length > 0) {
      return { ok: true, already_suppressed: true, phone_number: normalized };
    }

    const { error } = await supabase.from("sms_suppression_list").insert({
      phone_number: normalized,
      phone_e164: normalized,
      suppression_reason: reason,
      reason,
      suppression_type: "opt_out",
      source,
      is_active: true,
      suppressed_at: new Date().toISOString(),
    });
    if (error) throw error;

    info("compliance.contact_suppressed_on_stop", { phone_number: normalized, reason, source });
    return { ok: true, phone_number: normalized };
  } catch (error) {
    warn("compliance.suppress_contact_failed", {
      phone_number: normalized,
      reason,
      message: error?.message || "unknown_suppression_error",
    });
    return { ok: false, reason: "suppress_failed", error: error?.message || "unknown" };
  }
}

export default suppressContactOnStop;
