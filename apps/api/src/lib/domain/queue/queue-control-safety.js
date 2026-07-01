const CAMPAIGN_MODES = new Set(["paused", "dry_run", "live_limited", "live"]);

export function clean(value) {
  return String(value ?? "").trim();
}

export function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function asPositiveInteger(value, fallback = null) {
  if (value === null || value === undefined || clean(value) === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function firstPresent(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && clean(value) === "") continue;
    return value;
  }
  return null;
}

export function normalizeCampaignMode(value, fallback = "paused") {
  const raw = clean(value || fallback).toLowerCase();
  const aliases = {
    off: "paused",
    pause: "paused",
    paused: "paused",
    safe: "dry_run",
    assisted: "dry_run",
    preview: "dry_run",
    dryrun: "dry_run",
    dry_run: "dry_run",
    limited: "live_limited",
    live_limited: "live_limited",
    automatic: "live_limited",
    live: "live",
  };
  const mode = aliases[raw] || raw;
  return CAMPAIGN_MODES.has(mode) ? mode : "paused";
}

export function normalizeQueueProcessorMode(value, fallback = "paused") {
  const raw = clean(value || fallback).toLowerCase();
  if (["off", "paused", "pause"].includes(raw)) return "off";
  if (["safe", "assisted", "dry_run", "dryrun", "preview"].includes(raw)) return "safe";
  if (["live", "automatic", "on", "enabled", "active"].includes(raw)) return "live";
  return "off";
}

export function normalizeSafetyInput(input = {}, settings = {}) {
  const caps = input?.caps && typeof input.caps === "object" ? input.caps : {};
  const campaign_mode = normalizeCampaignMode(
    firstPresent(
      input.campaign_mode,
      caps.campaign_mode,
      settings.campaign_mode,
      settings.queue_campaign_mode,
      input.mode
    ),
    normalizeCampaignMode(firstPresent(settings.campaign_mode, settings.queue_campaign_mode, settings.queue_processor_mode), "paused")
  );
  const limit = asPositiveInteger(firstPresent(input.limit, input.target_count, caps.sends_per_run, settings.queue_run_limit), 1);
  const hard_cap = asPositiveInteger(firstPresent(input.hard_cap, input.queue_hard_cap, caps.hard_cap, settings.queue_hard_cap), null);
  const max_batch_size = asPositiveInteger(
    firstPresent(input.max_batch_size, input.queue_max_batch_size, caps.max_batch_size, caps.sends_per_run, settings.queue_max_batch_size),
    null
  );
  const daily_cap = asPositiveInteger(firstPresent(input.daily_cap, input.queue_daily_send_cap, caps.daily_cap, settings.queue_daily_send_cap), null);
  const market_cap = asPositiveInteger(
    firstPresent(input.market_cap, input.queue_market_cap, input.max_per_market_per_hour, caps.market_cap, caps.max_per_market_per_hour, settings.queue_market_cap, settings.queue_market_throttle),
    null
  );
  const per_number_cap = asPositiveInteger(
    firstPresent(input.per_number_cap, input.queue_per_number_cap, input.max_per_number_per_day, caps.per_number_cap, caps.max_per_number_per_day, settings.queue_per_number_cap, settings.queue_sender_throttle),
    null
  );
  const scan_limit = asPositiveInteger(firstPresent(input.scan_limit, input.candidate_fetch_limit, settings.queue_scan_limit), null);
  const market = clean(firstPresent(input.market, input.market_filter, settings.queue_market_filter, settings.market)) || null;
  const state = clean(firstPresent(input.state, input.state_filter, settings.queue_state_filter, settings.state)) || null;
  const all_market_ack = asBoolean(firstPresent(input.all_market_ack, caps.all_market_ack, settings.queue_all_market_ack), false);

  return {
    campaign_mode,
    limit,
    hard_cap,
    max_batch_size,
    daily_cap,
    market_cap,
    per_number_cap,
    scan_limit,
    market,
    state,
    all_market_ack,
  };
}

export function validateLiveLimitedRails(input = {}, options = {}) {
  const {
    campaign_mode,
    limit,
    hard_cap,
    max_batch_size,
    daily_cap,
    market_cap,
    per_number_cap,
    market,
    state,
    all_market_ack,
  } = input;
  const require_scope = options.require_scope !== false;
  const require_send_caps = options.require_send_caps !== false;
  const missing = [];

  if (campaign_mode !== "live_limited") missing.push("campaign_mode_live_limited");
  if (!hard_cap) missing.push("hard_cap");
  if (!max_batch_size) missing.push("max_batch_size");
  if (require_send_caps && !daily_cap) missing.push("daily_cap");
  if (require_send_caps && !market_cap) missing.push("market_cap");
  if (require_send_caps && !per_number_cap) missing.push("per_number_cap");
  if (require_scope && !market && !state && all_market_ack !== true) missing.push("market_or_state_filter_or_all_market_ack");

  const requested_limit = Math.max(1, asPositiveInteger(limit, 1));
  const effective_max = Math.min(
    hard_cap || Number.POSITIVE_INFINITY,
    max_batch_size || Number.POSITIVE_INFINITY
  );
  const effective_limit = Number.isFinite(effective_max)
    ? Math.min(requested_limit, effective_max)
    : requested_limit;

  if (missing.length > 0) {
    return {
      ok: false,
      status: 423,
      reason: "live_limited_rails_required",
      message: "Live queue work requires campaign_mode=live_limited with explicit caps and scope.",
      missing,
      safety: input,
    };
  }

  return {
    ok: true,
    status: 200,
    effective_limit,
    requested_limit,
    safety: input,
  };
}

export function blockedSafetyResult(validation, action = "queue_action") {
  return {
    ok: false,
    action,
    error: validation?.reason || "safety_rails_required",
    reason: validation?.reason || "safety_rails_required",
    message: validation?.message || "Queue action blocked by safety rails.",
    missing: validation?.missing || [],
    diagnostics: {
      safety: validation?.safety || null,
    },
  };
}

export function isEmergencyStopActive(value) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "off", "none", "null", "cleared", "clear"].includes(normalized);
}

function runtimeBrakeBlocked(reason, message, settings = {}, action = "queue_action") {
  return {
    ok: false,
    status: 423,
    action,
    error: "runtime_brake_active",
    reason,
    message,
    diagnostics: {
      queue_processor_mode: clean(settings.queue_processor_mode) || null,
      campaign_mode: clean(settings.campaign_mode) || null,
      auto_reply_mode: clean(settings.auto_reply_mode) || null,
      queue_auto_send_enabled: clean(settings.queue_auto_send_enabled) || null,
      queue_auto_enqueue_enabled: clean(settings.queue_auto_enqueue_enabled) || null,
      queue_emergency_stop_at: clean(settings.queue_emergency_stop_at) || null,
    },
  };
}

export function evaluateQueueSendRuntimeBrakes(settings = {}, options = {}) {
  const action = clean(options.action) || "queue_send";
  const fail_closed = options.failClosed === true;
  const emergency_stop_at = settings.queue_emergency_stop_at;
  if (isEmergencyStopActive(emergency_stop_at)) {
    return runtimeBrakeBlocked(
      "queue_emergency_stop_active",
      "Emergency stop is active; live queue sends are blocked.",
      settings,
      action
    );
  }

  const raw_mode = clean(settings.queue_processor_mode);
  const queue_processor_mode = raw_mode
    ? normalizeQueueProcessorMode(raw_mode)
    : fail_closed
      ? "off"
      : null;
  if (queue_processor_mode === "off") {
    return runtimeBrakeBlocked(
      "queue_processor_paused",
      "queue_processor_mode is off/paused; live sends are blocked.",
      settings,
      action
    );
  }

  return {
    ok: true,
    status: 200,
    action,
    diagnostics: {
      queue_processor_mode,
      queue_emergency_stop_at: clean(emergency_stop_at) || null,
    },
  };
}

export function evaluateQueueCreationRuntimeBrakes(settings = {}, options = {}) {
  const action = clean(options.action) || "queue_create";
  const fail_closed = options.failClosed === true;
  const require_auto_enqueue = options.requireAutoEnqueue === true;
  const emergency_stop_at = settings.queue_emergency_stop_at;
  if (isEmergencyStopActive(emergency_stop_at)) {
    return runtimeBrakeBlocked(
      "queue_emergency_stop_active",
      "Emergency stop is active; live queue creation is blocked.",
      settings,
      action
    );
  }

  const raw_campaign_mode = clean(settings.campaign_mode);
  const campaign_mode = raw_campaign_mode
    ? normalizeCampaignMode(raw_campaign_mode)
    : fail_closed
      ? "paused"
      : null;
  if (campaign_mode === "paused") {
    return runtimeBrakeBlocked(
      "campaign_paused",
      "campaign_mode is paused; live queue creation is blocked.",
      settings,
      action
    );
  }

  if (campaign_mode && campaign_mode !== "live_limited") {
    return runtimeBrakeBlocked(
      "campaign_not_live_limited",
      "campaign_mode must be live_limited before live queue creation.",
      settings,
      action
    );
  }

  if (require_auto_enqueue && !asBoolean(settings.queue_auto_enqueue_enabled, false)) {
    return runtimeBrakeBlocked(
      "queue_auto_enqueue_disabled",
      "queue_auto_enqueue_enabled is false; automatic queue creation is blocked.",
      settings,
      action
    );
  }

  return {
    ok: true,
    status: 200,
    action,
    diagnostics: {
      campaign_mode,
      queue_auto_enqueue_enabled: clean(settings.queue_auto_enqueue_enabled) || null,
      queue_emergency_stop_at: clean(emergency_stop_at) || null,
    },
  };
}

export function blockedRuntimeBrakeResult(evaluation = {}, action = "queue_action") {
  return {
    ok: false,
    action,
    error: evaluation.error || "runtime_brake_active",
    reason: evaluation.reason || "runtime_brake_active",
    message: evaluation.message || "Runtime safety brake is active.",
    diagnostics: evaluation.diagnostics || {},
  };
}
