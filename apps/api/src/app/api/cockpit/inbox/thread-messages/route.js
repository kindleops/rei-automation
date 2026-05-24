import { NextResponse } from "next/server.js";
import { ensureMutationAuth } from "../../_shared.js";
import { supabase, hasSupabaseConfig } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clean(value) {
  return String(value ?? "").trim();
}

function asLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function parseCursor(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(clean(value), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    created_at: row?.created_at || null,
    id: row?.id || null,
  })).toString("base64url");
}

function normalizeDirection(row) {
  const direction = clean(row?.direction).toLowerCase();
  const eventType = clean(row?.event_type).toLowerCase();
  if (direction === "inbound" || row?.received_at || eventType.includes("inbound")) return "inbound";
  if (direction === "outbound" || row?.sent_at || eventType === "outbound_send") return "outbound";
  return direction || "unknown";
}

export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const thread_key = clean(searchParams.get("thread_key"));
  const limit = asLimit(searchParams.get("limit"));
  const cursor = parseCursor(searchParams.get("cursor"));

  if (!thread_key) {
    return NextResponse.json({ ok: false, error: "missing_thread_key" }, { status: 400 });
  }

  try {
    let query = supabase
      .from("message_events")
      .select("*")
      .or(`thread_key.eq.${thread_key},from_phone_number.eq.${thread_key},to_phone_number.eq.${thread_key}`)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (cursor?.created_at) query = query.lt("created_at", cursor.created_at);

    const { data, error } = await query;
    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const normalized = rows
      .map((row) => ({
        ...row,
        direction: normalizeDirection(row),
        timeline_at: row.event_timestamp || row.received_at || row.sent_at || row.created_at || null,
      }))
      .sort((a, b) => new Date(a.timeline_at || 0).getTime() - new Date(b.timeline_at || 0).getTime());

    return NextResponse.json({
      ok: true,
      thread_key,
      messages: normalized,
      next_cursor: rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null,
      diagnostics: {
        rows_returned: normalized.length,
      },
    }, { status: 200 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: "thread_messages_failed",
      message: error?.message || "Unknown thread message error",
      thread_key,
      messages: [],
      next_cursor: null,
    }, { status: 500 });
  }
}
