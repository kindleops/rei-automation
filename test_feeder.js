import { runSupabaseCandidateFeeder } from './apps/api/src/lib/domain/outbound/supabase-candidate-feeder.js'

async function test() {
  const result = await runSupabaseCandidateFeeder({
    candidate_source: 'v_sms_ready_contacts_expanded',
    limit: 50,
    scan_limit: 1000,
    candidate_offset: 0,
    within_contact_window_now: false, // Don't block by contact window for this test
    routing_safe_only: false,
    dry_run: true, // IMPORTANT: Dry run so we don't actually insert
    schedule_spread: true,
    schedule_interval_seconds_min: 45,
    schedule_interval_seconds_max: 180,
    allow_multiple_per_owner: false,
  })

  console.log(JSON.stringify(result, null, 2))
}

test().catch(console.error)
