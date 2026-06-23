import { NextResponse } from "next/server";

import { listAutomationRules } from "@/lib/domain/automation/automation-rules.js";
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

  const rules = await listAutomationRules();
  return NextResponse.json({
    ok: true,
    route: "internal/automation/rules",
    count: rules.length,
    rules,
  });
}
