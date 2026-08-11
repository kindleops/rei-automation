// ─── internal/deal-context/thread-snapshot ───────────────────────────────────
// Read-only operator surface for the canonical thread automation snapshot
// (spine G12). Resolves what automation would ACTUALLY do on one thread —
// state, mode authority, stage, the negotiation economics, and the reason codes
// behind the verdict — plus the operator-readable Deal Desk rendering.
//
// Strictly read-only: it resolves and formats, it never mutates a thread, a
// mode, or the queue.
import { NextResponse } from "next/server.js";

import {
  resolveThreadAutomationSnapshot,
  formatThreadAutomationSummary,
} from "@/lib/domain/deal-context/thread-automation-snapshot.js";
import { requireSharedSecretAuth } from "@/lib/security/shared-secret.js";
import { child } from "@/lib/logging/logger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "internal/deal-context/thread-snapshot";
const logger = child({ module: "api.internal.deal_context.thread_snapshot" });

function clean(value) {
  return String(value ?? "").trim();
}

export async function GET(request) {
  const auth = requireSharedSecretAuth(request, logger, {
    env_name: "INTERNAL_API_SECRET",
    header_names: ["x-internal-api-secret"],
  });
  if (!auth.authorized) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const thread_key = clean(searchParams.get("thread_key"));
    if (!thread_key) {
      return NextResponse.json(
        { ok: false, route: ROUTE, error: "missing_thread_key" },
        { status: 400 },
      );
    }

    const snapshot = await resolveThreadAutomationSnapshot(thread_key);

    return NextResponse.json({
      ok: true,
      route: ROUTE,
      snapshot,
      summary: formatThreadAutomationSummary(snapshot),
    });
  } catch (error) {
    logger.error?.("thread_snapshot.failed", { error: error?.message || "unknown" });
    return NextResponse.json(
      {
        ok: false,
        route: ROUTE,
        error: "thread_automation_snapshot_failed",
        message: error?.message || "Unknown thread snapshot error",
      },
      { status: 500 },
    );
  }
}

export default GET;
