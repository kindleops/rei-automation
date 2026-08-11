import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";
import { runSendQueue } from "./src/lib/domain/queue/run-send-queue.js";

async function main() {
  const batch_name = "launch_batch_004";
  const limit = 500;
  
  console.log(`[${batch_name}] Preparing EXACTLY ${limit} live candidates for scale test...`);
  
  const params = {
    limit, 
    scan_limit: 5000,
    candidate_source: "v_outbound_discovery_open_now",
    batch_name,
    touch_number: 1,
    schedule_spread: true,
    within_contact_window_now: true,
    dry_run: false // LIVE INSERT
  };
  
  try {
    const result = await runSupabaseCandidateFeeder(params, {
        metadata_override: { batch_name }
    });

    if (!result.ok) {
        console.error("Feeder failed:", result.error);
        return;
    }

    console.log(`\n[${batch_name}] Enqueued: ${result.queued_count}`);
    
    // --- PRE-SEND AUDIT ---
    console.log("\n====================================================");
    console.log(`LIVE SEND AUDIT: ${batch_name} (Sample of 25)`);
    console.log("====================================================");
    
    (result.sample_created_queue_items || []).slice(0, 25).forEach((item, index) => {
        console.log(`\n[${index + 1}] PROSPECT: ${item.owner_name}`);
        console.log(`   PROPERTY: ${item.property_address} (${item.property_type} -> ${item.canonical_property_group})`);
        console.log(`   TEMPLATE: ${item.template_id} (Allowed: ${JSON.stringify(item.template_allowed_groups)})`);
        console.log(`   SENDER:   ${item.selected_textgrid_number} (${item.selected_textgrid_market}) | Tier: ${item.routing_tier}`);
        console.log(`   MESSAGE:  "${item.rendered_message_preview}"`);
    });

    console.log("\n====================================================");
    console.log("STARTING LIVE SEND EXECUTION (Limit 500)...");
    console.log("====================================================");

    const sendResult = await runSendQueue({ limit: result.queued_count });
    
    console.log("\n--- SEND EXECUTION SUMMARY ---");
    console.log(`Attempted: ${sendResult.attempted_count}`);
    console.log(`Sent:      ${sendResult.sent_count}`);
    console.log(`Failed:    ${sendResult.failed_count}`);
    
  } catch (err) {
    console.error("CRITICAL EXECUTION ERROR:", err);
  }
}

main();