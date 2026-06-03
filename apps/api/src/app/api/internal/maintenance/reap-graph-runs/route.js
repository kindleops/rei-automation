import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { requireCronAuth } from "@/lib/security/cron-auth.js";
import { supabase } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.internal.maintenance.reap-graph-runs" });

// Periodic hygiene for the campaign target graph refresh runs.
// refresh_campaign_target_graph_stage_start() already reaps stale runs on each
// new refresh, but that only fires when someone starts a refresh. This cron marks
// orphaned status='started' runs (whose owning process died) as failed on a fixed
// cadence so the runs table stays clean and degraded refreshes surface promptly.
// The underlying RPC keys staleness on last BATCH activity, so it never reaps a
// healthy in-flight refresh. Idempotent and low-harm.
async function handle(request) {
  const auth = requireCronAuth(request, logger);
  if (!auth.authorized) return auth.response;

  try {
    const { data, error } = await supabase.rpc(
      "reap_stale_campaign_target_graph_refresh_runs"
    );

    if (error) {
      logger.error("reap_graph_runs.failed", { error: error.message });
      return NextResponse.json(
        { ok: false, error: "reap_graph_runs_failed", message: error.message },
        { status: 500 }
      );
    }

    const reaped = Number(data || 0);
    logger.info("reap_graph_runs.completed", {
      reaped,
      is_vercel_cron: auth.auth.is_vercel_cron,
    });

    return NextResponse.json(
      { ok: true, route: "internal/maintenance/reap-graph-runs", reaped },
      { status: 200 }
    );
  } catch (error) {
    const message = error?.message || String(error);
    logger.error("reap_graph_runs.exception", { error: message });
    return NextResponse.json(
      { ok: false, error: "reap_graph_runs_exception", message },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  return handle(request);
}

export async function POST(request) {
  return handle(request);
}
