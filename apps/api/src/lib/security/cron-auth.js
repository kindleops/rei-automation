import { NextResponse } from "next/server";
import {
  DEPLOYMENT_PROVIDERS,
  describeRuntimeEnvironment,
  isExplicitNonProductionRuntime,
  resolveRuntimeIdentity,
} from "@/lib/config/runtime-environment.js";
import {
  getSharedSecretAuthResult,
  timingSafeSecretEqual,
} from "./shared-secret.js";

function clean(value) {
  return String(value ?? "").trim();
}

async function getQueueEngineSharedSecret() {
  const env_secret = clean(process.env.QUEUE_ENGINE_SHARED_SECRET);
  if (env_secret) return env_secret;

  const { getSystemValue } = await import("@/lib/system-control.js");
  return clean(await getSystemValue("queue_engine_shared_secret"));
}

function readProvidedCronSecret(request) {
  const authorization = clean(request?.headers?.get("authorization"));
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return clean(request?.headers?.get("x-vercel-cron-secret"));
}

/**
 * Provider-neutral scheduled-invocation provenance.
 *
 * Returns the scheduler that originated the request, or null for a manual /
 * human call:
 *   "vercel"      - legacy Vercel Cron (user-agent vercel-cron/1.0)
 *   "cloudflare"  - Cloudflare Cron Trigger -> Worker scheduled() -> this API,
 *                   which sets x-internal-cron-source
 *   <other>       - any future scheduler that sets the same header
 *
 * THIS IS PROVENANCE, NOT AUTHENTICATION. The header is never sufficient on its
 * own: CRON_SECRET remains the sole authority, and callers only consult
 * provenance after authentication has already succeeded.
 *
 * Note the safety direction: the one behavioural consumer of this signal
 * (queue_processor_mode === "safe") SKIPS auto-sending when it is set. A
 * spoofed header can therefore only make the system more conservative, never
 * less -- and without the correct secret the request is rejected regardless.
 */
function readCronSource(request) {
  const declared = clean(request?.headers?.get("x-internal-cron-source")).toLowerCase();
  if (declared) return declared;

  const user_agent = clean(request?.headers?.get("user-agent"));
  if (user_agent.includes("vercel-cron/1.0")) return "vercel";

  return null;
}

export function getCronAuthResult(request) {
  const cron_secret = clean(process.env.CRON_SECRET);
  const authorization = clean(request?.headers?.get("authorization"));
  const user_agent = clean(request?.headers?.get("user-agent"));
  const is_vercel_cron = user_agent.includes("vercel-cron/1.0");
  // Provider-neutral replacement for is_vercel_cron. is_vercel_cron is retained
  // for log compatibility, but behavioural branching must use these.
  const cron_source = readCronSource(request);
  const is_scheduled_cron = Boolean(cron_source);
  const provided_secret = readProvidedCronSecret(request);
  // FAIL CLOSED. The old check was `VERCEL_ENV === "production"` alone, which is
  // unset on Cloudflare Containers and any non-Vercel host - so a missing
  // CRON_SECRET silently authorized every cron caller there. The permissive
  // branch now requires PROOF of a dev/test runtime; an unrecognised or empty
  // environment is treated as production and rejected.
  const runtime_environment = describeRuntimeEnvironment();
  const secret_optional = isExplicitNonProductionRuntime();

  if (!cron_secret) {
    if (!secret_optional) {
      return {
        ok: false,
        status: 500,
        reason: "missing_cron_secret",
        is_vercel_cron,
        is_scheduled_cron,
        cron_source,
        runtime_environment,
        user_agent: user_agent || null,
      };
    }

    return {
      ok: true,
      authenticated: false,
      required: false,
      reason: "cron_secret_not_configured",
      is_vercel_cron,
      is_scheduled_cron,
      cron_source,
      runtime_environment,
      user_agent: user_agent || null,
    };
  }

  // Constant-time comparison via the shared primitive. Behaviourally identical
  // to the previous `!provided_secret || provided_secret !== cron_secret`:
  // an empty presented secret and a length mismatch are both rejections.
  if (!timingSafeSecretEqual(provided_secret, cron_secret)) {
    return {
      ok: false,
      status: 401,
      reason: "invalid_cron_authorization",
      is_vercel_cron,
      is_scheduled_cron,
      cron_source,
      runtime_environment,
      user_agent: user_agent || null,
    };
  }

  return {
    ok: true,
    authenticated: true,
    required: true,
    reason: "authorized",
    is_vercel_cron,
    is_scheduled_cron,
    cron_source,
    runtime_environment,
    user_agent: user_agent || null,
  };
}

export function requireCronAuth(request, logger = null) {
  const auth = getCronAuthResult(request);

  if (auth.ok) {
    return {
      authorized: true,
      auth,
      response: null,
    };
  }

  logger?.warn?.("cron_auth.rejected", {
    reason: auth.reason,
    is_vercel_cron: auth.is_vercel_cron,
    is_scheduled_cron: auth.is_scheduled_cron,
    cron_source: auth.cron_source,
    user_agent: auth.user_agent,
  });

  return {
    authorized: false,
    auth,
    response: NextResponse.json(
      {
        ok: false,
        error: auth.reason,
      },
      { status: auth.status || 401 }
    ),
  };
}

export async function requireCronOrEngineAuth(request, logger = null) {
  const cron_result = requireCronAuth(request, logger);
  if (cron_result.authorized) return cron_result;

  const queue_secret = await getQueueEngineSharedSecret();
  if (!queue_secret) {
    logger?.warn?.("queue_engine_secret.not_configured", {
      hint: "Set QUEUE_ENGINE_SHARED_SECRET or system_control['queue_engine_shared_secret'] to protect this endpoint from non-cron callers",
    });
    return cron_result;
  }

  const engine_result = getSharedSecretAuthResult(request, {
    env_name: "QUEUE_ENGINE_SHARED_SECRET",
    header_names: ["x-queue-engine-secret"],
    expected_token: queue_secret,
  });

  if (engine_result.ok) {
    return {
      authorized: true,
      auth: {
        authenticated: true,
        is_vercel_cron: false,
        is_scheduled_cron: false,
        cron_source: null,
        via: engine_result.via || "x-queue-engine-secret",
      },
      response: null,
    };
  }

  logger?.warn?.("queue_engine_secret.rejected", {
    reason: engine_result.reason,
    via: engine_result.via || null,
  });
  return cron_result;
}

/**
 * THE gate for a scheduled job that MUTATES production state.
 *
 * requireCronAuth proves the CALLER holds the cron secret. It does not prove
 * WHICH DEPLOYMENT is running, and that gap matters here: the Cloudflare Worker
 * sets NODE_ENV=production for the staging container too, and staging SHARES
 * THE PRODUCTION DATABASE. A job gated only on "is production" would therefore
 * also run from staging, against real seller rows.
 *
 * So a scheduled mutation additionally requires an unambiguous deployment
 * identity:
 *
 *   cloudflare:production  -> allowed   (the real production deployment)
 *   cloudflare:staging     -> DENIED    (shares the prod DB; not authoritative)
 *   anything:test/dev      -> allowed   (provably harmless local/test runtime)
 *   unknown identity       -> DENIED    (a missing binding is a config error)
 *
 * Default-deny: only a POSITIVE production binding, or POSITIVE proof of a
 * non-production runtime, may proceed. This is deliberately stricter than
 * requireCronAuth and is composed WITH it, never instead of it.
 */
export function requireScheduledMutationAuth(request, logger = null) {
  const cron_result = requireCronAuth(request, logger);
  if (!cron_result.authorized) return cron_result;

  const identity = resolveRuntimeIdentity();
  /**
   * PROVIDER, not just environment. The doc above always said
   * `cloudflare:production -> allowed`, but the check was
   * `is_production_deployment` alone, which is true for ANY provider whose
   * deployment environment resolves to production.
   *
   * PRODUCTION-COMMISSIONING-1B: that gap was load-bearing. A Vercel
   * deployment holding its own copies of SUPABASE_SERVICE_ROLE_KEY and the
   * TextGrid credentials resolved to `vercel:production` — Vercel injects
   * VERCEL_ENV itself — and therefore PASSED this gate. It ran 15 crons,
   * including /api/internal/queue/run every minute, against the production
   * database from a build 135 commits behind. It is currently silent only
   * because the project is billing-disabled (HTTP 402, DEPLOYMENT_DISABLED),
   * which is an accident, not a boundary: restoring billing would resurrect it.
   *
   * Rotating a shared secret does NOT fence it, because its crons invoke its
   * OWN routes and validate against its OWN env — the caller and the validator
   * are the same deployment, so it authenticates against itself no matter what
   * this side rotates.
   *
   * What it can never forge is the provider identity, because
   * DEPLOYMENT_PROVIDER=cloudflare is baked into the container image at build
   * time (apps/api/Dockerfile) rather than supplied as deployment config. So a
   * production scheduled mutation now requires the cloudflare provider.
   *
   * Non-production runtimes are unaffected: an explicitly non-production
   * identity (local, test) still passes, which is what keeps the suite honest.
   */
  const production_on_governed_provider =
    identity.is_production_deployment &&
    identity.provider === DEPLOYMENT_PROVIDERS.CLOUDFLARE;
  const allowed = production_on_governed_provider || identity.is_explicit_non_production;

  if (!allowed) {
    logger?.warn?.("scheduled_mutation.denied_by_runtime_identity", {
      provider: identity.provider,
      environment: identity.environment,
      label: identity.label,
    });
    return {
      authorized: false,
      auth: { ...cron_result.auth, runtime_identity: identity },
      response: NextResponse.json(
        {
          ok: false,
          error: "scheduled_mutation_runtime_not_authorized",
          runtime_identity: identity.label,
          message:
            "A scheduled mutation requires an unambiguous production deployment identity. " +
            "Staging shares the production database and is never authoritative.",
        },
        { status: 403 }
      ),
    };
  }

  return {
    authorized: true,
    auth: { ...cron_result.auth, runtime_identity: identity },
    response: null,
  };
}

export default requireCronAuth;
