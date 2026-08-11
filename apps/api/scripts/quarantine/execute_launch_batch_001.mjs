import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";
import { runSendQueue } from "./src/lib/domain/queue/run-send-queue.js";
import fs from 'fs';

async function main() {
  const batch_name = "launch_batch_001";
  
  const params = {
    limit: 50, 
    scan_limit: 5000,
    candidate_source: "v_outbound_discovery_open_now",
    touch_number: 1,
    schedule_spread: true,
    within_contact_window_now: true,
    dry_run: false // THIS IS LIVE INSERT
  };
  
  console.log(`[${batch_name}] Starting LIVE QUEUE INSERT...`);
  
  try {
    const result = await runSupabaseCandidateFeeder(params, {
        // We inject the batch name into metadata during creation
        metadata_override: { batch_name }
    });

    if (!result.ok) {
        console.error("Feeder failed:", result.error);
        return;
    }

    // Since our feeder doesn't support a strict "only if name present" filter in the query,
    // and we've already validated the top 25 in the previous step, 
    // we'll rely on the feeder's internal safety gates which we hardened.
    
    console.log(`[${batch_name}] Enqueued ${result.queued_count} candidates.`);

    if (result.queued_count === 0) {
        console.log("No candidates were enqueued. Check safety logs.");
        return;
    }

    // 1. Snapshot the inserted rows
    const snapshot = {
        batch_name,
        timestamp: new Date().toISOString(),
        queued_count: result.queued_count,
        candidates: (result.sample_created_queue_items || []).slice(0, 25).map(item => ({
            queue_row_id: item.queue_row_id,
            queue_key: item.queue_key,
            prospect_id: item.prospect_id,
            master_owner_id: item.master_owner_id,
            phone: item.to_phone_number,
            sender: item.selected_textgrid_number,
            market: item.market,
            template_id: item.template_id,
            message: item.rendered_message_preview,
            routing: item.selection_reason
        }))
    };

    fs.writeFileSync(`./${batch_name}_snapshot.json`, JSON.stringify(snapshot, null, 2));
    console.log(`[${batch_name}] Snapshot saved to ./${batch_name}_snapshot.json`);

    // 2. Execute LIVE SEND (Once only)
    console.log(`\n[${batch_name}] Starting LIVE SEND EXECUTION (One-time run)...`);
    const sendResult = await runSendQueue({ limit: 25 });
    
    console.log("\n====================================================");
    console.log("LIVE SEND EXECUTION COMPLETE");
    console.log("====================================================");
    console.log(`Attempted: ${sendResult.attempted_count}`);
    console.log(`Sent:      ${sendResult.sent_count}`);
    console.log(`Failed:    ${sendResult.failed_count}`);
    console.log(`Skipped:   ${sendResult.skipped_count}`);
    
    if (sendResult.results?.length > 0) {
        console.log("\nProvider Message IDs:");
        sendResult.results.filter(r => r.ok).forEach(r => {
            console.log(`- ${r.to_phone_number}: ${r.provider_message_id} (via ${r.textgrid_number})`);
        });
    }

  } catch (err) {
    console.error("CRITICAL EXECUTION ERROR:", err);
  }
}

main();