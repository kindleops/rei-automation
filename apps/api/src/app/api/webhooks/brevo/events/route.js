import { NextResponse } from "next/server.js";

import { child } from "@/lib/logging/logger.js";
import { verifyBrevoWebhook } from "@/lib/domain/email/brevo-webhook-verification.js";
import { reconcileEmailProviderEvent } from "@/lib/domain/email/reconcile-email-provider-event.js";
import { createEmailProviderEventStore } from "@/lib/domain/email/email-provider-event-store.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.webhooks.brevo.events" });

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Brevo posts either a single event object or an array of them, and has used a
 * wrapped `{ events: [...] }` shape in places. Accept all three; anything else
 * is a parse failure rather than an empty batch, because silently processing
 * zero events from a malformed body looks identical to success.
 */
function parseEvents(raw_body) {
  if (!clean(raw_body)) return { ok: true, events: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw_body);
  } catch {
    return { ok: false, reason: "brevo_webhook_body_not_json" };
  }
  if (Array.isArray(parsed)) return { ok: true, events: parsed };
  if (Array.isArray(parsed?.events)) return { ok: true, events: parsed.events };
  if (parsed && typeof parsed === "object") return { ok: true, events: [parsed] };
  return { ok: false, reason: "brevo_webhook_body_not_an_event" };
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "webhooks/brevo/events", status: "listening" });
}

export async function POST(request) {
  // The EXACT bytes. An HMAC computed over a re-serialized body verifies nothing,
  // because JSON.stringify does not reproduce the sender's key order or spacing.
  const raw_body = await request.text().catch(() => "");

  try {
    const verification = verifyBrevoWebhook({
      headers: request.headers,
      raw_body,
      url: request.url,
    });

    // FAIL CLOSED. The previous implementation accepted anything when
    // BREVO_WEBHOOK_SECRET was unset, which made a misconfigured deploy and a
    // forged request indistinguishable -- and let anyone who found the URL mark
    // a seller unsubscribed or a message delivered.
    if (!verification.ok) {
      logger.warn("brevo_webhook.refused", {
        reason: verification.reason,
        configured: verification.configured,
      });
      return NextResponse.json(
        {
          ok: false,
          route: "webhooks/brevo/events",
          error: verification.reason,
          // Told apart on purpose: "nobody configured this" and "someone forged
          // this" both refuse, but they need different fixes.
          webhook_secret_configured: verification.configured,
        },
        { status: verification.configured ? 401 : 503 }
      );
    }

    const parsed = parseEvents(raw_body);
    if (!parsed.ok) {
      return NextResponse.json(
        { ok: false, route: "webhooks/brevo/events", error: parsed.reason },
        { status: 400 }
      );
    }

    const store = createEmailProviderEventStore();
    const received_at = new Date().toISOString();
    const results = [];

    for (const payload of parsed.events) {
      // One bad event must not discard the rest of the batch. Brevo will retry
      // the WHOLE batch on a non-2xx, so a partial failure that rejected the
      // response would replay every sibling event -- which the idempotency key
      // survives, but only by doing the work again.
      try {
        results.push(await reconcileEmailProviderEvent(
          { payload, trust_class: verification.trust_class, received_at },
          store
        ));
      } catch (error) {
        logger.error("brevo_webhook.event_failed", { error: clean(error?.message) || "unknown" });
        results.push({ ok: false, error: "email_event_reconcile_failed" });
      }
    }

    return NextResponse.json({
      ok: results.every((result) => result.ok !== false),
      route: "webhooks/brevo/events",
      verification_mode: verification.mode,
      events_received: parsed.events.length,
      applied: results.filter((r) => r.advanced).length,
      suppressed: results.filter((r) => r.suppressed).length,
      results,
    });
  } catch (error) {
    logger.error("brevo_webhook.failed", { error: clean(error?.message) || "unknown" });
    return NextResponse.json(
      { ok: false, route: "webhooks/brevo/events", error: "brevo_webhook_failed" },
      { status: 500 }
    );
  }
}
