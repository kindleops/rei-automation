#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { DEFAULT_SMS_HEALTH_GUARD_BLOCKLISTS } from "../../apps/api/src/lib/domain/delivery/sms-health-guard.js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const JSON_MODE = process.argv.includes("--json");

const CONTROL_KEYS = [
  "auto_reply_enabled",
  "auto_reply_live_enabled",
  "auto_reply_dry_run",
  "followup_enabled",
  "feeder_enabled",
  "outbound_sms_enabled",
  "queue_runner_enabled",
  "reconcile_enabled",
  "require_local_routing",
  "auto_queue_enabled",
  "queue_auto_enqueue_enabled",
  "queue_auto_send_enabled",
  "queue_processor_mode",
  "campaign_mode",
  "retry_enabled",
  "podio_sync_enabled",
  "queue_max_batch_size",
  "queue_run_limit",
  "queue_daily_send_cap",
  "queue_hard_cap",
  "queue_market_cap",
  "queue_per_number_cap",
  "queue_market_filter",
  "queue_state_filter",
  "sms_blocked_sender_numbers",
  "sms_blocked_template_ids",
  "allow_regional_fallback_for_first_touch",
];

const CRITICAL_FILES = [
  "apps/api/src/app/api/internal/queue/run/route.js",
  "apps/api/src/app/api/internal/queue/retry/route.js",
  "apps/api/src/app/api/internal/queue/reconcile/route.js",
  "apps/api/src/app/api/internal/outbound/feed-master-owners/route.js",
  "apps/api/src/app/api/internal/autopilot/run/route.js",
  "apps/api/src/app/api/webhooks/textgrid/inbound/route.js",
  "apps/api/src/app/api/webhooks/textgrid/delivery/route.js",
  "apps/api/src/lib/flows/handle-textgrid-inbound.js",
  "apps/api/src/lib/flows/handle-textgrid-delivery.js",
  "apps/api/src/lib/domain/classification/classify.js",
  "apps/api/src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js",
  "apps/api/src/lib/domain/seller-flow/maybe-queue-seller-stage-reply.js",
  "apps/api/src/lib/domain/seller-flow/seller-followup-scheduler.js",
  "apps/api/src/lib/domain/delivery/canonical-delivery-state.js",
  "apps/api/src/lib/domain/delivery/sms-health-guard.js",
  "scripts/proof/sms-retry-safety-proof.mjs",
  "scripts/proof/sms-autopilot-dry-run-proof.mjs",
  "scripts/proof/sms-health-guard-proof.mjs",
];

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
    if (!process.env[key]) process.env[key] = parseEnvValue(normalized.slice(equalsIndex + 1));
  }
}

for (const file of [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/api/.env.production.local"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
]) {
  loadEnvFile(file);
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = lower(value);
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseList(value) {
  return clean(value).split(",").map(clean).filter(Boolean);
}

async function loadSystemControl() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { values: {}, source: "missing_supabase_env", error: null };
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", CONTROL_KEYS);

  if (error) return { values: {}, source: "supabase_error", error: error.message };
  return {
    values: Object.fromEntries((data || []).map((row) => [row.key, row.value])),
    source: "supabase",
    error: null,
  };
}

function addCheck(checks, name, status, detail = "", category = "code") {
  checks.push({ name, status, detail, category });
}

function computeVerdict(values, checks) {
  const criticalCodeBlockers = checks.filter((check) => check.category === "code" && check.status === "red");
  if (criticalCodeBlockers.length > 0) return "NOT_READY";

  const controlled =
    asBoolean(values.auto_queue_enabled, false) &&
    asBoolean(values.queue_auto_enqueue_enabled, false) &&
    asBoolean(values.queue_auto_send_enabled, false) &&
    lower(values.queue_processor_mode) === "controlled" &&
    lower(values.campaign_mode) === "controlled" &&
    asBoolean(values.retry_enabled, true) === false &&
    asBoolean(values.reconcile_enabled, false) &&
    asBoolean(values.followup_enabled, false) &&
    asBoolean(values.auto_reply_enabled, false) &&
    asBoolean(values.auto_reply_live_enabled, false) &&
    asBoolean(values.auto_reply_dry_run, true) === false &&
    asBoolean(values.require_local_routing, false) &&
    asNumber(values.queue_max_batch_size, 999) <= 3 &&
    asNumber(values.queue_run_limit, 999) <= 3 &&
    asNumber(values.queue_daily_send_cap, 999) <= 50 &&
    asNumber(values.queue_hard_cap, 999) <= 50;

  if (controlled) return "READY_FOR_CONTROLLED_AUTOPILOT";
  return "NOT_READY";
}

const control = await loadSystemControl();
const values = control.values;
const checks = [];

for (const file of CRITICAL_FILES) {
  addCheck(
    checks,
    `critical file exists: ${file}`,
    fs.existsSync(path.join(ROOT, file)) ? "green" : "red",
    file,
    "code"
  );
}

const blockedSenders = [
  ...DEFAULT_SMS_HEALTH_GUARD_BLOCKLISTS.blocked_sender_numbers,
  ...parseList(values.sms_blocked_sender_numbers),
  ...parseList(process.env.SMS_BLOCKED_SENDER_NUMBERS),
];
const blockedTemplates = [
  ...DEFAULT_SMS_HEALTH_GUARD_BLOCKLISTS.blocked_template_ids,
  ...parseList(values.sms_blocked_template_ids),
  ...parseList(process.env.SMS_BLOCKED_TEMPLATE_IDS),
];

addCheck(
  checks,
  "emergency sender blocklist includes known bad senders",
  ["+14704920588", "+14693131600"].every((phone) => blockedSenders.includes(phone)) ? "green" : "red",
  blockedSenders.join(","),
  "code"
);
addCheck(
  checks,
  "emergency template blocklist includes known toxic templates",
  ["208481", "204257", "204529", "204561", "204705", "204721", "207681"].every((id) => blockedTemplates.includes(id)) ? "green" : "red",
  blockedTemplates.join(","),
  "code"
);

if (control.source !== "supabase") {
  addCheck(checks, "system_control readable", "red", control.error || control.source, "control");
} else {
  addCheck(checks, "system_control readable", "green", `${Object.keys(values).length} keys`, "control");
}

const expectedEnabled = [
  "auto_reply_enabled",
  "auto_reply_live_enabled",
  "followup_enabled",
  "feeder_enabled",
  "outbound_sms_enabled",
  "queue_runner_enabled",
  "reconcile_enabled",
  "require_local_routing",
];

for (const key of expectedEnabled) {
  addCheck(checks, `${key}=true`, asBoolean(values[key], false) ? "green" : "red", `value=${clean(values[key]) || "missing"}`, "control");
}

for (const key of ["auto_queue_enabled", "queue_auto_enqueue_enabled", "queue_auto_send_enabled"]) {
  addCheck(checks, `${key}=true for controlled autopilot`, asBoolean(values[key], false) ? "green" : "red", `value=${clean(values[key]) || "missing"}`, "control");
}

addCheck(checks, "queue_processor_mode=controlled", lower(values.queue_processor_mode) === "controlled" ? "green" : "red", `value=${clean(values.queue_processor_mode) || "missing"}`, "control");
addCheck(checks, "campaign_mode=controlled", lower(values.campaign_mode) === "controlled" ? "green" : "red", `value=${clean(values.campaign_mode) || "missing"}`, "control");
addCheck(checks, "retry_enabled=false", asBoolean(values.retry_enabled, false) === false ? "green" : "red", `value=${clean(values.retry_enabled) || "missing"}`, "control");
addCheck(checks, "auto_reply_dry_run=false", asBoolean(values.auto_reply_dry_run, true) === false ? "green" : "red", `value=${clean(values.auto_reply_dry_run) || "missing"}`, "control");
addCheck(checks, "queue_max_batch_size<=3", asNumber(values.queue_max_batch_size, 999) <= 3 ? "green" : "red", `value=${clean(values.queue_max_batch_size) || "missing"}`, "control");
addCheck(checks, "queue_run_limit<=3", asNumber(values.queue_run_limit, 999) <= 3 ? "green" : "red", `value=${clean(values.queue_run_limit) || "missing"}`, "control");
addCheck(checks, "queue_daily_send_cap<=50", asNumber(values.queue_daily_send_cap, 999) <= 50 ? "green" : "red", `value=${clean(values.queue_daily_send_cap) || "missing"}`, "control");
addCheck(checks, "queue_hard_cap<=50", asNumber(values.queue_hard_cap, 999) <= 50 ? "green" : "red", `value=${clean(values.queue_hard_cap) || "missing"}`, "control");

const verdict = computeVerdict(values, checks);
const result = {
  ok: verdict !== "NOT_READY",
  verdict,
  system_control_source: control.source,
  system_control_error: control.error,
  values,
  checks,
  summary: {
    green: checks.filter((check) => check.status === "green").length,
    yellow: checks.filter((check) => check.status === "yellow").length,
    red: checks.filter((check) => check.status === "red").length,
  },
};

if (JSON_MODE) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`# SMS Automation Readiness Audit

Verdict: ${verdict}

System control source: ${control.source}${control.error ? ` (${control.error})` : ""}

${checks.map((check) => `- ${check.status.toUpperCase()} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`).join("\n")}

Final verdict: ${verdict}
`);
}
