import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";
import { runSendQueue } from "./src/lib/domain/queue/run-send-queue.js";

async function main() {
  const batch_name = "launch_batch_002";
  const limit = 25;
  
  console.log(`[${batch_name}] Preparing EXACTLY ${limit} live candidates...`);
  
  const params = {
    limit, 
    scan_limit: 5000,
    candidate_source: "v_outbound_discovery_open_now",
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
    
    if (result.queued_count === 0) {
        console.log("Zero candidates enqueued. Possible window closed or all suppressed.");
        return;
    }

    // --- PRE-SEND AUDIT ---
    console.log("\n====================================================");
    console.log(`LIVE SEND AUDIT: ${batch_name}`);
    console.log("====================================================");
    
    (result.sample_created_queue_items || []).slice(0, limit).forEach((item, index) => {
        console.log(`\n[${index + 1}] PROSPECT: ${item.owner_name}`);
        console.log(`PHONE:    ${item.to_phone_number}`);
        console.log(`PROPERTY: ${item.property_address} (${item.property_type} -> ${item.canonical_property_group})`);
        console.log(`TEMPLATE: ${item.template_id} (Allowed: ${JSON.stringify(item.template_allowed_groups)})`);
        console.log(`SENDER:   ${item.selected_textgrid_number} (${item.selected_textgrid_market}) | Reason: ${item.selection_reason}`);
        console.log(`MESSAGE:  "${item.rendered_message_preview}"`);
        
        // Final Safety Check
        const body = (item.rendered_message_preview || "").toLowerCase();
        if (body.includes("there") || body.includes(", ,") || body.includes("hey ,")) {
            console.log("!!! SAFETY ALERT: Malformed greeting detected.");
        }
    });

    console.log("\n====================================================");
    console.log("STARTING LIVE SEND EXECUTION...");
    console.log("====================================================");

    const sendResult = await runSendQueue({ limit });
    
    console.log("\n--- SEND EXECUTION SUMMARY ---");
    console.log(`Attempted: ${sendResult.attempted_count}`);
    console.log(`Sent:      ${sendResult.sent_count}`);
    console.log(`Failed:    ${sendResult.failed_count}`);
    console.log(`Skipped:   ${sendResult.skipped_count}`);
    
    if (sendResult.results?.length > 0) {
        console.log("\nMessage Trace:");
        sendResult.results.filter(r => r.ok).forEach(r => {
            console.log(`- ${r.to_phone_number}: SENT via ${r.textgrid_number} | ID: ${r.provider_message_id}`);
        });
    }

  } catch (err) {
    console.error("CRITICAL EXECUTION ERROR:", err);
  }
}

main();