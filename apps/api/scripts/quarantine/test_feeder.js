import { runSupabaseCandidateFeeder } from "@/lib/domain/outbound/supabase-candidate-feeder.js";

async function main() {
  console.log("Running feeder dry run...");
  const result = await runSupabaseCandidateFeeder({
    dry_run: true,
    limit: 25,
    scan_limit: 150,
    candidate_source: "v_sms_ready_contacts"
  });
  console.log('fetched_candidate_count:', result.fetched_candidate_count);
  console.log('eligible_count:', result.eligible_count);
  console.log('queued_count:', result.queued_count);
  console.log('property_hydration_attempt_count:', result.property_hydration_attempt_count);
  console.log('property_hydration_success_count:', result.property_hydration_success_count);
  console.log('identity_unknown_count:', result.identity_unknown_count);
  console.log('missing_property_id_after_hydration_count:', result.missing_property_id_after_hydration_count);
  console.log('first sample skip:', JSON.stringify(result.sample_skips[0], null, 2));
}

main().catch(console.error);
