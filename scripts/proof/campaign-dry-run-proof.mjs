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

function headers() {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    origin: "http://localhost:5173",
  };
  if (OPS_SECRET) h["x-ops-dashboard-secret"] = OPS_SECRET;
  return h;
}

async function callJson(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
  const startedAt = performance.now();
  let status = 0;
  let json = null;
  let raw = "";
  let error = null;
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || headers(),
      body: options.body,
    });
    status = response.status;
    raw = await response.text();
    json = raw ? JSON.parse(raw) : null;
  } catch (err) {
    error = err?.message || String(err);
  }
  return {
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
    console.warn(`WARN send_queue dry-run count unavailable ${error?.message || error}`);
    return null;
  }
}

function numeric(value) {
  return Number.isFinite(Number(value));
}

async function main() {
  const campaignSessionId = `campaign-dry-run-proof-${Date.now()}`;
  console.log(`Campaign dry-run proof base=${BASE_URL} session=${campaignSessionId}`);
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET));

  const beforeCount = await countRowsForSession(campaignSessionId);
  if (beforeCount !== null) mark("proof session starts with no queue rows", beforeCount === 0, `count=${beforeCount}`);

  const result = await callJson("/api/cockpit/queue/control", {
    method: "POST",
    body: JSON.stringify({
      action: "run_dry_run_feeder",
      dry_run: true,
      campaign_mode: "dry_run",
      campaign_session_id: campaignSessionId,
      candidate_source: "v_sms_ready_contacts_expanded",
      limit: 3,
      scan_limit: 25,
      debug_templates: true,
    }),
  });

  const json = result.json || {};
  const preview = json.preview || {};
  const blockReasons = json.block_reasons || {};

  mark("dry-run route returned 200", result.status === 200, `status=${result.status} ms=${result.ms}`);
  mark("dry-run response ok", json.ok === true, `ok=${json.ok}`);
  mark("dry-run flag preserved", json.dry_run === true || preview.dry_run === true, `dry_run=${json.dry_run ?? preview.dry_run}`);
  mark("no live rows reported inserted", Number(json.inserted_count || 0) === 0 && Number(json.live_rows_inserted || 0) === 0);
  mark("eligible count present", numeric(json.eligible_count ?? preview.eligible_count), `eligible=${json.eligible_count ?? preview.eligible_count}`);
  mark("skipped count present", numeric(json.skipped_count ?? preview.skipped_count), `skipped=${json.skipped_count ?? preview.skipped_count}`);
  for (const key of [
    "routing_blocked",
    "suppressed",
    "identity_held",
    "template_blocked",
    "duplicate_blocked",
    "active_queue_blocked",
  ]) {
    mark(`block count present ${key}`, numeric(blockReasons[key]), `${key}=${blockReasons[key]}`);
  }
  mark("sample candidates array present", Array.isArray(preview.sample_candidates), `count=${preview.sample_candidates?.length ?? "missing"}`);
  mark("selected templates array present", Array.isArray(preview.selected_templates), `count=${preview.selected_templates?.length ?? "missing"}`);

  const afterCount = await countRowsForSession(campaignSessionId);
  if (afterCount !== null) mark("dry-run inserted no send_queue rows", afterCount === 0, `count=${afterCount}`);

  if (failures > 0) {
    console.error(`FAIL campaign dry-run proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS campaign dry-run proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL campaign dry-run proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
