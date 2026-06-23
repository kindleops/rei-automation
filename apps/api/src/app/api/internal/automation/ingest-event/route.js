import { NextResponse } from "next/server";

import { runAutomationEngine } from "@/lib/domain/automation/automation-engine.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";
import { child } from "@/lib/logging/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = child({ module: "api.internal.automation.ingest_event" });

function statusForResult(result = {}) {
  if (result.ok === false && result.reason === "missing_event_type") return 400;
  if (result.ok === false) return 500;
  return 200;
}

export async function POST(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error || "unauthorized" },
      { status: auth.status || 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const result = await runAutomationEngine({
    event: body.event || body,
    source: body.source || "internal_api",
    dry_run: typeof body.dry_run === "boolean" ? body.dry_run : undefined,
    allow_send_queue_writes: body.allow_send_queue_writes === true,
    logger,
  });

  return NextResponse.json(
    {
      ok: result.ok !== false,
      route: "internal/automation/ingest-event",
      result,
    },
    { status: statusForResult(result) }
  );
}
