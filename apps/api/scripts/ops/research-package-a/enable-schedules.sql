-- PACKAGE A — STEP 5 (OWNER PATH, separately approved): enable the born-disabled Package A schedules.
-- Pass the names to enable (comma-separated, no spaces); anything else is refused. Touches agent.runtime_schedule only.
--   psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -X -v names=inbox-action-center,ops-supervisor,ops-health-check -f apps/api/scripts/ops/research-package-a/enable-schedules.sql
-- Recommended order (each its own approval): 5a ops (inbox-action-center, ops-supervisor, ops-health-check,
-- conversation-review-digest) → 5b recovery-sweep → 5c property-research-sweep → 5d valuation-refresh.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '5s';
select set_config('lc.package_a_names', :'names', true);
do $$
declare
  v_allowed constant text[] := array['property-research-sweep', 'valuation-refresh', 'recovery-sweep', 'inbox-action-center', 'ops-supervisor', 'conversation-review-digest', 'ops-health-check'];
  v_names text[] := string_to_array(current_setting('lc.package_a_names'), ',');
  v_kind_of jsonb := '{"property-research-sweep":"property.research_sweep","valuation-refresh":"valuation.refresh","recovery-sweep":"recovery.sweep","inbox-action-center":"inbox.action_center","ops-supervisor":"ops.supervisor","conversation-review-digest":"conversation.review_digest","ops-health-check":"ops.health_check"}'::jsonb;
  n text; v_n int;
begin
  if v_names is null or cardinality(v_names) = 0 then raise exception 'package_a.enable_schedules: names required'; end if;
  foreach n in array v_names loop
    if not n = any (v_allowed) then raise exception 'package_a.enable_schedules: % is not a Package A schedule', n; end if;
    if not exists (select 1 from agent.runtime_schedule where name = n and kind = v_kind_of ->> n) then raise exception 'package_a.enable_schedules: schedule % (kind %) missing — run the seed (step 2)', n, v_kind_of ->> n; end if;
    if not exists (select 1 from agent.runtime_limits where id = 1 and (kind_limits -> (v_kind_of ->> n) ->> 'enabled')::boolean and kind_limits -> (v_kind_of ->> n) ? 'armed_by') then
      raise exception 'package_a.enable_schedules: kind % is not armed (step 4 first)', v_kind_of ->> n;
    end if;
  end loop;
  update agent.runtime_schedule set enabled = true, updated_at = clock_timestamp() where name = any (v_names);
  get diagnostics v_n = row_count;
  raise notice 'package_a.enable_schedules: enabled % schedule(s): %', v_n, array_to_string(v_names, ', ');
end $$;
select name, kind, enabled, interval_seconds, next_run_at from agent.runtime_schedule order by name;
commit;
