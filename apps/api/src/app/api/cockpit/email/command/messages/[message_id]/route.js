import { getEmailMessageTelemetry } from "@/lib/domain/email/email-command-service.js";
import { optionsResponse, requireEmailCockpitAuth, withCors } from "../../../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) { return optionsResponse(request); }

/** Message telemetry sheet: lineage, delivery, open signals, clicks per link, reply, why it sent. */
export async function GET(request, { params }) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;
  const { message_id } = await params;
  try {
    const result = await getEmailMessageTelemetry(message_id);
    return withCors(request, result, result.ok ? 200 : result.status || 500);
  } catch (error) {
    return withCors(request, { ok: false, error: "email_message_failed", message: error?.message || String(error) }, 500);
  }
}
