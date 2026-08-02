// Inbound ledger retention purge.
//
// PII retention enforcement: inbound_processing_ledger rows carry seller phone
// numbers and message-body digests, and every row carries retain_until
// (receipt + INBOUND_LEDGER_RETENTION_DAYS). This endpoint hard-deletes rows
// past that deadline in bounded select-then-delete batches so the documented
// retention window is enforced, not just declared. Scheduled daily via the
// vercel.json cron.
//
// Auth: internal secret / cron, same contract as the other internal scanners.

import { NextResponse } from "next/server";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import {
  INBOUND_LEDGER_RETENTION_DAYS,
  purgeExpiredInboundLedgerRows,
} from "@/lib/domain/inbound/inbound-processing-ledger.js";
import { purgeExpiredWebhookRequestReceipts } from "@/lib/domain/webhooks/webhook-request-receipts.js";
import { info, warn } from "@/lib/logging/logger.js";

export const dynamic = "force-dynamic";

const DEFAULT_BATCH_LIMIT = 500;
const MAX_BATCH_LIMIT = 2000;
const DEFAULT_MAX_BATCHES = 10;
const MAX_MAX_BATCHES = 50;

// Bounded positive integer. Invalid, NaN, zero, and negative input fall back
// to the default; fractional values round (floor 1); excessive values clamp.
export function clampPurgeCount(raw, fallback, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.round(parsed)), max);
}

export async function handleLedgerRetentionPurgeRequest(request, deps = {}) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, reason: auth.error || "unauthorized" },
      { status: auth.status || 401 }
    );
  }

  const search_params = new URL(request.url).searchParams;
  const batch_limit = clampPurgeCount(
    search_params.get("limit"),
    DEFAULT_BATCH_LIMIT,
    MAX_BATCH_LIMIT
  );
  const max_batches = clampPurgeCount(
    search_params.get("max_batches"),
    DEFAULT_MAX_BATCHES,
    MAX_MAX_BATCHES
  );

  const purge = deps.purgeExpiredInboundLedgerRows || purgeExpiredInboundLedgerRows;

  let purged_total = 0;
  let batches = 0;
  let more = false;
  while (batches < max_batches) {
    const result = await purge({ limit: batch_limit });
    if (!result.ok) {
      // A broken purge must be visible: silently skipping it means seller PII
      // outlives the documented retention window. ledger_table_missing is the
      // pre-migration state — nothing retained, nothing to purge.
      warn("inbound_ledger_retention.purge_failed", {
        reason: result.reason,
        batches,
        purged: purged_total,
      });
      return NextResponse.json(
        { ok: false, reason: result.reason, purged: purged_total, batches },
        { status: result.reason === "ledger_table_missing" ? 200 : 500 }
      );
    }
    batches += 1;
    purged_total += result.purged || 0;
    more = Boolean(result.more);
    if (!more) break;
  }

  // Same retention contract for route-level request receipts (masked/hashed
  // phone identifiers + body digests). A receipt-purge failure is reported
  // but does not mask a successful ledger purge; receipt_table_missing is
  // the pre-migration state.
  const purge_receipts =
    deps.purgeExpiredWebhookRequestReceipts || purgeExpiredWebhookRequestReceipts;
  let receipts_purged_total = 0;
  let receipt_batches = 0;
  let receipts_more = false;
  let receipts_purge_reason = null;
  while (receipt_batches < max_batches) {
    const result = await purge_receipts({ limit: batch_limit });
    if (!result.ok) {
      receipts_purge_reason = result.reason;
      if (result.reason !== "receipt_table_missing") {
        warn("inbound_ledger_retention.receipts_purge_failed", {
          reason: result.reason,
          batches: receipt_batches,
          purged: receipts_purged_total,
        });
      }
      break;
    }
    receipt_batches += 1;
    receipts_purged_total += result.purged || 0;
    receipts_more = Boolean(result.more);
    if (!receipts_more) break;
  }

  info("inbound_ledger_retention.purge_completed", {
    purged: purged_total,
    batches,
    more,
    receipts_purged: receipts_purged_total,
    receipt_batches,
    receipts_more,
    retention_days: INBOUND_LEDGER_RETENTION_DAYS,
  });

  return NextResponse.json({
    ok: true,
    purged: purged_total,
    batches,
    more,
    receipts_purged: receipts_purged_total,
    receipt_batches,
    receipts_more,
    receipts_purge_reason,
    retention_days: INBOUND_LEDGER_RETENTION_DAYS,
  });
}

export async function GET(request) {
  return handleLedgerRetentionPurgeRequest(request);
}

export async function POST(request) {
  return handleLedgerRetentionPurgeRequest(request);
}
