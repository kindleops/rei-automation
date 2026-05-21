import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";

async function main() {
  const params = {
    limit: 50, // Request more to ensure we find 25 strict ones
    scan_limit: 5000,
    candidate_source: "v_outbound_discovery_open_now",
    touch_number: 1,
    schedule_spread: true,
    within_contact_window_now: true,
    dry_run: true
  };
  
  console.log("Preparing live micro-batch candidates (STRICT VALIDATION)...");
  console.log("Scanning up to 5000 rows. This may take a few minutes.");
  
  // Heartbeat to keep shell alive
  const heartbeat = setInterval(() => process.stdout.write("."), 5000);
  
  try {
    const result = await runSupabaseCandidateFeeder(params, {});
    clearInterval(heartbeat);
    console.log("\nScan complete.");
    
    if (!result.ok) {
        console.error("Feeder failed:", result.error);
        return;
    }

    const allCreated = result.sample_created_queue_items || [];
    const validItems = allCreated.filter(item => {
        const body = (item.rendered_message_preview || "").toLowerCase();
        // Reject "there", generic greetings, and blank greetings
        const hasThere = body.includes("there");
        const hasBlank = body.includes("hey ,") || body.includes("hi ,") || body.includes("hola ,") || body.includes(", ,");
        const hasUndefined = body.includes("undefined") || body.includes("null");
        
        return !hasThere && !hasBlank && !hasUndefined;
    });
    
    console.log("\n====================================================");
    console.log("LIVE MICRO-BATCH VALIDATION (TOP 25 - STRICT NAME)");
    console.log("====================================================");
    console.log(`Initial Candidates Found: ${allCreated.length}`);
    console.log(`Strictly Valid Candidates: ${validItems.length}`);
    
    if (validItems.length === 0) {
        console.log("No strictly valid candidates found. Check diagnostics below.");
        console.log("Diagnostics:", JSON.stringify({
            scanned: result.scanned_count,
            eligible: result.eligible_count,
            fresh: result.fresh_candidate_count,
            hydration_failed: result.hydration_failure_count,
            template_blocked: result.template_block_count,
            routing_blocked: result.routing_block_count,
            contact_window_blocked: result.contact_window_block_count
        }, null, 2));
        return;
    }

    // Output TOP 25 strictly valid
    validItems.slice(0, 25).forEach((item, index) => {
        console.log(`\n[${index + 1}] ------------------------------------------`);
        console.log(`PROSPECT: ${item.owner_name}`);
        console.log(`PHONE:    ${item.to_phone_number}`);
        console.log(`ADDRESS:  ${item.property_address}`);
        console.log(`MARKET:   ${item.market}`);
        console.log(`SENDER:   ${item.selected_textgrid_number} (${item.selected_textgrid_market})`);
        console.log(`TEMPLATE: ${item.template_id}`);
        console.log(`MESSAGE:  "${item.rendered_message_preview}"`);
    });

    console.log("\n====================================================");
    console.log("DIAGNOSTICS SUMMARY");
    console.log("====================================================");
    console.log(`Scanned:           ${result.scanned_count}`);
    console.log(`Eligible:          ${result.eligible_count}`);
    console.log(`Strict Pass:       ${validItems.length}`);
    console.log(`Hydration Blocks:  ${result.hydration_failure_count}`);
    console.log(`Template Blocks:   ${result.template_block_count}`);
    console.log(`Routing Blocks:    ${result.routing_block_count}`);
    console.log(`Window Blocks:     ${result.contact_window_block_count}`);

    if (validItems.length >= 25) {
        console.log("\nREADY FOR LIVE INSERT: 25 strictly valid rows confirmed.");
    } else {
        console.log("\nINSUFFICIENT CANDIDATES: Found fewer than 25 strictly valid rows.");
    }

  } catch (err) {
    console.error("Critical feeder error:", err);
  }
}

main();