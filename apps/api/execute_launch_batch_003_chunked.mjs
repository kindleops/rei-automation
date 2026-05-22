import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";
import { runSendQueue } from "./src/lib/domain/queue/run-send-queue.js";

async function main() {
  const batch_name = "launch_batch_003";
  let total_queued = 0;
  const target = 100;
  
  console.log(`[${batch_name}] Starting CHUNKED preparation for ${target} candidates...`);

  for (let i = 0; i < 5; i++) {
    if (total_queued >= target) break;
    
    console.log(`\nPass ${i + 1}: Scanning next chunk...`);
    
    const params = {
      limit: target - total_queued, 
      scan_limit: 400, // Smaller scan limit to prevent timeout
      candidate_offset: i * 400,
      candidate_source: "v_outbound_discovery_open_now",
      batch_name,
      touch_number: 1,
      schedule_spread: true,
      within_contact_window_now: true,
      dry_run: false
    };

    try {
      const result = await runSupabaseCandidateFeeder(params, {});
      if (result.ok) {
        total_queued += result.queued_count;
        console.log(`Enqueued ${result.queued_count} more. Total: ${total_queued}`);
      } else {
        console.error("Feeder pass failed:", result.error);
      }
    } catch (err) {
      console.error("Feeder exception:", err.message);
    }
  }

  if (total_queued === 0) {
    console.log("No candidates enqueued.");
    return;
  }

  console.log(`\n[${batch_name}] Total Enqueued: ${total_queued}. Starting send execution...`);
  
  // Force schedule
  // (We'll do this via SQL in the next turn if needed, or just let runSendQueue handle it)
  
  const sendResult = await runSendQueue({ limit: total_queued });
  console.log("\n--- EXECUTION COMPLETE ---");
  console.log(`Sent: ${sendResult.sent_count}`);
}

main();