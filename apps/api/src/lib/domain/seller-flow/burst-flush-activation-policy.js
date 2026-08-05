// ─── burst-flush-activation-policy.js ────────────────────────────────────────
// Pure activation authority for the seller-inbound burst FLUSH worker.
//
// WHY THIS EXISTS
// The flush worker built its coordinator with a hardcoded `enabled: true`,
// which reaches isSellerInboundBurstEnabled({enabled}) →
// `if (enabled != null) return Boolean(enabled)` and short-circuits ALL mode
// resolution. The worker was therefore globally live regardless of
// SELLER_INBOUND_BURST_ENABLED. This module is the replacement authority, and
// it deliberately exposes NO boolean override parameter anywhere: the defect is
// not merely fixed, it is unrepresentable in this API.
//
// WHAT IT DECIDES
//   disabled       → no scan, no claim, no ledger/thread mutation.
//   enabled        → existing global behaviour, unchanged.
//   internal_proof → at most bursts durably attributable to the ONE currently
//                    active proof session. Never a global fallback.
//   anything else  → disabled (fail-closed).
//
// ── DURABLE ASSOCIATION: there is no session_id column ──────────────────────
// public.seller_inbound_bursts has NO session-linking column of any kind.
// Association is therefore a conjunction over columns that already exist and
// that inbound traffic cannot forge. A burst belongs to the ACTIVE session iff:
//
//   1. normalizeE164(burst.thread_key) === session.recipient. session.recipient
//      is code-pinned by INTERNAL_PROOF_PINNED to exactly one number, so this
//      is one exact string compare — not a phone-family or registry rule.
//      Registry membership is explicitly NOT sufficient: the other registered
//      internal numbers are denied.
//   2. session.created_at <= burst.first_received_at <= session.expires_at.
//   3. session.created_at <= burst.created_at     <= session.expires_at.
//      This is the anti-backdating leg. first_received_at derives from
//      provider/ingress data; created_at is now() at INSERT (NOT NULL DEFAULT
//      now()) and is not attacker-influenced. A replayed or backdated
//      first_received_at cannot drag an old row into the window alone.
//   4. burst.created_at present and parseable — absent ⇒ DENY.
//
// Both temporal bounds come from the ACTIVE session object, never from "a
// session". That distinction is the whole discriminator. The preserved
// 2026-08-03 incident burst (first_received_at 22:40:31Z) sits INSIDE the old
// 22:37:12Z→23:09:22Z window, so a naive "inside some session window" rule
// ADMITS it. Under this policy it is denied in every reachable state: no
// session → denied; the old session → unloadable (expired); a session opened
// today → its window starts today, so legs 2 and 3 both fail.
//
// ── closed_at: a gap in the EXISTING session contract ───────────────────────
// parseInternalProofSession never reads closed_at, and
// loadActiveInternalProofSession strips it from the returned object. Verified:
// a session with closed_at 22:40Z and expires_at 23:09Z evaluated at 22:50Z
// parses ok:true — ACTIVE despite having been closed. Closing a proof session
// early does not deactivate it; only wall-clock expiry does.
//
// This module layers the check on top of the shared parser rather than editing
// it, because that parser is also the authority for the outbound-dispatch
// contact-window bypass and changing it would alter behaviour for that caller.
// A parseable closed_at <= now is terminal; an unparseable closed_at fails
// closed. The underlying gap is tracked as a separate follow-up.
//
// ── RULING: the scoped_canary_only coupling is NOT inherited ────────────────
// evaluateInternalProofContactWindowBypass additionally requires
// queue_execution_mode === "scoped_canary_only". This module deliberately does
// not:
//   1. That coupling authorizes an OUTBOUND SEND past the contact window inside
//      a validated scoped-canary dispatch (it also demands scoped_canary,
//      authorization_validated, canary_run_id, max_rows === 1). A flush is not
//      a dispatch and carries none of that context.
//   2. Production is `paused`. Inheriting it would make internal_proof
//      permanently inert — a mode advertising itself as the activation path
//      while being dead code. An honest narrow gate beats a gate that silently
//      never fires.
//   3. Containment is NOT weakened: finalizing a burst QUEUES a row; whether it
//      leaves the building is still gated by queue_execution_mode, which stays
//      paused. Declining the coupling creates no send path.

import {
  INTERNAL_PROOF_SESSION_KEY,
  parseInternalProofSession,
} from "@/lib/domain/queue/internal-proof-session.js";
import { resolveSellerInboundBurstMode } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";

export const BURST_FLUSH_ACTIVATION_MODES = Object.freeze({
  DISABLED: "disabled",
  ENABLED: "enabled",
  INTERNAL_PROOF: "internal_proof",
});

export const BURST_FLUSH_ACTIVATION_SCOPES = Object.freeze({
  NONE: "none",
  GLOBAL: "global",
  THREAD: "thread",
});

/**
 * Canonical outcome vocabulary. Callers must emit exactly one of these per
 * invocation; do not invent parallel strings.
 *
 * Session-resolution failures additionally pass through verbatim from
 * parseInternalProofSession (session_not_configured, session_invalid_json,
 * session_expired, session_recipient_not_pinned, session_exceeds_max_length,
 * …). Those are that module's vocabulary and are surfaced unchanged so an
 * operator sees the real cause.
 */
export const BURST_FLUSH_ACTIVATION_REASONS = Object.freeze({
  // Policy resolution
  DISABLED_NOOP: "disabled_noop",
  GLOBAL_ACTIVATION: "global_activation",
  INTERNAL_PROOF_SESSION_ACTIVE: "internal_proof_session_active",
  SESSION_CLOSED: "session_closed",
  SESSION_CLOSED_AT_INVALID: "session_closed_at_invalid",
  RESOLUTION_FAILED: "activation_policy_resolution_failed",
  // Per-burst admission
  ADMITTED: "admitted",
  NOT_ACTIVATED: "not_activated",
  MISSING_BURST: "missing_burst",
  POLICY_BOUNDS_INVALID: "policy_bounds_invalid",
  THREAD_KEY_MISSING: "thread_key_missing",
  THREAD_KEY_NOT_ALLOWED: "thread_key_not_allowed",
  BURST_FIRST_RECEIVED_AT_INVALID: "burst_first_received_at_invalid",
  BURST_CREATED_AT_MISSING: "burst_created_at_missing",
  BURST_CREATED_AT_INVALID: "burst_created_at_invalid",
  BURST_RECEIVED_BEFORE_SESSION: "burst_received_before_session",
  BURST_RECEIVED_AFTER_SESSION: "burst_received_after_session",
  BURST_CREATED_BEFORE_SESSION: "burst_created_before_session",
  BURST_CREATED_AFTER_SESSION: "burst_created_after_session",
});

const REASONS = BURST_FLUSH_ACTIVATION_REASONS;
const MODES = BURST_FLUSH_ACTIVATION_MODES;
const SCOPES = BURST_FLUSH_ACTIVATION_SCOPES;

function clean(value) {
  return String(value ?? "").trim();
}

function toTimestamp(value) {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

// Mirrors normalizeE164 in internal-proof-session.js, which does not export it.
// Kept byte-identical in behaviour so the thread compare cannot drift from the
// normalization the session parser applied to session.recipient.
function normalizeE164(value) {
  const raw = clean(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? raw : null;
}

/**
 * FATAL vs QUIET.
 *
 * The rule is: `alertable` means THE RESOLVER COULD NOT DETERMINE THE ANSWER —
 * the session lookup threw, the parser threw, or mode resolution threw.
 * `alertable:false` means the resolver DID determine the answer and the answer is
 * "no": mode_disabled, session_not_configured, session_expired,
 * session_recipient_not_pinned, session_closed, and every other parse
 * rejection. Those are legitimate quiet states.
 *
 * This distinction is load-bearing, not cosmetic. A Supabase read error that
 * rendered as "the operator hasn't started a session" would produce a cron
 * reporting a clean idle tick forever while the subsystem was down — the exact
 * signature of the 2026-08-03 incident, where a worker that never ran also
 * reported nothing. alertable:true callers must return 503 and alert once;
 * alertable:false callers return 200 and stay silent.
 *
 * Stating it as "could the resolver answer?" rather than enumerating strings
 * means reasons nobody has written yet classify correctly by construction.
 */
function deniedPolicy(mode, reason, { alertable = false } = {}) {
  return {
    mode,
    may_scan: false,
    may_claim: false,
    scope: SCOPES.NONE,
    allowed_thread_key: null,
    proof_session_id: null,
    received_not_before: null,
    received_not_after: null,
    created_not_before: null,
    reason,
    alertable,
  };
}

/**
 * The raw system_control value may be a JSON string or an already-parsed
 * object. parseInternalProofSession discards closed_at, so we re-read it from
 * the raw payload. Returns null when the payload is not a usable object — the
 * parser will have failed on the same input, so the caller never reaches the
 * closed_at check with a null here.
 */
function rawSessionObject(session_raw) {
  let value = session_raw;
  if (typeof value === "string") {
    if (!clean(value)) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/**
 * PURE. Resolve the flush worker's activation authority.
 *
 * Deliberately accepts NO boolean `enabled` override — unknown keys are
 * ignored, so no caller can short-circuit mode resolution the way the old
 * coordinator gate allowed.
 *
 * @returns {{
 *   mode: string, may_scan: boolean, may_claim: boolean, scope: string,
 *   allowed_thread_key: string|null, proof_session_id: string|null,
 *   received_not_before: string|null, received_not_after: string|null,
 *   reason: string, alertable: boolean
 * }}
 *
 * CONTRACT: allowed_thread_key !== null ⇒ the scan MUST be scoped to that
 * thread. scope "thread" is never a licence to list globally and filter after.
 */
export function resolveBurstFlushActivationPolicy({
  mode = null,
  session_raw = null,
  now = new Date(),
  env = process.env,
  parseSession = parseInternalProofSession,
  resolveMode = resolveSellerInboundBurstMode,
} = {}) {
  let resolved_mode;
  try {
    resolved_mode = clean(mode) || resolveMode({ env });
  } catch (error) {
    return deniedPolicy(MODES.DISABLED, `${REASONS.RESOLUTION_FAILED}:${error?.message || "mode_resolution_failed"}`, {
      alertable: true,
    });
  }

  // Any value that is not exactly `enabled` or `internal_proof` is disabled.
  // Unknown never resolves to enabled.
  if (resolved_mode === MODES.ENABLED) {
    return {
      mode: MODES.ENABLED,
      may_scan: true,
      may_claim: true,
      scope: SCOPES.GLOBAL,
      allowed_thread_key: null,
      proof_session_id: null,
      received_not_before: null,
      received_not_after: null,
      created_not_before: null,
      reason: REASONS.GLOBAL_ACTIVATION,
      alertable: false,
    };
  }

  if (resolved_mode !== MODES.INTERNAL_PROOF) {
    return deniedPolicy(MODES.DISABLED, REASONS.DISABLED_NOOP);
  }

  try {
    const now_ts = toTimestamp(now) ?? Date.now();
    const parsed = parseSession(session_raw, now);
    if (!parsed?.ok) {
      return deniedPolicy(MODES.INTERNAL_PROOF, parsed?.reason || "session_not_active");
    }
    const session = parsed.session;

    // closed_at is not part of the shared parser's contract — layered here.
    const raw_object = rawSessionObject(session_raw);
    const closed_at_raw = raw_object ? raw_object.closed_at : null;
    if (closed_at_raw != null && clean(closed_at_raw) !== "") {
      const closed_ts = toTimestamp(closed_at_raw);
      if (closed_ts === null) {
        return deniedPolicy(MODES.INTERNAL_PROOF, REASONS.SESSION_CLOSED_AT_INVALID);
      }
      if (closed_ts <= now_ts) {
        return deniedPolicy(MODES.INTERNAL_PROOF, REASONS.SESSION_CLOSED);
      }
    }

    return {
      mode: MODES.INTERNAL_PROOF,
      may_scan: true,
      may_claim: true,
      scope: SCOPES.THREAD,
      allowed_thread_key: session.recipient,
      proof_session_id: session.session_id,
      received_not_before: session.created_at,
      received_not_after: session.expires_at,
      // Separate floor for the ROW's insert instant. Flooring on
      // first_received_at alone lets a backfilled row carry an in-window
      // message time while the row itself predates the session.
      created_not_before: session.created_at,
      reason: REASONS.INTERNAL_PROOF_SESSION_ACTIVE,
      alertable: false,
    };
  } catch (error) {
    return deniedPolicy(
      MODES.INTERNAL_PROOF,
      `${REASONS.RESOLUTION_FAILED}:${error?.message || "unknown_error"}`,
      { alertable: true }
    );
  }
}

/**
 * Project a resolved policy into the ratified scope descriptor.
 *
 * `ok`      — the resolver reached an answer (i.e. !alertable).
 * `allowed` — activation was granted (may_scan && may_claim).
 *
 * `max_created_at` is a deliberate SUPERSET field beyond the ratified shape.
 * Every ratified field is present verbatim; this one additionally carries the
 * upper created_at bound so the anti-backdating leg survives. Dropping it
 * would admit a row whose first_received_at is inside the window but which was
 * INSERTED long after — a replayed artifact. Consumers that ignore the field
 * still get identical behaviour, because isBurstWithinFlushScope is the single
 * rule everyone calls.
 */
export function toBurstFlushScopeDescriptor(policy = null) {
  const p = policy && typeof policy === "object" ? policy : null;
  const kind = p?.scope || SCOPES.NONE;
  const thread_keys =
    kind === SCOPES.THREAD && p?.allowed_thread_key ? [p.allowed_thread_key] : [];
  return {
    // ONE SOURCE, ONE ALIAS. `alertable` is the resolver's field and the
    // source of truth; the descriptor re-exposes it under the name `fatal`
    // because that reads better at the consumer. There is deliberately no
    // second flag on the policy itself — two booleans meaning the same thing
    // is exactly how a 503 path goes quietly dead.
    //
    // Read this pair together: if `fatal` ever stops tracking `alertable`, a
    // resolution failure renders as {ok:true, fatal:false} and the handler
    // returns a silent 200 on a subsystem outage. Pinned by test.
    ok: p ? p.alertable !== true : false,
    mode: p?.mode || MODES.DISABLED,
    allowed: Boolean(p?.may_scan && p?.may_claim),
    fatal: Boolean(p?.alertable),
    reason: p?.reason || REASONS.DISABLED_NOOP,
    scope: {
      kind,
      thread_keys,
      // No grace window: the floor is the session's own created_at.
      min_first_received_at: p?.received_not_before ?? null,
      max_first_received_at: p?.received_not_after ?? null,
      // Row-insert floor, distinct from the message-time floor. Falls back to
      // received_not_before when a caller predates the field.
      min_created_at: p?.created_not_before ?? p?.received_not_before ?? null,
      max_created_at: p?.received_not_after ?? null,
      session_id: p?.proof_session_id ?? null,
      session_created_at: p?.received_not_before ?? null,
      session_expires_at: p?.received_not_after ?? null,
    },
  };
}

/**
 * THE ONE RULE. Every layer — store filter, coordinator, handler re-check —
 * calls this. Three copies of this logic would be three rules that drift, and
 * the first divergence is a burst admitted by one layer and denied by another.
 *
 * Returns { within, reason } so both façades below can share it.
 * Denies on any missing or unparseable field.
 */
function evaluateBurstScope(burst, scope) {
  if (!scope || typeof scope !== "object") {
    return { within: false, reason: REASONS.POLICY_BOUNDS_INVALID };
  }
  if (!burst || typeof burst !== "object") {
    return { within: false, reason: REASONS.MISSING_BURST };
  }

  // Global activation — existing behaviour, unchanged.
  if (scope.kind === SCOPES.GLOBAL) {
    return { within: true, reason: REASONS.ADMITTED };
  }
  if (scope.kind !== SCOPES.THREAD) {
    return { within: false, reason: REASONS.NOT_ACTIVATED };
  }

  const allowed = (Array.isArray(scope.thread_keys) ? scope.thread_keys : [])
    .map((key) => normalizeE164(key))
    .filter(Boolean);
  const min_first = toTimestamp(scope.min_first_received_at);
  const max_first = toTimestamp(scope.max_first_received_at);
  const min_created = toTimestamp(scope.min_created_at);
  // Superset field: absent ⇒ fall back to the session expiry, never unbounded.
  const max_created = toTimestamp(scope.max_created_at ?? scope.session_expires_at);
  if (
    allowed.length === 0 ||
    min_first === null ||
    max_first === null ||
    min_created === null ||
    max_created === null ||
    max_first < min_first
  ) {
    return { within: false, reason: REASONS.POLICY_BOUNDS_INVALID };
  }

  const thread_key = normalizeE164(burst.thread_key);
  if (!thread_key) return { within: false, reason: REASONS.THREAD_KEY_MISSING };
  if (!allowed.includes(thread_key)) {
    return { within: false, reason: REASONS.THREAD_KEY_NOT_ALLOWED };
  }

  const first_received_ts = toTimestamp(burst.first_received_at);
  if (first_received_ts === null) {
    return { within: false, reason: REASONS.BURST_FIRST_RECEIVED_AT_INVALID };
  }
  if (burst.created_at == null || clean(burst.created_at) === "") {
    return { within: false, reason: REASONS.BURST_CREATED_AT_MISSING };
  }
  const created_ts = toTimestamp(burst.created_at);
  if (created_ts === null) {
    return { within: false, reason: REASONS.BURST_CREATED_AT_INVALID };
  }

  // Bounds are inclusive at both ends.
  if (first_received_ts < min_first) {
    return { within: false, reason: REASONS.BURST_RECEIVED_BEFORE_SESSION };
  }
  if (first_received_ts > max_first) {
    return { within: false, reason: REASONS.BURST_RECEIVED_AFTER_SESSION };
  }
  if (created_ts < min_created) {
    return { within: false, reason: REASONS.BURST_CREATED_BEFORE_SESSION };
  }
  if (created_ts > max_created) {
    return { within: false, reason: REASONS.BURST_CREATED_AFTER_SESSION };
  }
  return { within: true, reason: REASONS.ADMITTED };
}

/**
 * PURE, SHARED. The scope predicate for the store filter, the coordinator and
 * the handler re-check. One export, three importers — do not reimplement it
 * locally.
 *
 * @param {{ burst: object, scope: object }} args — `scope` is the inner
 *        `.scope` of a toBurstFlushScopeDescriptor() result.
 * @returns {boolean}
 */
export function isBurstWithinFlushScope({ burst = null, scope = null } = {}) {
  return evaluateBurstScope(burst, scope).within === true;
}

/**
 * PURE. Is this specific burst admitted for claim under the resolved policy?
 * Implemented ON TOP of the shared predicate, so admission and scope filtering
 * are the same rule by construction rather than by convention.
 *
 * Fails closed on every ambiguity. Never widens to a phone-only gate.
 *
 * @returns {{ admitted: boolean, reason: string, policy_reason?: string|null,
 *             proof_session_id?: string|null }}
 */
export function isBurstAdmittedByActivationPolicy({ policy = null, burst = null } = {}) {
  if (!policy || typeof policy !== "object" || policy.may_claim !== true) {
    return {
      admitted: false,
      reason: REASONS.NOT_ACTIVATED,
      policy_reason: policy?.reason ?? null,
    };
  }
  const descriptor = toBurstFlushScopeDescriptor(policy);
  const verdict = evaluateBurstScope(burst, descriptor.scope);
  if (!verdict.within) {
    return { admitted: false, reason: verdict.reason };
  }
  return {
    admitted: true,
    reason: REASONS.ADMITTED,
    proof_session_id: descriptor.scope.session_id,
  };
}

/**
 * Cache-bypassing raw read of the session value. No fallback to the cached
 * module-level getSystemValue: a ~30s stale read is too stale for an
 * activation predicate, and an operator revocation must be seen on the next
 * scan. Neither source supplied ⇒ throw ⇒ the caller fails closed.
 */
async function readRawProofSession({ getSystemValue = null, supabase = null } = {}) {
  if (typeof getSystemValue === "function") {
    return getSystemValue(INTERNAL_PROOF_SESSION_KEY);
  }
  if (supabase) {
    const { data, error } = await supabase
      .from("system_control")
      .select("value")
      .eq("key", INTERNAL_PROOF_SESSION_KEY)
      .maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  }
  throw new Error("session_source_unavailable");
}

/**
 * Thin async wrapper: resolve mode, load the raw session only when the mode
 * actually needs it, then delegate to the pure resolver.
 *
 * Any throw — mode resolution, session lookup, parse — yields a disabled-shaped
 * result with alertable:true. NEVER a global fallback.
 */
export async function loadBurstFlushActivationPolicy({
  env = process.env,
  now = new Date(),
  getSystemValue = null,
  supabase = null,
  resolveMode = resolveSellerInboundBurstMode,
  parseSession = parseInternalProofSession,
} = {}) {
  let mode;
  try {
    mode = resolveMode({ env });
  } catch (error) {
    return deniedPolicy(
      MODES.DISABLED,
      `${REASONS.RESOLUTION_FAILED}:${error?.message || "mode_resolution_failed"}`,
      { alertable: true }
    );
  }

  if (mode !== MODES.INTERNAL_PROOF) {
    return resolveBurstFlushActivationPolicy({ mode, session_raw: null, now, env, parseSession });
  }

  let session_raw = null;
  try {
    session_raw = await readRawProofSession({ getSystemValue, supabase });
  } catch (error) {
    // FATAL. This must never render as "the operator hasn't started a session":
    // a Supabase read error that collapsed into session_not_configured would
    // produce a cron reporting clean idle ticks forever while the subsystem was
    // down — the 2026-08-03 signature. Caller returns 503 + one alert.
    return {
      ...deniedPolicy(
        MODES.INTERNAL_PROOF,
        `${REASONS.RESOLUTION_FAILED}:${error?.message || "session_lookup_failed"}`,
        { alertable: true }
      ),
      error_message: error?.message || "session_lookup_failed",
    };
  }

  return resolveBurstFlushActivationPolicy({ mode, session_raw, now, env, parseSession });
}

export default {
  BURST_FLUSH_ACTIVATION_MODES,
  BURST_FLUSH_ACTIVATION_SCOPES,
  BURST_FLUSH_ACTIVATION_REASONS,
  resolveBurstFlushActivationPolicy,
  toBurstFlushScopeDescriptor,
  isBurstWithinFlushScope,
  isBurstAdmittedByActivationPolicy,
  loadBurstFlushActivationPolicy,
};
