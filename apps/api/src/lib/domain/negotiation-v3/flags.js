// ─── negotiation-v3/flags.js ────────────────────────────────────────────────
// §84: separate flags, no master switch. Both default OFF.
//   NEGOTIATION_ENGINE_V3        the v3 plan/move may run in a live path (otherwise shadow/replay only)
//   AUTONOMOUS_MONETARY_QUOTES   a QUOTE move may go out without a human (otherwise every money move is HUMAN)
// Turning one on never turns the other on.

export const NEGOTIATION_ENGINE_V3_FLAG = "NEGOTIATION_ENGINE_V3";
export const AUTONOMOUS_MONETARY_QUOTES_FLAG = "AUTONOMOUS_MONETARY_QUOTES";

const ON = new Set(["1", "true", "on", "yes", "enabled"]);
const isOn = (v) => ON.has(String(v ?? "").trim().toLowerCase());

export function isNegotiationEngineV3Enabled(env = process.env) {
  return isOn(env?.[NEGOTIATION_ENGINE_V3_FLAG]);
}

/** Autonomous money needs BOTH flags: the quotes flag alone does nothing. */
export function isAutonomousMonetaryQuotesEnabled(env = process.env) {
  return isNegotiationEngineV3Enabled(env) && isOn(env?.[AUTONOMOUS_MONETARY_QUOTES_FLAG]);
}

export function resolveNegotiationFlags(env = process.env) {
  return {
    engine_v3: isNegotiationEngineV3Enabled(env),
    autonomous_monetary_quotes: isAutonomousMonetaryQuotesEnabled(env),
  };
}
