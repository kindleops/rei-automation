/**
 * IC8 FLAGS: the double gate (architecture §10).
 *
 * A flag is ON only when BOTH are true:
 *   1. the env ceiling: process.env.<NAME> === "true" (the worker forwards
 *      these default-deny; a stray deploy cannot enable a flag whose runtime
 *      switch is off, and vice versa);
 *   2. the runtime switch: system_control.<name in lower case> is truthy, read
 *      through an injected reader (production wires getSystemFlag, 30 s cache).
 * Missing, unreadable, slow or malformed = OFF. Reading a flag never throws.
 *
 * Toggles go through setRuntimeFlag: it writes the switch and an
 * intelligence.control_audit row, and reverts the switch if the audit row
 * cannot be written (no unaudited change survives).
 *
 * The autonomy kill switch is inverted and fail-closed: absent = PAUSED.
 */

import { settleWithin } from "../util/async.js";

export const IC8_FLAGS = Object.freeze({
  INTELLIGENCE_LOGGING_ENABLED: Object.freeze({ env: "INTELLIGENCE_LOGGING_ENABLED", control: "intelligence_logging_enabled" }),
  SELLER_MODEL_SHADOW: Object.freeze({ env: "SELLER_MODEL_SHADOW", control: "seller_model_shadow" }),
  CONVERSATION_MODEL_SHADOW: Object.freeze({ env: "CONVERSATION_MODEL_SHADOW", control: "conversation_model_shadow" }),
  COMP_CHALLENGER_SHADOW: Object.freeze({ env: "COMP_CHALLENGER_SHADOW", control: "comp_challenger_shadow" }),
  CAMPAIGN_POLICY_SHADOW: Object.freeze({ env: "CAMPAIGN_POLICY_SHADOW", control: "campaign_policy_shadow" }),
  STRATEGY_RECOMMENDATIONS_ENABLED: Object.freeze({ env: "STRATEGY_RECOMMENDATIONS_ENABLED", control: "strategy_recommendations_enabled" }),
  CAMPAIGN_AUTONOMY_ENABLED: Object.freeze({ env: "CAMPAIGN_AUTONOMY_ENABLED", control: "campaign_autonomy_enabled" }),
});

/** Kill switch for anything past Level 0. Absent/unreadable = paused. */
export const AUTONOMY_PAUSED_KEY = "intelligence_autonomy_paused";
export const DEFAULT_FLAG_READ_TIMEOUT_MS = 250;
const TRUE_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);

export class FlagError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FlagError";
    this.code = code;
  }
}

export function getFlagSpec(name) {
  const spec = IC8_FLAGS[name];
  if (!spec) throw new FlagError(`unknown IC8 flag ${name}`, "UNKNOWN_FLAG");
  return spec;
}

/** Env ceiling: synchronous, exact "true" only (the worker forwards "true"/"false"). */
export function envCeiling(name, env = process.env) {
  const spec = IC8_FLAGS[name];
  if (!spec || !env) return false;
  return String(env[spec.env] ?? "").trim().toLowerCase() === "true";
}

function truthy(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

/** Runtime switch via the injected reader (key -> boolean|string). Never throws; any failure is OFF. */
export async function readRuntimeSwitch(name, { readSystemFlag, timeoutMs = DEFAULT_FLAG_READ_TIMEOUT_MS } = {}) {
  const spec = IC8_FLAGS[name];
  if (!spec || typeof readSystemFlag !== "function") return { on: false, reason: spec ? "reader_unavailable" : "unknown_flag" };
  const result = await settleWithin(() => readSystemFlag(spec.control), timeoutMs);
  if (result.timedOut) return { on: false, reason: "reader_timeout" };
  if (result.error) return { on: false, reason: "reader_error" };
  return { on: truthy(result.value), reason: truthy(result.value) ? "on" : "off_or_missing" };
}

/** Both gates. Returns { enabled, ceiling, runtime, reason }; never throws. */
export async function isFlagEnabled(name, { env = process.env, readSystemFlag, timeoutMs } = {}) {
  if (!IC8_FLAGS[name]) return { enabled: false, ceiling: false, runtime: false, reason: "unknown_flag" };
  const ceiling = envCeiling(name, env);
  if (!ceiling) return { enabled: false, ceiling: false, runtime: false, reason: "env_ceiling_off" };
  const runtime = await readRuntimeSwitch(name, { readSystemFlag, timeoutMs });
  return { enabled: runtime.on, ceiling: true, runtime: runtime.on, reason: runtime.on ? "on" : `runtime_${runtime.reason}` };
}

/**
 * A cached gate for hot paths (the journal): ceiling() is synchronous; enabled()
 * re-reads the runtime switch at most every ttlMs.
 */
export function createFlagGate(name, { env = process.env, readSystemFlag, ttlMs = 30_000, timeoutMs = DEFAULT_FLAG_READ_TIMEOUT_MS, now = () => Date.now() } = {}) {
  getFlagSpec(name);
  let cached = null;
  return Object.freeze({
    name,
    ceiling: () => envCeiling(name, env),
    async enabled() {
      if (!envCeiling(name, env)) return false;
      if (cached && now() - cached.at < ttlMs) return cached.on;
      const runtime = await readRuntimeSwitch(name, { readSystemFlag, timeoutMs });
      cached = { on: runtime.on, at: now() };
      return runtime.on;
    },
    invalidate() {
      cached = null;
    },
  });
}

/** Autonomy kill switch: paused unless system_control says exactly false. Fail-closed. */
export async function isAutonomyPaused({ readSystemValue, timeoutMs = DEFAULT_FLAG_READ_TIMEOUT_MS } = {}) {
  if (typeof readSystemValue !== "function") return true;
  const result = await settleWithin(() => readSystemValue(AUTONOMY_PAUSED_KEY), timeoutMs);
  if (result.timedOut || result.error) return true;
  return String(result.value ?? "").trim().toLowerCase() !== "false";
}

/**
 * Audited runtime toggle (the IC8 operator route calls this).
 * deps: { store (insertControlAudit), readSystemValue(key), writeSystemValue(key, value), now }
 * The env ceiling is deploy-time only and cannot be changed here.
 */
export async function setRuntimeFlag({ flag, enabled, actor, reason } = {}, { store, readSystemValue, writeSystemValue, now = () => Date.now() } = {}) {
  const spec = IC8_FLAGS[flag];
  if (!spec) return { ok: false, code: "UNKNOWN_FLAG" };
  if (typeof enabled !== "boolean") return { ok: false, code: "ENABLED_MUST_BE_BOOLEAN" };
  if (!String(actor ?? "").trim()) return { ok: false, code: "ACTOR_REQUIRED" };
  if (!String(reason ?? "").trim()) return { ok: false, code: "REASON_REQUIRED" };
  if (!store || typeof store.insertControlAudit !== "function" || typeof writeSystemValue !== "function") {
    return { ok: false, code: "TOGGLE_UNCONFIGURED" };
  }
  let oldValue = null;
  if (typeof readSystemValue === "function") {
    const read = await settleWithin(() => readSystemValue(spec.control), 2000);
    oldValue = read.value === undefined || read.value === null ? null : String(read.value);
  }
  const newValue = enabled ? "true" : "false";
  const written = await settleWithin(() => writeSystemValue(spec.control, newValue), 5000);
  if (written.timedOut || written.error || (written.value && written.value.ok === false)) {
    return { ok: false, code: "SWITCH_WRITE_FAILED" };
  }
  const audit = await store.insertControlAudit({
    key: spec.control,
    old_value: oldValue,
    new_value: newValue,
    actor: String(actor).trim().slice(0, 200),
    reason: String(reason).trim().slice(0, 1000),
    at: new Date(now()).toISOString(),
  });
  if (!audit || audit.ok !== true) {
    const reverted = await settleWithin(() => writeSystemValue(spec.control, oldValue ?? "false"), 5000);
    const revertOk = !reverted.timedOut && !reverted.error && !(reverted.value && reverted.value.ok === false);
    return { ok: false, code: revertOk ? "AUDIT_WRITE_FAILED_REVERTED" : "AUDIT_WRITE_FAILED_REVERT_FAILED" };
  }
  return { ok: true, key: spec.control, old_value: oldValue, new_value: newValue };
}
