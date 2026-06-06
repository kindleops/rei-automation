import { clean } from "@/lib/utils/strings.js";
import { normalizePhone } from "@/lib/utils/phones.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";

const BLOCKED_INTENTS = new Set([
  "stop",
  "opt_out",
  "dnc",
  "do_not_contact",
  "legal_threat",
  "hostile_legal",
  "wrong_number",
]);

function quotePostgrestValue(value) {
  return `"${clean(value).replaceAll('"', '""')}"`;
}

/**
 * Centralized Hard Stop Guard.
 * Evaluates whether an outbound SMS is strictly forbidden by compliance rules.
 * 
 * Rules:
 * 1. thread_state indicates opt_out, suppressed, or hard negative intent.
 * 2. previous message_events show an opt_out, STOP, or hard negative intent.
 * 3. phone number is listed as active in sms_suppression_list.
 */
export async function evaluateComplianceHardStop({
  thread_key = null,
  to_phone_number = null,
  supabase = defaultSupabase,
} = {}) {
  const normalized_to = normalizePhone(to_phone_number);
  if (!normalized_to && !thread_key) {
    return { blocked: false, reason: null };
  }

  // 1. Check thread_state if we have a thread_key
  if (thread_key) {
    try {
      const { data: thread_state } = await supabase
        .from("deal_thread_state")
        .select("thread_key,universal_status,inbox_bucket,primary_intent,universal_stage,opt_out")
        .eq("thread_key", thread_key)
        .maybeSingle();

      if (thread_state) {
        const thread_intent = clean(thread_state.primary_intent).toLowerCase();
        const status_bucket = clean(thread_state.inbox_bucket).toLowerCase();
        const stage = clean(thread_state.universal_stage).toLowerCase();
        
        if (
          thread_state.opt_out === true ||
          thread_state.universal_status === "suppressed" ||
          status_bucket === "suppressed" ||
          BLOCKED_INTENTS.has(thread_intent) ||
          BLOCKED_INTENTS.has(stage)
        ) {
          return { blocked: true, reason: "compliance_suppressed_thread" };
        }
      }
    } catch {
      // non-fatal, continue to message-level compliance checks
    }

    // 2. Check message_events for prior STOP/Opt-out
    try {
      const { data: event_rows } = await supabase
        .from("message_events")
        .select("id,is_opt_out,opt_out_keyword,detected_intent,message_body,created_at")
        .eq("thread_key", thread_key)
        .order("created_at", { ascending: false })
        .limit(50);

      if (Array.isArray(event_rows)) {
        const has_opt_out = event_rows.some((row) => row?.is_opt_out === true);
        if (has_opt_out) return { blocked: true, reason: "compliance_opt_out_event" };

        const has_hard_intent = event_rows.some((row) =>
          BLOCKED_INTENTS.has(clean(row?.detected_intent).toLowerCase())
        );
        if (has_hard_intent) return { blocked: true, reason: "compliance_hard_intent" };

        const has_stop_language = event_rows.some((row) => {
          const keyword = clean(row?.opt_out_keyword).toLowerCase();
          const body = clean(row?.message_body).toLowerCase();
          return keyword === "stop" || body === "stop";
        });
        if (has_stop_language) return { blocked: true, reason: "compliance_stop" };
      }
    } catch {
      // non-fatal
    }
  }

  // 3. Global Suppression List Check
  if (normalized_to) {
    try {
      const suppression_phone_filter = [
        `phone_number.eq.${quotePostgrestValue(normalized_to)}`,
        `phone_e164.eq.${quotePostgrestValue(normalized_to)}`,
      ].join(",");

      const { data: suppression_rows, error } = await supabase
        .from("sms_suppression_list")
        .select("id,phone_number,phone_e164,reason,suppression_reason,suppression_type,is_active,suppressed_at")
        .or(suppression_phone_filter)
        .eq("is_active", true)
        .limit(1);

      if (!error && Array.isArray(suppression_rows) && suppression_rows.length > 0) {
        return { blocked: true, reason: "compliance_suppression_list" };
      }
      
      if (error) {
        return { blocked: false, reason: null, degraded: true, degradation_reason: "sms_suppression_list_query_failed" };
      }
    } catch (error) {
      return { blocked: false, reason: null, degraded: true, degradation_reason: "sms_suppression_list_exception" };
    }
  }

  return { blocked: false, reason: null };
}
