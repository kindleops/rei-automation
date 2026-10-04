/**
 * GET /api/cockpit/email/timeline?thread_key=<sms thread key>[&master_owner_id=&property_id=]
 * Email messages for the same seller lineage as an Inbox SMS thread, for the
 * Inbox to render beside SMS. Read-only.
 */
import { supabase } from "@/lib/supabase/client.js";
import { getSellerEmailTimeline } from "@/lib/domain/email/email-inbox-timeline.js";
import { optionsResponse, requireEmailCockpitAuth, searchParamsObject, withCors } from "../_shared.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) { return optionsResponse(request); }

export async function GET(request) {
  const auth = requireEmailCockpitAuth(request);
  if (!auth.ok) return auth.response;
  const q = searchParamsObject(request);
  try {
    const result = await getSellerEmailTimeline({ thread_key: q.thread_key, master_owner_id: q.master_owner_id, property_id: q.property_id }, { supabase });
    return withCors(request, result, result.ok ? 200 : result.status || 500);
  } catch (error) {
    return withCors(request, { ok: false, error: "email_timeline_failed", message: error?.message || String(error) }, 500);
  }
}
