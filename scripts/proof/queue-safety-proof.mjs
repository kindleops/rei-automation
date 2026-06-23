#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

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

const BASE_URL = String(
  process.env.COCKPIT_PROOF_BASE_URL ||
  process.env.API_URL ||
  process.env.LOCAL_API_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const OPS_SECRET =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.VITE_BACKEND_API_SECRET ||
  "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const QUEUE_ENGINE_SECRET = process.env.QUEUE_ENGINE_SHARED_SECRET || "";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

let failures = 0;
let warnings = 0;

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

function opsHeaders(extra = {}) {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    origin: "http://localhost:5173",
    ...extra,
  };
  if (OPS_SECRET) h["x-ops-dashboard-secret"] = OPS_SECRET;
  return h;
}

function feederHeaders() {
  const h = opsHeaders();
  if (CRON_SECRET) h.authorization = `Bearer ${CRON_SECRET}`;
  if (QUEUE_ENGINE_SECRET) h["x-queue-engine-secret"] = QUEUE_ENGINE_SECRET;
  return h;
}

async function callJson(label, pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
  const startedAt = performance.now();
  let status = 0;
  let json = null;
  let raw = "";
  let error = null;
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || opsHeaders(),
      body: options.body,
    });
    status = response.status;
    raw = await response.text();
    json = raw ? JSON.parse(raw) : null;
  } catch (err) {
    error = err?.message || String(err);
  }
  return {
    label,
    status,
    json,
    raw,
    error,
    ms: Math.round(performance.now() - startedAt),
    url,
  };
}

async function countRowsForSession(campaignSessionId) {
  if (!supabase) return null;
  try {
    const { count, error } = await supabase
      .from("send_queue")
      .select("id", { count: "exact", head: true })
      .contains("metadata", { campaign_session_id: campaignSessionId });
    if (error) throw error;
    return Number(count || 0);
  } catch (error) {
    warnings += 1;
    console.warn(`WARN send_queue safety count unavailable ${error?.message || error}`);
    return null;
  }
}

function isSafetyBlocked(result) {
  const json = result.json || {};
  const reason = String(json.reason || json.error || "");
  return (
    result.status === 423 &&
    json.ok === false &&
    (
      reason.includes("live_limited_rails_required") ||
      reason.includes("queue_emergency_stop_active") ||
      reason.includes("campaign_paused") ||
      reason.includes("campaign_not_live_limited") ||
      reason.includes("queue_processor_paused") ||
      json.error === "runtime_brake_active"
    )
  );
}

function isUnscopedLimitedBlocked(result) {
  const missing = result.json?.missing || [];
  return (
    isSafetyBlocked(result) &&
    (
      String(result.json?.reason || result.json?.error || "").includes("queue_emergency_stop_active") ||
      (Array.isArray(missing) && missing.includes("market_or_state_filter_or_all_market_ack"))
    )
  );
}

async function main() {
  const campaignSessionId = `queue-safety-proof-${Date.now()}`;
  console.log(`Queue safety proof base=${BASE_URL} session=${campaignSessionId}`);
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET));
  mark("feeder auth secret loaded", Boolean(CRON_SECRET || QUEUE_ENGINE_SECRET), "(CRON_SECRET or QUEUE_ENGINE_SHARED_SECRET)", true);

  const beforeCount = await countRowsForSession(campaignSessionId);
  if (beforeCount !== null) mark("proof session starts with no queue rows", beforeCount === 0, `count=${beforeCount}`);

  const unsafeQueueRun = await callJson("unsafe cockpit queue run", "/api/cockpit/queue/control", {
    method: "POST",
    body: JSON.stringify({
      action: "run_small_queue_batch",
      campaign_mode: "dry_run",
      campaign_session_id: campaignSessionId,
      limit: 5,
    }),
  });
  mark("global queue run blocked without live_limited", isSafetyBlocked(unsafeQueueRun), `status=${unsafeQueueRun.status} reason=${unsafeQueueRun.json?.reason || unsafeQueueRun.json?.error}`);

  const unsafeFeeder = await callJson("unsafe feeder live create", "/api/internal/outbound/feed-master-owners", {
    method: "POST",
    headers: feederHeaders(),
    body: JSON.stringify({
      dry_run: false,
      campaign_mode: "dry_run",
      campaign_session_id: campaignSessionId,
      candidate_source: "v_sms_ready_contacts_expanded",
      limit: 2,
      scan_limit: 25,
    }),
  });
  mark(
    "internal feeder live create blocked without live_limited",
    unsafeFeeder.status === 401 || unsafeFeeder.status === 403 || isSafetyBlocked(unsafeFeeder),
    `status=${unsafeFeeder.status} reason=${unsafeFeeder.json?.reason || unsafeFeeder.json?.error}`,
    unsafeFeeder.status === 401 || unsafeFeeder.status === 403,
  );

  const unscopedLimited = await callJson("unscoped live-limited queue create", "/api/cockpit/queue/control", {
    method: "POST",
    body: JSON.stringify({
      action: "queue_limited_batch",
      campaign_mode: "live_limited",
      campaign_session_id: campaignSessionId,
      hard_cap: 1,
      max_batch_size: 1,
      daily_cap: 1,
      market_cap: 1,
      per_number_cap: 1,
      all_market_ack: false,
      limit: 1,
      scan_limit: 25,
    }),
  });
  mark(
    "live_limited queue create blocked without market/state/all-market ack",
    isUnscopedLimitedBlocked(unscopedLimited),
    `status=${unscopedLimited.status} reason=${unscopedLimited.json?.reason || unscopedLimited.json?.error} missing=${(unscopedLimited.json?.missing || []).join(",")}`,
  );

  const unsafeQueueMore = await callJson("unsafe queue-more live create", "/api/cockpit/queue/queue-more", {
    method: "POST",
    body: JSON.stringify({
      dry_run: false,
      campaign_mode: "dry_run",
      campaign_session_id: campaignSessionId,
      target_count: 1,
      limit: 1,
      scan_limit: 25,
    }),
  });
  mark("queue-more live create blocked without live_limited", isSafetyBlocked(unsafeQueueMore), `status=${unsafeQueueMore.status} reason=${unsafeQueueMore.json?.reason || unsafeQueueMore.json?.error}`);

  const afterCount = await countRowsForSession(campaignSessionId);
  if (afterCount !== null) mark("blocked actions inserted no send_queue rows", afterCount === 0, `count=${afterCount}`);

  if (failures > 0) {
    console.error(`FAIL queue safety proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS queue safety proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL queue safety proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
