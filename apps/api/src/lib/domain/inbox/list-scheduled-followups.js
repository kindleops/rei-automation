// ─── list-scheduled-followups.js ─────────────────────────────────────────────
// Read-only view of outbound messages that have not sent yet and are still
// expected to. Reads the canonical send_queue directly -- there is no separate
// scheduler store and none should be introduced. The Inbox "Scheduled" tab is an
// operator-friendly lens over exactly the rows the Queue / Outbound Command
// Center works from.

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";

/**
 * "STILL GOING TO HAPPEN" -- the one definition.
 *
 * Shared with v_inbox_bucket_counts.scheduled, so the chip and this list cannot
 * disagree. A row that already sent, was cancelled, or failed terminally is
 * history, not a pending follow-up.
 *
 * `processing`/`sending` are IN FLIGHT, not done: the worker has claimed the row
 * but the provider has not accepted it. Dropping them from Scheduled the moment
 * a worker picks them up would make the count flicker down and back up, and a
 * crashed worker would leave a message nobody is counting.
 */
export const PENDING_QUEUE_STATUSES = [
  "scheduled",
  "queued",
  "pending",
  "approved",
  "ready",
  "processing",
  "sending",
];

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
  // Retry state is part of the operator's answer to "why is this still here?".
  "retry_count",
  "max_retries",
  "next_retry_at",
  "failed_reason",
  // Enough lineage to open the right conversation and explain the send.
  "property_id",
  "template_id",
  "current_stage",
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
export function presentScheduledRow(row = {}, nowMs = Date.now()) {
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

  const status = clean(row.queue_status).toLowerCase();
  const dueMs = new Date(scheduledFor || 0).getTime();
  const retryCount = Number(row.retry_count ?? 0);
  const isRetry = Number.isFinite(retryCount) && retryCount > 0;

  /**
   * Why this message is still in Scheduled, in the operator's terms.
   *
   * The previous version reported only "scheduled" vs "pending", which could not
   * distinguish a follow-up parked for tomorrow morning from one that was due
   * two hours ago and has not moved -- the second is the one worth looking at.
   */
  let scheduleState = "pending";
  if (status === "processing" || status === "sending") scheduleState = "sending";
  else if (isRetry) scheduleState = "retry_scheduled";
  else if (Number.isFinite(dueMs) && dueMs > nowMs) scheduleState = "scheduled";
  else if (Number.isFinite(dueMs) && dueMs > 0) scheduleState = "due";

  const body = clean(row.message_body);
  return {
    id: row.id || row.queue_id || null,
    thread_key: row.thread_key || null,
    queue_status: clean(row.queue_status) || null,
    // Never "sent"/"delivered": this message has not left.
    schedule_state: scheduleState,
    scheduled_for_utc: scheduledFor,
    is_due: Number.isFinite(dueMs) && dueMs > 0 && dueMs <= nowMs,
    timezone: row.timezone || null,
    local_send_date: row.local_send_date || null,
    local_send_hour: Number.isFinite(Number(row.local_send_hour)) ? Number(row.local_send_hour) : null,
    local_send_label: formatLocalLabel(Number(row.local_send_hour), localMinute),
    message_preview: body.length > 140 ? `${body.slice(0, 139)}…` : body,
    to_phone_number: row.to_phone_number || null,
    from_phone_number: row.from_phone_number || null,
    seller_name: row.seller_first_name || null,
    property_address: row.property_address || null,
    property_id: row.property_id || null,
    message_type: row.message_type || null,
    template_id: row.template_id || null,
    stage: row.current_stage || null,
    channel: "sms",
    retry_count: Number.isFinite(retryCount) ? retryCount : 0,
    max_retries: Number.isFinite(Number(row.max_retries)) ? Number(row.max_retries) : null,
    next_retry_at: row.next_retry_at || null,
    last_failure_reason: row.failed_reason || null,
    created_at: row.created_at || null,
  };
}

export async function listScheduledFollowups(params = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const threadKey = clean(params.thread_key);
  const nowMs = Number(params.nowMs) || Date.now();

  /**
   * NO `scheduled_for > now()` BOUND.
   *
   * It used to require the row be parked in the FUTURE, on the reasoning that a
   * due-but-unsent row "belongs to the queue runner". But the operator contract
   * is arithmetic -- schedule 20, watch 20 drain -- and a message that came due
   * while the processor was paused is still a message that has not sent and is
   * still expected to. Hiding it made the Scheduled list quietly smaller than
   * the Scheduled count and gave the stuck rows nowhere to show up at all.
   */
  let query = supabase
    .from("send_queue")
    .select(SCHEDULED_FIELDS)
    .in("queue_status", PENDING_QUEUE_STATUSES)
    .order("scheduled_for", { ascending: true })
    .limit(limit);

  if (threadKey) query = query.eq("thread_key", threadKey);

  /**
   * THE COUNT IS THE POPULATION, NOT THE PAGE.
   *
   * `count: items.length` capped the answer at `limit` (max 200), so an inbox
   * with 500 pending follow-ups reported 200 -- the exact "badge computed from
   * whatever happens to be loaded" failure the certification brief forbids.
   * Issued as a HEAD count against the same predicate.
   */
  let countQuery = supabase
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .in("queue_status", PENDING_QUEUE_STATUSES);
  if (threadKey) countQuery = countQuery.eq("thread_key", threadKey);

  const [{ data, error }, countResult] = await Promise.all([query, countQuery]);
  if (error) {
    return { ok: false, error: error.message || "scheduled_query_failed", items: [], count: 0, total: 0 };
  }

  const items = (data || []).map((row) => presentScheduledRow(row, nowMs));
  const total = countResult?.error ? null : Number(countResult?.count ?? 0);

  return {
    ok: true,
    items,
    // `count` stays the population for every existing caller; `returned` is the
    // page size. They were the same number before, and that was the bug.
    count: total ?? items.length,
    total,
    returned: items.length,
    has_more: total != null ? total > items.length : false,
  };
}

export default listScheduledFollowups;
