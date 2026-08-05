// Burst liveness invariants and metrics.
//
// Production incident 2026-08-03: burst sib:+16128072000:g1:ba199924 sat
// status=open with attempt_count=0, past both eligible_at and hard_close_at,
// indefinitely — because the scheduled worker never ran (the flush route
// exported POST only while Vercel Cron issues GET). Nothing noticed. The burst
// layer had no liveness invariant, and the disposition SLO scanner only looked
// at inbound_processing_ledger, where the same event had been (incorrectly)
// marked terminal.
//
// An eligible burst may never remain open indefinitely. This module is a pure
// evaluator: it reads burst rows and returns violations + metrics. It sends
// nothing and mutates nothing, so it is safe to call from a scanner, a test, or
// an ops probe.

import {
  SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
  SELLER_INBOUND_BURST_MAX_ATTEMPTS,
} from "./seller-inbound-burst-policy.js";

/**
 * Grace beyond eligible_at before an unclaimed burst is a violation. The worker
 * is scheduled every minute (the finest cadence Vercel Cron offers), so one
 * missed tick is normal jitter and two is not.
 */
export const BURST_CLAIM_GRACE_MS = 120_000;

export const BURST_LIVENESS_SEVERITY = Object.freeze({
  P0: "P0",
  P1: "P1",
});

export const BURST_LIVENESS_VIOLATIONS = Object.freeze({
  STALE_OPEN_PAST_ELIGIBLE: "burst_stale_open_past_eligible",
  STALE_OPEN_PAST_HARD_CLOSE: "burst_stale_open_past_hard_close",
  WORKER_LIVENESS_FAILURE: "burst_worker_liveness_failure",
  STALE_CLAIMED_PAST_LEASE: "burst_stale_claimed_past_lease",
  RETRIES_EXHAUSTED_NOT_TERMINAL: "burst_retries_exhausted_not_terminal",
});

function ms(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function statusOf(burst) {
  return String(burst?.status ?? "").trim().toLowerCase();
}

/**
 * Evaluates one burst row against the liveness invariants.
 * @returns {{violations: Array<{code:string, severity:string, burst_id:string, detail:object}>, state: string}}
 */
export function evaluateBurstLiveness(burst, {
  now = new Date().toISOString(),
  claim_grace_ms = BURST_CLAIM_GRACE_MS,
  claim_lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
  max_attempts = SELLER_INBOUND_BURST_MAX_ATTEMPTS,
} = {}) {
  const violations = [];
  const now_ms = ms(now);
  const status = statusOf(burst);
  const burst_id = burst?.burst_id || burst?.id || null;
  const eligible_at = ms(burst?.eligible_at);
  const hard_close_at = ms(burst?.hard_close_at);
  const claimed_at = ms(burst?.claimed_at);
  const attempt_count = Number(burst?.attempt_count ?? 0);

  const push = (code, severity, detail) =>
    violations.push({ code, severity, burst_id, detail: { status, ...detail } });

  if (status === "open") {
    if (hard_close_at != null && now_ms > hard_close_at) {
      // Past the hard cap and still open: the burst layer's own last-resort
      // bound has been breached. Nothing downstream will ever run for it.
      push(BURST_LIVENESS_VIOLATIONS.STALE_OPEN_PAST_HARD_CLOSE, BURST_LIVENESS_SEVERITY.P0, {
        hard_close_at: burst?.hard_close_at,
        overdue_ms: now_ms - hard_close_at,
      });
    } else if (eligible_at != null && now_ms > eligible_at + claim_grace_ms) {
      push(BURST_LIVENESS_VIOLATIONS.STALE_OPEN_PAST_ELIGIBLE, BURST_LIVENESS_SEVERITY.P0, {
        eligible_at: burst?.eligible_at,
        overdue_ms: now_ms - eligible_at,
        grace_ms: claim_grace_ms,
      });
    }

    // attempt_count === 0 after the first expected worker window means the
    // worker never even tried — the exact signature of the 2026-08-03 outage,
    // and distinguishable from "tried and failed".
    if (
      attempt_count === 0 &&
      eligible_at != null &&
      now_ms > eligible_at + claim_grace_ms
    ) {
      push(BURST_LIVENESS_VIOLATIONS.WORKER_LIVENESS_FAILURE, BURST_LIVENESS_SEVERITY.P0, {
        attempt_count,
        eligible_at: burst?.eligible_at,
        hint: "scheduled flush worker has not attempted any eligible burst",
      });
    }
  }

  if (status === "claimed") {
    const lease_base = claimed_at ?? ms(burst?.updated_at);
    if (lease_base != null && now_ms > lease_base + claim_lease_ms) {
      // Reclaimable: the worker that held it died mid-flight.
      push(BURST_LIVENESS_VIOLATIONS.STALE_CLAIMED_PAST_LEASE, BURST_LIVENESS_SEVERITY.P1, {
        claimed_at: burst?.claimed_at || burst?.updated_at,
        lease_ms: claim_lease_ms,
        reclaimable: true,
      });
    }
  }

  if (
    attempt_count >= max_attempts &&
    status !== "failed" &&
    status !== "completed" &&
    status !== "suppressed" &&
    status !== "cancelled"
  ) {
    // Retries are spent but the row never reached an explicit terminal state.
    push(BURST_LIVENESS_VIOLATIONS.RETRIES_EXHAUSTED_NOT_TERMINAL, BURST_LIVENESS_SEVERITY.P0, {
      attempt_count,
      max_attempts,
    });
  }

  return { violations, state: classifyBurstState(burst, { now, claim_grace_ms, claim_lease_ms }) };
}

/** Metric bucket for a single burst. */
export function classifyBurstState(burst, {
  now = new Date().toISOString(),
  claim_grace_ms = BURST_CLAIM_GRACE_MS,
  claim_lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
} = {}) {
  const now_ms = ms(now);
  const status = statusOf(burst);
  const eligible_at = ms(burst?.eligible_at);

  if (status === "completed") return "completed";
  if (status === "suppressed") return "suppressed";
  if (status === "failed") return "failed";
  // `cancelled` is a terminal status in the table CHECK constraint. Falling
  // through to the default bucket would have mislabelled it open_not_eligible
  // and hidden it from both the metrics and the invariants.
  if (status === "cancelled") return "cancelled";

  if (status === "claimed") {
    const lease_base = ms(burst?.claimed_at) ?? ms(burst?.updated_at);
    if (lease_base != null && now_ms > lease_base + claim_lease_ms) return "stale_claimed";
    return "claimed";
  }

  if (status === "open") {
    if (eligible_at == null || now_ms < eligible_at) return "open_not_eligible";
    if (now_ms > eligible_at + claim_grace_ms) return "stale_open";
    return "eligible_waiting";
  }

  return "open_not_eligible";
}

export const BURST_METRIC_BUCKETS = Object.freeze([
  "open_not_eligible",
  "eligible_waiting",
  "claimed",
  "completed",
  "suppressed",
  "failed",
  "stale_open",
  "stale_claimed",
  "cancelled",
]);

/**
 * Aggregates burst rows into the operational metric set, plus latency
 * distributions. Latencies are only computed for rows that actually reached the
 * relevant milestone — a stuck burst must never be counted as fast.
 */
export function collectBurstMetrics(bursts = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const counts = Object.fromEntries(BURST_METRIC_BUCKETS.map((b) => [b, 0]));
  const time_to_claim = [];
  const time_to_complete = [];
  const violations = [];

  for (const burst of Array.isArray(bursts) ? bursts.filter(Boolean) : []) {
    const evaluated = evaluateBurstLiveness(burst, { ...options, now });
    counts[evaluated.state] = (counts[evaluated.state] || 0) + 1;
    violations.push(...evaluated.violations);

    const eligible_at = ms(burst.eligible_at);
    const claimed_at = ms(burst.claimed_at);
    // `completed_at` is the only terminal timestamp on seller_inbound_bursts —
    // there is no `closed_at` column (20260726120000_seller_inbound_bursts.sql).
    const closed_at = ms(burst.completed_at);
    if (eligible_at != null && claimed_at != null && claimed_at >= eligible_at) {
      time_to_claim.push(claimed_at - eligible_at);
    }
    const first_received = ms(burst.first_received_at);
    if (first_received != null && closed_at != null && closed_at >= first_received) {
      time_to_complete.push(closed_at - first_received);
    }
  }

  return {
    counts,
    violations,
    worker_invocation: Number(options.worker_invocation ?? 0),
    worker_failure: Number(options.worker_failure ?? 0),
    time_to_claim: summarizeDurations(time_to_claim),
    time_to_complete: summarizeDurations(time_to_complete),
    p0_violation_count: violations.filter((v) => v.severity === BURST_LIVENESS_SEVERITY.P0).length,
  };
}

export const BURST_LIVENESS_TABLE = "seller_inbound_bursts";

/** Statuses that are still in flight — these are never aged out of monitoring. */
export const NON_TERMINAL_STATUSES = Object.freeze(["open", "claimed"]);

/**
 * READ-ONLY liveness scan over burst rows. Selects, evaluates, returns — it
 * never completes, retries, deletes, or otherwise mutates a burst, and it never
 * sends anything.
 *
 * Deliberately does NOT reuse the store's listEligible(): that helper
 * post-filters through isClaimableBurst, which hides exactly the stale rows a
 * liveness scan exists to find.
 *
 * A query failure returns ok:false. It must never be reported as a healthy
 * scan — a broken watchdog reads identically to a healthy system.
 */
export async function scanBurstLiveness({
  supabase = null,
  now = new Date().toISOString(),
  limit = 200,
  lookback_minutes = 1440,
  claim_grace_ms = BURST_CLAIM_GRACE_MS,
} = {}) {
  if (!supabase) return { ok: false, reason: "supabase_unconfigured", violation_count: 0 };

  const since = new Date(new Date(now).getTime() - lookback_minutes * 60_000).toISOString();
  const COLUMNS =
    "id,burst_id,thread_key,status,eligible_at,hard_close_at,first_received_at,attempt_count,claimed_at,completed_at,updated_at,safety_latched";
  let rows;
  let truncated = false;
  try {
    // Unfinished bursts are NEVER aged out: a burst stuck for three days is
    // more urgent than one stuck for three minutes, and a lookback ceiling
    // would silently retire the worst cases from monitoring. The lookback
    // applies only to terminal rows, which are kept solely for metrics.
    // Ask for one row beyond the cap. If it comes back, the backlog is larger
    // than this scan can see and `violation_count` is a FLOOR, not a total —
    // reporting it as a complete result would let a growing backlog look
    // bounded. The probe row is discarded; only `limit` rows are evaluated.
    const { data, error } = await supabase
      .from(BURST_LIVENESS_TABLE)
      .select(COLUMNS)
      .or(`status.in.(${NON_TERMINAL_STATUSES.join(",")}),first_received_at.gte.${since}`)
      .order("eligible_at", { ascending: true })
      .limit(limit + 1);
    if (error) {
      const code = String(error.code ?? "");
      if (code === "42P01" || code === "PGRST205") {
        return { ok: false, reason: "burst_table_missing", violation_count: 0 };
      }
      return { ok: false, reason: "burst_scan_failed", message: error.message, violation_count: 0 };
    }
    const fetched = data || [];
    truncated = fetched.length > limit;
    rows = truncated ? fetched.slice(0, limit) : fetched;
  } catch (scan_error) {
    return {
      ok: false,
      reason: "burst_scan_failed",
      message: scan_error?.message || "unknown_error",
      violation_count: 0,
    };
  }

  const metrics = collectBurstMetrics(rows, { now, claim_grace_ms });
  const worker_liveness_failures = metrics.violations.filter(
    (v) => v.code === BURST_LIVENESS_VIOLATIONS.WORKER_LIVENESS_FAILURE
  );
  // "never attempted" (the 2026-08-03 outage signature) must stay separable
  // from "attempted and failed".
  const tried_and_failed = metrics.violations.filter(
    (v) =>
      v.code === BURST_LIVENESS_VIOLATIONS.RETRIES_EXHAUSTED_NOT_TERMINAL ||
      v.code === BURST_LIVENESS_VIOLATIONS.STALE_CLAIMED_PAST_LEASE
  );

  return {
    ok: true,
    // A capped scan must never masquerade as a complete one. When `truncated`
    // is true every count below is a LOWER BOUND on the real backlog.
    truncated,
    row_limit: limit,
    scan_complete: !truncated,
    scanned_count: rows.length,
    counts: metrics.counts,
    violations: metrics.violations,
    violation_count: metrics.violations.length,
    p0_violation_count: metrics.p0_violation_count,
    worker_liveness_failure_count: worker_liveness_failures.length,
    tried_and_failed_count: tried_and_failed.length,
    time_to_claim: metrics.time_to_claim,
    time_to_complete: metrics.time_to_complete,
  };
}

function summarizeDurations(values) {
  if (!values.length) return { count: 0, p50_ms: null, max_ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: sorted[Math.floor((sorted.length - 1) / 2)],
    max_ms: sorted[sorted.length - 1],
  };
}

export default evaluateBurstLiveness;
