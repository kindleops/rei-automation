import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
// Same canonical operational credential as enqueue-target-one. Authentication
// here proves the caller is the queue engine; it confers no sending authority,
// because this route has no path to a send_queue insert or a dispatch.
import { requireQueueEngineInternalAuth } from "@/lib/security/queue-engine-internal-auth.js";
import { supabase } from "@/lib/supabase/client.js";
import { repairCampaignTargetReadiness } from "@/lib/domain/campaigns/repair-campaign-target-readiness.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const logger = child({ module: "api.internal.campaigns.repair_target_readiness" });

/**
 * Target-scoped readiness repair.
 *
 *   POST { campaign_target_id }
 *
 * Deliberately NOT a proxy onto the cockpit lifecycle surface. That surface can
 * activate a campaign, enable auto-send and hydrate a queue; exposing it to the
 * queue-engine credential would hand a one-row preparation step the authority
 * to launch a campaign. This route reaches exactly one function, which can only
 * resolve a market and select a governed template for a single named target.
 *
 * There is no template_id parameter, and adding one would be a defect: template
 * choice belongs to governance, not to the caller.
 */
async function handle(request) {
  const auth = await requireQueueEngineInternalAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  const body = await request.json().catch(() => ({}));
  const campaignTargetId = String(
    body.campaign_target_id ?? body.campaignTargetId ?? ""
  ).trim();

  if (!campaignTargetId) {
    return NextResponse.json(
      { ok: false, error: "campaign_target_id_required" },
      { status: 400 }
    );
  }

  try {
    const result = await repairCampaignTargetReadiness(
      { campaign_target_id: campaignTargetId },
      { supabase }
    );

    logger.info("repair_target_readiness.completed", {
      campaign_target_id: campaignTargetId,
      ok: result.ok,
      reason: result.reason,
      template_id: result.template_id ?? null,
      market: result.market ?? null,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    logger.error("repair_target_readiness.failed", {
      campaign_target_id: campaignTargetId,
      message: error?.message || String(error),
    });
    return NextResponse.json(
      { ok: false, error: "repair_target_readiness_failed", message: error?.message || String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  return handle(request);
}
