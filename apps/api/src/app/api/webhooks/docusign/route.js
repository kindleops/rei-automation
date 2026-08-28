import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { handleDocusignWebhook } from "@/lib/domain/contracts/handle-docusign-webhook.js";
import { reconcileClosingCaseFromEnvelope } from "@/lib/domain/closings/reconcile-closing-case-from-envelope.js";
import { verifyDocusignConnectHmac } from "@/lib/security/docusign-hmac.js";
import { ENV } from "@/lib/config/env.js";
import { FEATURE_FLAGS } from "@/lib/config/feature-flags.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({
  module: "api.webhooks.docusign",
});

function clean(value) {
  return String(value ?? "").trim();
}

function isProductionRuntime() {
  return (
    String(process.env.VERCEL_ENV ?? "").toLowerCase() === "production" ||
    String(process.env.NODE_ENV ?? "").toLowerCase() === "production"
  );
}

/**
 * Returns true when HMAC verification may be skipped.
 * Only permitted in non-production Node environments when the caller has
 * explicitly set DOCUSIGN_WEBHOOK_SKIP_HMAC=1.  Off by default.
 */
function isHmacBypassAllowed() {
  if (isProductionRuntime()) return false;
  return clean(process.env.DOCUSIGN_WEBHOOK_SKIP_HMAC) === "1";
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "webhooks/docusign",
    status: "listening",
  });
}

export async function POST(request) {
  try {
    // Read raw body first — must happen before any body-consuming operation.
    const rawBody = await request.text().catch(() => "");

    const hmac_bypass = isHmacBypassAllowed();

    if (!hmac_bypass) {
      const secret = clean(ENV.DOCUSIGN_WEBHOOK_SECRET);
      const hmac = verifyDocusignConnectHmac(rawBody, request.headers, secret);

      if (!hmac.ok) {
        logger.warn("docusign_webhook.hmac_rejected", {
          reason: hmac.reason,
          // Do not log the secret or the signature value.
        });

        return NextResponse.json(
          { ok: false, error: "unauthorized", reason: hmac.reason },
          { status: 401 }
        );
      }
    } else {
      logger.warn("docusign_webhook.hmac_bypass_active", {
        note: "DOCUSIGN_WEBHOOK_SKIP_HMAC=1 — HMAC verification skipped (dev only)",
      });
    }

    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = {};
    }

    // CANONICAL path: reconcile the signature into the Supabase closing case,
    // resolved by envelope id. This is the production system of record.
    let closing = null;
    try {
      closing = await reconcileClosingCaseFromEnvelope({
        payload,
        // Same closing-execution boundary that gates the legacy downstream:
        // signature state always reconciles, outward seller messaging does not
        // fire until closing execution is authorized.
        allowExternalEffects: Boolean(FEATURE_FLAGS.ENABLE_AUTO_CONTRACT_SEND),
      });
    } catch (error) {
      logger.error("docusign_webhook.closing_reconcile_failed", { error });
      closing = { ok: false, reconciled: false, reason: "closing_reconcile_threw" };
    }

    // LEGACY path: the Podio contract mirror. Podio is not in service in
    // production (no credentials; podio business writes are disabled), so this
    // is inert there — it is retained only so a Podio-enabled environment keeps
    // its existing behavior. A legacy failure must never fail the webhook when
    // the canonical Supabase reconciliation succeeded.
    let result = null;
    try {
      result = await handleDocusignWebhook(payload);
    } catch (error) {
      logger.error("docusign_webhook.legacy_handler_failed", { error });
      result = { ok: false, reason: "legacy_handler_threw" };
    }

    const ok = closing?.ok !== false || result?.ok !== false;

    return NextResponse.json(
      {
        ok,
        route: "webhooks/docusign",
        closing,
        result,
      },
      { status: ok ? 200 : 400 }
    );
  } catch (error) {
    logger.error("docusign_webhook.failed", { error });

    return NextResponse.json(
      {
        ok: false,
        error: "docusign_webhook_failed",
      },
      { status: 500 }
    );
  }
}
