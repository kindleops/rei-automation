#!/usr/bin/env node

/**
 * scripts/rebuild-inbox-from-message-events.mjs
 *
 * Reclassify every inbox conversation from message_events using classify.js.
 * Updates inbox_thread_state classification + latest-message fields only.
 * Zero messages, queue items, automations, or duplicate threads.
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  classifyThreadFromChronology,
  patchToInboxThreadState,
} from "../src/lib/domain/inbox/classify-thread-from-chronology.js";

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
const BATCH_SIZE = 100;

function asTime(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function fetchAllThreadKeys() {
  const keys = new Set();
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("message_events")
      .select("thread_key")
      .not("thread_key", "is", null)
      .range(offset, offset + pageSize - 1);

    if (error) throw error;
    if (!data?.length) break;

    for (const row of data) {
      if (row.thread_key) keys.add(row.thread_key);
    }

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return [...keys];
}

async function main() {
  console.log(`Starting Historical Inbox Rebuild... (Dry Run: ${!isApply})`);

  const uniqueKeys = await fetchAllThreadKeys();
  console.log(`Found ${uniqueKeys.length} unique thread keys.`);

  const stats = {
    processed: 0,
    skipped: 0,
    corrupted: 0,
    errors: 0,
    buckets: {},
    statuses: {},
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

      if (!messages?.length) {
        stats.skipped++;
        continue;
      }

      messages.sort(
        (a, b) =>
          asTime(b.received_at || b.sent_at || b.created_at) -
          asTime(a.received_at || a.sent_at || a.created_at)
      );

      const latest = messages[0];
      if (
        latest.from_phone_number &&
        latest.to_phone_number &&
        latest.from_phone_number === latest.to_phone_number
      ) {
        stats.corrupted++;
        continue;
      }

      const { data: existingState } = await supabase
        .from("inbox_thread_state")
        .select("*")
        .eq("thread_key", thread_key)
        .maybeSingle();

      const patch = await classifyThreadFromChronology(messages, {
        existingState: existingState || {},
        heuristicOnly: true,
      });

      if (!patch) {
        stats.skipped++;
        continue;
      }

      const { data: context } = await supabase
        .from("deal_context_index")
        .select("property_id, master_owner_id, prospect_id, market, owner_name")
        .eq("thread_key", thread_key)
        .limit(1)
        .maybeSingle();

      const stateRow = patchToInboxThreadState(patch, {
        thread_key,
        master_owner_id: context?.master_owner_id || latest.master_owner_id || existingState?.master_owner_id || null,
        prospect_id: context?.prospect_id || latest.prospect_id || existingState?.prospect_id || null,
        property_id: context?.property_id || latest.property_id || existingState?.property_id || null,
        market: context?.market || latest.market || existingState?.market || null,
      });

      const bucket = stateRow.inbox_bucket || "none";
      stats.buckets[bucket] = (stats.buckets[bucket] || 0) + 1;
      stats.statuses[patch.universal_status || "none"] = (stats.statuses[patch.universal_status || "none"] || 0) + 1;

      if (isApply) {
        const { error: upsertError } = await supabase
          .from("inbox_thread_state")
          .upsert(stateRow, { onConflict: "thread_key" });

        if (upsertError) {
          console.error(`Upsert failed for ${thread_key}:`, upsertError);
          stats.errors++;
        }
      }
    }

    console.log(`Processed ${Math.min(i + BATCH_SIZE, uniqueKeys.length)} / ${uniqueKeys.length} threads`);
  }

  console.log("\n=== Validation Counts ===");
  console.log("Inbox Buckets:", stats.buckets);
  console.log("Universal Statuses:", stats.statuses);
  console.log(`Corrupted skipped: ${stats.corrupted}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Total processed: ${stats.processed}`);
  console.log(`Errors: ${stats.errors}`);

  if (!isApply) {
    console.log("\nRun with --apply to write these changes to the database.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});