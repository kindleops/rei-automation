#!/usr/bin/env node
/**
 * Read-only production reconciliation audit for outbound production incidents.
 * Pair-level 21610 suppression coverage uses normalized sender/recipient grain.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { normalizeUsPhoneToE164 } from "../../src/lib/sms/sanitize.js";

function normalizePhone(value) {
  return normalizeUsPhoneToE164(value);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);
const scriptDir = dirname(fileURLToPath(import.meta.url));

function clean(value) {
  return String(value ?? "").trim();
}

function pairKey(recipient, sender) {
  const to = normalizePhone(recipient);
  const from = normalizePhone(sender);
  if (!to || !from) return null;
  return `${to}|${from}`;
}

async function fetchAllRows(queryBuilder, pageSize = 1000) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryBuilder.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

console.log("=== OUTBOUND PRODUCTION INCIDENT RECONCILIATION AUDIT (READ-ONLY) ===\n");

const failure_rows = await fetchAllRows(
  supabase
    .from("send_queue")
    .select("id,to_phone_number,from_phone_number,failed_reason,queue_status,retry_count,next_retry_at,created_at,updated_at")
    .ilike("failed_reason", "%21610%")
);

const suppression_rows = await fetchAllRows(
  supabase
    .from("sms_suppression_list")
    .select("id,phone_e164,sender_phone_e164,phone_number,suppression_type,suppression_reason,suppressed_at,is_active")
    .or("suppression_reason.ilike.%21610%,suppression_type.ilike.%blacklist%,suppression_reason.ilike.%blacklist%")
);

const historical_pairs = new Map();
const malformed_failure_pairs = [];
for (const row of failure_rows) {
  const key = pairKey(row.to_phone_number, row.from_phone_number);
  if (!key) {
    malformed_failure_pairs.push({
      queue_row_id: row.id,
      to_phone_number: row.to_phone_number,
      from_phone_number: row.from_phone_number,
    });
    continue;
  }
  if (!historical_pairs.has(key)) {
    historical_pairs.set(key, {
      pair_key: key,
      recipient: normalizePhone(row.to_phone_number),
      sender: normalizePhone(row.from_phone_number),
      queue_row_ids: [],
      statuses: new Set(),
    });
  }
  const entry = historical_pairs.get(key);
  entry.queue_row_ids.push(row.id);
  entry.statuses.add(clean(row.queue_status) || "unknown");
}

const suppression_pairs = new Map();
const duplicate_suppression_entries = [];
const malformed_suppression_pairs = [];
for (const row of suppression_rows) {
  const recipient = row.phone_e164 || row.phone_number;
  const key = pairKey(recipient, row.sender_phone_e164);
  if (!key) {
    malformed_suppression_pairs.push({
      suppression_id: row.id,
      phone_e164: row.phone_e164,
      phone_number: row.phone_number,
      sender_phone_e164: row.sender_phone_e164,
    });
    continue;
  }
  if (suppression_pairs.has(key)) {
    duplicate_suppression_entries.push({
      pair_key: key,
      existing_id: suppression_pairs.get(key).suppression_ids[0],
      duplicate_id: row.id,
    });
  }
  if (!suppression_pairs.has(key)) {
    suppression_pairs.set(key, {
      pair_key: key,
      recipient: normalizePhone(recipient),
      sender: normalizePhone(row.sender_phone_e164),
      suppression_ids: [],
    });
  }
  suppression_pairs.get(key).suppression_ids.push(row.id);
}

const uncovered_pairs = [];
for (const [key, entry] of historical_pairs.entries()) {
  if (!suppression_pairs.has(key)) {
    uncovered_pairs.push(entry);
  }
}

const executable_21610 = failure_rows.filter((row) =>
  ["queued", "scheduled", "pending", "processing", "ready", "runnable"].includes(
    clean(row.queue_status).toLowerCase()
  )
);

console.log("21610 FAILURE PAIR RECONCILIATION");
console.log("  total failure rows:", failure_rows.length);
console.log("  distinct historical 21610 pairs:", historical_pairs.size);
console.log("  distinct covered pairs:", historical_pairs.size - uncovered_pairs.length);
console.log("  distinct uncovered pairs:", uncovered_pairs.length);
console.log("  duplicate suppression entries:", duplicate_suppression_entries.length);
console.log("  malformed failure pairs:", malformed_failure_pairs.length);
console.log("  malformed suppression pairs:", malformed_suppression_pairs.length);
console.log("  still executable failure rows:", executable_21610.length);

if (uncovered_pairs.length) {
  console.log("\nUncovered pair sample (up to 10):");
  for (const entry of uncovered_pairs.slice(0, 10)) {
    console.log(`  ${entry.pair_key} queue_rows=${entry.queue_row_ids.join(",")}`);
  }
}

const backfill_rows = uncovered_pairs.map((entry) => ({
  phone_e164: entry.recipient,
  sender_phone_e164: entry.sender,
  phone_number: entry.recipient,
  suppression_type: "provider_blacklist_pair",
  suppression_reason: "provider_blacklist_21610",
  is_active: true,
  source: "reconciliation_21610_pair_backfill",
}));

const forward_sql = `-- FORWARD: backfill uncovered 21610 sender-recipient pairs only (${backfill_rows.length} rows)
INSERT INTO public.sms_suppression_list (
  phone_e164,
  sender_phone_e164,
  phone_number,
  suppression_type,
  suppression_reason,
  is_active,
  suppressed_at,
  source
)
SELECT DISTINCT
  sq.to_phone_number,
  sq.from_phone_number,
  sq.to_phone_number,
  'provider_blacklist_pair',
  COALESCE(NULLIF(sq.failed_reason, ''), 'provider_blacklist_21610'),
  true,
  NOW(),
  'reconciliation_21610_pair_backfill'
FROM public.send_queue sq
WHERE sq.failed_reason ILIKE '%21610%'
  AND sq.to_phone_number IS NOT NULL
  AND sq.from_phone_number IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.sms_suppression_list ssl
    WHERE ssl.phone_e164 = sq.to_phone_number
      AND ssl.sender_phone_e164 = sq.from_phone_number
  )
ON CONFLICT (phone_e164, sender_phone_e164) DO NOTHING;`;

const rollback_sql = `-- ROLLBACK: remove only reconciliation backfill rows
DELETE FROM public.sms_suppression_list
WHERE source = 'reconciliation_21610_pair_backfill'
  AND suppression_type = 'provider_blacklist_pair';`;

const terminal_sql = `-- FORWARD: terminalize any still-retryable 21610 queue rows (predicate scoped to 21610 only)
UPDATE public.send_queue
SET
  queue_status = 'failed',
  next_retry_at = NULL,
  is_locked = false,
  locked_at = NULL,
  lock_token = NULL,
  updated_at = NOW(),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'reconciled_at', NOW(),
    'reconciliation_reason', 'provider_blacklist_21610',
    'final_queue_status', 'failed'
  )
WHERE failed_reason ILIKE '%21610%'
  AND queue_status IN ('queued','scheduled','pending','processing','ready','runnable','paused','paused_after_hours');`;

const report = {
  generated_at: new Date().toISOString(),
  failure_row_count: failure_rows.length,
  distinct_historical_pairs: historical_pairs.size,
  distinct_covered_pairs: historical_pairs.size - uncovered_pairs.length,
  distinct_uncovered_pairs: uncovered_pairs.length,
  duplicate_suppression_entries: duplicate_suppression_entries.length,
  malformed_failure_pairs: malformed_failure_pairs.length,
  malformed_suppression_pairs: malformed_suppression_pairs.length,
  executable_21610_rows: executable_21610.length,
  uncovered_pairs: uncovered_pairs.map((entry) => ({
    pair_key: entry.pair_key,
    recipient: entry.recipient,
    sender: entry.sender,
    queue_row_ids: entry.queue_row_ids,
    statuses: [...entry.statuses],
  })),
  proposed_backfill_rows: backfill_rows,
  forward_sql,
  rollback_sql,
  terminal_sql,
};

const report_path = join(scriptDir, "outbound-incident-reconciliation-report.json");
const sql_path = join(scriptDir, "outbound-incident-reconciliation.sql");
writeFileSync(report_path, JSON.stringify(report, null, 2));
writeFileSync(sql_path, `${forward_sql}\n\n${terminal_sql}\n\n${rollback_sql}\n`);

console.log(`\nReport written: ${report_path}`);
console.log(`SQL written: ${sql_path}`);
console.log("\n=== NOT EXECUTED — review report and SQL before any production mutation ===");