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
import { findInboundLedgerSlaBreaches } from "@/lib/domain/inbound/inbound-processing-ledger.js";
import { launchAlerts } from "@/lib/domain/alerts/launch-critical-alerts.js";
import { info, warn } from "@/lib/logging/logger.js";

export const dynamic = "force-dynamic";

const DEFAULT_SLA_MINUTES = 10;
const DEFAULT_RETRY_HORIZON_MINUTES = 60;

async function runScan(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, reason: auth.error || "unauthorized" },
      { status: auth.status || 401 }
    );
  }

  const search_params = new URL(request.url).searchParams;
  const sla_minutes = Number(search_params.get("sla_minutes")) || DEFAULT_SLA_MINUTES;
  const retry_horizon_minutes =
    Number(search_params.get("retry_horizon_minutes")) || DEFAULT_RETRY_HORIZON_MINUTES;

  const scan = await findInboundLedgerSlaBreaches({
    sla_minutes,
    retry_horizon_minutes,
  });

  if (!scan.ok) {
    // The scanner itself failing must be visible: a broken watchdog reads
    // exactly like a healthy system with zero breaches.
    warn("inbound_disposition_slo.scan_failed", { reason: scan.reason });
    if (scan.reason !== "ledger_table_missing") {
      await launchAlerts
        .inboundNoDisposition({
          scan_failed: true,
          scan_failure_reason: scan.reason,
          sla_minutes,
        })
        .catch(() => {});
    }
    return NextResponse.json(
      { ok: false, reason: scan.reason, breach_count: 0 },
      { status: scan.reason === "ledger_table_missing" ? 200 : 500 }
    );
  }

  if (scan.breach_count > 0) {
    await launchAlerts
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
    breach_count: scan.breach_count,
    stuck_processing_count: scan.stuck_processing.length,
    exhausted_retry_count: scan.exhausted_retries.length,
  });

  return NextResponse.json({
    ok: true,
    breach_count: scan.breach_count,
    stuck_processing: scan.stuck_processing,
    exhausted_retries: scan.exhausted_retries,
    sla_minutes,
    retry_horizon_minutes,
  });
}

export async function GET(request) {
  return runScan(request);
}

export async function POST(request) {
  return runScan(request);
}
