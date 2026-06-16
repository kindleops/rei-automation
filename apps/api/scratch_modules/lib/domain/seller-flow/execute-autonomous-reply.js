import crypto from "node:crypto";
import { child } from "../lib/logging/logger.js";
import { normalizePhone } from "../lib/utils/phones.js";
import { hasSupabaseConfig, supabase as defaultSupabase } from "../lib/supabase/client.js";
import { evaluateQueueCreationRuntimeBrakes } from "../lib/domain/queue/queue-control-safety.js";
import { sendTextgridSMS } from "../lib/providers/textgrid.js";
import { getSystemValue } from "../lib/system-control.js";
import {
  insertSupabaseSendQueueRow,
  writeOutboundSuccessMessageEvent,
  writeOutboundFailureMessageEvent,
} from "../lib/supabase/sms-engine.js";

const logger = child({ module: "domain.auto_reply.execute_autonomous_reply" });

function clean(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBodyForFingerprint(value = "") {
  return clean(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTransportFingerprint({ to_phone_number, message_body, now = Date.now() }) {
  const window_ms = 24 * 60 * 60 * 1000; // 24-hour window for autonomous sends
  const window_bucket = Math.floor(now / window_ms);
  const seed = `${clean(to_phone_number)}|${normalizeBodyForFingerprint(message_body)}|${window_bucket}`;
  return crypto.createHash("sha256").update(seed).digest("hex");
}

export async function executeAutonomousReply(input = {}, deps = {}) {
  const {
    supabase = defaultSupabase,
    sendTextgridImpl = sendTextgridSMS,
    insertQueueImpl = insertSupabaseSendQueueRow,
  } = deps;

  const now = nowIso();
  const thread_key = clean(input.thread_key);
  const to_phone = normalizePhone(clean(input.to_phone_number));
  const from_phone = normalizePhone(clean(input.from_phone_number));
  const message_body = clean(input.message_body);
  const template_id = clean(input.template_id);
  const source_event_id = clean(input.source_event_id);
  const stage = clean(input.stage);

  if (!thread_key || !to_phone || !from_phone || !message_body || !source_event_id) {
    logger.warn("auto_reply.missing_required_fields", { input });
    return { ok: false, reason: "missing_required_fields" };
  }

  const get_system_value =
    deps.getSystemValue || (hasSupabaseConfig() ? getSystemValue : async () => null);
  const runtime_brake = evaluateQueueCreationRuntimeBrakes(
    {
      campaign_mode: await get_system_value("campaign_mode"),
      queue_emergency_stop_at: await get_system_value("queue_emergency_stop_at"),
    },
    { action: "autonomous_reply_queue_create", failClosed: false }
  );
  if (!runtime_brake.ok) {
    logger.warn("auto_reply.blocked_runtime_brake", {
      reason: runtime_brake.reason,
      thread_key,
    });
    return {
      ok: false,
      status: 423,
      reason: runtime_brake.reason,
      error: runtime_brake.error,
      diagnostics: runtime_brake.diagnostics,
    };
  }

  // ── 1. Idempotency Check (inbound_event_id + stage + response_template_id)
  const idempotency_key = `auto_reply:${source_event_id}:${stage}:${template_id || "no_template"}`;
  
  try {
    const { data: existing } = await supabase
      .from("send_queue")
      .select("id,queue_status")
      .eq("metadata->>idempotency_key", idempotency_key)
      .limit(1)
      .maybeSingle();

    if (existing) {
      logger.warn("auto_reply.idempotency_blocked", { idempotency_key, thread_key });
      return { ok: false, reason: "idempotency_blocked" };
    }
  } catch (err) {
    logger.error("auto_reply.idempotency_check_error", { error: err.message });
    // Fail safe: block
    return { ok: false, reason: "idempotency_check_error" };
  }

  // ── 2. 24-hour Duplicate Body Guard
  const transport_fingerprint = buildTransportFingerprint({
    to_phone_number: to_phone,
    message_body,
    now: Date.now()
  });

  try {
    const window_start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: duplicate_count } = await supabase
      .from("send_queue")
      .select("id", { count: "exact", head: true })
      .eq("to_phone_number", to_phone)
      .in("queue_status", ["sent", "delivered", "processing", "queued"])
      .contains("metadata", { transport_fingerprint })
      .gte("created_at", window_start);

    if ((duplicate_count ?? 0) > 0) {
      logger.warn("auto_reply.duplicate_body_blocked", { to_phone, thread_key });
      
      // Audit as blocked
      await insertQueueImpl({
        queue_key: `auto_reply:blocked:${crypto.randomUUID()}`,
        queue_status: "blocked",
        scheduled_for: now,
        scheduled_for_utc: now,
        scheduled_for_local: now,
        message_body,
        to_phone_number: to_phone,
        from_phone_number: from_phone,
        thread_key,
        type: "outbound",
        message_type: input.message_type || "auto_reply",
        metadata: {
          action_type: "autopilot_inbound_reply",
          idempotency_key,
          transport_fingerprint,
          blocked_reason: "24h_duplicate_body",
          source_event_id,
        }
      }).catch(() => null);

      return { ok: false, reason: "24h_duplicate_body" };
    }
  } catch (err) {
    logger.error("auto_reply.duplicate_check_error", { error: err.message });
    return { ok: false, reason: "duplicate_check_error" };
  }

  // ── 3. Create Processing Queue Row
  const lock_token = `auto_reply:${crypto.randomUUID()}`;
  let queue_insert = null;
  try {
    queue_insert = await insertQueueImpl({
      queue_key: lock_token,
      queue_status: "processing",
      scheduled_for: now,
      scheduled_for_utc: now,
      scheduled_for_local: now,
      is_locked: true,
      locked_at: now,
      lock_token,
      message_body,
      to_phone_number: to_phone,
      from_phone_number: from_phone,
      thread_key,
      type: "outbound",
      message_type: input.message_type || "auto_reply",
      use_case_template: input.use_case || null,
      master_owner_id: input.master_owner_id || null,
      property_id: input.property_id || null,
      metadata: {
        action_type: "autopilot_inbound_reply",
        idempotency_key,
        transport_fingerprint,
        source_event_id,
        stage,
        template_id,
      }
    });
  } catch (err) {
    logger.error("auto_reply.queue_insert_error", { error: err.message });
    return { ok: false, reason: "queue_insert_error" };
  }

  const queue_row_id = queue_insert?.queue_row_id || queue_insert?.item_id || null;
  if (!queue_row_id) {
    return { ok: false, reason: "queue_insert_failed" };
  }

  // ── 4. Immediate Provider Send
  let send_result = null;
  let provider_error = null;

  try {
    send_result = await sendTextgridImpl({
      to: to_phone,
      from: from_phone,
      body: message_body,
      client_reference_id: queue_row_id,
      bypass_system_control: false, // Respect global system flags
      bypass_reason: "autonomous_reply",
      bypass_content_guards: false,
    });
  } catch (err) {
    provider_error = err;
    logger.error("auto_reply.dispatch_failed", {
      error: err.message,
      queue_row_id,
    });
  }

  // ── 5. Finalize Queue & Write Events
  if (!send_result || !send_result.ok || provider_error) {
    const error_msg = provider_error?.message || send_result?.error || "unknown_provider_error";
    
    await supabase
      .from("send_queue")
      .update({
        queue_status: "failed",
        failed_reason: "delivery_failed",
        is_locked: false,
        lock_token: null,
        locked_at: null,
        updated_at: nowIso(),
        metadata: {
          ...queue_insert.raw?.metadata,
          provider_error: { message: error_msg },
        }
      })
      .eq("id", queue_row_id);

    try {
      await writeOutboundFailureMessageEvent({
        supabase,
        queue_row: {
          id: queue_row_id,
          thread_key,
          to_phone_number: to_phone,
          from_phone_number: from_phone,
          message_body,
          type: "outbound",
          message_type: input.message_type || "auto_reply",
          master_owner_id: input.master_owner_id,
          property_id: input.property_id,
          metadata: queue_insert.raw?.metadata || {},
        },
        error_message: error_msg,
        delivery_status: "undelivered",
      });
    } catch (evtErr) {
      logger.error("auto_reply.failed_to_write_error_event", { error: evtErr.message });
    }

    return { ok: false, reason: "provider_dispatch_failed", error: error_msg };
  }

  // Success
  await supabase
    .from("send_queue")
    .update({
      queue_status: "sent",
      provider_message_id: send_result.sid,
      textgrid_message_id: send_result.sid,
      delivery_confirmed: "⏳ Pending",
      is_locked: false,
      lock_token: null,
      locked_at: null,
      updated_at: nowIso(),
      metadata: {
        ...queue_insert.raw?.metadata,
        provider_cost: send_result.price || null,
        provider_segments: send_result.numSegments || 1,
      }
    })
    .eq("id", queue_row_id);

  try {
    await writeOutboundSuccessMessageEvent({
      supabase,
      queue_row: {
        id: queue_row_id,
        thread_key,
        to_phone_number: to_phone,
        from_phone_number: from_phone,
        message_body,
        type: "outbound",
        message_type: input.message_type || "auto_reply",
        master_owner_id: input.master_owner_id,
        property_id: input.property_id,
        metadata: queue_insert.raw?.metadata || {},
      },
      provider_message_id: send_result.sid,
      textgrid_message_id: send_result.sid,
      num_segments: send_result.numSegments || 1,
      price: send_result.price || null,
    });
  } catch (evtErr) {
    logger.error("auto_reply.failed_to_write_success_event", { error: evtErr.message });
  }

  return {
    ok: true,
    queue_row_id,
    provider_message_id: send_result.sid,
  };
}
