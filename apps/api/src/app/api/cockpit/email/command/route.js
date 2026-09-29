import { getEmailCommandHome } from "@/lib/domain/email/email-command-service.js";
import { optionsResponse, requireEmailCockpitAuth, searchParamsObject, withCors } from "../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) { return optionsResponse(request); }

/** Email Command home: operating-state counts + Needs You / System Handling / Waiting lists. */
export async function GET(request) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;
  try {
    const p = searchParamsObject(request);
    const result = await getEmailCommandHome({ filter: p.filter, q: p.q, limit: p.limit });
    return withCors(request, result, result.ok === false ? 500 : 200);
  } catch (error) {
    return withCors(request, { ok: false, error: "email_command_failed", message: error?.message || String(error) }, 500);
  }
}
