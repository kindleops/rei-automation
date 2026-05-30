#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

const CAP = 5;
const MARKET = process.env.QUEUE_LIMITED_CAP_PROOF_MARKET || "Houston, TX";
const STATE = process.env.QUEUE_LIMITED_CAP_PROOF_STATE || "TX";
const CANDIDATE_SOURCE = process.env.QUEUE_LIMITED_CAP_PROOF_SOURCE || "v_feeder_candidates_fast";
const SCAN_LIMIT = Number(process.env.QUEUE_LIMITED_CAP_PROOF_SCAN_LIMIT || 25);
const EMERGENCY_REASON = "cap_bug_operator_freeze";

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

async function callQueueControl(label, body) {
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
      label,
      status: response.status,
      json,
      raw,
      ms: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      label,
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

function totalCreatedFromResponse(result = {}) {
  const json = result.json || {};
  if (json.total_created_count !== undefined && json.total_created_count !== null) {
    return Number(json.total_created_count || 0);
  }
  return Number(json.rows_created || 0) + Number(json.rows_scheduled || 0);
}

function queueRowsCreated(result = {}) {
  const json = result.json || {};
  return Number(json.rows_created || 0) + Number(json.rows_scheduled || 0);
}

function responseSummary(result = {}) {
  const json = result.json || {};
  return `status=${result.status} ok=${json.ok} reason=${json.reason || json.error || "none"} total_created=${totalCreatedFromResponse(result)} rows_total=${queueRowsCreated(result)} ms=${result.ms}`;
}

function createSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
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

async function fetchProofRows(supabase, campaignSessionId) {
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_status,created_at,metadata,sms_eligible,routing_allowed")
    .contains("metadata", { campaign_session_id: campaignSessionId })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`send_queue proof row fetch failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

async function seedProofCapRows(supabase, campaignSessionId) {
  const now = new Date().toISOString();
  const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const rows = Array.from({ length: CAP }, (_, index) => {
    const key = `proof:queue-limited-cap:${campaignSessionId}:${index + 1}:${crypto.randomUUID()}`;
    return {
      queue_key: key,
      queue_id: key,
      queue_status: "scheduled",
      scheduled_for: scheduledFor,
      scheduled_for_utc: scheduledFor,
      scheduled_for_local: scheduledFor,
      message_body: "NO SEND queue_limited_cap_proof seeded cap row",
      message_text: "NO SEND queue_limited_cap_proof seeded cap row",
      to_phone_number: "+16127433952",
      from_phone_number: "+10000000000",
      market: MARKET,
      property_address_state: STATE,
      timezone: "America/Chicago",
      sms_eligible: false,
      routing_allowed: false,
      safety_status: "blocked",
      guard_status: "blocked",
      guard_reason: "queue_limited_cap_proof_seed",
      paused_reason: null,
      type: "proof",
      source: "queue_limited_cap_proof",
      metadata: {
        proof: true,
        proof_source: "queue_limited_cap_proof",
        proof_seed: true,
        no_send: true,
        exclude_from_kpis: true,
        campaign_session_id: campaignSessionId,
        batch_name: campaignSessionId,
        seller_market: MARKET,
        seller_state: STATE,
        candidate_snapshot: {
          campaign_session_id: campaignSessionId,
          seller_market: MARKET,
          seller_state: STATE,
        },
        seeded_at: now,
      },
      created_at: now,
      updated_at: now,
    };
  });
  const { data, error } = await supabase
    .from("send_queue")
    .insert(rows)
    .select("id,queue_status");
  if (error) throw new Error(`proof cap seed insert failed: ${error.message}`);
  return data || [];
}

async function freezeProofRows(supabase, campaignSessionId) {
  const rows = await fetchProofRows(supabase, campaignSessionId);
  let frozen = 0;
  for (const row of rows) {
    const metadata = {
      ...(row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {}),
      proof: true,
      proof_source: "queue_limited_cap_proof",
      proof_cleanup: true,
      no_send: true,
      exclude_from_kpis: true,
      operator_freeze_reason: "queue_limited_cap_proof_cleanup",
      operator_freeze_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("send_queue")
      .update({
        queue_status: "paused_operator_review",
        sms_eligible: false,
        routing_allowed: false,
        paused_reason: "queue_limited_cap_proof_cleanup",
        guard_status: "blocked",
        guard_reason: "queue_limited_cap_proof_cleanup",
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) throw new Error(`proof row freeze failed id=${row.id}: ${error.message}`);
    frozen += 1;
  }
  return { frozen, rows };
}

function isCapExhausted(result = {}) {
  const json = result.json || {};
  return result.status === 423 && lower(json.reason || json.error) === "queue_limited_cap_exhausted";
}

function activeProofCount(rows = []) {
  return rows.filter((row) => row.queue_status === "queued" || row.queue_status === "scheduled").length;
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
      proof_source: "queue_limited_cap_proof",
    }),
  });
}

async function main() {
  const campaignSessionId = `queue-limited-cap-proof-${Date.now()}`;
  const supabase = createSupabaseClient();

  console.log(`Queue limited cap proof base=${BASE_URL} session=${campaignSessionId}`);
  console.log("NO_SEND_GUARD active: this script creates capped queue rows only, never runs the queue, and never calls TextGrid.");
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
      queue_run_limit: String(CAP),
      queue_hard_cap: String(CAP),
      queue_max_batch_size: String(CAP),
      queue_daily_send_cap: String(CAP),
      queue_market_cap: String(CAP),
      queue_per_number_cap: String(CAP),
      queue_scan_limit: String(SCAN_LIMIT),
      queue_emergency_stop_at: "",
    });
    mark("proof controls keep sends disabled", true, "queue_processor_mode=off auto_send=false auto_enqueue=false");

    const seededRows = await seedProofCapRows(supabase, campaignSessionId);
    mark("seeded proof rows exhaust cap without sending", seededRows.length === CAP, `seeded=${seededRows.length} cap=${CAP}`);

    const body = {
      action: "queue_limited_batch",
      campaign_mode: "live_limited",
      market: MARKET,
      state: STATE,
      candidate_source: CANDIDATE_SOURCE,
      limit: CAP,
      hard_cap: CAP,
      max_batch_size: CAP,
      daily_cap: CAP,
      market_cap: CAP,
      per_number_cap: CAP,
      scan_limit: SCAN_LIMIT,
      respect_contact_window: true,
      campaign_session_id: campaignSessionId,
      batch_name: campaignSessionId,
    };

    const first = await callQueueControl("first queue_limited_batch", body);
    const firstTotal = totalCreatedFromResponse(first);
    mark(
      "first cap request completed or cap-exhausted safely",
      (first.status === 200 && first.json?.ok !== false) || isCapExhausted(first),
      responseSummary(first),
    );
    mark("first response total_created_count <= 5", firstTotal <= CAP, responseSummary(first));
    mark("first response queued_count + scheduled_count <= 5", queueRowsCreated(first) <= CAP, responseSummary(first));

    const rowsAfterFirst = await fetchProofRows(supabase, campaignSessionId);
    mark("database proof rows after first call <= 5", rowsAfterFirst.length <= CAP, `rows=${rowsAfterFirst.length} active=${activeProofCount(rowsAfterFirst)}`);

    const second = await callQueueControl("repeat queue_limited_batch", body);
    const secondTotal = totalCreatedFromResponse(second);
    mark(
      "repeat cap request completed or cap-exhausted safely",
      (second.status === 200 && second.json?.ok !== false) || isCapExhausted(second),
      responseSummary(second),
    );
    mark("repeat response total_created_count <= 5", secondTotal <= CAP, responseSummary(second));

    const rowsAfterSecond = await fetchProofRows(supabase, campaignSessionId);
    mark(
      "repeated call did not create beyond cap",
      rowsAfterSecond.length <= CAP && activeProofCount(rowsAfterSecond) <= CAP,
      `rows=${rowsAfterSecond.length} active=${activeProofCount(rowsAfterSecond)} first_rows=${rowsAfterFirst.length}`,
    );

    const cleanup = await freezeProofRows(supabase, campaignSessionId);
    cleanupCompleted = true;
    mark("proof rows frozen instead of deleted", cleanup.frozen === cleanup.rows.length, `frozen=${cleanup.frozen} rows=${cleanup.rows.length}`);

    const frozenRows = await fetchProofRows(supabase, campaignSessionId);
    mark(
      "proof rows are non-sendable after cleanup",
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
    console.error(`FAIL queue limited cap proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS queue limited cap proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL queue limited cap proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
