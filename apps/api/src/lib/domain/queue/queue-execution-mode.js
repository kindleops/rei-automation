import { getSystemValue } from "@/lib/system-control.js";

export const QUEUE_EXECUTION_MODES = Object.freeze({
  STOPPED: "stopped",
  NORMAL: "normal",
  SCOPED_CANARY_ONLY: "scoped_canary_only",
});

const ALLOWED = new Set(Object.values(QUEUE_EXECUTION_MODES));

/**
 * Canonical fail-closed storage value. Operators and code should write this.
 */
export const CANONICAL_FAIL_CLOSED_EXECUTION_MODE = QUEUE_EXECUTION_MODES.STOPPED;

/**
 * Legacy values that may exist in production system_control rows and have a
 * known, safe meaning. Production was frozen on 2026-07-29 with the literal
 * 'paused', which is NOT canonical but IS unambiguously a stop. Mapping it
 * explicitly (rather than letting it fall through the unknown-value branch)
 * keeps the audit trail honest: a legacy stop is recognised as a stop, not
 * silently reinterpreted.
 *
 * The SQL mirror queue_execution_mode_normalized() reaches the same verdict via
 * its ELSE branch (see 20260625200000_queue_atomic_claim_containment.sql).
 */
export const QUEUE_EXECUTION_MODE_LEGACY_ALIASES = Object.freeze({
  paused: QUEUE_EXECUTION_MODES.STOPPED,
  pause: QUEUE_EXECUTION_MODES.STOPPED,
});

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeQueueExecutionMode(value, fallback = QUEUE_EXECUTION_MODES.STOPPED) {
  const normalized = clean(value);
  if (ALLOWED.has(normalized)) return normalized;
  if (Object.hasOwn(QUEUE_EXECUTION_MODE_LEGACY_ALIASES, normalized)) {
    return QUEUE_EXECUTION_MODE_LEGACY_ALIASES[normalized];
  }
  return fallback;
}

/**
 * Classify a raw stored value for observability. Unknown values are reported as
 * such (and still fail closed) so an operator can see that the stored posture
 * was not understood, instead of it looking like a deliberate stop.
 *
 * @returns {{ mode: string, raw: string, source: 'canonical'|'legacy_alias'|'unknown_fail_closed', fail_closed: boolean }}
 */
export function describeQueueExecutionMode(value) {
  const raw = clean(value);
  if (ALLOWED.has(raw)) {
    return { mode: raw, raw, source: "canonical", fail_closed: raw !== QUEUE_EXECUTION_MODES.NORMAL };
  }
  if (Object.hasOwn(QUEUE_EXECUTION_MODE_LEGACY_ALIASES, raw)) {
    const mode = QUEUE_EXECUTION_MODE_LEGACY_ALIASES[raw];
    return { mode, raw, source: "legacy_alias", fail_closed: true };
  }
  return {
    mode: CANONICAL_FAIL_CLOSED_EXECUTION_MODE,
    raw,
    source: "unknown_fail_closed",
    fail_closed: true,
  };
}

export async function getQueueExecutionMode(deps = {}) {
  const get_value = deps.getSystemValue || getSystemValue;
  const raw = await get_value("queue_execution_mode", deps);
  return normalizeQueueExecutionMode(raw, QUEUE_EXECUTION_MODES.STOPPED);
}

export function evaluateUnrestrictedDispatchGate(mode, options = {}) {
  const normalized = normalizeQueueExecutionMode(mode);
  const action = options.action || "unrestricted_queue_dispatch";

  if (normalized === QUEUE_EXECUTION_MODES.STOPPED) {
    return blocked("queue_execution_mode_stopped", action, normalized);
  }
  if (normalized === QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY) {
    return blocked("queue_execution_mode_scoped_canary_only", action, normalized);
  }
  return { ok: true, mode: normalized, action };
}

export function evaluateScopedCanaryDispatchGate(mode, options = {}) {
  const normalized = normalizeQueueExecutionMode(mode);
  const action = options.action || "scoped_canary_dispatch";

  if (normalized !== QUEUE_EXECUTION_MODES.SCOPED_CANARY_ONLY) {
    return blocked("queue_execution_mode_not_scoped_canary_only", action, normalized);
  }
  return { ok: true, mode: normalized, action };
}

function blocked(reason, action, mode) {
  return {
    ok: false,
    status: 423,
    reason,
    error: reason,
    action,
    message:
      reason === "queue_execution_mode_stopped"
        ? "Queue execution mode is stopped; dispatch is blocked."
        : reason === "queue_execution_mode_scoped_canary_only"
          ? "Queue execution mode is scoped_canary_only; unrestricted dispatch is blocked."
          : "Queue execution mode must be scoped_canary_only for scoped canary dispatch.",
    queue_execution_mode: mode,
    sent_count: 0,
    claimed_count: 0,
    skipped: true,
  };
}

export function blockedExecutionModeResult(gate, action = "queue_action") {
  return {
    ok: false,
    status: gate.status || 423,
    error: gate.reason,
    reason: gate.reason,
    action,
    message: gate.message,
    queue_execution_mode: gate.queue_execution_mode,
    skipped: true,
    sent_count: 0,
    claimed_count: 0,
    results: [],
  };
}