import { NextResponse } from "next/server";
import { getLiveCounts, buildNullCounts } from "@/lib/domain/inbox/live-inbox-service.js";
import { ensureMutationAuth, corsHeaders } from "../../../_shared.js";
import { warn } from "@/lib/logging/logger.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const cors = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get("source") || "primary";

    const counts = await getLiveCounts(
      {},
      {
        // Rely on defaultSupabase defined in getLiveCounts
        preferredThreadSource: source,
        disableCountFullScan: false,
      }
    );

    return NextResponse.json(
      {
        ok: true,
        degraded: false,
        dataMode: "live",
        data: counts,
        counts,
        diagnostics: { countsSource: "canonical_inbox_counts" },
      },
      { status: 200, headers: cors }
    );
  } catch (error) {
    const emptyCounts = buildNullCounts();
    warn("inbox.live_counts_failed", {
      message: error?.message || "unknown",
      code: error?.code || null,
      details: error?.details || null,
      hint: error?.hint || null,
      stack: error?.stack || null,
    });
    return NextResponse.json(
      {
        ok: false,
        degraded: true,
        dataMode: "fallback_error",
        error: "live_inbox_counts_unavailable",
        message: error?.message || "Failed to fetch live counts",
        code: error?.code || null,
        details: error?.details || null,
        hint: error?.hint || null,
        data: emptyCounts,
        counts: emptyCounts,
        diagnostics: { countsSource: "error" },
      },
      { status: 200, headers: cors }
    );
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
