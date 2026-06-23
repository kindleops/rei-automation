import crypto from "node:crypto";

import { NextResponse } from "next/server.js";

import { handleBrevoWebhookEvents } from "@/lib/domain/email/email-service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(value) {
  return String(value ?? "").trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(clean(left), "utf8");
  const b = Buffer.from(clean(right), "utf8");
  if (!a.length || !b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(value) {
  const raw = clean(value);
  return raw.toLowerCase().startsWith("bearer ") ? clean(raw.slice(7)) : raw;
}

function hmacMatches(rawBody, secret, signature) {
  const provided = clean(signature).replace(/^sha256=/i, "");
  if (!provided) return false;

  const hex = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const base64 = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqual(provided, hex) || safeEqual(provided, base64);
}

function verifyWebhookSecret(request, rawBody) {
  const secret = clean(process.env.BREVO_WEBHOOK_SECRET);
  if (!secret) return { ok: true, configured: false };

  const url = new URL(request.url);
  const directCandidates = [
    request.headers.get("x-brevo-webhook-secret"),
    request.headers.get("x-webhook-secret"),
    request.headers.get("x-brevo-secret"),
    bearerToken(request.headers.get("authorization")),
    url.searchParams.get("secret"),
  ].filter(Boolean);

  if (directCandidates.some((candidate) => safeEqual(candidate, secret))) {
    return { ok: true, configured: true, mode: "shared_secret" };
  }

  const signatureCandidates = [
    request.headers.get("x-brevo-signature"),
    request.headers.get("x-sendinblue-signature"),
    request.headers.get("x-webhook-signature"),
  ].filter(Boolean);

  if (signatureCandidates.some((signature) => hmacMatches(rawBody, secret, signature))) {
    return { ok: true, configured: true, mode: "hmac" };
  }

  return { ok: false, configured: true, reason: "invalid_brevo_webhook_secret" };
}

function parseEvents(rawBody) {
  if (!clean(rawBody)) return [];
  const parsed = JSON.parse(rawBody);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.events)) return parsed.events;
  return [parsed];
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "webhooks/brevo/events",
    status: "listening",
  });
}

export async function POST(request) {
  const rawBody = await request.text().catch(() => "");
  try {
    const secret = verifyWebhookSecret(request, rawBody);
    if (!secret.ok) {
      return NextResponse.json(
        { ok: false, error: secret.reason || "brevo_webhook_unauthorized" },
        { status: 401 }
      );
    }

    const events = parseEvents(rawBody);
    const result = await handleBrevoWebhookEvents(events);
    return NextResponse.json({
      ok: true,
      route: "webhooks/brevo/events",
      webhook_secret_configured: secret.configured,
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        route: "webhooks/brevo/events",
        error: "brevo_webhook_failed",
        message: clean(error?.message) || "brevo_webhook_failed",
      },
      { status: 500 }
    );
  }
}
