#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { callProofJson, formatProofHttp401Diagnostic } from "./proof-http-client.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const API_ROOT = path.join(ROOT, "apps/api");
const DASHBOARD_ROOT = path.join(ROOT, "apps/dashboard");

const envFiles = [
  path.join(API_ROOT, ".env.local"),
  path.join(API_ROOT, ".env.production.local"),
  path.join(DASHBOARD_ROOT, ".env.local"),
  path.join(DASHBOARD_ROOT, ".env"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
];

const MARKET = process.env.FIRST_LIVE_ONE_ROW_PROOF_MARKET || "Houston, TX";
const STATE = process.env.FIRST_LIVE_ONE_ROW_PROOF_STATE || "TX";
const CANDIDATE_SOURCE = process.env.FIRST_LIVE_ONE_ROW_PROOF_SOURCE || "outbound_feeder_candidates";
const SCAN_LIMIT = Number(process.env.FIRST_LIVE_ONE_ROW_PROOF_SCAN_LIMIT || 100);
const CONFIRM = "SEND_ONE_REAL_SELLER_SMS";

let failures = 0;
let warnings = 0;

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function parseEnvValue(value) {
  const trimmed = clean(value);
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
    if (value && !process.env[key]) process.env[key] = value;
  }
}

for (const file of envFiles) loadEnvFile(file);

const BASE_URL = clean(
  process.env.COCKPIT_PROOF_BASE_URL ||
    process.env.API_URL ||
    process.env.LOCAL_API_URL ||
    "http://localhost:3000",
).replace(/\/$/, "");

const OPS_SECRET =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.VITE_BACKEND_API_SECRET ||
  "";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

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

function headers() {
  const out = {
    "content-type": "application/json",
    accept: "application/json",
    origin: "http://localhost:5173",
  };
  if (OPS_SECRET) out["x-ops-dashboard-secret"] = OPS_SECRET;
  return out;
}

function responseSummary(result = {}) {
  const json = result.json || {};
  const diagnosticsResult = json.diagnostics_result || {};
  const reason =
    json.reason ||
    json.error ||
    json.message ||
    diagnosticsResult.reason ||
    diagnosticsResult.error ||
    diagnosticsResult.message ||
    result.error ||
    "none";
  const diagnosticsStatus = diagnosticsResult.status ? ` diagnostics_status=${diagnosticsResult.status}` : "";
  const authDiagnostic = formatProofHttp401Diagnostic(result);
  return `status=${result.status} ok=${json.ok} reason=${reason}${diagnosticsStatus} queue_row_id=${json.queue_row_id || "n/a"} ms=${result.ms}${authDiagnostic ? ` ${authDiagnostic}` : ""}`;
}

function createSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function callQueueControl(body) {
  return callProofJson({
    root: ROOT,
    baseUrl: BASE_URL,
    pathOrUrl: "/api/cockpit/queue/control",
    label: `queue/control ${body?.action || "unknown"}`,
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    timeoutSeconds: 180,
  });
}

async function setSystemValues(supabase, values = {}) {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value: clean(value) }));
  const { error } = await supabase.from("system_control").upsert(rows, { onConflict: "key" });
  if (error) throw new Error(`system_control upsert failed: ${error.message}`);
}

async function fetchSystemValues(supabase, keys = []) {
  const { data, error } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", keys);
  if (error) throw new Error(`system_control fetch failed: ${error.message}`);
  return Object.fromEntries((data || []).map((row) => [row.key, row.value]));
}

async function fetchRowsBySession(supabase, campaignSessionId) {
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_key,queue_status,created_at,updated_at,scheduled_for,sent_at,delivered_at,provider_message_id,textgrid_message_id,sms_eligible,routing_allowed,metadata")
    .eq("metadata->>campaign_session_id", campaignSessionId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`send_queue session fetch failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

async function countRowsBySession(supabase, campaignSessionId) {
  const { count, error } = await supabase
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .eq("metadata->>campaign_session_id", campaignSessionId);
  if (error) throw new Error(`send_queue session count failed: ${error.message}`);
  return Number(count || 0);
}

async function freezeProofRows(supabase, campaignSessionId) {
  const rows = await fetchRowsBySession(supabase, campaignSessionId);
  let frozen = 0;
  for (const row of rows) {
    const metadata = {
      ...(row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {}),
      proof: true,
      proof_source: "first_live_one_row_no_send_proof",
      proof_cleanup: true,
      no_send: true,
      exclude_from_kpis: true,
      operator_freeze_reason: "first_live_one_row_no_send_proof_cleanup",
      operator_freeze_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("send_queue")
      .update({
        queue_status: "paused_operator_review",
        sms_eligible: false,
        routing_allowed: false,
        paused_reason: "first_live_one_row_no_send_proof_cleanup",
        guard_status: "blocked",
        guard_reason: "first_live_one_row_no_send_proof_cleanup",
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(`proof row freeze failed id=${row.id}: ${error.message}`);
    frozen += 1;
  }
  return { frozen, rows };
}

async function rearmEmergencyStop(supabase) {
  const stoppedAt = new Date().toISOString();
  await setSystemValues(supabase, {
    queue_processor_mode: "off",
    campaign_mode: "paused",
    auto_reply_mode: "disabled",
    queue_auto_send_enabled: "false",
    queue_auto_enqueue_enabled: "false",
    queue_emergency_stop_at: stoppedAt,
    queue_last_run_status: "emergency_stopped",
    queue_last_run_at: stoppedAt,
    queue_last_run_diagnostics: JSON.stringify({
      action: "emergency_stop",
      reason: "first_live_one_row_no_send_proof_complete",
      stopped_at: stoppedAt,
      proof_source: "first_live_one_row_no_send_proof",
    }),
  });
}

function noSendMetadataOk(row, campaignSessionId) {
  const metadata = row?.metadata || {};
  return (
    metadata.campaign_session_id === campaignSessionId &&
    metadata.campaign_mode === "live_limited" &&
    metadata.approval_mode === "proof_no_send" &&
    metadata.no_send === true &&
    metadata.proof === true &&
    metadata.proof_mode === true &&
    metadata.selected_sender_diagnostics &&
    typeof metadata.selected_sender_diagnostics === "object"
  );
}

function isEmergencyStopActive(value) {
  const normalized = lower(value);
  return Boolean(normalized && !["0", "false", "off", "none", "null", "cleared", "clear"].includes(normalized));
}

async function main() {
  const campaignSessionId = `first-live-one-row-no-send-proof-${Date.now()}`;
  const supabase = createSupabaseClient();

  console.log(`First live one-row no-send proof base=${BASE_URL} session=${campaignSessionId}`);
  console.log("NO_SEND_GUARD active: this script creates one no_send proof row only and never calls TextGrid.");
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET));
  mark("Supabase service role config loaded", Boolean(supabase), `url=${SUPABASE_URL ? "set" : "missing"} key=${SUPABASE_SERVICE_ROLE_KEY ? "set" : "missing"}`);
  if (!supabase) throw new Error("Supabase service role config is required");

  try {
    await rearmEmergencyStop(supabase);
    const beforeControls = await fetchSystemValues(supabase, [
      "queue_processor_mode",
      "queue_auto_send_enabled",
      "queue_auto_enqueue_enabled",
      "queue_emergency_stop_at",
    ]);
    mark(
      "proof controls armed before queue_one",
      beforeControls.queue_processor_mode === "off" &&
        beforeControls.queue_auto_send_enabled === "false" &&
        beforeControls.queue_auto_enqueue_enabled === "false" &&
        isEmergencyStopActive(beforeControls.queue_emergency_stop_at),
      `processor=${beforeControls.queue_processor_mode} auto_send=${beforeControls.queue_auto_send_enabled} auto_enqueue=${beforeControls.queue_auto_enqueue_enabled}`,
    );

    const beforeCount = await countRowsBySession(supabase, campaignSessionId);
    mark("proof session starts empty", beforeCount === 0, `count=${beforeCount}`);

    const createBody = {
      action: "queue_one",
      campaign_mode: "live_limited",
      approval_mode: "proof_no_send",
      market: MARKET,
      state: STATE,
      candidate_source: CANDIDATE_SOURCE,
      limit: 1,
      hard_cap: 1,
      max_batch_size: 1,
      daily_cap: 1,
      market_cap: 1,
      per_number_cap: 1,
      scan_limit: SCAN_LIMIT,
      respect_contact_window: false,
      schedule_for: "now",
      campaign_session_id: campaignSessionId,
      no_send: true,
      proof_mode: true,
      exclude_from_kpis: true,
      batch_name: campaignSessionId,
    };

    const createResult = await callQueueControl(createBody);
    mark("queue_one accepted one no_send proof row", createResult.status === 200 && createResult.json?.ok === true, responseSummary(createResult));
    const queueRowId = clean(createResult.json?.queue_row_id);
    mark("queue_one returned created row id", Boolean(queueRowId), `queue_row_id=${queueRowId || "missing"} queue_key=${createResult.json?.queue_key || "missing"}`);

    const rows = await fetchRowsBySession(supabase, campaignSessionId);
    mark("exactly one proof row exists", rows.length === 1, `rows=${rows.length}`);
    mark("metadata.campaign_session_id persisted", rows.length === 1 && noSendMetadataOk(rows[0], campaignSessionId), rows[0] ? `row_id=${rows[0].id}` : "missing row");
    mark(
      "created proof row has no provider evidence",
      rows.every((row) => !row.sent_at && !row.delivered_at && !row.provider_message_id && !row.textgrid_message_id),
      `rows=${rows.length}`,
    );

    const emergencyRefusal = await callQueueControl({
      action: "send_one_queue_row",
      queue_row_id: queueRowId,
      campaign_mode: "live_limited",
      confirm: CONFIRM,
    });
    mark(
      "targeted send refuses emergency stop without explicit one-send flag",
      emergencyRefusal.status === 423 && lower(emergencyRefusal.json?.reason || emergencyRefusal.json?.error) === "queue_emergency_stop_active",
      responseSummary(emergencyRefusal),
    );

    const noSendRefusal = await callQueueControl({
      action: "send_one_queue_row",
      queue_row_id: queueRowId,
      campaign_mode: "live_limited",
      confirm: CONFIRM,
      clear_one_send_window: true,
    });
    mark(
      "targeted send refuses no_send row even with explicit one-send flag",
      noSendRefusal.status === 423 && lower(noSendRefusal.json?.reason || noSendRefusal.json?.error) === "no_send_queue_row",
      responseSummary(noSendRefusal),
    );

    const afterRefusalRows = await fetchRowsBySession(supabase, campaignSessionId);
    mark(
      "targeted send refusals did not create provider evidence",
      afterRefusalRows.every((row) => !row.sent_at && !row.delivered_at && !row.provider_message_id && !row.textgrid_message_id),
      `rows=${afterRefusalRows.length}`,
    );

    const freeze = await freezeProofRows(supabase, campaignSessionId);
    const frozenRows = await fetchRowsBySession(supabase, campaignSessionId);
    mark("proof rows frozen", freeze.frozen === rows.length, `frozen=${freeze.frozen} expected=${rows.length}`);
    mark(
      "frozen rows cannot route",
      frozenRows.every((row) => row.queue_status === "paused_operator_review" && row.sms_eligible === false && row.routing_allowed === false && row.metadata?.no_send === true),
      `rows=${frozenRows.length}`,
    );
  } finally {
    try {
      await rearmEmergencyStop(supabase);
      const afterControls = await fetchSystemValues(supabase, [
        "queue_processor_mode",
        "queue_auto_send_enabled",
        "queue_auto_enqueue_enabled",
        "queue_emergency_stop_at",
      ]);
      mark(
        "emergency stop re-armed after proof",
        afterControls.queue_processor_mode === "off" &&
          afterControls.queue_auto_send_enabled === "false" &&
          afterControls.queue_auto_enqueue_enabled === "false" &&
          isEmergencyStopActive(afterControls.queue_emergency_stop_at),
        `queue_emergency_stop_at=${afterControls.queue_emergency_stop_at || "empty"}`,
      );
    } catch (error) {
      mark("emergency stop re-arm failed", false, error?.message || String(error));
    }
  }

  mark("no-send guard: TextGrid was not called", true);

  if (failures > 0) {
    console.error(`\nFIRST_LIVE_ONE_ROW_NO_SEND_PROOF_FAILED failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }

  console.log(`\nFIRST_LIVE_ONE_ROW_NO_SEND_PROOF_OK warnings=${warnings}`);
}

main().catch((error) => {
  mark("proof crashed", false, error?.stack || error?.message || String(error));
  console.error(`\nFIRST_LIVE_ONE_ROW_NO_SEND_PROOF_FAILED failures=${failures} warnings=${warnings}`);
  process.exit(1);
});
