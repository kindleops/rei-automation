#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

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

const args = new Set(process.argv.slice(2));
if (!args.has("--confirm-control-mode")) {
  console.error("Refusing to modify system_control without --confirm-control-mode.");
  process.exit(2);
}

const clearMarketFilter = args.has("--clear-market-filter");
const clearStateFilter = args.has("--clear-state-filter");

const auditRaw = execFileSync(
  process.execPath,
  [path.join(ROOT, "scripts/proof/sms-automation-readiness-audit.mjs"), "--json"],
  { cwd: ROOT, encoding: "utf8" }
);
const audit = JSON.parse(auditRaw);
const codeBlockers = (audit.checks || []).filter((check) => check.category === "code" && check.status === "red");
if (codeBlockers.length > 0) {
  console.error("Critical code blockers remain; not enabling controlled autopilot:");
  for (const blocker of codeBlockers) console.error(`- ${blocker.name}: ${blocker.detail || blocker.status}`);
  process.exit(1);
}

const updates = {
  auto_queue_enabled: "true",
  queue_auto_enqueue_enabled: "true",
  queue_auto_send_enabled: "true",
  queue_processor_mode: "controlled",
  campaign_mode: "controlled",
  retry_enabled: "false",
  reconcile_enabled: "true",
  followup_enabled: "true",
  auto_reply_enabled: "true",
  auto_reply_live_enabled: "true",
  auto_reply_dry_run: "false",
  require_local_routing: "true",
  queue_max_batch_size: "3",
  queue_run_limit: "3",
  queue_daily_send_cap: "50",
  queue_hard_cap: "50",
  queue_market_cap: "50",
  queue_per_number_cap: "10",
};

if (clearMarketFilter) updates.queue_market_filter = "";
if (clearStateFilter) updates.queue_state_filter = "";

console.log("Controlled SMS autopilot changes to apply:");
for (const [key, value] of Object.entries(updates)) {
  console.log(`- ${key}: ${JSON.stringify(audit.values?.[key] ?? null)} -> ${JSON.stringify(value)}`);
}
console.log("- retry_enabled remains false by design");

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; no changes applied.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const rows = Object.entries(updates).map(([key, value]) => ({ key, value }));
const { data, error } = await supabase
  .from("system_control")
  .upsert(rows, { onConflict: "key" })
  .select("key,value,updated_at");

if (error) {
  console.error(`system_control update failed: ${error.message}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  updated: data?.length || 0,
  keys: rows.map((row) => row.key),
}, null, 2));
