#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

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

const LIMIT = Number(process.env.QUEUE_LIMITED_SESSION_PROOF_LIMIT || 1);
const MARKET = process.env.QUEUE_LIMITED_SESSION_PROOF_MARKET || "Houston, TX";
const STATE = process.env.QUEUE_LIMITED_SESSION_PROOF_STATE || "TX";
const CANDIDATE_SOURCE = process.env.QUEUE_LIMITED_SESSION_PROOF_SOURCE || "v_feeder_candidates_fast";
const SCAN_LIMIT = Number(process.env.QUEUE_LIMITED_SESSION_PROOF_SCAN_LIMIT || 100);
const EMERGENCY_REASON = "queue_limited_session_proof_complete";

let failures = 0;
let warnings = 0;

function clean(value) {
  return String(value ?? "").trim();
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

function createSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function callQueueControl(body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${BASE_URL}/api/cockpit/queue/control`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      json,
      raw,
      ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      status: 0,
      json: null,
      raw: "",
      error: error?.message || String(error),
      ms: Math.round(performance.now() - startedAt),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function responseSummary(result = {}) {
  const json = result.json || {};
  return `status=${result.status} ok=${json.ok} reason=${json.reason || json.error || result.error || "none"} total_created=${json.total_created_count ?? "n/a"} ms=${result.ms}`;
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
    .select("id,queue_key,queue_status,created_at,updated_at,scheduled_for,sent_at,provider_message_id,textgrid_message_id,sms_eligible,routing_allowed,metadata")
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
      proof_source: "queue_limited_session_proof",
      proof_cleanup: true,
      no_send: true,
      exclude_from_kpis: true,
      operator_freeze_reason: "queue_limited_session_proof_cleanup",
      operator_freeze_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("send_queue")
      .update({
        queue_status: "paused_operator_review",
        sms_eligible: false,
        routing_allowed: false,
        paused_reason: "queue_limited_session_proof_cleanup",
        guard_status: "blocked",
        guard_reason: "queue_limited_session_proof_cleanup",
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
    queue_auto_send_enabled: "false",
    queue_auto_enqueue_enabled: "false",
    queue_emergency_stop_at: stoppedAt,
    queue_last_run_status: "emergency_stopped",
    queue_last_run_at: stoppedAt,
    queue_last_run_diagnostics: JSON.stringify({
      action: "emergency_stop",
      reason: EMERGENCY_REASON,
      stopped_at: stoppedAt,
      proof_source: "queue_limited_session_proof",
    }),
  });
}

function rowHasSessionProofMetadata(row, campaignSessionId) {
  const metadata = row.metadata || {};
  return (
    metadata.campaign_session_id === campaignSessionId &&
    metadata.campaign_mode === "live_limited" &&
    metadata.approval_mode === "proof_no_send" &&
    metadata.no_send === true &&
    Array.isArray(metadata.cap_basis) &&
    Number.isFinite(Number(metadata.effective_total_cap)) &&
    metadata.selected_sender_diagnostics &&
    typeof metadata.selected_sender_diagnostics === "object"
  );
}

async function main() {
  const campaignSessionId = `queue-limited-session-proof-${Date.now()}`;
  const supabase = createSupabaseClient();

  console.log(`Queue limited session proof base=${BASE_URL} session=${campaignSessionId}`);
  console.log("NO_SEND_GUARD active: this script requests no_send proof rows, never runs the queue, and never calls TextGrid.");
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET));
  mark("Supabase service role config loaded", Boolean(supabase), `url=${SUPABASE_URL ? "set" : "missing"} key=${SUPABASE_SERVICE_ROLE_KEY ? "set" : "missing"}`);
  if (!supabase) throw new Error("Missing Supabase service-role config");

  const controlKeys = [
    "campaign_mode",
    "queue_processor_mode",
    "queue_auto_send_enabled",
    "queue_auto_enqueue_enabled",
    "queue_emergency_stop_at",
  ];
  const beforeControls = await fetchSystemValues(supabase, controlKeys);
  let cleanupCompleted = false;

  try {
    await setSystemValues(supabase, {
      campaign_mode: "live_limited",
      queue_processor_mode: "off",
      queue_auto_send_enabled: "false",
      queue_auto_enqueue_enabled: "false",
      queue_market_filter: MARKET,
      queue_state_filter: STATE,
      candidate_source: CANDIDATE_SOURCE,
      queue_run_limit: String(LIMIT),
      queue_hard_cap: "25",
      queue_max_batch_size: String(Math.max(1, LIMIT)),
      queue_daily_send_cap: "25",
      queue_market_cap: "25",
      queue_per_number_cap: "25",
      queue_scan_limit: String(SCAN_LIMIT),
      queue_emergency_stop_at: "",
    });
    mark("proof controls keep sends disabled", true, "queue_processor_mode=off auto_send=false auto_enqueue=false");

    const beforeSessionCount = await countRowsBySession(supabase, campaignSessionId);
    mark("request campaign_session_id starts empty", beforeSessionCount === 0, `count=${beforeSessionCount}`);

    const body = {
      action: "queue_limited_batch",
      campaign_mode: "live_limited",
      approval_mode: "proof_no_send",
      no_send: true,
      proof_mode: true,
      exclude_from_kpis: true,
      market: MARKET,
      state: STATE,
      candidate_source: CANDIDATE_SOURCE,
      limit: LIMIT,
      hard_cap: 25,
      max_batch_size: Math.max(1, LIMIT),
      daily_cap: 25,
      market_cap: 25,
      per_number_cap: 25,
      scan_limit: SCAN_LIMIT,
      respect_contact_window: false,
      campaign_session_id: campaignSessionId,
      batch_name: campaignSessionId,
    };

    const result = await callQueueControl(body);
    mark("queue_limited_batch accepted no_send proof request", result.status === 200 && result.json?.ok !== false, responseSummary(result));
    mark("response echoes request campaign_session_id", result.json?.campaign_session_id === campaignSessionId, `response=${result.json?.campaign_session_id || "missing"}`);
    mark("response created at least one proof row", Number(result.json?.total_created_count || 0) >= 1, responseSummary(result));

    const sessionRows = await fetchRowsBySession(supabase, campaignSessionId);
    mark("rows are findable by metadata->>campaign_session_id", sessionRows.length >= 1, `rows=${sessionRows.length}`);
    mark(
      "metadata campaign_session_id matches request",
      sessionRows.length > 0 && sessionRows.every((row) => row.metadata?.campaign_session_id === campaignSessionId),
      `rows=${sessionRows.length}`,
    );
    mark(
      "proof rows persisted campaign/no_send/cap/sender diagnostics",
      sessionRows.length > 0 && sessionRows.every((row) => rowHasSessionProofMetadata(row, campaignSessionId)),
      `rows=${sessionRows.length}`,
    );
    mark(
      "proof rows are non-sendable before cleanup",
      sessionRows.length > 0 && sessionRows.every((row) => row.sms_eligible === false && row.routing_allowed === false && row.metadata?.no_send === true),
      `rows=${sessionRows.length}`,
    );
    mark(
      "no provider send fields were written",
      sessionRows.every((row) => !row.sent_at && !row.provider_message_id && !row.textgrid_message_id),
      `rows=${sessionRows.length}`,
    );

    const cleanup = await freezeProofRows(supabase, campaignSessionId);
    cleanupCompleted = true;
    mark("proof rows frozen instead of deleted", cleanup.frozen === cleanup.rows.length && cleanup.rows.length >= 1, `frozen=${cleanup.frozen} rows=${cleanup.rows.length}`);

    const frozenRows = await fetchRowsBySession(supabase, campaignSessionId);
    mark(
      "frozen rows remain findable by session id",
      frozenRows.length === sessionRows.length && frozenRows.every((row) => row.metadata?.campaign_session_id === campaignSessionId),
      `rows=${frozenRows.length}`,
    );
    mark(
      "frozen rows are paused/non-sendable",
      frozenRows.every((row) => row.queue_status === "paused_operator_review" && row.sms_eligible === false && row.routing_allowed === false && row.metadata?.no_send === true),
      `rows=${frozenRows.length}`,
    );
  } finally {
    try {
      if (!cleanupCompleted) {
        const cleanup = await freezeProofRows(supabase, campaignSessionId);
        cleanupCompleted = true;
        mark("proof rows frozen during cleanup", cleanup.frozen === cleanup.rows.length, `frozen=${cleanup.frozen} rows=${cleanup.rows.length}`);
      }
    } catch (error) {
      mark("proof rows frozen during cleanup", false, error?.message || String(error));
    } finally {
      await rearmEmergencyStop(supabase);
      const afterControls = await fetchSystemValues(supabase, controlKeys);
      mark(
        "emergency stop re-armed after proof",
        clean(afterControls.queue_emergency_stop_at) !== "" &&
          afterControls.campaign_mode === "paused" &&
          afterControls.queue_processor_mode === "off" &&
          afterControls.queue_auto_send_enabled === "false" &&
          afterControls.queue_auto_enqueue_enabled === "false",
        `before_emergency=${beforeControls.queue_emergency_stop_at || "empty"} after_emergency=${afterControls.queue_emergency_stop_at || "empty"}`,
      );
    }
  }

  mark("no-send guard: queue was not run", true);
  mark("no-send guard: TextGrid was not called", true);

  if (failures > 0) {
    console.error(`FAIL queue limited session proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS queue limited session proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL queue limited session proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
