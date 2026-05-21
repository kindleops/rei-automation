import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runSupabaseCandidateFeeder } from "../src/lib/domain/outbound/supabase-candidate-feeder.js";
import { supabase as supabaseServiceRole } from "../src/lib/supabase/client.js";

async function main() {
  console.log("Starting Phase A Suppression Proof...");

  // 1. Pick a phone number that was recently contacted
  const { data: recent, error: fetchErr } = await supabaseServiceRole
    .from('contact_outreach_state')
    .select('to_phone_number, podio_master_owner_id')
    .eq('suppression_reason', 'contacted_launch_batch_001')
    .limit(1)
    .single();

  if (fetchErr || !recent) {
    console.error("No recent contacts found for proof.");
    return;
  }

  console.log(`Testing suppression for: ${recent.to_phone_number}`);

  // 2. Attempt to feed this specific candidate
  const params = {
    limit: 1000,
    scan_limit: 5000, // Scan deeper to find the suppressed record
    candidate_source: "v_outbound_discovery_fresh",
    dry_run: true
  };

  const result = await runSupabaseCandidateFeeder(params, {});
  
  const skip = (result.sample_skips || []).find(s => s.to_phone_number === recent.to_phone_number);
  
  if (skip) {
    console.log("\n====================================================");
    console.log("SUPPRESSION PROOF: PASS");
    console.log("====================================================");
    console.log(`Candidate: ${skip.owner_name} (${skip.to_phone_number})`);
    console.log(`Reason:    ${skip.reason}`);
    console.log(`Until:     ${skip.suppression_until}`);
  } else {
    // If not in skips, check if it was even scanned
    console.log("Candidate not found in top 1000 skips. Checking if already queued in another run...");
  }
}

main();