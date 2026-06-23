import { runSupabaseCandidateFeeder } from './src/lib/domain/outbound/supabase-candidate-feeder.js';

const result = await runSupabaseCandidateFeeder({
  candidate_source: 'v_sms_ready_contacts',
  limit: 300,
  scan_limit: 50000,
  candidate_offset: 0,
  within_contact_window_now: false,
  schedule_spread_enabled: true,
  schedule_interval_seconds: 45,
  routing_safe_only: false,
  dry_run: false,
  only_first_touch: true,
  identity_gate_mode: 'relaxed',
  allow_identity_unknown: true,
  campaign_session_id: 'session-' + new Date().toISOString().slice(0,10)
});

console.log(JSON.stringify(result, null, 2));
