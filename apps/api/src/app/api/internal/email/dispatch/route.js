/**
 * Email dispatch tick — POST /api/internal/email/dispatch (Cloudflare cron,
 * send lane, every minute). The one email sender: bridge closing requests,
 * revalidate + send due messages, fetch inbound attachments, evaluate health.
 * Sends nothing unless EMAIL_SEND_ENABLED=true AND system_control
 * email_enabled='true' — a disabled tick still writes its heartbeat.
 */
import { NextResponse } from "next/server.js";

import { requireScheduledMutationAuth } from "@/lib/security/cron-auth.js";
import { supabase } from "@/lib/supabase/client.js";
import { runEmailDispatch } from "@/lib/domain/email/email-dispatch.js";
import "@/lib/domain/email/email-seller-channel.js"; // registers the seller revalidator
import { fetchPendingBrevoAttachments } from "@/lib/domain/email/email-attachments.js";
import { gatherEmailHealthFacts, evaluateEmailHealth } from "@/lib/domain/email/email-health.js";
import { emitNotificationFromBusinessEvent } from "@/lib/domain/notifications/notification-emitter.js";
import { child } from "@/lib/logging/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const logger = child({ module: "api.internal.email.dispatch" });
export const ROUTE_NAME = "internal/email/dispatch";

export async function POST(request) {
  const auth = requireScheduledMutationAuth(request, logger);
  if (!auth.authorized) return auth.response;
  try {
    const dispatch = await runEmailDispatch({});
    const attachments = await fetchPendingBrevoAttachments(supabase).catch((e) => ({ error: e.message }));
    const health = evaluateEmailHealth(await gatherEmailHealthFacts(supabase));
    await supabase.from("system_control").upsert({ key: "email_health_last", value: JSON.stringify({ status: health.status, issues: health.issues.map((i) => i.code), at: health.evaluated_at }) }, { onConflict: "key" });
    for (const issue of health.issues.filter((i) => i.severity === "critical" && i.code !== "email_dispatcher_stale")) {
      // Hourly dedupe per issue: an outage alerts, it does not spam.
      await emitNotificationFromBusinessEvent({ eventType: "email_delivery_degraded", severity: "critical", titleVars: { reason: issue.code.replace(/^email_/, "").replace(/_/g, " ") }, description: issue.message, sourceEntityType: "email_health", sourceEntityId: issue.code, deduplicationKey: `email_health:${issue.code}:${issue.domain || ""}:${new Date().toISOString().slice(0, 13)}` }).catch(() => null);
    }
    if (dispatch.sent || dispatch.failed || dispatch.escalated || dispatch.errors?.length) {
      logger.info("email_dispatch.tick", { sent: dispatch.sent, failed: dispatch.failed, escalated: dispatch.escalated, superseded: dispatch.superseded, errors: dispatch.errors?.length || 0 });
    }
    return NextResponse.json({ ok: true, route: ROUTE_NAME, dispatch, attachments, health: { status: health.status, issues: health.issues } });
  } catch (error) {
    logger.error("email_dispatch.failed", { error: error?.message || "unknown" });
    return NextResponse.json({ ok: false, route: ROUTE_NAME, error: "email_dispatch_failed", message: error?.message || "failed" }, { status: 500 });
  }
}
