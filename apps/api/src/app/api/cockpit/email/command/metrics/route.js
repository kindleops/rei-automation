import { getEmailMetrics } from "@/lib/domain/email/email-command-service.js";
import { optionsResponse, requireEmailCockpitAuth, searchParamsObject, withCors } from "../../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIMENSIONS = new Set(["campaign", "template", "sender", "domain", "lane", "provider", "sequence_step"]);

export async function OPTIONS(request) { return optionsResponse(request); }

/** Email metrics by one dimension (unique vs total, named denominators). */
export async function GET(request) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;
  const p = searchParamsObject(request);
  const dimension = DIMENSIONS.has(p.dimension) ? p.dimension : "lane";
  try {
    const result = await getEmailMetrics({ dimension, days: p.days, campaignId: p.campaign_id || null });
    return withCors(request, result, result.ok ? 200 : 500);
  } catch (error) {
    return withCors(request, { ok: false, error: "email_metrics_failed", message: error?.message || String(error) }, 500);
  }
}
