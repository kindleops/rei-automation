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

    return NextResponse.json({ ok: true, data: counts, counts }, { status: 200, headers: cors });
  } catch (error) {
    if (error?.message === "live_inbox_counts_unavailable") {
      const emptyCounts = buildNullCounts();
      return NextResponse.json({ ok: true, data: emptyCounts, counts: emptyCounts, degraded: true }, { status: 200, headers: cors });
    }
    warn("inbox.live_counts_failed", { message: error?.message || "unknown" });
    return NextResponse.json(
      { error: "Failed to fetch live counts", message: error?.message },
      { status: 500, headers: cors }
    );
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
