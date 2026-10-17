-- lc-fixture: setup
-- DISPOSABLE DATABASE ONLY. The PRODUCTION agent runtime state after Fix A (incident 2026-10-14,
-- executed 2026-10-16 23:33Z, owner-authorized; tmp/incident-20261014/FIX-A-EXECUTION-RECORD.md):
-- intel_runtime applied and empty, runtime_enabled = false, kind_limits = '{}', and the emergency stop
-- STILL ENGAGED (reason 'pretest', stamped 2026-10-14 21:25:22Z). Applied as setup AFTER
-- PROPOSED_20261012140000_intel_runtime.sql by the rc_8_5_21_release_chain_from_production_state entry,
-- whose verify proves no rc-8.5.21 migration (nor its rollback, nor the re-apply) touches it.
-- Applied by scripts/db/run-migration-test.mjs as setup; never against Supabase.
update agent.runtime_limits
   set runtime_enabled = false,
       emergency_stop = true,
       emergency_stop_at = '2026-10-14T21:25:22Z',
       emergency_stop_by = 'fix_a_model',
       emergency_stop_reason = 'pretest',
       kind_limits = '{}'::jsonb
 where id = 1;
