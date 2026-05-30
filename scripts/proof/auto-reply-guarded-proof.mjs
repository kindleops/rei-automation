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
const OUR_NUMBER = "+16128060495";
const PROOF_SOURCE = "auto-reply-guarded-proof";
const KEEP_ROWS = ["1", "true", "yes"].includes(
  String(process.env.AUTO_REPLY_PROOF_KEEP_ROWS || "").toLowerCase(),
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

process.chdir(API_ROOT);

register(
  pathToFileURL(path.join(API_ROOT, "tests/alias-loader.mjs")).href,
  pathToFileURL(`${API_ROOT}/`),
);

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(
  SUPABASE_URL || "https://placeholder.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY || "placeholder",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { classify } = await import(
  pathToFileURL(path.join(API_ROOT, "src/lib/domain/classification/classify.js")).href
);
const { executeInboundAutomationDecision } = await import(
  pathToFileURL(path.join(API_ROOT, "src/lib/domain/seller-flow/apply-inbound-automation-decision.js")).href
);

let failures = 0;
let warnings = 0;
const cleanup = {
  staleMessageEvents: 0,
  staleQueueRows: 0,
  messageEvents: 0,
  queueRows: 0,
  kept: KEEP_ROWS,
  errors: [],
};

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
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

function filterPayload(columns, payload) {
  if (!columns?.size) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => columns.has(key)));
}

function metadataBase(proofKey, caseKey, mode, extra = {}) {
  return {
    internal_test: true,
    proof: true,
    proof_key: proofKey,
    proof_source: PROOF_SOURCE,
    proof_case: caseKey,
    auto_reply_mode: mode,
    exclude_from_kpis: true,
    no_send: true,
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

async function deleteStaleProofRows() {
  const { data: messageRows, error: messageError } = await supabase
    .from("message_events")
    .delete()
    .eq("thread_key", TEST_PHONE)
    .eq("trigger_name", PROOF_SOURCE)
    .like("message_event_key", "proof:auto-reply:%")
    .select("id");
  if (messageError) throw new Error(`stale message_events cleanup failed: ${messageError.message}`);
  cleanup.staleMessageEvents = messageRows?.length || 0;

  const { data: queueRows, error: queueError } = await supabase
    .from("send_queue")
    .delete()
    .eq("thread_key", TEST_PHONE)
    .or("queue_key.like.inbound_auto_reply:proof:auto-reply:%,queue_key.like.proof:auto-reply:%")
    .select("id");
  if (queueError) throw new Error(`stale send_queue cleanup failed: ${queueError.message}`);
  cleanup.staleQueueRows = queueRows?.length || 0;
}

async function insertInboundEvent({ columns, proofKey, caseKey, mode, body, eventAt }) {
  const providerSid = `proof-auto-reply-${proofKey}-${caseKey}-${mode}`;
  const payload = filterPayload(columns, {
    message_event_key: `proof:auto-reply:${proofKey}:${caseKey}:${mode}`,
    provider_message_sid: providerSid,
    message_id: providerSid,
    direction: "inbound",
    event_type: "internal_auto_reply_proof",
    type: "internal_test_proof",
    thread_key: TEST_PHONE,
    from_phone_number: TEST_PHONE,
    to_phone_number: OUR_NUMBER,
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
    processed_by: "internal_test_proof",
    safety_status: "proof",
    priority: "normal",
    risk: "low",
    routing_allowed: false,
    metadata: metadataBase(proofKey, caseKey, mode, { provider_message_sid: providerSid }),
  });

  const { data, error } = await supabase
    .from("message_events")
    .insert(payload)
    .select("id,message_event_key,metadata")
    .single();
  if (error) throw new Error(`message_events insert failed ${caseKey}/${mode}: ${error.message}`);
  return data;
}

async function updateInboundDiagnostics({
  columns,
  eventId,
  proofKey,
  caseKey,
  mode,
  classification,
  execution,
}) {
  const decision = execution?.automation_decision || null;
  const selectedTemplate = execution?.selected_template || null;
  const queueId = execution?.queue_row_id || execution?.queue_item_id || null;
  const autoReplyStatus = execution?.queued
    ? "queued"
    : decision?.should_suppress_contact
      ? "suppressed"
      : decision?.should_mark_human_review
        ? "human_review_required"
        : execution?.rendered_message_text
          ? "dry_run"
          : "no_reply";

  const patch = filterPayload(columns, {
    updated_at: nowIso(),
    detected_intent: classification.primary_intent,
    classification_confidence: classification.confidence,
    auto_reply_status: autoReplyStatus,
    auto_reply_queue_id: queueId,
    safety_status:
      decision?.should_suppress_contact ? "suppressed" :
      decision?.should_mark_human_review ? "review" :
      execution?.queued ? "proof" : "dry_run",
    routing_allowed: Boolean(decision?.should_queue_reply && !decision?.should_suppress_contact),
    metadata: metadataBase(proofKey, caseKey, mode, {
      classification,
      automation_decision: decision,
      human_review_required: Boolean(decision?.should_mark_human_review),
      auto_reply_status: autoReplyStatus,
      auto_reply_queue_id: queueId,
      selected_template_id: selectedTemplate?.template_id || selectedTemplate?.id || null,
      selected_template_use_case: selectedTemplate?.use_case || null,
      selected_template_stage: selectedTemplate?.stage_code || null,
      rendered_message_preview: clean(execution?.rendered_message_text).slice(0, 220) || null,
      dry_run: Boolean(execution?.dry_run),
      queued: Boolean(execution?.queued),
      duplicate_suppressed: Boolean(execution?.duplicate_suppressed),
    }),
  });

  const { data, error } = await supabase
    .from("message_events")
    .update(patch)
    .eq("id", eventId)
    .select("id,auto_reply_status,auto_reply_queue_id,metadata")
    .single();
  if (error) throw new Error(`message_events diagnostic update failed: ${error.message}`);
  return data;
}

function buildContext(proofKey) {
  return {
    found: true,
    ids: {
      thread_key: TEST_PHONE,
      property_id: `900${proofKey.replace(/\D/g, "").slice(0, 6) || "123456"}`,
      master_owner_id: null,
      prospect_id: null,
      phone_item_id: null,
      textgrid_number_id: null,
    },
    summary: {
      property_address: "123 Proof St",
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
    },
    items: {},
    recent: {},
  };
}

async function runAutomationCase({
  columns,
  proofKey,
  testCase,
  mode,
  offsetMs,
}) {
  const body = `${testCase.text} [proof ${proofKey} ${testCase.key} ${mode}]`;
  const event = await insertInboundEvent({
    columns: columns.messageEvents,
    proofKey,
    caseKey: testCase.key,
    mode,
    body,
    eventAt: nowIso(offsetMs),
  });
  const sourceEventId = `proof:auto-reply:${proofKey}:${testCase.key}:${mode}`;
  const classification = await classify(testCase.text);
  const context = buildContext(proofKey);
  const execution = await executeInboundAutomationDecision({
    message: testCase.text,
    threadKey: TEST_PHONE,
    propertyId: context.ids.property_id,
    prospectId: null,
    ownerId: null,
    phoneId: null,
    classification,
    latestThreadContext: context,
    context,
    inboundFrom: TEST_PHONE,
    inboundTo: OUR_NUMBER,
    inboundEventId: sourceEventId,
    enableQueueInsert: mode === "internal_only",
    applySuppression: false,
    dryRun: mode === "dry_run",
    autoReplyMode: mode,
    proofRun: true,
    scheduleDelaySeconds: 86_400,
    supabaseClient: supabase,
  });

  const diagnostic = await updateInboundDiagnostics({
    columns: columns.messageEvents,
    eventId: event.id,
    proofKey,
    caseKey: testCase.key,
    mode,
    classification,
    execution,
  });

  return { event, sourceEventId, classification, execution, diagnostic };
}

async function fetchQueueRows(sourceEventId) {
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_key,queue_status,type,thread_key,to_phone_number,from_phone_number,provider_message_id,metadata,source_event_id,use_case_template,current_stage,selected_template_id")
    .eq("source_event_id", sourceEventId);
  if (error) throw new Error(`send_queue lookup failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

async function fetchLiveThread() {
  const { data, error } = await supabase
    .from("v_inbox_threads_live_v2")
    .select("thread_key,canonical_thread_key,latest_message_body,latest_message_direction,auto_reply_status,detected_intent,inbox_bucket,latest_message_event_data")
    .eq("thread_key", TEST_PHONE)
    .limit(1);
  if (error) {
    warnings += 1;
    console.warn(`WARN inbox live view lookup failed ${error.message}`);
    return null;
  }
  return Array.isArray(data) ? data[0] || null : null;
}

async function insertActiveDuplicateGuard({ columns, proofKey }) {
  const queueKey = `proof:auto-reply:${proofKey}:duplicate-active`;
  const body = `Internal proof duplicate guard ${proofKey}`;
  const payload = filterPayload(columns.sendQueue, {
    queue_key: queueKey,
    queue_id: queueKey,
    queue_status: "queued",
    type: "auto_reply",
    thread_key: TEST_PHONE,
    to_phone_number: TEST_PHONE,
    from_phone_number: OUR_NUMBER,
    message_body: body,
    message_text: body,
    character_count: body.length,
    scheduled_for: nowIso(365 * 24 * 60 * 60 * 1000),
    scheduled_for_utc: nowIso(365 * 24 * 60 * 60 * 1000),
    scheduled_for_local: nowIso(365 * 24 * 60 * 60 * 1000),
    sms_eligible: false,
    routing_allowed: false,
    safety_status: "proof_duplicate_guard",
    selected_template_id: "proof-duplicate",
    template_id: "proof-duplicate",
    use_case_template: "consider_selling",
    source_event_id: `proof:auto-reply:${proofKey}:duplicate-active-source`,
    created_at: nowIso(),
    updated_at: nowIso(),
    metadata: metadataBase(proofKey, "duplicate_guard", "internal_only", {
      active_duplicate_guard: true,
      no_send: true,
    }),
  });

  const { data, error } = await supabase
    .from("send_queue")
    .insert(payload)
    .select("id,queue_key")
    .single();
  if (error) throw new Error(`duplicate guard insert failed: ${error.message}`);
  return data;
}

async function cleanupProofRows({ messageEventIds, queueRowIds }) {
  if (KEEP_ROWS) return;

  if (messageEventIds.length) {
    const { data, error } = await supabase
      .from("message_events")
      .delete()
      .in("id", messageEventIds)
      .select("id");
    if (error) cleanup.errors.push(`message_events:${error.message}`);
    else cleanup.messageEvents = data?.length || 0;
  }

  if (queueRowIds.length) {
    const { data, error } = await supabase
      .from("send_queue")
      .delete()
      .in("id", queueRowIds)
      .select("id");
    if (error) cleanup.errors.push(`send_queue:${error.message}`);
    else cleanup.queueRows = data?.length || 0;
  }
}

const CASES = [
  {
    key: "own",
    text: "Yes I still own it",
    expectedIntent: "ownership_confirmed",
    expectedRoute: "consider_selling",
    shouldQueue: true,
  },
  {
    key: "offer",
    text: "How much would you offer?",
    expectedIntent: "asks_offer",
    expectedRoute: "ask_seller_price_or_basic_condition",
    shouldQueue: true,
  },
  {
    key: "stop",
    text: "Stop texting me",
    expectedIntent: "opt_out",
    shouldQueue: false,
    expectedSuppression: "opt_out",
  },
  {
    key: "wrong",
    text: "Wrong number",
    expectedIntent: "wrong_number",
    shouldQueue: false,
    expectedSuppression: "wrong_number",
  },
  {
    key: "address",
    text: "I'm interested but what address?",
    expectedIntent: "info_request",
    expectedRoute: "info_request",
    shouldQueue: true,
  },
];

async function main() {
  console.log(`Guarded auto-reply proof phone=${TEST_PHONE}`);
  console.log("No TextGrid call will be made; queue rows are proof/no_send rows only.");

  mark("Supabase URL loaded", Boolean(SUPABASE_URL));
  mark("Supabase service role loaded", Boolean(SUPABASE_SERVICE_ROLE_KEY));
  mark("internal test phone locked", TEST_PHONE === "+16127433952", TEST_PHONE);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const proofKey = proofToken(10);
  const messageEventIds = [];
  const queueRowIds = [];
  const columns = {
    messageEvents: await fetchColumns("message_events"),
    sendQueue: await fetchColumns("send_queue"),
  };

  try {
    await deleteStaleProofRows();
    if (cleanup.staleMessageEvents || cleanup.staleQueueRows) {
      console.log(
        `Preflight cleanup stale proof rows message_events=${cleanup.staleMessageEvents} send_queue=${cleanup.staleQueueRows}`,
      );
    }

    let offset = 1_000;
    for (const testCase of CASES) {
      console.log(`\nCASE ${testCase.key}: ${testCase.text}`);

      const dryRun = await runAutomationCase({
        columns,
        proofKey,
        testCase,
        mode: "dry_run",
        offsetMs: offset,
      });
      offset += 1_000;
      messageEventIds.push(dryRun.event.id);
      const dryQueueRows = await fetchQueueRows(dryRun.sourceEventId);

      mark(
        `${testCase.key} dry_run classification`,
        dryRun.classification.primary_intent === testCase.expectedIntent,
        `intent=${dryRun.classification.primary_intent} confidence=${dryRun.classification.confidence}`,
      );
      mark(
        `${testCase.key} dry_run decision`,
        Boolean(dryRun.execution.automation_decision),
        `decision=${dryRun.execution.audit_reason}`,
      );
      mark(
        `${testCase.key} dry_run no queue row`,
        dryQueueRows.length === 0 && dryRun.execution.queued === false,
        `queue_rows=${dryQueueRows.length}`,
      );

      if (testCase.shouldQueue) {
        mark(
          `${testCase.key} dry_run selected safe template`,
          Boolean(dryRun.execution.selected_template?.template_id || dryRun.execution.selected_template?.id),
          `template=${dryRun.execution.selected_template?.template_id || dryRun.execution.selected_template?.id || "missing"} use_case=${dryRun.execution.selected_template?.use_case || "missing"} stage=${dryRun.execution.selected_template?.stage_code || "missing"}`,
        );
        mark(
          `${testCase.key} dry_run route`,
          dryRun.execution.automation_decision?.route_hint === testCase.expectedRoute,
          `route=${dryRun.execution.automation_decision?.route_hint || "missing"}`,
        );
      }

      const internal = await runAutomationCase({
        columns,
        proofKey,
        testCase,
        mode: "internal_only",
        offsetMs: offset,
      });
      offset += 1_000;
      messageEventIds.push(internal.event.id);
      const internalQueueRows = await fetchQueueRows(internal.sourceEventId);
      for (const row of internalQueueRows) queueRowIds.push(row.id);

      mark(
        `${testCase.key} internal_only queue policy`,
        testCase.shouldQueue
          ? internal.execution.queued === true && internalQueueRows.length === 1
          : internal.execution.queued === false && internalQueueRows.length === 0,
        `queued=${internal.execution.queued} queue_rows=${internalQueueRows.length} reason=${internal.execution.audit_reason}`,
      );

      if (testCase.shouldQueue) {
        const row = internalQueueRows[0] || {};
        mark(
          `${testCase.key} proof queue row is non-runnable/no_send`,
          lower(row.queue_status) === "proof" &&
            row.metadata?.proof === true &&
            row.metadata?.no_send === true &&
            row.to_phone_number === TEST_PHONE,
          `status=${row.queue_status || "missing"} to=${row.to_phone_number || "missing"}`,
        );
      } else {
        mark(
          `${testCase.key} blocked reason`,
          testCase.expectedSuppression
            ? internal.execution.automation_decision?.suppression_reason === testCase.expectedSuppression
            : internal.execution.automation_decision?.should_mark_human_review === true,
          `suppression=${internal.execution.automation_decision?.suppression_reason || "none"} review=${internal.execution.automation_decision?.should_mark_human_review}`,
        );
      }

      const diagnostic = internal.diagnostic?.metadata || {};
      mark(
        `${testCase.key} message_event diagnostics`,
        diagnostic.auto_reply_status &&
          diagnostic.automation_decision &&
          Object.prototype.hasOwnProperty.call(diagnostic, "human_review_required"),
        `status=${diagnostic.auto_reply_status || "missing"} queue=${diagnostic.auto_reply_queue_id || "none"}`,
      );

      const liveThread = await fetchLiveThread();
      mark(
        `${testCase.key} inbox row updates`,
        !liveThread || clean(liveThread.latest_message_body).includes(`[proof ${proofKey} ${testCase.key} internal_only]`),
        liveThread
          ? `latest="${clean(liveThread.latest_message_body).slice(0, 90)}" auto_reply_status=${liveThread.auto_reply_status || "none"}`
          : "live view unavailable",
        !liveThread,
      );
    }

    const duplicateGuard = await insertActiveDuplicateGuard({ columns, proofKey });
    queueRowIds.push(duplicateGuard.id);
    const duplicateCase = await runAutomationCase({
      columns,
      proofKey,
      testCase: { ...CASES[0], key: "own_duplicate" },
      mode: "internal_only",
      offsetMs: offset,
    });
    messageEventIds.push(duplicateCase.event.id);
    mark(
      "existing active auto-reply row blocks duplicate",
      duplicateCase.execution.duplicate_suppressed === true &&
        duplicateCase.execution.queued === false &&
        duplicateCase.execution.audit_reason === "recent_thread_duplicate",
      `audit=${duplicateCase.execution.audit_reason} duplicate=${duplicateCase.execution.duplicate_suppressed}`,
    );

    const { data: outboundEvents, error: outboundError } = await supabase
      .from("message_events")
      .select("id")
      .eq("thread_key", TEST_PHONE)
      .eq("trigger_name", PROOF_SOURCE)
      .eq("direction", "outbound");
    if (outboundError) throw new Error(`outbound proof event check failed: ${outboundError.message}`);
    mark("no TextGrid/outbound message_events created", (outboundEvents || []).length === 0, `outbound_events=${(outboundEvents || []).length}`);

    await cleanupProofRows({ messageEventIds, queueRowIds });
    mark(
      "cleanup completed",
      KEEP_ROWS || (
        cleanup.errors.length === 0 &&
        cleanup.messageEvents === messageEventIds.length &&
        cleanup.queueRows === queueRowIds.length
      ),
      KEEP_ROWS
        ? "kept rows by AUTO_REPLY_PROOF_KEEP_ROWS=true"
        : `message_events=${cleanup.messageEvents}/${messageEventIds.length} send_queue=${cleanup.queueRows}/${queueRowIds.length} errors=${cleanup.errors.join("|") || "none"}`,
    );
  } finally {
    if (!KEEP_ROWS) {
      if (messageEventIds.length) {
        try {
          await supabase.from("message_events").delete().in("id", messageEventIds);
        } catch {}
      }
      if (queueRowIds.length) {
        try {
          await supabase.from("send_queue").delete().in("id", queueRowIds);
        } catch {}
      }
    }
  }

  console.log("");
  console.log(`Cleanup status: kept=${cleanup.kept} staleMessageEvents=${cleanup.staleMessageEvents} staleQueueRows=${cleanup.staleQueueRows} messageEvents=${cleanup.messageEvents} queueRows=${cleanup.queueRows} errors=${cleanup.errors.join("|") || "none"}`);

  if (failures > 0) {
    console.error(`FAIL guarded auto-reply proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS guarded auto-reply proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL guarded auto-reply proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
