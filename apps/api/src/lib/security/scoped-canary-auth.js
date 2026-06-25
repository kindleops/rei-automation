import { NextResponse } from "next/server.js";
import { getSharedSecretAuthResult } from "@/lib/security/shared-secret.js";
import { getSystemValue } from "@/lib/system-control.js";

function clean(value) {
  return String(value ?? "").trim();
}

async function resolveScopedCanarySecret() {
  const env_secret =
    clean(process.env.SCOPED_CANARY_EXECUTION_SECRET) ||
    clean(process.env.QUEUE_ENGINE_SHARED_SECRET);
  if (env_secret) return env_secret;
  return clean(await getSystemValue("queue_engine_shared_secret"));
}

export async function requireScopedCanaryExecutionAuth(request, logger = null) {
  const secret = await resolveScopedCanarySecret();
  if (!secret) {
    return {
      authorized: false,
      status: 500,
      reason: "scoped_canary_secret_not_configured",
      response: NextResponse.json(
        { ok: false, error: "scoped_canary_secret_not_configured" },
        { status: 500 }
      ),
    };
  }

  const auth = getSharedSecretAuthResult(request, {
    env_name: "SCOPED_CANARY_EXECUTION_SECRET",
    header_names: [
      "x-scoped-canary-secret",
      "x-queue-engine-secret",
      "x-cron-secret",
    ],
    expected_token: secret,
  });

  if (!auth.ok) {
    logger?.warn?.("scoped_canary_auth.rejected", {
      reason: auth.reason,
      via: auth.via || null,
    });
    return {
      authorized: false,
      status: 401,
      reason: auth.reason || "unauthorized",
      response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }),
    };
  }

  return {
    authorized: true,
    status: 200,
    via: auth.via,
    response: null,
  };
}

export function readCanaryAuthorizationToken(request, body = {}) {
  return clean(
    body?.canary_authorization_token ||
      body?.authorization_token ||
      request?.headers?.get?.("x-canary-authorization-token")
  );
}