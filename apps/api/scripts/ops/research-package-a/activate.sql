-- PACKAGE A — STEP 4 (OWNER PATH, separately approved): clear the agent emergency stop, enable the R2
-- runtime and arm ONLY the Package A research / operations kinds. Touches ONE row: agent.runtime_limits id=1.
-- No public.* table, no system_control key, no send_queue row, no campaign is read for writing or written.
--   psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -X -v owner_id=<owner auth uuid> -f apps/api/scripts/ops/research-package-a/activate.sql
-- Preconditions (else it raises and changes nothing): the Package A migrations are applied; the runtime is
-- in the Fix A state (runtime off, kind_limits {}) or already in the exact Package A armed state; no
-- runtime job is queued / claimed / running.
-- The SAME file is executed by tests/critical/research-package-a-arming-pg.test.mjs against a seeded
-- database with paused / held queue rows and paused campaigns (zero changes asserted).
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select set_config('lc.package_a_owner', :'owner_id', true);
do $$
declare
  v_owner text := current_setting('lc.package_a_owner');
  lim agent.runtime_limits%rowtype;
  v_kinds constant text[] := array['property.research', 'property.research_sweep', 'valuation.refresh', 'recovery.sweep', 'inbox.action_center', 'ops.supervisor', 'conversation.review_digest', 'ops.health_check'];
  v_armed jsonb := '{}'::jsonb;
  k text;
begin
  if not agent.runtime_is_named_operator(v_owner) then raise exception 'package_a.activate: owner_id must be the owner auth uuid'; end if;
  if to_regprocedure('agent.runtime_event_budget_ceiling(text)') is null or to_regclass('agent.ops_work_item') is null or to_regclass('agent.approval_request') is null then
    raise exception 'package_a.activate: apply the Package A migrations first (step 2)';
  end if;
  if to_regprocedure('agent.runtime_enqueue_event_at(text,text,jsonb,integer,timestamptz)') is not null then
    raise exception 'package_a.activate: runtime_enqueue_event_at exists — this database is not the Package A shape; stop';
  end if;
  select * into lim from agent.runtime_limits where id = 1 for update;
  if not found then raise exception 'package_a.activate: agent.runtime_limits row 1 missing'; end if;
  if exists (select 1 from agent.research_job where runtime_managed and state in ('queued', 'retrying', 'claimed', 'running')) then
    raise exception 'package_a.activate: runtime jobs are pending (%); reconcile first',
      (select jsonb_object_agg(kind || ':' || state, n) from (select kind, state, count(*) n from agent.research_job where runtime_managed and state in ('queued','retrying','claimed','running') group by 1, 2) x);
  end if;
  foreach k in array v_kinds loop
    v_armed := v_armed || jsonb_build_object(k, jsonb_build_object('enabled', true, 'max_concurrency', 1, 'armed_by', v_owner)
                         || case when k = 'property.research' then jsonb_build_object('event_budget_cap_usd', 0.30) else '{}'::jsonb end);
  end loop;
  if lim.kind_limits <> '{}'::jsonb and lim.kind_limits <> v_armed then
    raise exception 'package_a.activate: kind_limits is neither {} (Fix A) nor the Package A set: %', lim.kind_limits;
  end if;
  update agent.runtime_limits
     set kind_limits = v_armed,
         event_budget_ceilings = '{"property.research": 0.30}'::jsonb,
         max_concurrency_global = 2,
         tick_max_jobs = 2,
         runtime_enabled = true,
         emergency_stop = false, emergency_stop_at = null, emergency_stop_by = null, emergency_stop_reason = null,
         updated_at = now(), updated_by = 'owner:package_a_activate'
   where id = 1;
  raise notice 'package_a.activate: runtime enabled, emergency stop cleared, armed kinds: %', (select string_agg(x, ', ' order by x) from jsonb_object_keys(v_armed) x);
end $$;
select runtime_enabled, emergency_stop, kind_limits, event_budget_ceilings, max_concurrency_global, tick_max_jobs from agent.runtime_limits where id = 1;
commit;
