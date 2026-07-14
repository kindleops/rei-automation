import crypto from "node:crypto";
import { normalizePhone } from "@/lib/utils/phones.js";
import { info, warn } from "@/lib/logging/logger.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import {
  CANCELLABLE_QUEUE_STATUSES,
  TERMINAL_QUEUE_OUTCOMES,
} from "@/lib/domain/compliance/canonical-no-contact-states.js";

const SEND_QUEUE_TABLE = "send_queue";

export const CANCELLATION_POLICIES = Object.freeze({
  /** Opt-out, wrong-number, hostile, negative — cancel every unsent outbound type. */
  COMPLIANCE_TERMINAL: "compliance_terminal",
  /** Seller replied — cancel only automated reply rows, not unrelated campaign touches. */
  INBOUND_TAKEOVER: "inbound_takeover",
});

const POLICY_TYPE_FILTERS = Object.freeze({
  [CANCELLATION_POLICIES.COMPLIANCE_TERMINAL]: null,
  [CANCELLATION_POLICIES.INBOUND_TAKEOVER]: new Set(["followup", "auto_reply"]),
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function buildScopeKey(scope = {}) {
  return [
    clean(scope.thread_key) || "",
    normalizePhone(scope.to_phone_number) || "",
    clean(scope.phone_id) || "",
    clean(scope.prospect_id) || "",
    clean(scope.master_owner_id) || "",
    clean(scope.property_id) || "",
  ].join("|");
}

function buildCancellationIdempotencyKey({
  policy,
  reason,
  scope_key,
  inbound_event_id = null,
}) {
  const seed = `${policy}:${reason}:${scope_key}:${clean(inbound_event_id) || "none"}`;
  return `compliance_cancel:${crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32)}`;
}

function rowMatchesScope(row = {}, scope = {}) {
  const row_thread = normalizePhone(row.thread_key) || clean(row.thread_key);
  const row_to = normalizePhone(row.to_phone_number);
  const scope_thread = normalizePhone(scope.thread_key) || clean(scope.thread_key);
  const scope_to = normalizePhone(scope.to_phone_number);

  if (scope_thread && row_thread && row_thread === scope_thread) return true;
  if (scope_to && row_to && row_to === scope_to) return true;

  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  if (scope.phone_id && clean(row.phone_number_id || meta.phone_id) === clean(scope.phone_id)) {
    return true;
  }
  if (scope.prospect_id && clean(row.prospect_id || meta.prospect_id) === clean(scope.prospect_id)) {
    return true;
  }
  if (
    scope.master_owner_id &&
    clean(row.master_owner_id || meta.master_owner_id) === clean(scope.master_owner_id)
  ) {
    return true;
  }
  if (scope.property_id && clean(row.property_id || meta.property_id) === clean(scope.property_id)) {
    return true;
  }

  return false;
}

async function fetchCandidateRows(supabase, scope = {}) {
  const filters = [];
  const normalized_thread = normalizePhone(scope.thread_key) || clean(scope.thread_key);
  const normalized_to = normalizePhone(scope.to_phone_number);

  if (normalized_thread) {
    const { data, error } = await supabase
      .from(SEND_QUEUE_TABLE)
      .select(
        "id,thread_key,to_phone_number,queue_status,type,message_type,metadata,master_owner_id,prospect_id,property_id,phone_number_id,created_at"
      )
      .eq("thread_key", normalized_thread)
      .in("queue_status", [...CANCELLABLE_QUEUE_STATUSES])
      .limit(200);
    if (error) throw error;
    if (Array.isArray(data) && data.length) filters.push(...data);
  }

  if (normalized_to && normalized_to !== normalized_thread) {
    const { data, error } = await supabase
      .from(SEND_QUEUE_TABLE)
      .select(
        "id,thread_key,to_phone_number,queue_status,type,message_type,metadata,master_owner_id,prospect_id,property_id,phone_number_id,created_at"
      )
      .eq("to_phone_number", normalized_to)
      .in("queue_status", [...CANCELLABLE_QUEUE_STATUSES])
      .limit(200);
    if (error) throw error;
    if (Array.isArray(data) && data.length) filters.push(...data);
  }

  if (!filters.length && scope.master_owner_id) {
    const { data, error } = await supabase
      .from(SEND_QUEUE_TABLE)
      .select(
        "id,thread_key,to_phone_number,queue_status,type,message_type,metadata,master_owner_id,prospect_id,property_id,phone_number_id,created_at"
      )
      .eq("master_owner_id", scope.master_owner_id)
      .in("queue_status", [...CANCELLABLE_QUEUE_STATUSES])
      .limit(200);
    if (error) throw error;
    if (Array.isArray(data) && data.length) filters.push(...data);
  }

  const deduped = new Map();
  for (const row of filters) {
    if (!row?.id) continue;
    if (!rowMatchesScope(row, scope)) continue;
    deduped.set(row.id, row);
  }
  return [...deduped.values()];
}

/**
 * Cancel pending Supabase send_queue rows for a canonical identity scope.
 */
export async function cancelSupabasePendingOutbound(
  {
    thread_key = null,
    to_phone_number = null,
    phone_id = null,
    prospect_id = null,
    master_owner_id = null,
    property_id = null,
    policy = CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
    reason = "compliance_suppression",
    suppression_reason = null,
    inbound_event_id = null,
    cancelled_by = "compliance_guard",
    now = new Date().toISOString(),
    dry_run = false,
  } = {},
  deps = {}
) {
  const supabase = deps.supabase || deps.supabaseClient;
  const scope = {
    thread_key,
    to_phone_number,
    phone_id,
    prospect_id,
    master_owner_id,
    property_id,
  };
  const scope_key = buildScopeKey(scope);
  const type_filter = POLICY_TYPE_FILTERS[policy] ?? POLICY_TYPE_FILTERS[CANCELLATION_POLICIES.COMPLIANCE_TERMINAL];

  if (!supabase) {
    return { ok: false, cancelled: 0, reason: "missing_supabase_client", scope_key };
  }

  if (!scope_key.replace(/\|/g, "")) {
    return { ok: false, cancelled: 0, reason: "missing_scope_identity", scope_key };
  }

  const idempotency_key = buildCancellationIdempotencyKey({
    policy,
    reason,
    scope_key,
    inbound_event_id,
  });

  if (deps.audit_idempotency_cache?.has?.(idempotency_key)) {
    return {
      ok: true,
      cancelled: 0,
      reason: "duplicate_cancellation_suppressed",
      idempotent_replay: true,
      idempotency_key,
      scope_key,
    };
  }

  let candidates = [];
  try {
    candidates = await fetchCandidateRows(supabase, scope);
  } catch (error) {
    warn("compliance.cancel_fetch_failed", {
      scope_key,
      message: error?.message || "unknown_error",
    });
    return { ok: false, cancelled: 0, reason: error?.message || "fetch_failed", scope_key };
  }

  const eligible = candidates.filter((row) => {
    if (TERMINAL_QUEUE_OUTCOMES.has(lower(row.queue_status))) return false;
    const row_type = lower(row.type || row.message_type);
    if (type_filter && !type_filter.has(row_type)) return false;
    return true;
  });

  if (!eligible.length) {
    return {
      ok: true,
      cancelled: 0,
      reason: "no_pending_rows",
      idempotency_key,
      scope_key,
      scanned: candidates.length,
    };
  }

  if (dry_run) {
    return {
      ok: true,
      cancelled: eligible.length,
      dry_run: true,
      would_cancel_ids: eligible.map((row) => row.id),
      idempotency_key,
      scope_key,
    };
  }

  let cancelled = 0;
  const cancelled_ids = [];
  const suppression_at = now;

  for (const row of eligible) {
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    if (meta.compliance_cancel_idempotency_key === idempotency_key) {
      continue;
    }

    const { error: update_error } = await supabase
      .from(SEND_QUEUE_TABLE)
      .update({
        queue_status: "cancelled",
        is_locked: false,
        locked_at: null,
        lock_token: null,
        updated_at: now,
        metadata: {
          ...meta,
          skip_reason: reason,
          cancellation_reason: reason,
          suppression_reason: suppression_reason || reason,
          cancelled_by,
          cancelled_at: now,
          compliance_cancelled_at: suppression_at,
          cancelled_by_inbound_event_id: inbound_event_id || null,
          compliance_cancel_idempotency_key: idempotency_key,
          finalized_at: now,
          final_queue_status: "cancelled",
        },
      })
      .eq("id", row.id)
      .in("queue_status", [...CANCELLABLE_QUEUE_STATUSES]);

    if (update_error) {
      warn("compliance.cancel_row_failed", {
        queue_row_id: row.id,
        message: update_error.message,
      });
      continue;
    }

    cancelled += 1;
    cancelled_ids.push(row.id);
  }

  if (cancelled > 0) {
    info("compliance.pending_outbound_cancelled", {
      cancelled,
      policy,
      reason,
      scope_key,
      inbound_event_id: inbound_event_id || null,
      cancelled_ids,
      suppression_to_cancellation_ms: null,
    });

    try {
      await emitAutomationEvent(
        {
          event_type: "OUTBOUND_CANCELLED_COMPLIANCE",
          dedupe_key: idempotency_key,
          payload: {
            policy,
            reason,
            suppression_reason: suppression_reason || reason,
            cancelled_count: cancelled,
            cancelled_queue_row_ids: cancelled_ids,
            scope_key,
            inbound_event_id: inbound_event_id || null,
            cancelled_at: now,
          },
        },
        { supabase }
      );
    } catch (event_error) {
      warn("compliance.cancel_event_emit_failed", {
        message: event_error?.message || "unknown_error",
      });
    }

    if (deps.audit_idempotency_cache?.add) {
      deps.audit_idempotency_cache.add(idempotency_key);
    }
  }

  return {
    ok: true,
    cancelled,
    cancelled_ids,
    scanned: candidates.length,
    eligible_count: eligible.length,
    idempotency_key,
    scope_key,
    policy,
    reason,
  };
}

export default cancelSupabasePendingOutbound;