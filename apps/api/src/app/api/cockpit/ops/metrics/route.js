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
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: now };
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(request) });
}

export async function GET(request) {
  const startTimeMs = Date.now();
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
    const [
      sentRes, deliveredRes, failedRes, receivedRes, optOutsRes, queueRes,
      threadsTotalRes, threadsPriorityRes, threadsSuppressedRes
    ] = await Promise.all([
      supabase.from("message_events").select("id", { count: "exact", head: true }).not("sent_at", "is", null).gte("sent_at", startIso).lte("sent_at", endIso),
      supabase.from("message_events").select("id", { count: "exact", head: true }).not("delivered_at", "is", null).gte("delivered_at", startIso).lte("delivered_at", endIso),
      supabase.from("message_events").select("id", { count: "exact", head: true }).not("failed_at", "is", null).gte("failed_at", startIso).lte("failed_at", endIso),
      supabase.from("message_events").select("id", { count: "exact", head: true }).not("received_at", "is", null).gte("received_at", startIso).lte("received_at", endIso),
      supabase.from("message_events").select("id", { count: "exact", head: true }).eq("is_opt_out", true).gte("created_at", startIso).lte("created_at", endIso),
      supabase.from("send_queue").select("id,queue_status", { count: "exact" }).gte("created_at", startIso).lte("created_at", endIso).limit(10000),
      supabase.from("inbox_thread_state").select("id", { count: "exact", head: true }),
      supabase.from("inbox_thread_state").select("id", { count: "exact", head: true }).or("priority.in.(high,urgent),is_hot_lead.eq.true"),
      supabase.from("inbox_thread_state").select("id", { count: "exact", head: true }).eq("is_suppressed", true)
    ]);

    for (const res of [sentRes, deliveredRes, failedRes, receivedRes, optOutsRes, queueRes, threadsTotalRes, threadsPriorityRes, threadsSuppressedRes]) {
      if (res.error) throw res.error;
    }

    const queueRows = Array.isArray(queueRes.data) ? queueRes.data : [];
    const pendingCount = queueRows.filter((r) => clean(r.queue_status).toLowerCase() === "pending").length;
    const queuedOnlyCount = queueRows.filter((r) => clean(r.queue_status).toLowerCase() === "queued").length;
    const queued = queueRows.filter((r) => ["queued", "pending", "scheduled"].includes(clean(r.queue_status).toLowerCase())).length;
    const queueFailedTodayCount = queueRows.filter((r) => ["failed", "outbound:failed"].includes(clean(r.queue_status).toLowerCase())).length;
    const queueProcessorStatus = queued > 0 ? "Running" : "Idle / Needs Run";

    const sentCount = Number(sentRes.count || 0);
    const deliveredCount = Number(deliveredRes.count || 0);
    const failedCount = Number(failedRes.count || 0);
    const receivedCount = Number(receivedRes.count || 0);
    const optOutCount = Number(optOutsRes.count || 0);

    // Rate calculations
    const deliveryRate = sentCount > 0 ? (deliveredCount / sentCount) * 100 : 0;
    const failureRate = sentCount > 0 ? (failedCount / sentCount) * 100 : 0;
    const replyRate = deliveredCount > 0 ? (receivedCount / deliveredCount) * 100 : 0;
    const optOutRate = deliveredCount > 0 ? (optOutCount / deliveredCount) * 100 : 0;
    const positiveRate = 0; // Mocked until intent analysis is added
    const negativeRate = 0; // Mocked until intent analysis is added

    const diagnostics = {
      window,
      sent_count: sentCount,
      delivered_count: deliveredCount,
      failed_count: failedCount,
      received_count: receivedCount,
      opt_out_count: optOutCount,
      pending_count: pendingCount,
      queued_count_raw: queuedOnlyCount,
      queued_count: queued,
      queue_waiting_count: queued,
      queue_failed_today_count: queueFailedTodayCount,
      queue_processor_status: queueProcessorStatus,
      queue_last_run_at: null,
      automation_hard_failure_count: queueFailedTodayCount,
      threads_total: Number(threadsTotalRes.count || 0),
      priority_threads: Number(threadsPriorityRes.count || 0),
      suppressed_threads: Number(threadsSuppressedRes.count || 0),
      
      // Rates
      delivery_rate: deliveryRate,
      failure_rate: failureRate,
      reply_rate: replyRate,
      opt_out_rate: optOutRate,
      positive_rate: positiveRate,
      negative_rate: negativeRate,

      sender_performance: [],
      metric_source_debug: {
        metrics_generated_at: new Date().toISOString(),
        backend_version: "2.0.0-utc-canonical",
        aggregation_runtime_ms: Date.now() - startTimeMs,
        cached: false,
        duplicate_rows_detected: 0,
        rules: {
          sent: "message_events.sent_at",
          delivered: "message_events.delivered_at",
          failed: "message_events.failed_at",
          received: "message_events.received_at",
          opt_outs: "message_events.is_opt_out AND created_at",
          queued: "send_queue.queue_status in queued|pending|scheduled",
        },
        source_counts: {
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
