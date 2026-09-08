import { NextResponse } from "next/server.js";

import { child } from "@/lib/logging/logger.js";
import { createBrevoInboundProvider } from "@/lib/domain/email/inbound/brevo-inbound-adapter.js";
import { ingestInboundEmail } from "@/lib/domain/email/inbound/ingest-inbound-email.js";
import { createInboundEmailStore } from "@/lib/domain/email/inbound/inbound-email-store.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.webhooks.brevo.inbound" });

/**
 * THE CAPABILITY URL IS THE CREDENTIAL.
 *
 * Brevo publishes no signature for inbound parse callbacks -- see
 * brevo-inbound-adapter.js for the investigation. The strongest control it
 * genuinely supports is a URL only we and Brevo know, so the token lives in the
 * PATH and is checked in constant time.
 *
 * That is a bearer secret in a URL, with the weaknesses that implies: it can leak
 * through proxy logs, access logs and browser history in ways an HMAC cannot. It
 * is compensated by reply-token correlation (a forged callback still has to name
 * a 128-bit alias that only appeared in mail we sent) and by the fact that
 * nothing downstream treats inbound email as authority over acquisition state.
 *
 * The token is never logged. A logged capability URL is a capability URL that has
 * been given away.
 */
function clean(value) {
  return String(value ?? "").trim();
}

/** Bounded so a flood cannot exhaust the runtime before authentication. */
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_ITEMS_PER_CALLBACK = 50;

export async function GET() {
  // Deliberately says nothing about whether the token was right. A probe must
  // not be able to enumerate valid capability URLs from the response.
  return NextResponse.json({ ok: true, route: "webhooks/brevo/inbound", status: "listening" });
}

export async function POST(request, context) {
  const params = await context?.params;
  const path_token = clean(params?.token);

  // The EXACT bytes, read once. Re-serializing before verification would make a
  // signature check meaningless, and re-reading a stream is not possible anyway.
  const raw_body = await request.text().catch(() => "");

  if (raw_body.length > MAX_BODY_BYTES) {
    logger.warn("inbound_email.body_too_large", { bytes: raw_body.length });
    return NextResponse.json({ ok: false, error: "inbound_body_too_large" }, { status: 413 });
  }

  const provider = createBrevoInboundProvider();

  try {
    // ── authenticate BEFORE parsing ──────────────────────────────────────
    // Schema validation on an unauthenticated payload is free work for an
    // attacker and a parser surface we do not need to expose.
    const verification = provider.verify({
      path_token,
      headers: request.headers,
      raw_body,
      url: request.url,
    });

    if (!verification.ok) {
      logger.warn("inbound_email.refused", {
        reason: verification.reason,
        configured: verification.configured,
      });
      return NextResponse.json(
        {
          ok: false,
          error: verification.reason,
          // Told apart deliberately: "nobody configured this" and "someone
          // forged this" both refuse but need different fixes.
          inbound_security_configured: verification.configured,
        },
        { status: verification.configured ? 401 : 503 }
      );
    }

    let parsed;
    try {
      parsed = raw_body ? JSON.parse(raw_body) : [];
    } catch {
      return NextResponse.json({ ok: false, error: "inbound_body_not_json" }, { status: 400 });
    }

    const items = provider.splitBatch(parsed).slice(0, MAX_ITEMS_PER_CALLBACK);
    const store = createInboundEmailStore();
    const received_at = new Date().toISOString();
    const results = [];
    let must_retry = false;

    for (const item of items) {
      const normalization = provider.normalizeInbound(item, { received_at });
      if (!normalization.ok) {
        // A payload we cannot read is kept, not dropped: it is the only evidence
        // that something arrived, and it may be a provider change worth seeing.
        logger.warn("inbound_email.malformed", { reason: normalization.reason });
        await store.recordMalformed({ raw_item: item, reason: normalization.reason, received_at });
        results.push({ ok: false, error: normalization.reason, quarantined: true });
        continue;
      }

      const outcome = await ingestInboundEmail(
        { normalized: normalization.normalized, trust_class: verification.trust_class, now: received_at },
        store
      );
      // A receipt we could not store is the ONE case where Brevo should retry:
      // answering 200 would tell it the message was accepted and lose the reply.
      if (outcome.retryable) must_retry = true;
      results.push(outcome);
    }

    if (must_retry) {
      return NextResponse.json(
        { ok: false, error: "inbound_receipt_not_durable", results },
        { status: 503 }
      );
    }

    return NextResponse.json({
      ok: true,
      route: "webhooks/brevo/inbound",
      verification_mode: verification.mode,
      items_received: items.length,
      processed: results.filter((r) => r.processing_status === "processed").length,
      duplicates: results.filter((r) => r.duplicate).length,
      needs_review: results.filter((r) => r.needs_review).length,
      held: results.filter((r) => r.held).length,
      results,
    });
  } catch (error) {
    logger.error("inbound_email.failed", { error: clean(error?.message) || "unknown" });
    // 503 rather than 500: this asks Brevo to retry, because an unexpected
    // failure here means we do not know whether the reply was stored.
    return NextResponse.json({ ok: false, error: "inbound_email_failed" }, { status: 503 });
  }
}
