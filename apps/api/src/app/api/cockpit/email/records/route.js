import { getEmailRecords } from "@/lib/domain/email/email-service.js";
import {
  optionsResponse,
  requireEmailCockpitAuth,
  searchParamsObject,
  withCors,
} from "../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return optionsResponse(request);
}

export async function GET(request) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await getEmailRecords(searchParamsObject(request));
    return withCors(request, result, result.ok === false ? 500 : 200);
  } catch (error) {
    return withCors(
      request,
      { ok: false, error: "email_records_failed", message: error?.message || String(error) },
      500
    );
  }
}
