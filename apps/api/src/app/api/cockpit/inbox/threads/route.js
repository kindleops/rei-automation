import { NextResponse } from "next/server.js";
import { ensureMutationAuth } from "../../_shared.js";
import { supabase, hasSupabaseConfig } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const SCAN_PAGE_SIZE = 500;
const MAX_SCAN_PAGES = 20;

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

function normalizeThreadKey(row, direction) {
  return clean(
    row?.thread_key ||
    (direction === "inbound" ? row?.from_phone_number : row?.to_phone_number) ||
    row?.from_phone_number ||
    row?.to_phone_number
  );
}

function classifyThreadForTab(thread) {
  const dir = clean(thread.latest_direction).toLowerCase();
  const body = clean(thread.latest_message_body).toLowerCase();
  const isSuppressed = Boolean(thread.is_opt_out || body.includes("stop"));
  if (isSuppressed) return "suppressed";
  if (dir === "inbound") {
    if (/(offer|price|interested|yes|call)/.test(body)) return "priority";
    if (/(review|attorney|legal|lawsuit|wrong)/.test(body)) return "needs_review";
    return "new_replies";
  }
  if (/(follow up|follow-up|checking in)/.test(body)) return "follow_up";
  if (/(no thanks|not interested|stop)/.test(body)) return "cold";
  return "all_messages";
}

function passesTab(thread, tab, exclusionReasons) {
  const normalizedTab = clean(tab || "all_messages").toLowerCase();
  if (!normalizedTab || normalizedTab === "all_messages") return true;
  const bucket = classifyThreadForTab(thread);
  const ok = bucket === normalizedTab;
  if (!ok) exclusionReasons[bucket] = Number(exclusionReasons[bucket] || 0) + 1;
  return ok;
}

export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const limit = asLimit(searchParams.get("limit"));
  const tab = clean(searchParams.get("tab") || "all_messages").toLowerCase();
  const parsedCursor = parseCursor(searchParams.get("cursor"));

  const diagnostics = {
    raw_events_scanned: 0,
    threads_built: 0,
    inbound_events: 0,
    outbound_events: 0,
    tab,
    exclusion_reasons: {},
  };

  try {
    const threadsByKey = new Map();
    let page = 0;
    let queryCursor = parsedCursor?.created_at || null;
    let lastRawRow = null;
    let exhausted = false;

    while (threadsByKey.size < limit && page < MAX_SCAN_PAGES && !exhausted) {
      let query = supabase
        .from("message_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(SCAN_PAGE_SIZE);
      if (queryCursor) query = query.lt("created_at", queryCursor);

      const { data, error } = await query;
      if (error) throw error;

      const rows = Array.isArray(data) ? data : [];
      diagnostics.raw_events_scanned += rows.length;
      if (rows.length === 0) break;

      for (const row of rows) {
        lastRawRow = row;
        const direction = normalizeDirection(row);
        if (direction === "inbound") diagnostics.inbound_events += 1;
        if (direction === "outbound") diagnostics.outbound_events += 1;

        const key = normalizeThreadKey(row, direction);
        if (!key) continue;

        const existing = threadsByKey.get(key);
        if (!existing) {
          threadsByKey.set(key, {
            thread_key: key,
            latest_event_id: row.id || null,
            latest_message_body: row.message_body || "",
            latest_direction: direction,
            latest_at: row.event_timestamp || row.received_at || row.sent_at || row.created_at || null,
            latest_message_at: row.event_timestamp || row.received_at || row.sent_at || row.created_at || null,
            from_phone_number: row.from_phone_number || null,
            to_phone_number: row.to_phone_number || null,
            master_owner_id: row.master_owner_id || null,
            property_id: row.property_id || null,
            prospect_id: row.prospect_id || null,
            is_opt_out: Boolean(row.is_opt_out),
            message_count: 1,
          });
        } else {
          existing.message_count += 1;
        }
      }

      exhausted = rows.length < SCAN_PAGE_SIZE;
      queryCursor = rows[rows.length - 1]?.created_at || null;
      page += 1;
    }

    let threads = [...threadsByKey.values()]
      .filter((thread) => passesTab(thread, tab, diagnostics.exclusion_reasons))
      .sort((a, b) => new Date(b.latest_at || 0).getTime() - new Date(a.latest_at || 0).getTime());

    threads = threads.slice(0, limit);
    diagnostics.threads_built = threads.length;

    const next_cursor = lastRawRow ? encodeCursor(lastRawRow) : null;
    return NextResponse.json({
      ok: true,
      threads,
      next_cursor,
      diagnostics,
    }, { status: 200 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: "inbox_threads_failed",
      message: error?.message || "Unknown inbox threads error",
      threads: [],
      next_cursor: null,
      diagnostics,
    }, { status: 500 });
  }
}
