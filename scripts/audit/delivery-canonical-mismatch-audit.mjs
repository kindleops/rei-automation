#!/usr/bin/env node
/**
 * Read-only audit (default) for delivery canonical mismatches.
 * Pass --repair to apply RPC-free SQL corrections. Never contacts TextGrid.
 */

import { createClient } from "@supabase/supabase-js";

const args = new Set(process.argv.slice(2));
const repair = args.has("--repair");
const dryRun = !repair;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

const supabase = createClient(
  requiredEnv("SUPABASE_URL"),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

async function count(sqlLabel, query) {
  const { data, error } = await query;
  if (error) throw new Error(`${sqlLabel}: ${error.message}`);
  return Array.isArray(data) ? data.length : Number(data || 0);
}

async function fetchRows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function main() {
  console.log(`delivery-canonical-mismatch-audit mode=${dryRun ? "dry_run" : "repair"}`);

  const queueDeliveredMessageNot = await fetchRows(
    supabase
      .from("message_events")
      .select("id, provider_message_sid, delivery_status, queue_id")
      .eq("direction", "outbound")
      .in("delivery_status", ["pending", "sent", "queued", "failed"])
      .not("provider_message_sid", "is", null)
      .limit(5000),
  );

  const queueDeliveredPairs = await fetchRows(
    supabase
      .from("send_queue")
      .select("id, provider_message_id, textgrid_message_id, queue_status, delivered_at")
      .eq("queue_status", "delivered")
      .limit(5000),
  );

  const queueDeliveredMessageMismatch = [];
  for (const queueRow of queueDeliveredPairs) {
    const sid = queueRow.provider_message_id || queueRow.textgrid_message_id;
    if (!sid) continue;
    const { data: events } = await supabase
      .from("message_events")
      .select("id, delivery_status, delivered_at")
      .eq("provider_message_sid", sid);
    for (const event of events || []) {
      if (event.delivery_status !== "delivered") {
        queueDeliveredMessageMismatch.push({
          queue_id: queueRow.id,
          message_event_id: event.id,
          provider_message_sid: sid,
          queue_status: queueRow.queue_status,
          message_delivery_status: event.delivery_status,
        });
      }
    }
  }

  const messageDeliveredQueueMismatch = [];
  const { data: deliveredEvents } = await supabase
    .from("message_events")
    .select("id, provider_message_sid, delivery_status, delivered_at")
    .eq("delivery_status", "delivered")
    .eq("direction", "outbound")
    .limit(5000);

  for (const event of deliveredEvents || []) {
    if (!event.provider_message_sid) continue;
    const { data: queueRows } = await supabase
      .from("send_queue")
      .select("id, queue_status, delivered_at")
      .or(
        `provider_message_id.eq.${event.provider_message_sid},textgrid_message_id.eq.${event.provider_message_sid}`,
      );
    for (const queueRow of queueRows || []) {
      if (queueRow.queue_status !== "delivered") {
        messageDeliveredQueueMismatch.push({
          queue_id: queueRow.id,
          message_event_id: event.id,
          provider_message_sid: event.provider_message_sid,
          queue_status: queueRow.queue_status,
          message_delivery_status: event.delivery_status,
        });
      }
    }
  }

  const { data: inboundDeliveredThreads } = await supabase
    .from("inbox_thread_state")
    .select("thread_key, latest_direction, latest_delivery_status, latest_message_event_id, inbox_bucket")
    .eq("latest_direction", "inbound")
    .not("latest_delivery_status", "is", null)
    .limit(5000);

  const { data: outboundThreadMismatch } = await supabase
    .from("inbox_thread_state")
    .select("thread_key, latest_direction, latest_delivery_status, latest_message_event_id, inbox_bucket")
    .eq("latest_direction", "outbound")
    .not("latest_message_event_id", "is", null)
    .limit(5000);

  const threadStatusMismatch = [];
  for (const thread of outboundThreadMismatch || []) {
    const { data: event } = await supabase
      .from("message_events")
      .select("id, delivery_status")
      .eq("id", thread.latest_message_event_id)
      .maybeSingle();
    if (event && event.delivery_status && thread.latest_delivery_status !== event.delivery_status) {
      threadStatusMismatch.push({
        thread_key: thread.thread_key,
        thread_status: thread.latest_delivery_status,
        event_status: event.delivery_status,
        latest_message_event_id: thread.latest_message_event_id,
      });
    }
  }

  const { data: timestampMismatch } = await supabase
    .from("message_events")
    .select("id, provider_message_sid, sent_at, delivered_at, delivery_status")
    .eq("direction", "outbound")
    .not("delivered_at", "is", null)
    .not("sent_at", "is", null)
    .limit(5000);

  const deliveredBeforeSent = (timestampMismatch || []).filter((row) => {
    return new Date(row.delivered_at).getTime() < new Date(row.sent_at).getTime();
  });

  const terminalMissingTimestamp = (deliveredEvents || []).filter((row) => !row.delivered_at);

  const report = {
    queue_delivered_message_non_delivered: queueDeliveredMessageMismatch.length,
    message_delivered_queue_non_delivered: messageDeliveredQueueMismatch.length,
    inbound_thread_with_delivery_status: (inboundDeliveredThreads || []).length,
    outbound_thread_status_mismatch: threadStatusMismatch.length,
    delivered_at_before_sent_at: deliveredBeforeSent.length,
    delivered_without_delivered_at: terminalMissingTimestamp.length,
    samples: {
      queue_delivered_message_non_delivered: queueDeliveredMessageMismatch.slice(0, 10),
      message_delivered_queue_non_delivered: messageDeliveredQueueMismatch.slice(0, 10),
      inbound_thread_with_delivery_status: (inboundDeliveredThreads || []).slice(0, 10),
      outbound_thread_status_mismatch: threadStatusMismatch.slice(0, 10),
      delivered_at_before_sent_at: deliveredBeforeSent.slice(0, 10),
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (!repair) {
    console.log("Dry run complete. Re-run with --repair to apply corrections.");
    return;
  }

  let repaired = 0;
  for (const row of queueDeliveredMessageMismatch) {
    const { error } = await supabase
      .from("message_events")
      .update({
        delivery_status: "delivered",
        delivered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.message_event_id)
      .neq("delivery_status", "delivered");
    if (!error) repaired += 1;
  }

  for (const row of messageDeliveredQueueMismatch) {
    const { error } = await supabase
      .from("send_queue")
      .update({
        queue_status: "delivered",
        delivery_confirmed: "confirmed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.queue_id)
      .neq("queue_status", "delivered");
    if (!error) repaired += 1;
  }

  for (const thread of inboundDeliveredThreads || []) {
    const { error } = await supabase
      .from("inbox_thread_state")
      .update({
        latest_delivery_status: null,
        updated_at: new Date().toISOString(),
      })
      .eq("thread_key", thread.thread_key);
    if (!error) repaired += 1;
  }

  console.log(`repair_rows_touched=${repaired}`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});