import { getSystemValue } from "@/lib/system-control.js";

export const QUEUE_EXECUTION_MODES = Object.freeze({
  STOPPED: "stopped",
  NORMAL: "normal",
  SCOPED_CANARY_ONLY: "scoped_canary_only",
});

const ALLOWED = new Set(Object.values(QUEUE_EXECUTION_MODES));

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeQueueExecutionMode(value, fallback = QUEUE_EXECUTION_MODES.STOPPED) {
  const normalized = clean(value);
  return ALLOWED.has(normalized) ? normalized : fallback;
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