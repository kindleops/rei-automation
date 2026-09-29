/**
 * Tracked link. GET /api/public/email/c/:token
 * Redirects ONLY to the destination recorded at send time for this token —
 * the request cannot supply a destination, so this is never an open
 * redirect. Unknown or tampered tokens get a plain 404.
 */
import { supabase } from "@/lib/supabase/client.js";
import { recordClick } from "@/lib/domain/email/email-tracking.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { token } = await params;
  let result = { destination: null };
  try {
    result = await recordClick(supabase, token, {
      ua: request.headers.get("user-agent") || "",
      ip: request.headers.get("cf-connecting-ip") || "",
    });
  } catch {
    result = { destination: null };
  }
  if (!result.destination) {
    return new Response("Link not found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  }
  return new Response(null, { status: 302, headers: { location: result.destination, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
