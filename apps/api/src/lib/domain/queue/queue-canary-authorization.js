import crypto from "node:crypto";

function clean(value) {
  return String(value ?? "").trim();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(clean(token), "utf8").digest("hex");
}

function sortedIds(ids = []) {
  return [...new Set(ids.map((id) => clean(id)).filter(Boolean))].sort();
}

export function authorizationMatchesRequest(authorization = {}, request = {}) {
  const campaign_id = clean(request.campaign_id);
  const canary_run_id = clean(request.canary_run_id);
  const requested_ids = sortedIds(request.queue_row_ids || []);
  const authorized_ids = sortedIds(authorization.queue_row_ids || []);

  if (!authorization.id) return { ok: false, reason: "authorization_missing" };
  if (clean(authorization.campaign_id) !== campaign_id) {
    return { ok: false, reason: "authorization_campaign_mismatch" };
  }
  if (clean(authorization.canary_run_id) !== canary_run_id) {
    return { ok: false, reason: "authorization_canary_run_mismatch" };
  }
  if (authorized_ids.length !== requested_ids.length) {
    return { ok: false, reason: "authorization_row_count_mismatch" };
  }
  for (let i = 0; i < authorized_ids.length; i += 1) {
    if (authorized_ids[i] !== requested_ids[i]) {
      return { ok: false, reason: "authorization_row_ids_mismatch" };
    }
  }
  if (authorization.consumed_at && !request.allow_consumed) {
    return { ok: false, reason: "authorization_already_consumed" };
  }
  const expires_at = authorization.expires_at ? new Date(authorization.expires_at).getTime() : NaN;
  const now = request.now ? new Date(request.now).getTime() : Date.now();
  if (!Number.isFinite(expires_at) || expires_at <= now) {
    return { ok: false, reason: "authorization_expired" };
  }
  return { ok: true, authorization_id: authorization.id };
}

export async function loadCanaryAuthorizationByRunId(supabase, canary_run_id) {
  const { data, error } = await supabase
    .from("queue_canary_authorizations")
    .select("*")
    .eq("canary_run_id", clean(canary_run_id))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function validateCanaryAuthorizationToken(supabase, request = {}, provided_token = "") {
  const authorization = await loadCanaryAuthorizationByRunId(supabase, request.canary_run_id);
  if (!authorization) {
    return { ok: false, status: 401, reason: "authorization_not_found" };
  }
  const token = clean(provided_token);
  if (!token) {
    return { ok: false, status: 401, reason: "authorization_token_required" };
  }
  const token_hash = hashToken(token);
  if (token_hash !== clean(authorization.authorization_token_hash)) {
    return { ok: false, status: 401, reason: "authorization_token_invalid" };
  }
  const match = authorizationMatchesRequest(authorization, request);
  if (!match.ok) {
    return { ok: false, status: 401, reason: match.reason };
  }
  return {
    ok: true,
    status: 200,
    authorization,
    authorization_id: authorization.id,
  };
}

export async function consumeCanaryAuthorization(supabase, authorization_id, options = {}) {
  if (!authorization_id) return { ok: false, reason: "authorization_id_required" };
  const now = options.now || new Date().toISOString();
  const { data, error } = await supabase
    .from("queue_canary_authorizations")
    .update({ consumed_at: now })
    .eq("id", authorization_id)
    .is("consumed_at", null)
    .select("id,consumed_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "authorization_consume_failed" };
  return { ok: true, authorization_id: data.id, consumed_at: data.consumed_at };
}

export async function createCanaryAuthorization(
  supabase,
  {
    canary_run_id,
    campaign_id,
    queue_row_ids = [],
    authorization_token,
    expires_at,
    metadata = {},
  } = {}
) {
  const row = {
    canary_run_id: clean(canary_run_id),
    campaign_id: clean(campaign_id),
    queue_row_ids: sortedIds(queue_row_ids),
    authorization_token_hash: hashToken(authorization_token),
    expires_at,
    metadata,
  };
  const { data, error } = await supabase
    .from("queue_canary_authorizations")
    .insert(row)
    .select("id,canary_run_id,campaign_id,queue_row_ids,expires_at,created_at")
    .single();
  if (error) throw error;
  return data;
}