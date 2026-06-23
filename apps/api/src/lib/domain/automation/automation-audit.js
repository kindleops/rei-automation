import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";

export const AUTOMATION_LOG_TAGS = Object.freeze({
  event_ingested: "[AUTOMATION_EVENT_INGESTED]",
  rule_matched: "[AUTOMATION_RULE_MATCHED]",
  action_started: "[AUTOMATION_ACTION_STARTED]",
  action_success: "[AUTOMATION_ACTION_SUCCESS]",
  action_skipped: "[AUTOMATION_ACTION_SKIPPED]",
  action_failed: "[AUTOMATION_ACTION_FAILED]",
  state_patched: "[AUTOMATION_STATE_PATCHED]",
  suppression_applied: "[AUTOMATION_SUPPRESSION_APPLIED]",
  emit_failed_non_blocking: "[AUTOMATION_EMIT_FAILED_NON_BLOCKING]",
  live_send_blocked: "[AUTOMATION_LIVE_SEND_BLOCKED]",
  idempotency_skip: "[AUTOMATION_IDEMPOTENCY_SKIP]",
});

function clean(value) {
  return String(value ?? "").trim();
}

function compact(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

export function logAutomationConsole(tag, payload = {}) {
  try {
    console.log(tag, JSON.stringify(payload));
  } catch {
    console.log(tag);
  }
}

export function buildAuditPayload(input = {}) {
  const event = input.event || {};
  const run = input.run || {};
  const action = input.action || {};

  return compact({
    automation_event_id: input.automation_event_id || event.id || null,
    automation_run_id: input.automation_run_id || run.id || null,
    automation_action_id: input.automation_action_id || action.id || null,
    event_type: clean(input.event_type || event.event_type || run.event_type) || null,
    action_type: clean(input.action_type || action.action_type) || null,
    rule_key: clean(input.rule_key || run.rule_key || action.rule_key) || null,
    status: clean(input.status) || null,
    log_type: clean(input.log_type) || "info",
    message: clean(input.message) || null,
    conversation_thread_id:
      clean(input.conversation_thread_id || event.conversation_thread_id || run.conversation_thread_id) || null,
    property_id: clean(input.property_id || event.property_id || run.property_id) || null,
    prospect_id: clean(input.prospect_id || event.prospect_id || run.prospect_id) || null,
    master_owner_id:
      clean(input.master_owner_id || event.master_owner_id || run.master_owner_id) || null,
    phone_number_id:
      clean(input.phone_number_id || event.phone_number_id || run.phone_number_id) || null,
    queue_item_id: clean(input.queue_item_id || event.queue_item_id || run.queue_item_id) || null,
    payload: input.payload && typeof input.payload === "object" ? input.payload : {},
    error_code: clean(input.error_code) || null,
    error_message: clean(input.error_message) || null,
    error_payload:
      input.error_payload && typeof input.error_payload === "object" ? input.error_payload : null,
  });
}

export async function writeAutomationAuditLog(input = {}, options = {}) {
  const db = options.supabaseClient || options.supabase || getDefaultSupabaseClient();
  const row = buildAuditPayload(input);

  if (input.console_tag) {
    logAutomationConsole(input.console_tag, {
      event_type: row.event_type,
      rule_key: row.rule_key,
      action_type: row.action_type,
      status: row.status,
      automation_event_id: row.automation_event_id,
      automation_run_id: row.automation_run_id,
      automation_action_id: row.automation_action_id,
    });
  }

  if (!db?.from) {
    return { ok: false, skipped: true, reason: "supabase_unavailable", row };
  }

  try {
    const { data, error } = await db
      .from("automation_audit_log")
      .insert(row)
      .select()
      .maybeSingle();
    if (error) throw error;
    return { ok: true, row: data || row };
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      reason: "audit_log_write_failed",
      error: error?.message || "audit_log_write_failed",
      row,
    };
  }
}

export default writeAutomationAuditLog;
