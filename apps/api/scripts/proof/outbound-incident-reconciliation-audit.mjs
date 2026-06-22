#!/usr/bin/env node
/**
 * Read-only production reconciliation audit for outbound production incidents.
 * Does not mutate production data.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

async function countQuery(label, fn) {
  try {
    const result = await fn();
    if (result.error) {
      console.log(`${label}: ERROR ${result.error.message}`);
      return null;
    }
    return result;
  } catch (error) {
    console.log(`${label}: EXCEPTION ${error.message}`);
    return null;
  }
}

console.log("=== OUTBOUND PRODUCTION INCIDENT RECONCILIATION AUDIT (READ-ONLY) ===\n");

// 21610 incident
const blacklist_rows = await countQuery("21610 rows", () =>
  supabase
    .from("send_queue")
    .select("id,queue_status,to_phone_number,from_phone_number,retry_count,next_retry_at,failed_reason,created_at,updated_at,metadata", { count: "exact" })
    .ilike("failed_reason", "%21610%")
    .limit(500)
);

if (blacklist_rows?.data) {
  const rows = blacklist_rows.data;
  const executable = rows.filter((r) =>
    ["queued", "scheduled", "pending", "processing", "ready", "runnable"].includes(String(r.queue_status || "").toLowerCase())
  );
  const retry_scheduled = rows.filter((r) => r.next_retry_at);
  const recipients = new Set(rows.map((r) => r.to_phone_number).filter(Boolean));
  const pairs = new Set(rows.map((r) => `${r.from_phone_number}|${r.to_phone_number}`).filter((v) => !v.startsWith("|")));

  console.log("21610 send_queue rows:", rows.length, "(count header:", blacklist_rows.count, ")");
  console.log("  unique recipients:", recipients.size);
  console.log("  unique sender-recipient pairs:", pairs.size);
  console.log("  still executable:", executable.length);
  console.log("  with next_retry_at:", retry_scheduled.length);
  console.log("  status breakdown:", Object.fromEntries(
    rows.reduce((map, row) => {
      const k = row.queue_status || "unknown";
      map.set(k, (map.get(k) || 0) + 1);
      return map;
    }, new Map())
  ));
}

const suppression_21610 = await countQuery("21610 suppression list", () =>
  supabase
    .from("sms_suppression_list")
    .select("id,phone_e164,sender_phone_e164,suppression_type,suppression_reason,suppressed_at", { count: "exact" })
    .or("suppression_reason.ilike.%21610%,suppression_type.ilike.%blacklist%")
    .limit(200)
);
if (suppression_21610?.data) {
  console.log("\n21610/blacklist suppression rows:", suppression_21610.data.length, "(count:", suppression_21610.count, ")");
}

// Timestamp incident proxy: duplicate active dedupe_keys from feeder grain
const recent_feeder = await countQuery("recent feeder queue rows (7d)", () =>
  supabase
    .from("send_queue")
    .select("id,dedupe_key,queue_key,queue_status,created_at,scheduled_for,master_owner_id,property_id,to_phone_number,touch_number")
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .not("dedupe_key", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000)
);

if (recent_feeder?.data) {
  const by_dedupe = new Map();
  for (const row of recent_feeder.data) {
    const key = row.dedupe_key;
    if (!by_dedupe.has(key)) by_dedupe.set(key, []);
    by_dedupe.get(key).push(row);
  }
  const dupes = [...by_dedupe.entries()].filter(([, rows]) => rows.length > 1);
  const executable_dupes = dupes.filter(([, rows]) =>
    rows.filter((r) =>
      ["queued", "scheduled", "pending", "processing", "ready", "runnable"].includes(String(r.queue_status || "").toLowerCase()) &&
      !r.sent_at
    ).length > 1
  );
  console.log("\nFeeder dedupe_key duplicates (7d sample):", dupes.length);
  console.log("  with >1 executable active row:", executable_dupes.length);
  if (executable_dupes.length) {
    console.log("  sample duplicate grain:", executable_dupes.slice(0, 3).map(([k, rows]) => ({
      dedupe_key: k,
      row_ids: rows.map((r) => r.id),
      statuses: rows.map((r) => r.queue_status),
    })));
  }
}

console.log("\n=== PROPOSED RECONCILIATION (NOT EXECUTED) ===");
console.log(`
-- Terminalize retrying 21610 rows only:
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
  AND queue_status IN ('queued','scheduled','pending','processing','ready','runnable','paused','paused_after_hours');

-- Rollback predicate proof: only rows with 21610 in failed_reason are touched.

-- Pair suppression backfill (example — run per distinct pair after review):
INSERT INTO public.sms_suppression_list (phone_e164, sender_phone_e164, phone_number, suppression_type, suppression_reason, is_active, suppressed_at, source)
SELECT DISTINCT
  to_phone_number,
  from_phone_number,
  to_phone_number,
  'provider_blacklist_pair',
  failed_reason,
  true,
  NOW(),
  'reconciliation_21610'
FROM public.send_queue
WHERE failed_reason ILIKE '%21610%'
ON CONFLICT (phone_e164, sender_phone_e164) DO NOTHING;
`);