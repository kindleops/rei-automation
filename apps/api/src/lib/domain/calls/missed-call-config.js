// Missed-call auto-text — configuration.
//
// TWO switches, both default OFF:
//   1. env MISSED_CALL_AUTOTEXT_ENABLED === "true"   (deploy-time ceiling)
//      Off  -> the voice webhook answers <Reject reason="busy"/> and writes
//              nothing. No call log, no forward, no text.
//   2. system_control.missed_call_autotext_enabled === "true" (operator switch)
//      Off  -> calls are still forwarded (if OWNER_FORWARD_NUMBER is set) and
//              logged in the thread, but the text is SKIPPED with reason
//              "autotext_disabled". This is the observe stage.
//
// Nothing here can send: the text itself only ever goes through the canonical
// queue writer, and the queue processor owns provider dispatch.

import { normalizePhone } from "@/lib/utils/phones.js";

export const MISSED_CALL_SYSTEM_CONTROL_KEY = "missed_call_autotext_enabled";
export const MISSED_CALL_USE_CASE = "missed_call";
export const MISSED_CALL_DEFAULT_PERSONA = "Alex";
export const MISSED_CALL_DEFAULT_LANGUAGE = "English";

function clean(value) {
  return String(value ?? "").trim();
}

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(clean(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function isTruthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

/**
 * Deploy-time configuration from the environment. Pure; pass `env` in tests.
 */
export function readMissedCallEnv(env = process.env) {
  const forward_raw = clean(env.OWNER_FORWARD_NUMBER);
  const forward_number = forward_raw ? normalizePhone(forward_raw) || null : null;
  return {
    // Strict: only the literal "true" enables, mirroring the worker's
    // default-deny normalization.
    enabled: clean(env.MISSED_CALL_AUTOTEXT_ENABLED).toLowerCase() === "true",
    forward_number,
    forward_number_invalid: Boolean(forward_raw) && !forward_number,
    forward_timeout_seconds: boundedInt(env.MISSED_CALL_FORWARD_TIMEOUT_SECONDS, 20, 5, 60),
    // No text if we sent this caller anything within this many minutes.
    recent_outbound_minutes: boundedInt(env.MISSED_CALL_RECENT_OUTBOUND_MINUTES, 30, 0, 24 * 60),
    // No text if the conversation (either direction) moved this recently.
    active_conversation_minutes: boundedInt(env.MISSED_CALL_ACTIVE_CONVERSATION_MINUTES, 30, 0, 24 * 60),
    // One missed-call text per caller per this many hours.
    per_caller_hours: boundedInt(env.MISSED_CALL_PER_CALLER_HOURS, 24, 1, 24 * 14),
  };
}

/**
 * The operator switch. Fails CLOSED: a lookup error or a missing row is off.
 */
export async function isMissedCallAutotextSwitchOn(getSystemValue) {
  if (typeof getSystemValue !== "function") return false;
  try {
    return isTruthyFlag(await getSystemValue(MISSED_CALL_SYSTEM_CONTROL_KEY));
  } catch {
    return false;
  }
}

export default {
  MISSED_CALL_SYSTEM_CONTROL_KEY,
  MISSED_CALL_USE_CASE,
  readMissedCallEnv,
  isMissedCallAutotextSwitchOn,
};
