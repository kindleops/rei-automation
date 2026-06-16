import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../apps/api/.env") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function backfill() {
  console.log("Starting 21610 blacklist backfill...");

  // Query send_queue for historical 21610 failures
  const { data: failures, error: fetchError } = await supabase
    .from("send_queue")
    .select("to_phone_number, from_phone_number, failed_reason, updated_at")
    .or("failed_reason.ilike.%21610%,failed_reason.ilike.%blacklist%");

  if (fetchError) {
    console.error("Error fetching failures:", fetchError.message);
    return;
  }

  console.log(`Found ${failures?.length || 0} historical failures.`);

  if (!failures || failures.length === 0) return;

  // Deduplicate pairs and get latest updated_at
  const pairs = new Map();
  for (const row of failures) {
    const key = `${row.to_phone_number}|${row.from_phone_number}`;
    if (!pairs.has(key) || new Date(row.updated_at) > new Date(pairs.get(key).updated_at)) {
      pairs.set(key, row);
    }
  }

  console.log(`Unique suppressed pairs: ${pairs.size}`);

  const rowsToInsert = Array.from(pairs.values()).map(row => ({
    phone_e164: row.to_phone_number,
    phone_number: row.to_phone_number,
    sender_phone_e164: row.from_phone_number,
    suppression_type: "blacklist_pair",
    reason: row.failed_reason || "historical_21610_backfill",
    suppression_reason: row.failed_reason || "historical_21610_backfill",
    is_active: true,
    source: "send_queue_backfill",
    suppressed_at: row.updated_at || new Date().toISOString(),
    created_at: row.updated_at || new Date().toISOString()
  }));

  // Batch insert
  const batchSize = 100;
  for (let i = 0; i < rowsToInsert.length; i += batchSize) {
    const chunk = rowsToInsert.slice(i, i + batchSize);
    const { error: insertError } = await supabase
      .from("sms_suppression_list")
      .upsert(chunk, { onConflict: "phone_e164,sender_phone_e164" });

    if (insertError) {
      console.error(`Error inserting batch ${i / batchSize}:`, insertError.message);
    } else {
      console.log(`Inserted batch ${i / batchSize + 1}`);
    }
  }

  console.log("Backfill complete.");
}

backfill();
