// ─── textgrid.js ──────────────────────────────────────────────────────────
import crypto from "node:crypto";

import ENV from "@/lib/config/env.js";
import {
  buildTextgridConfigurationError,
  getValidatedTextgridConfig,
  getTextgridProviderReadiness,
  loadTextgridConfig,
} from "@/lib/config/textgrid-config.js";
import { recordSystemAlert } from "@/lib/domain/alerts/system-alerts.js";
import { evaluateQueueSendRuntimeBrakes } from "@/lib/domain/queue/queue-control-safety.js";
import { warn, info } from "@/lib/logging/logger.js";
import { normalizeUsPhoneToE164 } from "@/lib/sms/sanitize.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import { getSystemFlag, getSystemValue } from "@/lib/system-control.js";
import { classifyTextGridProviderError } from "@/lib/domain/messaging/textgrid-provider-error-classifier.js";

// Pre-send content guard patterns.
const BLANK_GREETING_RE = /^(Hello|Hi|Hey|Hola|Ola|Marhaba)\s*,|(Hello\s*,|Hey\s*,|Hi\s*,|Hola\s*,|Ola\s*,|Marhaba\s*,)/i;
const UNRESOLVED_PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

// ══════════════════════════════════════════════════════════════════════════
// CONFIG & ENV VALIDATION
// ══════════════════════════════════════════════════════════════════════════

const TEXTGRID_API_ORIGIN = "https://api.textgrid.com";
const TEXTGRID_API_VERSION_PATH = "/2010-04-01";
const TEXTGRID_ACCOUNT_SID_PLACEHOLDER = "{ACCOUNT_SID}";
const TEXTGRID_BASE_URL = `${TEXTGRID_API_ORIGIN}${TEXTGRID_API_VERSION_PATH}`;

const REQUEST_TIMEOUT_MS = 15_000;
// TextGrid send requests must use the fixed, Twilio-compatible REST path:
//   POST /2010-04-01/Accounts/{AccountSid}/Messages.json
const TEXTGRID_MESSAGES_RESOURCE = "/Messages.json";

const TEXTGRID_PROVIDER_CAPABILITIES = Object.freeze({
  message_status_lookup: {
    supported: false,
    reason: "no_verified_public_textgrid_message_status_lookup_endpoint",
  },
});

// ══════════════════════════════════════════════════════════════════════════
// STRUCTURED ERROR
// ══════════════════════════════════════════════════════════════════════════

export class TextGridError extends Error {
  constructor(message, { status, data, raw_text, endpoint, to, from, body } = {}) {
    super(message);
    this.name = "TextGridError";
    this.status = status ?? null;
    this.data = data ?? null;
    this.raw_text = raw_text ?? null;
    this.endpoint = endpoint ?? null;
    this.to = to ?? null;
    this.from = from ?? null;
    this.body = body ?? null;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = lower(value);
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function objectMetadata(value = null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function isManualInboxSendContext(context = {}) {
  const metadata = objectMetadata(context.metadata);
  return (
    asBoolean(context.manual_operator_send, false) ||
    asBoolean(metadata.manual_operator_send, false) ||
    lower(context.source) === "manual_inbox" ||
    lower(context.send_source) === "manual_inbox" ||
    lower(metadata.source) === "manual_inbox" ||
    lower(metadata.send_source) === "manual_inbox"
  );
}

export function shouldBypassTextgridRuntimeBrakeForManualSend(runtime_brake = {}, context = {}) {
  return (
    runtime_brake?.ok === false &&
    runtime_brake.reason === "queue_emergency_stop_active" &&
    isManualInboxSendContext(context)
  );
}

export function evaluateTextgridRuntimeBrakeForSend(runtime_brake = {}, context = {}) {
  const metadata = { ...objectMetadata(context.metadata) };
  const source = clean(context.source) || clean(metadata.source) || null;
  const send_source = clean(context.send_source) || clean(metadata.send_source) || null;
  const manual_operator_send =
    asBoolean(context.manual_operator_send, false) ||
    asBoolean(metadata.manual_operator_send, false);
  const normalized_metadata = {
    ...metadata,
    ...(source ? { source } : {}),
    ...(send_source ? { send_source } : {}),
    ...(manual_operator_send ? { manual_operator_send: true } : {}),
  };

  if (runtime_brake?.ok !== false) {
    return {
      ok: true,
      blocked: false,
      bypassed_queue_emergency_stop_for_manual_send: false,
      metadata: normalized_metadata,
    };
  }

  if (shouldBypassTextgridRuntimeBrakeForManualSend(runtime_brake, {
    source,
    send_source,
    manual_operator_send,
    metadata,
  })) {
    return {
      ok: true,
      blocked: false,
      reason: runtime_brake.reason,
      bypassed_queue_emergency_stop_for_manual_send: true,
      metadata: {
        ...normalized_metadata,
        bypassed_queue_emergency_stop_for_manual_send: true,
      },
    };
  }

  return {
    ok: false,
    blocked: true,
    error: runtime_brake.error || "runtime_brake_active",
    reason: runtime_brake.reason || "runtime_brake_active",
    message: runtime_brake.message || "Send blocked by runtime safety brake.",
    metadata: normalized_metadata,
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getTextgridSendCredentials() {
  const config = getValidatedTextgridConfig();
  return {
    account_sid: config.account_sid,
    auth_token: config.auth_token,
    configured: config.configured,
    missing: config.missing,
  };
}

export function getTextgridProviderCapabilities() {
  return {
    message_status_lookup: {
      ...TEXTGRID_PROVIDER_CAPABILITIES.message_status_lookup,
    },
  };
}

export function getTextgridSendCredentialStatus() {
  const readiness = getTextgridProviderReadiness();
  const credentials = getTextgridSendCredentials();

  return {
    provider: readiness.provider,
    configured: readiness.configured,
    missing: credentials.missing,
    account_sid_present: readiness.account_sid_present,
    auth_token_present: readiness.auth_token_present,
    sending_identity_configured: readiness.sending_identity_configured,
    webhook_configured: readiness.webhook_configured,
    status_callback_enabled: readiness.status_callback_enabled,
    status_callback_configured: readiness.status_callback_configured,
    base_url: TEXTGRID_BASE_URL,
    send_endpoint: getTextgridSendEndpoint(credentials.account_sid),
  };
}

export function hasTextgridSendCredentials() {
  return getTextgridSendCredentials().configured;
}

// Build the fixed TextGrid send endpoint.
//
// The provider was previously configurable enough to drift onto incorrect
// routes. Sending is now pinned to TextGrid's versioned Messages.json path.
export function getTextgridSendEndpoint(account_sid = null) {
  const sid = clean(
    account_sid ||
      ENV.TEXTGRID_ACCOUNT_SID ||
      process.env.TEXTGRID_ACCOUNT_SID
  );
  const account_segment = sid ? encodeURIComponent(sid) : TEXTGRID_ACCOUNT_SID_PLACEHOLDER;
  return `${TEXTGRID_BASE_URL}/Accounts/${account_segment}${TEXTGRID_MESSAGES_RESOURCE}`;
}

export function getTextgridWebhookSecret() {
  return clean(loadTextgridConfig().webhook_secret);
}

export function hasTextgridWebhookSecret() {
  return Boolean(getTextgridWebhookSecret());
}

export function buildTextgridBearerToken({
  account_sid = getValidatedTextgridConfig().account_sid,
  auth_token = getValidatedTextgridConfig().auth_token,
} = {}) {
  const normalized_account_sid = clean(account_sid);
  const normalized_auth_token = clean(auth_token);

  if (!normalized_account_sid || !normalized_auth_token) {
    return "";
  }

  return Buffer.from(
    `${normalized_account_sid}:${normalized_auth_token}`,
    "utf8"
  ).toString("base64");
}

export function buildTextgridSendHeaders(credentials = {}) {
  return {
    Authorization: `Bearer ${buildTextgridBearerToken(credentials)}`,
    "Content-Type": "application/json",
  };
}

export function buildTextgridSendPayload({
  body = "",
  from = "",
  to = "",
  statusCallback = null,
} = {}) {
  const payload = {
    body: String(body ?? ""),
    from: clean(from),
    to: clean(to),
  };
  const resolved_callback = clean(statusCallback);
  if (resolved_callback) {
    payload.StatusCallback = resolved_callback;
  }
  return payload;
}

function buildTextgridWebhookDigests(raw_body, webhook_secret) {
  const body = String(raw_body ?? "");
  const secret = clean(webhook_secret);

  return {
    hex: crypto.createHmac("sha1", secret).update(body, "utf8").digest("hex"),
    base64: crypto.createHmac("sha1", secret).update(body, "utf8").digest("base64"),
  };
}

export function verifyTextgridWebhookSignature({
  raw_body = "",
  signature = "",
  webhook_secret = getTextgridWebhookSecret(),
} = {}) {
  const normalized_signature = clean(signature);
  const normalized_secret = clean(webhook_secret);

  if (!normalized_secret) {
    return {
      ok: true,
      verified: false,
      required: false,
      algorithm: "HMAC-SHA1",
      reason: "webhook_secret_not_configured",
      signature_present: Boolean(normalized_signature),
    };
  }

  if (!normalized_signature) {
    return {
      ok: false,
      verified: false,
      required: true,
      algorithm: "HMAC-SHA1",
      reason: "missing_signature",
      signature_present: false,
    };
  }

  const { hex, base64 } = buildTextgridWebhookDigests(raw_body, normalized_secret);
  const candidates = [
    hex,
    base64,
    `sha1=${hex}`,
    `sha1=${base64}`,
  ];
  const matched_signature = candidates.find((candidate) =>
    safeEqual(candidate, normalized_signature)
  );

  return {
    ok: Boolean(matched_signature),
    verified: Boolean(matched_signature),
    required: true,
    algorithm: "HMAC-SHA1",
    reason: matched_signature ? "verified" : "invalid_signature",
    signature_present: true,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// NORMALIZATION
// ══════════════════════════════════════════════════════════════════════════

export function normalizePhone(value) {
  return normalizeUsPhoneToE164(value);
}

export function normalizeInboundTextgridPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

// ══════════════════════════════════════════════════════════════════════════
// RETRYABLE STATUS CLASSIFICATION
// ══════════════════════════════════════════════════════════════════════════

const RETRYABLE_STATUSES = new Set([408, 409, 420, 425, 429, 500, 502, 503, 504]);

function isRetryable(status) {
  return RETRYABLE_STATUSES.has(status);
}

// ══════════════════════════════════════════════════════════════════════════
// FAILURE BUCKET CLASSIFICATION
// ══════════════════════════════════════════════════════════════════════════

export function mapTextgridFailureBucket(result) {
  if (!result || result.ok || result.success) return null;

  const classified = classifyTextGridProviderError({
    message: result.error_message,
    status: result.error_status,
    code: result.error_code,
    data: result.raw || result.data,
  });
  if (classified.failure_bucket) return classified.failure_bucket;

  const status = result.error_status ?? 0;
  const msg = String(result.error_message ?? "").toLowerCase();

  if (msg.includes("21610") || msg.includes("blacklist")) {
    return "provider_blacklist_pair";
  }

  if (msg.includes("opt out") || msg.includes("dnc")) return "DNC";
  if (msg.includes("spam")) return "Spam";
  if (
    msg.includes("invalid number") ||
    msg.includes("invalid destination") ||
    msg.includes("invalid sending number")
  ) {
    return "Hard Bounce";
  }
  if ([400, 404].includes(status)) return "Hard Bounce";
  if (RETRYABLE_STATUSES.has(status)) return "Soft Bounce";

  return "Other";
}

// ══════════════════════════════════════════════════════════════════════════
// SEND
// ══════════════════════════════════════════════════════════════════════════

export async function sendTextgridSMS({
  to,
  from,
  body,
  media_urls = [],
  client_reference_id = null,
  message_type = "sms",
  seller_first_name = null,
  bypass_system_control = false,
  bypass_content_guards = false,
  bypass_reason = null,
  source = null,
  send_source = null,
  manual_operator_send = false,
  metadata = null,
  statusCallback = null,
}) {
  const send_metadata = { ...objectMetadata(metadata) };
  const send_context = {
    source: clean(source) || clean(send_metadata.source) || null,
    send_source: clean(send_source) || clean(send_metadata.send_source) || null,
    manual_operator_send:
      asBoolean(manual_operator_send, false) ||
      asBoolean(send_metadata.manual_operator_send, false),
    metadata: send_metadata,
  };

  if (hasSupabaseConfig()) {
    const runtime_brake = evaluateQueueSendRuntimeBrakes(
      {
        queue_processor_mode: await getSystemValue("queue_processor_mode"),
        queue_emergency_stop_at: await getSystemValue("queue_emergency_stop_at"),
      },
      { action: "sendTextgridSMS", failClosed: false }
    );
    const runtime_brake_decision = evaluateTextgridRuntimeBrakeForSend(runtime_brake, send_context);
    if (!runtime_brake_decision.ok) {
      info("send.blocked_runtime_brake", {
        reason: runtime_brake_decision.reason,
        to_input: to,
        client_reference_id,
        bypass_system_control: Boolean(bypass_system_control),
        source: send_context.source,
        send_source: send_context.send_source,
        manual_operator_send: send_context.manual_operator_send,
      });
      throw new TextGridError(
        `sendTextgridSMS: ${runtime_brake_decision.reason} - send blocked by runtime safety brake`,
        { to, from, body }
      );
    }
    Object.assign(send_metadata, runtime_brake_decision.metadata);
    if (runtime_brake_decision.bypassed_queue_emergency_stop_for_manual_send) {
      info("send.bypassed_runtime_brake", {
        reason: runtime_brake_decision.reason,
        to_input: to,
        client_reference_id,
        source: send_context.source || "manual_inbox",
        send_source: send_context.send_source || "manual_inbox",
        manual_operator_send: true,
        bypassed_queue_emergency_stop_for_manual_send: true,
      });
    }
  }

  // ── System control gate ────────────────────────────────────────────────
  const sms_enabled = await getSystemFlag("outbound_sms_enabled", { failClosedOnError: false });
  if (!sms_enabled && !bypass_system_control) {
    info("send.blocked_system_control", {
      flag: "outbound_sms_enabled",
      to_input: to,
      client_reference_id,
    });
    throw new TextGridError(
      "sendTextgridSMS: outbound_sms_enabled flag is false — send blocked by system_control",
      { to, from, body }
    );
  }
  if (!sms_enabled && bypass_system_control) {
    info("send.bypassed_system_control", {
      flag: "outbound_sms_enabled",
      to_input: to,
      client_reference_id,
      bypass_reason: clean(bypass_reason) || "manual_operator_send",
    });
  }

  const normalized_to = normalizePhone(to);
  const normalized_from = normalizePhone(from);
  const credentials = getTextgridSendCredentials();

  if (!normalized_to) {
    throw new TextGridError(`sendTextgridSMS: invalid 'to' number — "${to}"`);
  }

  if (!normalized_from) {
    throw new TextGridError(`sendTextgridSMS: invalid 'from' number — "${from}"`);
  }

  const trimmed_body = String(body ?? "").trim();
  if (!trimmed_body) {
    throw new TextGridError("sendTextgridSMS: message body is empty");
  }

  // ── Content guards ────────────────────────────────────────────────────
  // Block messages with blank seller greeting ("Hello ,").
  if (!bypass_content_guards && BLANK_GREETING_RE.test(trimmed_body)) {
    info("send.blocked_missing_name", {
      reason: "blank_seller_greeting",
      client_reference_id,
      to: normalized_to,
    });
    throw new TextGridError(
      "sendTextgridSMS: message contains blank greeting (missing seller_first_name)",
      { to: normalized_to, from: normalized_from, body: trimmed_body }
    );
  }

  // Block messages with unresolved template placeholders.
  if (!bypass_content_guards && UNRESOLVED_PLACEHOLDER_RE.test(trimmed_body)) {
    info("send.blocked_missing_name", {
      reason: "unresolved_placeholder",
      client_reference_id,
      to: normalized_to,
    });
    throw new TextGridError(
      "sendTextgridSMS: message contains unresolved placeholder",
      { to: normalized_to, from: normalized_from, body: trimmed_body }
    );
  }

  // Block if explicit seller_first_name is empty.
  if (!bypass_content_guards && seller_first_name !== null && String(seller_first_name).trim() === "") {
    info("send.blocked_missing_name", {
      reason: "seller_first_name_blank",
      client_reference_id,
      to: normalized_to,
    });
    throw new TextGridError(
      "sendTextgridSMS: seller_first_name is blank — send blocked",
      { to: normalized_to, from: normalized_from, body: trimmed_body }
    );
  }

  try {
    if (!credentials.configured) {
      const configuration_error = buildTextgridConfigurationError(
        loadTextgridConfig()
      );
      warn("textgrid.configuration_missing", {
        provider: configuration_error.provider,
        missing: configuration_error.missing,
        to_input: to,
        from_input: from,
        client_reference_id,
        source: send_context.source,
        send_source: send_context.send_source,
      });
      throw new TextGridError(configuration_error.message, {
        endpoint: getTextgridSendEndpoint(),
        to: normalized_to,
        from: normalized_from,
        body: trimmed_body,
        data: {
          code: configuration_error.code,
          provider: configuration_error.provider,
          missing: configuration_error.missing,
        },
      });
    }

    const send_endpoint = getTextgridSendEndpoint(credentials.account_sid);
    const status_callback_enabled =
      (ENV.TEXTGRID_STATUS_CALLBACK_ENABLED === true) ||
      ["1", "true", "yes", "on"].includes(lower(process.env.TEXTGRID_STATUS_CALLBACK_ENABLED || ""));
    const payload = buildTextgridSendPayload({
      body: trimmed_body,
      from: normalized_from,
      to: normalized_to,
      statusCallback: status_callback_enabled ? clean(statusCallback) : null,
    });

    const response = await fetch(send_endpoint, {
      method: "POST",
      headers: buildTextgridSendHeaders(credentials),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((error) => {
      throw new TextGridError(
        clean(error?.message) || "TextGrid network request failed",
        {
          endpoint: send_endpoint,
          to: normalized_to,
          from: normalized_from,
          body: trimmed_body,
        }
      );
    });

    const text = await response.text();

    console.log("TEXTGRID STATUS:", response.status);
    console.log("TEXTGRID RESPONSE:", text);

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      throw new TextGridError(`Invalid JSON response: ${text}`, {
        status: response.status,
        raw_text: text,
        endpoint: send_endpoint,
        to: normalized_to,
        from: normalized_from,
        body: trimmed_body,
      });
    }

    if (!response.ok) {
      throw new TextGridError(`TextGrid HTTP failure: ${text}`, {
        status: response.status,
        data,
        raw_text: text,
        endpoint: send_endpoint,
        to: normalized_to,
        from: normalized_from,
        body: trimmed_body,
      });
    }

    const sid = clean(data?.sid);
    if (!sid) {
      throw new TextGridError(`Missing SID (NOT SENT): ${text}`, {
        status: response.status,
        data,
        raw_text: text,
        endpoint: send_endpoint,
        to: normalized_to,
        from: normalized_from,
        body: trimmed_body,
      });
    }

    const provider_status = lower(data?.status);
    if (["failed", "undelivered"].includes(provider_status)) {
      throw new TextGridError(`Carrier rejected message: ${text}`, {
        status: response.status,
        data,
        raw_text: text,
        endpoint: send_endpoint,
        to: normalized_to,
        from: normalized_from,
        body: trimmed_body,
      });
    }

    return {
      success: true,
      ok: true,
      provider: "textgrid",
      sid,
      message_id: sid,
      provider_message_id: sid,
      status: clean(data?.status) || "sent",
      raw: data,
      to: normalized_to,
      from: normalized_from,
      body: trimmed_body,
      endpoint: send_endpoint,
      metadata: {
        ...send_metadata,
        ...(send_context.source ? { source: send_context.source } : {}),
        ...(send_context.send_source ? { send_source: send_context.send_source } : {}),
        ...(send_context.manual_operator_send ? { manual_operator_send: true } : {}),
      },
    };
  } catch (error) {
    const tge =
      error instanceof TextGridError
        ? error
        : new TextGridError(clean(error?.message) || "Unknown TextGrid error", {
            endpoint: getTextgridSendEndpoint(credentials.account_sid || null),
            to: normalized_to,
            from: normalized_from,
            body: trimmed_body,
          });

    warn("textgrid.send_failed", {
      to_input: to,
      from_input: from,
      to: tge.to || normalized_to,
      from: tge.from || normalized_from,
      status: tge.status,
      message: tge.message,
      error_data: tge.data,
      raw_text: tge.raw_text,
      endpoint: tge.endpoint || getTextgridSendEndpoint(credentials.account_sid || null),
      resource: TEXTGRID_MESSAGES_RESOURCE,
      client_reference_id,
    });

    const classified = classifyTextGridProviderError(tge);
    try {
      if (!classified.compliance_related) {
        await recordSystemAlert({
          subsystem: "textgrid",
          code: "send_failed",
          severity: tge.status && tge.status >= 500 ? "high" : "warning",
          retryable: classified.retryable,
          summary: `TextGrid send failed: ${tge.message}`,
          dedupe_key: `textgrid_send_${clean(tge.status) || "unknown"}`,
          affected_ids: [tge.to || normalized_to, tge.from || normalized_from],
          metadata: {
            status: tge.status,
            data: tge.data,
            raw_text: tge.raw_text,
            provider_code: classified.provider_code || null,
            endpoint: tge.endpoint || getTextgridSendEndpoint(credentials.account_sid || null),
          },
        });
      }
    } catch (alert_error) {
      warn("textgrid.send_failed_alert_record_failed", {
        message: clean(alert_error?.message) || "unknown",
        original_message: tge.message,
        original_status: tge.status,
        endpoint: tge.endpoint || getTextgridSendEndpoint(credentials.account_sid || null),
      });
    }

    throw tge;
  }
}
