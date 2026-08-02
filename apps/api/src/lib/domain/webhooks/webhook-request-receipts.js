// ─── webhook-request-receipts.js ─────────────────────────────────────────────
// Durable route-level request-receipt audit layer.
//
// The inbound_processing_ledger records authenticated MESSAGE events; requests
// rejected at the route boundary (invalid signature, malformed payload,
// missing sender, oversized body, parser exception, …) previously terminated
// before the handler wrapper and were log-only. Every inbound webhook HTTP
// request outcome — accepted, rejected, duplicate — gets exactly one receipt
// row here, queryable by outcome/reason/SID/correlation id, without polluting
// the message ledger with non-message noise.
//
// PII posture:
//   * the raw request body is NEVER stored — SHA-256 digest + length only;
//   * phone identifiers are masked (country prefix + last 4) plus a SHA-256
//     digest for correlation; full numbers never land in this table;
//   * rows carry retain_until (receipt + WEBHOOK_RECEIPT_RETENTION_DAYS) and
//     are hard-deleted by the daily ledger-retention-purge cron.
//
// Failure posture: receipts are OBSERVABILITY. A receipt write failure is
// loudly logged and never changes the HTTP response — rejecting provider
// traffic because the audit store hiccuped would trade a bounded
// observability gap for real message loss.

import crypto from "node:crypto";
import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { warn } from "@/lib/logging/logger.js";

const RECEIPT_TABLE = "webhook_request_receipts";

export const WEBHOOK_RECEIPT_RETENTION_DAYS = 30;
const RETENTION_MS = WEBHOOK_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export const RECEIPT_OUTCOMES = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  DUPLICATE: "duplicate",
});

// Canonical rejection vocabulary. Route call sites must use one of these so
// the receipts stay queryable by class; free-text detail belongs in `detail`.
export const RECEIPT_REJECTION_REASONS = Object.freeze([
  "invalid_signature",
  "missing_signature",
  "malformed_payload",
  "missing_sender",
  "missing_destination",
  "empty_body",
  "unsupported_media_only",
  "oversized_request",
  "unknown_provider_event",
  "authentication_failure",
  "parser_exception",
  "debug_stage_forbidden",
  "rate_limited",
  "internal_error",
  "inbound_claim_unavailable",
]);
const REJECTION_REASON_SET = new Set(RECEIPT_REJECTION_REASONS);

const SIGNATURE_STATUSES = new Set([
  "valid",
  "invalid",
  "missing",
  "skipped_mode_off",
  "skipped_log_only",
  "not_applicable",
  "unknown",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function getSupabase(deps = {}) {
  const client = deps.supabase || deps.supabaseClient;
  if (client) return client;
  return hasSupabaseConfig() ? defaultSupabase : null;
}

function tableMissing(error) {
  const msg = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    msg.includes("does not exist") ||
    msg.includes("could not find the table")
  );
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

// PII minimization: "+16128072000" → "+1******2000". Non-phone garbage is
// hashed only (masked form null) so junk sender fields can't leak verbatim.
export function maskPhoneForReceipt(value) {
  const raw = clean(value);
  if (!raw) return { masked: null, digest: null };
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) {
    return { masked: null, digest: sha256(raw) };
  }
  const last4 = digits.slice(-4);
  const prefix = raw.startsWith("+") ? `+${digits.slice(0, digits.length > 10 ? digits.length - 10 : 1)}` : "";
  return {
    masked: `${prefix}${"*".repeat(6)}${last4}`,
    digest: sha256(raw),
  };
}

export function digestBodyForReceipt(value) {
  const text = String(value ?? "");
  if (!text) return { body_sha256: null, body_length: 0 };
  return { body_sha256: sha256(text), body_length: text.length };
}

/**
 * Record one durable receipt for an inbound webhook HTTP request outcome.
 * Never throws; never stores raw bodies or full phone numbers.
 */
export async function recordWebhookRequestReceipt(
  {
    correlation_id,
    webhook_log_id = null,
    idempotency_key = null,
    provider = "textgrid",
    endpoint,
    event_kind = null,
    provider_message_sid = null,
    from_phone = null,
    to_phone = null,
    raw_body = null,
    outcome,
    rejection_reason = null,
    signature_status = "unknown",
    http_status,
    received_at = null,
    detail = {},
  } = {},
  deps = {}
) {
  const normalized_outcome = clean(outcome).toLowerCase();
  if (!Object.values(RECEIPT_OUTCOMES).includes(normalized_outcome)) {
    warn("webhook_receipts.invalid_outcome", { outcome, endpoint });
    return { ok: false, reason: "invalid_receipt_outcome" };
  }
  const normalized_reason = clean(rejection_reason) || null;
  if (normalized_outcome === RECEIPT_OUTCOMES.REJECTED) {
    if (!normalized_reason || !REJECTION_REASON_SET.has(normalized_reason)) {
      warn("webhook_receipts.invalid_rejection_reason", {
        rejection_reason: normalized_reason,
        endpoint,
      });
      return { ok: false, reason: "invalid_rejection_reason" };
    }
  }
  const normalized_signature = SIGNATURE_STATUSES.has(clean(signature_status))
    ? clean(signature_status)
    : "unknown";

  const supabase = getSupabase(deps);
  if (!supabase) return { ok: false, reason: "supabase_unconfigured" };

  const now = deps.now || new Date().toISOString();
  const received = clean(received_at) || now;
  const received_ms = Date.parse(received);
  const retain_until = new Date(
    (Number.isFinite(received_ms) ? received_ms : Date.parse(now)) + RETENTION_MS
  ).toISOString();

  const from_masked = maskPhoneForReceipt(from_phone);
  const to_masked = maskPhoneForReceipt(to_phone);
  const body_digest = digestBodyForReceipt(raw_body);

  try {
    const { data, error } = await supabase
      .from(RECEIPT_TABLE)
      .insert({
        correlation_id: clean(correlation_id) || crypto.randomUUID(),
        webhook_log_id: webhook_log_id || null,
        idempotency_key: clean(idempotency_key) || null,
        provider: clean(provider) || "textgrid",
        endpoint: clean(endpoint) || "unknown",
        event_kind: clean(event_kind) || null,
        provider_message_sid: clean(provider_message_sid) || null,
        from_phone_masked: from_masked.masked,
        from_phone_sha256: from_masked.digest,
        to_phone_masked: to_masked.masked,
        to_phone_sha256: to_masked.digest,
        body_sha256: body_digest.body_sha256,
        body_length: body_digest.body_length,
        outcome: normalized_outcome,
        rejection_reason:
          normalized_outcome === RECEIPT_OUTCOMES.REJECTED ? normalized_reason : normalized_reason,
        signature_status: normalized_signature,
        http_status: Number.isFinite(Number(http_status)) ? Number(http_status) : 0,
        received_at: received,
        retain_until,
        detail: detail && typeof detail === "object" ? detail : {},
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true, receipt_id: data?.id || null };
  } catch (error) {
    if (tableMissing(error)) {
      warn("webhook_receipts.table_missing", { endpoint });
      return { ok: false, reason: "receipt_table_missing" };
    }
    warn("webhook_receipts.write_failed", {
      endpoint,
      outcome: normalized_outcome,
      rejection_reason: normalized_reason,
      error: error?.message || "unknown",
    });
    return { ok: false, reason: "receipt_write_failed", message: error?.message };
  }
}

/**
 * Retention purge for receipts (same select-then-delete batching contract as
 * the inbound ledger purge; invoked by the same daily cron).
 */
export async function purgeExpiredWebhookRequestReceipts({ limit = 500 } = {}, deps = {}) {
  const supabase = getSupabase(deps);
  if (!supabase) return { ok: false, reason: "supabase_unconfigured", purged: 0 };
  const now = deps.now || new Date().toISOString();
  const parsed_limit = Number(limit);
  const batch_limit =
    Number.isFinite(parsed_limit) && parsed_limit > 0
      ? Math.min(Math.round(parsed_limit), 2000)
      : 500;

  try {
    const { data: expired, error: select_error } = await supabase
      .from(RECEIPT_TABLE)
      .select("id")
      .lt("retain_until", now)
      .order("retain_until", { ascending: true })
      .limit(batch_limit);
    if (select_error) throw select_error;

    const ids = (expired || []).map((row) => row.id);
    if (!ids.length) return { ok: true, purged: 0, more: false };

    const { error: delete_error, count } = await supabase
      .from(RECEIPT_TABLE)
      .delete({ count: "exact" })
      .in("id", ids);
    if (delete_error) throw delete_error;

    return { ok: true, purged: count ?? ids.length, more: ids.length === batch_limit };
  } catch (error) {
    if (tableMissing(error)) {
      return { ok: false, reason: "receipt_table_missing", purged: 0 };
    }
    warn("webhook_receipts.purge_failed", { error: error?.message || "unknown" });
    return { ok: false, reason: "receipt_purge_failed", message: error?.message, purged: 0 };
  }
}

export default {
  recordWebhookRequestReceipt,
  purgeExpiredWebhookRequestReceipts,
  maskPhoneForReceipt,
  digestBodyForReceipt,
  RECEIPT_OUTCOMES,
  RECEIPT_REJECTION_REASONS,
  WEBHOOK_RECEIPT_RETENTION_DAYS,
};
