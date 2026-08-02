// ─── inbound-processing-ledger.js ────────────────────────────────────────────
// Durable per-inbound processing record backing the terminal-disposition
// invariant. One row per idempotency key; the SLA scan alerts on any row that
// stays 'processing' past the disposition deadline, so an inbound that
// crashes out of every other code path still surfaces as a P0 instead of
// disappearing.
//
// Recording is deliberately non-blocking for inbound availability: a ledger
// write failure is loudly logged but never rejects the webhook — the provider
// retrying because our observability store hiccuped would double-process real
// seller messages. The webhook_log cross-check in the SLA scan covers the
// residual gap.
//
// PII minimization + retention: the ledger never stores raw seller message
// text — only a SHA-256 digest and length (enough to correlate/deduplicate
// without content). Phone numbers are kept because they ARE the thread
// identifiers the SLA scan and ops correlation need, but every row carries
// retain_until (receipt + INBOUND_LEDGER_RETENTION_DAYS) and is hard-deleted
// by the daily /api/internal/inbound/ledger-retention-purge cron. The
// migration (20260801060000_inbound_processing_ledger.sql) is the retention
// policy of record.

import crypto from "node:crypto";
import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { warn } from "@/lib/logging/logger.js";
import { isTerminalDisposition } from "@/lib/domain/inbound/terminal-disposition.js";

const LEDGER_TABLE = "inbound_processing_ledger";

// Operational retention window for ledger rows (seller phone numbers + body
// digests). The SLA scan only needs minutes-old rows; 30 days covers incident
// forensics with margin while keeping seller PII bounded.
export const INBOUND_LEDGER_RETENTION_DAYS = 30;
const RETENTION_MS = INBOUND_LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function clean(value) {
  return String(value ?? "").trim();
}

function getSupabase(deps = {}) {
  const client = deps.supabase || deps.supabaseClient;
  if (client) return client;
  return hasSupabaseConfig() ? defaultSupabase : null;
}

// PII minimization: persist a content digest + length, never the seller text.
function digestMessageBody(value) {
  const text = String(value ?? "");
  if (!text) return { body_sha256: null, body_length: 0 };
  return {
    body_sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    body_length: text.length,
  };
}

function retainUntilFrom(received_at, now) {
  const received_ms = Date.parse(clean(received_at));
  const base_ms = Number.isFinite(received_ms) ? received_ms : Date.parse(now);
  return new Date(base_ms + RETENTION_MS).toISOString();
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

export async function beginInboundLedgerEntry(
  {
    idempotency_key,
    provider_message_sid = null,
    thread_key = null,
    from_phone = null,
    to_phone = null,
    message_body = null,
    processing_run_id = null,
    received_at = null,
  } = {},
  deps = {}
) {
  const key = clean(idempotency_key);
  if (!key) return { ok: false, reason: "idempotency_key_required" };
  const supabase = getSupabase(deps);
  if (!supabase) return { ok: false, reason: "supabase_unconfigured" };
  const now = deps.now || new Date().toISOString();

  try {
    const { data: existing, error: lookup_error } = await supabase
      .from(LEDGER_TABLE)
      .select("id,status,terminal_disposition,attempt_count")
      .eq("idempotency_key", key)
      .maybeSingle();
    if (lookup_error) throw lookup_error;

    if (existing?.status === "completed") {
      return {
        ok: true,
        duplicate_completed: true,
        ledger_id: existing.id,
        terminal_disposition: existing.terminal_disposition,
      };
    }

    if (existing) {
      const { error: retry_error } = await supabase
        .from(LEDGER_TABLE)
        .update({
          status: "processing",
          attempt_count: (existing.attempt_count || 1) + 1,
          processing_run_id,
          error_message: null,
          updated_at: now,
        })
        .eq("id", existing.id);
      if (retry_error) throw retry_error;
      return { ok: true, ledger_id: existing.id, retry: true };
    }

    const { body_sha256, body_length } = digestMessageBody(clean(message_body));
    const { data, error } = await supabase
      .from(LEDGER_TABLE)
      .insert({
        idempotency_key: key,
        provider_message_sid: clean(provider_message_sid) || null,
        thread_key: clean(thread_key) || null,
        from_phone: clean(from_phone) || null,
        to_phone: clean(to_phone) || null,
        body_sha256,
        body_length,
        received_at: received_at || now,
        retain_until: retainUntilFrom(received_at || now, now),
        processing_run_id,
        status: "processing",
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true, ledger_id: data.id };
  } catch (error) {
    if (tableMissing(error)) {
      warn("inbound_ledger.table_missing", { idempotency_key: key });
      return { ok: false, reason: "ledger_table_missing" };
    }
    warn("inbound_ledger.begin_failed", {
      idempotency_key: key,
      error: error?.message || "unknown",
    });
    return { ok: false, reason: "ledger_begin_failed", message: error?.message };
  }
}

export async function recordInboundTerminalDisposition(
  {
    ledger_id = null,
    idempotency_key = null,
    disposition,
    detail = {},
    detected_intent = null,
    classifier_version = null,
    confidence = null,
    latency_ms = null,
    error_message = null,
  } = {},
  deps = {}
) {
  const key = clean(idempotency_key);
  if (!ledger_id && !key) return { ok: false, reason: "ledger_reference_required" };
  if (!isTerminalDisposition(disposition)) {
    warn("inbound_ledger.invalid_disposition", { disposition, idempotency_key: key });
    return { ok: false, reason: "invalid_terminal_disposition" };
  }
  const supabase = getSupabase(deps);
  if (!supabase) return { ok: false, reason: "supabase_unconfigured" };
  const now = deps.now || new Date().toISOString();
  const failed =
    disposition === "failed_retriable" || disposition === "failed_terminal";

  try {
    let query = supabase
      .from(LEDGER_TABLE)
      .update(
        {
          status: failed ? "failed" : "completed",
          terminal_disposition: disposition,
          disposition_detail: detail && typeof detail === "object" ? detail : {},
          detected_intent: clean(detected_intent) || null,
          classifier_version: clean(classifier_version) || null,
          confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
          latency_ms: Number.isFinite(Number(latency_ms)) ? Math.round(Number(latency_ms)) : null,
          error_message: clean(error_message) || null,
          completed_at: now,
          updated_at: now,
        },
        { count: "exact" }
      );
    query = ledger_id ? query.eq("id", ledger_id) : query.eq("idempotency_key", key);
    const { error, count } = await query;
    if (error) throw error;
    // Durable-write truthfulness: an update that matched no row (begin failed,
    // row deleted, wrong reference) is a FAILURE — reporting success here
    // would hide exactly the silent drop this ledger exists to make loud.
    if (count !== 1) {
      warn("inbound_ledger.record_row_missing", {
        idempotency_key: key,
        ledger_id,
        disposition,
        updated_count: count ?? 0,
      });
      return {
        ok: false,
        reason: "ledger_row_missing",
        disposition,
        updated_count: count ?? 0,
      };
    }
    return { ok: true, disposition };
  } catch (error) {
    if (tableMissing(error)) {
      return { ok: false, reason: "ledger_table_missing" };
    }
    warn("inbound_ledger.record_failed", {
      idempotency_key: key,
      ledger_id,
      disposition,
      error: error?.message || "unknown",
    });
    return { ok: false, reason: "ledger_record_failed", message: error?.message };
  }
}

/**
 * SLA scan: rows still 'processing' past the deadline. Used by the P0 alert
 * route; failed_retriable rows past the retry horizon are also surfaced so a
 * permanently-retrying message cannot hide.
 */
export async function findInboundLedgerSlaBreaches(
  { sla_minutes = 10, retry_horizon_minutes = 60, limit = 50 } = {},
  deps = {}
) {
  const supabase = getSupabase(deps);
  if (!supabase) return { ok: false, reason: "supabase_unconfigured", breach_count: 0 };
  const now = deps.now ? new Date(deps.now) : new Date();
  const processing_cutoff = new Date(now.getTime() - sla_minutes * 60_000).toISOString();
  const retry_cutoff = new Date(now.getTime() - retry_horizon_minutes * 60_000).toISOString();

  try {
    const { data: stuck, error: stuck_error } = await supabase
      .from(LEDGER_TABLE)
      .select("id,idempotency_key,provider_message_sid,thread_key,received_at,status,attempt_count")
      .eq("status", "processing")
      .lt("received_at", processing_cutoff)
      .order("received_at", { ascending: true })
      .limit(limit);
    if (stuck_error) throw stuck_error;

    const { data: retrying, error: retry_error } = await supabase
      .from(LEDGER_TABLE)
      .select("id,idempotency_key,provider_message_sid,thread_key,received_at,status,attempt_count,terminal_disposition")
      .eq("status", "failed")
      .eq("terminal_disposition", "failed_retriable")
      .lt("received_at", retry_cutoff)
      .order("received_at", { ascending: true })
      .limit(limit);
    if (retry_error) throw retry_error;

    return {
      ok: true,
      stuck_processing: stuck || [],
      exhausted_retries: retrying || [],
      breach_count: (stuck?.length || 0) + (retrying?.length || 0),
    };
  } catch (error) {
    if (tableMissing(error)) {
      return { ok: false, reason: "ledger_table_missing", breach_count: 0 };
    }
    return { ok: false, reason: "ledger_scan_failed", message: error?.message, breach_count: 0 };
  }
}

/**
 * Retention purge: hard-delete ledger rows past retain_until. The ledger holds
 * seller phone numbers and body digests, so rows must not outlive the
 * documented INBOUND_LEDGER_RETENTION_DAYS window. Select-then-delete keeps
 * every cron invocation bounded (never an unbounded DELETE).
 */
export async function purgeExpiredInboundLedgerRows({ limit = 500 } = {}, deps = {}) {
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
      .from(LEDGER_TABLE)
      .select("id")
      .lt("retain_until", now)
      .order("retain_until", { ascending: true })
      .limit(batch_limit);
    if (select_error) throw select_error;

    const ids = (expired || []).map((row) => row.id);
    if (!ids.length) return { ok: true, purged: 0, more: false };

    const { error: delete_error, count } = await supabase
      .from(LEDGER_TABLE)
      .delete({ count: "exact" })
      .in("id", ids);
    if (delete_error) throw delete_error;

    return { ok: true, purged: count ?? ids.length, more: ids.length === batch_limit };
  } catch (error) {
    if (tableMissing(error)) {
      return { ok: false, reason: "ledger_table_missing", purged: 0 };
    }
    warn("inbound_ledger.purge_failed", { error: error?.message || "unknown" });
    return { ok: false, reason: "ledger_purge_failed", message: error?.message, purged: 0 };
  }
}

export default {
  beginInboundLedgerEntry,
  recordInboundTerminalDisposition,
  findInboundLedgerSlaBreaches,
  purgeExpiredInboundLedgerRows,
  INBOUND_LEDGER_RETENTION_DAYS,
};
