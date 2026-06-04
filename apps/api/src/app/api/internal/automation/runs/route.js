import { NextResponse } from "next/server";

import { listAutomationRuns } from "@/lib/domain/automation/automation-events.js";
import { requireInternalSecret } from "@/lib/security/require-internal-secret.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = requireInternalSecret(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error || "unauthorized" },
      { status: auth.status || 401 }
    );
  }

  const url = new URL(request.url);
  const result = await listAutomationRuns({
    limit: Number(url.searchParams.get("limit") || 100),
    status: url.searchParams.get("status") || "",
    event_type: url.searchParams.get("event_type") || "",
  });

  return NextResponse.json(
    { ok: result.ok !== false, route: "internal/automation/runs", result },
    { status: result.ok === false ? 500 : 200 }
  );
}
