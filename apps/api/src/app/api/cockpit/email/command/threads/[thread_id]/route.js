import { getEmailCommandThread } from "@/lib/domain/email/email-command-service.js";
import { optionsResponse, requireEmailCockpitAuth, withCors } from "../../../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) { return optionsResponse(request); }

export async function GET(request, { params }) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;
  const { thread_id } = await params;
  try {
    const result = await getEmailCommandThread(thread_id);
    return withCors(request, result, result.ok ? 200 : result.status || 500);
  } catch (error) {
    return withCors(request, { ok: false, error: "email_thread_failed", message: error?.message || String(error) }, 500);
  }
}
