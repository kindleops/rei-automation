import { NextResponse } from "next/server";

import { replayAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error || "unauthorized" },
      { status: auth.status || 401 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const result = await replayAutomationEvent(body, {
    dry_run: body.dry_run,
    allow_send_queue_writes: body.allow_send_queue_writes === true,
  });

  return NextResponse.json(
    { ok: result.ok !== false, route: "internal/automation/replay", result },
    { status: result.ok === false ? 400 : 200 }
  );
}
