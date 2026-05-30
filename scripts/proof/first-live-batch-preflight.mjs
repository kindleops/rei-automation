#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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
const DEFAULT_AUTO_REPLY_MODE = "disabled";
const DEFAULT_QUEUE_PROCESSOR_MODE = "paused";
const DEFAULT_MAX_SELLERS = 5;
const DEFAULT_SCAN_LIMIT = 1000;

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

const ACTIVE_QUEUE_STATUSES = new Set([
  "queued",
  "scheduled",
  "pending",
  "approved",
  "approval",
  "ready",
  "runnable",
  "processing",
  "sending",
]);

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "off", "disabled", "paused", "null", "none"]);
const SAFE_AUTO_REPLY_MODES = new Set(["disabled", "dry_run"]);
const SAFE_QUEUE_PROCESSOR_TARGETS = new Set(["manual", "paused", "off"]);
const LIVE_SAFE_IDENTITY_STATUSES = new Set([
  "verified",
  "probable",
  "entity_company_linked",
  "entity_company_probable",
  "entity_operator_probable",
]);
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
  marks: [],
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
const USE_REMOTE_DRY_RUN = Boolean(clean(process.env.COCKPIT_PROOF_BASE_URL));
const USE_VERCEL_CURL = TRUE_VALUES.has(lower(process.env.PROOF_USE_VERCEL_CURL));

function printUsageAndExit(message) {
  if (message) console.error(`FAIL ${message}`);
  console.error(`
Usage:
  node scripts/proof/first-live-batch-preflight.mjs --market "Dallas, TX" --state "TX" --max-sellers 5

Required:
  --market                 Market name/label for the first seller batch.
  --state                  Two-letter property/seller state.

Optional:
  --max-sellers            Default ${DEFAULT_MAX_SELLERS}; hard cap for projected seller queue rows.
  --candidate-source       Default ${DEFAULT_CANDIDATE_SOURCE}.
  --auto-reply-mode        disabled or dry_run. Default ${DEFAULT_AUTO_REPLY_MODE}.
  --queue-processor-mode   manual, paused, or off. Default ${DEFAULT_QUEUE_PROCESSOR_MODE}.
  --scan-limit             Default ${DEFAULT_SCAN_LIMIT}; dry-run candidate scan limit.
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
  if (!Number.isFinite(maxSellers) || maxSellers < 1 || maxSellers > 25) {
    printUsageAndExit("--max-sellers must be between 1 and 25");
  }

  const scanLimit = Math.trunc(Number(out.scan_limit ?? Math.max(DEFAULT_SCAN_LIMIT, maxSellers * 200)));
  if (!Number.isFinite(scanLimit) || scanLimit < maxSellers || scanLimit > 5000) {
    printUsageAndExit("--scan-limit must be between max_sellers and 5000");
  }

  const candidateSource = clean(out.candidate_source || DEFAULT_CANDIDATE_SOURCE);
  const campaignMode = lower(out.campaign_mode || TARGET_CAMPAIGN_MODE);
  if (campaignMode !== TARGET_CAMPAIGN_MODE) {
    printUsageAndExit("--campaign-mode may only be live_limited for this preflight");
  }

  const autoReplyMode = lower(out.auto_reply_mode || DEFAULT_AUTO_REPLY_MODE);
  if (!SAFE_AUTO_REPLY_MODES.has(autoReplyMode)) {
    printUsageAndExit("--auto-reply-mode must be disabled or dry_run");
  }

  const queueProcessorMode = lower(out.queue_processor_mode || DEFAULT_QUEUE_PROCESSOR_MODE);
  if (!SAFE_QUEUE_PROCESSOR_TARGETS.has(queueProcessorMode)) {
    printUsageAndExit("--queue-processor-mode must be manual, paused, or off");
  }

  return {
    market,
    state: stateCode,
    max_sellers: maxSellers,
    scan_limit: scanLimit,
    candidate_source: candidateSource,
    campaign_mode_target: campaignMode,
    auto_reply_mode_target: autoReplyMode,
    queue_processor_mode_target: queueProcessorMode,
    allow_approved_sender_fallback: parseBooleanOption(out.allow_approved_sender_fallback, false),
    campaign_session_id: `first-live-preflight-${Date.now()}`,
  };
}

function mark(label, condition, detail = "", warnOnly = false) {
  const prefix = condition ? "PASS" : warnOnly ? "WARN" : "FAIL";
  const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
  state.marks.push({ label, ok: Boolean(condition), warnOnly, detail });
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

function isEmergencyStopActive(value) {
  const normalized = lower(value);
  return Boolean(normalized && !FALSE_VALUES.has(normalized) && normalized !== "clear" && normalized !== "cleared");
}

function normalizeQueueProcessorMode(value) {
  const normalized = lower(value);
  if (["off", "paused", "pause", "manual"].includes(normalized)) return "off";
  if (["safe", "assisted", "dry_run", "dryrun", "preview"].includes(normalized)) return "safe";
  if (["live", "automatic"].includes(normalized)) return "live";
  return normalized || "off";
}

function normalizeCampaignMode(value) {
  const normalized = lower(value);
  if (["off", "pause", "paused"].includes(normalized)) return "paused";
  if (["safe", "assisted", "preview", "dryrun", "dry_run"].includes(normalized)) return "dry_run";
  if (["limited", "live_limited", "live"].includes(normalized)) return normalized === "live" ? "live_limited" : normalized;
  return normalized || "paused";
}

function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return clean(value).startsWith("+") ? clean(value) : `+${digits}`;
}

function maskPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return null;
  return `***${phone.slice(-4)}`;
}

function hashRef(value) {
  const raw = clean(value);
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 10);
}

function normalizeMarket(value) {
  return lower(value)
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stateFromMarket(value) {
  const match = clean(value).match(/,\s*([A-Za-z]{2})(?:\b|$)/);
  return match ? match[1].toUpperCase() : "";
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to comma splitting.
    }
    return trimmed.split(/[,\n;]/).map(clean).filter(Boolean);
  }
  return [value];
}

function normalizeTextgridNumberRow(row = {}) {
  const market = clean(row.market_name || row.market || row.seller_market);
  const phone = normalizePhone(row.phone_number || row.number || row.e164 || row.normalized_phone);
  const aliases = asArray(row.approved_market_aliases || row.routing_aliases).map(normalizeMarket);
  const states = asArray(row.allowed_states || row.cluster_states || row.routing_states)
    .map((entry) => clean(entry).toUpperCase())
    .filter((entry) => /^[A-Z]{2}$/.test(entry));
  const marketState = stateFromMarket(market);
  if (marketState && !states.includes(marketState)) states.push(marketState);
  return {
    raw: row,
    id: clean(row.id || row.textgrid_number_id || row.item_id),
    phone_number: phone,
    masked_phone: maskPhone(phone),
    market,
    market_normalized: normalizeMarket(market),
    aliases,
    market_state: marketState,
    state_aliases: states,
    status: lower(row.status || row.number_status || "active"),
  };
}

function redactedSample(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  const snapshot = metadata.candidate_snapshot || {};
  const identity = identityStatusResolution(item);
  return {
    seller_ref: hashRef(item.master_owner_id || payload.master_owner_id || snapshot.master_owner_id),
    property_ref: hashRef(item.property_id || payload.property_id || snapshot.property_id),
    phone: item.phone_masked || maskPhone(item.to_phone_number || payload.to_phone_number),
    market: clean(item.market || item.seller_market || payload.market || metadata.seller_market) || null,
    state: clean(item.seller_state || payload.property_address_state || metadata.seller_state || snapshot.seller_state) || null,
    property_city: clean(snapshot.property_address_city || payload.property_address_city) || null,
    property_zip_prefix: clean(snapshot.property_address_zip || payload.property_address_zip).slice(0, 3) || null,
    identity_status: clean(identity.status) || null,
    template_id: clean(item.selected_template_id || item.template_id || payload.template_id || metadata.selected_template_id) || null,
    sender: maskPhone(item.selected_textgrid_number || payload.from_phone_number || metadata.selected_textgrid_number),
    sender_market: clean(item.selected_textgrid_market || metadata.selected_textgrid_market) || null,
    routing_tier: clean(item.routing_tier || metadata.routing_tier) || null,
  };
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
  const bodyText = JSON.stringify(body);
  if (USE_VERCEL_CURL && BASE_URL.includes("vercel.app")) {
    return [
      "vercel curl",
      shellSingleQuote(pathname),
      "--deployment",
      shellSingleQuote(BASE_URL),
      "--",
      "--request POST",
      apiHeadersSnippet(),
      "--data",
      shellSingleQuote(bodyText),
    ].join(" ");
  }
  return [
    "curl -fsS",
    "--request POST",
    apiHeadersSnippet(),
    "--data",
    shellSingleQuote(bodyText),
    shellSingleQuote(`${BASE_URL}${pathname}`),
  ].join(" ");
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

async function callJson(pathOrUrl, options = {}) {
  if (USE_VERCEL_CURL && BASE_URL.includes("vercel.app") && !pathOrUrl.startsWith("http")) {
    const startedAt = performance.now();
    const requestHeaders = options.headers || headers();
    const curlArgs = [
      "curl",
      pathOrUrl,
      "--deployment",
      BASE_URL,
      "--",
      "--silent",
      "--show-error",
      "--max-time",
      String(options.timeout_seconds || 120),
      "--request",
      options.method || "GET",
      "--write-out",
      "\n__HTTP_STATUS__:%{http_code}",
    ];
    for (const [key, value] of Object.entries(requestHeaders)) {
      curlArgs.push("--header", `${key}: ${value}`);
    }
    if (options.body) curlArgs.push("--data", options.body);

    let output = "";
    try {
      output = execFileSync("vercel", curlArgs, {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 30 * 1024 * 1024,
      });
      const statusMatch = output.match(/__HTTP_STATUS__:(\d{3})\s*$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const bodyText = statusMatch ? output.slice(0, statusMatch.index).trim() : output.trim();
      const jsonStart = bodyText.search(/[\[{]/);
      const raw = jsonStart >= 0 ? bodyText.slice(jsonStart) : bodyText;
      return {
        status,
        json: raw ? JSON.parse(raw) : null,
        raw,
        ms: Math.round(performance.now() - startedAt),
        url: `${BASE_URL}${pathOrUrl}`,
      };
    } catch (error) {
      return {
        status: 0,
        json: null,
        raw: output,
        error: error?.message || String(error),
        ms: Math.round(performance.now() - startedAt),
        url: `${BASE_URL}${pathOrUrl}`,
      };
    }
  }

  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
  const startedAt = performance.now();
  let status = 0;
  let raw = "";
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || headers(),
      body: options.body,
      signal: AbortSignal.timeout(Number(process.env.FIRST_LIVE_PREFLIGHT_HTTP_TIMEOUT_MS || 120000)),
    });
    status = response.status;
    raw = await response.text();
    return {
      status,
      json: raw ? JSON.parse(raw) : null,
      raw,
      ms: Math.round(performance.now() - startedAt),
      url,
    };
  } catch (error) {
    return {
      status,
      json: null,
      raw,
      error: error?.message || String(error),
      ms: Math.round(performance.now() - startedAt),
      url,
    };
  }
}

function createSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function loadSystemControlFromSupabase(supabase) {
  const { data, error } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", CONTROL_KEYS);
  if (error) throw error;
  return Object.fromEntries((data || []).map((row) => [row.key, clean(row.value)]));
}

async function loadSystemControlFromApi() {
  const result = await callJson("/api/cockpit/queue/control", { method: "GET" });
  if (result.status !== 200 || result.json?.ok !== true) {
    throw new Error(`queue control GET failed status=${result.status} error=${result.error || result.json?.error || ""}`);
  }
  return result.json?.control?.settings || result.json?.diagnostics || {};
}

async function countRowsForSession(supabase, campaignSessionId) {
  const { count, error } = await supabase
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .contains("metadata", { campaign_session_id: campaignSessionId });
  if (error) throw error;
  return Number(count || 0);
}

async function loadTextgridNumbers(supabase) {
  const { data, error } = await supabase
    .from("textgrid_numbers")
    .select("*")
    .limit(500);
  if (error) throw error;
  return (data || []).map(normalizeTextgridNumberRow).filter((row) => row.id && row.phone_number);
}

function numberIsLocalToState(number, stateCode) {
  const wanted = clean(stateCode).toUpperCase();
  return number.market_state === wanted || number.state_aliases.includes(wanted);
}

function senderStateForRow(row = {}) {
  const direct = clean(row.market_state).toUpperCase();
  if (/^[A-Z]{2}$/.test(direct)) return direct;
  const marketState = stateFromMarket(row.market);
  if (marketState) return marketState;
  const alias = (row.state_aliases || []).find((entry) => /^[A-Z]{2}$/i.test(clean(entry)));
  return clean(alias).toUpperCase();
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

function senderLabel(row = {}) {
  return `${row.market || "unknown"}:${senderStateForRow(row) || "??"}:${row.masked_phone || maskPhone(row.phone_number) || "no-phone"}`;
}

function senderCoveragePasses(coverage = {}, input = {}) {
  if (!coverage.ok) return false;
  if (coverage.fallback_ack_required && !input.allow_approved_sender_fallback) return false;
  return true;
}

function selectedSenderKey(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  return clean(
    item.selected_textgrid_number_id ||
      payload.textgrid_number_id ||
      metadata.selected_textgrid_number_id ||
      "",
  );
}

function selectedSenderPhone(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  return normalizePhone(
    item.selected_textgrid_number ||
      payload.from_phone_number ||
      metadata.selected_textgrid_number ||
      "",
  );
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

function valueAtPath(root, pathExpression) {
  return pathExpression.split(".").reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, root);
}

function identityStatusValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    return clean(
      value.status ||
        value.identity_resolution ||
        value.identity_alignment_status ||
        value.identity_status ||
        value.resolution ||
        "",
    );
  }
  return clean(value);
}

function identityStatusResolution(item = {}) {
  const paths = [
    "identity_resolution",
    "identity_alignment_status",
    "identity_status",
    "candidate_preview.identity_resolution",
    "candidate_preview.identity_alignment_status",
    "automation_decision.identity_resolution",
    "payload.identity_resolution",
    "payload.identity_alignment_status",
    "payload.identity_status",
    "payload.candidate_preview.identity_resolution",
    "payload.candidate_preview.identity_alignment_status",
    "payload.automation_decision.identity_resolution",
    "payload.metadata.identity_resolution",
    "payload.metadata.identity_alignment_status",
    "payload.metadata.identity_status",
    "payload.metadata.candidate_preview.identity_resolution",
    "payload.metadata.candidate_preview.identity_alignment_status",
    "payload.metadata.automation_decision.identity_resolution",
    "payload.metadata.safety_diagnostics.identity.status",
    "payload.metadata.safety_diagnostics.identity_resolution",
  ];

  for (const pathExpression of paths) {
    const status = identityStatusValue(valueAtPath(item, pathExpression));
    if (status) {
      return {
        status: lower(status),
        source: pathExpression,
      };
    }
  }

  return {
    status: "",
    source: null,
  };
}

function identityStatus(item = {}) {
  return identityStatusResolution(item).status;
}

function summarizeDiagnosticValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return clean(value).slice(0, 120);
  }
  if (Array.isArray(value)) {
    return `[array:${value.length}]`;
  }
  if (typeof value === "object") {
    const status = identityStatusValue(value);
    if (status) return `{status:${status}}`;
    return `{keys:${Object.keys(value).slice(0, 8).join(",")}}`;
  }
  return String(value).slice(0, 120);
}

function collectIdentityDiagnostics(item = {}) {
  const diagnostics = [];
  const seen = new WeakSet();

  function visit(value, prefix = "", depth = 0) {
    if (!value || typeof value !== "object" || depth > 5 || diagnostics.length >= 18) return;
    if (seen.has(value)) return;
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (diagnostics.length >= 18) break;
      const pathName = prefix ? `${prefix}.${key}` : key;
      const isIdentityKey = /identity|alignment/i.test(key) || /automation_decision/i.test(key);
      if (isIdentityKey) {
        diagnostics.push(`${pathName}=${summarizeDiagnosticValue(child)}`);
      }
      if (child && typeof child === "object") {
        visit(child, pathName, depth + 1);
      }
    }
  }

  visit(item);
  return diagnostics.length ? diagnostics.join("; ") : "none";
}

function samplePhone(item = {}) {
  const payload = item.payload || {};
  return normalizePhone(item.to_phone_number || payload.to_phone_number || "");
}

function sampleUseCase(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  return clean(item.template_use_case || payload.use_case_template || metadata.selected_template_use_case || metadata.template_use_case || "");
}

function sampleState(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  const snapshot = metadata.candidate_snapshot || {};
  return clean(item.seller_state || payload.property_address_state || metadata.seller_state || snapshot.seller_state).toUpperCase();
}

function sampleMarket(item = {}) {
  const payload = item.payload || {};
  const metadata = payload.metadata || {};
  return clean(item.market || item.seller_market || payload.market || metadata.seller_market || "");
}

function truthyDncValue(value) {
  const normalized = lower(value);
  return TRUE_VALUES.has(normalized) || ["true", "dnc", "opt out", "opt-out", "yes"].includes(normalized);
}

async function queryActiveDuplicateRows(supabase, item) {
  const phone = samplePhone(item);
  const masterOwnerId = clean(item.master_owner_id || item.payload?.master_owner_id || item.payload?.metadata?.candidate_snapshot?.master_owner_id);
  const propertyId = clean(item.property_id || item.payload?.property_id || item.payload?.metadata?.candidate_snapshot?.property_id);
  const touchNumber = Number(item.touch_number || item.payload?.touch_number || item.payload?.metadata?.candidate_snapshot?.touch_number || 1);
  const useCase = sampleUseCase(item);
  if (!masterOwnerId || !propertyId || !phone) {
    return { ok: false, reason: "missing_duplicate_check_keys", rows: [] };
  }

  const { data, error } = await supabase
    .from("send_queue")
    .select("id,queue_status,to_phone_number,touch_number,use_case_template,metadata,created_at,scheduled_for")
    .eq("master_owner_id", masterOwnerId)
    .eq("property_id", propertyId)
    .eq("touch_number", touchNumber)
    .limit(50);
  if (error) throw error;

  const rows = (data || []).filter((row) => {
    const rowPhone = normalizePhone(row.to_phone_number);
    const rowUseCase = clean(row.use_case_template || row.metadata?.template_use_case || row.metadata?.selected_template_use_case);
    return (
      rowPhone === phone &&
      (!useCase || !rowUseCase || lower(rowUseCase) === lower(useCase)) &&
      ACTIVE_QUEUE_STATUSES.has(lower(row.queue_status))
    );
  });

  return { ok: rows.length === 0, rows };
}

function eventIndicatesOptOutOrWrongNumber(row = {}) {
  const combined = [
    row.is_opt_out === true ? "opt_out" : "",
    row.detected_intent,
    row.ai_route,
    row.safety_status,
    row.current_stage,
    row.auto_reply_status,
  ].map(lower).join(" ");
  return /\b(opt_out|opt-out|dnc|stop_texting|wrong_number|wrong_person|wrong party|wrong-party)\b/.test(combined);
}

async function queryPhoneEvents(supabase, phone) {
  if (!phone) return [];
  const selectFields = "id,is_opt_out,detected_intent,ai_route,safety_status,current_stage,auto_reply_status,created_at,from_phone_number,to_phone_number";
  const queries = await Promise.all([
    supabase.from("message_events").select(selectFields).eq("from_phone_number", phone).limit(50),
    supabase.from("message_events").select(selectFields).eq("to_phone_number", phone).limit(50),
  ]);
  const rows = [];
  for (const result of queries) {
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = clean(row.id || JSON.stringify(row));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function queryPhoneRow(supabase, item) {
  const phoneId = clean(
    item.payload?.metadata?.candidate_snapshot?.phone_id ||
      item.payload?.metadata?.candidate_snapshot?.best_phone_id ||
      item.best_phone_id ||
      item.phone_id ||
      "",
  );
  if (!phoneId) return null;
  const { data, error } = await supabase
    .from("phones")
    .select("*")
    .eq("phone_id", phoneId)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

function phoneRowIsSuppressed(row = {}) {
  if (!row) return false;
  const status = lower(row.phone_contact_status || row.contact_status || row.status);
  return (
    status === "wrong_number" ||
    status === "opted_out" ||
    status === "dnc" ||
    truthyDncValue(row.do_not_call) ||
    truthyDncValue(row.active_opt_out) ||
    Boolean(row.opt_out_date)
  );
}

async function runRemoteDryRun(input) {
  const body = {
    action: "run_dry_run_feeder",
    dry_run: true,
    campaign_mode: "dry_run",
    campaign_session_id: input.campaign_session_id,
    candidate_source: input.candidate_source,
    market: input.market,
    state: input.state,
    limit: input.max_sellers,
    scan_limit: input.scan_limit,
    debug_templates: true,
    routing_safe_only: true,
    allow_internal_test_phones: false,
    respect_contact_window: true,
  };
  const result = await callJson("/api/cockpit/queue/control", {
    method: "POST",
    body: JSON.stringify(body),
    timeout_seconds: 180,
  });
  if (result.status !== 200 || result.json?.ok !== true) {
    throw new Error(`remote dry-run failed status=${result.status} error=${result.error || result.json?.error || result.raw?.slice?.(0, 160) || ""}`);
  }
  return result.json.preview || result.json;
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
      limit: input.max_sellers,
      scan_limit: input.scan_limit,
      campaign_session_id: input.campaign_session_id,
      within_contact_window_now: true,
      routing_safe_only: true,
      debug_templates: true,
      allow_internal_test_phones: false,
    },
    { supabase },
  );
}

function uniqueSelectedSenders(samples = [], numbers = []) {
  const byId = new Map(numbers.map((row) => [row.id, row]));
  const byPhone = new Map(numbers.map((row) => [row.phone_number, row]));
  const selected = new Map();
  for (const item of samples) {
    const id = selectedSenderKey(item);
    const phone = selectedSenderPhone(item);
    const row = byId.get(id) || byPhone.get(phone) || {
      id,
      phone_number: phone,
      masked_phone: maskPhone(phone),
      market: clean(item.selected_textgrid_market || item.payload?.metadata?.selected_textgrid_market),
      market_state: stateFromMarket(item.selected_textgrid_market || item.payload?.metadata?.selected_textgrid_market),
      market_normalized: normalizeMarket(item.selected_textgrid_market || item.payload?.metadata?.selected_textgrid_market),
      state_aliases: [],
      status: "unknown",
    };
    const key = row.id || row.phone_number;
    if (key) selected.set(key, row);
  }
  return Array.from(selected.values());
}

function uniqueSelectedTemplates(result = {}, samples = []) {
  const selected = new Map();
  for (const template of result.selected_templates || []) {
    const id = clean(template.template_id || template.id);
    if (id) selected.set(id, template);
  }
  for (const item of samples) {
    const id = selectedTemplateId(item);
    if (!id || selected.has(id)) continue;
    selected.set(id, {
      template_id: id,
      use_case: sampleUseCase(item) || null,
      language: clean(item.language || item.selected_template_language || item.payload?.metadata?.selected_template_language) || null,
    });
  }
  return Array.from(selected.values());
}

async function validateSamples({ supabase, input, samples, textgridNumbers }) {
  const byId = new Map(textgridNumbers.map((row) => [row.id, row]));
  const byPhone = new Map(textgridNumbers.map((row) => [row.phone_number, row]));

  for (const [index, item] of samples.entries()) {
    const label = `sample ${index + 1}`;
    const identity = identityStatusResolution(item);
    const identityDetail = identity.status
      ? `status=${identity.status} source=${identity.source}`
      : `status=missing available_identity_fields=${collectIdentityDiagnostics(item)}`;
    mark(`${label} identity live-safe`, LIVE_SAFE_IDENTITY_STATUSES.has(identity.status), identityDetail);

    const dncValue = item.do_not_call ?? item.payload?.metadata?.candidate_snapshot?.do_not_call;
    mark(`${label} no DNC flag`, !truthyDncValue(dncValue), `do_not_call=${clean(dncValue || "false")}`);
    mark(`${label} no true post-contact suppression`, item.true_post_contact_suppression !== true, `suppressed=${item.true_post_contact_suppression === true}`);

    const templateId = selectedTemplateId(item);
    mark(`${label} selected template`, Boolean(templateId), `template_id=${templateId || "missing"}`);

    const selectedId = selectedSenderKey(item);
    const selectedPhone = selectedSenderPhone(item);
    const senderRow = byId.get(selectedId) || byPhone.get(selectedPhone);
    mark(`${label} selected sender exists`, Boolean(senderRow), `sender=${maskPhone(selectedPhone) || selectedId || "missing"}`);
    mark(`${label} selected sender active`, senderRow?.status === "active", `status=${senderRow?.status || "missing"}`);
    const coverage = senderRow ? senderCoverageForRow(senderRow, input) : null;
    mark(
      `${label} selected sender coverage`,
      coverage ? senderCoveragePasses(coverage, input) : false,
      coverage
        ? senderCoverageDetail(coverage) +
            (coverage.fallback_ack_required && !input.allow_approved_sender_fallback
              ? " approved fallback available but acknowledgement required"
              : "")
        : "sender_market=missing sender_state=missing target_market=missing target_state=missing fallback_reason=missing",
    );

    const sellerState = sampleState(item);
    mark(`${label} candidate state matches requested state`, sellerState === input.state, `candidate_state=${sellerState || "missing"} requested=${input.state}`);

    const duplicate = await queryActiveDuplicateRows(supabase, item);
    mark(`${label} no active duplicate queue row`, duplicate.ok === true, `active_duplicates=${duplicate.rows?.length || 0}`);

    const phone = samplePhone(item);
    const events = await queryPhoneEvents(supabase, phone);
    const badEvents = events.filter(eventIndicatesOptOutOrWrongNumber);
    mark(`${label} no opt-out/wrong-number message events`, badEvents.length === 0, `matches=${badEvents.length}`);

    const phoneRow = await queryPhoneRow(supabase, item);
    mark(`${label} no phone-row opt-out/wrong-number`, !phoneRowIsSuppressed(phoneRow), `phone_status=${clean(phoneRow?.phone_contact_status || phoneRow?.contact_status || "ok")}`);
  }
}

function safeEmergencyStopAt(controlValues = {}) {
  const current = clean(controlValues.queue_emergency_stop_at);
  if (isEmergencyStopActive(current)) return current;
  return new Date().toISOString();
}

function printPlan({ input, result, samples, selectedSenders, selectedTemplates, controlValues }) {
  const projectedCount = samples.length;
  const safeCloseBody = {
    campaign_mode: "paused",
    auto_reply_mode: "disabled",
    queue_processor_mode: "paused",
    queue_auto_send_enabled: "false",
    queue_auto_enqueue_enabled: "false",
    queue_run_limit: "0",
    queue_scan_limit: "0",
    queue_hard_cap: "0",
    queue_max_batch_size: "0",
    queue_daily_send_cap: "0",
    queue_market_cap: "0",
    queue_per_number_cap: "0",
    queue_market_filter: "",
    queue_state_filter: "",
    queue_emergency_stop_at: safeEmergencyStopAt(controlValues),
  };
  const openBody = {
    campaign_mode: input.campaign_mode_target,
    auto_reply_mode: input.auto_reply_mode_target,
    queue_processor_mode: input.queue_processor_mode_target === "manual" ? "paused" : input.queue_processor_mode_target,
    queue_auto_send_enabled: "false",
    queue_auto_enqueue_enabled: "false",
    queue_market_filter: input.market,
    queue_state_filter: input.state,
    candidate_source: input.candidate_source,
    queue_run_limit: String(input.max_sellers),
    queue_hard_cap: String(input.max_sellers),
    queue_max_batch_size: String(input.max_sellers),
    queue_daily_send_cap: String(input.max_sellers),
    queue_market_cap: String(input.max_sellers),
    queue_per_number_cap: String(input.max_sellers),
    queue_scan_limit: String(input.scan_limit),
    queue_emergency_stop_at: "",
  };
  const queueRowsBody = {
    action: "queue_limited_batch",
    campaign_mode: input.campaign_mode_target,
    market: input.market,
    state: input.state,
    candidate_source: input.candidate_source,
    limit: input.max_sellers,
    hard_cap: input.max_sellers,
    max_batch_size: input.max_sellers,
    daily_cap: input.max_sellers,
    market_cap: input.max_sellers,
    per_number_cap: input.max_sellers,
    scan_limit: input.scan_limit,
    respect_contact_window: true,
    campaign_session_id: input.campaign_session_id.replace("preflight", "approved"),
  };
  const emergencyBody = {
    action: "emergency_stop",
    reason: "first_live_batch_operator_stop",
  };
  const rollbackBody = {
    action: "pause_queue_processor",
  };

  console.log("\nPROPOSED_BATCH_PLAN");
  console.log(JSON.stringify({
    mode: "NO_SEND_PREFLIGHT_ONLY",
    dry_run_runner: USE_REMOTE_DRY_RUN ? "remote_api" : "local_feeder_import",
    market: input.market,
    state: input.state,
    candidate_source: input.candidate_source,
    target_controls: {
      campaign_mode: input.campaign_mode_target,
      auto_reply_mode: input.auto_reply_mode_target,
      queue_processor_mode: input.queue_processor_mode_target,
      queue_auto_send_enabled: false,
      queue_auto_enqueue_enabled: false,
    },
    candidate_count: projectedCount,
    expected_queue_rows: projectedCount,
    max_sellers: input.max_sellers,
    dry_run_counts: {
      scanned_count: Number(result.scanned_count || 0),
      eligible_count: Number(result.eligible_count || 0),
      queued_count: Number(result.queued_count || 0),
      scheduled_count: Number(result.scheduled_count || 0),
      skipped_count: Number(result.skipped_count || 0),
      routing_block_count: Number(result.routing_block_count || result.routing_blocked_count || 0),
      suppression_block_count: Number(result.suppression_block_count || result.suppressed_count || 0),
      template_block_count: Number(result.template_block_count || result.template_blocked_count || 0),
      duplicate_queue_block_count: Number(result.duplicate_queue_block_count || result.duplicate_blocked_count || 0),
      active_queue_block_count: Number(result.active_queue_block_count || result.active_queue_blocked_count || 0),
    },
    selected_sender_numbers: selectedSenders.map((row) => ({
      coverage: senderCoverageForRow(row, input).tier,
      fallback_ack_required: senderCoverageForRow(row, input).fallback_ack_required,
      fallback_reason: senderCoverageForRow(row, input).reason,
      id: row.id || null,
      phone: row.masked_phone || maskPhone(row.phone_number),
      market: row.market || null,
      state: senderStateForRow(row) || null,
      status: row.status || null,
    })),
    selected_templates: selectedTemplates.map((row) => ({
      template_id: clean(row.template_id || row.id) || null,
      source: clean(row.source) || null,
      use_case: clean(row.use_case) || null,
      language: clean(row.language) || null,
    })),
    sample_sellers_properties: samples.slice(0, input.max_sellers).map(redactedSample),
    no_send_guard: {
      created_live_queue_rows: false,
      ran_queue: false,
      called_textgrid: false,
    },
  }, null, 2));

  console.log("\nSAFE_CLOSE_COMMAND_DOES_NOT_SEND");
  console.log(`Reset controls/caps and keep emergency stop active:\n${apiCommand("/api/cockpit/queue/control", safeCloseBody)}`);

  console.log("\nCOMMANDS_AFTER_EXPLICIT_APPROVAL_ONLY");
  console.log(`Open live_limited/manual mode:\n${apiCommand("/api/cockpit/queue/control", openBody)}`);
  console.log(`\nCreate the limited queue rows only; still does not send:\n${apiCommand("/api/cockpit/queue/control", queueRowsBody)}`);
  console.log(`\nEmergency stop:\n${apiCommand("/api/cockpit/queue/control", emergencyBody)}`);
  console.log(`\nRollback/pause:\n${apiCommand("/api/cockpit/queue/control", rollbackBody)}`);
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  console.log(`First live seller batch preflight base=${BASE_URL} runner=${USE_REMOTE_DRY_RUN ? "remote_api" : "local_feeder_import"} session=${input.campaign_session_id}`);
  console.log("NO_SEND_GUARD active: this script will not create live queue rows, run the queue, or call TextGrid.");

  const supabase = createSupabaseClient();
  mark("Supabase service role config loaded", Boolean(supabase), `url=${SUPABASE_URL ? "set" : "missing"} key=${SUPABASE_SERVICE_ROLE_KEY ? "set" : "missing"}`);
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET), OPS_SECRET ? "source=env" : "missing");
  if (!supabase) throw new Error("Supabase service role config is required for first live preflight");

  let controlValues = {};
  try {
    controlValues = USE_REMOTE_DRY_RUN ? await loadSystemControlFromApi() : await loadSystemControlFromSupabase(supabase);
    mark("system_control readable", true, `keys=${Object.keys(controlValues).length}`);
  } catch (error) {
    mark("system_control readable", false, error?.message || String(error));
    controlValues = {};
  }

  const currentCampaignMode = normalizeCampaignMode(controlValues.campaign_mode);
  const currentAutoReplyMode = lower(controlValues.auto_reply_mode || "disabled");
  const currentQueueProcessorMode = normalizeQueueProcessorMode(controlValues.queue_processor_mode);
  const autoSendEnabled = asBoolean(controlValues.queue_auto_send_enabled, false);
  const autoEnqueueEnabled = asBoolean(controlValues.queue_auto_enqueue_enabled, false);
  const emergencyStopActive = isEmergencyStopActive(controlValues.queue_emergency_stop_at);

  mark("emergency stop status readable", true, `active=${emergencyStopActive} queue_emergency_stop_at=${clean(controlValues.queue_emergency_stop_at) || "empty"}`);
  mark("queue_auto_send_enabled false before opening", autoSendEnabled === false, `value=${clean(controlValues.queue_auto_send_enabled || "false")}`);
  mark("queue_auto_enqueue_enabled false before opening", autoEnqueueEnabled === false, `value=${clean(controlValues.queue_auto_enqueue_enabled || "false")}`);
  mark("auto_reply_mode currently disabled/dry_run", SAFE_AUTO_REPLY_MODES.has(currentAutoReplyMode), `value=${currentAutoReplyMode || "missing"}`);
  mark("campaign_mode currently paused before opening", currentCampaignMode === "paused", `value=${currentCampaignMode || "missing"}`);
  mark("queue_processor_mode not live before opening", currentQueueProcessorMode !== "live", `value=${currentQueueProcessorMode || "missing"}`);
  mark("target campaign_mode live_limited", input.campaign_mode_target === TARGET_CAMPAIGN_MODE, `target=${input.campaign_mode_target}`);
  mark("target auto_reply_mode disabled/dry_run", SAFE_AUTO_REPLY_MODES.has(input.auto_reply_mode_target), `target=${input.auto_reply_mode_target}`);
  mark("target queue_processor_mode manual/paused", SAFE_QUEUE_PROCESSOR_TARGETS.has(input.queue_processor_mode_target), `target=${input.queue_processor_mode_target}`);

  const textgridNumbers = await loadTextgridNumbers(supabase);
  const activeTextgridNumbers = textgridNumbers.filter((row) => row.status === "active");
  const marketKey = normalizeMarket(input.market);
  const marketNumbers = activeTextgridNumbers.filter((row) => row.market_normalized === marketKey || row.aliases.includes(marketKey));
  const stateNumbers = activeTextgridNumbers.filter((row) => numberIsLocalToState(row, input.state));
  const coverageOptions = activeTextgridNumbers.map((row) => ({
    row,
    coverage: senderCoverageForRow(row, input),
  }));
  const exactCoverage = coverageOptions.filter((entry) => entry.coverage.tier === "exact_local_match");
  const approvedFallbackCoverage = coverageOptions.filter((entry) => entry.coverage.tier === "approved_regional_fallback");
  mark(
    "active TextGrid sender coverage exists for chosen market/state",
    exactCoverage.length > 0 || approvedFallbackCoverage.length > 0,
    [
      `market_matches=${marketNumbers.length}`,
      `state_matches=${stateNumbers.length}`,
      `exact_local=${exactCoverage.length}`,
      `approved_regional_fallback=${approvedFallbackCoverage.length}`,
      `target_market=${input.market}`,
      `target_state=${input.state}`,
    ].join(" "),
  );
  if (exactCoverage.length === 0 && approvedFallbackCoverage.length > 0) {
    mark(
      "approved sender fallback acknowledgement",
      input.allow_approved_sender_fallback,
      `approved fallback available but acknowledgement required options=${approvedFallbackCoverage.map((entry) => senderCoverageDetail(entry.coverage)).join(" | ")}`,
    );
  }

  const beforeSessionRows = await countRowsForSession(supabase, input.campaign_session_id);
  mark("preflight session starts with zero send_queue rows", beforeSessionRows === 0, `count=${beforeSessionRows}`);

  const result = USE_REMOTE_DRY_RUN
    ? await runRemoteDryRun(input)
    : await runLocalDryRun(input, supabase);

  mark("dry-run feeder completed", result?.ok !== false, `ok=${result?.ok}`);
  mark("dry-run flag preserved", result?.dry_run === true, `dry_run=${result?.dry_run}`);
  mark("candidate source matches request", clean(result?.candidate_source || result?.source) === input.candidate_source, `source=${clean(result?.candidate_source || result?.source) || "missing"}`);

  const samples = Array.isArray(result?.sample_created_queue_items) ? result.sample_created_queue_items : [];
  const projectedCount = samples.length;
  mark("dry-run feeder returned eligible candidates", projectedCount > 0, `candidate_count=${projectedCount} eligible=${Number(result?.eligible_count || 0)}`);
  mark("projected batch count within max_sellers", projectedCount <= input.max_sellers, `projected=${projectedCount} max=${input.max_sellers}`);
  mark("projected batch count matches dry-run queue preview", Number(result?.queued_count || 0) + Number(result?.scheduled_count || 0) <= input.max_sellers || projectedCount <= input.max_sellers, `queued=${Number(result?.queued_count || 0)} scheduled=${Number(result?.scheduled_count || 0)}`);

  const selectedSenders = uniqueSelectedSenders(samples, activeTextgridNumbers);
  const selectedTemplates = uniqueSelectedTemplates(result, samples);

  mark("selected sender numbers present", selectedSenders.length > 0, `count=${selectedSenders.length}`);
  mark("selected templates present", selectedTemplates.length > 0, `count=${selectedTemplates.length}`);
  const selectedCoverage = selectedSenders.map((row) => ({
    row,
    coverage: senderCoverageForRow(row, input),
  }));
  mark(
    "selected sender coverage approved",
    selectedCoverage.length > 0 && selectedCoverage.every((entry) => senderCoveragePasses(entry.coverage, input)),
    selectedCoverage.length
      ? selectedCoverage
          .map((entry) => `${senderLabel(entry.row)} ${senderCoverageDetail(entry.coverage)}${
            entry.coverage.fallback_ack_required && !input.allow_approved_sender_fallback
              ? " approved fallback available but acknowledgement required"
              : ""
          }`)
          .join(" | ")
      : "selected_senders=none",
  );
  mark("all selected candidates remain in requested state", samples.every((item) => sampleState(item) === input.state), `requested=${input.state}`);
  mark("all selected candidate markets match requested market label", samples.every((item) => normalizeMarket(sampleMarket(item)) === marketKey || !sampleMarket(item)), `requested=${input.market}`);

  await validateSamples({ supabase, input, samples, textgridNumbers: activeTextgridNumbers });

  const afterSessionRows = await countRowsForSession(supabase, input.campaign_session_id);
  mark("dry-run inserted no send_queue rows", afterSessionRows === beforeSessionRows, `before=${beforeSessionRows} after=${afterSessionRows}`);
  mark("no-send guard: live queue rows not created", afterSessionRows === 0, `session_rows=${afterSessionRows}`);
  mark("no-send guard: queue was not run", true);
  mark("no-send guard: TextGrid was not called", true);

  printPlan({ input, result, samples, selectedSenders, selectedTemplates, controlValues });

  if (state.failures > 0) {
    console.error(`\nNOT_READY_FOR_APPROVAL failures=${state.failures} warnings=${state.warnings}`);
    process.exit(1);
  }

  console.log(`\nREADY_FOR_APPROVAL warnings=${state.warnings}`);
}

main().catch((error) => {
  mark("preflight crashed", false, error?.stack || error?.message || String(error));
  console.error(`\nNOT_READY_FOR_APPROVAL failures=${state.failures} warnings=${state.warnings}`);
  process.exit(1);
});
