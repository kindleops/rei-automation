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

    /**
     * POST-REFRESH INTEGRITY GATE.
     *
     * A refresh that writes rows is not a refresh that works. On 2026-08-26
     * this pipeline completed with 169,797 rows and reported success, while the
     * campaign path could not build a single ready target — and nothing said
     * so for three weeks. Row count alone cannot see that.
     *
     * The health check asserts canonical identity linkage
     * (seller_person_key + canonical_e164) against sanity bounds. If it fails,
     * the refresh is reported as FAILED even though the RPC returned rows, so
     * the condition is loud instead of silent.
     */
    const { data: healthData, error: healthError } = await supabase.rpc(
      "campaign_target_graph_linkage_health"
    );
    const health = Array.isArray(healthData) ? healthData[0] : healthData;

    if (healthError) {
      // Unable to verify is not the same as verified.
      logger.error("rebuild_target_graph.health_check_unavailable", { error: healthError.message });
      return NextResponse.json(
        {
          ok: false,
          error: "rebuild_target_graph_health_unverified",
          message: `Refresh wrote ${graphRows} rows but linkage health could not be verified: ${healthError.message}`,
          graph_rows: graphRows,
          facet_rows: facetRows,
        },
        { status: 500 }
      );
    }

    if (health && health.healthy === false) {
      logger.error("rebuild_target_graph.linkage_unhealthy", {
        graph_rows: graphRows,
        failures: health.failures,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "rebuild_target_graph_linkage_unhealthy",
          message:
            `Refresh wrote ${graphRows} rows but identity linkage failed validation: ` +
            `${(health.failures || []).join("; ")}. Not publishing this as a successful refresh.`,
          graph_rows: graphRows,
          facet_rows: facetRows,
          linkage_health: health,
        },
        { status: 500 }
      );
    }

    logger.info("rebuild_target_graph.completed", {
      graph_rows: graphRows,
      facet_rows: facetRows,
      canonical_linked_queue_eligible: health?.canonical_linked_queue_eligible ?? null,
    });

    return NextResponse.json(
      {
        ok: true,
        route: "internal/campaigns/rebuild-target-graph",
        graph_rows: graphRows,
        facet_rows: facetRows,
        linkage_health: health ?? null,
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
