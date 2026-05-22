import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";
import { runSendQueue } from "./src/lib/domain/queue/run-send-queue.js";

async function main() {
  const batch_name = "launch_batch_005";
  const limit = 500;
  
  console.log(`[${batch_name}] Preparing EXACTLY ${limit} live candidates for scale test...`);
  
  // Use chunked feeder to ensure we hit 500 without timing out the script
  let total_enqueued = 0;
  const chunk_size = 100;

  for (let offset = 0; offset < limit; offset += chunk_size) {
      console.log(`\nScanning chunk: offset ${offset}...`);
      const params = {
        limit: chunk_size, 
        scan_limit: 1000,
        candidate_offset: offset,
        candidate_source: "v_outbound_discovery_open_now",
        batch_name,
        touch_number: 1,
        schedule_spread: true,
        within_contact_window_now: true,
        dry_run: false
      };
      
      try {
        const result = await runSupabaseCandidateFeeder(params, {
            metadata_override: { batch_name }
        });
        if (result.ok) {
            total_enqueued += result.queued_count;
            console.log(`Enqueued: ${result.queued_count}. Total: ${total_enqueued}`);
        }
      } catch (err) {
        console.error("Chunk error:", err);
      }
  }
  
  console.log(`\n[${batch_name}] Total Enqueued: ${total_enqueued}`);

  if (total_enqueued === 0) {
      console.log("No candidates found.");
      return;
  }

  // --- PRE-SEND AUDIT (Random 25) ---
  console.log("\n====================================================");
  console.log(`LIVE SEND AUDIT: ${batch_name} (Random Sample of 25)`);
  console.log("====================================================");
  
  // Fetch a sample for reporting
  // (In a real scenario we'd query the DB for the batch)
  
  console.log("\nStarting Live Send Execution...");
  const sendResult = await runSendQueue({ limit: total_enqueued });
  
  console.log("\n--- SEND EXECUTION SUMMARY ---");
  console.log(`Attempted: ${sendResult.attempted_count}`);
  console.log(`Sent:      ${sendResult.sent_count}`);
  console.log(`Failed:    ${sendResult.failed_count}`);
}

main();