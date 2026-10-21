-- PACKAGE A — ROLLBACK / KILL SWITCH (OWNER PATH; safe to run at any time, idempotent).
-- Re-engages the agent emergency stop, disables the runtime, disarms every kind (kind_limits = {}), clears
-- the event-budget ceilings and disables every schedule. In-flight jobs stop at their next step (the
-- emergency stop is checked on every checkpoint). Touches agent.runtime_limits and agent.runtime_schedule only.
--   psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -X -v owner_id=<owner auth uuid> -f apps/api/scripts/ops/research-package-a/disarm.sql
-- Fastest single action (any operator, agent_api allowed): select agent.runtime_emergency_stop('<operator uuid>', 'package_a_stop');
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '5s';
update agent.runtime_limits
   set emergency_stop = true, emergency_stop_at = coalesce(emergency_stop_at, clock_timestamp()),
       emergency_stop_by = coalesce(emergency_stop_by, 'owner:package_a_disarm'), emergency_stop_reason = coalesce(emergency_stop_reason, 'package_a_disarm'),
       runtime_enabled = false,
       kind_limits = '{}'::jsonb,
       updated_at = now(), updated_by = 'owner:package_a_disarm'
 where id = 1;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'agent' and table_name = 'runtime_limits' and column_name = 'event_budget_ceilings') then
    execute 'update agent.runtime_limits set event_budget_ceilings = ''{}''::jsonb where id = 1';
  end if;
end $$;
update agent.runtime_schedule set enabled = false, updated_at = clock_timestamp() where enabled;
-- every non-terminal runtime job is cancelled through agent.runtime_cancel (queued ⇒ cancelled now; claimed /
-- running ⇒ cooperative cancel at the next step). Terminal jobs and findings are kept.
select set_config('lc.package_a_owner', :'owner_id', true);
select count(*) as cancel_requested from (select agent.runtime_cancel(job_id, current_setting('lc.package_a_owner')) r from agent.research_job
  where runtime_managed and state in ('queued', 'retrying', 'claimed', 'running', 'waiting_for_approval', 'paused', 'budget_blocked')) x where (r ->> 'ok')::boolean;
select runtime_enabled, emergency_stop, emergency_stop_reason, kind_limits from agent.runtime_limits where id = 1;
select count(*) filter (where enabled) as schedules_enabled from agent.runtime_schedule;
commit;
