import { getBrevoHealth } from "@/lib/domain/email/brevo-provider.js";
import { optionsResponse, requireEmailCockpitAuth, withCors } from "../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return optionsResponse(request);
}

export async function GET(request) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await getBrevoHealth();
    return withCors(request, result, 200);
  } catch (error) {
    return withCors(
      request,
      { ok: false, error: "brevo_health_failed", message: error?.message || String(error) },
      500
    );
  }
}
