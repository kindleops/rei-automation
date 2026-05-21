import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "../src/lib/domain/outbound/supabase-candidate-feeder.js";

async function main() {
  const params = {
    limit: 100,
    scan_limit: 500,
    candidate_source: "v_outbound_discovery_fresh",
    touch_number: 1,
    schedule_spread: true,
    within_contact_window_now: true,
    dry_run: true
  };
  
  console.log("Starting Phase B Dry-Run Proof (100 candidates)...");
  
  try {
    const result = await runSupabaseCandidateFeeder(params, {});
    
    if (!result.ok) {
        console.error("Feeder failed:", result.error);
        return;
    }

    const items = result.sample_created_queue_items || [];
    const skips = result.sample_skips || [];
    
    console.log("\n====================================================");
    console.log("STRICT PROPERTY-TEMPLATE COMPATIBILITY PROOF");
    console.log("====================================================");

    items.slice(0, 10).forEach((item, index) => {
        console.log(`\n[${index + 1}] PASS: ${item.property_type} (${item.canonical_property_group || 'sfr'})`);
        console.log(`Template: ${item.template_id} | Allowed: ${JSON.stringify(item.template_allowed_groups)}`);
        console.log(`Message: "${item.rendered_message_preview}"`);
    });

    const mismatches = skips.filter(s => s.reason === 'property_template_mismatch');
    console.log(`\nBlocked Mismatches Found: ${mismatches.length}`);
    mismatches.slice(0, 5).forEach((item, index) => {
        console.log(`\n[SKIP ${index + 1}] BLOCK: ${item.property_type} (${item.canonical_property_group || 'sfr'})`);
        console.log(`Template ID: ${item.template_id}`);
    });

  } catch (err) {
    console.error("Proof script error:", err);
  }
}

main();