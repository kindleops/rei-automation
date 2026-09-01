// ─── canary-enqueue-authorization.js ────────────────────────────────────────
// SCOPED ENQUEUE AUTHORIZATION
//
// campaign_mode is `paused`, which closes the global campaign gate: no ordinary
// campaign enqueue may create a queue row. That gate MUST stay closed. This
// module is the single, explicit, narrowly-scoped exception used to materialise
// exactly one internal-canary opener, and nothing else.
//
// It deliberately reuses the EXISTING scoped-canary substrate
// (public.queue_canary_authorizations) rather than inventing a parallel bypass:
// same table, same sha256 token hash, same expires_at, same one-time
// consumed_at semantics. The only new thing is a scope discriminator.
//
// TWO SCOPES, MUTUALLY EXCLUSIVE
//   dispatch  (legacy, scope absent)  authorizes SENDING rows that already
//                                     exist; identified by a non-empty
//                                     queue_row_ids list.
//   campaign_enqueue_target_one       authorizes CREATING one row that does not
//                                     exist yet; queue_row_ids is necessarily
//                                     empty, and the thing being named is a
//                                     (campaign, campaign_target, recipient)
//                                     triple instead.
//
// WHY SCOPE IS CHECKED FIRST. The dispatch matcher compares sorted id lists by
// length and then element-by-element. An enqueue-scoped row has
// queue_row_ids = [], so against an empty requested list that comparison would
// trivially "match" -- an empty list must NEVER behave as a wildcard. Scope is
// therefore resolved BEFORE any queue-row-list semantics run, each validator
// rejects the other's scope explicitly, and enqueue additionally requires the
// list to be empty so a dispatch-shaped row cannot be replayed here.

import crypto from "node:crypto";

export const ENQUEUE_SCOPE = "campaign_enqueue_target_one";
export const DISPATCH_SCOPE = "queue_dispatch";

export const ENQUEUE_AUTH_REASONS = Object.freeze({
  NOT_FOUND: "enqueue_authorization_not_found",
  TOKEN_REQUIRED: "enqueue_authorization_token_required",
  TOKEN_INVALID: "enqueue_authorization_token_invalid",
  WRONG_SCOPE: "enqueue_authorization_wrong_scope",
  CAMPAIGN_MISMATCH: "enqueue_authorization_campaign_mismatch",
  TARGET_MISMATCH: "enqueue_authorization_target_mismatch",
  RECIPIENT_MISMATCH: "enqueue_authorization_recipient_mismatch",
  ROW_IDS_NOT_EMPTY: "enqueue_authorization_row_ids_must_be_empty",
  EXPIRED: "enqueue_authorization_expired",
  CONSUMED: "enqueue_authorization_already_consumed",
  CAMPAIGN_NOT_CANARY: "enqueue_authorization_campaign_not_internal_canary",
  CAMPAIGN_ACTIVATABLE: "enqueue_authorization_campaign_missing_do_not_activate",
  CAMPAIGN_LIVE: "enqueue_authorization_campaign_is_live",
  RECIPIENT_NOT_ALLOWLISTED: "enqueue_authorization_recipient_not_allowlisted",
});

/** Campaign statuses that mean the campaign is live. Enqueue scope forbids all. */
const LIVE_CAMPAIGN_STATUSES = new Set(["active", "running", "live", "sending", "launched"]);

function clean(value) {
  return String(value ?? "").trim();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(clean(token), "utf8").digest("hex");
}

/** E.164 for comparison, so +1 305 980 7795 and +13059807795 are one recipient. */
export function normalizeRecipient(value) {
  const digits = clean(value).replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

/** Which scope is this authorization row? Never inferred from an empty list. */
export function authorizationScope(authorization = {}) {
  const declared = clean(authorization?.metadata?.scope);
  if (declared) return declared;
  // Legacy rows predate the discriminator; they are dispatch authorizations.
  return DISPATCH_SCOPE;
}

export function isEnqueueScoped(authorization = {}) {
  return authorizationScope(authorization) === ENQUEUE_SCOPE;
}

/**
 * Does this authorization permit creating exactly this one queue row?
 *
 * Every field is an exact equality check. There is no wildcard, no prefix
 * match, and no "empty means any".
 */
export function enqueueAuthorizationMatchesRequest(authorization = {}, request = {}) {
  if (!authorization?.id) return { ok: false, reason: ENQUEUE_AUTH_REASONS.NOT_FOUND };

  // SCOPE FIRST -- before any queue-row-list semantics can run.
  if (!isEnqueueScoped(authorization)) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.WRONG_SCOPE };
  }

  // An enqueue authorization names no existing rows. A non-empty list means a
  // dispatch-shaped row is being replayed against the enqueue validator.
  const rowIds = Array.isArray(authorization.queue_row_ids) ? authorization.queue_row_ids : [];
  if (rowIds.length !== 0) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.ROW_IDS_NOT_EMPTY };
  }

  const meta = authorization.metadata && typeof authorization.metadata === "object"
    ? authorization.metadata
    : {};

  if (clean(authorization.campaign_id) !== clean(request.campaign_id)) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.CAMPAIGN_MISMATCH };
  }
  if (clean(meta.campaign_target_id) !== clean(request.campaign_target_id)) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.TARGET_MISMATCH };
  }
  const authorizedRecipient = normalizeRecipient(meta.recipient);
  const requestedRecipient = normalizeRecipient(request.recipient);
  if (!authorizedRecipient || authorizedRecipient !== requestedRecipient) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.RECIPIENT_MISMATCH };
  }

  if (authorization.consumed_at) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.CONSUMED };
  }

  const expiresAt = authorization.expires_at ? new Date(authorization.expires_at).getTime() : NaN;
  const now = request.now ? new Date(request.now).getTime() : Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.EXPIRED };
  }

  return { ok: true, authorization_id: authorization.id };
}

/**
 * Conditions on the CAMPAIGN itself. An authorization may never be used to
 * enqueue against an ordinary or live campaign, no matter how valid the token.
 */
export function campaignPermitsCanaryEnqueue(campaign = {}) {
  const meta = campaign?.metadata && typeof campaign.metadata === "object" ? campaign.metadata : {};
  if (meta.internal_canary !== true) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.CAMPAIGN_NOT_CANARY };
  }
  if (meta.do_not_activate !== true) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.CAMPAIGN_ACTIVATABLE };
  }
  if (LIVE_CAMPAIGN_STATUSES.has(clean(campaign.status).toLowerCase())) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.CAMPAIGN_LIVE };
  }
  return { ok: true };
}

/** The recipient must still be on the auto-reply allowlist at use time. */
export function recipientIsAllowlisted(allowlistValue, recipient) {
  const target = normalizeRecipient(recipient);
  if (!target) return false;
  const digits = target.replace(/\D+/g, "");
  const bare10 = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const raw = clean(allowlistValue);
  if (!raw) return false;
  return raw
    .split(",")
    .map((entry) => clean(entry).replace(/\D+/g, ""))
    .filter(Boolean)
    .some((entry) => entry === digits || entry === bare10 || entry === `1${bare10}`);
}

export async function loadEnqueueAuthorizationByRunId(supabase, canary_run_id) {
  const { data, error } = await supabase
    .from("queue_canary_authorizations")
    .select("*")
    .eq("canary_run_id", clean(canary_run_id))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Full validation. Returns { ok, reason } and NEVER consumes -- consumption is a
 * separate explicit step so a dry run can validate without spending the
 * authorization.
 */
export async function validateCanaryEnqueueAuthorization(
  supabase,
  { canary_run_id, campaign_id, campaign_target_id, recipient, campaign, allowlist_value, now } = {},
  provided_token = ""
) {
  const authorization = await loadEnqueueAuthorizationByRunId(supabase, canary_run_id);
  if (!authorization) return { ok: false, reason: ENQUEUE_AUTH_REASONS.NOT_FOUND };

  const token = clean(provided_token);
  if (!token) return { ok: false, reason: ENQUEUE_AUTH_REASONS.TOKEN_REQUIRED };
  if (hashToken(token) !== clean(authorization.authorization_token_hash)) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.TOKEN_INVALID };
  }

  const match = enqueueAuthorizationMatchesRequest(authorization, {
    campaign_id,
    campaign_target_id,
    recipient,
    now,
  });
  if (!match.ok) return { ok: false, reason: match.reason };

  const campaignVerdict = campaignPermitsCanaryEnqueue(campaign || {});
  if (!campaignVerdict.ok) return { ok: false, reason: campaignVerdict.reason };

  if (!recipientIsAllowlisted(allowlist_value, recipient)) {
    return { ok: false, reason: ENQUEUE_AUTH_REASONS.RECIPIENT_NOT_ALLOWLISTED };
  }

  return { ok: true, authorization, authorization_id: authorization.id };
}

/**
 * One-time consumption. The `.is("consumed_at", null)` predicate makes this
 * atomic: two concurrent consumers cannot both succeed.
 *
 * `already_consumed` is returned rather than an error when the row was already
 * spent, so a replay after an interrupted consumption can complete
 * idempotently instead of stranding a created queue row.
 */
export async function consumeEnqueueAuthorization(supabase, authorization_id, options = {}) {
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
  if (!data) return { ok: true, already_consumed: true, authorization_id };
  return { ok: true, already_consumed: false, authorization_id: data.id, consumed_at: data.consumed_at };
}

export async function createCanaryEnqueueAuthorization(
  supabase,
  { canary_run_id, campaign_id, campaign_target_id, recipient, authorization_token, expires_at, metadata = {} } = {}
) {
  const row = {
    canary_run_id: clean(canary_run_id),
    campaign_id: clean(campaign_id),
    // Enqueue scope names no existing rows, by construction.
    queue_row_ids: [],
    authorization_token_hash: hashToken(authorization_token),
    expires_at,
    metadata: {
      ...metadata,
      scope: ENQUEUE_SCOPE,
      campaign_target_id: clean(campaign_target_id),
      recipient: normalizeRecipient(recipient),
    },
  };
  const { data, error } = await supabase
    .from("queue_canary_authorizations")
    .insert(row)
    .select("id,canary_run_id,campaign_id,queue_row_ids,expires_at,created_at,metadata")
    .single();
  if (error) throw error;
  return data;
}
