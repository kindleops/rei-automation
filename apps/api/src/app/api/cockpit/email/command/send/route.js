/**
 * Operator reply / compose from Email Command. Queues through the ONE
 * dispatcher (same identity, threading, suppression, telemetry as automation).
 */
import { sendManualEmail } from "@/lib/domain/email/email-service.js";
import { optionsResponse, parseJsonSafe, requireEmailCockpitAuth, withCors } from "../../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) { return optionsResponse(request); }

export async function POST(request) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;
  const body = (await parseJsonSafe(request)) || {};
  const actor = request.headers.get("x-ops-user-id") || "";
  if (!actor) return withCors(request, { ok: false, error: "actor_required" }, 401);
  try {
    const result = await sendManualEmail({ ...body, actor }, { actor });
    return withCors(request, result, result.ok ? 200 : 422);
  } catch (error) {
    return withCors(request, { ok: false, error: "email_send_failed", message: error?.message || String(error) }, 500);
  }
}
