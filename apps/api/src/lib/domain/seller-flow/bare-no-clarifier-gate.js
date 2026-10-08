/**
 * BARE_NO_AUTO_CLARIFIER (owner, round 10 2026-10-08): an ambiguous bare "No"
 * to the ownership question must NOT trigger an automatic clarifier until the
 * contextual behaviour is validated.
 *
 * Double gate, the IC8 pattern (intelligence/config/flags.js): ON only when
 *   1. the env ceiling process.env.BARE_NO_AUTO_CLARIFIER === "true", AND
 *   2. the runtime switch system_control.bare_no_auto_clarifier is truthy.
 * Missing, unreadable, slow or malformed = OFF. Never throws.
 *
 * The production worker does not forward BARE_NO_AUTO_CLARIFIER yet, so the
 * ceiling is OFF in production until that forward is added deliberately.
 */

import { settleWithin } from "@/lib/domain/intelligence/util/async.js";

export const BARE_NO_AUTO_CLARIFIER_FLAG = Object.freeze({
  env: "BARE_NO_AUTO_CLARIFIER",
  control: "bare_no_auto_clarifier",
});

const TRUE_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);
const DEFAULT_TIMEOUT_MS = 250;

function truthy(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

async function defaultReadSystemFlag(key) {
  const { getSystemFlag } = await import("@/lib/system-control.js");
  return getSystemFlag(key);
}

/** Both gates. Returns { enabled, ceiling, runtime, reason }; never throws. */
export async function isBareNoAutoClarifierEnabled({
  env = process.env,
  readSystemFlag = defaultReadSystemFlag,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const ceiling = String(env?.[BARE_NO_AUTO_CLARIFIER_FLAG.env] ?? "").trim().toLowerCase() === "true";
  if (!ceiling) return { enabled: false, ceiling: false, runtime: false, reason: "env_ceiling_off" };
  if (typeof readSystemFlag !== "function") {
    return { enabled: false, ceiling: true, runtime: false, reason: "runtime_reader_unavailable" };
  }
  const result = await settleWithin(() => readSystemFlag(BARE_NO_AUTO_CLARIFIER_FLAG.control), timeoutMs);
  if (result.timedOut) return { enabled: false, ceiling: true, runtime: false, reason: "runtime_reader_timeout" };
  if (result.error) return { enabled: false, ceiling: true, runtime: false, reason: "runtime_reader_error" };
  const on = truthy(result.value);
  return { enabled: on, ceiling: true, runtime: on, reason: on ? "on" : "runtime_off_or_missing" };
}

export default isBareNoAutoClarifierEnabled;
