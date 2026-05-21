import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";

async function main() {
  const params = {
    limit: 25,
    scan_limit: 100,
    touch_number: 1,
    schedule_spread: true,
    within_contact_window_now: true,
    dry_run: true
  };
  
  console.log("Running feeder with:", params);
  
  try {
    const result = await runSupabaseCandidateFeeder(params, {});
    
    console.log("\n--- FEEDER DIAGNOSTICS ---");
    console.log("scanned_count:", result.scanned_count);
    console.log("eligible_count:", result.eligible_count);
    console.log("queued_count:", result.queued_count);
    console.log("hydration_failure_count:", result.hydration_failure_count);
    
    console.log("\n--- SAMPLE SKIPS (Top 5) ---");
    const skips = (result.sample_skips || []).slice(0, 5);
    for (const s of skips) {
        console.log("-".repeat(40));
        console.log("Reason:", s.reason);
        console.log("Contact Window:", s.candidate_preview?.contact_window);
        console.log("Window Allowed:", s.contact_window?.allowed);
        console.log("Window Reason:", s.contact_window?.reason);
    }
  } catch (err) {
    console.error("Feeder execution error:", err);
  }
}

main().catch(console.error);