/**
 * Seller-state reconciliation — the NARROW scheduled lane.
 * POST|GET /api/internal/seller-flow/reconcile-state
 *
 * WHY THIS EXISTS RATHER THAN SCHEDULING THE EXISTING ROUTE
 * ---------------------------------------------------------
 * /api/internal/seller-flow/recover-inbound is the only existing caller of the
 * canonical primitive, and it is far too broad to run unattended. It replays
 * unprocessed inbound messages with auto_reply_mode defaulting to
 * CANONICAL_FULL_AUTOPILOT_MODE, and it runs ALL SEVEN gap sweeps — including
 * ones that enqueue offers, schedule follow-ups, advance stages and create
 * closing cases.
 *
 * This route is an EXECUTION ADAPTER, not a second reconciler. It calls the
 * same canonical primitive (recoverSellerExecutionGaps) with an explicit
 * allowlist of exactly one sweep. There is no reconciliation logic here.
 *
 * WHAT THE ALLOWED SWEEP DOES
 *   stale_active_without_next_action reads inbox_thread_state rows that are
 *   active, non-archived, non-suppressed, stale, and have next_action NULL or
 *   the legacy empty-string sentinel. For each it copies the next_action that
 *   already exists on the canonical acquisition_opportunities row; when there
 *   is none it writes the non-send sentinel `human_review`. It never invents an
 *   outbound send, never guesses identity, and writes exactly one table
 *   (inbox_thread_state, via patchUniversalLeadState).
 *
 * THREE INDEPENDENT GATES, ALL DEFAULT-DENY
 *   1. requireScheduledMutationAuth — cron secret AND an unambiguous production
 *      deployment identity. Cloudflare staging is denied because it shares the
 *      production database.
 *   2. seller_state_reconcile_enabled — a system_control kill switch that fails
 *      closed on a missing row, a read error, or absent configuration. It lets
 *      an operator stop this lane instantly without a redeploy.
 *   3. The sweep allowlist itself, which is a constant in the primitive.
 */
import { NextResponse } from "next/server.js";

import {
  recoverSellerExecutionGaps,
  SCHEDULER_SAFE_SWEEPS,
} from "@/lib/domain/seller-flow/recover-seller-execution-gaps.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { requireScheduledMutationAuth } from "@/lib/security/cron-auth.js";
import { getSystemFlag, setSystemValues } from "@/lib/system-control.js";
import { child } from "@/lib/logging/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const logger = child({ module: "api.internal.seller_flow.reconcile_state" });

export const ENABLE_FLAG = "seller_state_reconcile_enabled";
export const ROUTE_NAME = "internal/seller-flow/reconcile-state";

/** Hard ceiling. A scheduled lane must never be able to sweep unbounded work. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

function resolveLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

async function runReconcile(body = {}) {
  // Kill switch first: cheapest check, and an operator must be able to stop
  // this lane without a deploy.
  const enabled = await getSystemFlag(ENABLE_FLAG);
  if (!enabled) {
    return {
      ok: true,
      skipped: true,
      route: ROUTE_NAME,
      reason: "seller_state_reconcile_disabled",
      flag_key: ENABLE_FLAG,
    };
  }

  const dry_run = body.dry_run === true;
  const limit = resolveLimit(body.limit);

  const result = await recoverSellerExecutionGaps({
    supabaseClient: getDefaultSupabaseClient(),
    limit,
    dryRun: dry_run,
    // THE containment boundary of this route. Never widen this without
    // re-proving the side-effect classification of every added sweep.
    sweeps: SCHEDULER_SAFE_SWEEPS,
  });

  if (!dry_run) {
    await setSystemValues({
      seller_state_reconcile_heartbeat_at: new Date().toISOString(),
      seller_state_reconcile_last_scanned: String(result?.total_scanned ?? 0),
      seller_state_reconcile_last_repaired: String(result?.total_repaired ?? 0),
    });
  }

  logger.info("seller_state_reconcile.complete", {
    dry_run,
    limit,
    sweeps_executed: result?.sweeps_executed ?? null,
    total_scanned: result?.total_scanned ?? 0,
    total_repaired: result?.total_repaired ?? 0,
  });

  return {
    ok: result?.ok !== false,
    skipped: false,
    route: ROUTE_NAME,
    dry_run,
    limit,
    allowed_sweeps: SCHEDULER_SAFE_SWEEPS,
    ...result,
  };
}

async function handle(request, body) {
  const auth = requireScheduledMutationAuth(request, logger);
  if (!auth.authorized) return auth.response;

  try {
    const result = await runReconcile(body);
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    logger.error("seller_state_reconcile.failed", { error: error?.message || "unknown" });
    return NextResponse.json(
      { ok: false, route: ROUTE_NAME, error: "seller_state_reconcile_failed", message: error?.message || "failed" },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  // Read-only by default on GET: a browser or probe must not mutate.
  return handle(request, { dry_run: true });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  return handle(request, body);
}
