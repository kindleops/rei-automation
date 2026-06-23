#!/usr/bin/env node

/**
 * scripts/repair-inbox-buckets-from-canonical-state.mjs
 *
 * Scans all current inbox states and re-evaluates the `inbox_bucket` based
 * on the canonical logic, enforcing terminal states (dead, suppressed) and 
 * priority intents properly so outbound messages don't override them.
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  resolveInboxBucketFromClassification
} from "../src/lib/domain/inbox/resolve-inbox-state-from-classification.js";

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const isApply = process.argv.includes("--apply");
const BATCH_SIZE = 500;

async function main() {
  console.log(`Starting Inbox Bucket Repair... (Dry Run: ${!isApply})`);

  let offset = 0;
  let hasMore = true;
  
  const stats = {
    scanned: 0,
    mismatches: 0,
    fixed: 0,
    errors: 0,
    buckets: {},
    statuses: {},
    with_owner_name: 0,
    with_property_address: 0,
    with_canonical_e164: 0,
    with_latest_body: 0,
    with_latest_direction: 0,
  };

  while (hasMore) {
    const { data: rows, error } = await supabase
      .from("deal_thread_state")
      .select("*")
      .order("updated_at", { ascending: false })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error("Error fetching rows:", error);
      process.exit(1);
    }

    if (!rows || rows.length === 0) {
      hasMore = false;
      break;
    }

    offset += rows.length;

    for (const row of rows) {
      stats.scanned++;

      // Ensure classification fields exist for fallback resolver
      const fakeClassification = {
        primary_intent: row.primary_intent,
        objection: row.objection,
        compliance_flag: row.compliance_flag,
        motivation_score: row.motivation_score
      };

      const resolvedBucket = resolveInboxBucketFromClassification(
        fakeClassification, 
        { direction: row.latest_message_direction || row.latest_direction || 'inbound' }, 
        row
      );

      // Stat tracking
      stats.buckets[resolvedBucket] = (stats.buckets[resolvedBucket] || 0) + 1;
      stats.statuses[row.universal_status || 'unknown'] = (stats.statuses[row.universal_status || 'unknown'] || 0) + 1;
      
      if (row.seller_display_name || row.owner_name) stats.with_owner_name++;
      if (row.property_address || row.property_street) stats.with_property_address++; // we don't have street natively in this table, but tracking what we can
      if (row.canonical_e164 || row.seller_phone) stats.with_canonical_e164++;
      if (row.latest_message_body) stats.with_latest_body++;
      if (row.latest_message_direction || row.latest_direction) stats.with_latest_direction++;

      if (row.inbox_bucket !== resolvedBucket) {
        stats.mismatches++;
        // console.log(`Mismatch [${row.thread_key}]: current=${row.inbox_bucket} -> new=${resolvedBucket} (status=${row.universal_status})`);

        if (isApply) {
          const patch = { inbox_bucket: resolvedBucket, resolved_inbox_bucket: resolvedBucket, updated_at: new Date().toISOString() };
          
          await Promise.all([
            supabase.from("operator_thread_state").update(patch).eq("thread_key", row.thread_key),
            supabase.from("deal_thread_state").update(patch).eq("thread_key", row.thread_key)
          ]).then(() => {
            stats.fixed++;
          }).catch((err) => {
            console.error(`Error updating thread ${row.thread_key}`, err);
            stats.errors++;
          });
        }
      }
    }
  }

  console.log("\n=== Repair Validation Stats ===");
  console.log(`Total Scanned: ${stats.scanned}`);
  console.log(`Mismatches Found: ${stats.mismatches}`);
  console.log(`Fixed: ${stats.fixed}`);
  console.log(`Errors: ${stats.errors}\n`);
  
  console.log("Rows by universal_status:", stats.statuses);
  console.log("Rows by resolved inbox_bucket:", stats.buckets);
  
  console.log("\nData Completeness Check:");
  console.log(`- with owner_name: ${stats.with_owner_name}`);
  console.log(`- with canonical_e164 (or seller_phone): ${stats.with_canonical_e164}`);
  console.log(`- with latest_message_body: ${stats.with_latest_body}`);
  console.log(`- with latest_message_direction: ${stats.with_latest_direction}`);

  if (!isApply) {
    console.log("\nRun with --apply to commit these bucket fixes.");
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
