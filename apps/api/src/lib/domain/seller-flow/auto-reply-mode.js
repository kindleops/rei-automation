import { isInternalTestPhone } from "../../config/internal-phones.js";

export const AUTO_REPLY_MODES = Object.freeze([
  "disabled",
  "dry_run",
  "internal_only",
  "live_limited",
]);

const VALID_AUTO_REPLY_MODES = new Set(AUTO_REPLY_MODES);

function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeAutoReplyMode(value, fallback = "disabled") {
  const normalized = clean(value).toLowerCase().replace(/[-\s]+/g, "_");
  if (VALID_AUTO_REPLY_MODES.has(normalized)) return normalized;
  return fallback;
}

export function resolveGuardedAutoReplyMode({
  requestedMode = null,
  env = process.env,
  systemMode = null,
  legacyEnabled = false,
  legacyDryRun = false,
  legacyLiveEnabled = false,
} = {}) {
  const system_mode = normalizeAutoReplyMode(systemMode, null);
  if (system_mode) return { mode: system_mode, source: "system_control" };

  const explicit = normalizeAutoReplyMode(requestedMode, null);
  if (explicit) return { mode: explicit, source: "request" };

  const env_mode = normalizeAutoReplyMode(
    env?.AUTO_REPLY_MODE || env?.INBOUND_AUTOPILOT_MODE,
    null
  );
  if (env_mode) return { mode: env_mode, source: "env" };

  if (legacyEnabled && legacyDryRun) {
    return { mode: "dry_run", source: "legacy_dry_run_flag" };
  }

  // auto_reply_mode is the authoritative send gate. Legacy live flags
  // (auto_reply_enabled/auto_reply_live_enabled) are diagnostics only and
  // must never enable public sending by themselves: missing/blank/invalid
  // mode fails closed to disabled.
  if (legacyEnabled && legacyLiveEnabled) {
    return {
      mode: "disabled",
      source: "legacy_live_flags_blocked",
      legacy_live_fallthrough_blocked: true,
      audit_reason: "auto_reply_mode_missing_or_invalid",
    };
  }

  return { mode: "disabled", source: "default_disabled" };
}

export function autoReplyModeAllowsDiagnostics(mode = "disabled") {
  return normalizeAutoReplyMode(mode) !== "disabled";
}

export function autoReplyModeAllowsQueue({
  mode = "disabled",
  inboundFrom = "",
  threadKey = "",
  isInternalTestPhoneImpl = isInternalTestPhone,
} = {}) {
  const normalized_mode = normalizeAutoReplyMode(mode);
  const phone = clean(inboundFrom) || clean(threadKey);
  const internal_test_phone = Boolean(isInternalTestPhoneImpl(phone));

  if (normalized_mode === "internal_only") {
    return {
      allowed: internal_test_phone,
      reason: internal_test_phone ? "internal_test_phone" : "internal_only_non_internal",
      internal_test_phone,
    };
  }

  if (normalized_mode === "live_limited") {
    return {
      allowed: true,
      reason: "live_limited",
      internal_test_phone,
    };
  }

  return {
    allowed: false,
    reason: normalized_mode === "dry_run" ? "dry_run" : "auto_reply_disabled",
    internal_test_phone,
  };
}
