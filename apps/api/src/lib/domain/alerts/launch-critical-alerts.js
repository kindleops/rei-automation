/**
 * launch-critical-alerts.js
 *
 * Canonical Supabase-backed sink for launch-critical operational alerts.
 *
 * Why this exists: the pre-existing system-alerts.js stores alerts as Podio
 * items in the Message Events app. Production carries no Podio credentials, so
 * every launch-critical alert was silently failing to persist — alerting looked
 * healthy while delivering nothing. Worse, two of its Podio reads sit outside
 * their try blocks, so a Podio failure threw INTO the caller (autopilot route,
 * retry runner, webhook handlers), turning a missing alert into a 500.
 *
 * This module writes to `notification_events`, the project's existing canonical
 * operator-facing event table (live in production, dashboard-wired through
 * /api/cockpit/notifications). No new observability table is introduced.
 *
 * Contract: recording an alert MUST NEVER throw and MUST NEVER block the
 * operation that raised it. Alerting is observability, not control flow.
 */

import { child } from "@/lib/logging/logger.js";
import { upsertNotificationEvent } from "@/lib/domain/notifications/notification-intelligence-service.js";

const logger = child({ module: "alerts.launch_critical" });

export const LAUNCH_ALERT_DOMAIN = "launch_safety";

/**
 * The launch-critical alert codes that must be observable in production.
 * Kept as an explicit frozen catalog so a test can assert full coverage.
 */
export const LAUNCH_CRITICAL_ALERT_CODES = Object.freeze({
  QUEUE_DISPATCH_FAILURE: "queue_dispatch_failure",
  INBOUND_WEBHOOK_FAILURE: "inbound_webhook_failure",
  DELIVERY_WEBHOOK_FAILURE: "delivery_webhook_failure",
  BURST_FLUSH_FAILURE: "burst_flush_failure",
  QUEUE_RUN_FAILURE: "queue_run_failure",
  SUPPRESSION_INVARIANT_FAILURE: "suppression_invariant_failure",
  CANARY_SCOPE_VIOLATION: "canary_scope_violation",
  UNEXPECTED_OUTBOUND_WHILE_STOPPED: "unexpected_outbound_while_stopped",
});

/**
 * notification_events.severity is CHECK-constrained to
 * positive|neutral|warning|critical. system-alerts.js uses info|warning|high|
 * critical, so map the legacy vocabulary rather than violating the constraint.
 */
const SEVERITY_MAP = Object.freeze({
  info: "neutral",
  neutral: "neutral",
  low: "neutral",
  warning: "warning",
  warn: "warning",
  high: "critical",
  critical: "critical",
  fatal: "critical",
});

export function normalizeLaunchAlertSeverity(value, fallback = "warning") {
  const key = String(value ?? "").trim().toLowerCase();
  return SEVERITY_MAP[key] ?? fallback;
}

/**
 * Alerts that always warrant the strongest severity regardless of caller input:
 * these represent a broken safety invariant, not a degraded dependency.
 */
const ALWAYS_CRITICAL = new Set([
  LAUNCH_CRITICAL_ALERT_CODES.SUPPRESSION_INVARIANT_FAILURE,
  LAUNCH_CRITICAL_ALERT_CODES.CANARY_SCOPE_VIOLATION,
  LAUNCH_CRITICAL_ALERT_CODES.UNEXPECTED_OUTBOUND_WHILE_STOPPED,
]);

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Never let alert metadata carry message content or secrets into an ops table.
 */
const FORBIDDEN_METADATA_KEYS = [
  "secret",
  "token",
  "auth",
  "password",
  "api_key",
  "apikey",
  "credential",
  "message_body",
  "message_text",
  "body",
  "rendered_message",
  "service_role",
];

export function sanitizeAlertMetadata(metadata = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_METADATA_KEYS.some((fragment) => lowered.includes(fragment))) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      safe[key] = Array.isArray(value) ? value.slice(0, 25) : sanitizeAlertMetadata(value);
      continue;
    }
    safe[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  return safe;
}

/**
 * Record a launch-critical alert.
 *
 * @param {object} input
 * @param {string} input.code one of LAUNCH_CRITICAL_ALERT_CODES (free-form allowed)
 * @param {string} [input.severity] info|warning|high|critical (legacy vocabulary accepted)
 * @param {string} [input.summary] one-line operator-facing summary
 * @param {string} [input.subsystem] e.g. "queue", "inbound", "delivery"
 * @param {object} [input.metadata] sanitized before persistence
 * @param {string} [input.dedupe_key] defaults to subsystem:code
 * @param {object} [deps] { upsertNotificationEvent }
 * @returns {Promise<{ok: boolean, id?: string, error?: string, skipped?: boolean}>}
 */
export async function recordLaunchCriticalAlert(input = {}, deps = {}) {
  const upsert = deps.upsertNotificationEvent || upsertNotificationEvent;
  const code = clean(input.code) || "unspecified_launch_alert";
  const subsystem = clean(input.subsystem) || "launch";
  const severity = ALWAYS_CRITICAL.has(code)
    ? "critical"
    : normalizeLaunchAlertSeverity(input.severity);
  const dedupeKey = clean(input.dedupe_key) || `launch_safety:${subsystem}:${code}`;

  try {
    const result = await upsert({
      event_type: `launch_safety.${code}`,
      domain: LAUNCH_ALERT_DOMAIN,
      severity,
      title: clean(input.summary) || code.replace(/_/g, " "),
      description: clean(input.description) || clean(input.summary) || null,
      source_entity_type: clean(input.source_entity_type) || "launch_safety",
      source_entity_id: clean(input.source_entity_id) || code,
      campaign_id: input.campaign_id ?? null,
      metrics_snapshot: sanitizeAlertMetadata({
        ...input.metadata,
        subsystem,
        alert_code: code,
        reported_severity: clean(input.severity) || null,
      }),
      deduplication_key: dedupeKey,
      grouping_key: `launch_safety:${subsystem}`,
      sound_category: severity === "critical" ? "critical" : "ops",
    });

    if (!result?.ok) {
      logger.warn("launch_alert.persist_failed", { code, subsystem, error: result?.error || null });
      return { ok: false, error: result?.error || "persist_failed" };
    }
    logger.info("launch_alert.persisted", { code, subsystem, severity, id: result.id || null });
    return { ok: true, id: result.id, evolved: Boolean(result.evolved) };
  } catch (error) {
    // Alerting must never propagate. A failed alert is logged and dropped.
    logger.error("launch_alert.persist_threw", {
      code,
      subsystem,
      error_message: error?.message || "unknown_error",
    });
    return { ok: false, error: "alert_persist_threw" };
  }
}

/**
 * Mark a previously recorded launch-critical alert resolved.
 * Never throws; a missing alert is not an error.
 */
export async function resolveLaunchCriticalAlert(input = {}, deps = {}) {
  const code = clean(input.code);
  const subsystem = clean(input.subsystem) || "launch";
  const dedupeKey = clean(input.dedupe_key) || `launch_safety:${subsystem}:${code}`;

  try {
    const { resolveNotificationByDeduplicationKey } = await import(
      "@/lib/domain/notifications/notification-intelligence-service.js"
    );
    const resolver = deps.resolveNotification || resolveNotificationByDeduplicationKey;
    if (typeof resolver !== "function") {
      return { ok: true, resolved: false, reason: "resolver_unavailable" };
    }
    const result = await resolver(dedupeKey, {
      resolution_message: clean(input.resolution_message) || null,
    });
    return { ok: true, resolved: Boolean(result?.ok && result?.resolved !== false) };
  } catch (error) {
    logger.warn("launch_alert.resolve_failed", {
      code,
      subsystem,
      error_message: error?.message || "unknown_error",
    });
    return { ok: true, resolved: false, reason: "resolve_failed" };
  }
}

/** Convenience wrappers for the mandated launch-critical failure paths. */
export const launchAlerts = Object.freeze({
  queueDispatchFailure: (metadata, deps) =>
    recordLaunchCriticalAlert(
      {
        code: LAUNCH_CRITICAL_ALERT_CODES.QUEUE_DISPATCH_FAILURE,
        subsystem: "queue",
        severity: "high",
        summary: "Queue dispatch failed",
        metadata,
      },
      deps,
    ),
  queueRunFailure: (metadata, deps) =>
    recordLaunchCriticalAlert(
      {
        code: LAUNCH_CRITICAL_ALERT_CODES.QUEUE_RUN_FAILURE,
        subsystem: "queue",
        severity: "high",
        summary: "Queue run failed",
        metadata,
      },
      deps,
    ),
  inboundWebhookFailure: (metadata, deps) =>
    recordLaunchCriticalAlert(
      {
        code: LAUNCH_CRITICAL_ALERT_CODES.INBOUND_WEBHOOK_FAILURE,
        subsystem: "inbound",
        severity: "high",
        summary: "Inbound webhook processing failed",
        metadata,
      },
      deps,
    ),
  deliveryWebhookFailure: (metadata, deps) =>
    recordLaunchCriticalAlert(
      {
        code: LAUNCH_CRITICAL_ALERT_CODES.DELIVERY_WEBHOOK_FAILURE,
        subsystem: "delivery",
        severity: "high",
        summary: "Delivery webhook processing failed",
        metadata,
      },
      deps,
    ),
  burstFlushFailure: (metadata, deps) =>
    recordLaunchCriticalAlert(
      {
        code: LAUNCH_CRITICAL_ALERT_CODES.BURST_FLUSH_FAILURE,
        subsystem: "seller_inbound_burst",
        severity: "high",
        summary: "Seller inbound burst flush failed",
        metadata,
      },
      deps,
    ),
  suppressionInvariantFailure: (metadata, deps) =>
    recordLaunchCriticalAlert(
      {
        code: LAUNCH_CRITICAL_ALERT_CODES.SUPPRESSION_INVARIANT_FAILURE,
        subsystem: "suppression",
        summary: "Suppression invariant violated",
        metadata,
      },
      deps,
    ),
  canaryScopeViolation: (metadata, deps) =>
    recordLaunchCriticalAlert(
      {
        code: LAUNCH_CRITICAL_ALERT_CODES.CANARY_SCOPE_VIOLATION,
        subsystem: "canary",
        summary: "Canary scope violation detected",
        metadata,
      },
      deps,
    ),
  unexpectedOutboundWhileStopped: (metadata, deps) =>
    recordLaunchCriticalAlert(
      {
        code: LAUNCH_CRITICAL_ALERT_CODES.UNEXPECTED_OUTBOUND_WHILE_STOPPED,
        subsystem: "queue",
        summary: "Outbound send attempted while execution mode was not normal",
        metadata,
      },
      deps,
    ),
});

export default { recordLaunchCriticalAlert, launchAlerts, LAUNCH_CRITICAL_ALERT_CODES };
