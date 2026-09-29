/**
 * Inbound email → Email Command. POST /api/webhooks/email/inbound
 *
 * Sources: Cloudflare Email Routing (the Email Worker forwards raw MIME) or
 * Brevo inbound parse ({ items: [...] }). Authenticated by EMAIL_INBOUND_SECRET
 * and FAIL CLOSED: this route is outside the operator session gate and can
 * drive seller automation, so an unset secret refuses everything.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server.js";

import { ingestInboundEmail } from "@/lib/domain/email/email-inbound.js";
import { handleSellerEmail } from "@/lib/domain/email/email-seller-channel.js";
import { parseMime } from "@/lib/domain/email/email-mime.js";
import { child } from "@/lib/logging/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const logger = child({ module: "api.webhooks.email.inbound" });
const clean = (v) => String(v ?? "").trim();

function authorized(request) {
  const secret = clean(process.env.EMAIL_INBOUND_SECRET);
  if (!secret) return { ok: false, status: 503, error: "email_inbound_secret_not_configured" };
  const url = new URL(request.url);
  const candidates = [
    request.headers.get("x-email-inbound-secret"),
    clean(request.headers.get("authorization")).replace(/^bearer\s+/i, ""),
    url.searchParams.get("secret"),
  ].filter(Boolean);
  const want = Buffer.from(secret);
  const ok = candidates.some((c) => {
    const got = Buffer.from(clean(c));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
  return ok ? { ok: true } : { ok: false, status: 401, error: "invalid_inbound_secret" };
}

export async function POST(request) {
  const auth = authorized(request);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "malformed_payload" }, { status: 400 });
  }

  const items = [];
  let source = "brevo_inbound";
  if (body?.source === "cloudflare" && clean(body.raw_base64)) {
    source = "cloudflare_inbound_email";
    const raw = Buffer.from(body.raw_base64, "base64");
    if (raw.length > 26 * 1024 * 1024) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
    const m = parseMime(raw);
    items.push({
      from: m.from, to: m.to.length ? m.to : [clean(body.envelope_to)], cc: m.cc, subject: m.subject,
      text: m.text, html: m.html, messageId: m.messageId || null, inReplyTo: m.inReplyTo, references: m.references,
      date: m.date, headers: m.headers,
      attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size, content: a.content, contentId: a.contentId })),
    });
  } else if (Array.isArray(body?.items)) {
    items.push(...body.items.slice(0, 50));
  } else {
    return NextResponse.json({ ok: false, error: "unrecognized_payload" }, { status: 400 });
  }

  const results = [];
  for (const item of items) {
    try {
      const r = await ingestInboundEmail(item, { handleSellerEmail, source, provider: source === "cloudflare_inbound_email" ? "cloudflare" : "brevo" });
      results.push({ ok: r.ok, duplicate: Boolean(r.duplicate), thread_id: r.thread_id || null, category: r.category || null, resolution: r.resolution || null });
    } catch (error) {
      logger.error("email_inbound.failed", { error: error?.message || "unknown" });
      // 5xx → the Email Worker rejects temporarily so the sending server retries.
      return NextResponse.json({ ok: false, error: "inbound_processing_failed" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, received: items.length, results });
}
