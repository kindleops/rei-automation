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

import { hasSupabaseConfig, supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { warn } from "@/lib/logging/logger.js";
import { isTerminalDisposition } from "@/lib/domain/inbound/terminal-disposition.js";

const LEDGER_TABLE = "inbound_processing_ledger";

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

export async function beginInboundLedgerEntry(
  {
    idempotency_key,
    provider_message_sid = null,
    thread_key = null,
    from_phone = null,
    to_phone = null,
    message_preview = null,
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

    const { data, error } = await supabase
      .from(LEDGER_TABLE)
      .insert({
        idempotency_key: key,
        provider_message_sid: clean(provider_message_sid) || null,
        thread_key: clean(thread_key) || null,
        from_phone: clean(from_phone) || null,
        to_phone: clean(to_phone) || null,
        message_preview: clean(message_preview).slice(0, 160) || null,
        received_at: received_at || now,
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
      .update({
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
      });
    query = ledger_id ? query.eq("id", ledger_id) : query.eq("idempotency_key", key);
    const { error } = await query;
    if (error) throw error;
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

export default {
  beginInboundLedgerEntry,
  recordInboundTerminalDisposition,
  findInboundLedgerSlaBreaches,
};
