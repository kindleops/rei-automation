import { NextResponse } from "next/server.js";
import { getSharedSecretAuthResult } from "@/lib/security/shared-secret.js";
import { resolveQueueEngineOperationalSecrets } from "@/lib/security/queue-engine-internal-auth.js";

function clean(value) {
  return String(value ?? "").trim();
}

// Consumes the canonical queue-engine resolver so dispatch and enqueue can
// never again disagree about who the queue engine is. Previously this was
// first-match-wins (env OR control plane), which silently excluded a valid
// rotation-window credential; the canonical resolver accepts every configured
// source concurrently.
async function resolveScopedCanarySecret() {
  const secrets = await resolveQueueEngineOperationalSecrets();
  return secrets.length ? secrets[0] : "";
}

export async function requireScopedCanaryExecutionAuth(request, logger = null) {
  const secrets = await resolveQueueEngineOperationalSecrets();
  if (!secrets.length) {
    return {
      authorized: false,
      status: 401,
      reason: "scoped_canary_secret_not_configured",
      response: NextResponse.json(
        { ok: false, error: "unauthorized", reason: "scoped_canary_secret_not_configured" },
        { status: 401 }
      ),
    };
  }

  // Try every currently-valid credential, not just the first. A rotation
  // window in which the Worker and the control plane hold different values
  // must authenticate against either - which is exactly the drift that made
  // dispatch reachable while enqueue was not.
  let auth = { ok: false, reason: "unauthorized", via: null };
  for (const candidate of secrets) {
    const attempt = getSharedSecretAuthResult(request, {
      env_name: "SCOPED_CANARY_EXECUTION_SECRET",
      header_names: [
        "x-scoped-canary-secret",
        "x-queue-engine-secret",
        "x-internal-api-secret",
        "x-cron-secret",
      ],
      expected_token: candidate,
    });
    if (attempt.ok) { auth = attempt; break; }
    auth = { ...attempt, ok: false };
  }

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