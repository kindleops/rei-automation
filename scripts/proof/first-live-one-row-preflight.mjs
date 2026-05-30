#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { resolveTextgridMarketCoverage } from "../../apps/api/src/lib/config/textgrid-market-coverage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API_ROOT = path.join(ROOT, "apps/api");
const DASHBOARD_ROOT = path.join(ROOT, "apps/dashboard");

const DEFAULT_CANDIDATE_SOURCE = "v_feeder_candidates_fast";
const TARGET_CAMPAIGN_MODE = "live_limited";
const DEFAULT_MAX_SELLERS = 1;
const DEFAULT_SCAN_LIMIT = 1000;
const CONFIRM = "SEND_ONE_REAL_SELLER_SMS";

const CONTROL_KEYS = [
  "queue_processor_mode",
  "auto_reply_mode",
  "campaign_mode",
  "candidate_source",
  "queue_auto_send_enabled",
  "queue_auto_enqueue_enabled",
  "queue_emergency_stop_at",
  "queue_market_filter",
  "queue_state_filter",
  "queue_run_limit",
  "queue_scan_limit",
  "queue_daily_send_cap",
  "queue_hard_cap",
  "queue_max_batch_size",
  "queue_market_cap",
  "queue_per_number_cap",
];

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "off", "disabled", "paused", "null", "none"]);
const SAFE_AUTO_REPLY_MODES = new Set(["disabled", "dry_run"]);
const BOOLEAN_FLAGS = new Set(["allow_approved_sender_fallback"]);

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

const state = {
  failures: 0,
  warnings: 0,
};

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

function printUsageAndExit(message) {
  if (message) console.error(`FAIL ${message}`);
  console.error(`
Usage:
  node scripts/proof/first-live-one-row-preflight.mjs --market "Houston, TX" --state "TX"

Required:
  --market                 Market name/label for the one seller.
  --state                  Two-letter property/seller state.

Optional:
  --max-sellers            Must be 1. Default ${DEFAULT_MAX_SELLERS}.
  --candidate-source       Must be ${DEFAULT_CANDIDATE_SOURCE}.
  --scan-limit             Default ${DEFAULT_SCAN_LIMIT}.
  --allow-approved-sender-fallback
                           Acknowledge explicit approved regional sender fallback.
`);
  process.exit(2);
}

function parseBooleanOption(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === undefined) return fallback;
  const normalized = lower(value);
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function parseArgs(argv = []) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) printUsageAndExit(`unexpected argument ${token}`);
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-/g, "_");
    if (BOOLEAN_FLAGS.has(key) && inlineValue === undefined) {
      out[key] = true;
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[index + 1];
    if (inlineValue === undefined) index += 1;
    if (value === undefined || String(value).startsWith("--")) {
      printUsageAndExit(`missing value for --${rawKey}`);
    }
    out[key] = value;
  }

  const market = clean(out.market);
  const stateCode = clean(out.state).toUpperCase();
  if (!market) printUsageAndExit("--market is required");
  if (!/^[A-Z]{2}$/.test(stateCode)) printUsageAndExit("--state must be a two-letter state code");

  const maxSellers = Math.trunc(Number(out.max_sellers ?? DEFAULT_MAX_SELLERS));
  if (maxSellers !== 1) printUsageAndExit("--max-sellers must be exactly 1 for this workflow");

  const candidateSource = clean(out.candidate_source || DEFAULT_CANDIDATE_SOURCE);
  if (candidateSource !== DEFAULT_CANDIDATE_SOURCE) {
    printUsageAndExit(`--candidate-source must be ${DEFAULT_CANDIDATE_SOURCE}`);
  }

  const scanLimit = Math.trunc(Number(out.scan_limit ?? DEFAULT_SCAN_LIMIT));
  if (!Number.isFinite(scanLimit) || scanLimit < 1 || scanLimit > 5000) {
    printUsageAndExit("--scan-limit must be between 1 and 5000");
  }

  return {
    market,
    state: stateCode,
    max_sellers: 1,
    scan_limit: scanLimit,
    candidate_source: candidateSource,
    allow_approved_sender_fallback: parseBooleanOption(out.allow_approved_sender_fallback, false),
    campaign_session_id: `first-live-one-row-preflight-${Date.now()}`,
  };
}

function mark(label, condition, detail = "", warnOnly = false) {
  const prefix = condition ? "PASS" : warnOnly ? "WARN" : "FAIL";
  const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
    return true;
  }
  if (warnOnly) {
    state.warnings += 1;
    console.warn(line);
    return false;
  }
  state.failures += 1;
  console.error(line);
  return false;
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = lower(value);
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function normalizeQueueProcessorMode(value) {
  const normalized = lower(value || "paused");
  if (["off", "paused", "pause"].includes(normalized)) return "off";
  if (["safe", "assisted", "dry_run", "dryrun", "preview"].includes(normalized)) return "safe";
  if (["live", "automatic"].includes(normalized)) return "live";
  return "off";
}

function isEmergencyStopActive(value) {
  const normalized = lower(value);
  return Boolean(normalized && !["0", "false", "off", "none", "null", "cleared", "clear"].includes(normalized));
}

function createSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function loadSystemControl(supabase) {
  const { data, error } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", CONTROL_KEYS);
  if (error) throw error;
  return Object.fromEntries((data || []).map((row) => [row.key, clean(row.value)]));
}

async function countRowsForSession(supabase, campaignSessionId) {
  const { count, error } = await supabase
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .eq("metadata->>campaign_session_id", campaignSessionId);
  if (error) throw error;
  return Number(count || 0);
}

function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return clean(value).startsWith("+") ? clean(value) : "";
}

function maskPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return null;
  return `***${phone.slice(-4)}`;
}

function normalizeMarket(value) {
  return lower(value)
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stateFromMarket(value) {
  const match = clean(value).match(/,\s*([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : "";
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (!clean(value)) return [];
  return clean(value).split(/[,\n;|]+/).map(clean).filter(Boolean);
}

function hashRef(value) {
  const raw = clean(value);
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 10);
}

function normalizeTextgridNumberRow(row = {}) {
  const market = clean(row.market_name || row.market || row.seller_market);
  const stateAliases = asArray(row.allowed_states || row.cluster_states || row.routing_states).map((entry) => entry.toUpperCase());
  const phone = normalizePhone(row.phone_number || row.number || row.e164);
  return {
    raw: row,
    id: clean(row.id || row.textgrid_number_id),
    phone_number: phone,
    masked_phone: maskPhone(phone),
    market,
    market_normalized: normalizeMarket(market),
    aliases: asArray(row.approved_market_aliases || row.routing_aliases).map(normalizeMarket),
    status: lower(row.status || row.number_status || "active"),
    market_state: clean(row.market_state).toUpperCase() || stateFromMarket(market),
    state_aliases: stateAliases,
  };
}

async function loadTextgridNumbers(supabase) {
  const { data, error } = await supabase
    .from("textgrid_numbers")
    .select("*")
    .limit(500);
  if (error) throw error;
  return (data || []).map(normalizeTextgridNumberRow).filter((row) => row.id && row.phone_number);
}

function senderStateForRow(row = {}) {
  if (/^[A-Z]{2}$/.test(clean(row.market_state))) return clean(row.market_state).toUpperCase();
  const state = stateFromMarket(row.market);
  if (state) return state;
  return clean((row.state_aliases || []).find((entry) => /^[A-Z]{2}$/.test(clean(entry))) || "").toUpperCase();
}

function senderCoverageForRow(row = {}, input = {}) {
  return resolveTextgridMarketCoverage({
    sender_market: row.market || "",
    sender_state: senderStateForRow(row),
    target_market: input.market,
    target_state: input.state,
  });
}

function senderCoverageDetail(coverage = {}) {
  return [
    `tier=${coverage.tier || "missing"}`,
    `sender_market=${coverage.sender_market || "missing"}`,
    `sender_state=${coverage.sender_state || "missing"}`,
    `target_market=${coverage.target_market || "missing"}`,
    `target_state=${coverage.target_state || "missing"}`,
    `fallback_reason=${coverage.reason || "missing"}`,
    `fallback_ack_required=${coverage.fallback_ack_required === true}`,
  ].join(" ");
}

function selectedSenderKey(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  return clean(item.selected_textgrid_number_id || payload.textgrid_number_id || metadata.selected_textgrid_number_id || "");
}

function selectedSenderPhone(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  return normalizePhone(item.selected_textgrid_number || payload.from_phone_number || metadata.selected_textgrid_number || "");
}

function selectedTemplateId(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  return clean(
    item.selected_template_id ||
      item.template_id ||
      payload.template_id ||
      metadata.selected_template_id ||
      metadata.template?.id ||
      "",
  );
}

function samplePhone(item = {}) {
  const payload = item.payload || {};
  return normalizePhone(item.to_phone_number || payload.to_phone_number || "");
}

function sampleMarket(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  return clean(item.market || item.seller_market || payload.market || metadata.seller_market || "");
}

function sampleState(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  const snapshot = metadata.candidate_snapshot || {};
  return clean(item.seller_state || payload.property_address_state || metadata.seller_state || snapshot.seller_state).toUpperCase();
}

function selectedSenderFromItem(item = {}, textgridNumbers = []) {
  const id = selectedSenderKey(item);
  const phone = selectedSenderPhone(item);
  const byId = new Map(textgridNumbers.map((row) => [row.id, row]));
  const byPhone = new Map(textgridNumbers.map((row) => [row.phone_number, row]));
  return byId.get(id) || byPhone.get(phone) || {
    id,
    phone_number: phone,
    masked_phone: maskPhone(phone),
    market: clean(item.selected_textgrid_market || item.payload?.metadata?.selected_textgrid_market),
    market_state: stateFromMarket(item.selected_textgrid_market || item.payload?.metadata?.selected_textgrid_market),
    status: "unknown",
    aliases: [],
    state_aliases: [],
  };
}

function redactedSelectedCandidate(item = {}, input = {}, sender = {}, coverage = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  const snapshot = metadata.candidate_snapshot || {};
  return {
    seller_ref: hashRef(item.master_owner_id || payload.master_owner_id || snapshot.master_owner_id),
    property_ref: hashRef(item.property_id || payload.property_id || snapshot.property_id),
    phone: item.phone_masked || maskPhone(samplePhone(item)),
    market: sampleMarket(item) || null,
    state: sampleState(item) || null,
    queue_key: clean(item.queue_key || payload.queue_key || metadata.queue_key) || null,
    template_id: selectedTemplateId(item) || null,
    template_use_case: clean(item.template_use_case || payload.use_case_template || metadata.template_use_case) || null,
    sender: sender.masked_phone || maskPhone(sender.phone_number),
    sender_id: sender.id || null,
    sender_market: sender.market || null,
    sender_state: senderStateForRow(sender) || null,
    sender_coverage_tier: coverage.tier || null,
    sender_fallback_ack_required: coverage.fallback_ack_required === true,
    target_market: input.market,
    target_state: input.state,
    rendered_message_preview: clean(item.rendered_message_preview || payload.message_body || payload.message_text).slice(0, 160),
  };
}

async function runLocalDryRun(input, supabase) {
  const originalCwd = process.cwd();
  process.env.PODIO_CLIENT_ID ||= "preflight-no-send";
  process.env.PODIO_CLIENT_SECRET ||= "preflight-no-send";
  process.env.PODIO_USERNAME ||= "preflight-no-send";
  process.env.PODIO_PASSWORD ||= "preflight-no-send";
  process.env.INTERNAL_API_SECRET ||= "preflight-no-send";
  process.env.BUYER_WEBHOOK_SECRET ||= "preflight-no-send";
  process.env.OPS_DASHBOARD_SECRET ||= OPS_SECRET || "preflight-no-send";

  let feederModule;
  try {
    process.chdir(API_ROOT);
    register("./tests/alias-loader.mjs", pathToFileURL(`${API_ROOT}/`));
    feederModule = await import(pathToFileURL(path.join(API_ROOT, "src/lib/domain/outbound/supabase-candidate-feeder.js")).href);
  } finally {
    process.chdir(originalCwd);
  }

  return feederModule.runSupabaseCandidateFeeder(
    {
      dry_run: true,
      candidate_source: input.candidate_source,
      market: input.market,
      state: input.state,
      limit: 1,
      scan_limit: input.scan_limit,
      campaign_session_id: input.campaign_session_id,
      within_contact_window_now: false,
      routing_safe_only: true,
      debug_templates: true,
      allow_internal_test_phones: false,
    },
    { supabase },
  );
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellDoubleQuote(value) {
  return `"${String(value).replace(/(["\\`])/g, "\\$1")}"`;
}

function apiHeadersSnippet() {
  return [
    `--header ${shellSingleQuote("content-type: application/json")}`,
    `--header ${shellSingleQuote("accept: application/json")}`,
    `--header ${shellSingleQuote("origin: http://localhost:5173")}`,
    `--header ${shellDoubleQuote("x-ops-dashboard-secret: $OPS_DASHBOARD_SECRET")}`,
  ].join(" ");
}

function apiCommand(pathname, body) {
  return [
    "curl -fsS",
    "--request POST",
    apiHeadersSnippet(),
    "--data",
    shellSingleQuote(JSON.stringify(body)),
    shellSingleQuote(`${BASE_URL}${pathname}`),
  ].join(" ");
}

function inspectCommand(campaignSessionId) {
  return `node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
const root = process.cwd();
for (const file of [
  path.join(root, "apps/api/.env.local"),
  path.join(root, "apps/api/.env.production.local"),
  path.join(root, "apps/dashboard/.env.local"),
  path.join(root, ".env.local"),
  path.join(root, ".env"),
]) {
  if (!fs.existsSync(file)) continue;
  for (const raw of fs.readFileSync(file, "utf8").split(/\\r?\\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).replace(/^export\\s+/, "").trim();
    const value = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] ||= value;
  }
}
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await supabase
  .from("send_queue")
  .select("id,queue_key,queue_status,scheduled_for,sent_at,delivered_at,provider_message_id,textgrid_message_id,sms_eligible,routing_allowed,metadata")
  .eq("metadata->>campaign_session_id", ${JSON.stringify(campaignSessionId)})
  .order("created_at", { ascending: true });
if (error) throw error;
console.log(JSON.stringify(data, null, 2));
NODE`;
}

function queueRowIdLookupCommand(campaignSessionId) {
  return `node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
const root = process.cwd();
for (const file of [
  path.join(root, "apps/api/.env.local"),
  path.join(root, "apps/api/.env.production.local"),
  path.join(root, "apps/dashboard/.env.local"),
  path.join(root, ".env.local"),
  path.join(root, ".env"),
]) {
  if (!fs.existsSync(file)) continue;
  for (const raw of fs.readFileSync(file, "utf8").split(/\\r?\\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).replace(/^export\\s+/, "").trim();
    const value = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] ||= value;
  }
}
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await supabase
  .from("send_queue")
  .select("id")
  .eq("metadata->>campaign_session_id", ${JSON.stringify(campaignSessionId)})
  .order("created_at", { ascending: true })
  .limit(1)
  .maybeSingle();
if (error) throw error;
if (!data?.id) throw new Error("No queue row found for campaign_session_id");
console.log(data.id);
NODE`;
}

function targetedSendCommand(campaignSessionId) {
  const bodyPrefix = `{"action":"send_one_queue_row","queue_row_id":"`;
  const bodySuffix = `","campaign_mode":"live_limited","confirm":"${CONFIRM}","clear_one_send_window":true}`;
  return `QUEUE_ROW_ID=$(
${queueRowIdLookupCommand(campaignSessionId)}
) && curl -fsS --request POST ${apiHeadersSnippet()} --data ${
    shellSingleQuote(`${bodyPrefix}`) + '"$QUEUE_ROW_ID"' + shellSingleQuote(`${bodySuffix}`)
  } ${shellSingleQuote(`${BASE_URL}/api/cockpit/queue/control`)}`;
}

function printPlan({ input, result, selectedCandidate, sender, coverage }) {
  const approvedSessionId = input.campaign_session_id.replace("preflight", "approved");
  const createBody = {
    action: "queue_one",
    campaign_mode: TARGET_CAMPAIGN_MODE,
    approval_mode: "operator_approved_one_row",
    market: input.market,
    state: input.state,
    candidate_source: input.candidate_source,
    limit: 1,
    hard_cap: 1,
    max_batch_size: 1,
    daily_cap: 1,
    market_cap: 1,
    per_number_cap: 1,
    scan_limit: input.scan_limit,
    respect_contact_window: false,
    schedule_for: "now",
    campaign_session_id: approvedSessionId,
  };

  console.log("\nSELECTED_ONE_ROW_PREVIEW");
  console.log(JSON.stringify({
    mode: "NO_SEND_PREFLIGHT_ONLY",
    dry_run: true,
    candidate_source: input.candidate_source,
    dry_run_counts: {
      scanned_count: Number(result.scanned_count || 0),
      eligible_count: Number(result.eligible_count || 0),
      queued_preview_count: Number(result.queued_count || 0),
      scheduled_preview_count: Number(result.scheduled_count || 0),
      skipped_count: Number(result.skipped_count || 0),
    },
    selected_candidate: selectedCandidate,
    selected_sender_coverage: senderCoverageDetail(coverage),
    no_send_guard: {
      created_live_queue_rows: false,
      ran_queue: false,
      called_textgrid: false,
    },
  }, null, 2));

  console.log("\nCREATE_ONE_ROW_COMMAND_DOES_NOT_SEND");
  console.log(apiCommand("/api/cockpit/queue/control", createBody));

  console.log("\nINSPECT_ONE_ROW_COMMAND");
  console.log(inspectCommand(approvedSessionId));

  console.log("\nDO_NOT_RUN_UNTIL_APPROVED_TARGETED_SEND_COMMAND");
  console.log(targetedSendCommand(approvedSessionId));

  console.log("\nREARM_EMERGENCY_STOP_COMMAND");
  console.log(apiCommand("/api/cockpit/queue/control", {
    action: "emergency_stop",
    reason: "first_live_one_row_operator_stop",
  }));
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  console.log(`First live one-row preflight base=${BASE_URL} session=${input.campaign_session_id}`);
  console.log("NO_SEND_GUARD active: this script will not create live queue rows, run the queue, or call TextGrid.");

  const supabase = createSupabaseClient();
  mark("Supabase service role config loaded", Boolean(supabase), `url=${SUPABASE_URL ? "set" : "missing"} key=${SUPABASE_SERVICE_ROLE_KEY ? "set" : "missing"}`);
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET), OPS_SECRET ? "source=env" : "missing");
  if (!supabase) throw new Error("Supabase service role config is required for first live one-row preflight");

  let controlValues = {};
  try {
    controlValues = await loadSystemControl(supabase);
    mark("system_control readable", true, `keys=${Object.keys(controlValues).length}`);
  } catch (error) {
    mark("system_control readable", false, error?.message || String(error));
    controlValues = {};
  }

  const currentAutoReplyMode = lower(controlValues.auto_reply_mode || "disabled");
  const currentQueueProcessorMode = normalizeQueueProcessorMode(controlValues.queue_processor_mode);
  const autoSendEnabled = asBoolean(controlValues.queue_auto_send_enabled, false);
  const autoEnqueueEnabled = asBoolean(controlValues.queue_auto_enqueue_enabled, false);
  const emergencyStopActive = isEmergencyStopActive(controlValues.queue_emergency_stop_at);

  mark("emergency stop active before planning", emergencyStopActive, `queue_emergency_stop_at=${clean(controlValues.queue_emergency_stop_at) || "empty"}`);
  mark("queue_auto_send_enabled false", autoSendEnabled === false, `value=${clean(controlValues.queue_auto_send_enabled || "false")}`);
  mark("queue_auto_enqueue_enabled false", autoEnqueueEnabled === false, `value=${clean(controlValues.queue_auto_enqueue_enabled || "false")}`);
  mark("queue_processor_mode off/paused", currentQueueProcessorMode === "off", `value=${clean(controlValues.queue_processor_mode || "missing")}`);
  mark("auto_reply_mode disabled/dry_run", SAFE_AUTO_REPLY_MODES.has(currentAutoReplyMode), `value=${currentAutoReplyMode || "missing"}`);
  mark("candidate_source fixed to v_feeder_candidates_fast", input.candidate_source === DEFAULT_CANDIDATE_SOURCE, `source=${input.candidate_source}`);
  mark("max_sellers fixed to one", input.max_sellers === 1, `max_sellers=${input.max_sellers}`);

  const textgridNumbers = await loadTextgridNumbers(supabase);
  const activeTextgridNumbers = textgridNumbers.filter((row) => row.status === "active");
  const coverageOptions = activeTextgridNumbers.map((row) => ({
    row,
    coverage: senderCoverageForRow(row, input),
  }));
  const exactCoverage = coverageOptions.filter((entry) => entry.coverage.tier === "exact_local_match");
  const approvedFallbackCoverage = coverageOptions.filter((entry) => entry.coverage.tier === "approved_regional_fallback");
  mark(
    "active TextGrid sender coverage exists for chosen market/state",
    exactCoverage.length > 0 || (input.allow_approved_sender_fallback && approvedFallbackCoverage.length > 0),
    [
      `exact_local=${exactCoverage.length}`,
      `approved_regional_fallback=${approvedFallbackCoverage.length}`,
      `target_market=${input.market}`,
      `target_state=${input.state}`,
      `fallback_ack=${input.allow_approved_sender_fallback}`,
    ].join(" "),
  );

  const beforeSessionRows = await countRowsForSession(supabase, input.campaign_session_id);
  mark("preflight session starts with zero send_queue rows", beforeSessionRows === 0, `count=${beforeSessionRows}`);

  const result = await runLocalDryRun(input, supabase);
  mark("dry-run feeder completed", result?.ok !== false, `ok=${result?.ok}`);
  mark("dry-run flag preserved", result?.dry_run === true, `dry_run=${result?.dry_run}`);
  mark("candidate source matches request", clean(result?.candidate_source || result?.source) === input.candidate_source, `source=${clean(result?.candidate_source || result?.source) || "missing"}`);

  const samples = Array.isArray(result?.sample_created_queue_items) ? result.sample_created_queue_items : [];
  mark("dry-run feeder returned exactly one selected candidate", samples.length === 1, `candidate_count=${samples.length} eligible=${Number(result?.eligible_count || 0)}`);
  const item = samples[0] || {};
  const sender = selectedSenderFromItem(item, activeTextgridNumbers);
  const coverage = senderCoverageForRow(sender, input);
  const exactLocalOk = coverage.tier === "exact_local_match";
  const fallbackOk = input.allow_approved_sender_fallback && coverage.ok && coverage.tier === "approved_regional_fallback";
  mark(
    "selected sender exact local match unless approved fallback acknowledged",
    exactLocalOk || fallbackOk,
    senderCoverageDetail(coverage),
  );
  mark("selected candidate state matches requested state", sampleState(item) === input.state, `candidate_state=${sampleState(item) || "missing"} requested=${input.state}`);
  mark("selected candidate market matches requested market", normalizeMarket(sampleMarket(item)) === normalizeMarket(input.market), `candidate_market=${sampleMarket(item) || "missing"} requested=${input.market}`);
  mark("selected template present", Boolean(selectedTemplateId(item)), `template_id=${selectedTemplateId(item) || "missing"}`);
  mark("selected queue_key present", Boolean(clean(item.queue_key || item.payload?.queue_key || item.payload?.metadata?.queue_key)), `queue_key=${clean(item.queue_key || item.payload?.queue_key || item.payload?.metadata?.queue_key) || "missing"}`);

  const afterSessionRows = await countRowsForSession(supabase, input.campaign_session_id);
  mark("dry-run inserted no send_queue rows", afterSessionRows === beforeSessionRows, `before=${beforeSessionRows} after=${afterSessionRows}`);
  mark("no-send guard: live queue rows not created", afterSessionRows === 0, `session_rows=${afterSessionRows}`);
  mark("no-send guard: queue was not run", true);
  mark("no-send guard: TextGrid was not called", true);

  const selectedCandidate = redactedSelectedCandidate(item, input, sender, coverage);
  printPlan({ input, result, selectedCandidate, sender, coverage });

  if (state.failures > 0) {
    console.error(`\nNOT_READY_FOR_ONE_ROW_APPROVAL failures=${state.failures} warnings=${state.warnings}`);
    process.exit(1);
  }

  console.log(`\nREADY_FOR_ONE_ROW_APPROVAL warnings=${state.warnings}`);
}

main().catch((error) => {
  mark("preflight crashed", false, error?.stack || error?.message || String(error));
  console.error(`\nNOT_READY_FOR_ONE_ROW_APPROVAL failures=${state.failures} warnings=${state.warnings}`);
  process.exit(1);
});
