import { NextResponse } from "next/server";

import { capRetryBatch, getRolloutControls, resolveScopedId } from "@/lib/config/rollout-controls.js";
import { child } from "@/lib/logging/logger.js";
import {
  buildPodioCooldownSkipResult,
  isPodioRateLimitError,
  serializePodioError,
} from "@/lib/providers/podio.js";
import { runRetryRunner } from "@/lib/workers/retry-runner.js";
import { requireCronOrEngineAuth } from "@/lib/security/cron-auth.js";
import { buildDisabledResponse, getSystemFlag } from "@/lib/system-control.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({
  module: "api.internal.queue.retry",
});

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function statusForResult(result) {
  return result?.ok === false ? 400 : 200;
}

export async function GET(request) {
  try {
    const auth = await requireCronOrEngineAuth(request, logger);
    if (!auth.authorized) return auth.response;

    const retry_enabled = await getSystemFlag("retry_enabled");
    if (!retry_enabled) {
      return NextResponse.json(buildDisabledResponse("retry_enabled", "queue-retry-route"), {
        status: 423,
      });
    }

    const { searchParams } = new URL(request.url);
    const rollout = getRolloutControls();
    const master_owner_scope = resolveScopedId({
      requested_id: asNumber(searchParams.get("master_owner_id"), null),
      safe_id: rollout.single_master_owner_id,
      resource: "master_owner",
    });
    if (!master_owner_scope.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: master_owner_scope.reason,
        },
        { status: 400 }
      );
    }
    const limit = capRetryBatch(asNumber(searchParams.get("limit"), 50), 50);
    const dry_run = asBoolean(searchParams.get("dry_run"), false);

    logger.info("queue_retry.requested", {
      method: "GET",
      limit,
      master_owner_id: master_owner_scope.effective_id,
      dry_run,
      authenticated: auth.auth.authenticated,
      is_vercel_cron: auth.auth.is_vercel_cron,
    });

    const result = await runRetryRunner({
      limit,
      master_owner_id: master_owner_scope.effective_id,
      dry_run,
    });

    logger.info("queue_retry.completed", {
      method: "GET",
      ok: result?.ok !== false,
      skipped: result?.skipped || false,
      reason: result?.reason || null,
      processed_count: result?.processed_count ?? 0,
      retried_count: result?.retried_count ?? 0,
      scheduled_count: result?.scheduled_count ?? 0,
      terminal_count: result?.terminal_count ?? 0,
      skipped_count: result?.skipped_count ?? 0,
      retry_candidates_checked: result?.retry_candidates_checked ?? 0,
      retryable_count: result?.retryable_count ?? 0,
      terminal_skipped_count: result?.terminal_skipped_count ?? 0,
      blocked_count: result?.blocked_count ?? 0,
      retry_after_seconds: result?.retry_after_seconds ?? null,
    });

    return NextResponse.json(
      {
        ok: result?.ok !== false,
        route: "internal/queue/retry",
        result,
      },
      { status: statusForResult(result) }
    );
  } catch (error) {
    const diagnostics = serializePodioError(error);

    logger.error("queue_retry.failed", {
      method: "GET",
      error: diagnostics,
    });

    if (isPodioRateLimitError(error)) {
      const result = await buildPodioCooldownSkipResult({
        processed_count: 0,
        retried_count: 0,
        scheduled_count: 0,
        terminal_count: 0,
        skipped_count: 0,
        scanned_count: 0,
        results: [],
      });

      return NextResponse.json(
        {
          ok: true,
          route: "internal/queue/retry",
          result,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: "queue_retry_failed",
        message: diagnostics.message,
      },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const auth = await requireCronOrEngineAuth(request, logger);
    if (!auth.authorized) return auth.response;

    const retry_enabled = await getSystemFlag("retry_enabled");
    if (!retry_enabled) {
      return NextResponse.json(buildDisabledResponse("retry_enabled", "queue-retry-route"), {
        status: 423,
      });
    }

    const body = await request.json().catch(() => ({}));
    const rollout = getRolloutControls();
    const master_owner_scope = resolveScopedId({
      requested_id: asNumber(body?.master_owner_id, null),
      safe_id: rollout.single_master_owner_id,
      resource: "master_owner",
    });
    if (!master_owner_scope.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: master_owner_scope.reason,
        },
        { status: 400 }
      );
    }
    const limit = capRetryBatch(asNumber(body?.limit, 50), 50);
    const dry_run = asBoolean(body?.dry_run, false);

    logger.info("queue_retry.requested", {
      method: "POST",
      limit,
      master_owner_id: master_owner_scope.effective_id,
      dry_run,
      authenticated: auth.auth.authenticated,
      is_vercel_cron: auth.auth.is_vercel_cron,
    });

    const result = await runRetryRunner({
      limit,
      master_owner_id: master_owner_scope.effective_id,
      dry_run,
    });

    logger.info("queue_retry.completed", {
      method: "POST",
      ok: result?.ok !== false,
      skipped: result?.skipped || false,
      reason: result?.reason || null,
      processed_count: result?.processed_count ?? 0,
      retried_count: result?.retried_count ?? 0,
      scheduled_count: result?.scheduled_count ?? 0,
      terminal_count: result?.terminal_count ?? 0,
      skipped_count: result?.skipped_count ?? 0,
      retry_candidates_checked: result?.retry_candidates_checked ?? 0,
      retryable_count: result?.retryable_count ?? 0,
      terminal_skipped_count: result?.terminal_skipped_count ?? 0,
      blocked_count: result?.blocked_count ?? 0,
      retry_after_seconds: result?.retry_after_seconds ?? null,
    });

    return NextResponse.json(
      {
        ok: result?.ok !== false,
        route: "internal/queue/retry",
        result,
      },
      { status: statusForResult(result) }
    );
  } catch (error) {
    const diagnostics = serializePodioError(error);

    logger.error("queue_retry.failed", {
      method: "POST",
      error: diagnostics,
    });

    if (isPodioRateLimitError(error)) {
      const result = await buildPodioCooldownSkipResult({
        processed_count: 0,
        retried_count: 0,
        scheduled_count: 0,
        terminal_count: 0,
        skipped_count: 0,
        scanned_count: 0,
        results: [],
      });

      return NextResponse.json(
        {
          ok: true,
          route: "internal/queue/retry",
          result,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: "queue_retry_failed",
        message: diagnostics.message,
      },
      { status: 500 }
    );
  }
}
