import { sendManualEmail } from "@/lib/domain/email/email-service.js";
import {
  optionsResponse,
  parseJsonSafe,
  requireEmailCockpitAuth,
  withCors,
} from "../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return optionsResponse(request);
}

export async function POST(request) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const payload = await parseJsonSafe(request);
    const result = await sendManualEmail(payload);
    return withCors(request, result, result.ok === false ? 400 : 200);
  } catch (error) {
    return withCors(
      request,
      { ok: false, error: "email_manual_send_failed", message: error?.message || String(error) },
      500
    );
  }
}
