import { NextResponse } from "next/server";

import {
  runAutomationEngine,
  runAutomationPendingEvents,
} from "@/lib/domain/automation/automation-engine.js";
import { replayAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function unauthorized(auth) {
  return NextResponse.json(
    { ok: false, error: auth.error || "unauthorized" },
    { status: auth.status || 401 }
  );
}

export async function GET(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) return unauthorized(auth);

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 25);
  const dry_run = url.searchParams.get("dry_run") === "true";
  const result = await runAutomationPendingEvents({ limit, dry_run });

  return NextResponse.json(
    { ok: result.ok !== false, route: "internal/automation/run", result },
    { status: result.ok === false ? 500 : 200 }
  );
}

export async function POST(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) return unauthorized(auth);

  const body = await request.json().catch(() => ({}));
  const result = body.event_id
    ? await replayAutomationEvent(body, {
        dry_run: body.dry_run,
        allow_send_queue_writes: body.allow_send_queue_writes === true,
      })
    : body.event
      ? await runAutomationEngine({
          event: body.event,
          source: body.source || "internal_api",
          dry_run: body.dry_run,
          allow_send_queue_writes: body.allow_send_queue_writes === true,
        })
      : await runAutomationPendingEvents({
          limit: Number(body.limit || 25),
          dry_run: body.dry_run,
          allow_send_queue_writes: body.allow_send_queue_writes === true,
        });

  return NextResponse.json(
    { ok: result.ok !== false, route: "internal/automation/run", result },
    { status: result.ok === false ? 500 : 200 }
  );
}
