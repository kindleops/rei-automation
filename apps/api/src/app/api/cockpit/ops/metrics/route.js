import { NextResponse } from "next/server.js";
import { ensureMutationAuth, handleOptionsResponse, withCors } from "../../_shared.js";
import { supabase, hasSupabaseConfig } from "@/lib/supabase/client.js";
import { getCorsHeaders } from "@/lib/cors.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(value) {
  return String(value ?? "").trim();
}

function startOfWindow(window = "today") {
  const now = new Date();
  if (window === "24h") return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
  if (window === "7d") return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
  if (window === "30d") return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return { start, end: now };
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(request) });
}

export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return withCors(request, auth.response);
  if (!hasSupabaseConfig()) {
    return withCors(request, NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500, headers: getCorsHeaders(request) }));
  }

  const { searchParams } = new URL(request.url);
  const window = clean(searchParams.get("window") || "today");
  const { start, end } = startOfWindow(window);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  try {
    const [sentRes, deliveredRes, failedByTsRes, failedByStatusRes, receivedRes, queueRes] = await Promise.all([
      supabase.from("message_events").select("id", { count: "exact", head: true }).not("sent_at", "is", null).gte("sent_at", startIso).lte("sent_at", endIso),
      supabase.from("message_events").select("id", { count: "exact", head: true }).not("delivered_at", "is", null).gte("delivered_at", startIso).lte("delivered_at", endIso),
      supabase.from("message_events").select("id", { count: "exact", head: true }).not("failed_at", "is", null).gte("failed_at", startIso).lte("failed_at", endIso),
      supabase.from("message_events").select("id", { count: "exact", head: true }).in("delivery_status", ["failed", "undelivered", "rejected"]).gte("created_at", startIso).lte("created_at", endIso),
      supabase.from("message_events").select("id", { count: "exact", head: true }).not("received_at", "is", null).gte("received_at", startIso).lte("received_at", endIso),
      supabase.from("send_queue").select("id,queue_status", { count: "exact" }).gte("created_at", startIso).lte("created_at", endIso).limit(10000),
    ]);

    for (const res of [sentRes, deliveredRes, failedByTsRes, failedByStatusRes, receivedRes, queueRes]) {
      if (res.error) throw res.error;
    }

    const queueRows = Array.isArray(queueRes.data) ? queueRes.data : [];
    const pendingCount = queueRows.filter((r) => clean(r.queue_status).toLowerCase() === "pending").length;
    const queuedOnlyCount = queueRows.filter((r) => clean(r.queue_status).toLowerCase() === "queued").length;
    const queued = queueRows.filter((r) => ["queued", "pending", "scheduled"].includes(clean(r.queue_status).toLowerCase())).length;
    const queueFailedTodayCount = queueRows.filter((r) => clean(r.queue_status).toLowerCase() === "failed").length;
    const failedCount = Math.max(Number(failedByTsRes.count || 0), Number(failedByStatusRes.count || 0));
    const queueProcessorStatus = queued > 0 ? "Running" : "Idle / Needs Run";

    const diagnostics = {
      window,
      sent_count: Number(sentRes.count || 0),
      delivered_count: Number(deliveredRes.count || 0),
      failed_count: failedCount,
      received_count: Number(receivedRes.count || 0),
      pending_count: pendingCount,
      queued_count_raw: queuedOnlyCount,
      queued_count: queued,
      queue_waiting_count: queued,
      queue_failed_today_count: queueFailedTodayCount,
      queue_processor_status: queueProcessorStatus,
      queue_last_run_at: null,
      automation_hard_failure_count: queueFailedTodayCount,
      sender_performance: [],
      metric_source_debug: {
        rules: {
          sent: "message_events.sent_at",
          delivered: "message_events.delivered_at",
          failed: "message_events.failed_at OR terminal failed statuses",
          received: "message_events.received_at",
          queued: "send_queue.queue_status in queued|pending|scheduled",
        },
        source_counts: {
          message_events_failed_at_count: Number(failedByTsRes.count || 0),
          message_events_failed_status_count: Number(failedByStatusRes.count || 0),
          send_queue_rows_scanned: queueRows.length,
        },
        window_start: startIso,
        window_end: endIso,
      },
    };

    return withCors(request, NextResponse.json({ ok: true, action: "ops-metrics", diagnostics }, { status: 200, headers: getCorsHeaders(request) }));
  } catch (error) {
    return withCors(request, NextResponse.json({
      ok: false,
      error: "ops_metrics_failed",
      message: error?.message || "Unknown ops metrics error",
    }, { status: 500, headers: getCorsHeaders(request) }));
  }
}
