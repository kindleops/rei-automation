// Inbound terminal-disposition SLO scan.
//
// Launch invariant: EVERY inbound event reaches one explicit terminal
// disposition. This endpoint is the enforcement loop for the residual gap the
// recorder cannot cover (its own process dying, ledger write failures): any
// inbound_processing_ledger row still 'processing' past the SLA — or stuck in
// failed_retriable past the retry horizon — raises the P0
// inbound_no_disposition launch-critical alert (durable notification_events
// row + Discord fan-out via the alert layer).
//
// Auth: internal secret / cron, same contract as the other internal scanners.

import { NextResponse } from "next/server";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import { scanBurstLiveness } from "@/lib/domain/seller-flow/seller-inbound-burst-liveness.js";
import { findInboundLedgerSlaBreaches } from "@/lib/domain/inbound/inbound-processing-ledger.js";
import { launchAlerts } from "@/lib/domain/alerts/launch-critical-alerts.js";
import { info, warn } from "@/lib/logging/logger.js";

export const dynamic = "force-dynamic";

const DEFAULT_SLA_MINUTES = 10;
const DEFAULT_RETRY_HORIZON_MINUTES = 60;
// Upper bounds keep a typo'd (or hostile) query string from neutering the
// watchdog: a negative window moves the cutoff into the future and pages on a
// healthy system; an enormous window hides every real breach.
const MAX_SLA_MINUTES = 1440; // 24h
const MAX_RETRY_HORIZON_MINUTES = 10080; // 7d

// Bounded positive integer minutes. Invalid, NaN, zero, and negative input
// fall back to the default; fractional values round (floor 1); excessive
// values clamp to the ceiling.
export function clampScanMinutes(raw, fallback, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.round(parsed)), max);
}

export async function handleDispositionSloScanRequest(request, deps = {}) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, reason: auth.error || "unauthorized" },
      { status: auth.status || 401 }
    );
  }

  const search_params = new URL(request.url).searchParams;
  const sla_minutes = clampScanMinutes(
    search_params.get("sla_minutes"),
    DEFAULT_SLA_MINUTES,
    MAX_SLA_MINUTES
  );
  const retry_horizon_minutes = clampScanMinutes(
    search_params.get("retry_horizon_minutes"),
    DEFAULT_RETRY_HORIZON_MINUTES,
    MAX_RETRY_HORIZON_MINUTES
  );

  const scan_for_breaches = deps.findInboundLedgerSlaBreaches || findInboundLedgerSlaBreaches;
  const scan = await scan_for_breaches({
    sla_minutes,
    retry_horizon_minutes,
  });

  // The ledger is only half the picture. The 2026-08-03 outage was invisible
  // here because the stuck inbound had been (incorrectly) marked terminal in
  // the ledger while its burst sat open forever. The scanner must inspect burst
  // state too. Read-only: it never mutates or completes a burst.
  const scan_burst_liveness = deps.scanBurstLiveness || scanBurstLiveness;
  // Production must use the canonical service-role client. Passing null here
  // made every deployed invocation return supabase_unconfigured and scan
  // nothing — the watchdog existed but never looked at anything.
  const resolve_supabase = deps.resolveSupabase || resolveCanonicalSupabase;
  let burst_supabase = deps.supabase || null;
  if (!burst_supabase) {
    burst_supabase = await resolve_supabase();
  }
  const burst_scan = await scan_burst_liveness({
    supabase: burst_supabase,
    now: deps.now ? deps.now() : undefined,
  }).catch((error) => ({
    ok: false,
    reason: "burst_scan_failed",
    message: error?.message || "unknown_error",
    violation_count: 0,
  }));

  const alerts = deps.launchAlerts || launchAlerts;

  if (!burst_scan.ok) {
    // A failed burst scan must never read as "no burst problems".
    warn("inbound_disposition_slo.burst_scan_failed", { reason: burst_scan.reason });
    // Only a genuinely absent table degrades quietly. An unconfigured client in
    // production means the scan looked at nothing, which must never be mistaken
    // for a healthy result.
    if (burst_scan.reason !== "burst_table_missing") {
      await alerts
        .burstLivenessFailure({ scan_failed: true, scan_failure_reason: burst_scan.reason })
        .catch(() => {});
    }
  } else if (burst_scan.violation_count > 0) {
    await alerts
      .burstLivenessFailure({
        violation_count: burst_scan.violation_count,
        p0_violation_count: burst_scan.p0_violation_count,
        worker_liveness_failure_count: burst_scan.worker_liveness_failure_count,
        tried_and_failed_count: burst_scan.tried_and_failed_count,
        counts: burst_scan.counts,
        sample: burst_scan.violations.slice(0, 5).map((v) => ({
          code: v.code,
          severity: v.severity,
          burst_id: v.burst_id,
        })),
      })
      .catch((error) => {
        warn("inbound_disposition_slo.burst_alert_failed", { error: error?.message });
      });
  }

  if (!scan.ok) {
    // The scanner itself failing must be visible: a broken watchdog reads
    // exactly like a healthy system with zero breaches.
    warn("inbound_disposition_slo.scan_failed", { reason: scan.reason });
    if (scan.reason !== "ledger_table_missing") {
      await alerts
        .inboundNoDisposition({
          scan_failed: true,
          scan_failure_reason: scan.reason,
          sla_minutes,
        })
        .catch(() => {});
    }
    return NextResponse.json(
      { ok: false, reason: scan.reason, breach_count: 0, burst_liveness: burst_scan },
      { status: scan.reason === "ledger_table_missing" ? 200 : 500 }
    );
  }

  if (scan.breach_count > 0) {
    await alerts
      .inboundNoDisposition({
        breach_count: scan.breach_count,
        stuck_processing_count: scan.stuck_processing.length,
        exhausted_retry_count: scan.exhausted_retries.length,
        sla_minutes,
        retry_horizon_minutes,
        sample: [...scan.stuck_processing, ...scan.exhausted_retries]
          .slice(0, 5)
          .map((row) => ({
            idempotency_key: row.idempotency_key,
            provider_message_sid: row.provider_message_sid,
            received_at: row.received_at,
            status: row.status,
            attempt_count: row.attempt_count,
          })),
      })
      .catch((error) => {
        warn("inbound_disposition_slo.alert_failed", { error: error?.message });
      });
  }

  info("inbound_disposition_slo.scan_completed", {
    burst_violation_count: burst_scan.violation_count,
    burst_worker_liveness_failures: burst_scan.worker_liveness_failure_count ?? 0,
    burst_counts: burst_scan.counts,
    breach_count: scan.breach_count,
    stuck_processing_count: scan.stuck_processing.length,
    exhausted_retry_count: scan.exhausted_retries.length,
  });

  return NextResponse.json({
    ok: true,
    breach_count: scan.breach_count,
    burst_liveness: burst_scan,
    stuck_processing: scan.stuck_processing,
    exhausted_retries: scan.exhausted_retries,
    sla_minutes,
    retry_horizon_minutes,
  });
}

/**
 * Canonical server-side service-role client for the production scan path.
 * Injectable via deps.resolveSupabase so the wiring is testable in an
 * environment that intentionally has no Supabase configuration.
 */
export async function resolveCanonicalSupabase() {
  try {
    const { hasSupabaseConfig } = await import("@/lib/supabase/client.js");
    if (!hasSupabaseConfig()) return null;
    const { getDefaultSupabaseClient } = await import("@/lib/supabase/default-client.js");
    return getDefaultSupabaseClient() || null;
  } catch {
    return null;
  }
}

export async function GET(request) {
  return handleDispositionSloScanRequest(request);
}

export async function POST(request) {
  return handleDispositionSloScanRequest(request);
}
