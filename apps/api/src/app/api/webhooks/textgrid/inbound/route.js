import { NextResponse } from "next/server.js";

import { maybeHandleBuyerTextgridInbound } from "@/lib/domain/buyers/handle-buyer-response-webhook.js";
import { child } from "@/lib/logging/logger.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import {
  logInboundMessageEvent as logSupabaseInboundMessageEvent,
  writeWebhookLog,
} from "@/lib/supabase/sms-engine.js";
import { processInboundWebhookLive } from "@/lib/domain/webhooks/webhook-event-processor.js";
import { setSystemValues } from "@/lib/system-control.js";
import { handleTextgridInbound } from "@/lib/flows/handle-textgrid-inbound.js";
import {
  buildTextgridWebhookBypassResult,
  buildTextgridWebhookLogMeta,
  buildTextgridWebhookVerificationMeta,
  getTextgridWebhookSignatureMode,
  verifyTextgridWebhookRequest,
} from "@/lib/webhooks/textgrid-verify-webhook.js";
import { normalizeTextgridInboundPayload } from "@/lib/webhooks/textgrid-inbound-normalize.js";
import { captureRouteException, addSentryBreadcrumb } from "@/lib/monitoring/sentry.js";
import { captureSystemEvent } from "@/lib/analytics/posthog-server.js";
import { sendHotLeadAlert } from "@/lib/alerts/discord.js";
import { sendInboundSmsDiscordAlert } from "@/lib/discord/inbound-alerts.js";
import { recordWebhookRequestReceipt } from "@/lib/domain/webhooks/webhook-request-receipts.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({
  module: "api.webhooks.textgrid.inbound",
});

const ROUTE_SECRET_ENV_NAMES = Object.freeze([
  "INTERNAL_API_SECRET",
  "CRON_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "DISCORD_BOT_TOKEN",
  "TEXTGRID_AUTH_TOKEN",
  "TEXTGRID_WEBHOOK_SECRET",
  "PODIO_CLIENT_SECRET",
  "PODIO_PASSWORD",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "POSTHOG_KEY",
  "SENTRY_AUTH_TOKEN",
]);

const defaultDeps = {
  logger,
  maybeHandleBuyerTextgridInboundImpl: maybeHandleBuyerTextgridInbound,
  handleTextgridInboundImpl: handleTextgridInbound,
  verifyTextgridWebhookRequestImpl: verifyTextgridWebhookRequest,
  normalizeTextgridInboundPayloadImpl: normalizeTextgridInboundPayload,
  writeWebhookLogImpl: writeWebhookLog,
  logSupabaseInboundMessageEventImpl: logSupabaseInboundMessageEvent,
  processInboundWebhookLiveImpl: processInboundWebhookLive,
  sendInboundSmsDiscordAlertImpl: sendInboundSmsDiscordAlert,
  recordWebhookRequestReceiptImpl: recordWebhookRequestReceipt,
};

let runtimeDeps = { ...defaultDeps };

function clean(value) {
  return String(value ?? "").trim();
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactRouteSecrets(value) {
  let text = String(value ?? "");
  for (const key of ROUTE_SECRET_ENV_NAMES) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(key)}\\b`, "gi"), "[redacted_key]");
    const secret = clean(process.env[key]);
    if (secret.length >= 8) {
      text = text.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]");
    }
  }
  return text;
}

function safeErrorMessage(error, fallback = "Unknown error") {
  return redactRouteSecrets(error?.message || fallback);
}

function safeErrorStack(error) {
  return error?.stack ? redactRouteSecrets(error.stack) : null;
}

// Route-level oversize guard: TextGrid inbound SMS webhooks are small
// form/JSON posts; 256 KB is far above any legitimate message payload.
const MAX_INBOUND_REQUEST_BYTES = 256 * 1024;

function resolveReceiptSignatureStatus({ mode, verified, bypassed, header_name } = {}) {
  if (verified) return "valid";
  if (mode === "off" || bypassed) return "skipped_mode_off";
  if (!header_name) return "missing";
  if (mode === "log_only") return "skipped_log_only";
  if (mode === "strict") return "invalid";
  return "unknown";
}

function asBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function serializeForConsole(value) {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val instanceof Error) {
        return {
          name: val.name,
          message: val.message,
          stack: val.stack,
        };
      }
      return val;
    });
  } catch {
    return JSON.stringify({ serialization_error: true });
  }
}

function safeRouteLog(level, event, meta = {}) {
  try {
    const logFn = runtimeDeps?.logger?.[level];
    if (typeof logFn === "function") {
      logFn(event, meta);
    }
  } catch (log_error) {
    // Wrap the catch body so a console.error throw cannot escape safeRouteLog.
    try {
      console.error(
        serializeForConsole({
          event: `${event}.logger_failed`,
          log_error_message: log_error?.message || "unknown_logger_error",
          log_error_stack: log_error?.stack || null,
          original_event: event,
          original_level: level,
        })
      );
    } catch {}
  }
}

function isMainInboundHandlerDebugStage(stage = null) {
  return [
    "handler_entry",
    "after_extract",
    "after_normalize_from",
    "after_normalize_to",
    "after_inbound_received_log",
    "after_message_event_lookup",
    "after_brain_lookup",
    "after_phone_resolution",
    "after_message_event_create",
    "after_conversation_resolution",
    "after_prospect_resolution",
    "after_market_resolution",
    "after_podio_write",
    "handler_exit",
  ].includes(clean(stage));
}

async function parseRequestBody(request) {
  const contentType = clean(request.headers.get("content-type")).toLowerCase();

  if (contentType.includes("application/json")) {
    return await request.json().catch(() => ({}));
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData().catch(() => null);
    return form ? Object.fromEntries(form.entries()) : {};
  }

  const text = await request.text().catch(() => "");
  return { raw_text: text };
}

const __normalizeInboundPayloadForTest = normalizeTextgridInboundPayload;

export function __setTextgridInboundRouteTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetTextgridInboundRouteTestDeps() {
  runtimeDeps = { ...defaultDeps };
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "webhooks/textgrid/inbound",
    status: "listening",
  });
}

export async function POST(request) {
  let accepted_logged = false;
  let downstream_handler_invoked = false;
  let podio_persistence_attempted = false;
  let parsed_body_keys = [];
  let safe_message_id = null;
  let safe_from = null;
  let safe_to = null;
  let safe_status = null;
  let safe_signature_header_name = null;
  let safe_signature_verification_mode = null;
  let safe_signature_verified = false;
  let safe_signature_bypassed = false;
  let safe_signature_failure_reason = null;
  let safe_signature_unverified_observe_mode = false;
  let normalized_payload = null;
  let safe_webhook_verification = null;
  let inbound_alert_sent = false;
  let buyer_handler_failed = false;
  let buyer_handler_error_message = null;
  let inbound_webhook_log_row = null;

  async function sendAcceptedInboundAlert({
    result = null,
    buyer_result = null,
    handler_name = null,
    failure = null,
    severity = null,
    final_response_status = null,
  } = {}) {
    if (inbound_alert_sent || !accepted_logged || !normalized_payload) return;
    inbound_alert_sent = true;

    try {
      await runtimeDeps.sendInboundSmsDiscordAlertImpl({
        payload: normalized_payload,
        result,
        buyer_result,
        provider_message_id: safe_message_id,
        from: safe_from,
        to: safe_to,
        message_body: normalized_payload?.message_body || normalized_payload?.message || null,
        handler_name,
        failure,
        severity,
        final_response_status,
        buyer_handler_failed,
        buyer_handler_error_message,
        webhook_verification: safe_webhook_verification,
      });
    } catch (alert_error) {
      safeRouteLog("warn", "textgrid_inbound.discord_alert_failed", {
        message_id: safe_message_id,
        message: safeErrorMessage(alert_error, "discord_alert_failed"),
      });
    }
  }

  // ── Route-level request receipt (durable audit for EVERY outcome) ────────
  // One receipt per HTTP request, including requests rejected before the core
  // handler. First terminal outcome wins; the write never throws and never
  // changes the response.
  const receipt_correlation_id = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `wrr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let receipt_written = false;
  let receipt_raw_body = "";
  const receipt_flags = {};
  const writeRequestReceipt = async (fields = {}) => {
    if (receipt_written) return;
    receipt_written = true;
    try {
      await runtimeDeps.recordWebhookRequestReceiptImpl({
        correlation_id: receipt_correlation_id,
        webhook_log_id: inbound_webhook_log_row?.id || null,
        provider: "textgrid",
        endpoint: "/api/webhooks/textgrid/inbound",
        event_kind: normalized_payload?.header_event || "inbound",
        provider_message_sid: safe_message_id,
        from_phone: safe_from,
        to_phone: safe_to,
        raw_body: receipt_raw_body,
        signature_status: resolveReceiptSignatureStatus({
          mode: safe_signature_verification_mode,
          verified: safe_signature_verified,
          bypassed: safe_signature_bypassed,
          header_name: safe_signature_header_name,
        }),
        detail: {
          ...receipt_flags,
          ...(fields.detail || {}),
        },
        ...fields,
      });
    } catch (receipt_error) {
      safeRouteLog("warn", "textgrid_inbound.request_receipt_failed", {
        message_id: safe_message_id,
        message: safeErrorMessage(receipt_error, "request_receipt_failed"),
      });
    }
  };

  try {
    const raw_body = await request.clone().text().catch(() => "");
    receipt_raw_body = raw_body;
    console.log("TEXTGRID INBOUND WEBHOOK HIT", serializeForConsole({ method: "POST", url: request.url }));
    const content_type = clean(request.headers.get("content-type"));
    console.log("INBOUND CONTENT TYPE", serializeForConsole({ content_type }));

    // Oversized requests are rejected before any parsing/processing. TextGrid
    // SMS payloads are a few KB; anything beyond this is not a message.
    if (raw_body.length > MAX_INBOUND_REQUEST_BYTES) {
      await writeRequestReceipt({
        outcome: "rejected",
        rejection_reason: "oversized_request",
        http_status: 413,
        detail: { body_bytes: raw_body.length, limit: MAX_INBOUND_REQUEST_BYTES },
      });
      return NextResponse.json(
        { ok: false, error: "oversized_request" },
        { status: 413 }
      );
    }

    const body = await parseRequestBody(request);

    // form_params is the decoded key/value object when the body is form-encoded.
    // The Twilio signing algorithm needs these (sorted) to reproduce the digest.
    const is_form_encoded = content_type.toLowerCase().includes("application/x-www-form-urlencoded");
    const form_params = is_form_encoded && body && !body.raw_text ? body : null;
    parsed_body_keys = Object.keys(body || {});

    const payload = runtimeDeps.normalizeTextgridInboundPayloadImpl(body, request.headers);
    normalized_payload = payload;
    

    const request_url = new URL(request.url);
    const dry_run = asBool(
      body?.dry_run ??
      body?.dryRun ??
      payload?.dry_run ??
      request_url.searchParams.get("dry_run") ??
      request_url.searchParams.get("dryRun"),
      false
    );
    const signature_verification_mode = getTextgridWebhookSignatureMode();
    const verification =
      signature_verification_mode === "off"
        ? buildTextgridWebhookBypassResult({
            request_url: request.url,
            raw_body,
            form_params,
            content_type,
            signature: payload.header_signature,
            signature_header_name: payload.header_signature_name,
          })
        : runtimeDeps.verifyTextgridWebhookRequestImpl({
            request_url: request.url,
            raw_body,
            form_params,
            content_type,
            signature: payload.header_signature,
            signature_header_name: payload.header_signature_name,
          });
    const signature_meta = buildTextgridWebhookVerificationMeta({
      verification,
      mode: signature_verification_mode,
      signature_header_name: payload.header_signature_name,
    });
    const webhook_verification = {
      ...verification,
      ...signature_meta,
    };
    safe_webhook_verification = webhook_verification;
    safe_signature_verification_mode =
      webhook_verification?.signature_verification_mode || signature_verification_mode;
    safe_signature_verified = Boolean(webhook_verification?.signature_verified);
    safe_signature_bypassed = Boolean(webhook_verification?.signature_bypassed);
    safe_signature_failure_reason = webhook_verification?.signature_failure_reason || null;
    safe_signature_unverified_observe_mode = Boolean(
      webhook_verification?.signature_unverified_observe_mode
    );
    safe_signature_header_name =
      webhook_verification?.signature_header_name || payload?.header_signature_name || null;


    try {
      safe_message_id = payload?.message_id || null;
    } catch {}
    try {
      safe_from = payload?.from || null;
    } catch {}
    try {
      safe_to = payload?.to || null;
    } catch {}
    try {
      safe_status = clean(payload?.status) || null;
    } catch {}

    try {
      safeRouteLog(
        "info",
        "textgrid_inbound.normalized",
        buildTextgridWebhookLogMeta({
          payload,
          webhook_verification,
          extra: {
            event: payload.header_event || null,
            parsed_body_keys,
          },
        })
      );
    } catch (error) {
      console.error("SAFE_ROUTE_LOG_THROW_NORMALIZED", error.message, error.stack);
      return NextResponse.json(
        { ok: false, error: "textgrid_inbound_failed_safe_route_log" },
        { status: 500 }
      );
    }

    // Debug checkpoints short-circuit processing and persist nothing, so the
    // header is honored only outside production or with the internal API
    // secret — never for an arbitrary internet caller on the public webhook.
    const raw_debug_stage = request.headers.get("x-inbound-debug-stage");
    const debug_stage_authorized =
      Boolean(raw_debug_stage) &&
      (process.env.NODE_ENV !== "production" ||
        (Boolean(process.env.INTERNAL_API_SECRET) &&
          request.headers.get("x-internal-api-secret") ===
            process.env.INTERNAL_API_SECRET));
    if (raw_debug_stage && !debug_stage_authorized) {
      safeRouteLog("warn", "textgrid_inbound.debug_stage_rejected", {
        stage: raw_debug_stage,
      });
      // Not a terminal reject (the header is ignored and processing
      // continues) — stamp the misuse onto whatever receipt this request
      // ultimately writes.
      receipt_flags.debug_stage_misuse = true;
    }
    const inbound_debug_stage = debug_stage_authorized ? raw_debug_stage : null;
    if (inbound_debug_stage === "after_normalized") {
      return NextResponse.json({ ok: true, stage: "after_normalized" });
    }

    if (inbound_debug_stage === "after_checkpoint_0") {
      return NextResponse.json({ ok: true, stage: "after_checkpoint_0" });
    }

    try {
      console.log(
        "INBOUND_CHECKPOINT_1",
        serializeForConsole({
          message_id: safe_message_id,
          from: safe_from,
          to: safe_to,
          parsed_body_keys,
          signature_verification_mode: safe_signature_verification_mode,
          next_statement: "build_checkpoint_base",
        })
      );
      try {
        runtimeDeps.logger.info("INBOUND_CHECKPOINT_1", {
          message_id: safe_message_id,
          from: safe_from,
          to: safe_to,
          parsed_body_keys,
          signature_verification_mode: safe_signature_verification_mode,
          next_statement: "build_checkpoint_base",
        });
      } catch (log_error) {
        console.error(
          "INBOUND_CHECKPOINT_1_LOGGER_FAILED",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }

      const checkpoint_base = {
        message_id: safe_message_id,
        from: safe_from,
        to: safe_to,
        parsed_body_keys,
        signature_verification_mode: safe_signature_verification_mode,
      };

      if (inbound_debug_stage === "after_checkpoint_base") {
        return NextResponse.json({ ok: true, stage: "after_checkpoint_base" });
      }

      console.log(
        "INBOUND_CHECKPOINT_2",
        serializeForConsole({
          ...checkpoint_base,
          next_statement: "compute_signature_invalid",
        })
      );
      try {
        runtimeDeps.logger.info("INBOUND_CHECKPOINT_2", {
          ...checkpoint_base,
          next_statement: "compute_signature_invalid",
        });
      } catch (log_error) {
        console.error(
          "INBOUND_CHECKPOINT_2_LOGGER_FAILED",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }

      const signature_invalid = Boolean(verification.required && !verification.ok);

      if (inbound_debug_stage === "after_signature_invalid") {
        return NextResponse.json({ ok: true, stage: "after_signature_invalid" });
      }

      console.log(
        "INBOUND_CHECKPOINT_3",
        serializeForConsole({
          ...checkpoint_base,
          signature_invalid,
          next_statement: "compute_signature_continuation",
        })
      );
      try {
        runtimeDeps.logger.info("INBOUND_CHECKPOINT_3", {
          ...checkpoint_base,
          signature_invalid,
          next_statement: "compute_signature_continuation",
        });
      } catch (log_error) {
        console.error(
          "INBOUND_CHECKPOINT_3_LOGGER_FAILED",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }

      const will_continue_after_signature_check = !(
        verification.required &&
        !verification.ok &&
        safe_signature_verification_mode === "strict"
      );

      if (inbound_debug_stage === "after_signature_gate") {
        return NextResponse.json({ ok: true, stage: "after_signature_gate" });
      }

      console.log(
        "INBOUND_CHECKPOINT_4",
        serializeForConsole({
          ...checkpoint_base,
          signature_invalid,
          will_continue_after_signature_check,
          next_statement: "log_signature_branch_selected",
        })
      );
      try {
        runtimeDeps.logger.info("INBOUND_CHECKPOINT_4", {
          ...checkpoint_base,
          signature_invalid,
          will_continue_after_signature_check,
          next_statement: "log_signature_branch_selected",
        });
      } catch (log_error) {
        console.error(
          "INBOUND_CHECKPOINT_4_LOGGER_FAILED",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }

      const branch_meta = {
        message_id: safe_message_id,
        from: safe_from,
        to: safe_to,
        status: safe_status,
        signature_verification_mode: safe_signature_verification_mode,
        signature_verified: safe_signature_verified,
        signature_bypassed: safe_signature_bypassed,
        signature_failure_reason: safe_signature_failure_reason,
        signature_header_name: safe_signature_header_name,
        signature_unverified_observe_mode: safe_signature_unverified_observe_mode,
        downstream_handler_invoked: false,
        podio_persistence_attempted: false,
        final_response_status: null,
        ...webhook_verification?.diagnostics,
        parsed_body_keys,
        signature_invalid,
        will_continue_after_signature_check,
      };

      console.log(
        "textgrid_inbound.signature_branch_selected",
        serializeForConsole(branch_meta)
      );
      try {
        runtimeDeps.logger.info("textgrid_inbound.signature_branch_selected", branch_meta);
      } catch (log_error) {
        console.error(
          "textgrid_inbound.signature_branch_selected.logger_failed",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }

      if (inbound_debug_stage === "after_signature_branch_selected") {
        return NextResponse.json({ ok: true, stage: "after_signature_branch_selected" });
      }

      if (hasSupabaseConfig()) {
        try {
          inbound_webhook_log_row = await runtimeDeps.writeWebhookLogImpl({
            event_type: payload.header_event || "inbound",
            direction: "inbound",
            provider_message_sid: payload.message_id || null,
            payload,
            headers: Object.fromEntries(request.headers.entries()),
            received_at: new Date().toISOString(),
            source: "textgrid",
          });
        } catch (webhook_log_error) {
          safeRouteLog("error", "textgrid_inbound.webhook_log_failed", {
            message: safeErrorMessage(webhook_log_error, "webhook_log_write_failed"),
          });
        }
      }

      if (!payload.from) {
        const invalid_payload_meta = {
          ...branch_meta,
          response_error: "invalid_textgrid_inbound_payload",
        };
        console.error(
          "textgrid_inbound.invalid_payload",
          serializeForConsole(invalid_payload_meta)
        );
        try {
          runtimeDeps.logger.warn("textgrid_inbound.invalid_payload", invalid_payload_meta);
        } catch (log_error) {
          console.error(
            "textgrid_inbound.invalid_payload.logger_failed",
            serializeForConsole({
              log_error_message: log_error?.message || "unknown_logger_error",
              log_error_stack: log_error?.stack || null,
            })
          );
        }

        const invalid_payload_log_meta = {
          ...invalid_payload_meta,
          payload,
        };
        try {
          runtimeDeps.logger.warn("textgrid_inbound.invalid_payload.details", invalid_payload_log_meta);
        } catch {}

        const invalid_payload_response_meta = {
          ...branch_meta,
          final_response_status: 400,
          response_error: "invalid_textgrid_inbound_payload",
        };
        console.log(
          "textgrid_inbound.response_sent",
          serializeForConsole(invalid_payload_response_meta)
        );
        try {
          runtimeDeps.logger.info("textgrid_inbound.response_sent", invalid_payload_response_meta);
        } catch (log_error) {
          console.error(
            "textgrid_inbound.response_sent.logger_failed",
            serializeForConsole({
              log_error_message: log_error?.message || "unknown_logger_error",
              log_error_stack: log_error?.stack || null,
            })
          );
        }

        await writeRequestReceipt({
          outcome: "rejected",
          rejection_reason:
            parsed_body_keys.length === 0 && receipt_raw_body
              ? "malformed_payload"
              : "missing_sender",
          http_status: 400,
          detail: { response_error: "invalid_textgrid_inbound_payload" },
        });
        return NextResponse.json(
          {
            ok: false,
            error: "invalid_textgrid_inbound_payload",
          },
          { status: 400 }
        );
      }

      if (verification.required && !verification.ok) {
        const invalid_signature_meta = {
          ...branch_meta,
        };
        console.error(
          "textgrid_inbound.invalid_signature",
          serializeForConsole(invalid_signature_meta)
        );
        try {
          runtimeDeps.logger.warn("textgrid_inbound.invalid_signature", invalid_signature_meta);
        } catch (log_error) {
          console.error(
            "textgrid_inbound.invalid_signature.logger_failed",
            serializeForConsole({
              log_error_message: log_error?.message || "unknown_logger_error",
              log_error_stack: log_error?.stack || null,
            })
          );
        }

        if (safe_signature_verification_mode === "strict") {
          const strict_response_meta = {
            ...branch_meta,
            final_response_status: 401,
            response_error: "invalid_textgrid_signature",
          };
          console.log(
            "textgrid_inbound.response_sent",
            serializeForConsole(strict_response_meta)
          );
          try {
            runtimeDeps.logger.info("textgrid_inbound.response_sent", strict_response_meta);
          } catch (log_error) {
            console.error(
              "textgrid_inbound.response_sent.logger_failed",
              serializeForConsole({
                log_error_message: log_error?.message || "unknown_logger_error",
                log_error_stack: log_error?.stack || null,
              })
            );
          }

          await writeRequestReceipt({
            outcome: "rejected",
            rejection_reason: payload.header_signature
              ? "invalid_signature"
              : "missing_signature",
            signature_status: payload.header_signature ? "invalid" : "missing",
            http_status: 401,
            detail: {
              signature_failure_reason: safe_signature_failure_reason,
            },
          });
          return NextResponse.json(
            {
              ok: false,
              error: "invalid_textgrid_signature",
              verification: webhook_verification,
            },
            { status: 401 }
          );
        }
      }

      if (safe_signature_verification_mode === "off") {
        const disabled_meta = {
          ...branch_meta,
          signature_verification_disabled: true,
        };
        console.error(
          "textgrid_inbound.signature_verification_disabled",
          serializeForConsole(disabled_meta)
        );
        try {
          runtimeDeps.logger.warn("textgrid_inbound.signature_verification_disabled", disabled_meta);
        } catch (log_error) {
          console.error(
            "textgrid_inbound.signature_verification_disabled.logger_failed",
            serializeForConsole({
              log_error_message: log_error?.message || "unknown_logger_error",
              log_error_stack: log_error?.stack || null,
            })
          );
        }
      }

      payload.webhook_verification = webhook_verification;
      Object.assign(payload, signature_meta);

      const accepted_meta = {
        ...branch_meta,
      };
      console.log("textgrid_inbound.accepted", serializeForConsole(accepted_meta));
      try {
        runtimeDeps.logger.info("textgrid_inbound.accepted", accepted_meta);
      } catch (log_error) {
        console.error(
          "textgrid_inbound.accepted.logger_failed",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }
      accepted_logged = true;

      addSentryBreadcrumb("textgrid_inbound", "inbound_message_accepted", {
        provider_message_id: safe_message_id,
        to: safe_to,
      });

      if (hasSupabaseConfig()) {
        try {
          await runtimeDeps.logSupabaseInboundMessageEventImpl(payload, {
            now: new Date().toISOString(),
          });
          console.log("INBOUND MESSAGE EVENT WRITTEN", serializeForConsole({
            provider_message_sid: payload.message_id || null,
            body_source: payload.body_source || null,
            message_body: payload.message_body ?? null,
          }));
        } catch (supabase_error) {
          safeRouteLog(
            "error",
            "textgrid_inbound.supabase_logging_failed",
            buildTextgridWebhookLogMeta({
              payload,
              webhook_verification,
              downstream_handler_invoked,
              podio_persistence_attempted,
              extra: {
                message: safeErrorMessage(supabase_error, "Unknown Supabase inbound logging error"),
              },
            })
          );
        }
      }

      if (inbound_debug_stage === "after_accepted") {
        await sendAcceptedInboundAlert({
          result: { ok: true, stage: "after_accepted" },
          handler_name: "textgrid_inbound_route",
          final_response_status: 200,
        });
        return NextResponse.json({ ok: true, stage: "after_accepted" });
      }
    } catch (error) {
      const error_meta = {
        message_id: safe_message_id,
        from: safe_from,
        to: safe_to,
        status: safe_status,
        signature_verification_mode: safe_signature_verification_mode,
        signature_verified: safe_signature_verified,
        signature_bypassed: safe_signature_bypassed,
        signature_failure_reason: safe_signature_failure_reason,
        signature_header_name: safe_signature_header_name,
        signature_unverified_observe_mode: safe_signature_unverified_observe_mode,
        downstream_handler_invoked,
        podio_persistence_attempted,
        final_response_status: 500,
        parsed_body_keys,
        error_message: safeErrorMessage(error),
        error_stack: safeErrorStack(error),
      };

      console.error("textgrid_inbound.failed_pre_accept", serializeForConsole(error_meta));
      try {
        runtimeDeps.logger.error("textgrid_inbound.failed_pre_accept", error_meta);
      } catch (log_error) {
        console.error(
          "textgrid_inbound.failed_pre_accept.logger_failed",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }

      captureRouteException(error, {
        route: "webhooks/textgrid/inbound",
        subsystem: "textgrid_inbound",
        context: {
          provider_message_id: safe_message_id,
          to: safe_to,
          stage: "pre_accept",
        },
      });

      console.error("textgrid_inbound.failed", serializeForConsole(error_meta));
      try {
        runtimeDeps.logger.error("textgrid_inbound.failed", error_meta);
      } catch (log_error) {
        console.error(
          "textgrid_inbound.failed.logger_failed",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }

      const response_meta = {
        ...error_meta,
        response_error: "textgrid_inbound_failed_pre_accept",
      };
      console.log("textgrid_inbound.response_sent", serializeForConsole(response_meta));
      try {
        runtimeDeps.logger.info("textgrid_inbound.response_sent", response_meta);
      } catch (log_error) {
        console.error(
          "textgrid_inbound.response_sent.logger_failed",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }

      await writeRequestReceipt({
        outcome: "rejected",
        rejection_reason: "parser_exception",
        http_status: 500,
        detail: { response_error: "textgrid_inbound_failed_pre_accept" },
      });
      return NextResponse.json(
        {
          ok: false,
          error: "textgrid_inbound_failed_pre_accept",
        },
        { status: 500 }
      );
    }

    if (inbound_debug_stage === "before_handler") {
      await sendAcceptedInboundAlert({
        result: { ok: true, stage: "before_handler" },
        handler_name: "textgrid_inbound_route",
        final_response_status: 200,
      });
      return NextResponse.json({ ok: true, stage: "before_handler" });
    }

    const bypass_buyer_handler_for_debug = isMainInboundHandlerDebugStage(inbound_debug_stage);

    if (bypass_buyer_handler_for_debug) {
      const bypass_meta = buildTextgridWebhookLogMeta({
        payload,
        webhook_verification,
        downstream_handler_invoked: false,
        podio_persistence_attempted: false,
        extra: {
          inbound_debug_stage,
          buyer_handler_bypassed_for_debug: true,
        },
      });
      console.log(
        "textgrid_inbound.buyer_handler_bypassed_for_debug",
        serializeForConsole(bypass_meta)
      );
      try {
        runtimeDeps.logger.info("textgrid_inbound.buyer_handler_bypassed_for_debug", bypass_meta);
      } catch (log_error) {
        console.error(
          "textgrid_inbound.buyer_handler_bypassed_for_debug.logger_failed",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }
    }

    let buyer_result = { ok: true, matched: false, reason: "buyer_handler_not_invoked" };

    if (!bypass_buyer_handler_for_debug) {
      downstream_handler_invoked = true;
      safeRouteLog(
        "info",
        "textgrid_inbound.handler_started",
        buildTextgridWebhookLogMeta({
          payload,
          webhook_verification,
          downstream_handler_invoked: true,
          extra: {
            handler_name: "maybeHandleBuyerTextgridInbound",
          },
        })
      );

      try {
        buyer_result = await runtimeDeps.maybeHandleBuyerTextgridInboundImpl(payload);
      } catch (error) {
        buyer_handler_failed = true;
        buyer_handler_error_message = safeErrorMessage(error);
        const buyer_error_meta = buildTextgridWebhookLogMeta({
          payload,
          webhook_verification,
          downstream_handler_invoked: true,
          podio_persistence_attempted: false,
          final_response_status: 500,
          extra: {
            handler_name: "maybeHandleBuyerTextgridInbound",
            error_message: safeErrorMessage(error),
            error_stack: safeErrorStack(error),
            inbound_debug_stage,
            will_continue_to_main_handler: true,
          },
        });
        console.error(
          "textgrid_inbound.buyer_handler_failed",
          serializeForConsole(buyer_error_meta)
        );
        try {
          runtimeDeps.logger.error("textgrid_inbound.buyer_handler_failed", buyer_error_meta);
        } catch (log_error) {
          console.error(
            "textgrid_inbound.buyer_handler_failed.logger_failed",
            serializeForConsole({
              log_error_message: log_error?.message || "unknown_logger_error",
              log_error_stack: log_error?.stack || null,
            })
          );
        }
        captureRouteException(error, {
          route: "webhooks/textgrid/inbound",
          subsystem: "textgrid_inbound",
          context: {
            provider_message_id: safe_message_id,
            to: safe_to,
            stage: "buyer_handler",
          },
        });
        buyer_result = {
          ok: false,
          matched: false,
          reason: "buyer_handler_failed",
          error_message: safeErrorMessage(error),
        };
      }
    }

    if (inbound_debug_stage === "after_handler") {
      await sendAcceptedInboundAlert({
        result: { ok: true, stage: "after_handler", buyer_matched: Boolean(buyer_result?.matched) },
        buyer_result,
        handler_name: "maybeHandleBuyerTextgridInbound",
        final_response_status: 200,
      });
      return NextResponse.json({ ok: true, stage: "after_handler", buyer_matched: Boolean(buyer_result?.matched) });
    }

    if (!bypass_buyer_handler_for_debug) {
      safeRouteLog(
        "info",
        "textgrid_inbound.handler_completed",
        buildTextgridWebhookLogMeta({
          payload,
          webhook_verification,
          downstream_handler_invoked: true,
          podio_persistence_attempted: Boolean(buyer_result?.matched),
          extra: {
            handler_name: "maybeHandleBuyerTextgridInbound",
            buyer_disposition_matched: Boolean(buyer_result?.matched),
          },
        })
      );
    }

    if (!bypass_buyer_handler_for_debug && buyer_result?.matched) {
      podio_persistence_attempted = true;
      safeRouteLog("info", "textgrid_inbound.routed_to_buyer_disposition", {
        message_id: payload.message_id || null,
        from: payload.from || null,
        buyer_match_item_id: buyer_result?.result?.buyer_match_item_id || null,
        company_item_id: buyer_result?.result?.company_item_id || null,
        correlation_mode: buyer_result?.correlation_mode || null,
      });

      const response_status = buyer_result?.result?.ok === false ? 400 : 200;
      safeRouteLog(
        "info",
        "textgrid_inbound.response_sent",
        buildTextgridWebhookLogMeta({
          payload,
          webhook_verification,
          downstream_handler_invoked: true,
          podio_persistence_attempted: true,
          final_response_status: response_status,
          extra: {
            buyer_disposition: true,
          },
        })
      );

      await sendAcceptedInboundAlert({
        result: buyer_result?.result || null,
        buyer_result,
        handler_name: "maybeHandleBuyerTextgridInbound",
        final_response_status: response_status,
        severity: response_status >= 400 ? "warning" : "info",
      });

      return NextResponse.json(
        {
          ok: buyer_result?.result?.ok !== false,
          route: "webhooks/textgrid/inbound",
          verification: webhook_verification,
          buyer_disposition: true,
          result: buyer_result.result,
        },
        { status: buyer_result?.result?.ok === false ? 400 : 200 }
      );
    }

    downstream_handler_invoked = true;
    podio_persistence_attempted = true;
    safeRouteLog(
      "info",
      "textgrid_inbound.handler_started",
      buildTextgridWebhookLogMeta({
        payload,
        webhook_verification,
        downstream_handler_invoked: true,
        podio_persistence_attempted: true,
        extra: {
          handler_name: "handleTextgridInbound",
          buyer_handler_failed,
          buyer_handler_error_message,
        },
      })
    );

    let result;
    if (inbound_webhook_log_row?.id && hasSupabaseConfig()) {
      const live_started = Date.now();
      const live_outcome = await runtimeDeps.processInboundWebhookLiveImpl(
        inbound_webhook_log_row,
        {
          now: new Date().toISOString(),
          inbound_options: {
            inbound_debug_stage,
            dry_run,
            auto_reply_enabled:
              process.env.INBOUND_AUTOPILOT_ENABLED ??
              process.env.AUTO_REPLY_ENABLED ??
              null,
            auto_reply_live_enabled:
              process.env.AUTO_REPLY_LIVE_ENABLED ??
              process.env.INBOUND_AUTOPILOT_LIVE_ENABLED ??
              null,
            auto_reply_dry_run: process.env.AUTO_REPLY_DRY_RUN ?? null,
            auto_reply_mode:
              process.env.AUTO_REPLY_MODE ??
              process.env.INBOUND_AUTOPILOT_MODE ??
              null,
            auto_post_discord_card: asBool(process.env.INBOUND_AUTOPILOT_POST_DISCORD_CARD, true),
            auto_reply_delay_seconds:
              Number.parseInt(process.env.INBOUND_AUTOPILOT_DELAY_SECONDS || "60", 10) || 60,
            inbound_user_initiated: true,
          },
        },
        runtimeDeps,
      );
      result = live_outcome?.result || live_outcome;
      await setSystemValues({
        webhook_live_inbound_last_at: new Date().toISOString(),
        webhook_live_inbound_last_latency_ms: String(
          live_outcome?.latency_ms ?? Date.now() - live_started,
        ),
        webhook_live_inbound_last_provider_sid: payload.message_id || null,
      }).catch(() => {});
    } else {
      result = await runtimeDeps.handleTextgridInboundImpl(payload, {
        inbound_debug_stage,
        dry_run,
        auto_reply_enabled:
          process.env.INBOUND_AUTOPILOT_ENABLED ??
          process.env.AUTO_REPLY_ENABLED ??
          null,
        auto_reply_live_enabled:
          process.env.AUTO_REPLY_LIVE_ENABLED ??
          process.env.INBOUND_AUTOPILOT_LIVE_ENABLED ??
          null,
        auto_reply_dry_run: process.env.AUTO_REPLY_DRY_RUN ?? null,
        auto_reply_mode:
          process.env.AUTO_REPLY_MODE ??
          process.env.INBOUND_AUTOPILOT_MODE ??
          null,
        auto_post_discord_card: asBool(process.env.INBOUND_AUTOPILOT_POST_DISCORD_CARD, true),
        auto_reply_delay_seconds:
          Number.parseInt(process.env.INBOUND_AUTOPILOT_DELAY_SECONDS || "60", 10) || 60,
        inbound_user_initiated: true,
      });
    }

    captureSystemEvent("inbound_sms_classified", {
      provider_message_id: payload?.message_id || null,
      ok: result?.ok !== false,
      buyer_matched: Boolean(buyer_result?.matched),
      buyer_handler_failed,
      retryable: Boolean(result?.retryable),
      reason: result?.reason || null,
    });

    if (
      result?.ok &&
      !result?.inbound_is_negative &&
      (result?.offer?.created || result?.offer_progress?.updated || result?.contract?.created)
    ) {
      sendHotLeadAlert({
        title: "Hot Seller Reply",
        description: "Inbound SMS triggered a deal-stage advancement",
        color: 0x27ae60,
        fields: [
          { name: "Offer Created", value: String(Boolean(result.offer?.created)), inline: true },
          { name: "Offer Progressed", value: String(Boolean(result.offer_progress?.updated)), inline: true },
          { name: "Contract Created", value: String(Boolean(result.contract?.created)), inline: true },
          { name: "Route Stage", value: String(result.route?.stage || "?"), inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "webhooks/textgrid/inbound" },
      });
    }

    safeRouteLog(
      "info",
      "textgrid_inbound.handler_completed",
      buildTextgridWebhookLogMeta({
        payload,
        webhook_verification,
        downstream_handler_invoked: true,
        podio_persistence_attempted: true,
        extra: {
          handler_name: "handleTextgridInbound",
          handler_ok: result?.ok !== false,
          buyer_handler_failed,
          buyer_handler_error_message,
        },
      })
    );

    const main_handler_response_status = result?.retryable ? 503 : 200;

    // Durable receipt for the request's terminal outcome. Duplicates are
    // first-class (never misrepresented as fresh seller messages); handler
    // refusals map onto the canonical rejection vocabulary.
    {
      const media_only =
        !clean(payload?.message_body ?? payload?.body ?? "") &&
        (Number(payload?.num_media) > 0 ||
          (Array.isArray(payload?.media_urls) && payload.media_urls.length > 0));
      let receipt_fields;
      if (result?.duplicate) {
        receipt_fields = {
          outcome: "duplicate",
          http_status: main_handler_response_status,
          idempotency_key: result?.idempotency_key || null,
          detail: {
            duplicate_reason: result?.reason || null,
            prior_disposition: result?.prior_disposition || null,
          },
        };
      } else if (result?.fail_closed) {
        receipt_fields = {
          outcome: "rejected",
          rejection_reason: "inbound_claim_unavailable",
          http_status: main_handler_response_status,
          idempotency_key: result?.idempotency_key || null,
          detail: { handler_reason: result?.reason || null },
        };
      } else if (result?.ok === false) {
        const handler_reason = clean(result?.reason || result?.error || "");
        receipt_fields = {
          outcome: "rejected",
          rejection_reason:
            handler_reason === "missing_inbound_from"
              ? "missing_sender"
              : handler_reason === "empty_inbound_body"
                ? media_only
                  ? "unsupported_media_only"
                  : "empty_body"
                : "internal_error",
          http_status: main_handler_response_status,
          idempotency_key: result?.idempotency_key || null,
          detail: { handler_reason: handler_reason || null },
        };
      } else {
        receipt_fields = {
          outcome: "accepted",
          http_status: main_handler_response_status,
          idempotency_key: result?.idempotency_key || null,
          detail: {
            terminal_disposition: result?.terminal_disposition || null,
          },
        };
      }
      await writeRequestReceipt(receipt_fields);
    }

    const response_headers = {};
    const retry_after_seconds = Number(result?.retry_after_seconds);
    if (Number.isFinite(retry_after_seconds) && retry_after_seconds > 0) {
      response_headers["Retry-After"] = String(Math.max(1, Math.ceil(retry_after_seconds)));
    }

    safeRouteLog(
      "info",
      "textgrid_inbound.response_sent",
      buildTextgridWebhookLogMeta({
        payload,
        webhook_verification,
        downstream_handler_invoked: true,
        podio_persistence_attempted: true,
        final_response_status: main_handler_response_status,
        extra: {
          buyer_handler_failed,
          buyer_handler_error_message,
          retryable: Boolean(result?.retryable),
          retry_after_seconds: response_headers["Retry-After"] || null,
          retry_after_at: result?.retry_after_at || null,
        },
      })
    );

    await sendAcceptedInboundAlert({
      result,
      buyer_result,
      handler_name: "handleTextgridInbound",
      final_response_status: main_handler_response_status,
      severity: result?.ok === false ? (result?.retryable ? "warning" : "error") : null,
    });

    if (result?.unknown_router && result?.context?.unknown_inbound) {
      return NextResponse.json(
        {
          ok: result?.ok !== false,
          route: "webhooks/textgrid/inbound",
          verification: webhook_verification,
          buyer_handler_failed,
          context: result.context,
          unknown_router: result.unknown_router,
          result,
        },
        {
          status: main_handler_response_status,
          headers: response_headers,
        }
      );
    }

    return NextResponse.json(
      {
        ok: result?.ok !== false,
        route: "webhooks/textgrid/inbound",
        verification: webhook_verification,
        buyer_handler_failed,
        result,
      },
      {
        status: main_handler_response_status,
        headers: response_headers,
      }
    );
  } catch (error) {
    const failure_meta = {
      message_id: safe_message_id,
      from: safe_from,
      to: safe_to,
      status: safe_status,
      signature_verification_mode: safe_signature_verification_mode,
      signature_verified: safe_signature_verified,
      signature_bypassed: safe_signature_bypassed,
      signature_failure_reason: safe_signature_failure_reason,
      signature_header_name: safe_signature_header_name,
      signature_unverified_observe_mode: safe_signature_unverified_observe_mode,
      downstream_handler_invoked,
      podio_persistence_attempted,
      final_response_status: 500,
      parsed_body_keys,
      accepted_logged,
      error_message: safeErrorMessage(error),
      error_stack: safeErrorStack(error),
    };

    console.error("textgrid_inbound.failed", serializeForConsole(failure_meta));
    try {
      runtimeDeps.logger.error("textgrid_inbound.failed", failure_meta);
    } catch (log_error) {
      console.error(
        "textgrid_inbound.failed.logger_failed",
        serializeForConsole({
          log_error_message: log_error?.message || "unknown_logger_error",
          log_error_stack: log_error?.stack || null,
        })
      );
    }

    captureRouteException(error, {
      route: "webhooks/textgrid/inbound",
      subsystem: "textgrid_inbound",
      context: {
        provider_message_id: safe_message_id,
        to: safe_to,
        downstream_handler_invoked,
        accepted_logged,
      },
    });

    if (!accepted_logged) {
      console.error("textgrid_inbound.failed_pre_accept", serializeForConsole(failure_meta));
      try {
        runtimeDeps.logger.error("textgrid_inbound.failed_pre_accept", failure_meta);
      } catch (log_error) {
        console.error(
          "textgrid_inbound.failed_pre_accept.logger_failed",
          serializeForConsole({
            log_error_message: log_error?.message || "unknown_logger_error",
            log_error_stack: log_error?.stack || null,
          })
        );
      }
    }

    const response_meta = {
      ...failure_meta,
      response_error: "textgrid_inbound_failed",
    };
    console.log("textgrid_inbound.response_sent", serializeForConsole(response_meta));
    try {
      runtimeDeps.logger.info("textgrid_inbound.response_sent", response_meta);
    } catch (log_error) {
      console.error(
        "textgrid_inbound.response_sent.logger_failed",
        serializeForConsole({
          log_error_message: log_error?.message || "unknown_logger_error",
          log_error_stack: log_error?.stack || null,
        })
      );
    }

    await sendAcceptedInboundAlert({
      handler_name: downstream_handler_invoked ? "handleTextgridInbound" : "textgrid_inbound_route",
      failure: {
        error_message: safeErrorMessage(error),
      },
      severity: "error",
      final_response_status: 500,
    });

    await writeRequestReceipt({
      outcome: "rejected",
      rejection_reason: "internal_error",
      http_status: 500,
      detail: { response_error: "textgrid_inbound_failed" },
    });

    return NextResponse.json(
      {
        ok: false,
        error: "textgrid_inbound_failed",
      },
      { status: 500 }
    );
  }
}
