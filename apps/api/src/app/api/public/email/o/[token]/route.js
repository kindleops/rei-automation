/**
 * Open-signal pixel. GET /api/public/email/o/:token(.gif)
 * No login (mail clients fetch it), no data in the URL, always a 1×1 GIF —
 * unknown tokens included, so the endpoint reveals nothing. Records an
 * open SIGNAL (never proof of a human read).
 */
import { supabase } from "@/lib/supabase/client.js";
import { recordOpen, TRANSPARENT_GIF } from "@/lib/domain/email/email-tracking.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GIF_HEADERS = {
  "content-type": "image/gif",
  "cache-control": "no-store, no-cache, must-revalidate, private",
  pragma: "no-cache",
  "x-robots-tag": "noindex",
};

export async function GET(request, { params }) {
  const { token } = await params;
  try {
    await recordOpen(supabase, token, {
      ua: request.headers.get("user-agent") || "",
      ip: request.headers.get("cf-connecting-ip") || "",
    });
  } catch {
    // Never let tracking failure show up in someone's inbox.
  }
  return new Response(TRANSPARENT_GIF, { status: 200, headers: GIF_HEADERS });
}
