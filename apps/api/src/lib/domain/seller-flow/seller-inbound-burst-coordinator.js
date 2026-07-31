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
// Crash recovery: a claim carries claimed_at + claim_token + attempt_count.
// A worker that dies mid-finalize leaves the row CLAIMED; after
// SELLER_INBOUND_BURST_CLAIM_LEASE_MS any worker atomically reclaims it with
// the SAME generation/constituents/decision_idempotency_key. Observable side
// effects are idempotent under at-least-once retries because the aggregate V2
// turn re-runs with an identical inboundEventId (send_queue.source_event_id
// dedupe) and identical decision_idempotency_key. attempt_count bounds
// retries; exhaustion finalizes the burst as FAILED (explicit, observable).

import {
  aggregateBurstMessage,
  BURST_STATUSES,
  detectImmediateSafetySignal,
  SELLER_INBOUND_BURST_DEBOUNCE_MS,
  SELLER_INBOUND_BURST_MAX_DURATION_MS,
  SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
  SELLER_INBOUND_BURST_MAX_ATTEMPTS,
  SELLER_INBOUND_BURST_POLICY_VERSION,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import {
  createMemorySellerInboundBurstStore,
  createSupabaseSellerInboundBurstStore,
} from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";

function clean(value) {
  return String(value ?? "").trim();
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
} = {}) {
  const burstStore =
    store ||
    (supabase
      ? createSupabaseSellerInboundBurstStore({ supabase, now })
      : createMemorySellerInboundBurstStore({ now }));

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
    if (!isSellerInboundBurstEnabled({ enabled })) {
      return { ok: true, deferred: false, reason: "burst_disabled" };
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
    let cancel_result = { ok: true, cancelled: 0, reason: "not_attempted" };
    if (typeof cancelPendingOutbound === "function") {
      try {
        cancel_result = await cancelPendingOutbound({
          thread_key: group,
          reason: safety.latch
            ? `burst_safety_${safety.kind || "terminal"}`
            : "superseded_by_newer_inbound",
          inbound_event_id: event_id || provider_message_id,
          policy: safety.latch ? "compliance_terminal" : "superseded_by_newer_inbound",
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
    });

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
      await flushEligible({ thread_key: group, limit: 1 });
      append = await burstStore.appendMessage({
        thread_key: group,
        message: append.pending_message,
        debounce_ms,
        max_duration_ms,
        now: now(),
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
  async function finalizeBurst({
    thread_key = null,
    burst_id = null,
    orchestration_context = null,
  } = {}) {
    const claim = await burstStore.claimEligible({
      thread_key,
      burst_id,
      now: now(),
      worker_id,
      lease_ms: claim_lease_ms,
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
      return {
        ok: false,
        reason: "attempts_exhausted",
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
      return {
        ok: true,
        suppressed: true,
        queued: false,
        followup_scheduled: false,
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

    const ctx = orchestration_context || {};
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

    return {
      ok: true,
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

  async function flushEligible({ thread_key = null, limit = 20 } = {}) {
    const results = [];
    if (thread_key) {
      results.push(await finalizeBurst({ thread_key }));
      return { ok: true, results };
    }
    const eligible =
      typeof burstStore.listEligible === "function"
        ? await burstStore.listEligible({ now: now(), limit, lease_ms: claim_lease_ms })
        : [];
    for (const b of eligible) {
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
    isEnabled: () => isSellerInboundBurstEnabled({ enabled }),
  };
}

export default {
  createSellerInboundBurstCoordinator,
  isSellerInboundBurstEnabled,
};
