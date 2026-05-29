#!/usr/bin/env node

/**
 * scripts/rebuild-inbox-from-message-events.mjs
 *
 * Requirements:
 * 1. Source of truth is message_events.
 * 2. Normalize seller_number / our_number by direction.
 * 3. Skip or mark corrupted same-from-to rows.
 * 4. Run classify.js on every inbound message.
 * 5. Use resolve-inbox-state-from-classification.js to derive inbox_bucket, universal_status, etc.
 * 6. Roll up by thread_key.
 * 7. Enrich with deal_context_index by thread_key/canonical_e164.
 * 8. Upsert into deal_thread_state.
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { classify } from "../src/lib/domain/classification/classify.js";
import {
  buildThreadStatePatchFromClassification
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
const isDryRun = process.argv.includes("--dry-run") || !isApply;

const BATCH_SIZE = 100;
// Fallback function to extract time
function asTime(v) { const d = new Date(v||0).getTime(); return Number.isFinite(d) ? d : 0; }

async function main() {
  console.log(`Starting Historical Inbox Rebuild... (Dry Run: ${!isApply})`);

  // 1. Fetch unique thread_keys
  const { data: threadKeys, error: keyError } = await supabase
    .from("message_events")
    .select("thread_key")
    .not("thread_key", "is", null);

  if (keyError) throw keyError;
  const uniqueKeys = [...new Set(threadKeys.map(k => k.thread_key))];
  console.log(`Found ${uniqueKeys.length} unique thread keys.`);

  // Validation trackers
  const stats = {
    processed: 0,
    corrupted: 0,
    errors: 0,
    buckets: {},
    statuses: {}
  };

  for (let i = 0; i < uniqueKeys.length; i += BATCH_SIZE) {
    const batchKeys = uniqueKeys.slice(i, i + BATCH_SIZE);

    for (const thread_key of batchKeys) {
      stats.processed++;
      
      const { data: messages, error: msgError } = await supabase
        .from("message_events")
        .select("*")
        .eq("thread_key", thread_key)
        .order("created_at", { ascending: false });

      if (msgError) {
        console.error(`Error fetching messages for ${thread_key}:`, msgError);
        stats.errors++;
        continue;
      }
      
      if (!messages || messages.length === 0) continue;

      // Handle ordering based on latest_activity_at/created_at just in case
      messages.sort((a, b) => asTime(b.received_at || b.sent_at || b.created_at) - asTime(a.received_at || a.sent_at || a.created_at));

      const latest = messages[0];
      
      if (latest.from_phone_number && latest.to_phone_number && latest.from_phone_number === latest.to_phone_number) {
        stats.corrupted++;
        continue; // skip corrupted same-from-to
      }
      
      const inboundMsgs = messages.filter(m => (m.direction || "").toLowerCase() === "inbound");
      const outboundMsgs = messages.filter(m => (m.direction || "").toLowerCase() === "outbound");

      let classification = null;
      let latestInbound = inboundMsgs[0];
      
      if (latestInbound) {
        classification = await classify(latestInbound.message_body || "", null);
      }
      
      const direction = (latest.direction || "").toLowerCase();
      let seller_phone = null;
      let our_number = null;
      
      if (direction === "inbound") {
        seller_phone = latest.from_phone_number;
        our_number = latest.to_phone_number;
      } else if (direction === "outbound") {
        seller_phone = latest.to_phone_number;
        our_number = latest.from_phone_number;
      } else {
        // Fallback for null direction
        seller_phone = latest.from_phone_number || latest.to_phone_number;
        our_number = latest.to_phone_number || latest.from_phone_number;
      }

      let existingStateForOutbound = {};
      if (latestInbound) {
        existingStateForOutbound = buildThreadStatePatchFromClassification({
          messageEvent: latestInbound,
          classification: classification || {},
          existingState: {}
        });
      }

      let patch;
      if (direction === "outbound") {
        patch = buildThreadStatePatchFromClassification({
          messageEvent: latest,
          classification: {}, // Outbound has no classification
          existingState: existingStateForOutbound
        });
      } else {
        patch = existingStateForOutbound;
      }

      // Enrich from deal_context_index
      const { data: contexts } = await supabase
        .from("deal_context_index")
        .select("property_id, master_owner_id, prospect_id, market, owner_name")
        .eq("thread_key", thread_key)
        .limit(1)
        .maybeSingle();

      const stateRow = {
        thread_key,
        seller_phone,
        our_number,
        message_count: messages.length,
        inbound_count: inboundMsgs.length,
        outbound_count: outboundMsgs.length,
        
        property_id: contexts?.property_id || latest.property_id || null,
        master_owner_id: contexts?.master_owner_id || latest.master_owner_id || null,
        prospect_id: contexts?.prospect_id || latest.prospect_id || null,
        market: contexts?.market || latest.market || null,
        seller_display_name: contexts?.owner_name || latest.seller_display_name || null,
        
        last_inbound_at: latestInbound?.received_at || latestInbound?.created_at || null,
        last_outbound_at: outboundMsgs[0]?.sent_at || outboundMsgs[0]?.created_at || null,

        // Apply classification derived flags & state
        ...patch,
      };

      // Tally validation counts
      stats.buckets[patch.inbox_bucket || 'none'] = (stats.buckets[patch.inbox_bucket || 'none'] || 0) + 1;
      stats.statuses[patch.universal_status || 'none'] = (stats.statuses[patch.universal_status || 'none'] || 0) + 1;

      if (isApply) {
        // Upsert into deal_thread_state only
        await supabase.from("deal_thread_state").upsert(stateRow, { onConflict: "thread_key" })
          .catch(err => {
          console.error(`Upsert failed for ${thread_key}:`, err);
          stats.errors++;
        });
      }
    }
    console.log(`Processed ${Math.min(i + BATCH_SIZE, uniqueKeys.length)} / ${uniqueKeys.length} threads`);
  }

  console.log("\n=== Validation Counts ===");
  console.log("Inbox Buckets:", stats.buckets);
  console.log("Universal Statuses:", stats.statuses);
  console.log(`Corrupted skipped: ${stats.corrupted}`);
  console.log(`Total processed: ${stats.processed}`);
  console.log(`Errors: ${stats.errors}`);
  
  if (!isApply) {
    console.log("\nRun with --apply to write these changes to the database.");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
