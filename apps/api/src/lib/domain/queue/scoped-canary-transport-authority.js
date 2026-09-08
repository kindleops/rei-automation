/**
 * scoped-canary-transport-authority.js
 *
 * THE ONLY THING THAT MAY EXCUSE THE TEXTGRID ADAPTER'S EMERGENCY BRAKE.
 *
 * WHY THIS EXISTS.
 *   §11 Slice 4H established that `sendTextgridSMS` runs its own brake check,
 *   independent of `evaluateCanonicalSendAuthority`. Canonical scoped-canary
 *   authority succeeded upstream while transport stayed unreachable downstream,
 *   which made `queue_execution_mode = scoped_canary_only` an unreachable
 *   production mode for as long as the global emergency stop is set. The first
 *   live canary died there.
 *
 * WHAT THIS IS NOT.
 *   It is NOT `if (scopedCanary) ignoreEmergencyBrake()`. A caller-supplied
 *   boolean is a description of intent, not a grant of authority, and anything
 *   in this process could set one. It is NOT a general bypass flag either:
 *   there is deliberately no `forceSend`, no `ignoreEmergencyStop`, no
 *   `bypassEmergencyBrake`. Ordinary, manual and campaign sends are untouched
 *   and still stop dead at the brake.
 *
 * WHAT IT IS.
 *   A re-verification, against the database, that the exact send about to
 *   happen is the exact send an operator already authorized and that the
 *   claim RPC already spent. The caller supplies CLAIMS; every one of them is
 *   checked against durable rows it does not control. The load-bearing fact is
 *   `authorization_consumed_at`: a value only `queue_atomic_claim_send_row`
 *   produces, in the same transaction that claimed the row, after it has
 *   already verified the token hash, the expiry, the campaign, the allowlist,
 *   the execution mode and the global lock under FOR UPDATE.
 *
 *   So the exception is not "a canary is running". It is "THIS row, under THIS
 *   authorization, for THIS logical communication, to THIS destination, was
 *   authorized once, has been spent exactly once, and the control plane still
 *   says scoped_canary_only".
 *
 * FAIL CLOSED, ALWAYS. Every unknown, unreadable, absent or mismatched fact is
 * a refusal. There is no branch here that returns ok on missing evidence, and
 * a thrown read is a denial rather than an exception the caller might swallow.
 */

import crypto from "node:crypto";

function clean(value) {
  return String(value ?? "").trim();
}

export const SCOPED_CANARY_TRANSPORT_AUTHORITY_VERSION =
  "scoped_canary_transport_authority_v1";

/**
 * The scope a dispatch authorization SHOULD declare, now written by
 * `createCanaryAuthorization`.
 *
 * It is not required, and requiring it would have been a bug: the established
 * contract in `authorizationMatchesRequest` is NEGATIVE. A dispatch
 * authorization is one that is not enqueue-scoped, and historically it declared
 * no scope at all. An earlier draft of this module demanded this exact literal,
 * which no minting path wrote, so the exception could never verify: every
 * canary would have burned its single-use authorization and still been refused
 * at the brake. The rule below therefore mirrors the existing contract and adds
 * the positive marker only as forward-looking provenance.
 */
export const TRANSPORT_AUTHORIZED_SCOPE = "queue_run_scoped_canary";

/**
 * Enqueue authorizations carry an EMPTY queue_row_ids list, so they must never
 * satisfy a row-scoped check by comparing empty against empty. This is the one
 * scope that is genuinely disqualifying.
 */
export const ENQUEUE_SCOPE = "campaign_enqueue_target_one";

/** Is this authorization scope permitted to reach transport? */
export function scopeMayReachTransport(scope) {
  const value = clean(scope);
  if (value === ENQUEUE_SCOPE) return false;
  return value === "" || value === TRANSPORT_AUTHORIZED_SCOPE || value === "queue_dispatch";
}

/**
 * Can a transport authority be issued from this authorization AT ALL?
 *
 * Callable BEFORE the row is claimed. The claim transaction consumes the
 * authorization, so discovering a mis-issued one afterwards costs an operator
 * their single-use grant and leaves the queue row failed. Checking first turns
 * that into a clean, retryable refusal.
 */
export function assertTransportAuthorityIssuable({
  canary_leg,
  authorization_scope,
  manifest_size = null,
} = {}) {
  if (!scopeMayReachTransport(authorization_scope)) {
    return { ok: false, reason: "authorization_scope_cannot_reach_transport" };
  }
  if (!clean(canary_leg)) {
    return { ok: false, reason: "authorization_missing_canary_leg" };
  }
  // SINGLE ROW, ALWAYS. Two independent reasons, either sufficient:
  //
  //   Safety. Crossing an ACTIVE global emergency stop is the most dangerous
  //   thing this system can do. It may buy exactly one message, never a batch.
  //
  //   Honesty. `consumed_at` is set by the claim RPC only when the LAST row of
  //   a manifest is claimed, so on a multi-row manifest every earlier row would
  //   carry a null consumption proof and be refused, while the final row went
  //   through. That is a confusing, order-dependent half-behaviour. Refusing
  //   the whole shape is clearer than partially honouring it.
  if (manifest_size !== null && Number(manifest_size) !== 1) {
    return { ok: false, reason: "transport_exception_requires_single_row_manifest" };
  }
  return { ok: true };
}

/** Only this execution mode may reach transport under the exception. */
export const REQUIRED_EXECUTION_MODE = "scoped_canary_only";

/** Owner recorded on the global execution lock by a scoped canary run. */
const REQUIRED_LOCK_OWNER = "scoped_canary";

function hashToken(token) {
  return crypto.createHash("sha256").update(clean(token), "utf8").digest("hex");
}

/** Constant-time compare so a hash check cannot be probed byte by byte. */
function safeEqualHex(left, right) {
  const a = Buffer.from(clean(left), "utf8");
  const b = Buffer.from(clean(right), "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function jsonArray(value) {
  if (Array.isArray(value)) return value.map((v) => clean(v)).filter(Boolean);
  return [];
}

function refuse(reason, detail = {}) {
  return { ok: false, reason, authority_version: SCOPED_CANARY_TRANSPORT_AUTHORITY_VERSION, ...detail };
}

/**
 * Assemble the claims that a scoped-canary execution will present to transport.
 *
 * Returns null unless the execution genuinely holds all of them. A partially
 * populated authority is worse than none: it invites a verifier to "fill in"
 * what is missing.
 *
 * @param {object} facts
 * @param {boolean} facts.scoped_canary            this execution declared itself a canary
 * @param {string}  facts.authorization_id         durable authorization row id
 * @param {string}  facts.authorization_token      the operator-held secret, unhashed
 * @param {string}  facts.authorization_consumed_at  ONLY the claim RPC produces this
 * @param {string}  facts.canary_run_id
 * @param {string}  facts.canary_leg
 * @param {string}  facts.campaign_id
 * @param {string}  facts.queue_row_id
 * @param {string}  facts.queue_execution_mode     mode observed by the runner
 * @param {object}  facts.canonical_authority      verdict from evaluateCanonicalSendAuthority
 */
export function buildScopedCanaryTransportAuthority(facts = {}) {
  if (facts.scoped_canary !== true) return null;

  // `authorization_consumed_at` is the one field a caller cannot invent from
  // its own inputs: it comes back from the claim transaction. Without it there
  // is no proof the authorization was actually spent on this execution.
  const required = {
    authorization_id: clean(facts.authorization_id),
    authorization_token: clean(facts.authorization_token),
    authorization_consumed_at: clean(facts.authorization_consumed_at),
    canary_run_id: clean(facts.canary_run_id),
    canary_leg: clean(facts.canary_leg),
    campaign_id: clean(facts.campaign_id),
    queue_row_id: clean(facts.queue_row_id),
  };
  if (Object.values(required).some((value) => !value)) return null;

  return Object.freeze({
    version: SCOPED_CANARY_TRANSPORT_AUTHORITY_VERSION,
    ...required,
    queue_execution_mode: clean(facts.queue_execution_mode),
    // All three are stamped at BIND time, by the canonical seam, because none
    // of them exists when the runner claims the row. Unbound authority carries
    // no canonical verdict and can never satisfy the verifier.
    canonical_authority: null,
    canonical_authority_version: null,
    logical_communication_id: null,
    destination: null,
  });
}

/**
 * Bind an authority to the one communication and destination it may excuse.
 *
 * Binding is separate from construction because the logical communication does
 * not exist yet when the runner claims the row: the canonical seam establishes
 * it. Binding late, from the seam's own values, is what stops an authority
 * minted for one row from excusing a send to somebody else.
 */
export function bindScopedCanaryTransportAuthority(authority, binding = {}) {
  if (!authority || authority.version !== SCOPED_CANARY_TRANSPORT_AUTHORITY_VERSION) return null;
  const logical_communication_id = clean(binding.logical_communication_id);
  const destination = clean(binding.destination);
  const queue_row_id = clean(binding.queue_row_id);
  if (!logical_communication_id || !destination) return null;
  // A binding for a different row is a programming error, never a downgrade.
  if (queue_row_id && queue_row_id !== authority.queue_row_id) return null;

  // The canonical verdict is recorded by whoever actually obtained it, at the
  // moment it was obtained. Binding without one, or with a denial, yields no
  // authority: transport must never infer approval that nothing granted.
  const canonical = binding.canonical_authority || null;
  if (!canonical || canonical.ok !== true) return null;

  return Object.freeze({
    ...authority,
    logical_communication_id,
    destination,
    canonical_authority: clean(canonical.authority),
    canonical_authority_version: clean(canonical.authority_version),
  });
}

/**
 * Verify a bound authority against durable state.
 *
 * @param {object} authority  the bound claims
 * Every read goes through the SAME client, straight to the tables, with no
 * value cache in front of it. The 30-second system-control cache is deliberately
 * bypassed: an operator who moves the execution mode back must close transport
 * on the next send, not half a minute later.
 *
 * @param {object} context
 * @param {string} context.to                 destination of the message about to be sent
 * @param {string} context.logical_communication_id
 * @param {object} context.supabase           REQUIRED. No client, no exception.
 * @returns {Promise<{ok:boolean, reason:string, evidence?:object}>} never throws
 */
export async function verifyScopedCanaryTransportAuthority(authority, context = {}) {
  if (!authority || authority.version !== SCOPED_CANARY_TRANSPORT_AUTHORITY_VERSION) {
    return refuse("transport_authority_absent");
  }

  // ── 1. every claim must be present ───────────────────────────────────────
  const claims = [
    "authorization_id", "authorization_token", "authorization_consumed_at",
    "canary_run_id", "canary_leg", "campaign_id", "queue_row_id",
    "logical_communication_id", "destination",
  ];
  for (const field of claims) {
    if (!clean(authority[field])) return refuse("transport_authority_incomplete", { field });
  }

  // ── 2. the canonical authority must already have approved ────────────────
  if (authority.canonical_authority !== "scoped_canary_authorization") {
    return refuse("transport_authority_not_canonically_approved");
  }

  // ── 3. it must be bound to THIS message ──────────────────────────────────
  // Checked before any database work: a mismatch here means the authority
  // belongs to a different send, and no amount of durable evidence fixes that.
  if (clean(context.to) !== authority.destination) {
    return refuse("transport_authority_destination_mismatch");
  }
  if (clean(context.logical_communication_id) !== authority.logical_communication_id) {
    return refuse("transport_authority_logical_mismatch");
  }

  const supabase = context.supabase || null;
  if (!supabase) return refuse("transport_authority_unverifiable_no_client");

  // ── 4. the control plane must STILL say scoped_canary_only ───────────────
  let execution_mode = "";
  try {
    const { data, error } = await supabase
      .from("system_control")
      .select("value")
      .eq("key", "queue_execution_mode")
      .maybeSingle();
    if (error) return refuse("transport_authority_execution_mode_unreadable");
    execution_mode = clean(data?.value).toLowerCase();
  } catch {
    return refuse("transport_authority_execution_mode_unreadable");
  }
  // An absent or unreadable mode is not permission. Only the exact string is.
  if (execution_mode !== REQUIRED_EXECUTION_MODE) {
    return refuse("transport_authority_execution_mode_not_scoped_canary_only", { execution_mode });
  }

  // ── 5. the durable authorization row is the real authority ───────────────
  let row = null;
  try {
    const { data, error } = await supabase
      .from("queue_canary_authorizations")
      .select("id,canary_run_id,campaign_id,queue_row_ids,claimed_row_ids,authorization_token_hash,consumed_at,metadata")
      .eq("canary_run_id", authority.canary_run_id)
      .maybeSingle();
    if (error) return refuse("transport_authority_read_failed");
    row = data || null;
  } catch {
    return refuse("transport_authority_read_failed");
  }
  if (!row) return refuse("transport_authority_authorization_not_found");

  if (clean(row.id) !== authority.authorization_id) {
    return refuse("transport_authority_authorization_id_mismatch");
  }
  if (clean(row.campaign_id) !== authority.campaign_id) {
    return refuse("transport_authority_campaign_mismatch");
  }
  if (!scopeMayReachTransport(row?.metadata?.scope)) {
    return refuse("transport_authority_wrong_scope");
  }
  if (clean(row?.metadata?.canary_leg) !== authority.canary_leg) {
    return refuse("transport_authority_canary_leg_mismatch");
  }
  // Possession of the operator secret, not merely knowledge of the run id.
  if (!safeEqualHex(hashToken(authority.authorization_token), clean(row.authorization_token_hash))) {
    return refuse("transport_authority_token_invalid");
  }

  // ── 6. single use, and already spent BY THIS EXECUTION ───────────────────
  // An unconsumed authorization means the claim never happened, so nothing
  // proves this send was the authorized one. A consumed_at that disagrees with
  // the value this execution received means a DIFFERENT execution spent it.
  const consumed_at = clean(row.consumed_at);
  if (!consumed_at) return refuse("transport_authority_not_consumed");
  if (Date.parse(consumed_at) !== Date.parse(authority.authorization_consumed_at)) {
    return refuse("transport_authority_consumed_by_other_execution");
  }

  // ── 7. this exact row was authorized AND claimed under it ────────────────
  const authorized_ids = jsonArray(row.queue_row_ids);
  if (!authorized_ids.length) return refuse("transport_authority_no_rows_authorized");
  // See assertTransportAuthorityIssuable: one authorization, one message.
  if (authorized_ids.length !== 1) {
    return refuse("transport_authority_multi_row_manifest");
  }
  if (!authorized_ids.includes(authority.queue_row_id)) {
    return refuse("transport_authority_row_not_allowlisted");
  }
  if (!jsonArray(row.claimed_row_ids).includes(authority.queue_row_id)) {
    return refuse("transport_authority_row_not_claimed");
  }

  // ── 8. the scoped-canary execution lock must still be held for this run ──
  let lock = null;
  try {
    const { data, error } = await supabase
      .from("queue_global_execution_lock")
      .select("owner_type,canary_run_id")
      .eq("id", 1)
      .maybeSingle();
    if (error) return refuse("transport_authority_lock_unreadable");
    lock = data || null;
  } catch {
    return refuse("transport_authority_lock_unreadable");
  }
  if (!lock) return refuse("transport_authority_lock_absent");
  if (clean(lock.owner_type) !== REQUIRED_LOCK_OWNER) {
    return refuse("transport_authority_lock_not_scoped_canary");
  }
  if (clean(lock.canary_run_id) !== authority.canary_run_id) {
    return refuse("transport_authority_lock_run_mismatch");
  }

  return {
    ok: true,
    reason: "scoped_canary_transport_authorized",
    authority_version: SCOPED_CANARY_TRANSPORT_AUTHORITY_VERSION,
    // Evidence for the audit trail. No token, no phone number, no secret.
    evidence: {
      authorization_id: authority.authorization_id,
      canary_run_id: authority.canary_run_id,
      canary_leg: authority.canary_leg,
      queue_row_id: authority.queue_row_id,
      logical_communication_id: authority.logical_communication_id,
      authorization_consumed_at: consumed_at,
      queue_execution_mode: execution_mode,
    },
  };
}

export default verifyScopedCanaryTransportAuthority;
