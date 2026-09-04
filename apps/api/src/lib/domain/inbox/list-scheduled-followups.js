// ─── list-scheduled-followups.js ─────────────────────────────────────────────
// Read-only view of follow-ups the operator has intentionally parked in the
// future. Reads the canonical send_queue directly -- there is no separate
// scheduler store and none should be introduced.

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";

// Statuses that mean "still going to happen". A row that already sent, failed,
// or was cancelled is history, not a pending follow-up.
const PENDING_STATUSES = ["scheduled", "queued", "pending", "approved", "ready"];

const SCHEDULED_FIELDS = [
  "id",
  "queue_id",
  "thread_key",
  "queue_status",
  "scheduled_for",
  "scheduled_for_utc",
  "timezone",
  "local_send_date",
  "local_send_hour",
  "message_body",
  "to_phone_number",
  "from_phone_number",
  "seller_first_name",
  "property_address",
  "message_type",
  "use_case_template",
  "created_at",
].join(",");

function clean(value) {
  return String(value ?? "").trim();
}

function formatLocalLabel(hour, minute = 0) {
  if (!Number.isFinite(hour)) return null;
  const meridiem = hour >= 12 ? "PM" : "AM";
  let hour12 = hour % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

/**
 * Present a scheduled queue row for the Inbox "Scheduled" view.
 * Deliberately reports queue_status verbatim: a scheduled message is NOT sent,
 * and nothing here may imply delivery.
 */
export function presentScheduledRow(row = {}) {
  const scheduledFor = row.scheduled_for_utc || row.scheduled_for || null;
  let localMinute = 0;
  if (scheduledFor && clean(row.timezone)) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: row.timezone, hour12: false, minute: "2-digit",
      }).formatToParts(new Date(scheduledFor));
      localMinute = Number(parts.find((p) => p.type === "minute")?.value || 0);
    } catch { localMinute = 0; }
  }

  const body = clean(row.message_body);
  return {
    id: row.id || row.queue_id || null,
    thread_key: row.thread_key || null,
    queue_status: clean(row.queue_status) || null,
    // Never "sent"/"delivered": this message has not left.
    schedule_state: clean(row.queue_status) === "scheduled" ? "scheduled" : "pending",
    scheduled_for_utc: scheduledFor,
    timezone: row.timezone || null,
    local_send_date: row.local_send_date || null,
    local_send_hour: Number.isFinite(Number(row.local_send_hour)) ? Number(row.local_send_hour) : null,
    local_send_label: formatLocalLabel(Number(row.local_send_hour), localMinute),
    message_preview: body.length > 140 ? `${body.slice(0, 139)}…` : body,
    to_phone_number: row.to_phone_number || null,
    from_phone_number: row.from_phone_number || null,
    seller_name: row.seller_first_name || null,
    property_address: row.property_address || null,
    message_type: row.message_type || null,
    created_at: row.created_at || null,
  };
}

export async function listScheduledFollowups(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const threadKey = clean(params.thread_key);

  let query = supabase
    .from("send_queue")
    .select(SCHEDULED_FIELDS)
    .in("queue_status", PENDING_STATUSES)
    // Only rows genuinely parked in the future. A due-but-unsent row belongs to
    // the queue runner, not to an operator-facing "scheduled" list.
    .gt("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(limit);

  if (threadKey) query = query.eq("thread_key", threadKey);

  const { data, error } = await query;
  if (error) {
    return { ok: false, error: error.message || "scheduled_query_failed", items: [], count: 0 };
  }

  const items = (data || []).map(presentScheduledRow);
  return { ok: true, items, count: items.length };
}

export default listScheduledFollowups;
