import { NextResponse } from "next/server";

import { child } from "@/lib/logging/logger.js";
import { requireSharedSecretAuth } from "@/lib/security/shared-secret.js";
import { runEmailQueue } from "@/lib/domain/email/run-email-queue.js";
import { buildDisabledResponse, getSystemFlag } from "@/lib/system-control.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.internal.email.queue.run" });

function clean(value) {
  return String(value ?? "").trim();
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = clean(value).toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  return fallback;
}

function asLimit(value, fallback = 25) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.trunc(parsed), 200);
}

/**
 * CUT OVER to the canonical runner.
 *
 * This route previously called processEmailQueue(), which reads
 * `email_send_queue` -- a table that has never existed in this database. Every
 * invocation therefore errored on a missing relation, and the route reported it
 * as a failed run rather than as a broken path.
 *
 * It now calls runEmailQueue(), which reads the real `email_queue` table and
 * puts every row through the canonical dispatch seam: identity, the three
 * vetoes, the attempt ledger, and provider_request_started_at committed before
 * the network call.
 */
async function runFromPayload(payload = {}) {
  const result = await runEmailQueue({
    limit: asLimit(payload.limit, 10),
    dry_run: asBoolean(payload.dry_run, false),
  });

  return {
    ok: result?.ok !== false,
    route: "internal/email/queue/run",
    result,
  };
}

export async function GET(request) {
  try {
    const auth = requireSharedSecretAuth(request, logger, {
      env_name: "INTERNAL_API_SECRET",
      header_names: ["x-internal-api-secret"],
    });
    if (!auth.authorized) return auth.response;

    const email_enabled = await getSystemFlag("email_enabled");
    if (!email_enabled) {
      return NextResponse.json(buildDisabledResponse("email_enabled", "email-queue-run-route"), {
        status: 423,
      });
    }

    const { searchParams } = new URL(request.url);
    const response = await runFromPayload({
      limit: searchParams.get("limit"),
      dry_run: searchParams.get("dry_run"),
    });

    return NextResponse.json(response, { status: response.ok ? 200 : 400 });
  } catch (error) {
    logger.error("email.queue_run.failed", { error: clean(error?.message) || "unknown" });
    return NextResponse.json({ ok: false, error: "email_queue_run_failed" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const auth = requireSharedSecretAuth(request, logger, {
      env_name: "INTERNAL_API_SECRET",
      header_names: ["x-internal-api-secret"],
    });
    if (!auth.authorized) return auth.response;

    const email_enabled = await getSystemFlag("email_enabled");
    if (!email_enabled) {
      return NextResponse.json(buildDisabledResponse("email_enabled", "email-queue-run-route"), {
        status: 423,
      });
    }

    const body = await request.json().catch(() => ({}));
    const response = await runFromPayload(body || {});

    return NextResponse.json(response, { status: response.ok ? 200 : 400 });
  } catch (error) {
    logger.error("email.queue_run.failed", { error: clean(error?.message) || "unknown" });
    return NextResponse.json({ ok: false, error: "email_queue_run_failed" }, { status: 500 });
  }
}
