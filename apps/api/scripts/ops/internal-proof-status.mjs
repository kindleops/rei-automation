#!/usr/bin/env node
// Read-only production status check for the internal canary proof session.
// Usage: node scripts/ops/internal-proof-status.mjs [--env .env.prod-secrets]
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const envFlagIndex = process.argv.indexOf("--env");
const envFile = envFlagIndex > -1 ? process.argv[envFlagIndex + 1] : ".env.local";
const envPath = path.resolve(process.cwd(), envFile);

const env = { ...process.env };
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch (error) {
  console.error(`env file not loaded (${envPath}): ${error?.message}`);
}

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available");
  process.exit(1);
}

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PINNED_ROW = "4d211395-bc7b-4bfe-8afb-16a329e636a4";
const PINNED_CAMPAIGN = "b7c9a000-7ad3-468b-9b9b-4647dbefc35f";

const { data: row, error: rowErr } = await supabase
  .from("send_queue")
  .select(
    "id,queue_status,campaign_id,to_phone_number,from_phone_number,scheduled_for,scheduled_for_utc,thread_key,message_type,use_case_template,timezone,is_locked,lock_token,retry_count,max_retries,sms_eligible,routing_allowed,metadata,created_at,updated_at"
  )
  .eq("id", PINNED_ROW)
  .maybeSingle();
console.log("=== PINNED CANARY ROW ===");
console.log(rowErr ? `ERROR: ${rowErr.message}` : JSON.stringify(row, null, 2));

const { data: sys, error: sysErr } = await supabase
  .from("system_control")
  .select("key,value,updated_at")
  .in("key", [
    "queue_execution_mode",
    "queue_processor_mode",
    "auto_reply_mode",
    "followup_automation_mode",
    "internal_proof_session",
    "queue_emergency_stop_at",
  ]);
console.log("\n=== SYSTEM CONTROL ===");
console.log(sysErr ? `ERROR: ${sysErr.message}` : JSON.stringify(sys, null, 2));

const { data: auths, error: authErr } = await supabase
  .from("queue_canary_authorizations")
  .select("id,canary_run_id,campaign_id,queue_row_ids,claimed_row_ids,consumed_at,expires_at,created_at")
  .eq("campaign_id", PINNED_CAMPAIGN)
  .order("created_at", { ascending: false })
  .limit(5);
console.log("\n=== CANARY AUTHORIZATIONS (latest 5) ===");
console.log(authErr ? `ERROR: ${authErr.message}` : JSON.stringify(auths, null, 2));

const { data: lock, error: lockErr } = await supabase
  .from("queue_global_execution_lock")
  .select("*")
  .eq("id", 1)
  .maybeSingle();
console.log("\n=== GLOBAL EXECUTION LOCK ===");
console.log(lockErr ? `ERROR: ${lockErr.message}` : JSON.stringify(lock, null, 2));
