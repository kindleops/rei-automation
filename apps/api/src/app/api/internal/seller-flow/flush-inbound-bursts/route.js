// Internal flush endpoint for eligible seller inbound bursts.
// Auth: internal secret / cron. Append path is feature-gated; this endpoint
// finalizes already-open bursts. Reloads thread context before V2.
//
// ACTIVATION PREREQUISITE: SELLER_INBOUND_BURST_ENABLED requires this endpoint
// to be driven by a scheduler (Vercel cron or equivalent) — without it,
// non-safety bursts finalize only when a later inbound trips the hard-close
// rollover's inline flush (delayed, never lost). This endpoint also reclaims
// stale claimed bursts whose worker died (claim lease recovery), so the cron
// doubles as the crash-recovery worker.
//
// Vercel Cron invokes scheduled paths with GET. Exporting POST alone silently
// removed this worker from the schedule; both methods now run the identical
// handler. Logic lives in the shared request handler so the cron GET path is
// testable end-to-end.

import { handleFlushInboundBurstsRequest } from "@/lib/domain/seller-flow/flush-inbound-bursts-request.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request) {
  return handleFlushInboundBurstsRequest(request, { method: "GET" });
}

export async function POST(request) {
  return handleFlushInboundBurstsRequest(request, { method: "POST" });
}
