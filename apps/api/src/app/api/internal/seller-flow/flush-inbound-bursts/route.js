// Internal flush endpoint for eligible seller inbound bursts.
// Auth: internal secret / cron. Append path is feature-gated; this endpoint
// finalizes already-open bursts. Reloads thread context before V2.
//
// ACTIVATION PREREQUISITE: SELLER_INBOUND_BURST_ENABLED requires this endpoint
// to be driven by a scheduler (Vercel cron or equivalent) — without it,
// non-safety bursts finalize only when a later inbound trips the hard-close
// rollover's inline flush (delayed, never lost). This endpoint also reclaims
// stale claimed bursts whose worker died (claim lease recovery), so the cron
// doubles as the crash-recovery worker. The default flush context resolves
// auto-reply mode via V2's own guarded resolution and stays non-live unless
// system_control explicitly allows queueing.

import { NextResponse } from "next/server";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { createSellerInboundBurstCoordinator } from "@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js";
import { processSellerInboundMessage } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { cancelSupabasePendingOutbound } from "@/lib/domain/queue/cancel-supabase-pending-outbound.js";
import { cancelPendingFollowUpsForThread } from "@/lib/domain/seller-flow/seller-followup-scheduler.js";
import { loadContextWithFallback } from "@/lib/domain/context/load-context-with-fallback.js";
import { loadContext } from "@/lib/domain/context/load-context.js";
import { getSystemValue } from "@/lib/system-control.js";
import { info, warn } from "@/lib/logging/logger.js";
import { launchAlerts } from "@/lib/domain/alerts/launch-critical-alerts.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    // requireInternalSecret contract: { error, status } — unauthorized → 401,
    // internal secret not configured → 500 internal_secret_not_configured.
    return NextResponse.json(
      { ok: false, reason: auth.error || "unauthorized" },
      { status: auth.status || 401 }
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // client.js exports no getSupabaseClient — the canonical accessor is
  // getDefaultSupabaseClient (always returns a client, placeholder included),
  // so the availability guard must be hasSupabaseConfig().
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ ok: false, reason: "missing_supabase" }, { status: 503 });
  }
  const supabase = getDefaultSupabaseClient() || null;
  if (!supabase) {
    return NextResponse.json({ ok: false, reason: "missing_supabase" }, { status: 503 });
  }

  async function processWithContext(args = {}) {
    let context = args.context || null;
    if (!context && args.threadKey) {
      try {
        context = await loadContextWithFallback({
          inbound_from: args.threadKey,
          inbound_to: args.inboundTo || null,
          create_brain_if_missing: false,
          loadContextImpl: loadContext,
        });
      } catch {
        context = null;
      }
    }
    return processSellerInboundMessage({
      ...args,
      context: context || args.context || null,
      conversationBrain: args.conversationBrain || context?.items?.brain_item || null,
      propertyId: args.propertyId || context?.ids?.property_id || null,
      prospectId: args.prospectId || context?.ids?.prospect_id || null,
      ownerId: args.ownerId || context?.ids?.master_owner_id || null,
      phoneId: args.phoneId || context?.ids?.phone_item_id || null,
      getSystemValue: args.getSystemValue || getSystemValue,
      supabaseClient: args.supabaseClient || supabase,
    });
  }

  const coordinator = createSellerInboundBurstCoordinator({
    supabase,
    processSellerInboundMessage: processWithContext,
    cancelPendingOutbound: async (args) =>
      cancelSupabasePendingOutbound(
        {
          thread_key: args.thread_key,
          to_phone_number: args.thread_key,
          reason: args.reason,
          inbound_event_id: args.inbound_event_id,
          cancelled_by: "seller_inbound_burst_flush",
        },
        { supabase }
      ),
    cancelPendingFollowUps: async (args) =>
      cancelPendingFollowUpsForThread({
        thread_key: args.thread_key,
        reason: args.reason,
        inbound_event_id: args.inbound_event_id,
        supabase,
      }),
    worker_id: body.worker_id || "flush-inbound-bursts-route",
    enabled: true,
  });

  let result;
  try {
    result = await coordinator.flushEligible({
      thread_key: body.thread_key || null,
      limit: Number(body.limit) > 0 ? Number(body.limit) : 20,
    });
  } catch (flush_error) {
    // A crashing flush must be observable, not silent. The scheduler retries on
    // the next minute; expired claim leases are reclaimable, so returning 500
    // here is safe and makes the failure visible to Vercel cron monitoring.
    warn("seller_inbound_burst.flush_threw", {
      error_message: flush_error?.message || "unknown_error",
    });
    await launchAlerts
      .burstFlushFailure({
        error_message: flush_error?.message || "unknown_error",
        thread_scoped: Boolean(body.thread_key),
      })
      .catch(() => {});
    return NextResponse.json(
      { ok: false, reason: "seller_inbound_burst_flush_failed" },
      { status: 500 }
    );
  }

  try {
    const results = result.results || [];
    const failed = results.filter((r) => r && r.ok === false && r.reason !== "no_eligible_burst");
    info("seller_inbound_burst.flush_run", {
      flushed: results.length,
      finalized: results.filter((r) => r?.ok).length,
      suppressed: results.filter((r) => r?.suppressed).length,
      failed: failed.length,
      failed_reasons: failed.map((r) => r.reason).slice(0, 5),
    });
    if (failed.length) {
      warn("seller_inbound_burst.flush_failures", {
        failed: failed.length,
        reasons: failed.map((r) => r.reason).slice(0, 10),
      });
      await launchAlerts
        .burstFlushFailure({
          failed_count: failed.length,
          reasons: failed.map((r) => r.reason).slice(0, 10),
        })
        .catch(() => {});
    }
  } catch {
    /* logging must never fail the flush */
  }

  return NextResponse.json({
    ok: true,
    flushed: result.results?.length || 0,
    results: result.results || [],
  });
}
