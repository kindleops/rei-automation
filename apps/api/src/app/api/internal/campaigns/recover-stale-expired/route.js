import { NextResponse } from "next/server";

import {
  analyzeReplaceableExpiredTargets,
  recoverCampaignStaleExpiredTargets,
} from "@/lib/domain/campaigns/campaign-stale-expiration-recovery.js";
import { getQueueRouteDeploymentMeta } from "@/lib/domain/queue/queue-route-deployment-meta.js";
import { requireCronOrEngineAuth } from "@/lib/security/cron-auth.js";
import { child } from "@/lib/logging/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({
  module: "api.internal.campaigns.recover_stale_expired",
});

function clean(value = "") {
  return String(value ?? "").trim();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

export async function GET(request) {
  const auth = await requireCronOrEngineAuth(request, logger);
  if (!auth.authorized) return auth.response;

  const { searchParams } = new URL(request.url);
  const campaignId = clean(searchParams.get("campaign_id"));
  if (!campaignId) {
    return NextResponse.json({ ok: false, error: "missing_campaign_id" }, { status: 400 });
  }

  const analysis = await analyzeReplaceableExpiredTargets(campaignId);
  return NextResponse.json({
    ok: true,
    route: "internal/campaigns/recover-stale-expired",
    deployment: getQueueRouteDeploymentMeta(request),
    analysis,
  });
}

export async function POST(request) {
  const auth = await requireCronOrEngineAuth(request, logger);
  if (!auth.authorized) return auth.response;

  const body = await request.json().catch(() => ({}));
  const campaignId = clean(body.campaign_id || body.campaignId);
  if (!campaignId) {
    return NextResponse.json({ ok: false, error: "missing_campaign_id" }, { status: 400 });
  }

  const result = await recoverCampaignStaleExpiredTargets(campaignId, {
    dry_run: asBoolean(body.dry_run, false),
    limit: body.limit,
    recovery_execution_id: body.recovery_execution_id,
    spread_interval_seconds: body.spread_interval_seconds,
  });

  return NextResponse.json({
    ok: result.ok !== false,
    route: "internal/campaigns/recover-stale-expired",
    deployment: getQueueRouteDeploymentMeta(request),
    result,
  });
}