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

// ── live_limited activation scope ───────────────────────────────────────────
// live_limited is the only mode that can auto-reply to a real seller, so it
// must never become a blanket switch: setting the mode alone would make every
// inbound message already sitting in the database eligible, including the
// unanswered backlog that the */5 recover-inbound cron re-scans on a rolling
// 72-hour lookback. Two independent scope inputs bound it, both fail-closed:
//
//   auto_reply_eligibility_cutoff_at — REQUIRED. Inbound received before the
//     cutoff can never be auto-replied to. Missing/blank/unparseable ⇒ denied,
//     so flipping the mode without setting a cutoff is inert.
//   auto_reply_thread_allowlist — OPTIONAL. When non-empty, only the listed
//     threads/phones are eligible (canary scoping). Empty ⇒ no thread
//     restriction, the cutoff alone bounds eligibility (ramp/full volume).

export const AUTO_REPLY_CUTOFF_KEY = "auto_reply_eligibility_cutoff_at";
export const AUTO_REPLY_ALLOWLIST_KEY = "auto_reply_thread_allowlist";

function parseTimestampMs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Both the literal form and a digits-only form, so +1-404-372-4312 == +14043724312. */
function scopeKeyVariants(value) {
  const literal = clean(value).toLowerCase();
  if (!literal) return [];
  const digits = literal.replace(/\D+/g, "");
  const variants = [literal];
  if (digits) {
    variants.push(digits);
    // Tolerate a US country-code prefix mismatch between stored thread keys
    // and operator-entered allowlist entries.
    if (digits.length === 11 && digits.startsWith("1")) variants.push(digits.slice(1));
    if (digits.length === 10) variants.push(`1${digits}`);
  }
  return variants;
}

export function normalizeAutoReplyThreadAllowlist(value) {
  // Entries are separated by comma / semicolon / newline only — never by bare
  // whitespace, so an operator can paste "+1 (612) 807-2000" as one entry.
  const entries = Array.isArray(value) ? value : clean(value).split(/[,;\n\r]+/);
  const normalized = new Set();
  for (const entry of entries) {
    for (const variant of scopeKeyVariants(entry)) normalized.add(variant);
  }
  return normalized;
}

/**
 * Pure scope gate for live_limited. Every denial reason is explicit so proof
 * runs and audits can assert exactly why a send was withheld.
 */
export function evaluateAutoReplyScope({
  inboundFrom = "",
  threadKey = "",
  inboundReceivedAt = null,
  cutoffAt = null,
  threadAllowlist = null,
} = {}) {
  const cutoff_ms = parseTimestampMs(cutoffAt);
  if (!cutoff_ms) {
    return { allowed: false, reason: "auto_reply_cutoff_not_configured" };
  }

  const received_ms = parseTimestampMs(inboundReceivedAt);
  if (!received_ms) {
    return { allowed: false, reason: "auto_reply_inbound_timestamp_missing" };
  }
  if (received_ms < cutoff_ms) {
    return {
      allowed: false,
      reason: "auto_reply_inbound_before_cutoff",
      cutoff_at: new Date(cutoff_ms).toISOString(),
      inbound_received_at: new Date(received_ms).toISOString(),
    };
  }

  const allowlist = normalizeAutoReplyThreadAllowlist(threadAllowlist);
  if (allowlist.size > 0) {
    const candidates = [
      ...scopeKeyVariants(threadKey),
      ...scopeKeyVariants(inboundFrom),
    ];
    const matched = candidates.some((candidate) => allowlist.has(candidate));
    if (!matched) {
      return { allowed: false, reason: "auto_reply_thread_not_allowlisted", allowlist_enforced: true };
    }
    return { allowed: true, reason: "auto_reply_scope_allowlisted", allowlist_enforced: true };
  }

  return { allowed: true, reason: "auto_reply_scope_after_cutoff", allowlist_enforced: false };
}

export function autoReplyModeAllowsQueue({
  mode = "disabled",
  inboundFrom = "",
  threadKey = "",
  inboundReceivedAt = null,
  cutoffAt = null,
  threadAllowlist = null,
  // Capability probes (does this MODE permit sending at all?) pass false.
  // Every gate that decides whether a specific inbound message gets a reply
  // must leave this true — that is what keeps live_limited fail-closed.
  enforceScope = true,
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
    if (!enforceScope) {
      return {
        allowed: true,
        reason: "live_limited_capability_probe",
        internal_test_phone,
        scope_enforced: false,
      };
    }

    const scope = evaluateAutoReplyScope({
      inboundFrom,
      threadKey,
      inboundReceivedAt,
      cutoffAt,
      threadAllowlist,
    });

    return {
      allowed: scope.allowed,
      reason: scope.allowed ? "live_limited" : scope.reason,
      internal_test_phone,
      scope_enforced: true,
      scope,
    };
  }

  return {
    allowed: false,
    reason: normalized_mode === "dry_run" ? "dry_run" : "auto_reply_disabled",
    internal_test_phone,
  };
}

/**
 * Loads the live_limited scope inputs from system_control. Returns nulls when
 * no reader is available — the gate treats that as "no cutoff" and denies.
 */
export async function resolveAutoReplyScopeConfig({ getSystemValue = null } = {}) {
  const read =
    typeof getSystemValue === "function"
      ? getSystemValue
      : (await import("@/lib/system-control.js")).getSystemValue;

  const [cutoffAt, threadAllowlist] = await Promise.all([
    Promise.resolve(read(AUTO_REPLY_CUTOFF_KEY)).catch(() => null),
    Promise.resolve(read(AUTO_REPLY_ALLOWLIST_KEY)).catch(() => null),
  ]);

  return { cutoffAt: clean(cutoffAt) || null, threadAllowlist: clean(threadAllowlist) || null };
}
