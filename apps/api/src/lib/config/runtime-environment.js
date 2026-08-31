/**
 * Canonical deployment-runtime detection.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production detection was duplicated in seven places, each re-deriving
 * `NODE_ENV === "production" || VERCEL_ENV === "production"` locally. One of
 * them - src/lib/security/cron-auth.js - drifted and checked VERCEL_ENV ALONE.
 * On any non-Vercel host (Cloudflare Containers, plain Node, Docker) VERCEL_ENV
 * is unset, so that call site silently concluded "not production" and failed
 * OPEN on a missing CRON_SECRET.
 *
 * This module is the single definition. It is host-agnostic: Vercel, Cloudflare
 * Containers, and generic Node production all resolve correctly.
 *
 * THE TWO PREDICATES ARE NOT OPPOSITES - that asymmetry is the safety property.
 *
 *   isProductionRuntime()            "we can PROVE this is production"
 *   isExplicitNonProductionRuntime() "we can PROVE this is dev/test/preview"
 *
 * A runtime with no environment markers at all - a misconfigured container that
 * forgot to set NODE_ENV - satisfies NEITHER. Security decisions must branch on
 * `isExplicitNonProductionRuntime()` and treat "unknown" as production, so a
 * configuration mistake fails CLOSED rather than granting access.
 */

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * True only when the runtime is positively identified as production.
 *
 * - NODE_ENV=production   - generic Node, Docker, Cloudflare Containers
 * - VERCEL_ENV=production - legacy Vercel (retained; harmless once unset)
 */
export function isProductionRuntime(env = process.env) {
  return lower(env.NODE_ENV) === "production" || lower(env.VERCEL_ENV) === "production";
}

/**
 * True only when the runtime is positively identified as NOT production.
 *
 * Anything unrecognised - including a completely empty environment - returns
 * false, so callers that fail closed on `!isExplicitNonProductionRuntime()`
 * stay safe when deployment configuration is missing or wrong.
 */
export function isExplicitNonProductionRuntime(env = process.env) {
  if (isProductionRuntime(env)) return false;

  const node_env = lower(env.NODE_ENV);
  const vercel_env = lower(env.VERCEL_ENV);

  return (
    node_env === "development" ||
    node_env === "test" ||
    vercel_env === "preview" ||
    vercel_env === "development"
  );
}

/**
 * Diagnostic label. Never used for an authorization decision.
 */
export function describeRuntimeEnvironment(env = process.env) {
  if (isProductionRuntime(env)) return "production";
  if (isExplicitNonProductionRuntime(env)) return "non_production";
  return "unknown";
}

export default {
  isProductionRuntime,
  isExplicitNonProductionRuntime,
  describeRuntimeEnvironment,
};
