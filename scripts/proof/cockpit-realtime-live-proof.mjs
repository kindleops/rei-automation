#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API_ROOT = path.join(ROOT, "apps/api");
const TEST_PHONE = "+16127433952";
const PROOF_SOURCE = "cockpit-realtime-live-proof";
const PRIMARY_THREAD_SOURCE = "v_inbox_threads_live_v2";
const PRIMARY_COUNT_SOURCE = "v_inbox_thread_counts_live_v2";
const KEEP_ROWS = ["1", "true", "yes"].includes(
  String(process.env.COCKPIT_PROOF_KEEP_ROWS || "").toLowerCase(),
);
const EXPECTED_DELIVERY_STATUS = String(
  process.env.COCKPIT_PROOF_DELIVERY_STATUS || "delivered",
).toLowerCase() === "failed"
  ? "failed"
  : "delivered";

const envFiles = [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/api/.env.production.local"),
  path.join(ROOT, "apps/dashboard/.env.local"),
  path.join(ROOT, "apps/dashboard/.env"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
];

function parseEnvValue(value) {
  const trimmed = String(value ?? "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    const value = parseEnvValue(normalized.slice(equalsIndex + 1));
    if (!process.env[key]) process.env[key] = value;
  }
}

for (const file of envFiles) loadEnvFile(file);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const OPS_SECRET =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.VITE_BACKEND_API_SECRET ||
  "";

const supabase = createClient(SUPABASE_URL || "https://placeholder.supabase.co", SUPABASE_SERVICE_ROLE_KEY || "placeholder", {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const results = [];
const cleanup = {
  staleMessageEvents: 0,
  staleQueueRows: 0,
  messageEvents: 0,
  queueRows: 0,
  restored: false,
  kept: KEEP_ROWS,
  errors: [],
};
let failures = 0;
let warnings = 0;

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function msSince(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proofLetters(length = 8) {
  return Array.from(crypto.randomBytes(length), (byte) =>
    String.fromCharCode(97 + (byte % 26)),
  ).join("");
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function isActiveBucket(bucket) {
  return ["priority", "new_replies", "needs_review", "follow_up"].includes(lower(bucket));
}

function routeHeaders() {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    origin: "http://localhost:5173",
  });
  if (OPS_SECRET) headers.set("x-ops-dashboard-secret", OPS_SECRET);
  return headers;
}

function mark(label, condition, detail = "", warnOnly = false) {
  const prefix = condition ? "PASS" : warnOnly ? "WARN" : "FAIL";
  const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
    return true;
  }
  if (warnOnly) {
    warnings += 1;
    console.warn(line);
    return false;
  }
  failures += 1;
  console.error(line);
  return false;
}

function routeDetail(result) {
  const parts = [`status=${result.status || "ERR"}`, `${result.ms}ms`];
  if (result.source) parts.push(`source=${result.source}`);
  if (result.countsSource) parts.push(`countsSource=${result.countsSource}`);
  if (result.error) parts.push(`error=${result.error}`);
  return `[${parts.join(" ")}]`;
}

function sourceFromLive(json = {}) {
  return json.source || json.diagnostics?.source || json.diagnostics?.live_source || null;
}

function countsSourceFromLive(json = {}) {
  return json.countsSource || json.diagnostics?.countsSource || null;
}

function countSummary(counts = {}) {
  return [
    `all=${Number(counts.all ?? 0)}`,
    `active=${Number(counts.active ?? 0)}`,
    `new_replies=${Number(counts.new_replies ?? 0)}`,
    `follow_up=${Number(counts.follow_up ?? 0)}`,
    `waiting=${Number(counts.waiting ?? 0)}`,
  ].join(" ");
}

function countDelta(before = {}, after = {}) {
  return ["all", "active", "new_replies", "follow_up", "waiting"]
    .map((key) => `${key}=${Number(after[key] ?? 0) - Number(before[key] ?? 0)}`)
    .join(" ");
}

function findThread(json = {}) {
  const rows = Array.isArray(json.threads)
    ? json.threads
    : Array.isArray(json.messages)
      ? json.messages
      : [];
  return rows.find((row) => (
    clean(row.thread_key) === TEST_PHONE ||
    clean(row.canonical_thread_key) === TEST_PHONE ||
    clean(row.canonical_e164) === TEST_PHONE ||
    clean(row.best_phone) === TEST_PHONE ||
    clean(row.seller_phone) === TEST_PHONE ||
    clean(row.phone) === TEST_PHONE
  )) || null;
}

function findMessage(json = {}, body) {
  const rows = Array.isArray(json.messages) ? json.messages : [];
  return rows.find((row) => clean(row.message_body) === body) || null;
}

function firstClean(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function liveRowDeliveryStatus(thread = {}) {
  return lower(firstClean(
    thread.latest_delivery_status,
    thread.delivery_status,
    thread.latest_provider_delivery_status,
    thread.provider_delivery_status,
    thread.queue_status,
  ));
}

function deliverySnapshot(thread = {}) {
  return {
    latest_delivery_status: firstClean(thread.latest_delivery_status),
    delivery_status: firstClean(thread.delivery_status),
    latest_provider_delivery_status: firstClean(thread.latest_provider_delivery_status),
    provider_delivery_status: firstClean(thread.provider_delivery_status),
    latest_delivered_at: firstClean(thread.latest_delivered_at),
    latest_failed_at: firstClean(thread.latest_failed_at),
    latest_failure_reason: firstClean(thread.latest_failure_reason),
    queue_status: firstClean(thread.queue_status),
  };
}

function metadataBase(proofKey, phase, extra = {}) {
  return {
    internal_test: true,
    proof: true,
    proof_key: proofKey,
    proof_source: PROOF_SOURCE,
    exclude_from_kpis: true,
    no_send: true,
    phone: TEST_PHONE,
    phase,
    ...extra,
  };
}

function filterPayload(columns, payload) {
  if (!columns?.size) return payload;
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => columns.has(key)),
  );
}

async function fetchColumns(table) {
  const { data, error } = await supabase.from(table).select("*").limit(1);
  if (error) throw new Error(`${table} column probe failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : null;
  return new Set(row ? Object.keys(row) : []);
}

async function deleteStaleProofRows() {
  const { data: messageRows, error: messageError } = await supabase
    .from("message_events")
    .delete()
    .eq("thread_key", TEST_PHONE)
    .eq("trigger_name", PROOF_SOURCE)
    .like("message_event_key", "proof:cockpit:%")
    .select("id");
  if (messageError) throw new Error(`stale message_events cleanup failed: ${messageError.message}`);
  cleanup.staleMessageEvents = messageRows?.length || 0;

  const { data: queueRows, error: queueError } = await supabase
    .from("send_queue")
    .delete()
    .eq("thread_key", TEST_PHONE)
    .like("queue_key", "proof:cockpit:%")
    .select("id");
  if (queueError) throw new Error(`stale send_queue cleanup failed: ${queueError.message}`);
  cleanup.staleQueueRows = queueRows?.length || 0;
}

async function insertMessageEvent({
  columns,
  proofKey,
  phase,
  body,
  direction,
  deliveryStatus,
  providerStatus = deliveryStatus,
  eventAt,
  queueId = null,
}) {
  const providerSid = `proof-${proofKey}-${phase}`;
  const payload = filterPayload(columns, {
    message_event_key: `proof:cockpit:${proofKey}:${phase}`,
    direction,
    event_type: `internal_test_proof_${phase}`,
    type: "internal_test_proof",
    thread_key: TEST_PHONE,
    from_phone_number: TEST_PHONE,
    to_phone_number: TEST_PHONE,
    message_body: body,
    character_count: body.length,
    delivery_status: deliveryStatus,
    provider_delivery_status: providerStatus,
    raw_carrier_status: providerStatus,
    provider_message_sid: providerSid,
    message_id: providerSid,
    queue_id: queueId,
    received_at: direction === "inbound" ? eventAt : null,
    sent_at: direction === "outbound" ? eventAt : null,
    event_timestamp: eventAt,
    created_at: eventAt,
    updated_at: eventAt,
    source_app: "internal_test",
    trigger_name: PROOF_SOURCE,
    triggered_by: PROOF_SOURCE,
    processed_by: "internal_test_proof",
    safety_status: "internal_test",
    priority: "normal",
    risk: "low",
    routing_allowed: false,
    detected_intent: "internal_test_proof",
    metadata: metadataBase(proofKey, phase, { provider_message_sid: providerSid }),
  });

  const { data, error } = await supabase
    .from("message_events")
    .insert(payload)
    .select("id,message_event_key,delivery_status,provider_delivery_status")
    .single();

  if (error) throw new Error(`message_events insert ${phase} failed: ${error.message}`);
  return data;
}

async function insertSendQueue({ columns, proofKey, body, sentAt }) {
  const queueKey = `proof:cockpit:${proofKey}:queue`;
  const payload = filterPayload(columns, {
    queue_key: queueKey,
    queue_id: queueKey,
    queue_status: "sent",
    type: "internal_test_proof",
    source: PROOF_SOURCE,
    thread_key: TEST_PHONE,
    to_phone_number: TEST_PHONE,
    from_phone_number: TEST_PHONE,
    message_body: body,
    message_text: body,
    character_count: body.length,
    provider_message_id: `proof-${proofKey}-queue`,
    textgrid_message_id: `proof-${proofKey}-queue`,
    sms_eligible: false,
    routing_allowed: false,
    routing_reason: "internal_test_proof_no_send",
    safety_status: "internal_test",
    guard_status: "blocked",
    guard_reason: "internal_test_proof_no_send",
    priority: "normal",
    risk: "low",
    risk_level: "low",
    send_priority: 9,
    scheduled_for: sentAt,
    scheduled_for_utc: sentAt,
    sent_at: sentAt,
    created_at: sentAt,
    updated_at: sentAt,
    metadata: metadataBase(proofKey, "queue", { queue_key: queueKey }),
  });

  const { data, error } = await supabase
    .from("send_queue")
    .insert(payload)
    .select("id,queue_key,queue_status")
    .single();

  if (error) throw new Error(`send_queue insert failed: ${error.message}`);
  return data;
}

async function updateDelivery({ proofKey, messageEventId, queueRowId, status }) {
  const eventAt = nowIso();
  const messagePatch = {
    delivery_status: status,
    provider_delivery_status: status,
    raw_carrier_status: status,
    delivered_at: status === "delivered" ? eventAt : null,
    failed_at: status === "failed" ? eventAt : null,
    failure_reason: status === "failed" ? "internal_test_proof_failure" : null,
    updated_at: eventAt,
    metadata: metadataBase(proofKey, "delivery_update", { delivery_status: status }),
  };
  const { error: messageError } = await supabase
    .from("message_events")
    .update(messagePatch)
    .eq("id", messageEventId);
  if (messageError) throw new Error(`message_events delivery update failed: ${messageError.message}`);

  const queuePatch = {
    queue_status: status,
    delivered_at: status === "delivered" ? eventAt : null,
    failed_reason: status === "failed" ? "internal_test_proof_failure" : null,
    updated_at: eventAt,
    metadata: metadataBase(proofKey, "queue_delivery_update", { delivery_status: status }),
  };
  const { error: queueError } = await supabase
    .from("send_queue")
    .update(queuePatch)
    .eq("id", queueRowId);
  if (queueError) throw new Error(`send_queue delivery update failed: ${queueError.message}`);
}

async function cleanupProofRows({ proofKey, messageEventIds, queueRowIds, liveRoute }) {
  if (KEEP_ROWS) return;

  const messageKeys = [
    `proof:cockpit:${proofKey}:inbound`,
    `proof:cockpit:${proofKey}:outbound`,
  ];
  const { data: deletedMessages, error: messageError } = await supabase
    .from("message_events")
    .delete()
    .in("message_event_key", messageKeys)
    .in("id", messageEventIds)
    .select("id");
  if (messageError) {
    cleanup.errors.push(`message_events:${messageError.message}`);
  } else {
    cleanup.messageEvents = deletedMessages?.length || 0;
  }

  const { data: deletedQueue, error: queueError } = await supabase
    .from("send_queue")
    .delete()
    .in("id", queueRowIds)
    .select("id");
  if (queueError) {
    cleanup.errors.push(`send_queue:${queueError.message}`);
  } else {
    cleanup.queueRows = deletedQueue?.length || 0;
  }

  await sleep(750);
  const restored = await callLive(liveRoute, "cleanup restore", "active", { limit: 10 });
  const restoredThread = findThread(restored.json);
  cleanup.restored = Boolean(
    restoredThread &&
      ![...messageKeys].some((key) => clean(restoredThread.latest_message_body).includes(key)) &&
      !clean(restoredThread.latest_message_body).startsWith("Internal test cockpit realtime proof"),
  );
}

async function callRoute(label, route, pathOrUrl) {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `http://localhost:3000${pathOrUrl}`;
  const startedAt = performance.now();
  let status = 0;
  let json = null;
  let error = null;

  try {
    const response = await route.GET(new Request(url, { headers: routeHeaders() }));
    status = response.status;
    const raw = await response.text();
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      error = `non_json_response:${raw.slice(0, 120)}`;
    }
  } catch (err) {
    error = err?.message || String(err);
  }

  const result = {
    label,
    status,
    ms: msSince(startedAt),
    json,
    error,
    source: sourceFromLive(json || {}),
    countsSource: countsSourceFromLive(json || {}),
  };
  results.push(result);
  return result;
}

async function callLive(route, label, filter = "all", options = {}) {
  const params = new URLSearchParams({
    filter,
    limit: String(options.limit || 20),
    timeout_mode: "manual_bucket_switch",
    q: TEST_PHONE,
  });
  return callRoute(label, route, `/api/cockpit/inbox/live?${params.toString()}`);
}

async function callMessages(route, label) {
  const params = new URLSearchParams({
    thread_key: TEST_PHONE,
    canonical_e164: TEST_PHONE,
    phone: TEST_PHONE,
    best_phone: TEST_PHONE,
    seller_phone: TEST_PHONE,
    limit: "50",
  });
  return callRoute(label, route, `/api/cockpit/inbox/thread-messages?${params.toString()}`);
}

async function loadRoutes() {
  process.chdir(API_ROOT);
  register(
    pathToFileURL(path.join(API_ROOT, "tests/alias-loader.mjs")).href,
    pathToFileURL(`${API_ROOT}/`),
  );

  const [liveRoute, threadMessagesRoute] = await Promise.all([
    import(pathToFileURL(path.join(API_ROOT, "src/app/api/cockpit/inbox/live/route.js")).href),
    import(pathToFileURL(path.join(API_ROOT, "src/app/api/cockpit/inbox/thread-messages/route.js")).href),
  ]);

  return { liveRoute, threadMessagesRoute };
}

function verifyCounts(label, beforeCounts, currentCounts, currentBucket = null) {
  const all = Number(currentCounts?.all ?? 0);
  const active = Number(currentCounts?.active ?? 0);
  const bucketCount = currentBucket ? Number(currentCounts?.[currentBucket] ?? 0) : null;
  const ok =
    all > 0 &&
    active > 0 &&
    (currentBucket ? bucketCount > 0 || isActiveBucket(currentBucket) : true);
  mark(
    `${label} count deltas do not zero out`,
    ok,
    `counts=[${countSummary(currentCounts)}] delta=[${countDelta(beforeCounts, currentCounts)}] bucket=${currentBucket || "n/a"} bucketCount=${bucketCount ?? "n/a"}`,
  );
}

async function main() {
  console.log(`Cockpit realtime live proof phone=${TEST_PHONE}`);
  console.log(`No TextGrid call will be made; synthetic rows are terminal/internal proof rows only.`);

  mark("Supabase URL loaded", Boolean(SUPABASE_URL));
  mark("Supabase service role loaded", Boolean(SUPABASE_SERVICE_ROLE_KEY));
  mark("internal test phone locked", TEST_PHONE === "+16127433952", TEST_PHONE);
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET), "", true);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const proofToken = proofLetters(10);
  const proofKey = `cockpit-live-${proofToken}`;
  const inboundBody = `Internal test cockpit realtime proof ${proofToken} inbound`;
  const outboundBody = `Internal test cockpit realtime proof ${proofToken} outbound`;
  const messageEventIds = [];
  const queueRowIds = [];
  let deliveryBefore = null;
  let deliveryAfter = null;
  let liveRowDelivery = "";

  const [{ liveRoute, threadMessagesRoute }, messageEventColumns, sendQueueColumns] = await Promise.all([
    loadRoutes(),
    fetchColumns("message_events"),
    fetchColumns("send_queue"),
  ]);

  try {
    await deleteStaleProofRows();
    if (cleanup.staleMessageEvents || cleanup.staleQueueRows) {
      console.log(
        `Preflight cleanup stale proof rows message_events=${cleanup.staleMessageEvents} send_queue=${cleanup.staleQueueRows}`,
      );
    }

    const before = await callLive(liveRoute, "before", "active", { limit: 10 });
    const beforeThread = findThread(before.json);
    const beforeBucket = beforeThread?.inbox_bucket || "missing";
    mark(
      "before live cockpit route",
      before.status === 200 && before.json?.ok === true && beforeThread,
      `${routeDetail(before)} bucket=${beforeBucket} latest="${beforeThread?.latest_message_body || ""}"`,
    );
    mark(
      "before live primary source",
      before.source === PRIMARY_THREAD_SOURCE && before.countsSource === PRIMARY_COUNT_SOURCE,
      `source=${before.source || "unknown"} countsSource=${before.countsSource || "unknown"}`,
    );
    const beforeCounts = before.json?.counts || {};

    const inbound = await insertMessageEvent({
      columns: messageEventColumns,
      proofKey,
      phase: "inbound",
      body: inboundBody,
      direction: "inbound",
      deliveryStatus: "received",
      eventAt: nowIso(500),
    });
    messageEventIds.push(inbound.id);
    console.log(`Inserted inbound proof message_event id=${inbound.id} key=${inbound.message_event_key}`);

    await sleep(1_000);
    const afterInbound = await callLive(liveRoute, "after inbound", "active", { limit: 10 });
    const inboundThread = findThread(afterInbound.json);
    const inboundBucket = inboundThread?.inbox_bucket || "missing";
    mark(
      "inbound thread appears/updates",
      afterInbound.status === 200 &&
        afterInbound.json?.ok === true &&
        inboundThread &&
        clean(inboundThread.latest_message_body) === inboundBody,
      `${routeDetail(afterInbound)} bucketBefore=${beforeBucket} bucketAfter=${inboundBucket}`,
    );
    mark(
      "inbound latest direction",
      lower(inboundThread?.latest_message_direction || inboundThread?.direction) === "inbound",
      `direction=${inboundThread?.latest_message_direction || inboundThread?.direction || "missing"}`,
    );
    mark(
      "inbound bucket resolves to new_replies/active",
      inboundBucket === "new_replies" || isActiveBucket(inboundBucket),
      `bucket=${inboundBucket} active=${isActiveBucket(inboundBucket)}`,
    );
    verifyCounts("after inbound", beforeCounts, afterInbound.json?.counts || {}, inboundBucket);

    const activeInbound = await callLive(liveRoute, "after inbound active filter", "active", { limit: 10 });
    mark(
      "inbound visible in active filter",
      Boolean(findThread(activeInbound.json)),
      `${routeDetail(activeInbound)} bucket=${inboundBucket}`,
    );

    const queue = await insertSendQueue({
      columns: sendQueueColumns,
      proofKey,
      body: outboundBody,
      sentAt: nowIso(1_500),
    });
    queueRowIds.push(queue.id);
    console.log(`Inserted terminal synthetic send_queue id=${queue.id} key=${queue.queue_key}`);

    const outbound = await insertMessageEvent({
      columns: messageEventColumns,
      proofKey,
      phase: "outbound",
      body: outboundBody,
      direction: "outbound",
      deliveryStatus: "sent",
      providerStatus: "sent",
      eventAt: nowIso(2_000),
      queueId: queue.id,
    });
    messageEventIds.push(outbound.id);
    console.log(`Inserted outbound proof message_event id=${outbound.id} key=${outbound.message_event_key}`);

    await sleep(1_000);
    const afterOutbound = await callLive(liveRoute, "after outbound sent", "active", { limit: 10 });
    const outboundThread = findThread(afterOutbound.json);
    const outboundBucket = outboundThread?.inbox_bucket || "missing";
    deliveryBefore = deliverySnapshot(outboundThread || {});
    mark(
      "outbound thread latest fields update",
      afterOutbound.status === 200 &&
        afterOutbound.json?.ok === true &&
        outboundThread &&
        clean(outboundThread.latest_message_body) === outboundBody &&
        lower(outboundThread.latest_message_direction || outboundThread.direction) === "outbound",
      `${routeDetail(afterOutbound)} bucketBefore=${inboundBucket} bucketAfter=${outboundBucket}`,
    );
    verifyCounts("after outbound sent", beforeCounts, afterOutbound.json?.counts || {}, outboundBucket);

    await updateDelivery({
      proofKey,
      messageEventId: outbound.id,
      queueRowId: queue.id,
      status: EXPECTED_DELIVERY_STATUS,
    });
    console.log(`Updated synthetic delivery status expected=${EXPECTED_DELIVERY_STATUS}`);

    await sleep(1_000);
    const afterDelivery = await callLive(liveRoute, "after delivery update", "active", { limit: 10 });
    const deliveryThread = findThread(afterDelivery.json);
    deliveryAfter = deliverySnapshot(deliveryThread || {});
    liveRowDelivery = liveRowDeliveryStatus(deliveryThread || {});
    mark(
      "delivery update preserves live latest fields",
      afterDelivery.status === 200 &&
        afterDelivery.json?.ok === true &&
        deliveryThread &&
        clean(deliveryThread.latest_message_body) === outboundBody &&
        lower(deliveryThread.latest_message_direction || deliveryThread.direction) === "outbound",
      `${routeDetail(afterDelivery)} bucket=${deliveryThread?.inbox_bucket || "missing"} liveDelivery=${liveRowDelivery || "not_surfaced"}`,
    );
    mark(
      "live row delivery status changes as expected",
      liveRowDelivery === EXPECTED_DELIVERY_STATUS,
      `expected=${EXPECTED_DELIVERY_STATUS} live_row_delivery_status=${liveRowDelivery || "missing"} provider=${deliveryAfter.latest_provider_delivery_status || deliveryAfter.provider_delivery_status || "missing"}`,
    );
    verifyCounts("after delivery", beforeCounts, afterDelivery.json?.counts || {}, deliveryThread?.inbox_bucket);

    console.log("Delivery row proof:", JSON.stringify({
      delivery_before: deliveryBefore,
      delivery_after: deliveryAfter,
      live_row_delivery_status: liveRowDelivery,
    }, null, 2));

    const threadMessages = await callMessages(threadMessagesRoute, "thread messages delivery");
    const outboundMessage = findMessage(threadMessages.json, outboundBody);
    mark(
      "delivery status changes as expected",
      threadMessages.status === 200 &&
        threadMessages.json?.ok === true &&
        outboundMessage &&
        lower(outboundMessage.delivery_status) === EXPECTED_DELIVERY_STATUS,
      `${routeDetail(threadMessages)} expected=${EXPECTED_DELIVERY_STATUS} actual=${outboundMessage?.delivery_status || "missing"} provider=${outboundMessage?.provider_delivery_status || "missing"}`,
    );

    await cleanupProofRows({
      proofKey,
      messageEventIds,
      queueRowIds,
      liveRoute,
    });

    mark(
      "cleanup completed",
      KEEP_ROWS || (
        cleanup.errors.length === 0 &&
        cleanup.messageEvents === messageEventIds.length &&
        cleanup.queueRows === queueRowIds.length
      ),
      KEEP_ROWS
        ? "kept rows by COCKPIT_PROOF_KEEP_ROWS=true"
        : `message_events=${cleanup.messageEvents}/${messageEventIds.length} send_queue=${cleanup.queueRows}/${queueRowIds.length} restored=${cleanup.restored} errors=${cleanup.errors.join("|") || "none"}`,
    );
  } finally {
    if (!KEEP_ROWS && (messageEventIds.length || queueRowIds.length)) {
      const { error: messageError } = await supabase
        .from("message_events")
        .delete()
        .in("id", messageEventIds);
      if (messageError && !cleanup.errors.some((value) => value.includes(messageError.message))) {
        cleanup.errors.push(`final_message_events:${messageError.message}`);
      }
      const { error: queueError } = await supabase
        .from("send_queue")
        .delete()
        .in("id", queueRowIds);
      if (queueError && !cleanup.errors.some((value) => value.includes(queueError.message))) {
        cleanup.errors.push(`final_send_queue:${queueError.message}`);
      }
    }
  }

  console.log("");
  console.log("Live route checkpoints:");
  for (const result of results) {
    const thread = findThread(result.json);
    const latest = thread?.latest_message_body
      ? ` latest="${clean(thread.latest_message_body).slice(0, 72)}"`
      : "";
    const bucket = thread?.inbox_bucket ? ` bucket=${thread.inbox_bucket}` : "";
    const delivery = thread ? ` live_row_delivery_status=${liveRowDeliveryStatus(thread) || "n/a"}` : "";
    const counts = result.json?.counts ? ` counts=[${countSummary(result.json.counts)}]` : "";
    console.log(`- ${result.label}: status=${result.status || "ERR"} ms=${result.ms} source=${result.source || "n/a"} countsSource=${result.countsSource || "n/a"}${bucket}${delivery}${latest}${counts}`);
  }

  console.log("");
  console.log(`Cleanup status: kept=${cleanup.kept} staleMessageEvents=${cleanup.staleMessageEvents} staleQueueRows=${cleanup.staleQueueRows} messageEvents=${cleanup.messageEvents} queueRows=${cleanup.queueRows} restored=${cleanup.restored} errors=${cleanup.errors.join("|") || "none"}`);

  if (failures > 0) {
    console.error(`FAIL cockpit realtime live proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS cockpit realtime live proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL cockpit realtime live proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
