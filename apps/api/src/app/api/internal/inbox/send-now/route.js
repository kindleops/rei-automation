/**
 * Inbox Manual Send-Now Endpoint
 * POST /api/internal/inbox/send-now
 *
 * Creates a send_queue row for a manual inbox "send now" action.
 * Validates all required fields before inserting.
 * Returns 400 with clear error message on validation failure.
 */
import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { requireOpsDashboardAuth } from "@/lib/security/dashboard-auth.js";
import { createInboxSendNowQueueRow } from "@/lib/domain/inbox/send-now-service.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { processSendQueueItem } from "@/lib/domain/queue/process-send-queue.js";
import { classifyQueueBusinessOutcome } from "@/lib/domain/queue/failure-classifier.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.internal.inbox.send_now" });

function clean(value) {
  return String(value ?? "").trim();
}

export async function POST(request) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────
    const auth = requireOpsDashboardAuth(request);
    if (!auth.authorized) return auth.response;

    // ── System control gate ──────────────────────────────────────────
    const dashboard_live_enabled = await getSystemFlag("dashboard_live_enabled");
    if (!dashboard_live_enabled) {
      return NextResponse.json(
        {
          ok: false,
          error: "system_control_disabled",
          flag_key: "dashboard_live_enabled",
          context: "internal-inbox-send-now",
        },
        { status: 423 }
      );
    }

    // ── Parse body ──────────────────────────────────────────────────
    const body = await request.json().catch(() => ({}));

    logger.info("inbox_send_now.requested", {
      has_thread_key: Boolean(clean(body.thread_key)),
      message_body_length: clean(body.message_body)?.length || 0,
    });

    // ── Create queue row via service ─────────────────────────────────
    const result = await createInboxSendNowQueueRow(body);
    let row_result = null;
    const dry_run = body?.dry_run === true;
    if (result?.queue_created && result?.queue_row_id && !dry_run) {
      row_result = await processSendQueueItem(result.queue_row_id, { now: new Date().toISOString() });
    }

    logger.info("inbox_send_now.completed", {
      ok: result.ok,
      status: result.status,
      error: result.error || null,
      queue_created: result.queue_created,
    });

    return NextResponse.json(
      {
        ok: true,
        handled: true,
        outcome: result.ok ? "queued" : "blocked",
        error: result.error || null,
        queue_id: result.queue_id || null,
        queue_key: result.queue_key || null,
        queue_row_id: result.queue_row_id || null,
        row_result,
        failure: result.ok ? null : {
          reason: result.error || "send_now_blocked",
          failure_bucket: classifyQueueBusinessOutcome({ reason: result.error })?.failure_bucket || null,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    const handled = classifyQueueBusinessOutcome({
      message: error?.message,
      reason: error?.reason,
      code: error?.code || error?.status,
    });
    if (handled?.handled) {
      return NextResponse.json({
        ok: true,
        handled: true,
        outcome: "failed",
        failure: handled,
      }, { status: 200 });
    }
    logger.error("inbox_send_now.failed", {
      error: error?.message || "unknown",
    });

    return NextResponse.json(
      {
        ok: false,
        error: "inbox_send_now_failed",
        message: error?.message || "Unknown error",
      },
      { status: 500 }
    );
  }
}
