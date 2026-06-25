#!/usr/bin/env node
/**
 * Read-only audit (default) for delivery canonical mismatches.
 * Pass --repair to apply RPC-free SQL corrections. Never contacts TextGrid.
 */

import { createClient } from "@supabase/supabase-js";

const args = new Set(process.argv.slice(2));
const repair = args.has("--repair");
const dryRun = !repair;
const BATCH = 200;

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

async function fetchAll(builderFactory, pageSize = 1000) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await builderFactory(offset, pageSize);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function chunk(values, size = BATCH) {
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

async function fetchEventsBySid(sids) {
  const bySid = new Map();
  for (const group of chunk([...new Set(sids.filter(Boolean))])) {
    const { data, error } = await supabase
      .from("message_events")
      .select("id, provider_message_sid, delivery_status, delivered_at, sent_at")
      .in("provider_message_sid", group);
    if (error) throw error;
    for (const row of data || []) {
      const list = bySid.get(row.provider_message_sid) || [];
      list.push(row);
      bySid.set(row.provider_message_sid, list);
    }
  }
  return bySid;
}

async function fetchQueueBySid(sids) {
  const bySid = new Map();
  for (const group of chunk([...new Set(sids.filter(Boolean))])) {
    const { data: byProvider, error: providerError } = await supabase
      .from("send_queue")
      .select("id, provider_message_id, textgrid_message_id, queue_status, delivered_at")
      .in("provider_message_id", group);
    if (providerError) throw providerError;
    const { data: byTextgrid, error: textgridError } = await supabase
      .from("send_queue")
      .select("id, provider_message_id, textgrid_message_id, queue_status, delivered_at")
      .in("textgrid_message_id", group);
    if (textgridError) throw textgridError;
    for (const row of [...(byProvider || []), ...(byTextgrid || [])]) {
      const sid = row.provider_message_id || row.textgrid_message_id;
      if (!sid) continue;
      const list = bySid.get(sid) || [];
      if (!list.some((item) => item.id === row.id)) list.push(row);
      bySid.set(sid, list);
    }
  }
  return bySid;
}

async function main() {
  console.log(`delivery-canonical-mismatch-audit mode=${dryRun ? "dry_run" : "repair"}`);

  const queueDeliveredPairs = await fetchAll((offset, limit) =>
    supabase
      .from("send_queue")
      .select("id, provider_message_id, textgrid_message_id, queue_status, delivered_at")
      .eq("queue_status", "delivered")
      .range(offset, offset + limit - 1),
  );

  const deliveredSids = queueDeliveredPairs
    .map((row) => row.provider_message_id || row.textgrid_message_id)
    .filter(Boolean);
  const eventsBySid = await fetchEventsBySid(deliveredSids);

  const queueDeliveredMessageMismatch = [];
  for (const queueRow of queueDeliveredPairs) {
    const sid = queueRow.provider_message_id || queueRow.textgrid_message_id;
    if (!sid) continue;
    for (const event of eventsBySid.get(sid) || []) {
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

  const deliveredEvents = await fetchAll((offset, limit) =>
    supabase
      .from("message_events")
      .select("id, provider_message_sid, delivery_status, delivered_at, sent_at")
      .eq("delivery_status", "delivered")
      .eq("direction", "outbound")
      .range(offset, offset + limit - 1),
  );

  const eventSids = deliveredEvents.map((row) => row.provider_message_sid).filter(Boolean);
  const queueBySid = await fetchQueueBySid(eventSids);

  const messageDeliveredQueueMismatch = [];
  for (const event of deliveredEvents) {
    if (!event.provider_message_sid) continue;
    for (const queueRow of queueBySid.get(event.provider_message_sid) || []) {
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

  const inboundDeliveredThreads = await fetchAll((offset, limit) =>
    supabase
      .from("inbox_thread_state")
      .select("thread_key, latest_direction, latest_delivery_status, latest_message_event_id, inbox_bucket")
      .eq("latest_direction", "inbound")
      .not("latest_delivery_status", "is", null)
      .range(offset, offset + limit - 1),
  );

  const outboundThreads = await fetchAll((offset, limit) =>
    supabase
      .from("inbox_thread_state")
      .select("thread_key, latest_direction, latest_delivery_status, latest_message_event_id, inbox_bucket")
      .eq("latest_direction", "outbound")
      .not("latest_message_event_id", "is", null)
      .range(offset, offset + limit - 1),
  );

  const eventIds = outboundThreads.map((row) => row.latest_message_event_id).filter(Boolean);
  const eventsById = new Map();
  for (const group of chunk(eventIds)) {
    const { data, error } = await supabase
      .from("message_events")
      .select("id, delivery_status")
      .in("id", group);
    if (error) throw error;
    for (const row of data || []) eventsById.set(String(row.id), row);
  }

  const threadStatusMismatch = [];
  for (const thread of outboundThreads) {
    const event = eventsById.get(String(thread.latest_message_event_id));
    if (event?.delivery_status && thread.latest_delivery_status !== event.delivery_status) {
      threadStatusMismatch.push({
        thread_key: thread.thread_key,
        thread_status: thread.latest_delivery_status,
        event_status: event.delivery_status,
        latest_message_event_id: thread.latest_message_event_id,
      });
    }
  }

  const deliveredBeforeSent = deliveredEvents.filter((row) => {
    if (!row.delivered_at || !row.sent_at) return false;
    return new Date(row.delivered_at).getTime() < new Date(row.sent_at).getTime();
  });

  const terminalMissingTimestamp = deliveredEvents.filter((row) => !row.delivered_at);

  const report = {
    queue_delivered_message_non_delivered: queueDeliveredMessageMismatch.length,
    message_delivered_queue_non_delivered: messageDeliveredQueueMismatch.length,
    inbound_thread_with_delivery_status: inboundDeliveredThreads.length,
    outbound_thread_status_mismatch: threadStatusMismatch.length,
    delivered_at_before_sent_at: deliveredBeforeSent.length,
    delivered_without_delivered_at: terminalMissingTimestamp.length,
    samples: {
      queue_delivered_message_non_delivered: queueDeliveredMessageMismatch.slice(0, 10),
      message_delivered_queue_non_delivered: messageDeliveredQueueMismatch.slice(0, 10),
      inbound_thread_with_delivery_status: inboundDeliveredThreads.slice(0, 10),
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

  for (const thread of inboundDeliveredThreads) {
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