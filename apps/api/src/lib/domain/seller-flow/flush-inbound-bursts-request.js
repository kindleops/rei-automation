// Shared authenticated handler for the seller inbound burst flush worker.
//
// Vercel Cron invokes scheduled paths with GET. This route previously exported
// POST alone, so the scheduled worker never entered the handler and eligible
// non-safety bursts stayed open indefinitely (production incident 2026-08-03:
// burst sib:+16128072000:g1:ba199924 sat open with attempt_count=0). GET and
// POST now run this identical function; the method only selects the auth
// contract's entry order and whether a JSON body is read.
//
// Dependencies are injectable (same idiom as queue-run-request.js) so the cron
// GET path can be exercised end-to-end in tests without live Supabase.

import crypto from "node:crypto";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Cron authorization first (Vercel sends `Authorization: Bearer $CRON_SECRET`),
 * then the pre-existing internal-secret contract. Neither branch is weaker than
 * what POST already enforced: requireCronAuth demands an exact CRON_SECRET
 * match, and requireInternalSecret accepts INTERNAL_API_SECRET / CRON_SECRET /
 * QUEUE_ENGINE_SHARED_SECRET. Anonymous callers are rejected on both methods.
 */
export function authorizeFlushRequest(request, { requireCronAuth, requireInternalSecret }) {
  const cron_auth = requireCronAuth(request);
  if (cron_auth.authorized && cron_auth.auth?.authenticated) {
    return {
      ok: true,
      caller_type: cron_auth.auth?.is_vercel_cron ? "vercel_cron" : "cron_secret",
    };
  }

  const internal_auth = requireInternalSecret(request);
  if (internal_auth.ok) {
    return { ok: true, caller_type: "internal_secret" };
  }

  return {
    ok: false,
    caller_type: "unauthorized",
    // requireInternalSecret contract: unauthorized → 401, missing config → 500.
    error: internal_auth.error || "unauthorized",
    status: internal_auth.status || 401,
  };
}

/**
 * Derives the operational counters from the coordinator's real result shape.
 * finalizeBurst returns { ok, reason, claim?, suppressed?, queued? }; a failed
 * claim is the only shape that carries `claim` alongside ok:false.
 */
export function summarizeFlushResults(results = []) {
  const all = Array.isArray(results) ? results.filter(Boolean) : [];
  // "no eligible burst" means there was nothing to work. It is not an eligible
  // burst, not a claim, and not a failure — counting it inflated eligible_count
  // and claimed_count on every idle scheduler tick.
  const list = all.filter((r) => r.reason !== "no_eligible_burst");
  // A failed claim means another worker won the race (or the burst stopped being
  // eligible). That is benign contention, not an operational failure — counting
  // it would alert on normal concurrency.
  const claim_failures = list.filter((r) => r.ok === false && r.claim);
  const failures = list.filter((r) => r.ok === false && !r.claim);
  return {
    eligible_count: list.length,
    claimed_count: list.length - claim_failures.length,
    completed_count: list.filter((r) => r.ok === true && !r.suppressed).length,
    queued_count: list.filter((r) => r.queued).length,
    suppressed_count: list.filter((r) => r.suppressed).length,
    failed_count: failures.length,
    failed_reasons: failures.map((r) => r.reason).slice(0, 10),
    no_eligible_burst_count: all.length - list.length,
  };
}

export async function handleFlushInboundBurstsRequest(request, deps = {}) {
  const method = String(deps.method || request?.method || "POST").toUpperCase();
  const json_response = deps.jsonResponse || jsonResponse;

  const require_cron_auth =
    deps.requireCronAuth || (await import("@/lib/security/cron-auth.js")).requireCronAuth;
  const require_internal_secret =
    deps.requireInternalSecret ||
    (await import("@/lib/security/require-internal-secret.js")).requireInternalSecret;
  const logger = deps.logger || (await import("@/lib/logging/logger.js"));
  const alerts = deps.launchAlerts || (await import("@/lib/domain/alerts/launch-critical-alerts.js")).launchAlerts;

  const request_id =
    request?.headers?.get?.("x-vercel-id") ||
    request?.headers?.get?.("x-request-id") ||
    crypto.randomUUID();

  const auth = authorizeFlushRequest(request, {
    requireCronAuth: require_cron_auth,
    requireInternalSecret: require_internal_secret,
  });
  if (!auth.ok) {
    logger.warn?.("seller_inbound_burst.flush_unauthorized", { method, request_id });
    return json_response({ ok: false, reason: auth.error }, { status: auth.status });
  }
  const log_base = { method, caller_type: auth.caller_type, request_id };

  // GET (the cron path) carries no body; only POST supplies flush parameters.
  let body = {};
  if (method !== "GET") {
    try {
      body = (await request.json()) || {};
    } catch {
      body = {};
    }
  }

  const has_supabase_config =
    deps.hasSupabaseConfig || (await import("@/lib/supabase/client.js")).hasSupabaseConfig;
  if (!deps.supabase && !has_supabase_config()) {
    return json_response({ ok: false, reason: "missing_supabase" }, { status: 503 });
  }
  const supabase =
    deps.supabase ||
    (await import("@/lib/supabase/default-client.js")).getDefaultSupabaseClient() ||
    null;
  if (!supabase) {
    return json_response({ ok: false, reason: "missing_supabase" }, { status: 503 });
  }

  const coordinator = deps.coordinator || (await buildProductionCoordinator({ supabase, body, method }));

  const started_at = deps.now ? deps.now() : Date.now();
  let result;
  try {
    result = await coordinator.flushEligible({
      thread_key: body.thread_key || null,
      limit: Number(body.limit) > 0 ? Number(body.limit) : 20,
    });
  } catch (flush_error) {
    // A crashing flush must be observable, not silent. The scheduler retries on
    // the next minute and expired claim leases are reclaimable, so a 500 here is
    // safe and makes the failure visible to cron monitoring.
    logger.warn?.("seller_inbound_burst.flush_threw", {
      ...log_base,
      error_message: flush_error?.message || "unknown_error",
    });
    await alerts
      ?.burstFlushFailure?.({
        ...log_base,
        error_message: flush_error?.message || "unknown_error",
        thread_scoped: Boolean(body.thread_key),
      })
      ?.catch?.(() => {});
    return json_response(
      { ok: false, reason: "seller_inbound_burst_flush_failed", request_id },
      { status: 500 }
    );
  }

  const counts = summarizeFlushResults(result?.results);
  try {
    logger.info?.("seller_inbound_burst.flush_run", {
      ...log_base,
      ...counts,
      duration_ms: (deps.now ? deps.now() : Date.now()) - started_at,
    });
    if (counts.failed_count) {
      logger.warn?.("seller_inbound_burst.flush_failures", { ...log_base, ...counts });
      await alerts?.burstFlushFailure?.({ ...log_base, ...counts })?.catch?.(() => {});
    }
  } catch {
    /* logging must never fail the flush */
  }

  return json_response({
    ok: true,
    route: "internal/seller-flow/flush-inbound-bursts",
    method,
    caller_type: auth.caller_type,
    request_id,
    ...counts,
    flushed: result?.results?.length || 0,
    results: result?.results || [],
  });
}

async function buildProductionCoordinator({ supabase, body, method }) {
  const [
    { createSellerInboundBurstCoordinator },
    { processSellerInboundMessage },
    { cancelSupabasePendingOutbound },
    { cancelPendingFollowUpsForThread },
    { loadContextWithFallback },
    { loadContext },
    { getSystemValue },
  ] = await Promise.all([
    import("@/lib/domain/seller-flow/seller-inbound-burst-coordinator.js"),
    import("@/lib/domain/seller-flow/process-seller-inbound-message.js"),
    import("@/lib/domain/queue/cancel-supabase-pending-outbound.js"),
    import("@/lib/domain/seller-flow/seller-followup-scheduler.js"),
    import("@/lib/domain/context/load-context-with-fallback.js"),
    import("@/lib/domain/context/load-context.js"),
    import("@/lib/system-control.js"),
  ]);

  const [{ finalizeBurstConstituentLedger }, { completeInboundProcessingClaim }, { launchAlerts }] =
    await Promise.all([
      import("@/lib/domain/seller-flow/finalize-burst-constituent-ledger.js"),
      import("@/lib/domain/inbound/inbound-processing-ledger.js"),
      import("@/lib/domain/alerts/launch-critical-alerts.js"),
    ]);

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

  return createSellerInboundBurstCoordinator({
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
    worker_id: body.worker_id || `flush-inbound-bursts-${String(method).toLowerCase()}`,
    enabled: true,
    finalizeConstituentLedger: finalizeBurstConstituentLedger,
    completeInboundProcessingClaim,
    alertBurstFailure: launchAlerts.burstFlushFailure,
  });
}

export default handleFlushInboundBurstsRequest;
