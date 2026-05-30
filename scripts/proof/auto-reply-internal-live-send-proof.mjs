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
const DEFAULT_PROOF_FROM_PHONE = "+16128060495";
const PROOF_SOURCE = "auto-reply-internal-live-send-proof";
const PROOF_MODE = "internal_only_live_proof";
const AUTOMATION_MODE = "internal_only";
const INBOUND_TEXT = "Yes I still own it";
const LIVE_SEND_PROOF_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.AUTO_REPLY_INTERNAL_LIVE_SEND_PROOF_ENABLED || "").toLowerCase(),
);
const ACTIVE_QUEUE_STATUSES = [
  "queued",
  "pending",
  "approved",
  "ready",
  "scheduled",
  "processing",
  "sending",
];
const DELIVERY_TERMINAL_OR_SENT = new Set(["sent", "delivered", "failed"]);
const DELIVERY_POLL_MS = Math.max(
  0,
  Number.parseInt(process.env.AUTO_REPLY_INTERNAL_LIVE_DELIVERY_POLL_MS || "15000", 10) || 0,
);

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
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
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

process.env.PODIO_CLIENT_ID ||= "proof";
process.env.PODIO_CLIENT_SECRET ||= "proof";
process.env.PODIO_USERNAME ||= "proof";
process.env.PODIO_PASSWORD ||= "proof";
process.env.ENABLE_AI_ASSIST = "false";
process.env.OPENAI_KEY ||= "proof-openai-key";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (SUPABASE_URL) process.env.SUPABASE_URL = SUPABASE_URL;
if (SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

process.chdir(API_ROOT);

register(
  pathToFileURL(path.join(API_ROOT, "tests/alias-loader.mjs")).href,
  pathToFileURL(`${API_ROOT}/`),
);

const supabase = createClient(
  SUPABASE_URL || "https://placeholder.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY || "placeholder",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { isInternalTestPhone } = await import(
  pathToFileURL(path.join(API_ROOT, "src/lib/config/internal-phones.js")).href
);
const {
  getTextgridProviderCapabilities,
  getTextgridSendCredentialStatus,
  normalizePhone,
  sendTextgridSMS,
} = await import(pathToFileURL(path.join(API_ROOT, "src/lib/providers/textgrid.js")).href);
const { getSystemFlag, getSystemValue } = await import(
  pathToFileURL(path.join(API_ROOT, "src/lib/system-control.js")).href
);
const { classify } = await import(
  pathToFileURL(path.join(API_ROOT, "src/lib/domain/classification/classify.js")).href
);
const { executeInboundAutomationDecision } = await import(
  pathToFileURL(path.join(API_ROOT, "src/lib/domain/seller-flow/apply-inbound-automation-decision.js")).href
);
const { insertSupabaseSendQueueRow } = await import(
  pathToFileURL(path.join(API_ROOT, "src/lib/supabase/sms-engine.js")).href
);
const { processSendQueue } = await import(
  pathToFileURL(path.join(API_ROOT, "src/lib/domain/queue/process-send-queue.js")).href
);

let failures = 0;
let warnings = 0;
let insertedInboundEventId = null;
let insertedQueueRowId = null;
let sendAttempted = false;

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proofToken(length = 8) {
  return Array.from(crypto.randomBytes(length), (byte) =>
    String.fromCharCode(97 + (byte % 26)),
  ).join("");
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

function hardAssert(condition, message, detail = "") {
  if (!condition) {
    throw new Error(`${message}${detail ? ` ${detail}` : ""}`);
  }
}

function filterPayload(columns, payload) {
  if (!columns?.size) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => columns.has(key)));
}

function parsePhoneList(value = "") {
  return String(value || "")
    .split(/[,\s]+/)
    .map((entry) => normalizePhone(entry))
    .filter(Boolean);
}

const APPROVED_PROOF_SENDERS = new Set([
  DEFAULT_PROOF_FROM_PHONE,
  ...parsePhoneList(process.env.AUTO_REPLY_INTERNAL_PROOF_APPROVED_SENDERS),
]);
const PROOF_FROM_PHONE = normalizePhone(
  process.env.AUTO_REPLY_INTERNAL_PROOF_FROM_PHONE || DEFAULT_PROOF_FROM_PHONE,
);

function metadataBase(proofKey, extra = {}) {
  return {
    internal_test: true,
    internal_test_phone: true,
    proof: true,
    proof_key: proofKey,
    proof_source: PROOF_SOURCE,
    proof_mode: PROOF_MODE,
    auto_reply_mode: AUTOMATION_MODE,
    exclude_from_kpis: true,
    no_send: false,
    phone: TEST_PHONE,
    ...extra,
  };
}

async function fetchColumns(table) {
  const { data, error } = await supabase.from(table).select("*").limit(1);
  if (error) throw new Error(`${table} column probe failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : null;
  return new Set(row ? Object.keys(row) : []);
}

async function fetchQueueRow(queueRowId) {
  const { data, error } = await supabase
    .from("send_queue")
    .select("*")
    .eq("id", queueRowId)
    .maybeSingle();
  if (error) throw new Error(`send_queue lookup failed: ${error.message}`);
  return data || null;
}

async function fetchOutboundEvent(queueRowId) {
  const { data, error } = await supabase
    .from("message_events")
    .select("*")
    .eq("queue_id", queueRowId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`outbound message_events lookup failed: ${error.message}`);
  return Array.isArray(data) ? data[0] || null : null;
}

async function fetchInboundProofEvent(proofKey) {
  const { data, error } = await supabase
    .from("message_events")
    .select("id,message_event_key,metadata")
    .like("message_event_key", `proof:auto-reply-live:${proofKey}:%`)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`inbound proof message_events lookup failed: ${error.message}`);
  return Array.isArray(data) ? data[0] || null : null;
}

async function fetchRecentCompletedProofSend() {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_key,queue_status,to_phone_number,from_phone_number,provider_message_id,created_at,metadata")
    .eq("to_phone_number", TEST_PHONE)
    .like("queue_key", "inbound_auto_reply:proof-live:%")
    .eq("queue_status", "sent")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(`recent completed proof lookup failed: ${error.message}`);
  return (Array.isArray(data) ? data : []).find((row) =>
    row.metadata?.proof === true &&
    row.metadata?.proof_source === PROOF_SOURCE &&
    clean(row.provider_message_id)
  ) || null;
}

async function fetchActiveAutoReplyRows() {
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_key,queue_status,to_phone_number,thread_key,type,metadata")
    .eq("to_phone_number", TEST_PHONE)
    .eq("type", "auto_reply")
    .in("queue_status", ACTIVE_QUEUE_STATUSES);
  if (error) throw new Error(`active auto-reply duplicate check failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

async function cancelStaleProofQueueRows(proofKey) {
  const now = nowIso();
  const { data, error } = await supabase
    .from("send_queue")
    .update({
      queue_status: "cancelled",
      is_locked: false,
      locked_at: null,
      lock_token: null,
      updated_at: now,
      metadata: {
        proof: true,
        internal_test: true,
        internal_test_phone: true,
        proof_source: PROOF_SOURCE,
        cancelled_by: PROOF_SOURCE,
        cancelled_before_proof_key: proofKey,
        cancelled_at: now,
        exclude_from_kpis: true,
        no_send: true,
      },
    })
    .eq("to_phone_number", TEST_PHONE)
    .like("queue_key", "inbound_auto_reply:proof-live:%")
    .in("queue_status", ACTIVE_QUEUE_STATUSES)
    .select("id");
  if (error) throw new Error(`stale proof queue cancel failed: ${error.message}`);
  return data?.length || 0;
}

function senderStatusAllowed(status = "") {
  const normalized = lower(status);
  if (!normalized) return true;
  if (normalized.includes("inactive") || normalized.includes("disabled") || normalized.includes("retired")) return false;
  if (normalized.includes("active") || normalized.includes("warming")) return true;
  return [
    "active",
    "enabled",
    "available",
    "on",
    "_ active",
    "_ warming up",
  ].includes(normalized);
}

function senderHardPaused(row = {}) {
  return ["hard_pause", "hard-pause", "paused", "is_paused"].some((key) => {
    const value = row[key];
    if (typeof value === "boolean") return value;
    return ["true", "1", "yes", "on", "paused"].includes(lower(value));
  });
}

function senderPhoneCandidates(row = {}) {
  return [
    row.phone_number,
    row.title,
    row.from_phone_number,
    row.number,
    row.textgrid_number,
  ].map((value) => normalizePhone(value)).filter(Boolean);
}

async function loadApprovedProofSender(fromPhone) {
  const { data, error } = await supabase
    .from("textgrid_numbers")
    .select("*")
    .limit(500);
  if (error) throw new Error(`textgrid_numbers lookup failed: ${error.message}`);

  const rows = Array.isArray(data) ? data : [];
  const match = rows.find((row) => senderPhoneCandidates(row).includes(fromPhone));
  hardAssert(match, "approved TextGrid proof sender not found in textgrid_numbers", fromPhone);
  hardAssert(
    senderStatusAllowed(match.status),
    "TextGrid proof sender is not active/available",
    `status=${match.status || "missing"}`,
  );
  hardAssert(!senderHardPaused(match), "TextGrid proof sender is paused", fromPhone);

  const dailyLimit = Number(match.daily_limit);
  const sentToday = Number(match.messages_sent_today || 0);
  if (Number.isFinite(dailyLimit)) {
    hardAssert(sentToday < dailyLimit, "TextGrid proof sender daily limit reached", `sent=${sentToday} limit=${dailyLimit}`);
  }

  return match;
}

async function insertInboundProofEvent({ columns, proofKey, body }) {
  const eventAt = nowIso();
  const providerSid = `proof-auto-reply-live-${proofKey}-inbound`;
  const payload = filterPayload(columns, {
    message_event_key: `proof:auto-reply-live:${proofKey}:inbound`,
    provider_message_sid: providerSid,
    message_id: providerSid,
    direction: "inbound",
    event_type: "internal_auto_reply_live_proof",
    type: "internal_test_proof",
    thread_key: TEST_PHONE,
    from_phone_number: TEST_PHONE,
    to_phone_number: PROOF_FROM_PHONE,
    message_body: body,
    character_count: body.length,
    delivery_status: "received",
    provider_delivery_status: "received",
    raw_carrier_status: "received",
    received_at: eventAt,
    event_timestamp: eventAt,
    created_at: eventAt,
    updated_at: eventAt,
    source_app: "internal_test",
    trigger_name: PROOF_SOURCE,
    triggered_by: PROOF_SOURCE,
    processed_by: PROOF_SOURCE,
    safety_status: "proof_internal_live",
    priority: "normal",
    risk: "low",
    routing_allowed: true,
    metadata: metadataBase(proofKey, {
      provider_message_sid: providerSid,
      simulated_inbound: true,
    }),
  });

  const { data, error } = await supabase
    .from("message_events")
    .insert(payload)
    .select("id,message_event_key,metadata")
    .single();
  if (error) throw new Error(`message_events inbound insert failed: ${error.message}`);
  return data;
}

function buildContext(proofKey, senderRow) {
  return {
    found: true,
    ids: {
      thread_key: TEST_PHONE,
      property_id: `900${proofKey.replace(/\D/g, "").slice(0, 6) || "123456"}`,
      master_owner_id: null,
      prospect_id: null,
      phone_item_id: null,
      textgrid_number_id: senderRow?.id || null,
    },
    summary: {
      property_address: "123 Internal Proof St",
      property_city: "Minneapolis",
      market: "Minneapolis, MN",
      market_name: "Minneapolis, MN",
      market_timezone: "America/Chicago",
      contact_window: "12AM-11:59PM CT",
      property_type: "Single Family",
      property_type_scope: "Single Family",
      conversation_stage: "ownership_check",
      owner_name: "Internal Proof",
      seller_first_name: "Internal",
      suppression_status: "allowed",
      phone_contact_status: "active",
    },
    items: {},
    recent: {},
  };
}

function automationGatesAreOpen(execution = {}, classification = {}) {
  const decision = execution.automation_decision || {};
  const intent = lower(classification.primary_intent);
  return (
    decision.should_suppress_contact !== true &&
    decision.should_mark_human_review !== true &&
    intent !== "opt_out" &&
    intent !== "wrong_number" &&
    intent !== "hostile_or_legal" &&
    !clean(decision.human_review_reason) &&
    !clean(decision.suppression_reason)
  );
}

function appendProofSuffix(renderedText, proofKey) {
  const base = clean(renderedText);
  const suffix = `[internal proof ${proofKey}]`;
  if (base.includes(suffix)) return base;
  return `${base} ${suffix}`;
}

async function createRunnableProofQueueRow({
  proofKey,
  inboundEventKey,
  classification,
  execution,
  senderRow,
}) {
  const selectedTemplate = execution.selected_template || {};
  const templateId = clean(selectedTemplate.template_id || selectedTemplate.id);
  const selectedUseCase = clean(selectedTemplate.use_case || execution.automation_decision?.route_hint || "auto_reply");
  const renderedMessage = appendProofSuffix(execution.rendered_message_text, proofKey);
  const queueKey = [
    "inbound_auto_reply",
    "proof-live",
    proofKey,
    clean(inboundEventKey),
    templateId || "no-template",
    TEST_PHONE,
  ].join(":");
  const scheduledFor = nowIso(-1000);
  const metadata = metadataBase(proofKey, {
    source: "auto_reply",
    action_type: "autopilot_inbound_reply",
    target_runner_only: true,
    inbound_message_event_id: inboundEventKey,
    classification_snapshot: classification,
    automation_decision_snapshot: execution.automation_decision,
    selected_template_snapshot: {
      id: selectedTemplate.id || null,
      template_id: selectedTemplate.template_id || null,
      use_case: selectedTemplate.use_case || null,
      stage_code: selectedTemplate.stage_code || null,
      language: selectedTemplate.language || null,
    },
    selected_template_id: templateId,
    route_hint: execution.automation_decision?.route_hint || null,
    allowed_template_stages: execution.automation_decision?.allowed_template_stages || [],
    approved_proof_sender: PROOF_FROM_PHONE,
    queue_context: {
      seller_first_name: "Internal",
      canonical_e164: TEST_PHONE,
      phone_e164: TEST_PHONE,
      market_timezone: "America/Chicago",
    },
    candidate_snapshot: {
      seller_first_name: "Internal",
      display_name: "Internal Proof",
      phone_e164: TEST_PHONE,
      owner_display_name: "Internal Proof",
      property_address: "123 Internal Proof St",
    },
  });

  const result = await insertSupabaseSendQueueRow({
    queue_key: queueKey,
    queue_id: queueKey,
    dedupe_key: `${queueKey}:dedupe`,
    queue_status: "queued",
    scheduled_for: scheduledFor,
    scheduled_for_utc: scheduledFor,
    scheduled_for_local: scheduledFor,
    timezone: "America/Chicago",
    contact_window: "12AM-11:59PM CT",
    send_priority: 10,
    retry_count: 0,
    max_retries: 1,
    message_body: renderedMessage,
    message_text: renderedMessage,
    to_phone_number: TEST_PHONE,
    from_phone_number: PROOF_FROM_PHONE,
    master_owner_id: null,
    prospect_id: null,
    property_id: null,
    phone_number_id: null,
    textgrid_number_id: senderRow?.id || null,
    template_id: templateId,
    selected_template_id: templateId,
    current_stage: clean(selectedTemplate.stage_code || selectedUseCase) || null,
    message_type: "Follow-Up",
    use_case_template: selectedUseCase,
    character_count: renderedMessage.length,
    thread_key: TEST_PHONE,
    template_source: "sms_templates",
    rendered_message: renderedMessage,
    priority: "normal",
    risk: "low",
    sms_eligible: true,
    routing_allowed: true,
    safety_status: "proof_internal_live",
    type: "auto_reply",
    source_event_id: inboundEventKey,
    inbound_message_id: inboundEventKey,
    detected_intent: classification.primary_intent || null,
    stage_before: clean(classification.stage_hint) || "ownership_check",
    stage_after: clean(selectedTemplate.stage_code || selectedUseCase) || null,
    template_selected: selectedUseCase,
    market: "Minneapolis, MN",
    language: clean(selectedTemplate.language || classification.language) || "English",
    property_address: "123 Internal Proof St",
    property_type: "Single Family",
    seller_first_name: "Internal",
    seller_display_name: "Internal Proof",
    metadata,
  }, {
    supabase,
  });

  if (!result?.ok) {
    throw new Error(`proof queue insert failed: ${result?.reason || "unknown"}`);
  }

  return result;
}

async function patchProofMetadata(table, id, extra = {}) {
  const { data: row, error: fetchError } = await supabase
    .from(table)
    .select("metadata")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw new Error(`${table} metadata fetch failed: ${fetchError.message}`);
  const metadata = {
    ...(row?.metadata && typeof row.metadata === "object" ? row.metadata : {}),
    ...extra,
  };
  const { error } = await supabase
    .from(table)
    .update({ metadata, updated_at: nowIso() })
    .eq("id", id);
  if (error) throw new Error(`${table} proof metadata patch failed: ${error.message}`);
}

function liveRowDeliveryStatus(row = {}) {
  const candidates = [
    row.latest_delivery_status,
    row.delivery_status,
    row.latest_provider_delivery_status,
    row.provider_delivery_status,
    row.latest_message_event_data?.latest_delivery_status,
    row.latest_message_event_data?.delivery_status,
    row.latest_message_event_data?.provider_delivery_status,
    row.auto_reply_status,
    row.queue_status,
  ].map(lower).filter(Boolean);
  return candidates.find((value) => DELIVERY_TERMINAL_OR_SENT.has(value)) || candidates[0] || "";
}

async function fetchLiveThread() {
  const { data, error } = await supabase
    .from("v_inbox_threads_live_v2")
    .select("*")
    .eq("thread_key", TEST_PHONE)
    .limit(1);
  if (error) throw new Error(`v_inbox_threads_live_v2 lookup failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] || null : null;
  if (!row) return null;

  const { data: latestOutbound, error: outboundError } = await supabase
    .from("message_events")
    .select("id,queue_id,delivery_status,provider_delivery_status,raw_carrier_status,delivered_at,failed_at,failure_reason,error_message")
    .eq("thread_key", TEST_PHONE)
    .eq("direction", "outbound")
    .order("event_timestamp", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (outboundError) throw new Error(`live delivery hydration lookup failed: ${outboundError.message}`);
  const delivery = Array.isArray(latestOutbound) ? latestOutbound[0] || null : null;
  if (!delivery) return row;

  return {
    ...row,
    delivery_status: delivery.delivery_status || row.delivery_status,
    latest_delivery_status: delivery.delivery_status || row.latest_delivery_status,
    provider_delivery_status:
      delivery.provider_delivery_status || delivery.raw_carrier_status || row.provider_delivery_status,
    latest_provider_delivery_status:
      delivery.provider_delivery_status || delivery.raw_carrier_status || row.latest_provider_delivery_status,
    latest_delivered_at: delivery.delivered_at || row.latest_delivered_at,
    latest_failed_at: delivery.failed_at || row.latest_failed_at,
    latest_failure_reason:
      delivery.failure_reason || delivery.error_message || row.latest_failure_reason,
    latest_message_event_data: {
      ...(row.latest_message_event_data || {}),
      message_event_id: delivery.id,
      queue_id: delivery.queue_id,
      latest_delivery_status: delivery.delivery_status,
      latest_provider_delivery_status: delivery.provider_delivery_status || delivery.raw_carrier_status || null,
      latest_delivered_at: delivery.delivered_at || null,
      latest_failed_at: delivery.failed_at || null,
      latest_failure_reason: delivery.failure_reason || delivery.error_message || null,
    },
  };
}

async function pollDeliveryStatus(queueRowId, providerSid) {
  const deadline = Date.now() + DELIVERY_POLL_MS;
  let snapshot = null;

  do {
    const [queueRow, outboundEvent] = await Promise.all([
      fetchQueueRow(queueRowId),
      fetchOutboundEvent(queueRowId),
    ]);
    snapshot = { queueRow, outboundEvent };
    const eventStatus = lower(outboundEvent?.delivery_status);
    const queueStatus = lower(queueRow?.queue_status);
    const providerMatches =
      !providerSid || clean(outboundEvent?.provider_message_sid) === clean(providerSid);

    if (
      providerMatches &&
      (["delivered", "failed"].includes(eventStatus) || ["delivered", "failed"].includes(queueStatus))
    ) {
      return snapshot;
    }

    if (Date.now() >= deadline) break;
    await sleep(Math.min(5000, Math.max(1000, deadline - Date.now())));
  } while (Date.now() < deadline);

  return snapshot;
}

async function cancelUnsentProofRow() {
  if (!insertedQueueRowId || sendAttempted) return;
  const row = await fetchQueueRow(insertedQueueRowId).catch(() => null);
  if (!row || clean(row.provider_message_id)) return;
  if (!ACTIVE_QUEUE_STATUSES.includes(lower(row.queue_status))) return;
  await supabase
    .from("send_queue")
    .update({
      queue_status: "cancelled",
      is_locked: false,
      locked_at: null,
      lock_token: null,
      updated_at: nowIso(),
      metadata: {
        ...(row.metadata || {}),
        cancelled_by: PROOF_SOURCE,
        cancelled_at: nowIso(),
        final_queue_status: "cancelled",
      },
    })
    .eq("id", insertedQueueRowId);
}

async function assertNoProofRowsTouchRealSellers(proofKey, queueRowId) {
  const { data: queueRows, error: queueError } = await supabase
    .from("send_queue")
    .select("id,queue_key,to_phone_number,from_phone_number,thread_key,metadata")
    .like("queue_key", `inbound_auto_reply:proof-live:${proofKey}%`);
  if (queueError) throw new Error(`proof send_queue isolation check failed: ${queueError.message}`);

  const { data: events, error: eventError } = await supabase
    .from("message_events")
    .select("id,message_event_key,direction,to_phone_number,from_phone_number,thread_key,queue_id,metadata")
    .or(`message_event_key.like.%${proofKey}%,queue_id.eq.${queueRowId}`);
  if (eventError) throw new Error(`proof message_events isolation check failed: ${eventError.message}`);

  const badQueueRows = (queueRows || []).filter((row) => normalizePhone(row.to_phone_number) !== TEST_PHONE);
  const badEvents = (events || []).filter((row) => {
    const direction = lower(row.direction);
    if (direction === "inbound") return normalizePhone(row.from_phone_number) !== TEST_PHONE;
    if (direction === "outbound") return normalizePhone(row.to_phone_number) !== TEST_PHONE;
    return normalizePhone(row.thread_key) !== TEST_PHONE;
  });

  return {
    ok: badQueueRows.length === 0 && badEvents.length === 0,
    queue_count: queueRows?.length || 0,
    event_count: events?.length || 0,
    bad_queue_count: badQueueRows.length,
    bad_event_count: badEvents.length,
  };
}

async function verifyCompletedProofRecords({
  proofKey,
  queueRowId,
  providerMessageId = null,
  beforeStatus = "queued",
  reused = false,
}) {
  const sentQueueRow = await fetchQueueRow(queueRowId);
  const resolvedProviderMessageId = clean(sentQueueRow?.provider_message_id || providerMessageId);
  mark(
    "queue row moved queued/processing to sent",
    lower(sentQueueRow?.queue_status) === "sent" && Boolean(resolvedProviderMessageId),
    `before=${beforeStatus} after=${sentQueueRow?.queue_status || "missing"} provider=${resolvedProviderMessageId || "missing"}`,
  );

  let outboundEvent = await fetchOutboundEvent(queueRowId);
  hardAssert(outboundEvent, "outbound message_event was not created");
  await patchProofMetadata("message_events", outboundEvent.id, metadataBase(proofKey, {
    outbound_live_send: true,
    provider_message_sid: clean(outboundEvent.provider_message_sid || resolvedProviderMessageId),
    reused_recent_proof: Boolean(reused),
  }));
  await patchProofMetadata("send_queue", queueRowId, metadataBase(proofKey, {
    outbound_live_send: true,
    provider_message_sid: resolvedProviderMessageId,
    final_queue_status: sentQueueRow?.queue_status || null,
    reused_recent_proof: Boolean(reused),
  }));
  outboundEvent = await fetchOutboundEvent(queueRowId);

  mark(
    "message_events outbound row created",
    Boolean(outboundEvent?.id) &&
      lower(outboundEvent.direction) === "outbound" &&
      normalizePhone(outboundEvent.to_phone_number) === TEST_PHONE,
    `id=${outboundEvent?.id || "missing"} direction=${outboundEvent?.direction || "missing"} to=${outboundEvent?.to_phone_number || "missing"}`,
  );
  mark(
    "provider_message_sid/message_id captured",
    clean(outboundEvent.provider_message_sid) === resolvedProviderMessageId &&
      clean(outboundEvent.message_id) === resolvedProviderMessageId,
    `queue_provider=${resolvedProviderMessageId || "missing"} event_sid=${outboundEvent.provider_message_sid || "missing"} event_message_id=${outboundEvent.message_id || "missing"}`,
  );
  mark(
    "outbound proof metadata excludes KPIs",
    outboundEvent.metadata?.proof === true &&
      outboundEvent.metadata?.internal_test_phone === true &&
      outboundEvent.metadata?.exclude_from_kpis === true,
    `proof=${outboundEvent.metadata?.proof} internal=${outboundEvent.metadata?.internal_test_phone} exclude=${outboundEvent.metadata?.exclude_from_kpis}`,
  );

  const deliverySnapshot = await pollDeliveryStatus(queueRowId, resolvedProviderMessageId);
  const deliveryEvent = deliverySnapshot?.outboundEvent || outboundEvent;
  const deliveryQueue = deliverySnapshot?.queueRow || sentQueueRow;
  const eventDeliveryStatus = lower(deliveryEvent?.delivery_status);
  const queueDeliveryStatus = lower(deliveryQueue?.queue_status);
  mark(
    "delivery status is sent/delivered/failed",
    DELIVERY_TERMINAL_OR_SENT.has(eventDeliveryStatus) || DELIVERY_TERMINAL_OR_SENT.has(queueDeliveryStatus),
    `event=${eventDeliveryStatus || "missing"} queue=${queueDeliveryStatus || "missing"}`,
  );
  mark(
    "delivery webhook/reconcile observed terminal update",
    ["delivered", "failed"].includes(eventDeliveryStatus) || ["delivered", "failed"].includes(queueDeliveryStatus),
    `event=${eventDeliveryStatus || "missing"} queue=${queueDeliveryStatus || "missing"}`,
    true,
  );

  await sleep(2000);
  const liveThread = await fetchLiveThread();
  const liveDelivery = liveRowDeliveryStatus(liveThread || {});
  mark(
    "live inbox row shows outbound latest message",
    Boolean(liveThread) &&
      clean(liveThread.latest_message_body).includes(proofKey) &&
      lower(liveThread.latest_message_direction || liveThread.direction) === "outbound",
    liveThread
      ? `direction=${liveThread.latest_message_direction || liveThread.direction || "missing"} latest="${clean(liveThread.latest_message_body).slice(0, 90)}"`
      : "live row missing",
  );
  mark(
    "live row delivery status is sent/delivered/failed",
    DELIVERY_TERMINAL_OR_SENT.has(liveDelivery),
    `live_delivery=${liveDelivery || "missing"}`,
  );

  const isolation = await assertNoProofRowsTouchRealSellers(proofKey, queueRowId);
  mark(
    "no real seller rows touched by proof key",
    isolation.ok,
    `proof_queue_rows=${isolation.queue_count} proof_events=${isolation.event_count} bad_queue=${isolation.bad_queue_count} bad_events=${isolation.bad_event_count}`,
  );

  const activeAfterSend = await fetchActiveAutoReplyRows();
  mark(
    "no active duplicate auto-reply row remains after send",
    activeAfterSend.length === 0,
    `active=${activeAfterSend.length}`,
  );

  const inboundEvent = await fetchInboundProofEvent(proofKey);
  console.log("");
  console.log("Proof records retained and marked internal/proof:");
  console.log(`- inbound_message_event_id=${inboundEvent?.id || insertedInboundEventId || "unknown"}`);
  console.log(`- queue_row_id=${queueRowId}`);
  console.log(`- outbound_message_event_id=${outboundEvent.id}`);
  console.log(`- provider_message_id=${resolvedProviderMessageId}`);
}

async function main() {
  console.log(`Internal-only live auto-reply send proof recipient=${TEST_PHONE}`);
  console.log("No global queue run will be invoked; this proof targets one queue row by id.");

  const normalizedRecipient = normalizePhone(TEST_PHONE);
  hardAssert(normalizedRecipient === TEST_PHONE, "selected recipient is not the locked internal phone", normalizedRecipient);
  hardAssert(isInternalTestPhone(TEST_PHONE), "recipient is not registered as an internal test phone", TEST_PHONE);
  hardAssert(PROOF_FROM_PHONE, "missing proof sender phone");
  hardAssert(
    APPROVED_PROOF_SENDERS.has(PROOF_FROM_PHONE),
    "selected TextGrid sender is not in the approved proof sender allowlist",
    PROOF_FROM_PHONE,
  );

  mark("internal recipient locked", TEST_PHONE === "+16127433952", TEST_PHONE);
  mark("proof sender allowlisted", APPROVED_PROOF_SENDERS.has(PROOF_FROM_PHONE), PROOF_FROM_PHONE);
  mark(
    "explicit live send proof flag checked",
    true,
    LIVE_SEND_PROOF_ENABLED
      ? "AUTO_REPLY_INTERNAL_LIVE_SEND_PROOF_ENABLED=true"
      : "disabled by default; set AUTO_REPLY_INTERNAL_LIVE_SEND_PROOF_ENABLED=true to perform the locked TextGrid send",
  );

  if (!LIVE_SEND_PROOF_ENABLED) {
    console.log("PASS internal live auto-reply proof skipped: live TextGrid send is disabled by default");
    return;
  }

  mark("Supabase URL loaded", Boolean(SUPABASE_URL));
  mark("Supabase service role loaded", Boolean(SUPABASE_SERVICE_ROLE_KEY));
  hardAssert(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY, "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const proofKey = proofToken(10);

  const textgridCredentials = getTextgridSendCredentialStatus();
  mark(
    "TextGrid credentials configured",
    textgridCredentials.configured,
    textgridCredentials.configured ? "account_sid_present=true auth_token_present=true" : `missing=${textgridCredentials.missing.join(",")}`,
  );
  hardAssert(textgridCredentials.configured, "TextGrid send credentials are missing");

  const providerCapabilities = getTextgridProviderCapabilities();
  const queueRunnerEnabled = await getSystemFlag("queue_runner_enabled", { supabase });
  const outboundSmsEnabled = await getSystemFlag("outbound_sms_enabled", { supabase });
  const autoReplyLiveEnabled = await getSystemFlag("auto_reply_live_enabled", { supabase });
  const systemAutoReplyMode = await getSystemValue("auto_reply_mode", { supabase });

  console.log(
    `System flags: queue_runner_enabled=${queueRunnerEnabled} outbound_sms_enabled=${outboundSmsEnabled} auto_reply_live_enabled=${autoReplyLiveEnabled} auto_reply_mode=${systemAutoReplyMode || "unset"}`,
  );
  if (!outboundSmsEnabled) {
    console.warn("WARN outbound_sms_enabled is false; provider send will use the TextGrid internal proof bypass after hard recipient checks.");
    warnings += 1;
  }
  if (providerCapabilities.message_status_lookup?.supported === false) {
    console.warn(`WARN TextGrid status lookup unavailable: ${providerCapabilities.message_status_lookup.reason}`);
    warnings += 1;
  }

  const columns = {
    messageEvents: await fetchColumns("message_events"),
    sendQueue: await fetchColumns("send_queue"),
  };
  const senderRow = await loadApprovedProofSender(PROOF_FROM_PHONE);
  mark("TextGrid proof sender active", Boolean(senderRow), `from=${PROOF_FROM_PHONE} id=${senderRow.id || "unknown"}`);

  const cancelledStale = await cancelStaleProofQueueRows(proofKey);
  if (cancelledStale > 0) {
    console.log(`Cancelled stale active proof queue rows count=${cancelledStale}`);
  }

  const activeBefore = await fetchActiveAutoReplyRows();
  hardAssert(
    activeBefore.length === 0,
    "active duplicate auto-reply queue row exists for internal test phone",
    `count=${activeBefore.length}`,
  );
  mark("no active duplicate auto-reply row before insert", activeBefore.length === 0);

  const recentProof = await fetchRecentCompletedProofSend();
  if (recentProof && process.env.AUTO_REPLY_INTERNAL_LIVE_FORCE_NEW !== "true") {
    const recentProofKey = clean(recentProof.metadata?.proof_key);
    hardAssert(recentProofKey, "recent proof row is missing proof_key", recentProof.id);
    insertedQueueRowId = recentProof.id;
    console.log(`Reusing recent completed proof row to avoid a second TextGrid send queue_row_id=${recentProof.id} proof_key=${recentProofKey}`);
    mark("recent completed proof send found", true, `queue_row_id=${recentProof.id} provider=${recentProof.provider_message_id}`);
    await verifyCompletedProofRecords({
      proofKey: recentProofKey,
      queueRowId: recentProof.id,
      providerMessageId: recentProof.provider_message_id,
      beforeStatus: "sent",
      reused: true,
    });

    if (failures > 0) {
      console.error(`FAIL internal live auto-reply proof failures=${failures} warnings=${warnings}`);
      process.exit(1);
    }

    console.log(`PASS internal live auto-reply proof warnings=${warnings}`);
    return;
  }

  const inboundBody = `${INBOUND_TEXT} [internal live proof ${proofKey}]`;
  const inboundEvent = await insertInboundProofEvent({
    columns: columns.messageEvents,
    proofKey,
    body: inboundBody,
  });
  insertedInboundEventId = inboundEvent.id;
  const inboundEventKey = inboundEvent.message_event_key;
  mark("inbound proof message_event created", Boolean(inboundEvent.id), `id=${inboundEvent.id}`);

  const classification = await classify(INBOUND_TEXT);
  const context = buildContext(proofKey, senderRow);
  const execution = await executeInboundAutomationDecision({
    message: INBOUND_TEXT,
    threadKey: TEST_PHONE,
    propertyId: context.ids.property_id,
    prospectId: null,
    ownerId: null,
    phoneId: null,
    classification,
    latestThreadContext: context,
    context,
    inboundFrom: TEST_PHONE,
    inboundTo: PROOF_FROM_PHONE,
    inboundEventId: inboundEventKey,
    enableQueueInsert: false,
    applySuppression: false,
    dryRun: false,
    autoReplyMode: AUTOMATION_MODE,
    proofRun: false,
    scheduleDelaySeconds: 0,
    supabaseClient: supabase,
  });

  const selectedTemplateId = clean(
    execution.selected_template?.template_id || execution.selected_template?.id,
  );
  const renderedText = clean(execution.rendered_message_text);
  const gatesOpen = automationGatesAreOpen(execution, classification);
  const selectedTemplateExists = Boolean(selectedTemplateId);

  mark(
    "guarded automation classified ownership reply",
    classification.primary_intent === "ownership_confirmed",
    `intent=${classification.primary_intent || "missing"} confidence=${classification.confidence ?? "n/a"}`,
  );
  mark(
    "guarded automation mode is internal-only",
    execution.auto_reply_mode === AUTOMATION_MODE && execution.queue_permission?.internal_test_phone === true,
    `mode=${execution.auto_reply_mode || "missing"} permission=${execution.queue_permission?.reason || "missing"}`,
  );
  mark(
    "selected safe auto-reply template exists",
    selectedTemplateExists,
    `template=${selectedTemplateId || "missing"}`,
  );
  mark(
    "automation gates are open",
    gatesOpen,
    `audit=${execution.audit_reason || "missing"} suppress=${execution.automation_decision?.should_suppress_contact} review=${execution.automation_decision?.should_mark_human_review}`,
  );
  mark("rendered message exists", Boolean(renderedText), `chars=${renderedText.length}`);

  hardAssert(selectedTemplateExists, "selected template missing");
  hardAssert(gatesOpen, "automation safety gates are not all open");
  hardAssert(renderedText, "rendered auto-reply text missing");

  const queueInsert = await createRunnableProofQueueRow({
    proofKey,
    inboundEventKey,
    classification,
    execution,
    senderRow,
  });
  insertedQueueRowId = queueInsert.queue_row_id;
  const queuedRow = await fetchQueueRow(insertedQueueRowId);
  hardAssert(queuedRow, "inserted proof queue row missing");
  hardAssert(normalizePhone(queuedRow.to_phone_number) === TEST_PHONE, "selected to_phone_number is not +16127433952", queuedRow.to_phone_number);
  hardAssert(isInternalTestPhone(queuedRow.to_phone_number), "proof queue recipient is not internal", queuedRow.to_phone_number);

  mark(
    "exactly one proof runnable queue row created",
    lower(queuedRow.queue_status) === "queued" &&
      queuedRow.metadata?.proof === true &&
      queuedRow.metadata?.no_send === false &&
      queuedRow.sms_eligible === true &&
      queuedRow.routing_allowed === true,
    `id=${queuedRow.id} status=${queuedRow.queue_status} proof=${queuedRow.metadata?.proof} sms_eligible=${queuedRow.sms_eligible} routing_allowed=${queuedRow.routing_allowed}`,
  );
  mark("selected to_phone_number hard locked", normalizePhone(queuedRow.to_phone_number) === TEST_PHONE, queuedRow.to_phone_number);
  mark("queue row uses approved proof sender", normalizePhone(queuedRow.from_phone_number) === PROOF_FROM_PHONE, queuedRow.from_phone_number);

  const activeAfterInsert = await fetchActiveAutoReplyRows();
  hardAssert(
    activeAfterInsert.length === 1 && String(activeAfterInsert[0].id) === String(insertedQueueRowId),
    "active duplicate check after insert did not find exactly this proof row",
    `count=${activeAfterInsert.length}`,
  );

  let textgridCallCount = 0;
  const guardedSendTextgridSMS = async ({ to, from, body, seller_first_name = null }) => {
    textgridCallCount += 1;
    sendAttempted = true;
    const normalizedTo = normalizePhone(to);
    const normalizedFrom = normalizePhone(from);
    hardAssert(textgridCallCount === 1, "targeted runner attempted more than one TextGrid send", `count=${textgridCallCount}`);
    hardAssert(normalizedTo === TEST_PHONE, "TextGrid send recipient is not the internal test phone", normalizedTo || clean(to));
    hardAssert(isInternalTestPhone(normalizedTo), "TextGrid send recipient is not internal", normalizedTo);
    hardAssert(normalizedFrom === PROOF_FROM_PHONE, "TextGrid send sender is not the approved proof sender", normalizedFrom || clean(from));
    hardAssert(clean(body).includes(proofKey), "TextGrid send body does not include proof key");

    return sendTextgridSMS({
      to: normalizedTo,
      from: normalizedFrom,
      body,
      seller_first_name,
      client_reference_id: queuedRow.queue_key,
      bypass_system_control: true,
      bypass_reason: PROOF_SOURCE,
    });
  };

  const guardedEvaluateContactWindow = (row = {}) => {
    hardAssert(row?.metadata?.proof === true, "contact-window proof override saw non-proof row");
    hardAssert(normalizePhone(row?.to_phone_number) === TEST_PHONE, "contact-window proof override saw non-internal recipient");
    return {
      allowed: true,
      reason: "internal_live_proof_targeted_runner",
      timezone: "America/Chicago",
      valid_window: true,
    };
  };

  const runnerNow = nowIso();
  const runnerResult = await processSendQueue({
    queue_row_id: insertedQueueRowId,
  }, {
    supabaseClient: supabase,
    now: runnerNow,
    processing_run_id: `proof-${proofKey}`,
    run_started_at: runnerNow,
    evaluateContactWindow: guardedEvaluateContactWindow,
    sendTextgridSMS: guardedSendTextgridSMS,
  });

  mark(
    "targeted queue runner processed exactly one row",
    textgridCallCount === 1 && String(runnerResult.queue_row_id || runnerResult.queue_item_id) === String(insertedQueueRowId),
    `calls=${textgridCallCount} result_queue=${runnerResult.queue_row_id || runnerResult.queue_item_id || "missing"}`,
  );
  mark(
    "targeted runner result sent",
    runnerResult.sent === true && clean(runnerResult.provider_message_id),
    `sent=${runnerResult.sent} provider=${runnerResult.provider_message_id || "missing"} status=${runnerResult.final_queue_status || runnerResult.queue_status || "missing"}`,
  );

  await verifyCompletedProofRecords({
    proofKey,
    queueRowId: insertedQueueRowId,
    providerMessageId: runnerResult.provider_message_id,
    beforeStatus: queuedRow.queue_status,
  });

  if (failures > 0) {
    console.error(`FAIL internal live auto-reply proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }

  console.log(`PASS internal live auto-reply proof warnings=${warnings}`);
}

main()
  .catch(async (error) => {
    try {
      await cancelUnsentProofRow();
    } catch {}
    console.error("FAIL internal live auto-reply proof crashed", error?.stack || error?.message || error);
    process.exit(1);
  });
