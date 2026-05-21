import dotenv from 'dotenv'

dotenv.config({ path: '/Users/ryankindle/real-estate-automation/.env.local' })

// SAFETY GUARD: This script imports from real-estate-automation directly.
// It must NOT run from nexus-dashboard. Run from real-estate-automation repo instead.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

const mod = await import('/Users/ryankindle/real-estate-automation/src/lib/domain/outbound/supabase-candidate-feeder.js')

const runPromise = mod.runSupabaseCandidateFeeder({
  dry_run: true,
  candidate_source: 'v_sms_ready_contacts',
  within_contact_window_now: true,
  limit: 25,
  scan_limit: 1000,
  touch_number: 1,
  schedule_spread: true,
})

const timeoutMs = 45000
const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`feeder_dry_run_timeout_${timeoutMs}ms`)), timeoutMs)
})

try {
  const result = await Promise.race([runPromise, timeoutPromise])
  console.log(JSON.stringify({
    ok: result?.ok,
    error: result?.error || null,
    candidate_source_error: result?.candidate_source_error || null,
    schedule_spread_enabled: result?.schedule_spread_enabled,
    first_scheduled_for: result?.first_scheduled_for,
    last_scheduled_for: result?.last_scheduled_for,
    queued_count: result?.queued_count,
    duplicate_queue_block_count: result?.duplicate_queue_block_count,
    batch_duplicate_block_count: result?.batch_duplicate_block_count,
    sample_created_queue_items: result?.sample_created_queue_items || [],
    sample_skips: result?.sample_skips || [],
  }, null, 2))
} catch (err) {
  console.log(JSON.stringify({
    ok: false,
    error: err?.message || 'unknown_proof_error',
  }, null, 2))
}
