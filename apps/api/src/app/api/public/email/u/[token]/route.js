/**
 * One-click unsubscribe. /api/public/email/u/:token
 *
 * POST — RFC 8058 one-click (mail providers send
 *        "List-Unsubscribe=One-Click") and the confirm button below.
 *        Suppresses the address that received that message. A transient
 *        failure answers 503 (never a false confirmation) so it is retried.
 * GET  — a confirmation page with a button. GET never unsubscribes: link
 *        scanners prefetch GETs, and an unsubscribe must be the reader's act.
 */
import { supabase } from "@/lib/supabase/client.js";
import { recordUnsubscribe } from "@/lib/domain/email/email-compliance.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  "referrer-policy": "no-referrer",
};

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;color:#111">${body}</body></html>`;

export async function GET(_request, { params }) {
  const { token } = await params;
  const safe = encodeURIComponent(String(token || ""));
  return new Response(
    page(`<h1 style="font-size:20px">Unsubscribe</h1><p>Stop receiving these emails at this address?</p><form method="post" action="${safe}"><button type="submit" style="font-size:16px;padding:10px 18px">Unsubscribe</button></form>`),
    { status: 200, headers: HTML_HEADERS }
  );
}

export async function POST(_request, { params }) {
  const { token } = await params;
  let r;
  try {
    r = await recordUnsubscribe(supabase, token);
  } catch {
    r = { ok: false, reason: "error" };
  }
  if (r.ok) {
    return new Response(page(`<h1 style="font-size:20px">You are unsubscribed</h1><p>This address will not receive these emails again.</p>`), { status: 200, headers: HTML_HEADERS });
  }
  if (r.reason === "bad_token" || r.reason === "unknown_token") {
    return new Response(page(`<h1 style="font-size:20px">Link not recognised</h1><p>Reply to the email with the word "unsubscribe" and we will remove your address.</p>`), { status: 200, headers: HTML_HEADERS });
  }
  // Never claim success we did not record: a transient failure asks for a retry.
  return new Response(page(`<h1 style="font-size:20px">Please try again</h1><p>We could not process the request just now.</p>`), { status: 503, headers: { ...HTML_HEADERS, "retry-after": "60" } });
}
