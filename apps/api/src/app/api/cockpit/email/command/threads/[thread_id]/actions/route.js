/**
 * Operator actions on one conversation: take_over, return_to_system,
 * mark_read, resolve_needs, approve_send, cancel_message, review_attachment.
 * The actor is the Worker-verified operator (x-ops-user-id); a body "actor"
 * is ignored.
 */
import { applyEmailThreadAction } from "@/lib/domain/email/email-command-service.js";
import { optionsResponse, parseJsonSafe, requireEmailCockpitAuth, withCors } from "../../../../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) { return optionsResponse(request); }

export async function POST(request, { params }) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;
  const { thread_id } = await params;
  const body = (await parseJsonSafe(request)) || {};
  const { action, actor: _ignored, ...fields } = body;
  try {
    const result = await applyEmailThreadAction(thread_id, String(action || ""), fields, { actor: request.headers.get("x-ops-user-id") || "" });
    return withCors(request, result, result.ok ? 200 : result.status || 422);
  } catch (error) {
    return withCors(request, { ok: false, error: "email_action_failed", message: error?.message || String(error) }, 500);
  }
}
