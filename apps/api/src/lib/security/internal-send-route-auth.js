// ─── internal-send-route-auth.js ────────────────────────────────────────────
// Authentication for the /api/internal/* routes that can trigger, or queue, a
// seller-facing SMS: outbound/send-now, outbound/direct-send,
// outbound/queue-message and queue/seed-test.
//
// THE DEFECT THIS CLOSES (send-authorization audit, 2026-11-11). Those route
// files and their handlers checked no credential. middleware.js only adds CORS
// headers and refuses Command Wall display credentials, so anyone who knew the
// URL could make the API build and dispatch an SMS.
//
// FAIL CLOSED, IN EVERY ENVIRONMENT.
//   * INTERNAL_API_SECRET unset        -> 503 internal_api_secret_not_configured
//     (unlike getSharedSecretAuthResult, a missing secret is never "open" outside
//     production: a preview or staging deployment can reach the real provider)
//   * no token presented               -> 401 missing_internal_api_secret_token
//   * token does not match             -> 401 invalid_internal_api_secret_token
// Only INTERNAL_API_SECRET is accepted: CRON_SECRET and the queue-engine secret
// authorize scheduled automation, not ad-hoc sends. The comparison is
// constant-time, with the same semantics as shared-secret.js's
// timingSafeSecretEqual (re-stated here so this module carries no next/server
// import into the domain handlers that use it).
//
// Accepted presentations: `x-internal-api-secret: <secret>` or
// `Authorization: Bearer <secret>`. Query strings and bodies are never read.

import crypto from "node:crypto";

function clean(value) {
  return String(value ?? "").trim();
}

function timingSafeSecretEqual(left, right) {
  const a = Buffer.from(clean(left), "utf8");
  const b = Buffer.from(clean(right), "utf8");
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function presentedToken(request) {
  const header = clean(request?.headers?.get?.("x-internal-api-secret"));
  if (header) return { token: header, via: "header:x-internal-api-secret" };
  const authorization = clean(request?.headers?.get?.("authorization"));
  if (authorization.toLowerCase().startsWith("bearer ")) {
    const token = clean(authorization.slice(7));
    if (token) return { token, via: "authorization" };
  }
  return null;
}

/**
 * @param {Request} request
 * @param {{ env?: object }} [options]  env override for tests
 * @returns {{ ok: true, via: string } | { ok: false, status: number, error: string }}
 */
export function authorizeInternalSendRoute(request, { env = process.env } = {}) {
  const secret = clean(env?.INTERNAL_API_SECRET);
  if (!secret) {
    return { ok: false, status: 503, error: "internal_api_secret_not_configured" };
  }
  const presented = presentedToken(request);
  if (!presented) {
    return { ok: false, status: 401, error: "missing_internal_api_secret_token" };
  }
  if (!timingSafeSecretEqual(presented.token, secret)) {
    return { ok: false, status: 401, error: "invalid_internal_api_secret_token" };
  }
  return { ok: true, via: presented.via };
}

/** The refusal body every guarded route returns (no detail beyond the reason). */
export function internalSendRouteRefusal(auth, route) {
  return {
    status: auth.status,
    payload: { ok: false, route, error: auth.error },
  };
}

export default authorizeInternalSendRoute;
