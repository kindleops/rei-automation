-- lc-fixture: verify
-- PROPOSED ONLY — READ-ONLY verification that the Package A research chain preserves the production
-- Fix A runtime state (scripts/db/fixtures/fix_a_runtime_state.sql): runtime off, emergency stop
-- engaged with its original stamp / reason, no kind armed. Runs after apply AND after the re-apply.
-- Every row must say ok = true. Selects only. DISPOSABLE DATABASE ONLY.
select 'Fix A: runtime_enabled stays false' as check, (select runtime_enabled = false from agent.runtime_limits where id = 1) as ok, (select runtime_enabled::text from agent.runtime_limits where id = 1) as detail
union all select 'Fix A: emergency_stop stays engaged', (select emergency_stop = true from agent.runtime_limits where id = 1), (select emergency_stop::text from agent.runtime_limits where id = 1)
union all select 'Fix A: emergency stop stamp + reason unchanged', (select emergency_stop_at = '2026-10-14T21:25:22Z'::timestamptz and emergency_stop_reason = 'pretest' and emergency_stop_by = 'fix_a_model' from agent.runtime_limits where id = 1), (select format('%s / %s / %s', emergency_stop_at, emergency_stop_reason, emergency_stop_by) from agent.runtime_limits where id = 1)
union all select 'Fix A: kind_limits stays {} (nothing armed)', (select kind_limits = '{}'::jsonb from agent.runtime_limits where id = 1), (select kind_limits::text from agent.runtime_limits where id = 1)
union all select 'Fix A: exactly one runtime_limits row', (select count(*) = 1 from agent.runtime_limits), null;
