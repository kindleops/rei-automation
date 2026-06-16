import { runSupabaseCandidateFeeder } from "../lib/domain/outbound/supabase-candidate-feeder.js";
import { child } from "../lib/logging/logger.js";
import { captureRouteException } from "../lib/monitoring/sentry.js";
import { notifyDiscordOps } from "../lib/discord/notify-discord-ops.js";
import {
  blockedSafetyResult,
  blockedRuntimeBrakeResult,
  evaluateQueueCreationRuntimeBrakes,
  normalizeSafetyInput,
  validateLiveLimitedRails,
} from "../lib/domain/queue/queue-control-safety.js";

const logger = child({ module: "domain.outbound.feed_candidates_request" });

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

function asOptionalBoolean(value) {
  if (value === undefined || value === null || clean(value) === "") return null;
  return asBoolean(value, false);
}

function asPositiveInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function asNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

export function statusForResult(result) {
  const status = Number(result?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  return result?.ok === false ? 500 : 200;
}

export function normalizeFeedCandidatesInput(input = {}) {
  const raw_scan_limit = input.scan_limit ?? input.candidate_fetch_limit;
  const raw_offset = input.candidate_offset ?? input.scan_offset ?? input.offset;
  return {
    limit: asPositiveInteger(input.limit, 25),
    scan_limit: asPositiveInteger(raw_scan_limit, 500),
    candidate_offset: asNonNegativeInteger(raw_offset, 0),
    candidate_source: clean(input.candidate_source) || null,
    market: clean(input.market) || null,
    state: clean(input.state) || null,
    routing_safe_only: asBoolean(input.routing_safe_only, true),
    allow_phone_fallback: asBoolean(input.allow_phone_fallback, false),
    within_contact_window_now: asBoolean(input.within_contact_window_now, true),
    dry_run: asBoolean(input.dry_run, false),
    template_use_case: clean(input.template_use_case) || "ownership_check",
    touch_number: asPositiveInteger(input.touch_number, 1),
    campaign_session_id: clean(input.campaign_session_id) || null,
    campaign_mode: clean(input.campaign_mode) || null,
    hard_cap: asPositiveInteger(input.hard_cap ?? input.queue_hard_cap, null),
    max_batch_size: asPositiveInteger(input.max_batch_size ?? input.queue_max_batch_size, null),
    daily_cap: asPositiveInteger(input.daily_cap ?? input.queue_daily_send_cap, null),
    market_cap: asPositiveInteger(input.market_cap ?? input.queue_market_cap, null),
    per_number_cap: asPositiveInteger(input.per_number_cap ?? input.queue_per_number_cap, null),
    all_market_ack: asBoolean(input.all_market_ack, false),
    debug_templates: asBoolean(input.debug_templates, false),
    schedule_spread: asBoolean(input.schedule_spread, false),
    schedule_start_local: clean(input.schedule_start_local) || "09:00",
    schedule_end_local: clean(input.schedule_end_local) || "20:00",
    schedule_interval_seconds_min: asPositiveInteger(input.schedule_interval_seconds_min, 45),
    schedule_interval_seconds_max: asPositiveInteger(input.schedule_interval_seconds_max, 180),
    timezone_filter: clean(input.timezone_filter) || null,
    identity_gate_mode: clean(input.identity_gate_mode) || null,
    allow_identity_unknown: asOptionalBoolean(input.allow_identity_unknown),
    allow_weak_identity_outbound: asOptionalBoolean(input.allow_weak_identity_outbound),
    cold_outbound_cooldown_days: asPositiveInteger(input.cold_outbound_cooldown_days, 30),
    duplicate_body_cooldown_hours: asPositiveInteger(input.duplicate_body_cooldown_hours, 24),
    cold_outbound_touch_cap: asPositiveInteger(input.cold_outbound_touch_cap, 5),
    phone_cooldown_days: asPositiveInteger(input.phone_cooldown_days, 14),
    allow_internal_test_phones: false,
  };
}

function mergeBodyAndQuery(request, method, body = {}) {
  const merged = { ...(body || {}) };
  const search_params = new URL(request.url).searchParams;

  for (const key of [
    "limit",
    "scan_limit",
    "candidate_fetch_limit",
    "candidate_offset",
    "scan_offset",
    "offset",
    "candidate_source",
    "market",
    "state",
    "routing_safe_only",
    "allow_phone_fallback",
    "within_contact_window_now",
    "dry_run",
    "template_use_case",
    "touch_number",
    "campaign_session_id",
    "campaign_mode",
    "hard_cap",
    "queue_hard_cap",
    "max_batch_size",
    "queue_max_batch_size",
    "daily_cap",
    "queue_daily_send_cap",
    "market_cap",
    "queue_market_cap",
    "per_number_cap",
    "queue_per_number_cap",
    "all_market_ack",
    "debug_templates",
    "schedule_spread",
    "schedule_start_local",
    "schedule_end_local",
    "schedule_interval_seconds_min",
    "schedule_interval_seconds_max",
    "timezone_filter",
    "identity_gate_mode",
    "allow_identity_unknown",
    "allow_weak_identity_outbound",
    "cold_outbound_cooldown_days",
    "duplicate_body_cooldown_hours",
  ]) {
    const value = search_params.get(key);
    if (value !== null) merged[key] = value;
  }

  if (method === "GET") {
    return merged;
  }

  return merged;
}

export async function handleFeedCandidatesRequest(request, method = "GET", options = {}) {
  const route = clean(options.route) || "internal/outbound/feed-candidates";
  const route_logger = options.logger || logger;
  const json_response = options.jsonResponse || ((payload, init = {}) => Response.json(payload, init));
  let feeder_request_meta = null;
  const require_cron_auth =
    options.requireCronAuth ||
    (await import("../lib/security/cron-auth.js")).requireCronAuth;
  const get_system_value =
    options.getSystemValue ||
    (await import("../lib/system-control.js")).getSystemValue;

  try {
    let auth = require_cron_auth(request, route_logger);

    if (!auth.authorized) {
      const queue_secret = String(
        process.env.QUEUE_ENGINE_SHARED_SECRET ??
        (await get_system_value("queue_engine_shared_secret")) ??
        ""
      ).trim();
      if (!queue_secret) {
        route_logger?.warn?.("queue_engine_secret.not_configured", {
          hint: "Set QUEUE_ENGINE_SHARED_SECRET or system_control['queue_engine_shared_secret'] to protect this endpoint from non-cron callers",
        });
        return json_response(
          {
            ok: false,
            route,
            error: auth.auth?.reason || "unauthorized",
            message: auth.auth?.reason || "unauthorized",
            queued_count: 0,
            scheduled_count: 0,
            invalid_scheduled_for_count: 0,
          },
          { status: auth.auth?.status || 401 }
        );
      }

      const { getSharedSecretAuthResult } = await import("../lib/security/shared-secret.js");
      const engine_result = getSharedSecretAuthResult(request, {
        env_name: "QUEUE_ENGINE_SHARED_SECRET",
        header_names: ["x-queue-engine-secret"],
        expected_token: queue_secret,
      });
      if (!engine_result.ok) {
        route_logger?.warn?.("queue_engine_secret.rejected", {
          reason: engine_result.reason,
          via: engine_result.via || null,
        });
        return json_response(
          {
            ok: false,
            route,
            error: "unauthorized",
            message: "unauthorized",
            queued_count: 0,
            scheduled_count: 0,
            invalid_scheduled_for_count: 0,
          },
          { status: 401 }
        );
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

    const body = method === "POST" ? await request.json().catch(() => ({})) : {};
    const normalized = normalizeFeedCandidatesInput(mergeBodyAndQuery(request, method, body));
    const queue_processor_mode = clean(await get_system_value("queue_processor_mode") || "paused").toLowerCase();
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
      queue_scan_limit: await get_system_value("queue_scan_limit"),
      queue_market_filter: await get_system_value("queue_market_filter"),
      queue_state_filter: await get_system_value("queue_state_filter"),
      queue_all_market_ack: await get_system_value("queue_all_market_ack"),
      queue_auto_enqueue_enabled: await get_system_value("queue_auto_enqueue_enabled"),
      queue_emergency_stop_at: await get_system_value("queue_emergency_stop_at"),
    };
    const safety = normalizeSafetyInput(normalized, safety_settings);
    if (!normalized.dry_run) {
      const runtime_brake = evaluateQueueCreationRuntimeBrakes(safety_settings, {
        action: "feed_candidates",
        requireAutoEnqueue: false,
        failClosed: true,
      });
      if (!runtime_brake.ok) {
        return json_response(blockedRuntimeBrakeResult(runtime_brake, "feed_candidates"), {
          status: runtime_brake.status,
        });
      }
      const validation = validateLiveLimitedRails(safety, { require_scope: true, require_send_caps: true });
      if (!validation.ok) {
        return json_response(blockedSafetyResult(validation, "feed_candidates"), { status: validation.status });
      }
      normalized.limit = Math.min(normalized.limit, validation.effective_limit);
      normalized.allow_internal_test_phones = false;
      if (safety.market && !normalized.market) normalized.market = safety.market;
      if (safety.state && !normalized.state) normalized.state = safety.state;
    }
    feeder_request_meta = {
      route,
      dry_run: normalized.dry_run,
      limit: normalized.limit,
      scan_limit: normalized.scan_limit,
      campaign_mode: safety.campaign_mode,
    };

    await notifyDiscordOps({
      event_type: "feed_candidates_started",
      severity: "info",
      domain: "feeder",
      title: "Feed Candidates Started",
      summary: `Feeder scan started (limit=${normalized.limit}, scan_limit=${normalized.scan_limit}, dry_run=${normalized.dry_run})`,
      fields: [
        { name: "Market", value: normalized.market || "all", inline: true },
        { name: "State", value: normalized.state || "all", inline: true },
        { name: "Dry Run", value: String(Boolean(normalized.dry_run)), inline: true },
      ],
      dedupe_key: `feed_candidates_started:${normalized.market || "all"}:${normalized.state || "all"}`,
      throttle_window_seconds: 60,
    });

    const diagnostics = await runSupabaseCandidateFeeder(normalized, options.deps || {});

    await notifyDiscordOps({
      event_type: diagnostics.ok === false ? "feed_candidates_failed" : "feed_candidates_completed",
      severity: diagnostics.ok === false ? "error" : "success",
      domain: "feeder",
      title: diagnostics.ok === false ? "Feed Candidates Failed" : "Feed Candidates Completed",
      summary: diagnostics.ok === false
        ? `Feeder run failed: ${clean(diagnostics?.reason) || "unknown"}`
        : `Feeder run completed: scanned=${diagnostics.scanned_count || 0}, eligible=${diagnostics.eligible_count || 0}, queued=${diagnostics.queued_count || 0}`,
      fields: [
        { name: "Scanned", value: String(diagnostics.scanned_count || 0), inline: true },
        { name: "Eligible", value: String(diagnostics.eligible_count || 0), inline: true },
        { name: "Queued", value: String(diagnostics.queued_count || 0), inline: true },
      ],
      metadata: {
        dry_run: Boolean(normalized.dry_run),
        result: diagnostics,
      },
      should_alert_critical: diagnostics.ok === false,
    });

    return json_response(
      {
        ok: diagnostics.ok !== false,
        route,
        loaded_count: diagnostics.scanned_count,
        eligible_count: diagnostics.eligible_count,
        inserted_count: diagnostics.queued_count,
        ...diagnostics,
      },
      { status: statusForResult(diagnostics) }
    );
  } catch (error) {
    route_logger?.error?.("feed_candidates_request.failed", {
      route: feeder_request_meta?.route || route,
      method,
      dry_run: feeder_request_meta?.dry_run ?? null,
      limit: feeder_request_meta?.limit ?? null,
      scan_limit: feeder_request_meta?.scan_limit ?? null,
      error: error?.message || "feed_candidates_failed",
      stack: error?.stack || null,
    });

    captureRouteException(error, {
      route,
      subsystem: "outbound_feeder",
      context: { method, ...(feeder_request_meta || {}) },
    });

    await notifyDiscordOps({
      event_type: "feed_candidates_failed",
      severity: "critical",
      domain: "feeder",
      title: "Feed Candidates Request Failed",
      summary: clean(error?.message) || "feed_candidates_failed",
      metadata: { route, method, ...(feeder_request_meta || {}) },
      should_alert_critical: true,
    });

    return json_response(
      {
        ok: false,
        route,
        error: error?.message || "feed_candidates_failed",
        message: error?.message || "feed_candidates_failed",
        queued_count: 0,
        scheduled_count: 0,
        invalid_scheduled_for_count: 0,
      },
      { status: 500 }
    );
  }
}
