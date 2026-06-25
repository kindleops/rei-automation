import crypto from "node:crypto";
import { warn } from "@/lib/logging/logger.js";
import { normalizeSendQueueRow } from "@/lib/supabase/sms-engine.js";

export const CLAIM_MODES = Object.freeze({
  NORMAL: "normal",
  SCOPED_CANARY: "scoped_canary",
});

function clean(value) {
  return String(value ?? "").trim();
}

function rpcFunctionMissing(error) {
  if (!error) return false;
  const code = error.code || "";
  const msg = `${error.message || ""} ${error.details || ""} ${error.hint || ""}`.toLowerCase();
  return (
    code === "42883" ||
    code === "PGRST202" ||
    msg.includes("could not find the function") ||
    msg.includes("does not exist")
  );
}

export function hashCanaryAuthorizationToken(token) {
  return crypto.createHash("sha256").update(clean(token), "utf8").digest("hex");
}

export function resolveClaimMode(deps = {}) {
  if (deps.claim_mode) return clean(deps.claim_mode).toLowerCase();
  if (deps.scoped_canary === true || deps.claimMode === CLAIM_MODES.SCOPED_CANARY) {
    return CLAIM_MODES.SCOPED_CANARY;
  }
  return CLAIM_MODES.NORMAL;
}

export async function atomicClaimSendQueueRow(row, deps = {}) {
  const supabase = deps.supabase || deps.supabaseClient;
  const normalized = normalizeSendQueueRow(row);
  const queue_row_id = clean(normalized.id);
  if (!supabase) {
    return { ok: false, claimed: false, reason: "supabase_required", row: normalized };
  }
  if (!queue_row_id) {
    return { ok: false, claimed: false, reason: "missing_queue_row_id", row: normalized };
  }

  const claim_mode = resolveClaimMode(deps);
  const processing_run_id = clean(deps.processing_run_id || deps.run_id) || null;
  const canary_run_id = clean(deps.canary_run_id) || null;
  const authorization_token = clean(deps.authorization_token || deps.canary_authorization_token);
  const authorization_token_hash =
    clean(deps.authorization_token_hash) ||
    (authorization_token ? hashCanaryAuthorizationToken(authorization_token) : null);
  const campaign_id = clean(deps.campaign_id || normalized.campaign_id || normalized.metadata?.campaign_id) || null;

  const { data, error } = await supabase.rpc("queue_atomic_claim_send_row", {
    p_queue_row_id: queue_row_id,
    p_claim_mode: claim_mode,
    p_processing_run_id: processing_run_id,
    p_canary_run_id: canary_run_id || null,
    p_authorization_token_hash: claim_mode === CLAIM_MODES.SCOPED_CANARY ? authorization_token_hash : null,
    p_campaign_id: claim_mode === CLAIM_MODES.SCOPED_CANARY ? campaign_id : null,
  });

  if (error) {
    if (rpcFunctionMissing(error)) {
      warn("queue.atomic_claim.function_unavailable", { queue_row_id, claim_mode });
      return {
        ok: false,
        claimed: false,
        reason: "atomic_claim_function_unavailable",
        row: normalized,
        fail_closed: true,
      };
    }
    throw error;
  }

  const result = data && typeof data === "object" ? data : {};
  if (!result.claimed) {
    return {
      ok: false,
      claimed: false,
      reason: result.reason || "atomic_claim_rejected",
      row: normalized,
      block_reason: result.reason || null,
      queue_execution_mode: result.queue_execution_mode || null,
    };
  }

  const claimed_row = normalizeSendQueueRow(result.row || normalized);
  const claim_token = clean(result.claim_token || result.lock_token) || null;
  return {
    ok: true,
    claimed: true,
    reason: "claimed",
    row: claimed_row,
    lock_token: claim_token,
    claim_token,
    claimed_at: result.claimed_at || deps.now || new Date().toISOString(),
    processing_run_id: result.processing_run_id || processing_run_id,
  };
}

export async function verifyDispatchAuthorization(queue_row_id, claim_token, deps = {}) {
  const supabase = deps.supabase || deps.supabaseClient;
  if (!supabase || !queue_row_id || !claim_token) {
    return { ok: false, reason: "missing_dispatch_authorization_inputs" };
  }

  const { data, error } = await supabase.rpc("queue_verify_dispatch_authorization", {
    p_queue_row_id: queue_row_id,
    p_claim_token: claim_token,
  });

  if (error) {
    if (rpcFunctionMissing(error)) {
      return { ok: false, reason: "dispatch_verify_function_unavailable", fail_closed: true };
    }
    throw error;
  }

  const result = data && typeof data === "object" ? data : {};
  return {
    ok: result.ok === true,
    reason: result.reason || (result.ok ? "dispatch_authorized" : "dispatch_denied"),
    claim_mode: result.claim_mode || null,
  };
}

export async function guardedMutateScheduledFor(row_ids = [], scheduled_for, options = {}) {
  const supabase = options.supabase || options.supabaseClient;
  const ids = [...new Set((row_ids || []).map((id) => clean(id)).filter(Boolean))];
  if (!supabase) return { ok: false, reason: "supabase_required" };
  if (!ids.length) return { ok: false, reason: "row_ids_required" };
  if (!scheduled_for) return { ok: false, reason: "scheduled_for_required" };

  const { data, error } = await supabase.rpc("queue_guarded_mutate_scheduled_for", {
    p_row_ids: ids,
    p_scheduled_for: scheduled_for,
    p_operator_reason: clean(options.operator_reason) || null,
    p_metadata: options.metadata && typeof options.metadata === "object" ? options.metadata : {},
  });

  if (error) {
    if (rpcFunctionMissing(error)) {
      return { ok: false, reason: "guarded_scheduled_for_function_unavailable", fail_closed: true };
    }
    throw error;
  }

  return data && typeof data === "object" ? data : { ok: false, reason: "invalid_guarded_mutation_response" };
}