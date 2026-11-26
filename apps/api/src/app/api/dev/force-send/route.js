import { requireDevRouteAccess } from "@/lib/security/dev-route-guard.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(value) {
  return String(value ?? "").trim();
}

function isProductionRuntime(env = process.env) {
  return clean(env.NODE_ENV) === "production" || clean(env.VERCEL_ENV) === "production";
}

// P0 round 4 (2026-11-26, condition 6 item 8): this route calls TextGrid
// directly, outside every send seam. "Not production" used to mean "NODE_ENV is
// not production", which is a guess about the runtime, not a decision anyone
// made: a container started without NODE_ENV (or with NODE_ENV=development)
// served it. It now refuses unless the deployment EXPLICITLY declares itself a
// non-production environment that permits force-send, whatever NODE_ENV says.
// The production check still runs first and still wins over the flag.
export const DEV_FORCE_SEND_FLAG = "DEV_FORCE_SEND_NON_PRODUCTION";
export const DEV_FORCE_SEND_FLAG_VALUE = "allow_non_production_force_send";

export function isDevForceSendExplicitlyAllowed(env = process.env) {
  return clean(env?.[DEV_FORCE_SEND_FLAG]) === DEV_FORCE_SEND_FLAG_VALUE;
}

export async function handleDevForceSendRequest(request, deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;

  if (isProductionRuntime(env)) {
    logger.warn?.("dev_force_send_blocked_in_production", {
      node_env: clean(env.NODE_ENV) || null,
      vercel_env: clean(env.VERCEL_ENV) || null,
    });
    return new Response(null, { status: 404 });
  }

  if (!isDevForceSendExplicitlyAllowed(env)) {
    logger.warn?.("dev_force_send_blocked_flag_missing", {
      node_env: clean(env.NODE_ENV) || null,
      vercel_env: clean(env.VERCEL_ENV) || null,
      flag: DEV_FORCE_SEND_FLAG,
    });
    return new Response(null, { status: 404 });
  }

  const require_dev_route_access = deps.requireDevRouteAccess || requireDevRouteAccess;
  const denied = require_dev_route_access(request);

  if (denied) {
    return denied;
  }

  try {
    const send_textgrid_sms =
      deps.sendTextgridSMS ||
      (await import("@/lib/providers/textgrid.js")).sendTextgridSMS;

    const result = await send_textgrid_sms({
      from: "+16128060495",
      to: "+16127433952",
      body: "🔥 FORCE SEND TEST",
    });

    logger.log?.("FORCE SEND RESULT:", result);

    return Response.json({
      success: true,
      result,
    });
  } catch (err) {
    logger.error?.("FORCE SEND ERROR:", err);

    return Response.json({
      success: false,
      error: err?.message || "Unknown error",
    });
  }
}

export async function GET(request) {
  return handleDevForceSendRequest(request);
}
