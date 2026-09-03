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
 *
 * DEPLOYMENT IDENTITY (added for scheduler commissioning)
 * ------------------------------------------------------
 * `isProductionRuntime()` is NOT sufficient to authorize a scheduled mutation.
 * The Cloudflare Worker sets NODE_ENV=production for BOTH the staging and the
 * production container (staging runs a production build), so NODE_ENV alone
 * cannot tell them apart -- and staging SHARES THE PRODUCTION DATABASE. A job
 * authorized purely on "is production" would therefore also run from staging.
 *
 * The discriminator is the canonical deployment binding the Worker already
 * forwards: DEPLOYMENT_ENV (staging|production) and DEPLOYMENT_PROVIDER
 * (cloudflare). `resolveRuntimeIdentity()` reports both, and every value is
 * default-deny: anything unrecognised resolves to "unknown", never to
 * production. Hostnames are never consulted -- a canonical binding exists.
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

/** Canonical deployment providers. Anything else is "unknown". */
export const DEPLOYMENT_PROVIDERS = Object.freeze({
  CLOUDFLARE: "cloudflare",
  VERCEL: "vercel",
  UNKNOWN: "unknown",
});

/** Canonical deployment environments. Anything else is "unknown". */
export const DEPLOYMENT_ENVIRONMENTS = Object.freeze({
  PRODUCTION: "production",
  STAGING: "staging",
  PREVIEW: "preview",
  DEVELOPMENT: "development",
  TEST: "test",
  UNKNOWN: "unknown",
});

/**
 * Which host is running this code. Default-deny: an absent or unrecognised
 * DEPLOYMENT_PROVIDER is "unknown", never assumed to be the current host.
 */
export function getDeploymentProvider(env = process.env) {
  const declared = lower(env.DEPLOYMENT_PROVIDER) || lower(env.RUNTIME_PROVIDER);
  if (declared === "cloudflare") return DEPLOYMENT_PROVIDERS.CLOUDFLARE;
  if (declared === "vercel") return DEPLOYMENT_PROVIDERS.VERCEL;
  // Vercel injects VERCEL_ENV itself, so it can still be recognised without an
  // explicit binding. There is no equivalent ambient signal for Cloudflare.
  if (lower(env.VERCEL_ENV)) return DEPLOYMENT_PROVIDERS.VERCEL;
  return DEPLOYMENT_PROVIDERS.UNKNOWN;
}

/**
 * WHICH deployment this is - not merely whether it is a production BUILD.
 *
 * Precedence is explicit-binding first: DEPLOYMENT_ENV / DEPLOY_ENV / APP_ENV
 * are canonical deployment identity. NODE_ENV is only a build mode and is
 * consulted last, because a staging container is also NODE_ENV=production.
 */
export function getDeploymentEnvironment(env = process.env) {
  const declared =
    lower(env.DEPLOYMENT_ENV) || lower(env.DEPLOY_ENV) || lower(env.APP_ENV);
  if (declared) {
    if (declared === "production" || declared === "prod") return DEPLOYMENT_ENVIRONMENTS.PRODUCTION;
    if (declared === "staging" || declared === "stage") return DEPLOYMENT_ENVIRONMENTS.STAGING;
    if (declared === "preview") return DEPLOYMENT_ENVIRONMENTS.PREVIEW;
    if (declared === "development" || declared === "dev") return DEPLOYMENT_ENVIRONMENTS.DEVELOPMENT;
    if (declared === "test") return DEPLOYMENT_ENVIRONMENTS.TEST;
    // An explicit-but-unrecognised binding is a configuration error. Fail to
    // "unknown" so scheduled mutation is denied rather than mis-attributed.
    return DEPLOYMENT_ENVIRONMENTS.UNKNOWN;
  }

  const vercel_env = lower(env.VERCEL_ENV);
  if (vercel_env === "production") return DEPLOYMENT_ENVIRONMENTS.PRODUCTION;
  if (vercel_env === "preview") return DEPLOYMENT_ENVIRONMENTS.PREVIEW;
  if (vercel_env === "development") return DEPLOYMENT_ENVIRONMENTS.DEVELOPMENT;

  const node_env = lower(env.NODE_ENV);
  if (node_env === "test") return DEPLOYMENT_ENVIRONMENTS.TEST;
  if (node_env === "development") return DEPLOYMENT_ENVIRONMENTS.DEVELOPMENT;

  // NODE_ENV=production with NO deployment binding is genuinely ambiguous: it
  // could be production, staging, or a local production build. Do not guess.
  return DEPLOYMENT_ENVIRONMENTS.UNKNOWN;
}

/**
 * The single identity object security code should branch on.
 *
 * `is_production_deployment` is the ONLY property that may authorize a
 * production-scoped scheduled mutation. It is true only when the deployment
 * binding positively says production - so Cloudflare staging (which is also
 * NODE_ENV=production) is correctly excluded.
 */
export function resolveRuntimeIdentity(env = process.env) {
  const provider = getDeploymentProvider(env);
  const environment = getDeploymentEnvironment(env);
  return {
    provider,
    environment,
    label: `${provider}:${environment}`,
    is_production_build: isProductionRuntime(env),
    is_explicit_non_production: isExplicitNonProductionRuntime(env),
    is_production_deployment: environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION,
  };
}

export default {
  isProductionRuntime,
  isExplicitNonProductionRuntime,
  describeRuntimeEnvironment,
  getDeploymentProvider,
  getDeploymentEnvironment,
  resolveRuntimeIdentity,
  DEPLOYMENT_PROVIDERS,
  DEPLOYMENT_ENVIRONMENTS,
};
