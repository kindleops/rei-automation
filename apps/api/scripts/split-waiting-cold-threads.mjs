#!/usr/bin/env node

/**
 * Focused cleanup: split stale waiting rows into cold_reactivation.
 * Does not send messages or touch queue/automation systems.
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import {
  isOutboundLastWithoutReply,
  WAITING_REPLY_WINDOW_MS,
} from "../src/lib/domain/inbox/resolve-waiting-cold-state.js";

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const isApply = process.argv.includes("--apply");
const BATCH_SIZE = 500;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  const now = Date.now();
  const cutoffIso = new Date(now - WAITING_REPLY_WINDOW_MS).toISOString();
  console.log(`Split waiting/cold cleanup (apply=${isApply}) cutoff=${cutoffIso}`);

  let scanned = 0;
  let movedToCold = 0;
  let keepWaiting = 0;
  let errors = 0;

  const { count: initialWaiting, error: initialError } = await supabase
    .from("inbox_thread_state")
    .select("thread_key", { count: "exact", head: true })
    .eq("inbox_bucket", "waiting");
  if (initialError) throw initialError;

  while (true) {
    const { data: rows, error } = await supabase
      .from("inbox_thread_state")
      .select("thread_key,last_outbound_at,last_inbound_at,latest_delivery_status,inbox_bucket")
      .eq("inbox_bucket", "waiting")
      .lt("last_outbound_at", cutoffIso)
      .order("thread_key", { ascending: true })
      .limit(BATCH_SIZE);

    if (error) throw error;
    if (!rows?.length) break;

    const staleRows = rows.filter((row) =>
      isOutboundLastWithoutReply({
        lastOutboundAt: row.last_outbound_at,
        lastInboundAt: row.last_inbound_at,
      })
    );

    if (!staleRows.length) break;

    scanned += staleRows.length;
    const threadKeys = staleRows.map((row) => row.thread_key);

    if (isApply) {
      const { error: updateError } = await supabase
        .from("inbox_thread_state")
        .update({
          inbox_bucket: null,
          automation_lane: "cold_reactivation",
          updated_at: new Date(now).toISOString(),
        })
        .in("thread_key", threadKeys);

      if (updateError) {
        errors += threadKeys.length;
        console.error("Batch update failed:", updateError.message);
      } else {
        movedToCold += threadKeys.length;
      }
    } else {
      movedToCold += threadKeys.length;
    }

    console.log(`Processed stale waiting batch: ${movedToCold}`);
  }

  const { count: remainingWaiting, error: remainingError } = await supabase
    .from("inbox_thread_state")
    .select("thread_key", { count: "exact", head: true })
    .eq("inbox_bucket", "waiting");
  if (remainingError) throw remainingError;

  const { count: coldCount, error: coldError } = await supabase
    .from("inbox_thread_state")
    .select("thread_key", { count: "exact", head: true })
    .eq("automation_lane", "cold_reactivation");
  if (coldError) throw coldError;

  keepWaiting = Number(remainingWaiting || 0);

  console.log("\n=== Waiting/Cold Split ===");
  console.log(`Initial waiting: ${initialWaiting ?? 0}`);
  console.log(`Stale scanned: ${scanned}`);
  console.log(`Moved to cold: ${movedToCold}`);
  console.log(`Remaining waiting: ${keepWaiting}`);
  console.log(`Cold reactivation total: ${coldCount ?? 0}`);
  console.log(`Errors: ${errors}`);

  if (!isApply) {
    console.log("\nRun with --apply to write changes.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});