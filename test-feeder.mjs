import { runSupabaseCandidateFeeder } from './apps/api/src/lib/domain/outbound/supabase-candidate-feeder.js'
async function run() {
  const result = await runSupabaseCandidateFeeder({
    candidate_source: 'v_sms_ready_contacts',
    limit: 25,
    scan_limit: 1000,
    candidate_offset: 0,
    within_contact_window_now: true,
    routing_safe_only: false,
    dry_run: true
  })
  console.log(JSON.stringify(result, null, 2))
}
run()
