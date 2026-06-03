#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API_ROOT = path.join(ROOT, "apps/api");
const DASHBOARD_ROOT = path.join(ROOT, "apps/dashboard");

const RESTORED_INBOX_MIGRATION = "20260530011838_restore_inbox_live_v2_primary_views.sql";
const PRIMARY_THREAD_VIEW = "v_inbox_threads_live_v2";
const PRIMARY_COUNTS_VIEW = "v_inbox_thread_counts_live_v2";

const envFiles = [
  path.join(API_ROOT, ".env.local"),
  path.join(API_ROOT, ".env.production.local"),
  path.join(API_ROOT, ".env.preview"),
  path.join(API_ROOT, ".env.vercel.production"),
  path.join(API_ROOT, ".env.vercel.preview"),
  path.join(DASHBOARD_ROOT, ".env.local"),
  path.join(DASHBOARD_ROOT, ".env.production"),
  path.join(DASHBOARD_ROOT, ".env"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
];

const env = { ...process.env };
const envSources = new Map();
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

function noteSource(key, source) {
  if (!envSources.has(key)) envSources.set(key, new Set());
  envSources.get(key).add(source);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const rel = path.relative(ROOT, filePath);
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    const value = parseEnvValue(normalized.slice(equalsIndex + 1));
    if (value && !env[key]) env[key] = value;
    if (value) noteSource(key, rel);
  }
}

for (const file of envFiles) loadEnvFile(file);

for (const [key, value] of Object.entries(process.env)) {
  if (clean(value)) noteSource(key, "process.env");
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

function sourceList(keys) {
  const sources = new Set();
  for (const key of keys) {
    for (const source of envSources.get(key) || []) sources.add(source);
  }
  return Array.from(sources).sort().join(", ") || "not found";
}

function hasEnv(key) {
  return clean(env[key]).length > 0;
}

function requireEnv(key, label = key) {
  return mark(`${label} env loaded`, hasEnv(key), `sources=${sourceList([key])}`);
}

function requireAny(keys, label) {
  return mark(`${label} env loaded`, keys.some(hasEnv), `keys=${keys.join("|")} sources=${sourceList(keys)}`);
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

async function checkSupabaseReadiness() {
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceRole) {
    mark("Supabase live readiness skipped", false, "missing SUPABASE_URL or service role", true);
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const view of [PRIMARY_THREAD_VIEW, PRIMARY_COUNTS_VIEW]) {
    const { count, error } = await supabase
      .from(view)
      .select("*", { count: "exact", head: true });
    mark(`Supabase view reachable ${view}`, !error, error ? error.message : `count=${count ?? "unknown"}`);
  }

  const { data, error } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", [
      "queue_processor_mode",
      "auto_reply_mode",
      "campaign_mode",
      "queue_auto_send_enabled",
      "queue_auto_enqueue_enabled",
      "queue_emergency_stop_at",
    ]);

  if (error) {
    mark("system_control safety values readable", false, error.message);
    return;
  }

  const values = Object.fromEntries((data || []).map((row) => [row.key, clean(row.value).toLowerCase()]));
  const queueMode = values.queue_processor_mode || "paused";
  const autoReplyMode = values.auto_reply_mode || "disabled";
  const campaignMode = values.campaign_mode || "paused";
  const autoSend = values.queue_auto_send_enabled || "false";
  const autoEnqueue = values.queue_auto_enqueue_enabled || "false";
  const emergencyStopAt = values.queue_emergency_stop_at || "";

  mark("runtime queue_processor_mode safe", ["paused", "off", "safe", "dry_run"].includes(queueMode), `value=${queueMode}`);
  mark("runtime auto_reply_mode safe", ["disabled", "dry_run"].includes(autoReplyMode), `value=${autoReplyMode}`);
  mark("runtime campaign_mode safe", ["paused", "dry_run"].includes(campaignMode), `value=${campaignMode}`);
  mark("runtime queue_auto_send_enabled false", !["true", "1", "yes", "on", "enabled"].includes(autoSend), `value=${autoSend}`);
  mark("runtime queue_auto_enqueue_enabled false", !["true", "1", "yes", "on", "enabled"].includes(autoEnqueue), `value=${autoEnqueue}`);
  mark("runtime emergency stop readable", true, `set=${Boolean(emergencyStopAt)}`);
}

function headers() {
  const opsSecret = env.OPS_DASHBOARD_SECRET || env.VITE_OPS_DASHBOARD_SECRET || env.VITE_BACKEND_API_SECRET || "";
  const h = { accept: "application/json", "content-type": "application/json", origin: "http://localhost:5173" };
  if (opsSecret) h["x-ops-dashboard-secret"] = opsSecret;
  return h;
}

async function callJson(pathOrUrl, options = {}) {
  const base = clean(
    env.COCKPIT_PROOF_BASE_URL ||
    env.API_URL ||
    env.LOCAL_API_URL ||
    "http://localhost:3000",
  ).replace(/\/$/, "");
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base}${pathOrUrl}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.headers || headers(),
    body: options.body,
    signal: AbortSignal.timeout(Number(env.PRODUCTION_READINESS_HTTP_TIMEOUT_MS || 60000)),
  });
  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    return { status: response.status, json: null, raw, error: `non_json:${raw.slice(0, 120)}` };
  }
  return { status: response.status, json, raw, error: null };
}

async function checkEmergencyStopLive() {
  const enabled = ["1", "true", "yes", "on"].includes(
    clean(env.PRODUCTION_READINESS_ALLOW_EMERGENCY_STOP || env.PRODUCTION_READINESS_EMERGENCY_STOP_LIVE).toLowerCase(),
  );
  if (!enabled) {
    mark(
      "emergency stop live proof disabled by default",
      true,
      "set PRODUCTION_READINESS_ALLOW_EMERGENCY_STOP=true to POST the safe stop action",
    );
    return;
  }

  try {
    const result = await callJson("/api/cockpit/queue/control", {
      method: "POST",
      body: JSON.stringify({ action: "emergency_stop", reason: "production_readiness_proof" }),
    });
    const diagnostics = result.json?.diagnostics || result.json?.control?.settings || {};
    mark("emergency stop route status", result.status === 200 && result.json?.ok === true, `status=${result.status} error=${result.error || result.json?.error || ""}`);
    mark("emergency stop pauses queue", diagnostics.queue_processor_mode === "off", `queue_processor_mode=${diagnostics.queue_processor_mode || "unknown"}`);
    mark("emergency stop pauses campaign", diagnostics.campaign_mode === "paused", `campaign_mode=${diagnostics.campaign_mode || "unknown"}`);
    mark("emergency stop disables auto send", String(diagnostics.queue_auto_send_enabled).toLowerCase() === "false", `queue_auto_send_enabled=${diagnostics.queue_auto_send_enabled ?? "unknown"}`);
  } catch (error) {
    mark("emergency stop live proof", false, error?.message || String(error));
  }
}

async function checkRuntimeBrakeInvariants() {
  const queueSafety = await import(
    pathToFileURL(path.join(API_ROOT, "src/lib/domain/queue/queue-control-safety.js")).href
  );
  const autoReplyMode = await import(
    pathToFileURL(path.join(API_ROOT, "src/lib/domain/seller-flow/auto-reply-mode.js")).href
  );

  const permissiveSettings = {
    queue_processor_mode: "live",
    campaign_mode: "live_limited",
    auto_reply_mode: "live_limited",
    queue_auto_enqueue_enabled: "true",
    queue_auto_send_enabled: "true",
    queue_emergency_stop_at: "2026-05-30T00:00:00.000Z",
  };

  const emergencySend = queueSafety.evaluateQueueSendRuntimeBrakes(permissiveSettings, {
    action: "proof_send",
    failClosed: true,
  });
  mark(
    "emergency stop blocks send despite permissive flags",
    emergencySend.ok === false && emergencySend.reason === "queue_emergency_stop_active",
    `reason=${emergencySend.reason || "missing"}`,
  );

  const emergencyCreate = queueSafety.evaluateQueueCreationRuntimeBrakes(permissiveSettings, {
    action: "proof_queue_create",
    requireAutoEnqueue: true,
    failClosed: true,
  });
  mark(
    "emergency stop blocks queue creation despite permissive flags",
    emergencyCreate.ok === false && emergencyCreate.reason === "queue_emergency_stop_active",
    `reason=${emergencyCreate.reason || "missing"}`,
  );

  const pausedSend = queueSafety.evaluateQueueSendRuntimeBrakes(
    { queue_processor_mode: "off", queue_emergency_stop_at: "" },
    { action: "proof_send", failClosed: true },
  );
  mark(
    "queue_processor_mode off blocks live send",
    pausedSend.ok === false && pausedSend.reason === "queue_processor_paused",
    `reason=${pausedSend.reason || "missing"}`,
  );

  const pausedCreate = queueSafety.evaluateQueueCreationRuntimeBrakes(
    { campaign_mode: "paused", queue_auto_enqueue_enabled: "true", queue_emergency_stop_at: "" },
    { action: "proof_queue_create", requireAutoEnqueue: true, failClosed: true },
  );
  mark(
    "campaign_mode paused blocks queue creation",
    pausedCreate.ok === false && pausedCreate.reason === "campaign_paused",
    `reason=${pausedCreate.reason || "missing"}`,
  );

  const dryRunCreate = queueSafety.evaluateQueueCreationRuntimeBrakes(
    { campaign_mode: "dry_run", queue_auto_enqueue_enabled: "true", queue_emergency_stop_at: "" },
    { action: "proof_queue_create", requireAutoEnqueue: true, failClosed: true },
  );
  mark(
    "campaign_mode dry_run blocks live queue creation",
    dryRunCreate.ok === false && dryRunCreate.reason === "campaign_not_live_limited",
    `reason=${dryRunCreate.reason || "missing"}`,
  );

  const disabledAutoReply = autoReplyMode.resolveGuardedAutoReplyMode({
    requestedMode: "live_limited",
    env: {
      AUTO_REPLY_MODE: "live_limited",
      AUTO_REPLY_ENABLED: "true",
      AUTO_REPLY_LIVE_ENABLED: "true",
    },
    systemMode: "disabled",
    legacyEnabled: true,
    legacyDryRun: false,
    legacyLiveEnabled: true,
  });
  mark(
    "auto_reply_mode disabled beats permissive env booleans",
    disabledAutoReply.mode === "disabled" && disabledAutoReply.source === "system_control",
    `mode=${disabledAutoReply.mode || "missing"} source=${disabledAutoReply.source || "missing"}`,
  );
}

async function main() {
  console.log("Production readiness proof mode=read-only unless emergency-stop opt-in is set");

  requireAny(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"], "API Supabase URL");
  requireAny(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"], "API Supabase service role");
  requireEnv("OPS_DASHBOARD_SECRET", "API OPS dashboard secret");
  requireAny(["CRON_SECRET", "QUEUE_ENGINE_SHARED_SECRET"], "API cron/queue secret");
  requireEnv("INTERNAL_API_SECRET", "API internal secret");
  requireEnv("TEXTGRID_ACCOUNT_SID", "API TextGrid account SID");
  requireEnv("TEXTGRID_AUTH_TOKEN", "API TextGrid auth token");
  requireEnv("TEXTGRID_WEBHOOK_SECRET", "API TextGrid webhook secret");

  requireEnv("VITE_BACKEND_API_URL", "dashboard backend URL");
  requireAny(["VITE_BACKEND_API_SECRET", "VITE_OPS_DASHBOARD_SECRET"], "dashboard backend secret");
  requireEnv("VITE_SUPABASE_URL", "dashboard Supabase URL");
  requireEnv("VITE_SUPABASE_ANON_KEY", "dashboard Supabase anon key");

  for (const projectFile of [
    path.join(ROOT, ".vercel/project.json"),
    path.join(API_ROOT, ".vercel/project.json"),
    path.join(DASHBOARD_ROOT, ".vercel/project.json"),
  ]) {
    mark(`Vercel project linked ${path.relative(ROOT, projectFile)}`, fs.existsSync(projectFile));
  }

  const migrationPath = path.join(API_ROOT, "supabase/migrations", RESTORED_INBOX_MIGRATION);
  const migrationSql = readText(migrationPath);
  mark("restored inbox v2 migration file present", Boolean(migrationSql), path.relative(ROOT, migrationPath));
  mark("restored inbox v2 threads view in migration", migrationSql.includes(PRIMARY_THREAD_VIEW), PRIMARY_THREAD_VIEW);
  mark("restored inbox v2 counts view in migration", migrationSql.includes(PRIMARY_COUNTS_VIEW), PRIMARY_COUNTS_VIEW);

  const queueControlSource = readText(path.join(API_ROOT, "src/app/api/cockpit/queue/control/route.js"));
  const autoReplySource = readText(path.join(API_ROOT, "src/lib/domain/seller-flow/auto-reply-mode.js"));
  mark("queue_processor_mode default paused", /queue_processor_mode:\s*['"]paused['"]/.test(queueControlSource));
  mark("auto_reply_mode default disabled", /auto_reply_mode:\s*['"]disabled['"]/.test(queueControlSource) && autoReplySource.includes('mode: "disabled"'));
  mark("campaign_mode default paused", /campaign_mode:\s*['"]paused['"]/.test(queueControlSource));
  mark("campaign dry-run action exists", queueControlSource.includes("run_dry_run_feeder") && queueControlSource.includes("dry_run: true"));
  mark("emergency stop code path exists", queueControlSource.includes("action === 'emergency_stop'") && queueControlSource.includes("queue_auto_send_enabled: 'false'"));
  mark("provider send checks runtime brakes", readText(path.join(API_ROOT, "src/lib/providers/textgrid.js")).includes("evaluateQueueSendRuntimeBrakes"));
  mark("queue creation checks runtime brakes", readText(path.join(API_ROOT, "src/lib/domain/outbound/supabase-candidate-feeder.js")).includes("evaluateQueueCreationRuntimeBrakes"));
  mark("auto-reply emergency stop path exists", readText(path.join(API_ROOT, "src/lib/flows/handle-textgrid-inbound.js")).includes("queue_emergency_stop"));

  await checkRuntimeBrakeInvariants();
  await checkEmergencyStopLive();
  await checkSupabaseReadiness();

  if (failures > 0) {
    console.error(`FAIL production readiness proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS production readiness proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL production readiness proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
