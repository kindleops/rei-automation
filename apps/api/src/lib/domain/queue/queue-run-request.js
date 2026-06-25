import { notifyDiscordOps } from "@/lib/discord/notify-discord-ops.js";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import {
  blockedSafetyResult,
  blockedRuntimeBrakeResult,
  evaluateQueueSendRuntimeBrakes,
  normalizeSafetyInput,
  validateLiveLimitedRails,
} from "@/lib/domain/queue/queue-control-safety.js";

function clean(value) {
  return String(value ?? "").trim();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined || clean(value) === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rowMetadata(row = {}) {
  const metadata = row?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

function isProofOrInternalQueueRow(row = {}) {
  const metadata = rowMetadata(row);
  return Boolean(
    metadata.proof === true ||
    metadata.proof_mode ||
    metadata.internal_test_phone === true ||
    metadata.exclude_from_kpis === true
  );
}

export function statusForResult(result) {
  if (result?.status != null) return result.status;
  return result?.ok === false ? 500 : 200;
}

export async function handleQueueRunRequest(request, method, deps = {}) {
  console.log("QUEUE EXECUTION STARTED");

  const require_cron_auth =
    deps.requireCronAuth ||
    (await import("@/lib/security/cron-auth.js")).requireCronAuth;
  const run_send_queue =
    deps.runSendQueue ||
    (await import("@/lib/domain/queue/run-send-queue.js")).runSendQueue;
  const get_system_value =
    deps.getSystemValue ||
    (await import("@/lib/system-control.js")).getSystemValue;
  const build_podio_cooldown_skip_result =
    deps.buildPodioCooldownSkipResult || null;
  const route_logger = deps.logger;
  const json_response =
    deps.jsonResponse ||
    ((body, init) =>
      Response.json(body, {
        status: init?.status,
      }));

  route_logger?.info?.("queue_run.route_enter", { method });

  try {
    const cron_auth = require_cron_auth(request, route_logger);
    let auth = cron_auth;

    if (!cron_auth.authorized) {
      const queue_secret = String(
        deps.queueEngineSecret ??
        process.env.QUEUE_ENGINE_SHARED_SECRET ??
        (await get_system_value("queue_engine_shared_secret")) ??
        ""
      ).trim();
      if (!queue_secret) {
        route_logger?.warn?.("queue_engine_secret.not_configured", {
          hint: "Set QUEUE_ENGINE_SHARED_SECRET or system_control['queue_engine_shared_secret'] to protect this endpoint from non-cron callers",
        });
      } else {
        const get_secret_auth = deps.getSharedSecretAuthResult ||
          (await import("@/lib/security/shared-secret.js")).getSharedSecretAuthResult;
        const engine_result = get_secret_auth(request, {
          env_name: "QUEUE_ENGINE_SHARED_SECRET",
          header_names: ["x-queue-engine-secret"],
          expected_token: queue_secret,
        });
        if (!engine_result.ok) {
          route_logger?.warn?.("queue_engine_secret.rejected", {
            reason: engine_result.reason,
            via: engine_result.via || null,
          });
          return json_response({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        auth = {
          authorized: true,
          auth: {
            authenticated: true,
            is_vercel_cron: false,
            via: engine_result.via || "x-queue-engine-secret",
          },
          response: null,
        };
      }
    }

    if (!auth.authorized) return auth.response;

    const body =
      method === "POST"
        ? await request.json().catch(() => ({}))
        : {};
    const search_params = new URL(request.url).searchParams;

    const limit = Math.max(
      1,
      Math.min(
        50,
        asNumber(method === "POST" ? body?.limit : search_params.get("limit"), 50)
      )
    );
    const dry_run = asBoolean(
      method === "POST" ? body?.dry_run : search_params.get("dry_run"),
      false
    );
    const queue_row_id = clean(
      method === "POST"
        ? body?.queue_row_id || body?.queue_item_id || body?.item_id || body?.id
        : search_params.get("queue_row_id") || search_params.get("queue_item_id") || search_params.get("item_id") || search_params.get("id")
    );

    // Hard safety: if caller explicitly requested dry_run, never allow a live send through
    const body_dry_run_explicit = method === "POST" && body?.dry_run === true;
    const query_dry_run_explicit = search_params.get("dry_run") === "true" || search_params.get("dry_run") === "1";
    if ((body_dry_run_explicit || query_dry_run_explicit) && !dry_run) {
      route_logger?.error?.("queue_run.dry_run_safety_violation", { method, body_dry_run_explicit, query_dry_run_explicit });
      return json_response({ ok: false, error: "dry_run_safety_violation", message: "dry_run was requested but resolved false — refusing to execute" }, { status: 500 });
    }

    route_logger?.info?.("queue_run.requested", {
      method,
      limit,
      dry_run,
      authenticated: auth.auth.authenticated,
      is_vercel_cron: auth.auth.is_vercel_cron,
    });

    const queue_processor_mode = clean(await get_system_value("queue_processor_mode") || "paused").toLowerCase();
    if (!dry_run && auth.auth.is_vercel_cron && queue_processor_mode === "safe") {
      return json_response({
        ok: true,
        skipped: true,
        reason: "queue_processor_mode_safe_cron_no_auto_send",
        queue_processor_mode,
      }, { status: 200 });
    }

    const safety_settings = {
      queue_processor_mode,
      campaign_mode: await get_system_value("campaign_mode"),
      queue_hard_cap: await get_system_value("queue_hard_cap"),
      queue_max_batch_size: await get_system_value("queue_max_batch_size"),
      queue_daily_send_cap: await get_system_value("queue_daily_send_cap"),
      queue_market_cap: await get_system_value("queue_market_cap"),
      queue_per_number_cap: await get_system_value("queue_per_number_cap"),
      queue_market_throttle: await get_system_value("queue_market_throttle"),
      queue_sender_throttle: await get_system_value("queue_sender_throttle"),
      queue_all_market_ack: await get_system_value("queue_all_market_ack"),
      queue_emergency_stop_at: await get_system_value("queue_emergency_stop_at"),
    };
    const safety = normalizeSafetyInput({ ...body, limit }, safety_settings);
    const scoped_canary_request = await (async () => {
      const { parseScopedCanaryRequest } = await import("@/lib/domain/queue/run-scoped-campaign-canary.js");
      const raw_queue_row_ids =
        method === "POST"
          ? body?.queue_row_ids || body?.queueRowIds
          : search_params.getAll("queue_row_id");
      return parseScopedCanaryRequest({
        ...body,
        scoped_canary:
          body?.scoped_canary ??
          body?.scopedCanary ??
          asBoolean(search_params.get("scoped_canary"), false),
        validate_only:
          body?.validate_only ??
          body?.validateOnly ??
          asBoolean(search_params.get("validate_only"), false),
        campaign_id:
          body?.campaign_id ??
          body?.campaignId ??
          search_params.get("campaign_id"),
        canary_run_id:
          body?.canary_run_id ??
          body?.canaryRunId ??
          search_params.get("canary_run_id"),
        queue_row_ids: raw_queue_row_ids,
        max_rows:
          body?.max_rows ??
          body?.maxRows ??
          search_params.get("max_rows"),
      });
    })();

    if (scoped_canary_request.scoped) {
      const { runScopedCampaignCanary } = await import("@/lib/domain/queue/run-scoped-campaign-canary.js");
      scoped_canary_request.dry_run =
        scoped_canary_request.validate_only || dry_run;
      if (!scoped_canary_request.validate_only && !dry_run) {
        const runtime_brake = evaluateQueueSendRuntimeBrakes(safety_settings, {
          action: "run_scoped_campaign_canary",
          failClosed: true,
        });
        if (!runtime_brake.ok) {
          return json_response(blockedRuntimeBrakeResult(runtime_brake, "run_scoped_campaign_canary"), {
            status: runtime_brake.status,
          });
        }
        const validation = validateLiveLimitedRails(safety, {
          require_scope: false,
          require_send_caps: true,
        });
        if (!validation.ok) {
          return json_response(blockedSafetyResult(validation, "run_scoped_campaign_canary"), {
            status: validation.status,
          });
        }
      }
      const result = await runScopedCampaignCanary(scoped_canary_request, deps);
      return json_response(
        {
          ok: result?.ok !== false,
          dry_run: Boolean(scoped_canary_request.dry_run),
          route: "internal/queue/run",
          action: "run_scoped_campaign_canary",
          scoped_canary: true,
          validate_only: scoped_canary_request.validate_only,
          ...result,
        },
        { status: result?.status || (result?.ok === false ? 423 : 200) }
      );
    }

    if (!dry_run) {
      const runtime_brake = evaluateQueueSendRuntimeBrakes(safety_settings, {
        action: "queue_run",
        failClosed: true,
      });
      if (!runtime_brake.ok) {
        return json_response(blockedRuntimeBrakeResult(runtime_brake, "queue_run"), {
          status: runtime_brake.status,
        });
      }
    }

    if (queue_row_id) {
      const { loadQueueRowById, processSendQueue } = await import("@/lib/domain/queue/process-send-queue.js");
      const row = await loadQueueRowById(queue_row_id, deps);
      if (!row) {
        return json_response({ ok: false, error: "missing_queue_row", queue_row_id }, { status: 404 });
      }
      const proof_or_internal = isProofOrInternalQueueRow(row);
      if (!dry_run && !proof_or_internal) {
        const validation = validateLiveLimitedRails(safety, { require_scope: false, require_send_caps: true });
        if (!validation.ok) {
          return json_response(blockedSafetyResult(validation, "run_targeted_queue_row"), { status: validation.status });
        }
      }
      if (!dry_run && isInternalTestPhone(row.to_phone_number) && !proof_or_internal) {
        return json_response({
          ok: false,
          error: "internal_test_phone_requires_proof_mode",
          reason: "internal_test_phone_requires_proof_mode",
          queue_row_id,
        }, { status: 423 });
      }
      const result = dry_run
        ? { ok: true, dry_run: true, skipped: true, reason: "targeted_queue_row_dry_run", queue_row_id }
        : await processSendQueue({ queue_row_id }, deps);
      return json_response({
        ok: result?.ok !== false,
        dry_run: Boolean(dry_run),
        route: "internal/queue/run",
        action: "run_targeted_queue_row",
        queue_row_id,
        result,
      }, { status: statusForResult(result) });
    }

    if (!dry_run) {
      const validation = validateLiveLimitedRails(safety, { require_scope: false, require_send_caps: true });
      if (!validation.ok) {
        return json_response(blockedSafetyResult(validation, "queue_run"), { status: validation.status });
      }
    }

    route_logger?.info?.("queue_run.before_run_send_queue", {
      limit,
      dry_run,
      queue_processor_mode,
      dry_run_reason: dry_run ? "requested" : "disabled",
      rollout_mode: process.env.ROLLOUT_MODE || null,
      forced_dry_run: false,
      master_owner_id: null,
      scope_reason: "supabase_queue_runner",
    });

    await notifyDiscordOps({
      event_type: "queue_run_started",
      severity: "info",
      domain: "queue",
      title: "Queue Run Started",
      summary: `Queue run started (limit=${limit}, dry_run=${dry_run})`,
      fields: [
        { name: "Limit", value: String(limit), inline: true },
        { name: "Dry Run", value: String(Boolean(dry_run)), inline: true },
      ],
      dedupe_key: `queue_run_started:${dry_run ? "dry" : "live"}`,
      throttle_window_seconds: 60,
    });

    const result = await run_send_queue({
      limit: dry_run ? limit : Math.min(limit, safety.hard_cap || limit, safety.max_batch_size || limit),
      dry_run,
    });

    if (result?.skipped) {
      route_logger?.warn?.("queue_run.early_return", {
        reason: result.reason || "unknown",
        skipped: true,
        lock_expires_at: result.lock?.meta?.expires_at || null,
        lock_owner: result.lock?.meta?.owner || null,
        lock_acquired_at: result.lock?.meta?.acquired_at || null,
        run_started_at: result.run_started_at || null,
      });
    }

    route_logger?.info?.("queue_run.after_run_send_queue", {
      ok: result?.ok !== false,
      skipped: result?.skipped || false,
      partial: result?.partial || false,
      dry_run: result?.dry_run ?? null,
      reason: result?.reason || null,
      attempted_count: result?.attempted_count ?? null,
      claimed_count: result?.claimed_count ?? null,
      started_count: result?.started_count ?? null,
      processed_count: result?.processed_count ?? null,
      sent_count: result?.sent_count ?? null,
      failed_count: result?.failed_count ?? null,
      blocked_count: result?.blocked_count ?? null,
      skipped_count: result?.skipped_count ?? null,
      duplicate_locked_count: result?.duplicate_locked_count ?? null,
      first_failing_queue_item_id:
        result?.first_failing_queue_item_id ?? null,
      first_failing_reason: result?.first_failing_reason ?? null,
      first_failure_queue_item_id:
        result?.first_failure_queue_item_id ?? null,
      first_failure_reason: result?.first_failure_reason ?? null,
      batch_duration_ms: result?.batch_duration_ms ?? null,
      due_rows: result?.due_rows ?? null,
      future_rows: result?.future_rows ?? null,
      total_rows_loaded: result?.total_rows_loaded ?? null,
    });

    route_logger?.info?.("queue_run.summary", {
      attempted_count: result?.attempted_count ?? 0,
      claimed_count: result?.claimed_count ?? 0,
      processed_count: result?.processed_count ?? 0,
      sent_count: result?.sent_count ?? 0,
      failed_count: result?.failed_count ?? 0,
      blocked_count: result?.blocked_count ?? 0,
      skipped_count: result?.skipped_count ?? 0,
      invalid_queue_row_count: result?.invalid_queue_row_count ?? 0,
      preclaim_paused_name_missing_count:
        result?.preclaim_paused_name_missing_count ?? 0,
      preclaim_outside_window_excluded_count:
        result?.preclaim_outside_window_excluded_count ?? 0,
      preclaim_retry_pending_excluded_count:
        result?.preclaim_retry_pending_excluded_count ?? 0,
      eligible_claim_count: result?.eligible_claim_count ?? 0,
      first_failure_reason:
        result?.first_failure_reason ??
        result?.first_failing_reason ??
        null,
    });

    await notifyDiscordOps({
      event_type: result?.ok === false ? "queue_run_failed" : "queue_run_completed",
      severity: result?.ok === false || (result?.failed_count || 0) > 0 ? "error" : "success",
      domain: "queue",
      title: result?.ok === false ? "Queue Run Failed" : "Queue Run Completed",
      summary: result?.ok === false
        ? clean(result?.reason) || "queue_run_failed"
        : `Queue run completed: sent=${result?.sent_count || 0}, failed=${result?.failed_count || 0}, blocked=${result?.blocked_count || 0}`,
      fields: [
        { name: "Sent", value: String(result?.sent_count || 0), inline: true },
        { name: "Failed", value: String(result?.failed_count || 0), inline: true },
        { name: "Blocked", value: String(result?.blocked_count || 0), inline: true },
      ],
      metadata: { result },
      should_alert_critical: result?.ok === false || (result?.failed_count || 0) > 0,
    });

    return json_response(
      {
        ok: result?.ok !== false,
        dry_run: Boolean(dry_run),
        selected_count: result?.eligible_claim_count ?? 0,
        due_scheduled_count: result?.due_rows ?? 0,
        skipped_future_scheduled_count: result?.future_rows ?? 0,
        skipped_guard_count: result?.blocked_count ?? 0,
        skipped_suppression_count: result?.preclaim_outside_window_excluded_count ?? 0,
        skipped_invalid_phone_count: result?.skipped_invalid_phone_count ?? 0,
        skipped_missing_body_count: result?.skipped_missing_body_count ?? 0,
        sent_count: result?.sent_count ?? 0,
        failed_count: result?.failed_count ?? 0,
        results: result?.results ?? [],
        route: "internal/queue/run",
        result,
      },
      { status: statusForResult(result) }
    );
  } catch (error) {
    const diagnostics = {
      name: error?.name || "Error",
      message: error?.message || "queue_run_failed",
      status: Number(error?.status || 0) || null,
      path: clean(error?.path) || null,
      method: clean(error?.method) || null,
      operation: clean(error?.operation) || null,
      retry_after_seconds:
        error?.retry_after_seconds === undefined ||
        error?.retry_after_seconds === null
          ? null
          : Number(error.retry_after_seconds),
      rate_limit_remaining:
        error?.rate_limit_remaining === undefined ||
        error?.rate_limit_remaining === null
          ? null
          : Number(error.rate_limit_remaining),
      stack: error?.stack || null,
    };

    route_logger?.error?.("queue_run.failed", {
      method,
      error: diagnostics,
    });

    if (
      build_podio_cooldown_skip_result &&
      diagnostics.name === "PodioError" &&
      diagnostics.status === 420
    ) {
      const result = await build_podio_cooldown_skip_result({
        results: [],
        processed_count: 0,
        sent_count: 0,
        failed_count: 0,
        skipped_count: 0,
      });

      return json_response(
        {
          ok: true,
          route: "internal/queue/run",
          result,
        },
        { status: 200 }
      );
    }

    await notifyDiscordOps({
      event_type: "queue_run_failed",
      severity: "critical",
      domain: "queue",
      title: "Queue Run Request Failed",
      summary: diagnostics.message,
      metadata: diagnostics,
      should_alert_critical: true,
    });

    return json_response(
      {
        ok: false,
        error: "queue_run_failed",
        message: diagnostics.message,
      },
      { status: 500 }
    );
  }
}

export default handleQueueRunRequest;
