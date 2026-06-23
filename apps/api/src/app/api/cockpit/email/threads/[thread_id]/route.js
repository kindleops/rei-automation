import { getEmailThread } from "@/lib/domain/email/email-service.js";
import { optionsResponse, requireEmailCockpitAuth, withCors } from "../../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return optionsResponse(request);
}

export async function GET(request, { params } = {}) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await getEmailThread(params?.thread_id);
    return withCors(request, result, result.ok === false ? 404 : 200);
  } catch (error) {
    return withCors(
      request,
      { ok: false, error: "email_thread_failed", message: error?.message || String(error) },
      500
    );
  }
}
