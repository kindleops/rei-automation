import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import { supabase } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const logger = child({ module: "api.internal.campaigns.rebuild-target-graph" });

// Full rebuild of campaign_target_graph via the staged refresh pipeline.
// Calls refresh_campaign_target_graph() which runs all property batches and
// commits with graph_refresh_scope='full'. Takes ~2-3 min for 120k+ rows.
// Requires INTERNAL_API_SECRET / CRON_SECRET in Authorization header.
async function handle(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status ?? 401 }
    );
  }

  logger.info("rebuild_target_graph.started");

  try {
    const { data, error } = await supabase.rpc("refresh_campaign_target_graph");

    if (error) {
      logger.error("rebuild_target_graph.rpc_failed", { error: error.message });
      return NextResponse.json(
        {
          ok: false,
          error: "rebuild_target_graph_rpc_failed",
          message: error.message,
        },
        { status: 500 }
      );
    }

    const result = Array.isArray(data) ? data[0] : data;
    const graphRows = Number(result?.graph_rows ?? 0);
    const facetRows = Number(result?.facet_rows ?? 0);

    logger.info("rebuild_target_graph.completed", { graph_rows: graphRows, facet_rows: facetRows });

    return NextResponse.json(
      {
        ok: true,
        route: "internal/campaigns/rebuild-target-graph",
        graph_rows: graphRows,
        facet_rows: facetRows,
      },
      { status: 200 }
    );
  } catch (err) {
    const message = err?.message || String(err);
    logger.error("rebuild_target_graph.exception", { error: message });
    return NextResponse.json(
      { ok: false, error: "rebuild_target_graph_exception", message },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  return handle(request);
}
