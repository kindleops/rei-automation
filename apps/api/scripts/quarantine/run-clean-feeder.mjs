import { runSupabaseCandidateFeeder } from './src/lib/domain/outbound/supabase-candidate-feeder.js';

const result = await runSupabaseCandidateFeeder({
  candidate_source: 'v_sms_ready_contacts_clean',
  candidate_offset: 0,
  scan_limit: 1000,
  limit: 25,

  within_contact_window_now: false,
  schedule_spread_enabled: true,
  schedule_interval_seconds: 45,

  routing_safe_only: false,
  dry_run: true,

  only_first_touch: true,

  identity_gate_mode: 'relaxed',
  allow_identity_unknown: true,

  campaign_session_id: 'session-' + new Date().toISOString().slice(0,10)
});

console.log(JSON.stringify({
  ok: result.ok,
  fetched_candidate_count: result.fetched_candidate_count,
  eligible_count: result.eligible_count,
  queued_count: result.queued_count,
  scheduled_count: result.scheduled_count,
  first_scheduled_for: result.first_scheduled_for,
  last_scheduled_for: result.last_scheduled_for,
  error: result.error,
  candidate_source_error: result.candidate_source_error
}, null, 2));
