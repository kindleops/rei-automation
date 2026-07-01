import { capReconcileBatch, getRolloutControls, resolveScopedId } from "@/lib/config/rollout-controls.js";
import { reconcileSupabaseDeliveryStatuses } from "@/lib/domain/events/normalize-delivery-status.js";
import { getQueueRouteDeploymentMeta } from "@/lib/domain/queue/queue-route-deployment-meta.js";
import { buildDisabledResponse, getSystemFlag, setSystemValues } from "@/lib/system-control.js";
import { reconcileCampaignExecutionHealth } from "@/lib/domain/queue/campaign-universal-reconciliation.js";
import { reconcileCanonicalQueueLifecycle } from "@/lib/supabase/sms-engine.js";

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function serializeIntegrationError(error) {
  return {
    message: clean(error?.message) || "unknown_error",
    code: clean(error?.code) || null,
    name: clean(error?.name) || null,
  };
}

function clean(value = "") {
  return String(value ?? "").trim();
}

async function runOptionalIntegration(name, runner, logger) {
  try {
    const result = await runner();
    return { ok: true, integration: name, result };
  } catch (error) {
    logger?.warn?.("queue_reconcile.optional_integration_failed", {
      integration: name,
      error: serializeIntegrationError(error),
    });
    return {
      ok: false,
      integration: name,
      skipped: true,
      error: serializeIntegrationError(error),
    };
  }
}

export async function handleQueueReconcileRequest(request, method = "GET", deps = {}) {
  const logger = deps.logger;
  const requireCronOrEngineAuth =
    deps.requireCronOrEngineAuth ||
    (await import("@/lib/security/cron-auth.js")).requireCronOrEngineAuth;
  const runQueueReconcileRunner =
    deps.runQueueReconcileRunner ||
    (await import("@/lib/workers/queue-reconcile-runner.js")).runQueueReconcileRunner;
  const reconcileCanonicalQueueLifecycleFn =
    deps.reconcileCanonicalQueueLifecycle || reconcileCanonicalQueueLifecycle;
  const reconcileSupabaseDeliveryStatusesFn =
    deps.reconcileSupabaseDeliveryStatuses || reconcileSupabaseDeliveryStatuses;
  const setSystemValuesFn = deps.setSystemValues || setSystemValues;
  const getSystemFlagFn = deps.getSystemFlag || getSystemFlag;
  const jsonResponse =
    deps.jsonResponse ||
    ((payload, init = {}) => Response.json(payload, init));

  const started_at = Date.now();
  const auth = await requireCronOrEngineAuth(request, logger);
  if (!auth.authorized) return auth.response;

  const reconcile_enabled = await getSystemFlagFn("reconcile_enabled");
  if (!reconcile_enabled) {
    return jsonResponse(buildDisabledResponse("reconcile_enabled", "queue-reconcile-route"), {
      status: 423,
    });
  }

  const input =
    method === "POST" ? await request.json().catch(() => ({})) : {};
  const search_params = new URL(request.url).searchParams;
  const rollout = getRolloutControls();
  const master_owner_scope = resolveScopedId({
    requested_id: asNumber(
      input?.master_owner_id ?? search_params.get("master_owner_id"),
      null
    ),
    safe_id: rollout.single_master_owner_id,
    resource: "master_owner",
  });
  if (!master_owner_scope.ok) {
    return jsonResponse(
      {
        ok: false,
        error: master_owner_scope.reason,
      },
      { status: 400 }
    );
  }

  const limit = capReconcileBatch(
    asNumber(input?.limit ?? search_params.get("limit"), 50),
    50
  );
  const stale_after_minutes = asNumber(
    input?.stale_after_minutes ?? search_params.get("stale_after_minutes"),
    20
  );
  const deployment_meta = getQueueRouteDeploymentMeta(request);

  logger?.info?.("queue_reconcile.requested", {
    method,
    limit,
    stale_after_minutes,
    master_owner_id: master_owner_scope.effective_id,
    authenticated: auth.auth.authenticated,
    is_vercel_cron: auth.auth.is_vercel_cron,
    deployment: deployment_meta,
  });

  const canonical_lifecycle_result = await reconcileCanonicalQueueLifecycleFn({
    limit,
    stale_minutes: stale_after_minutes,
    lease_minutes: 10,
    dry_run: false,
    caller_route: "internal/queue/reconcile",
    deploy_sha: deployment_meta.git_sha,
  }).catch((error) => {
    logger?.error?.("queue_reconcile.canonical_lifecycle_failed", {
      error: serializeIntegrationError(error),
    });
    return {
      ok: false,
      reconciled_rows: 0,
      error: serializeIntegrationError(error),
    };
  });

  const supabase_delivery_wrap = await runOptionalIntegration(
    "supabase_delivery",
    () =>
      reconcileSupabaseDeliveryStatusesFn({
        limit,
      }),
    logger
  );
  const supabase_delivery_result = supabase_delivery_wrap.result || {
    ok: false,
    total_normalized: 0,
    error: supabase_delivery_wrap.error || null,
  };

  const universal_reconcile_result = await reconcileCampaignExecutionHealth({
    limit: 25,
    delivery_recovery_limit: 50,
  }).catch((error) => {
    logger?.warn?.("queue_reconcile.universal_reconcile_failed", {
      error: serializeIntegrationError(error),
    });
    return { ok: false, error: serializeIntegrationError(error) };
  });

  const podio_wrap = await runOptionalIntegration(
    "podio_queue_reconcile",
    () =>
      runQueueReconcileRunner({
        limit,
        stale_after_minutes,
        master_owner_id: master_owner_scope.effective_id,
      }),
    logger
  );
  const podio_result = podio_wrap.result || {
    ok: false,
    skipped: true,
    reason: "podio_unavailable",
    error: podio_wrap.error || null,
  };

  const duration_ms = Date.now() - started_at;
  const heartbeat_at = new Date().toISOString();
  await setSystemValuesFn({
    queue_reconcile_heartbeat_at: heartbeat_at,
    queue_reconcile_last_duration_ms: String(duration_ms),
    queue_reconcile_last_deploy_sha: deployment_meta.git_sha || "unknown",
    queue_reconcile_last_deployment_id: deployment_meta.deployment_id || "",
    queue_reconcile_last_lifecycle_version: deployment_meta.reconcile_lifecycle_version || "",
    queue_reconcile_last_canonical_ok: String(canonical_lifecycle_result?.ok !== false),
    queue_reconcile_last_podio_ok: String(podio_wrap.ok === true),
  }).catch((error) => {
    logger?.warn?.("queue_reconcile.heartbeat_write_failed", {
      error: serializeIntegrationError(error),
    });
  });

  logger?.info?.("queue_reconcile.completed", {
    method,
    duration_ms,
    canonical_ok: canonical_lifecycle_result?.ok !== false,
    podio_ok: podio_wrap.ok === true,
    deployment: deployment_meta,
  });

  return jsonResponse(
    {
      ok: true,
      route: "internal/queue/reconcile",
      deployment: deployment_meta,
      heartbeat_at,
      duration_ms,
      canonical_lifecycle_reconcile: canonical_lifecycle_result,
      universal_campaign_reconcile: universal_reconcile_result,
      supabase_delivery_reconcile: supabase_delivery_result,
      optional_integrations: {
        podio_queue_reconcile: podio_wrap,
        supabase_delivery: supabase_delivery_wrap,
      },
      podio_queue_reconcile: podio_result,
    },
    { status: 200 }
  );
}