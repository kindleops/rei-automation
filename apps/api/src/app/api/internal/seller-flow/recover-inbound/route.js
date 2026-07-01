import { NextResponse } from "next/server.js";

import { recoverUnprocessedInboundMessages } from "@/lib/domain/seller-flow/recover-unprocessed-inbound-messages.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { requireSharedSecretAuth } from "@/lib/security/shared-secret.js";
import { requireCronAuth } from "@/lib/security/cron-auth.js";
import { getSystemValue, setSystemValues } from "@/lib/system-control.js";
import { CANONICAL_FULL_AUTOPILOT_MODE } from "@/lib/domain/campaigns/campaign-live-execution.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function requireAuth(request) {
  const cronAuth = requireCronAuth(request);
  if (cronAuth.authorized) {
    return { authorized: true, via: "vercel_cron" };
  }
  return requireSharedSecretAuth(request, null, {
    env_name: "INTERNAL_API_SECRET",
    header_names: ["x-internal-api-secret"],
  });
}

async function runRecovery(body = {}) {
  const limit = Number(body.limit) || 25;
  const dryRun = body.dry_run === true;
  const autoReplyMode = body.auto_reply_mode || (await getSystemValue("auto_reply_mode")) || CANONICAL_FULL_AUTOPILOT_MODE;
  const proofCases = Array.isArray(body.proof_cases) ? body.proof_cases : null;

  const result = await recoverUnprocessedInboundMessages({
    supabaseClient: getDefaultSupabaseClient(),
    limit,
    dryRun,
    autoReplyMode,
    proofCases,
    messageEventId: body.message_event_id || body.messageEventId || null,
    bodyContains: body.body_contains || body.bodyContains || null,
    detectedIntent: body.detected_intent || body.detectedIntent || null,
  });

  if (!dryRun) {
    const heartbeatAt = new Date().toISOString();
    await setSystemValues({
      recovery_worker_heartbeat_at: heartbeatAt,
      follow_up_scheduler_heartbeat_at: heartbeatAt,
      recovery_worker_last_processed: String(result.processed ?? result.recovered ?? 0),
    });
  }

  return result;
}

export async function GET(request) {
  const auth = requireAuth(request);
  if (!auth.authorized) return auth.response;

  try {
    const result = await runRecovery({ dry_run: false, limit: 25 });
    return NextResponse.json(
      { ok: result.ok !== false, route: "internal/seller-flow/recover-inbound", cadence: "*/5 * * * *", ...result },
      { status: result.ok !== false ? 200 : 500 },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: "recovery_failed", error: error?.message || "recovery_failed" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  const auth = requireAuth(request);
  if (!auth.authorized) return auth.response;

  try {
    const body = await request.json().catch(() => ({}));
    const result = await runRecovery(body);
    return NextResponse.json(result, { status: result.ok !== false ? 200 : 500 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: "recovery_failed", error: error?.message || "recovery_failed" },
      { status: 500 }
    );
  }
}

export default POST;