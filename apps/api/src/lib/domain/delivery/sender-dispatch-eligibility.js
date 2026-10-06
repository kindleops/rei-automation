/**
 * THE CANONICAL SENDER DISPATCH ELIGIBILITY (2026-10-02 owner invariant).
 *
 *   No production send path may dispatch from a number this function rejects.
 *
 * One answer, every path, Sender Routing 2.0 gate ON or OFF:
 *   1. operator blocklist   system_control.sms_blocked_sender_numbers + env
 *                           SMS_BLOCKED_SENDER_NUMBERS (the health guard's list)
 *   2. fleet record         the number must be in textgrid_numbers
 *   3. status / health / cooling / total ceiling / daily limit
 *                           evaluateOutboundNumberEligibility; the daily
 *                           (cold) limit is skipped for send_class
 *                           'conversational' (send-class.js), the total
 *                           ceiling never is
 *
 * Enforced before the canonical dispatch seam on both production entries
 * (pinned by tests/critical/sender-dispatch-eligibility-invariant.test.mjs):
 *   queue runner   sms-engine selectAvailableTextgridNumber — every queued row
 *                  (campaigns, auto-replies, follow-ups, late replies, queued
 *                  inbox replies) passes through it before dispatchSellerQueueRow
 *   manual send    send-now-service createInboxSendNowQueueRow, before the row
 *                  that dispatchManualOperatorSend sends from exists
 *
 * The blocklist read is STRICT: unreadable is not "nothing blocked". The pure
 * evaluator takes the set; loadDispatchBlockedSenders reads it fail-closed.
 */

import { evaluateOutboundNumberEligibility } from "@/lib/supabase/sms-engine.js";
import { getDispatchBlockedSets } from "@/lib/domain/delivery/sms-health-guard.js";

const clean = (value) => String(value ?? "").trim();

function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export const SENDER_BLOCKED_REASON = "outbound_number_blocked_by_operator";
export const SENDER_BLOCKLIST_UNREADABLE = "sender_blocklist_unreadable";

/**
 * Pure. fleet_row = the textgrid_numbers row (messages_sent_today derived), or
 * null. blocked = Set<E.164> from loadDispatchBlockedSenders (required).
 * Returns { ok, reason, terminal }.
 */
export function evaluateSenderDispatchEligibility(fleet_row, { blocked, now = new Date(), phone = null, send_class = null } = {}) {
  if (!(blocked instanceof Set)) return { ok: false, reason: SENDER_BLOCKLIST_UNREADABLE, terminal: false };
  const number = normalizePhone(phone || fleet_row?.phone_number);
  if (number && blocked.has(number)) return { ok: false, reason: SENDER_BLOCKED_REASON, terminal: false };
  return evaluateOutboundNumberEligibility(fleet_row, now, { send_class });
}

/**
 * The dispatch blocklist, read STRICTLY. Returns a Set, or null when it cannot
 * be read (callers refuse / defer). getSystemValue swallows read errors into
 * null, so when no reader is injected and a database is configured the value
 * is read straight from system_control. With no database configured (local
 * tooling) only the env list applies, as in the health guard.
 */
export async function loadDispatchBlockedSenders(deps = {}) {
  const env = deps.env || process.env;
  try {
    let value = null;
    if (typeof deps.getSystemValue === "function") {
      value = await deps.getSystemValue("sms_blocked_sender_numbers");
    } else {
      const { hasSupabaseConfig, supabase } = await import("@/lib/supabase/client.js");
      if (hasSupabaseConfig()) {
        const { data, error } = await supabase.from("system_control").select("value").eq("key", "sms_blocked_sender_numbers").maybeSingle();
        if (error) return null;
        value = data ? data.value : null;
      }
    }
    return new Set([...getDispatchBlockedSets(env, { sms_blocked_sender_numbers: value }).sender_numbers].map(normalizePhone).filter(Boolean));
  } catch {
    return null;
  }
}
