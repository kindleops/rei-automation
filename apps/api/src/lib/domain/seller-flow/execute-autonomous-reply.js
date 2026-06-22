import crypto from "node:crypto";
import { child } from "@/lib/logging/logger.js";
import { normalizePhone } from "@/lib/utils/phones.js";
import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { getSystemValue } from "@/lib/system-control.js";
import { enqueueCanonicalOutboundSms } from "@/lib/domain/queue/canonical-queue-writer.js";

const logger = child({ module: "domain.auto_reply.execute_autonomous_reply" });

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeBodyForFingerprint(value = "") {
  return clean(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function buildTransportFingerprint({ to_phone_number, message_body, now = Date.now() }) {
  const window_ms = 24 * 60 * 60 * 1000;
  const window_bucket = Math.floor(now / window_ms);
  const seed = `${clean(to_phone_number)}|${normalizeBodyForFingerprint(message_body)}|${window_bucket}`;
  return crypto.createHash("sha256").update(seed).digest("hex");
}

/**
 * Queue an autonomous reply through the canonical writer only.
 * Provider dispatch is deferred to the queue processor — no direct TextGrid calls.
 */
export async function executeAutonomousReply(input = {}, deps = {}) {
  const supabase = deps.supabase ?? defaultSupabase;
  const get_system_value =
    deps.getSystemValue || (hasSupabaseConfig() ? getSystemValue : async () => null);

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

  const transport_fingerprint = buildTransportFingerprint({
    to_phone_number: to_phone,
    message_body,
    now: Date.now(),
  });

  if (supabase?.from) {
    try {
      const window_start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: duplicate_count } = await supabase
        .from("send_queue")
        .select("id", { count: "exact", head: true })
        .eq("to_phone_number", to_phone)
        .in("queue_status", ["sent", "delivered", "processing", "queued", "scheduled", "pending"])
        .contains("metadata", { transport_fingerprint })
        .gte("created_at", window_start);

      if ((duplicate_count ?? 0) > 0) {
        logger.warn("auto_reply.duplicate_body_blocked", { to_phone, thread_key });
        return { ok: false, reason: "24h_duplicate_body" };
      }
    } catch (err) {
      logger.error("auto_reply.duplicate_check_error", { error: err.message });
      return { ok: false, reason: "duplicate_check_error" };
    }
  }

  const result = await enqueueCanonicalOutboundSms(
    {
      ...input,
      thread_key,
      to_phone_number: to_phone,
      from_phone_number: from_phone,
      message_body,
      template_id,
      source_event_id,
      stage,
      queue_status: "queued",
      action_type: "autopilot_inbound_reply",
      scheduled_for: input.scheduled_for ?? null,
      timezone: input.timezone ?? "America/New_York",
      metadata: {
        transport_fingerprint,
        ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
      },
    },
    {
      supabase,
      getSystemValue: get_system_value,
      canSendImpl: deps.canSendImpl,
      insertQueueImpl: deps.insertQueueImpl,
    },
  );

  if (!result.ok) {
    logger.warn("auto_reply.canonical_enqueue_failed", {
      reason: result.reason,
      thread_key,
    });
    return result;
  }

  logger.info("auto_reply.queued", {
    thread_key,
    queue_row_id: result.queue_row_id,
    provider_dispatch: result.provider_dispatch,
  });

  return {
    ok: true,
    queue_row_id: result.queue_row_id,
    queue_status: result.queue_status,
    provider_dispatch: "deferred_to_queue_processor",
    sms_segments: result.sms_segments,
  };
}

export default { executeAutonomousReply };