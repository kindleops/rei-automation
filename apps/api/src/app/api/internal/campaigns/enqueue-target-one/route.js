import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import { supabase } from "@/lib/supabase/client.js";
import {
  enqueueCampaignTargetOne,
  previewCampaignTargetOne,
} from "@/lib/domain/campaigns/enqueue-campaign-target-one.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const logger = child({ module: "api.internal.campaigns.enqueue_target_one" });

/**
 * Target-addressed single-row campaign enqueue.
 *
 * Deliberately a separate action from `queue_one`, which is left untouched.
 * `queue_one` resolves its recipient through the legacy candidate feeder and
 * cannot be pointed at a campaign target; overloading it would have made one
 * action mean two different things depending on which parameters were present.
 *
 *   POST { campaign_target_id, dry_run?: boolean }
 *
 * `dry_run` defaults to TRUE. Creating a real outbound row is the exceptional
 * case and has to be asked for explicitly — the default behaviour of this
 * endpoint is to show you what would happen.
 *
 * One request creates at most one queue row, for exactly the named target.
 * It never sends: dispatch remains with the queue processor via
 * send_one_queue_row.
 */
async function handle(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  const body = await request.json().catch(() => ({}));
  const campaignTargetId = String(body.campaign_target_id ?? body.campaignTargetId ?? "").trim();

  if (!campaignTargetId) {
    return NextResponse.json(
      { ok: false, error: "campaign_target_id_required" },
      { status: 400 }
    );
  }

  // Opt-in to writing. Anything other than an explicit false stays a dry run.
  const dryRun = body.dry_run === false || body.dryRun === false ? false : true;

  // Scoped canary-enqueue credentials. campaign_mode stays `paused` globally;
  // these open the gate for exactly one authorized (campaign, target,
  // recipient) triple and nothing else. Absent credentials => ordinary
  // behaviour, i.e. still blocked by the mode gate.
  const canaryRunId = String(body.canary_run_id ?? body.canaryRunId ?? "").trim();
  const canaryAuthorizationToken = String(
    body.canary_authorization_token ?? body.canaryAuthorizationToken ?? ""
  ).trim();
  const canaryDeps = { supabase, canaryRunId, canaryAuthorizationToken };

  try {
    const result = dryRun
      ? await previewCampaignTargetOne(campaignTargetId, canaryDeps)
      : await enqueueCampaignTargetOne(campaignTargetId, canaryDeps);

    // The invariant is fatal: surface it as a server error rather than a
    // routine "not created", because it means something substituted a
    // different recipient.
    if (result?.fatal) {
      logger.error("enqueue_target_one.invariant_violation", {
        requested: campaignTargetId,
        resulting: result.resulting_campaign_target_id ?? null,
      });
      return NextResponse.json({ ok: false, dry_run: dryRun, ...result }, { status: 500 });
    }

    logger.info("enqueue_target_one.completed", {
      campaign_target_id: campaignTargetId,
      dry_run: dryRun,
      created: Boolean(result?.created),
      reason: result?.reason ?? null,
    });

    return NextResponse.json(
      { ok: true, dry_run: dryRun, ...result },
      { status: 200 }
    );
  } catch (err) {
    // Log the detail, return a stable code. Postgres errors carry table,
    // column and constraint names, and this route is reachable by anything
    // holding the internal secret — no reason to hand schema back over HTTP.
    logger.error("enqueue_target_one.exception", { error: err?.message || String(err) });
    return NextResponse.json(
      { ok: false, error: "enqueue_target_one_exception" },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  return handle(request);
}
