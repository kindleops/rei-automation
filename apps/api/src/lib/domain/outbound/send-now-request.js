import { processSendQueue } from "@/lib/domain/queue/process-send-queue.js";
import { evaluateInternalSendPreflight } from "@/lib/domain/outbound/internal-send-preflight.js";
import { queueOutboundMessage } from "@/lib/flows/queue-outbound-message.js";
import {
  authorizeInternalSendRoute,
  internalSendRouteRefusal,
} from "@/lib/security/internal-send-route-auth.js";
import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { getSystemValue } from "@/lib/system-control.js";
import { checkThreadContactability } from "@/lib/domain/lead-state/check-thread-contactability.js";

function clean(value) {
  return String(value ?? "").trim();
}

function asNullablePositiveInteger(value, fallback = null) {
  const normalized = clean(value);
  if (!normalized) return fallback;

  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function previewMessage(value, max = 160) {
  const normalized = clean(value);
  if (!normalized) return null;
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function statusForResult(result) {
  if (result?.queued?.status) return result.queued.status;
  if (result?.processed?.status) return result.processed.status;
  return result?.queued?.ok === false || result?.processed?.ok === false ? 400 : 200;
}

export function serializeRouteError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || "Unknown error",
    stack: error?.stack || null,
  };
}

export function normalizeSendNowInput(input = {}) {
  const rendered_message_text =
    clean(input?.rendered_message_text) || clean(input?.message_text) || null;

  return {
    phone: clean(input?.phone),
    use_case: clean(input?.use_case) || null,
    language: clean(input?.language) || null,
    touch_number: asNullablePositiveInteger(input?.touch_number, null),
    rendered_message_text,
    message_override_present: Boolean(rendered_message_text),
    message_override_preview: previewMessage(rendered_message_text),
  };
}

export async function buildAndSendNow(
  {
    phone,
    use_case = null,
    language = null,
    touch_number = null,
    rendered_message_text = null,
  },
  deps = {}
) {
  const {
    queueOutboundMessageImpl = queueOutboundMessage,
    processSendQueueImpl = processSendQueue,
  } = deps;
  let queued;
  const get_system_value =
    deps.getSystemValue || (hasSupabaseConfig() ? getSystemValue : async () => null);
  // Both the runtime brakes and the compliance gate are evaluated before the
  // verdict is chosen. When the compliance gate refuses (suppression,
  // quarantine, paused review, ...), ITS reason is the verdict even if a brake
  // is also active: a compliance block is permanent, it is what the operator
  // and the records act on, and it outlives the emergency stop. The brake is
  // still reported, as also_blocked_by. Either refusal alone denies the send;
  // nothing is queued or sent unless both pass.
  const runtime_brake = await evaluateInternalSendPreflight({
    getSystemValue: get_system_value,
    action: "send_now_queue_create",
  });
  const runtime_brake_refusal = runtime_brake.ok
    ? null
    : {
        ok: false,
        stage: "runtime_brake",
        status: 423,
        reason: runtime_brake.reason,
        error: runtime_brake.error,
        message: runtime_brake.message,
        diagnostics: runtime_brake.diagnostics,
      };

  const can_send_fn = deps.canSend || deps.canSendImpl;
  if (typeof can_send_fn === "function") {
    let gate;
    try {
      gate = await can_send_fn(
        {
          to_phone_number: phone,
          thread_key: phone,
          message_body: rendered_message_text,
        },
        deps
      );
    } catch (gate_error) {
      // A failed compliance check never authorizes anything. If a brake is
      // already refusing, that refusal stands; otherwise the error propagates
      // exactly as it did before the brake was moved.
      if (runtime_brake_refusal) {
        return { queued: runtime_brake_refusal, processed: null };
      }
      throw gate_error;
    }
    if (!gate?.ok) {
      return {
        queued: {
          ok: false,
          stage: "can_send_gate",
          status: 423,
          reason: gate?.reason || "can_send_gate_refused",
          ...(runtime_brake_refusal
            ? {
                also_blocked_by: {
                  stage: "runtime_brake",
                  reason: runtime_brake_refusal.reason,
                  error: runtime_brake_refusal.error,
                },
              }
            : {}),
        },
        processed: null,
      };
    }
  }

  if (runtime_brake_refusal) {
    return { queued: runtime_brake_refusal, processed: null };
  }

  if (hasSupabaseConfig()) {
    const supabase = deps.supabase || defaultSupabase;
    try {
      const contactability = await checkThreadContactability(supabase, phone);
      if (contactability.blocks_send) {
        return {
          queued: {
            ok: false,
            stage: "contactability",
            status: 423,
            reason: "contactability_blocked",
            contactability_status: contactability.contactability_status,
          },
          processed: null,
        };
      }
    } catch (contactability_error) {
      return {
        queued: {
          ok: false,
          stage: "contactability",
          status: 423,
          reason: "contactability_check_unavailable",
          message: contactability_error?.message || "contactability_check_unavailable",
        },
        processed: null,
      };
    }
  }

  try {
    queued = await queueOutboundMessageImpl({
      phone,
      use_case,
      language,
      touch_number,
      rendered_message_text,
    });
  } catch (error) {
    return {
      queued: {
        ok: false,
        stage: "queue_build",
        reason: "queue_build_failed",
        message: error?.message || "queue_build_failed",
      },
      processed: null,
    };
  }

  const queue_item_id =
    queued?.queue_item_id ||
    queued?.item_id ||
    queued?.result?.queue_item_id ||
    null;

  if (!queued?.ok) {
    return {
      queued,
      processed: null,
    };
  }

  if (!queue_item_id) {
    return {
      queued,
      processed: {
        ok: false,
        sent: false,
        reason: "missing_queue_item_id_after_queue",
      },
    };
  }

  let processed;

  try {
    processed = await processSendQueueImpl({
      queue_item_id,
    });
  } catch (error) {
    processed = {
      ok: false,
      sent: false,
      stage: "queue_processing",
      reason: "queue_processing_failed",
      message: error?.message || "queue_processing_failed",
      queue_item_id,
    };
  }

  return {
    queued,
    processed,
  };
}

/**
 * Log-safe destination: never the number itself (founder P0 2026-11-23 item 6:
 * phones and message text stay out of request logs). The last four digits are
 * enough to correlate with an operator's report; nothing more is recorded.
 */
export function maskPhoneForLog(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return null;
  return `***${digits.slice(-4)}`;
}

export const SEND_NOW_ALLOWED_METHODS = Object.freeze(["POST"]);

export async function handleSendNowRequestData(request, method = "POST", deps = {}) {
  const {
    logger,
    queueOutboundMessageImpl = queueOutboundMessage,
    processSendQueueImpl = processSendQueue,
    authorizeRequest = authorizeInternalSendRoute,
  } = deps;

  // FOUNDER P0 2026-11-23 item 6: no message sending via URL parameters. A GET
  // carried the destination phone and the message text in the query string,
  // where every proxy, access log and browser history keeps them. Only an
  // authenticated POST with the message in its body can send. Refused before
  // the request is authenticated or read, so nothing from the URL is ever used.
  if (!SEND_NOW_ALLOWED_METHODS.includes(clean(method).toUpperCase())) {
    logger?.warn?.("outbound_send_now.method_not_allowed", { method: clean(method).toUpperCase() || null });
    return {
      status: 405,
      headers: { Allow: SEND_NOW_ALLOWED_METHODS.join(", ") },
      payload: {
        ok: false,
        route: "internal/outbound/send-now",
        error: "method_not_allowed",
        reason: "send_now_requires_post_body",
        message: "Send-now accepts only an authenticated POST with the message in the request body.",
      },
    };
  }

  // Authenticate before reading the request at all.
  const auth = authorizeRequest(request);
  if (!auth?.ok) {
    logger?.warn?.("outbound_send_now.unauthorized", { method, reason: auth?.error || "unauthorized" });
    return internalSendRouteRefusal(
      { status: auth?.status || 401, error: auth?.error || "unauthorized" },
      "internal/outbound/send-now"
    );
  }

  // Log metadata only: a masked destination and the message LENGTH. The phone
  // and the message text never enter request logs.
  let request_meta = {
    method,
    phone_masked: null,
    use_case: null,
    language: null,
    touch_number: null,
    message_override_present: false,
    message_length: 0,
  };

  try {
    const body = await request.json().catch(() => ({}));
    const normalized_input = normalizeSendNowInput(body);

    request_meta = {
      method,
      phone_masked: maskPhoneForLog(normalized_input.phone),
      use_case: normalized_input.use_case,
      language: normalized_input.language,
      touch_number: normalized_input.touch_number,
      message_override_present: normalized_input.message_override_present,
      message_length: clean(normalized_input.rendered_message_text).length,
    };

    logger?.info?.("outbound_send_now.requested", request_meta);

    // The preview is for the caller's own response only; it is never logged.
    const { message_override_preview: _preview, ...send_input } = normalized_input;
    const result = await buildAndSendNow(send_input, {
      queueOutboundMessageImpl,
      processSendQueueImpl,
      ...(deps.getSystemValue ? { getSystemValue: deps.getSystemValue } : {}),
      ...(deps.supabase ? { supabase: deps.supabase } : {}),
    });

    logger?.info?.("outbound_send_now.completed", {
      ...request_meta,
      ok: result?.queued?.ok === true && result?.processed?.ok === true,
      queued_stage: result?.queued?.stage || null,
      queued_reason: result?.queued?.reason || null,
      processed_stage: result?.processed?.stage || null,
      processed_reason: result?.processed?.reason || null,
      queue_item_id:
        result?.queued?.queue_item_id ||
        result?.processed?.queue_item_id ||
        null,
    });

    return {
      status: statusForResult(result),
      payload: {
        ok: result?.queued?.ok === true && result?.processed?.ok === true,
        route: "internal/outbound/send-now",
        result,
      },
    };
  } catch (error) {
    const diagnostics = serializeRouteError(error);

    logger?.error?.("outbound_send_now.failed", {
      ...request_meta,
      error: diagnostics,
    });

    return {
      status: 500,
      payload: {
        ok: false,
        error: "outbound_send_now_failed",
        message: diagnostics.message,
      },
    };
  }
}
