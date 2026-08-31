import { NextResponse } from "next/server";
import {
  describeRuntimeEnvironment,
  isExplicitNonProductionRuntime,
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

export function getCronAuthResult(request) {
  const cron_secret = clean(process.env.CRON_SECRET);
  const authorization = clean(request?.headers?.get("authorization"));
  const user_agent = clean(request?.headers?.get("user-agent"));
  const is_vercel_cron = user_agent.includes("vercel-cron/1.0");
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

export default requireCronAuth;
