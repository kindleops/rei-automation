// ─── seller-inbound-burst-coordinator.js ─────────────────────────────────────
// Durable seller-inbound burst coordination.
//
// Owns ONLY: grouping, trailing-edge timing, durable claim + lease recovery,
// aggregation, idempotent handoff into processSellerInboundMessage (V2 remains
// the business-decision authority).
//
// Production activation is gated by isSellerInboundBurstEnabled().
//
// ACTIVATION PREREQUISITES (flag must stay false until ALL hold — see also the
// 20260726120000_seller_inbound_bursts.sql migration header):
//   1. seller_inbound_bursts schema + claim RPC applied. Without them the
//      durable append THROWS, the inbound webhook fails its idempotency record
//      and the provider retries — fail-closed. There is NO automatic fallback
//      to per-message auto-reply when burst infrastructure is unavailable.
//   2. Flush worker wired (cron → /api/internal/seller-flow/flush-inbound-bursts).
//      Without it, non-safety bursts finalize only when a later inbound trips
//      the hard-close rollover's inline flush (delayed, never lost); safety
//      latches always finalize inline immediately.
//   3. Flush-path auto-reply mode gating resolved by the flush caller before
//      live queueing; the default flush context stays non-live.
//
// INVARIANT — EVERY selection predicate goes IN THE QUERY, never in JS after
// the store has applied `limit`.
//
// Eligible selection is ordered `eligible_at ASC`, so the page always goes to
// the OLDEST rows. A filter applied afterwards in JS therefore cannot narrow a
// page — it can only discard rows that already won it, while the rows the
// caller actually wanted sit just past the boundary. The call then returns an
// empty result and reports "no work" while work exists. It is quiet, it is
// wrong, and it looks exactly like a healthy idle tick.
//
// This defect has now appeared TWICE in this subsystem — once on the scope
// filter, once on the thread filter — which makes it a missing invariant rather
// than two mistakes. If you are adding a new way to select bursts, it belongs
// in the store's query builder alongside scope and thread_key. A JS check is
// permitted only as a POST-CONDITION on rows the query already narrowed, so a
// store that ignores the parameter cannot widen the caller.
//
// Crash recovery: a claim carries claimed_at + claim_token + attempt_count.
// A worker that dies mid-finalize leaves the row CLAIMED; after
// SELLER_INBOUND_BURST_CLAIM_LEASE_MS any worker atomically reclaims it with
// the SAME generation/constituents/decision_idempotency_key. Observable side
// effects are idempotent under at-least-once retries because the aggregate V2
// turn re-runs with an identical inboundEventId (send_queue.source_event_id
// dedupe) and identical decision_idempotency_key. attempt_count bounds
// retries; exhaustion finalizes the burst as FAILED (explicit, observable).

import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import {
  aggregateBurstMessage,
  BURST_STATUSES,
  detectImmediateSafetySignal,
  SELLER_INBOUND_BURST_DEBOUNCE_MS,
  SELLER_INBOUND_BURST_MAX_DURATION_MS,
  SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
  SELLER_INBOUND_BURST_MAX_ATTEMPTS,
  SELLER_INBOUND_BURST_POLICY_VERSION,
  durableExecutionContext,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  createMemorySellerInboundBurstStore,
  createSupabaseSellerInboundBurstStore,
} from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Recover the webhook-validated facts from the burst's persisted constituents.
 *
 * Uses the LATEST constituent that carries each fact, so a multi-fragment burst
 * resolves to the most recent validated turn rather than the first. Returns
 * empty objects when nothing was persisted (bursts written before this change),
 * which leaves the previous behaviour exactly as it was.
 */
export function latestPersistedTurnFacts(constituents = []) {
  const list = Array.isArray(constituents) ? constituents : [];
  let classification = null;
  let execution_context = null;
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    if (c.classification && typeof c.classification === "object") classification = c.classification;
    if (c.execution_context && typeof c.execution_context === "object") {
      execution_context = c.execution_context;
    }
  }
  return { classification, execution_context };
}

function asBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

/**
 * Feature gate — default OFF (no production activation).
 * Env SELLER_INBOUND_BURST_ENABLED or explicit option.
 */
export function isSellerInboundBurstEnabled({
  enabled = null,
  env = process.env,
} = {}) {
  if (enabled != null) return Boolean(enabled);
  return asBoolean(env?.SELLER_INBOUND_BURST_ENABLED, false);
}

/**
 * Burst activation mode.
 *   disabled       — default; no burst behavior anywhere.
 *   enabled        — global activation (boolean-truthy env values; unchanged).
 *   internal_proof — burst engages ONLY for internal test phones, and the
 *                    webhook additionally requires an active bounded
 *                    internal-proof session. Real seller threads behave
 *                    exactly as disabled. This is the activation path for the
 *                    burst leg of the internal automation proof without any
 *                    production seller exposure.
 * Unknown values fall back to disabled (fail-closed).
 */
export function resolveSellerInboundBurstMode({ env = process.env } = {}) {
  const raw = String(env?.SELLER_INBOUND_BURST_ENABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return "enabled";
  if (raw === "internal_proof") return "internal_proof";
  return "disabled";
}

/**
 * Thread-scoped burst gate. In internal_proof mode only an internal test
 * phone thread may engage burst; callers that can check the proof session
 * (the webhook) must ALSO verify one is active before honoring this.
 */
export function isSellerInboundBurstEnabledForThread({
  thread_key = null,
  enabled = null,
  env = process.env,
  mode = null,
  isInternalPhone = null,
} = {}) {
  if (enabled != null) return Boolean(enabled);
  const resolved_mode = mode || resolveSellerInboundBurstMode({ env });
  if (resolved_mode === "enabled") return true;
  if (resolved_mode !== "internal_proof") return false;
  const checker = isInternalPhone || isInternalTestPhone;
  const key = clean(thread_key);
  return Boolean(key) && Boolean(checker(key));
}

/**
 * Coordinator activation scope — the single authority for "which bursts may
 * this coordinator touch". Every store door (append, list, claim) receives it.
 *
 * DENY BY DEFAULT. A coordinator constructed with neither an explicit scope nor
 * an explicit `enabled` assertion may touch nothing. That is deliberate: the
 * defect this module repairs was a permissive default — `enabled: true`
 * hardcoded into the flush route, short-circuiting every mode check beneath it.
 * Re-creating an "absent means global" default one layer lower would reproduce
 * the same failure with a longer stack trace.
 *
 * `enabled === true` still maps to global scope, and that is NOT a permissive
 * default: it is an explicit assertion made by a caller that has already run
 * its own mode gate (the webhook at handle-textgrid-inbound.js:1329-1362, the
 * flush handler after resolving the activation policy). Absent is denied;
 * asserted is honored.
 */
export function resolveCoordinatorActivationScope({
  activation_scope = null,
  enabled = null,
  env = process.env,
} = {}) {
  if (activation_scope && typeof activation_scope === "object") {
    return {
      ...activation_scope,
      authorized: Boolean(activation_scope.authorized),
      global: Boolean(activation_scope.global),
    };
  }
  const GLOBAL = (reason) => ({
    authorized: true,
    global: true,
    kind: "global",
    thread_keys: null,
    reason,
  });
  if (enabled === true) return GLOBAL("legacy_enabled_assertion");
  // No explicit assertion either way: honor the operator's env flag, which is
  // what `enabled` mode has always meant. `internal_proof` is not boolean-truthy
  // and therefore denies here — that mode MUST arrive as an explicit scope
  // carrying a session window, never as a bare global activation.
  if (enabled == null && isSellerInboundBurstEnabled({ env })) {
    return GLOBAL("env_global_activation");
  }
  return {
    authorized: false,
    global: false,
    kind: "none",
    thread_keys: [],
    reason: enabled === false ? "explicitly_disabled" : "no_activation_scope",
  };
}

/**
 * Attach authorization flags to a burst-flush scope descriptor, producing the
 * store-facing scope.
 *
 * Takes the OUTPUT of toBurstFlushScopeDescriptor() rather than importing that
 * builder, for two reasons: the policy module already imports
 * resolveSellerInboundBurstMode from this file (importing back would close a
 * cycle), and the descriptor must have exactly one producer. This function adds
 * `authorized` / `global` and nothing else — the bounds, the thread list and
 * the reason vocabulary all belong to the policy module, which owns the shared
 * predicate that reads them.
 *
 * Refuses on anything short of an explicit, non-fatal claim licence.
 */
export function activationScopeFromDescriptor(descriptor) {
  const d = descriptor && typeof descriptor === "object" ? descriptor : null;
  const denied = (reason) => ({
    authorized: false,
    global: false,
    kind: "none",
    thread_keys: [],
    reason,
  });
  if (!d) return denied("missing_scope_descriptor");
  if (d.ok !== true || d.fatal === true) return denied(d.reason || "policy_resolution_failed");
  if (d.allowed !== true) return denied(d.reason || "not_activated");
  const scope = d.scope && typeof d.scope === "object" ? d.scope : null;
  if (!scope) return denied("missing_scope");
  if (scope.kind === "global") {
    return { ...scope, authorized: true, global: true, reason: d.reason || "global_activation" };
  }
  // A thread scope missing either floor is an UNRESOLVED licence, not a
  // narrower one. Deny it here rather than let it reach the store, where an
  // absent bound and a global scope are one field apart.
  if (
    !Array.isArray(scope.thread_keys) ||
    scope.thread_keys.length === 0 ||
    !clean(scope.min_first_received_at) ||
    !clean(scope.min_created_at)
  ) {
    return denied("policy_bounds_invalid");
  }
  return {
    ...scope,
    authorized: true,
    global: false,
    reason: d.reason || "internal_proof_session_active",
  };
}

export function createSellerInboundBurstCoordinator({
  store = null,
  supabase = null,
  now = () => new Date().toISOString(),
  processSellerInboundMessage = null,
  cancelPendingOutbound = null,
  cancelPendingFollowUps = null,
  worker_id = "burst-coordinator",
  debounce_ms = SELLER_INBOUND_BURST_DEBOUNCE_MS,
  max_duration_ms = SELLER_INBOUND_BURST_MAX_DURATION_MS,
  claim_lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
  max_attempts = SELLER_INBOUND_BURST_MAX_ATTEMPTS,
  enabled = null,
  activation_scope = null,
  finalizeConstituentLedger = null,
  completeInboundProcessingClaim = null,
  alertBurstFailure = null,
} = {}) {
  const burstStore =
    store ||
    (supabase
      ? createSupabaseSellerInboundBurstStore({ supabase, now })
      : createMemorySellerInboundBurstStore({ now }));

  // Resolved once at construction. Every store call below passes it; there is
  // no code path that reaches the table without it.
  const scope = resolveCoordinatorActivationScope({ activation_scope, enabled });

  /**
   * Ingest one already-persisted inbound into the burst layer.
   * Does NOT persist the raw message — caller must have done that.
   * Applies immediate safety latch + cancels pending outbound when needed.
   */
  async function onPersistedInbound({
    thread_key,
    event_id = null,
    provider_message_id = null,
    body,
    received_at = null,
    classification = null,
    orchestration_context = null,
    // Durable contact suppression already on the thread (e.g. prior STOP).
    // Monotonic: a later benign fragment must not open a reply-capable generation.
    prior_thread_suppressed = false,
  } = {}) {
    if (!scope.authorized) {
      return {
        ok: true,
        deferred: false,
        reason: "burst_disabled",
        scope_reason: scope.reason || "unauthorized",
      };
    }
    const group = clean(thread_key);
    if (!group) return { ok: false, reason: "missing_thread_key" };

    const message = {
      event_id,
      provider_message_id,
      body,
      // Timing value for debounce/ordering — synthesized when the provider gave
      // us nothing, because the windows need a concrete instant.
      received_at: received_at || now(),
      // Authorization value — deliberately NOT synthesized. The live_limited
      // cutoff must never be cleared by a timestamp we invented; null flows
      // through to the scope gate, which denies it.
      authorized_received_at: received_at || null,
      classification,
      // Durable, allowlisted snapshot of the webhook's execution context. The
      // scheduled flush runs minutes later with no live request context, so
      // without this it reconstructs the turn from the body alone.
      execution_context: durableExecutionContext(orchestration_context),
    };

    let safety = detectImmediateSafetySignal({ message: body, classification });
    // Prior durable suppression latches every subsequent fragment — STOP→benign
    // must not create a new generation that can flush into V2/reply/follow-up.
    if (!safety.latch && prior_thread_suppressed === true) {
      safety = {
        latch: true,
        kind: "contact_suppression",
        reason: "prior_thread_suppressed",
      };
    }

    // Immediate pending-reply cancellation for safety OR any new inbound
    // (stale auto-reply supersession). Fail open on cancel errors.
    //
    // Policy scope matters: a safety latch cancels EVERYTHING
    // (compliance_terminal), but a benign new inbound must cancel only the
    // automated reply/follow-up rows (inbound_takeover) — the old
    // "superseded_by_newer_inbound" policy string was not a member of
    // CANCELLATION_POLICIES, fell through to the compliance default, and
    // cancelled unrelated campaign touches on every fragment.
    // inbound_received_at arms the supersession guard so a slow older
    // inbound can never cancel a newer inbound's queued reply.
    let cancel_result = { ok: true, cancelled: 0, reason: "not_attempted" };
    if (typeof cancelPendingOutbound === "function") {
      try {
        cancel_result = await cancelPendingOutbound({
          thread_key: group,
          reason: safety.latch
            ? `burst_safety_${safety.kind || "terminal"}`
            : "superseded_by_newer_inbound",
          inbound_event_id: event_id || provider_message_id,
          policy: safety.latch ? "compliance_terminal" : "inbound_takeover",
          inbound_received_at: message.received_at,
        });
      } catch (err) {
        cancel_result = {
          ok: false,
          cancelled: 0,
          reason: err?.message || "cancel_failed",
        };
      }
    }
    if (safety.latch && typeof cancelPendingFollowUps === "function") {
      try {
        await cancelPendingFollowUps({
          thread_key: group,
          reason: `burst_safety_${safety.kind || "terminal"}`,
          inbound_event_id: event_id || provider_message_id,
        });
      } catch {
        /* best-effort */
      }
    }

    let append = await burstStore.appendMessage({
      thread_key: group,
      message,
      debounce_ms,
      max_duration_ms,
      now: now(),
      scope,
    });
    // The store DECLINED to take this message. Two flavours today — an
    // out-of-scope OPEN generation on the thread (the guard protecting a
    // preserved burst from the rollover force-eligible write, which lands
    // inside appendMessage before the coordinator can see `rollover`), and a
    // thread the scope never authorized at all.
    //
    // `deferred` means "the burst layer has taken custody of this message". A
    // decline is the opposite, and saying `deferred: true` here silently drops
    // the message: no burst row, no orchestration, no error, no redelivery.
    //
    // Matched on `ok === false` rather than on a list of reasons. Enumerating
    // reasons is exactly how `thread_out_of_scope` slipped through — the two
    // branches that existed covered the two failures that were in mind when
    // they were written. A new refusal reason must fail into "declined", never
    // into "deferred".
    if (append?.ok === false && !append?.rollover) {
      return {
        ok: true,
        declined: true,
        deferred: false,
        reason: append.reason || "burst_append_refused",
        blocking_burst_id: append?.blocking_burst_id || null,
        blocking_first_received_at: append?.blocking_first_received_at || null,
        append,
        safety,
        cancel_result,
        orchestration_context,
      };
    }

    // Hard-close rollover (Supabase store contract): the old open generation
    // was force-marked eligible and the new message could not be appended yet.
    // Flush the old generation, then retry the SAME message (constituent dedupe
    // on provider id makes the retry idempotent). Bounded loop — after
    // exhaustion we FAIL EXPLICITLY so the webhook errors and the provider
    // redelivers; the message is never silently dropped and never falls back
    // to a per-message auto-reply.
    let rollover_rounds = 0;
    while (append?.rollover && append?.pending_message && rollover_rounds < 3) {
      rollover_rounds += 1;
      // Pin the exact generation that blocked this append. An unpinned
      // thread-scoped flush resolves to `ORDER BY eligible_at ASC LIMIT 1`
      // inside claim_seller_inbound_burst — the OLDEST eligible generation on
      // the thread, which is not necessarily the one that blocked us.
      await flushEligible({
        thread_key: group,
        burst_id: append?.burst?.burst_id || null,
        limit: 1,
      });
      append = await burstStore.appendMessage({
        thread_key: group,
        message: append.pending_message,
        debounce_ms,
        max_duration_ms,
        now: now(),
        scope,
      });
    }
    if (append?.rollover) {
      return {
        ok: false,
        deferred: false,
        reason: "burst_rollover_append_failed",
        safety,
        cancel_result,
        append,
        orchestration_context,
      };
    }

    // Coordinator-level safety (message STOP/wrong-number OR durable prior
    // thread suppression) must land on the store row: mark safety_latched +
    // eligible_at=now so claim/finalize can run immediately. Message-only
    // detection inside createOpenBurstState does not see prior_thread_suppressed.
    if (
      safety.latch &&
      append?.burst &&
      append.burst.safety_latched !== true &&
      typeof burstStore.latchSafety === "function"
    ) {
      const latched = await burstStore.latchSafety({
        thread_key: group,
        reason: safety.reason,
        kind: safety.kind,
        now: now(),
      });
      if (latched?.ok && latched.burst) {
        append = { ...append, burst: latched.burst };
      }
    }

    // Safety-latched → flush immediately (no wait for quiet window). Also
    // applies to a safety message that just rolled into generation N+1.
    let flush = null;
    if (safety.latch || append.burst?.safety_latched) {
      // If `append.burst` is somehow absent this refuses (and alerts) rather
      // than degrading to an unpinned thread-scoped claim. The compliance-
      // critical half of a safety latch — cancelPendingOutbound — has already
      // run above, so a refused finalize delays the suppression record; it does
      // not let an outbound message escape.
      flush = await finalizeBurst({
        thread_key: group,
        burst_id: append.burst?.burst_id,
        orchestration_context,
      });
    }

    return {
      ok: true,
      deferred: true,
      rollover: rollover_rounds > 0,
      safety,
      cancel_result,
      append,
      flush,
      orchestration_context,
    };
  }

  /**
   * Claim + run one V2 orchestration for an eligible burst.
   */

  /**
   * Settles the constituent inbound ledger rows for a burst that has reached a
   * terminal status. Called after EVERY successful terminal completeClaimed —
   * completed, suppressed and failed alike. A terminal burst that leaves rows
   * marked awaiting_burst_finalization is the 2026-08-03 failure shape again:
   * a decision nobody ever recorded.
   *
   * Uses the STORE'S returned burst record so the exact burst_id/generation is
   * settled and one generation can never settle another. Reports honestly —
   * a failed burst is never handed { ok: true }.
   */
  async function settleConstituentLedger({ completion, fallbackBurst, result }) {
    if (!supabase || typeof finalizeConstituentLedger !== "function") return null;
    // Only settle behind a genuinely successful terminal write.
    if (completion && completion.ok === false) return null;
    const finalBurst = completion?.burst || fallbackBurst || null;
    if (!finalBurst?.burst_id) return null;
    try {
      return await finalizeConstituentLedger({
        supabase,
        burst: finalBurst,
        result,
        completeClaim: completeInboundProcessingClaim,
        alert: alertBurstFailure,
      });
    } catch (settle_error) {
      // finalizeBurstConstituentLedger alerts on its OWN partial-failure path
      // (it is handed `alert` above). A throw bypasses that entirely: without
      // this the burst still reports ok:true, the constituent rows keep their
      // awaiting_burst_finalization marker — which findInboundLedgerSlaBreaches
      // excludes from breach_count — and scanBurstLiveness sees a healthy
      // terminal burst. Nobody is paged and nothing is stuck-scanned: the
      // unwatched-parking hazard, reached through a second door.
      //
      // Alert exactly once here, with burst identity and error metadata only.
      // NEVER seller content: alert payloads travel to notification sinks.
      try {
        await alertBurstFailure?.({
          reason: "ledger_finalization_threw",
          burst_id: finalBurst.burst_id,
          generation: finalBurst.generation ?? null,
          thread_key: finalBurst.thread_key || null,
          constituent_count: Array.isArray(finalBurst.constituents)
            ? finalBurst.constituents.length
            : null,
          error: settle_error?.message || "unknown_error",
        });
      } catch {
        /* alerting must never mask the ledger failure it is reporting */
      }
      return {
        ok: false,
        reason: "ledger_finalization_threw",
        message: settle_error?.message || "unknown_error",
        alerted: true,
      };
    }
  }

  async function finalizeBurst({
    thread_key = null,
    burst_id = null,
    orchestration_context = null,
  } = {}) {
    if (!scope.authorized) {
      return { ok: false, reason: "burst_scope_unauthorized", scope_reason: scope.reason || null };
    }
    // A finalize MUST name its target. An unpinned thread-scoped claim degrades
    // to `p_burst_id => NULL`, and the RPC then takes `ORDER BY eligible_at ASC
    // LIMIT 1` — the oldest generation on the thread. Both former call sites
    // reached that degradation through optional chaining while reading as if
    // they were pinned. Requiring the id here removes the unpinned claim as a
    // reachable path rather than discouraging it; there is deliberately no
    // override parameter, because an override is a door with a sign on it.
    const pinned_burst_id = clean(burst_id);
    if (!pinned_burst_id) {
      try {
        await alertBurstFailure?.({
          reason: "finalize_missing_burst_id",
          thread_key: clean(thread_key) || null,
          burst_id: null,
        });
      } catch {
        /* alerting must never mask the refusal it is reporting */
      }
      return { ok: false, reason: "finalize_requires_burst_id", alerted: true };
    }
    const claim = await burstStore.claimEligible({
      thread_key,
      burst_id: pinned_burst_id,
      now: now(),
      worker_id,
      lease_ms: claim_lease_ms,
      scope,
    });
    if (!claim.ok) {
      return { ok: false, reason: claim.reason, claim };
    }

    const burst = claim.burst;
    const aggregated = aggregateBurstMessage(burst.constituents || []);
    const decision_key =
      burst.decision_idempotency_key ||
      `seller_inbound_burst_decision:${burst.thread_key}:g${burst.generation}`;

    // Bounded at-least-once: too many reclaim cycles → finalize as FAILED so
    // the burst is an explicit observable outcome, never an infinite retry.
    // Safety-latched bursts are exempt — suppression finalize is trivial and
    // must always land.
    if (
      !burst.safety_latched &&
      Number(burst.attempt_count || 0) > Number(max_attempts || SELLER_INBOUND_BURST_MAX_ATTEMPTS)
    ) {
      const failed = await burstStore.completeClaimed({
        burst_id: burst.burst_id,
        claim_token: claim.claim_token,
        status: BURST_STATUSES.FAILED,
        result_summary: {
          error: "attempts_exhausted",
          attempt_count: burst.attempt_count,
          decision_idempotency_key: decision_key,
        },
        now: now(),
      });
      const failed_ledger = await settleConstituentLedger({
        completion: failed,
        fallbackBurst: burst,
        // Honest mapping: the burst FAILED. Attempts are spent, so this is
        // terminal rather than retriable.
        result: { ok: false, retriable: false },
      });
      return {
        ok: false,
        reason: "attempts_exhausted",
        ledger_finalization: failed_ledger,
        burst: failed.burst || burst,
        aggregated,
        decision_idempotency_key: decision_key,
      };
    }

    // Safety-latched: no V2 auto-reply path — complete as suppressed.
    if (burst.safety_latched) {
      if (typeof cancelPendingOutbound === "function") {
        try {
          await cancelPendingOutbound({
            thread_key: burst.thread_key,
            reason: `burst_safety_${burst.safety_kind || "terminal"}`,
            inbound_event_id: burst.latest_event_id,
            policy: "compliance_terminal",
          });
        } catch {
          /* best-effort re-check */
        }
      }
      const completed = await burstStore.completeClaimed({
        burst_id: burst.burst_id,
        claim_token: claim.claim_token,
        status: BURST_STATUSES.SUPPRESSED,
        result_summary: {
          suppressed: true,
          safety_kind: burst.safety_kind,
          safety_reason: burst.safety_reason,
          message_count: aggregated.message_count,
          decision_idempotency_key: decision_key,
          policy_version: SELLER_INBOUND_BURST_POLICY_VERSION,
        },
        now: now(),
      });
      const suppressed_ledger = await settleConstituentLedger({
        completion: completed,
        fallbackBurst: burst,
        result: {
          ok: true,
          suppressed: true,
          suppression_kind: burst.safety_kind || null,
        },
      });
      return {
        ok: true,
        suppressed: true,
        queued: false,
        followup_scheduled: false,
        ledger_finalization: suppressed_ledger,
        burst: completed.burst || burst,
        aggregated,
        orchestration: null,
        decision_idempotency_key: decision_key,
      };
    }

    if (typeof processSellerInboundMessage !== "function") {
      // Claim held but no processor — mark failed/retryable by returning without complete.
      // Caller may retry with same claim_token path only if we leave CLAIMED.
      // For recovery, leave CLAIMED and return error so a crash-safe retry can complete.
      return {
        ok: false,
        reason: "missing_process_seller_inbound",
        claim,
        burst,
        aggregated,
        decision_idempotency_key: decision_key,
      };
    }

    // A live orchestration_context exists only on the inline (webhook) finalize.
    // The SCHEDULED flush has none, so rebuild it from the durable snapshot the
    // webhook persisted on the constituent. Live context always wins; the
    // persisted snapshot fills only what the caller did not supply.
    //
    // This is the repair for the 2026-08-06 proof: the webhook had validated
    // ownership_confirmed at 0.88 against a 36-second-old question, and the
    // flush then re-derived the turn from the bare body "Yeah" — no question to
    // bind to, no property/prospect/owner, no execution authorization — and
    // returned effective_action=none.
    const persisted = latestPersistedTurnFacts(burst.constituents);
    const ctx = { ...(persisted.execution_context || {}), ...(orchestration_context || {}) };
    if (!ctx.classification && persisted.classification) {
      ctx.classification = persisted.classification;
    }
    let orchestration = null;
    let process_error = null;
    try {
      orchestration = await processSellerInboundMessage({
        message: aggregated.message,
        threadKey: burst.thread_key,
        propertyId: ctx.propertyId ?? null,
        prospectId: ctx.prospectId ?? null,
        ownerId: ctx.ownerId ?? null,
        phoneId: ctx.phoneId ?? null,
        classification: ctx.classification ?? null, // null → re-classify aggregated
        conversationBrain: ctx.conversationBrain ?? null,
        context: ctx.context ?? null,
        route: ctx.route ?? null,
        inboundFrom: burst.thread_key,
        inboundTo: ctx.inboundTo ?? null,
        inboundEventId: burst.latest_event_id || burst.first_event_id,
        // Authorization input: never falls back to the timing value, which may
        // have been synthesized at ingress.
        inboundReceivedAt: aggregated.last_authorized_received_at,
        providerMessageId: burst.latest_event_id || null,
        stageBefore: ctx.stageBefore ?? null,
        autoReplyMode: ctx.autoReplyMode ?? null,
        executionAllowed: ctx.executionAllowed ?? null,
        systemFollowupEnabled: ctx.systemFollowupEnabled ?? true,
        inboundAutopilotDelaySeconds: ctx.inboundAutopilotDelaySeconds ?? 0,
        timezoneOverride: ctx.timezoneOverride ?? null,
        contactWindowOverride: ctx.contactWindowOverride ?? null,
        dryRun: Boolean(ctx.dryRun),
        proofRun: Boolean(ctx.proofRun),
        applySuppression: true,
        underwritingSignals: ctx.underwritingSignals ?? null,
        recentOutbound: ctx.recentOutbound ?? null,
        supabaseClient: ctx.supabaseClient ?? null,
        getSystemValue: ctx.getSystemValue ?? null,
        // Burst provenance for audit / idempotent reply keys, plus the raw
        // constituents so V2's monetary resolution can apply the burst-aware
        // latest-explicit-price reduction (resolveBurstAskingPriceSignal).
        burstContext: {
          burst_id: burst.burst_id,
          generation: burst.generation,
          constituent_event_ids: aggregated.ordered_event_ids,
          constituent_messages: (burst.constituents || []).map((c) => ({
            event_id: c.event_id || null,
            provider_message_id: c.provider_message_id || null,
            body: c.body,
            received_at: c.received_at || null,
          })),
          decision_idempotency_key: decision_key,
          policy_version: SELLER_INBOUND_BURST_POLICY_VERSION,
          message_count: aggregated.message_count,
          attempt_count: Number(burst.attempt_count || 0),
        },
      });
    } catch (err) {
      process_error = err?.message || "process_failed";
    }

    // Phase 11 (no silent dead-end): gate COMPLETED finalization on a genuinely
    // successful orchestration. A top-level orchestration result that returns
    // ok:false is unprocessable (e.g. a classification-contract failure) and
    // must NOT finalize as a clean COMPLETED carrying no reply, review, or
    // fallback. Fold it into the SAME process_error path so it inherits the
    // existing bounded at-least-once retry and, on exhaustion, becomes a
    // VISIBLE FAILED — no new error lifecycle. Scoped strictly to the top-level
    // orchestration result's own `ok` flag; nested helper ok:false values
    // inside the orchestrator are unaffected.
    if (!process_error && orchestration && orchestration.ok === false) {
      process_error = clean(orchestration.reason) || "orchestration_not_ok";
    }

    // Re-check safety after processing (race: STOP arrived during claim).
    const openAfter = typeof burstStore.getOpen === "function"
      ? await burstStore.getOpen(burst.thread_key)
      : null;
    const post_safety =
      openAfter?.safety_latched ||
      (orchestration?.intelligence_snapshot?.canonical_decision?.should_suppress_contact ===
        true);

    if (process_error) {
      // At-least-once recovery: leave the row CLAIMED (no completion write).
      // After claim_lease_ms the stale-lease reclaim path retries with the
      // same generation/constituents/decision_idempotency_key; attempt_count
      // bounds retries and exhaustion finalizes as FAILED above. Observable
      // side effects the dead/failed attempt already produced are deduped by
      // the stable inboundEventId (send_queue.source_event_id) on retry.
      return {
        ok: false,
        reason: process_error,
        retry_after_lease: true,
        burst,
        aggregated,
        decision_idempotency_key: decision_key,
      };
    }

    const completed = await burstStore.completeClaimed({
      burst_id: burst.burst_id,
      claim_token: claim.claim_token,
      status: post_safety ? BURST_STATUSES.SUPPRESSED : BURST_STATUSES.COMPLETED,
      result_summary: {
        queued: Boolean(orchestration?.queued || orchestration?.execution?.queued),
        followup_scheduled: Boolean(
          orchestration?.followup_scheduled || orchestration?.follow_up?.followup_created
        ),
        effective_action: orchestration?.effective_action || null,
        decision_idempotency_key: decision_key,
        message_count: aggregated.message_count,
        policy_version: SELLER_INBOUND_BURST_POLICY_VERSION,
        post_safety: Boolean(post_safety),
      },
      now: now(),
    });

    const ledger_finalization = await settleConstituentLedger({
      completion: completed,
      fallbackBurst: burst,
      result: {
        ok: true,
        suppressed: Boolean(post_safety),
        queued: Boolean(orchestration?.queued || orchestration?.execution?.queued),
        queue_row_id:
          orchestration?.queue_row_id || orchestration?.execution?.queue_row_id || null,
        human_review_required: Boolean(orchestration?.human_review_required),
        suppression_kind: post_safety ? burst?.safety_kind || null : null,
      },
    });

    return {
      ok: true,
      ledger_finalization,
      suppressed: Boolean(post_safety),
      queued: Boolean(orchestration?.queued || orchestration?.execution?.queued),
      followup_scheduled: Boolean(
        orchestration?.followup_scheduled || orchestration?.follow_up?.followup_created
      ),
      burst: completed.burst || burst,
      aggregated,
      orchestration,
      decision_idempotency_key: decision_key,
    };
  }

  async function flushEligible({ thread_key = null, burst_id = null, limit = 20 } = {}) {
    const results = [];
    if (!scope.authorized) {
      return {
        ok: false,
        reason: "burst_scope_unauthorized",
        scope_reason: scope.reason || null,
        results,
      };
    }
    // Caller named an exact generation (rollover, targeted flush): honor it.
    if (clean(burst_id)) {
      results.push(await finalizeBurst({ thread_key, burst_id }));
      return { ok: true, results };
    }
    // Everything else is list-driven, and the list is scoped. `thread_key`
    // WITHOUT a burst_id is a FILTER over the eligible set — never a bare
    // claim. That distinction is the whole repair: a bare thread-scoped claim
    // is what selects a 36-hour-old artifact ahead of the burst beside it.
    // The thread filter goes IN THE QUERY, before `limit`. Filtering in JS
    // afterwards means a page can be filled entirely by other threads' older
    // bursts and the named thread's live burst never makes it — a targeted
    // flush that reports no work while work exists. Reachable in `enabled`
    // mode, where the scope is global and the operator supplies the thread.
    // Same rule the scope filter already follows, one layer up.
    const group = clean(thread_key);
    const eligible =
      typeof burstStore.listEligible === "function"
        ? await burstStore.listEligible({
            now: now(),
            limit,
            lease_ms: claim_lease_ms,
            scope,
            thread_key: group || null,
          })
        : [];
    for (const b of eligible) {
      // Post-condition, not the enforcement: the store constrains the thread
      // in-query. Kept so a store that ignores the parameter cannot widen us.
      if (group && clean(b.thread_key) !== group) continue;
      // A listed row with no burst_id would finalize as an unpinned claim. The
      // store should never produce one; refuse rather than trust it.
      if (!clean(b.burst_id)) {
        try {
          await alertBurstFailure?.({
            reason: "eligible_row_missing_burst_id",
            thread_key: clean(b.thread_key) || null,
            burst_id: null,
          });
        } catch {
          /* alerting must never mask the refusal it is reporting */
        }
        results.push({ ok: false, reason: "eligible_row_missing_burst_id", alerted: true });
        continue;
      }
      results.push(
        await finalizeBurst({
          thread_key: b.thread_key,
          burst_id: b.burst_id,
        })
      );
    }
    return { ok: true, results };
  }

  return {
    store: burstStore,
    onPersistedInbound,
    finalizeBurst,
    flushEligible,
    scope,
    isEnabled: () => scope.authorized,
  };
}

export default {
  createSellerInboundBurstCoordinator,
  isSellerInboundBurstEnabled,
  resolveCoordinatorActivationScope,
  activationScopeFromDescriptor,
};
