import { info } from "@/lib/logging/logger.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import { evaluateCanonicalContactability } from "@/lib/domain/compliance/evaluate-canonical-contactability.js";

const QUEUE_TABLE = "send_queue";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Final send-time compliance block — cancels/suppresses row without TextGrid call.
 * Race strategy: fresh read of row status + live suppression state immediately
 * before transport (no DB transaction held across provider request).
 */
export async function blockSendAtCompliance(
  queue_row = {},
  lock_token = null,
  compliance = {},
  deps = {}
) {
  const supabase = deps.supabase || deps.supabaseClient;
  const now = deps.now || new Date().toISOString();
  const queue_row_id = clean(queue_row.id);
  const reason_code = clean(compliance.reason_code) || "suppressed_at_send_time";
  const internal_reason = clean(compliance.reason) || "compliance_blocked";
  const meta = queue_row.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};

  if (!supabase || !queue_row_id) {
    return {
      ok: false,
      sent: false,
      skipped: true,
      reason: reason_code,
      final_queue_status: queue_row.queue_status || null,
      queue_row_id,
    };
  }

  await supabase
    .from(QUEUE_TABLE)
    .update({
      queue_status: "cancelled",
      failed_reason: null,
      is_locked: false,
      locked_at: null,
      lock_token: null,
      updated_at: now,
      metadata: {
        ...meta,
        skip_reason: reason_code,
        cancellation_reason: reason_code,
        compliance_block_reason: internal_reason,
        compliance_blocked_at_send_time: true,
        send_time_guard_blocked: true,
        claimed_row_race_prevented: Boolean(lock_token),
        finalized_at: now,
        final_queue_status: "cancelled",
        next_retry_at: null,
        provider_error: null,
      },
    })
    .eq("id", queue_row_id);

  info("compliance.send_time_guard_blocked", {
    queue_row_id,
    reason_code,
    internal_reason,
    queue_type: queue_row.type || queue_row.message_type || null,
    thread_key: queue_row.thread_key || null,
    lifecycle_stage: queue_row.current_stage || meta.stage_code || null,
    claimed_row_race_prevented: Boolean(lock_token),
  });

  try {
    await emitAutomationEvent(
      {
        event_type: "OUTBOUND_BLOCKED_SEND_TIME_COMPLIANCE",
        dedupe_key: `send_time_block:${queue_row_id}:${reason_code}`,
        queue_item_id: queue_row_id,
        payload: {
          reason_code,
          internal_reason,
          queue_type: queue_row.type || queue_row.message_type || null,
          thread_key: queue_row.thread_key || null,
          blocked_at: now,
        },
      },
      { supabase }
    );
  } catch {
    // observability must not block the guard
  }

  return {
    ok: true,
    sent: false,
    skipped: true,
    blocked: true,
    reason: reason_code,
    compliance_reason: internal_reason,
    queue_status: "cancelled",
    final_queue_status: "cancelled",
    queue_row_id,
    queue_item_id: queue_row_id,
    retryable: false,
  };
}

export async function evaluateAndBlockSendAtCompliance(queue_row = {}, deps = {}) {
  const supabase = deps.supabase || deps.supabaseClient;
  const manual_operator_send = deps.manual_operator_send === true;
  const compliance = await evaluateCanonicalContactability(
    {
      thread_key: queue_row.thread_key,
      to_phone_number: queue_row.to_phone_number,
      from_phone_number: queue_row.from_phone_number,
      phone_id: queue_row.phone_number_id || queue_row.metadata?.phone_id,
      prospect_id: queue_row.prospect_id,
      master_owner_id: queue_row.master_owner_id,
      queue_row_id: queue_row.id,
      queue_status: queue_row.queue_status,
      manual_operator_send,
      fail_closed_for_automated: !manual_operator_send,
    },
    { supabase }
  );

  if (!compliance.blocked) {
    return { blocked: false, compliance, result: null };
  }

  const result = await blockSendAtCompliance(
    queue_row,
    deps.claimedLockToken || queue_row.lock_token,
    compliance,
    deps
  );
  return { blocked: true, compliance, result };
}

export default blockSendAtCompliance;