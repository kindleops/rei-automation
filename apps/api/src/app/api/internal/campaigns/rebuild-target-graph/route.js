import { NextResponse } from "next/server";

import {
  evaluateGraphCommitIntegrity,
  measureGraphCommitState,
} from "@/lib/domain/campaigns/campaign-target-graph-integrity.js";
import { child } from "@/lib/logging/logger.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import { supabase } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const logger = child({ module: "api.internal.campaigns.rebuild-target-graph" });

/**
 * The exact population `..._stage_batch` can stage — mirrors its source
 * predicate (`NULLIF(properties.master_owner_id,'') IS NOT NULL`). Counted
 * server-side, so it is not subject to PostgREST's max-rows clamp.
 */
async function countOwnerLinkedProperties(client) {
  const { count, error } = await client
    .from("properties")
    .select("property_id", { count: "exact", head: true })
    .not("master_owner_id", "is", null)
    .neq("master_owner_id", "");
  if (error) throw error;
  return Number(count || 0);
}

/**
 * Rebuild of campaign_target_graph via the staged refresh pipeline.
 *
 * ── READ THIS BEFORE REMOVING THE PREFLIGHT ─────────────────────────────────
 * `refresh_campaign_target_graph()` wraps
 * `refresh_campaign_target_graph_staged(10000, NULL)`, which loops ONLY
 * `..._stage_batch` — whose source predicate requires
 * `properties.master_owner_id IS NOT NULL`.
 *
 * The live graph was built by TWO passes: that one plus `..._fallback_batch`,
 * which has no owner requirement. 809 of 1,219 historical batches were fallback
 * batches. So this route is NOT capable of reproducing the graph it replaces.
 *
 * Measured 2026-08-17 against production:
 *     live graph                         124,046 rows (94,723 owner-linked)
 *     properties with master_owner_id      41,532
 *     net effect of running this route    -82,514 rows (-67%)
 *
 * The database's own `refused_partial_commit` guard does NOT catch this: it
 * only asks whether the run completed all of ITS batches, which it does. The
 * run's definition of "all" is the bug.
 *
 * The two prior comments here were also wrong and are corrected: the runtime is
 * not "~2-3 min" (observed full runs: 51.5 and 57.7 minutes, against this
 * route's 300s ceiling), and completing "all property batches" is only true of
 * the owner-linked pass.
 *
 * Until the pipeline is fixed to run both passes, this route refuses to
 * execute. It fails closed: an unreadable measurement blocks, it does not pass.
 * Override is explicit and must be deliberate.
 */
async function handle(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status ?? 401 }
    );
  }

  // There is deliberately NO override here.
  //
  // An earlier revision accepted `?i_understand_this_shrinks_the_graph=true`.
  // A query parameter is not an authorization boundary: it is not privileged,
  // carries no identity, records no reason, and anything that can reach this
  // route can set it. It made the guard advisory, which is the same as not
  // having one.
  //
  // A graph rebuild that fails integrity is not a thing to force through an
  // HTTP knob. Repair the input (see docs/backend/campaign_target_graph_contract.md),
  // or perform the commit deliberately at the database boundary where the
  // actor, reason, and before/after metrics are recorded.

  // ── PREFLIGHT ─────────────────────────────────────────────────────────────
  // Projected, not hypothetical: this route can only ever stage the
  // owner-linked subset, so we can evaluate the outcome before committing to
  // it. The staged counts are the counts this run WOULD produce.
  let preflight;
  try {
    const live = await measureGraphCommitState(supabase);
    const ownerLinkedSource = await countOwnerLinkedProperties(supabase);
    preflight = evaluateGraphCommitIntegrity({
      stagedRows: ownerLinkedSource,
      stagedDistinctProperties: ownerLinkedSource,
      stagedWithOwner: ownerLinkedSource, // this pass stages only owner-linked rows
      liveRows: live.liveRows,
      liveWithOwner: live.liveWithOwner,
      sourceUniverse: live.sourceUniverse,
    });
  } catch (error) {
    // Fail closed — we could not prove the rebuild is safe.
    const message = error?.message || String(error);
    logger.error("rebuild_target_graph.preflight_unavailable", { error: message });
    return NextResponse.json(
      {
        ok: false,
        error: "rebuild_target_graph_preflight_unavailable",
        message: `Refusing to rebuild: integrity preflight could not be evaluated (${message}).`,
      },
      { status: 503 }
    );
  }

  if (!preflight.ok) {
    logger.error("rebuild_target_graph.blocked_by_integrity", {
      violations: preflight.violations,
      metrics: preflight.metrics,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "rebuild_target_graph_integrity_blocked",
        message:
          "Refusing to rebuild the campaign target graph: the staged result would be smaller or " +
          "less owner-linked than the live graph. This route runs only the owner-linked pass and " +
          "cannot reproduce the two-pass graph it would replace.",
        violations: preflight.violations,
        metrics: preflight.metrics,
        thresholds: preflight.thresholds,
        override: null,
        remedy:
          "This block cannot be overridden over HTTP. Repair the ownership input " +
          "so the rebuild no longer shrinks the graph.",
      },
      { status: 409 }
    );
  }

  logger.info("rebuild_target_graph.started", {
    preflight_ok: preflight.ok, // always true here — a failed preflight has already returned 409
    metrics: preflight.metrics,
  });

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
