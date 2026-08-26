// Shared authenticated handler for the seller inbound burst flush worker.
//
// Vercel Cron invokes scheduled paths with GET. This route previously exported
// POST alone, so the scheduled worker never entered the handler and eligible
// non-safety bursts stayed open indefinitely (production incident 2026-08-03:
// burst sib:+16128072000:g1:ba199924 sat open with attempt_count=0). GET and
// POST now run this identical function; the method only selects the auth
// contract's entry order and whether a JSON body is read.
//
// ── ACTIVATION AUTHORITY ────────────────────────────────────────────────────
// This handler previously built its coordinator with a hardcoded
// `enabled: true`, which reached isSellerInboundBurstEnabled({enabled}) →
// `if (enabled != null) return Boolean(enabled)` and short-circuited ALL mode
// resolution: the worker was globally live regardless of
// SELLER_INBOUND_BURST_ENABLED, and flushEligible() never consulted a gate at
// all. That hardcode is gone and is NOT replaced by another boolean — this
// handler passes no `enabled` whatsoever, so the defect is unrepresentable at
// this call site the same way it is unrepresentable in the policy API.
//
// The handler's job in the layered defence is narrow and specific: it is the
// AUTHORITY-GRANTING layer for the cron/POST leg. It resolves the activation
// policy and hands it down. The coordinator translates policy → scope and the
// store enforces that scope deny-by-default; neither can distinguish a correct
// grant from a well-formed wrong one, which is why resolution correctness lives
// here. It does NOT protect the ingest leg (onPersistedInbound's rollover and
// safety-latch finalize never traverse this file).
//
// Dependencies are injectable (same idiom as queue-run-request.js) so the cron
// GET path can be exercised end-to-end in tests without live Supabase.

import crypto from "node:crypto";

/**
 * Canonical per-invocation outcome vocabulary. Exactly ONE is emitted per
 * authenticated invocation.
 *
 * BOUNDARY: outcomes describe AUTHENTICATED invocations. A 401 is a rejection
 * at the door — the request never became an invocation of the flush — and so
 * carries no outcome, preserving the pre-existing `{ok:false, reason:
 * "unauthorized"}` body. An authenticated caller that fails an infrastructure
 * precondition DID invoke the worker, so it gets `precondition_failed`.
 */
export const BURST_FLUSH_OUTCOMES = Object.freeze({
  DISABLED_NOOP: "disabled_noop",
  INTERNAL_PROOF_NO_ACTIVE_SESSION: "internal_proof_no_active_session",
  INTERNAL_PROOF_NO_AUTHORIZED_BURSTS: "internal_proof_no_authorized_bursts",
  INTERNAL_PROOF_FLUSHED: "internal_proof_flushed",
  ENABLED_FLUSHED: "enabled_flushed",
  ENABLED_NO_WORK: "enabled_no_work",
  PROOF_SCOPE_RESOLUTION_FAILED: "proof_scope_resolution_failed",
  PRECONDITION_FAILED: "precondition_failed",
  FLUSH_FAILED: "flush_failed",
});

const OUTCOMES = BURST_FLUSH_OUTCOMES;

/** Every value in the vocabulary, for the one-outcome invariant assertion. */
export const BURST_FLUSH_OUTCOME_VALUES = Object.freeze(Object.values(BURST_FLUSH_OUTCOMES));

// ── Reason sanitization: the one field this pipeline does not author ────────
//
// `reason` reaches three sinks — the HTTP response (`failed_reasons`,
// `results[].reason`), the structured log, and the alert payload. On the
// coordinator's `process_error` path its value is
// `err.message` from inside processSellerInboundMessage, i.e. an exception
// message. Truncation bounds the LENGTH of that string; it does not bound its
// CONTENT, so it was a hole in the same redaction boundary that closed the
// `aggregated` echo.
//
// Proving the field safe would mean proving that no exception anywhere in the
// seller-inbound call graph — our code, Supabase, the AI SDK, V8 itself —
// interpolates message content. That is not provable, and the mechanism is
// real: V8's own JSON.parse echoes the first ten characters of its input
// (`JSON.parse("Yeah I want $150k")` → `Unexpected token 'Y', "Yeah I wan"...
// is not valid JSON`). natural-response-engine.js:353 parses raw LLM completion
// content exactly that way; today its caller catches and maps to a fixed
// `model_error` token, so it does not escape — but that containment is one
// `catch` block away from disappearing, and nothing test-enforces it.
//
// So the boundary is structural instead of audited. Every reason WE author is
// an identifier (`attempts_exhausted`, `burst_scope_unauthorized`,
// `coordinator_refused:burst_scope_unauthorized`). Free-form prose is, by
// construction, not ours. Identifier-shaped values pass through verbatim;
// anything else becomes a stable correlation digest that preserves
// "same error recurring" without carrying a single character of the text.
const SAFE_REASON_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json" },
  });
}

export function sanitizeReason(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (SAFE_REASON_PATTERN.test(text)) return text;
  // Unauthored. Correlatable, never readable.
  const digest = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `unauthored_error_redacted:${digest}`;
}

/**
 * Cron authorization first (Vercel sends `Authorization: Bearer $CRON_SECRET`),
 * then the pre-existing internal-secret contract. Neither branch is weaker than
 * what POST already enforced: requireCronAuth demands an exact CRON_SECRET
 * match, and requireInternalSecret accepts INTERNAL_API_SECRET / CRON_SECRET /
 * QUEUE_ENGINE_SHARED_SECRET. Anonymous callers are rejected on both methods.
 */
export function authorizeFlushRequest(request, { requireCronAuth, requireInternalSecret }) {
  const cron_auth = requireCronAuth(request);
  if (cron_auth.authorized && cron_auth.auth?.authenticated) {
    return {
      ok: true,
      caller_type: cron_auth.auth?.is_vercel_cron ? "vercel_cron" : "cron_secret",
    };
  }

  const internal_auth = requireInternalSecret(request);
  if (internal_auth.ok) {
    return { ok: true, caller_type: "internal_secret" };
  }

  return {
    ok: false,
    caller_type: "unauthorized",
    // requireInternalSecret contract: unauthorized → 401, missing config → 500.
    error: internal_auth.error || "unauthorized",
    status: internal_auth.status || 401,
  };
}

/**
 * Derives the operational counters from the coordinator's real result shape.
 * finalizeBurst returns { ok, reason, claim?, suppressed?, queued? }.
 */
export function summarizeFlushResults(results = []) {
  const all = Array.isArray(results) ? results.filter(Boolean) : [];
  // "no eligible burst" means there was nothing to work. It is not an eligible
  // burst, not a claim, and not a failure — counting it inflated eligible_count
  // and claimed_count on every idle scheduler tick.
  const list = all.filter((r) => r.reason !== "no_eligible_burst");
  // A failed claim means another worker won the race (or the burst stopped being
  // eligible). That is benign contention, not an operational failure — counting
  // it would alert on normal concurrency.
  //
  // The discriminator is `claim.ok === false`, not merely the presence of a
  // `claim` key. finalizeBurst attaches a SUCCESSFUL claim alongside ok:false on
  // the missing_process_seller_inbound path (coordinator: claim held, no
  // processor): keying on presence alone silently reclassified a genuine
  // failure — a burst claimed and then abandoned mid-flight — as benign
  // contention, so it was never counted and never alerted.
  const claim_failures = list.filter((r) => r.ok === false && r.claim?.ok === false);
  const failures = list.filter((r) => r.ok === false && r.claim?.ok !== false);
  return {
    eligible_count: list.length,
    claimed_count: list.length - claim_failures.length,
    completed_count: list.filter((r) => r.ok === true && !r.suppressed).length,
    queued_count: list.filter((r) => r.queued).length,
    suppressed_count: list.filter((r) => r.suppressed).length,
    failed_count: failures.length,
    failed_reasons: failures.map((r) => sanitizeReason(r.reason)).slice(0, 10),
    no_eligible_burst_count: all.length - list.length,
  };
}

/**
 * Redacted per-burst summary for the HTTP response.
 *
 * The handler previously echoed the coordinator's results verbatim. Those
 * objects carry `aggregated`, i.e. the seller's concatenated message text, so
 * every flush response shipped seller content to whoever called the endpoint.
 * Only operational identity and disposition leave this function.
 */
export function redactFlushResults(results = []) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  return list.map((r) => ({
    burst_id: r.burst?.burst_id || null,
    thread_key: r.burst?.thread_key || null,
    ok: r.ok === true,
    reason: sanitizeReason(r.reason) ?? null,
    suppressed: Boolean(r.suppressed),
    queued: Boolean(r.queued),
  }));
}

/**
 * A result carries a claimed burst iff finalizeBurst got past claimEligible.
 * On a failed claim the coordinator returns `{ok:false, reason, claim}` with no
 * top-level `burst`, so the presence of `burst.burst_id` is the exact
 * discriminator for "this row was actually claimed and mutated".
 */
export function claimedBurstsFromResults(results = []) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  return list.map((r) => r.burst).filter((b) => b && b.burst_id);
}

/**
 * POST-HOC ADMISSION AUDIT.
 *
 * DETECTION, NOT PREVENTION — by the time this runs the claim already happened.
 * Its value is twofold and neither is covered elsewhere:
 *
 *   1. It is the only executor of the activation policy's leg 3
 *      (session.created_at <= burst.created_at <= session.expires_at, the
 *      anti-backdating leg). The store's scope contract carries thread_keys and
 *      first_received_at bounds only — there is no created_at bound in it — so
 *      a burst whose first_received_at was replayed into the window but whose
 *      row is old passes the store and fails here.
 *   2. It sits downstream of the policy→scope translation, which is the one
 *      seam no other layer checks: a correct policy translated into a wrong
 *      scope is obeyed faithfully by the store.
 *
 * A violation is never swallowed: the run reports non-2xx and alerts.
 */
export function auditClaimedBurstAdmissions({ policy, results, isBurstAdmitted }) {
  if (typeof isBurstAdmitted !== "function") return [];
  const violations = [];
  for (const burst of claimedBurstsFromResults(results)) {
    let verdict;
    try {
      verdict = isBurstAdmitted({ policy, burst });
    } catch (error) {
      // An audit that throws must read as a violation, never as a pass.
      verdict = { admitted: false, reason: `audit_threw:${error?.message || "unknown_error"}` };
    }
    if (!verdict?.admitted) {
      violations.push({
        burst_id: burst.burst_id,
        thread_key: burst.thread_key || null,
        generation: burst.generation ?? null,
        admission_reason: sanitizeReason(verdict?.reason) || "not_admitted",
      });
    }
  }
  return violations;
}

/**
 * Is this policy a resolver FAULT (as opposed to a benign "no session open")?
 *
 * Deliberately tolerant of three signals rather than keyed on one field:
 *
 *   * `fatal` and `alertable` are both honoured because the policy module has
 *     carried each name in turn. This handler previously read only `alertable`;
 *     when that field was renamed it silently became `undefined` and a FATAL
 *     session-lookup failure rendered as a benign 200 no-session no-op — the
 *     precise collapse the discriminator exists to prevent.
 *   * the reason string is checked independently, so the semantics survive a
 *     rename of both flags.
 *
 * The union is the conservative direction: over-reporting a fault costs one
 * spurious page, under-reporting it costs a scheduled worker that reports clean
 * idle ticks forever while the subsystem is down. Those are not symmetric.
 */
export function isFatalActivationPolicy(policy) {
  if (!policy || typeof policy !== "object") return true;
  if (policy.fatal === true || policy.alertable === true) return true;
  const reason = String(policy.reason ?? "");
  return (
    reason.startsWith("activation_policy_resolution_failed") ||
    reason.startsWith("session_lookup_failed")
  );
}

/** Operator-supplied worker_id lands in claimed_by; bound its shape. */
function sanitizeWorkerId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return safe || null;
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(Math.floor(parsed), 100);
}

/**
 * Context resolution for the SCHEDULED flush.
 *
 * Extracted from the production coordinator so the temporal bound below is
 * directly assertable: the webhook path bounds outbound-pair selection by the
 * inbound receipt instant, and the flush must apply the SAME bound or an
 * outbound that left after the seller replied can be selected as the question
 * they answered.
 */
export async function resolveBurstFlushContext(
  args = {},
  { loadContextWithFallbackImpl, loadContextImpl } = {}
) {
  if (args.context) return args.context;
  if (!args.threadKey) return null;
  try {
    return await loadContextWithFallbackImpl({
      inbound_from: args.threadKey,
      inbound_to: args.inboundTo || null,
      inbound_received_at: args.inboundReceivedAt || null,
      create_brain_if_missing: false,
      loadContextImpl,
    });
  } catch {
    return null;
  }
}

export async function handleFlushInboundBurstsRequest(request, deps = {}) {
  const method = String(deps.method || request?.method || "POST").toUpperCase();
  const json_response = deps.jsonResponse || jsonResponse;

  const require_cron_auth =
    deps.requireCronAuth || (await import("@/lib/security/cron-auth.js")).requireCronAuth;
  const require_internal_secret =
    deps.requireInternalSecret ||
    (await import("@/lib/security/require-internal-secret.js")).requireInternalSecret;
  const logger = deps.logger || (await import("@/lib/logging/logger.js"));
  const alerts = deps.launchAlerts || (await import("@/lib/domain/alerts/launch-critical-alerts.js")).launchAlerts;

  const request_id =
    request?.headers?.get?.("x-vercel-id") ||
    request?.headers?.get?.("x-request-id") ||
    crypto.randomUUID();

  const auth = authorizeFlushRequest(request, {
    requireCronAuth: require_cron_auth,
    requireInternalSecret: require_internal_secret,
  });
  if (!auth.ok) {
    // No outcome: an unauthenticated request never became an invocation.
    logger.warn?.("seller_inbound_burst.flush_unauthorized", { method, request_id });
    return json_response({ ok: false, reason: auth.error }, { status: auth.status });
  }
  const log_base = { method, caller_type: auth.caller_type, request_id };

  // GET (the cron path) carries no body; only POST supplies flush parameters.
  // A GET that carries a body is ignored entirely — the scheduled caller cannot
  // widen its own scope by attaching one.
  let body = {};
  if (method !== "GET") {
    try {
      body = (await request.json()) || {};
    } catch {
      body = {};
    }
  }

  const now_ms = deps.now ? deps.now() : Date.now();
  const started_at = now_ms;

  const finish = ({ outcome, reason, status = 200, extra = {}, alert = null }) => {
    const payload = {
      ok: status >= 200 && status < 300,
      route: "internal/seller-flow/flush-inbound-bursts",
      method,
      caller_type: auth.caller_type,
      request_id,
      outcome,
      reason: reason ?? null,
      ...extra,
    };
    try {
      logger.info?.("seller_inbound_burst.flush_run", {
        ...log_base,
        outcome,
        reason: reason ?? null,
        duration_ms: (deps.now ? deps.now() : Date.now()) - started_at,
        ...extra,
      });
    } catch {
      /* logging must never fail the flush */
    }
    if (alert) {
      // Alerting is best-effort and must never mask the outcome it reports.
      try {
        const promise = alert();
        if (promise?.catch) promise.catch(() => {});
      } catch {
        /* ignore */
      }
    }
    return json_response(payload, { status });
  };

  // ── Infrastructure precondition ───────────────────────────────────────────
  // Deliberately NOT folded into proof_scope_resolution_failed: an absent
  // Supabase configuration and a faulted scope resolver are different pages of
  // the runbook, and overloading one name to keep a shorter vocabulary would
  // cost the operator the distinction at exactly the moment they need it.
  const has_supabase_config =
    deps.hasSupabaseConfig || (await import("@/lib/supabase/client.js")).hasSupabaseConfig;
  let supabase = deps.supabase || null;
  if (!supabase && !has_supabase_config()) {
    return finish({
      outcome: OUTCOMES.PRECONDITION_FAILED,
      reason: "missing_supabase",
      status: 503,
      alert: () => alerts?.burstFlushFailure?.({ ...log_base, reason: "missing_supabase" }),
    });
  }
  if (!supabase) {
    supabase =
      (await import("@/lib/supabase/default-client.js")).getDefaultSupabaseClient() || null;
  }
  if (!supabase) {
    return finish({
      outcome: OUTCOMES.PRECONDITION_FAILED,
      reason: "missing_supabase",
      status: 503,
      alert: () => alerts?.burstFlushFailure?.({ ...log_base, reason: "missing_supabase" }),
    });
  }

  // ── Activation authority ──────────────────────────────────────────────────
  const load_activation_policy =
    deps.loadActivationPolicy ||
    (await import("@/lib/domain/seller-flow/burst-flush-activation-policy.js"))
      .loadBurstFlushActivationPolicy;
  const is_burst_admitted =
    deps.isBurstAdmitted ||
    (await import("@/lib/domain/seller-flow/burst-flush-activation-policy.js"))
      .isBurstAdmittedByActivationPolicy;

  let policy;
  try {
    policy = await load_activation_policy({
      env: deps.env || process.env,
      now: new Date(now_ms),
      supabase,
      getSystemValue: deps.getSystemValue || null,
    });
  } catch (policy_error) {
    // loadBurstFlushActivationPolicy is itself fail-closed; this catches the
    // unforeseen. Either way there is NO fallback to global processing.
    policy = null;
    logger.warn?.("seller_inbound_burst.flush_policy_threw", {
      ...log_base,
      error_message: sanitizeReason(policy_error?.message) || "unknown_error",
    });
    return finish({
      outcome: OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED,
      reason: sanitizeReason(
        `activation_policy_resolution_failed:${policy_error?.message || "unknown_error"}`
      ),
      status: 503,
      alert: () =>
        alerts?.burstFlushFailure?.({
          ...log_base,
          reason: "activation_policy_resolution_failed",
          error_message: sanitizeReason(policy_error?.message) || "unknown_error",
        }),
    });
  }

  if (!policy || typeof policy !== "object") {
    return finish({
      outcome: OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED,
      reason: "activation_policy_resolution_failed:malformed_policy",
      status: 503,
      alert: () =>
        alerts?.burstFlushFailure?.({ ...log_base, reason: "activation_policy_malformed" }),
    });
  }

  const mode = policy.mode || "disabled";
  const proof_session_id =
    mode === "internal_proof" ? policy.proof_session_id || null : null;
  const mode_extra = { mode, proof_session_id };

  // A resolver FAULT (session lookup threw, mode resolution threw) is alertable
  // and non-2xx. A quiet "no session is open" is neither. Collapsing the two is
  // how a cron reports success while doing nothing — the shape of the original
  // incident — so the distinction is consumed from the policy's own
  // discriminator rather than re-derived here (see isFatalActivationPolicy for
  // why that read is deliberately tolerant).
  if (isFatalActivationPolicy(policy)) {
    return finish({
      outcome: OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED,
      reason: policy.reason || "activation_policy_resolution_failed",
      status: 503,
      extra: mode_extra,
      alert: () =>
        alerts?.burstFlushFailure?.({
          ...log_base,
          reason: policy.reason || "activation_policy_resolution_failed",
          mode,
        }),
    });
  }

  const zero_counts = {
    eligible_count: 0,
    claimed_count: 0,
    completed_count: 0,
    queued_count: 0,
    suppressed_count: 0,
    failed_count: 0,
    failed_reasons: [],
    no_eligible_burst_count: 0,
    out_of_scope_claimed: 0,
    flushed: 0,
    results: [],
  };

  // ── Not activated: zero work, zero store contact, no alert ────────────────
  if (policy.may_scan !== true || policy.may_claim !== true) {
    return finish({
      outcome:
        mode === "internal_proof"
          ? OUTCOMES.INTERNAL_PROOF_NO_ACTIVE_SESSION
          : OUTCOMES.DISABLED_NOOP,
      reason: policy.reason || "not_activated",
      extra: { ...mode_extra, ...zero_counts },
    });
  }

  // ── Operator parameter intersection ───────────────────────────────────────
  // CONTRACT (policy): allowed_thread_key !== null ⇒ the scan MUST be scoped to
  // that thread. An operator-supplied thread_key is therefore a filter WITHIN
  // the authorized scope, never a selector that reaches past it. A conflicting
  // pair is never forwarded to the coordinator at all.
  const requested_thread_key = String(body.thread_key ?? "").trim() || null;
  if (
    requested_thread_key &&
    policy.allowed_thread_key &&
    requested_thread_key !== policy.allowed_thread_key
  ) {
    return finish({
      outcome:
        mode === "internal_proof"
          ? OUTCOMES.INTERNAL_PROOF_NO_AUTHORIZED_BURSTS
          : OUTCOMES.ENABLED_NO_WORK,
      reason: "thread_key_not_allowed",
      extra: { ...mode_extra, ...zero_counts },
    });
  }
  const thread_key = policy.allowed_thread_key || requested_thread_key || null;
  const limit = clampLimit(body.limit);
  const worker_id = sanitizeWorkerId(body.worker_id);

  // The POLICY is handed down and the coordinator owns policy→scope translation
  // (activationScopeFromPolicy). This file builds no store filters — one
  // translation point, so the layers cannot speak two dialects of one rule.
  // The scope is bound at CONSTRUCTION, so there is no coordinator instance in
  // this process that holds an authority it was not granted.
  const build_coordinator = deps.buildCoordinator || buildProductionCoordinator;
  const coordinator =
    deps.coordinator || (await build_coordinator({ supabase, policy, worker_id, method }));

  let result;
  try {
    result = await coordinator.flushEligible({ thread_key, limit });
  } catch (flush_error) {
    // A crashing flush must be observable, not silent. The scheduler retries on
    // the next minute and expired claim leases are reclaimable, so a 500 here is
    // safe and makes the failure visible to cron monitoring.
    logger.warn?.("seller_inbound_burst.flush_threw", {
      ...log_base,
      error_message: sanitizeReason(flush_error?.message) || "unknown_error",
    });
    return finish({
      outcome: OUTCOMES.FLUSH_FAILED,
      reason: "seller_inbound_burst_flush_failed",
      status: 500,
      extra: mode_extra,
      alert: () =>
        alerts?.burstFlushFailure?.({
          ...log_base,
          error_message: sanitizeReason(flush_error?.message) || "unknown_error",
          thread_scoped: Boolean(thread_key),
        }),
    });
  }

  // AUTHORITY DISAGREEMENT. The handler resolved a policy that licensed this
  // run; the coordinator translated it and refused. Two layers now disagree
  // about the same policy, and the refusal arrives shaped exactly like an idle
  // tick (`results: []`). Reporting it as "no authorized bursts" would hide a
  // broken translation behind a green 200 forever — the incident's signature.
  if (result && result.ok === false) {
    const refusal = sanitizeReason(result.reason) || "coordinator_refused";
    logger.warn?.("seller_inbound_burst.flush_coordinator_refused", {
      ...log_base,
      mode,
      reason: refusal,
      scope_reason: sanitizeReason(result.scope_reason) || null,
    });
    return finish({
      outcome: OUTCOMES.PROOF_SCOPE_RESOLUTION_FAILED,
      reason: `coordinator_refused:${refusal}`,
      status: 503,
      extra: { ...mode_extra, ...zero_counts },
      alert: () =>
        alerts?.burstFlushFailure?.({
          ...log_base,
          reason: "coordinator_refused_authorized_policy",
          mode,
          coordinator_reason: refusal,
          scope_reason: sanitizeReason(result.scope_reason) || null,
        }),
    });
  }

  const counts = summarizeFlushResults(result?.results);
  const violations = auditClaimedBurstAdmissions({
    policy,
    results: result?.results,
    isBurstAdmitted: is_burst_admitted,
  });
  const redacted = redactFlushResults(result?.results);
  const payload_extra = {
    ...mode_extra,
    ...counts,
    out_of_scope_claimed: violations.length,
    flushed: redacted.length,
    results: redacted,
  };

  // A burst claimed outside the authority that licensed the run is the single
  // worst outcome available to this subsystem. It is loud, non-2xx, and alerted
  // on its own code — never folded into the ordinary failure counters.
  if (violations.length) {
    logger.warn?.("seller_inbound_burst.flush_scope_violation", {
      ...log_base,
      mode,
      proof_session_id,
      violations,
    });
    return finish({
      outcome: OUTCOMES.FLUSH_FAILED,
      reason: "burst_scope_violation_after_claim",
      status: 500,
      extra: { ...payload_extra, violations },
      alert: () =>
        alerts?.canaryScopeViolation?.({
          ...log_base,
          reason: "burst_scope_violation_after_claim",
          mode,
          proof_session_id,
          violations,
        }),
    });
  }

  if (counts.failed_count) {
    logger.warn?.("seller_inbound_burst.flush_failures", { ...log_base, ...counts });
    try {
      const promise = alerts?.burstFlushFailure?.({ ...log_base, ...counts });
      if (promise?.catch) promise.catch(() => {});
    } catch {
      /* alerting must never fail the flush */
    }
  }

  const worked = counts.claimed_count > 0;
  const outcome =
    mode === "internal_proof"
      ? worked
        ? OUTCOMES.INTERNAL_PROOF_FLUSHED
        : OUTCOMES.INTERNAL_PROOF_NO_AUTHORIZED_BURSTS
      : worked
        ? OUTCOMES.ENABLED_FLUSHED
        : OUTCOMES.ENABLED_NO_WORK;

  return finish({ outcome, reason: policy.reason || null, extra: payload_extra });
}

async function buildProductionCoordinator({ supabase, policy, worker_id, method }) {
  const { toBurstFlushScopeDescriptor } = await import(
    "@/lib/domain/seller-flow/burst-flush-activation-policy.js"
  );
  const [
    { createSellerInboundBurstCoordinator, activationScopeFromDescriptor },
    { processSellerInboundMessage },
    { cancelSupabasePendingOutbound, CANCELLATION_POLICIES },
    { cancelPendingFollowUpsForThread },
    { loadContextWithFallback },
    { loadContext },
    { getSystemValue },
  ] = await Promise.all([
    import("@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js"),
    import("@/lib/domain/seller-flow/process-seller-inbound-message.js"),
    import("@/lib/domain/queue/cancel-supabase-pending-outbound.js"),
    import("@/lib/domain/seller-flow/seller-followup-scheduler.js"),
    import("@/lib/domain/context/load-context-with-fallback.js"),
    import("@/lib/domain/context/load-context.js"),
    import("@/lib/system-control.js"),
  ]);

  const [{ finalizeBurstConstituentLedger }, { completeInboundProcessingClaim }, { launchAlerts }] =
    await Promise.all([
      import("@/lib/domain/seller-flow/finalize-burst-constituent-ledger.js"),
      import("@/lib/domain/inbound/inbound-processing-ledger.js"),
      import("@/lib/domain/alerts/launch-critical-alerts.js"),
    ]);

  async function processWithContext(args = {}) {
    const context = await resolveBurstFlushContext(args, {
      loadContextWithFallbackImpl: loadContextWithFallback,
      loadContextImpl: loadContext,
    });
    return processSellerInboundMessage({
      ...args,
      context: context || args.context || null,
      conversationBrain: args.conversationBrain || context?.items?.brain_item || null,
      propertyId: args.propertyId || context?.ids?.property_id || null,
      prospectId: args.prospectId || context?.ids?.prospect_id || null,
      ownerId: args.ownerId || context?.ids?.master_owner_id || null,
      phoneId: args.phoneId || context?.ids?.phone_item_id || null,
      getSystemValue: args.getSystemValue || getSystemValue,
      supabaseClient: args.supabaseClient || supabase,
    });
  }

  return createSellerInboundBurstCoordinator({
    supabase,
    processSellerInboundMessage: processWithContext,
    cancelPendingOutbound: async (args) =>
      cancelSupabasePendingOutbound(
        {
          thread_key: args.thread_key,
          to_phone_number: args.thread_key,
          reason: args.reason,
          inbound_event_id: args.inbound_event_id,
          cancelled_by: "seller_inbound_burst_flush",
          // Scope-correct policy: safety latches cancel everything; a benign
          // flush supersession cancels only automated reply/follow-up rows.
          // Omitting the policy fell through to the compliance default and
          // cancelled unrelated campaign touches.
          policy:
            args.policy === "compliance_terminal"
              ? CANCELLATION_POLICIES.COMPLIANCE_TERMINAL
              : CANCELLATION_POLICIES.INBOUND_TAKEOVER,
          inbound_received_at: args.inbound_received_at || null,
        },
        { supabase }
      ),
    cancelPendingFollowUps: async (args) =>
      cancelPendingFollowUpsForThread({
        thread_key: args.thread_key,
        reason: args.reason,
        inbound_event_id: args.inbound_event_id,
        supabase,
      }),
    worker_id: worker_id || `flush-inbound-bursts-${String(method).toLowerCase()}`,
    // NO `enabled` — deliberately absent, not set to false. Passing any boolean
    // here reaches isSellerInboundBurstEnabled's `enabled != null` short-circuit,
    // which is the exact mechanism of the defect this change removes. Activation
    // authority arrives as an explicit scope carrying the session window, and
    // it is bound at construction so no instance ever holds an ungranted
    // authority. A malformed scope coerces `authorized` to false and denies.
    //
    // toBurstFlushScopeDescriptor is the descriptor's single producer (policy
    // module); activationScopeFromDescriptor only attaches the authorization
    // flags. Going through both is what keeps one vocabulary end to end.
    activation_scope: activationScopeFromDescriptor(toBurstFlushScopeDescriptor(policy)),
    finalizeConstituentLedger: finalizeBurstConstituentLedger,
    completeInboundProcessingClaim,
    alertBurstFailure: launchAlerts.burstFlushFailure,
  });
}

export default handleFlushInboundBurstsRequest;
