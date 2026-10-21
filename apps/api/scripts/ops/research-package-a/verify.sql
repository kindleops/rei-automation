-- PACKAGE A — POST-STEP VERIFICATION (READ ONLY). Prints check | ok | detail; every ok must be t.
--   psql "$PROD_RO_DB_URL" -v ON_ERROR_STOP=1 -X -f apps/api/scripts/ops/research-package-a/verify.sql
-- Run after step 4 and after every schedule step. Compare the two fingerprints with the preflight output
-- taken before the step (they must be IDENTICAL, except for rows the live queue runner itself changed:
-- re-run both within a minute, or compare the by_status counts of rows not touched by the runner).
\set ON_ERROR_STOP on
begin read only;
select 'armed kinds are exactly the Package A set' as check,
       (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(kind_limits) k) <@ array['conversation.review_digest','inbox.action_center','ops.health_check','ops.supervisor','property.research','property.research_sweep','recovery.sweep','valuation.refresh']::text[] as ok,
       kind_limits::text as detail from agent.runtime_limits where id = 1
union all select 'no messaging kind armed (conversation.decide / conversation.turn / followup.* / mission.* / acquisition.discovery / pipeline.reconcile)',
       not exists (select 1 from jsonb_object_keys(kind_limits) k where k ~ '^(conversation\.(decide|turn)|followup\.|mission\.|acquisition\.discovery|pipeline\.reconcile)'), null
  from agent.runtime_limits where id = 1
union all select 'event ceilings ⊆ {property.research ≤ 0.30}', (select coalesce(array_agg(k), '{}') from jsonb_object_keys(event_budget_ceilings) k) <@ array['property.research']::text[], event_budget_ceilings::text from agent.runtime_limits where id = 1
union all select 'no non-package runtime job exists', not exists (select 1 from agent.research_job where runtime_managed and kind not in ('conversation.review_digest','inbox.action_center','ops.health_check','ops.supervisor','property.research','property.research_sweep','recovery.sweep','valuation.refresh')),
       (select string_agg(distinct kind, ',') from agent.research_job where runtime_managed)
union all select 'enabled schedules are Package A schedules', not exists (select 1 from agent.runtime_schedule where enabled and name not in ('property-research-sweep','valuation-refresh','recovery-sweep','inbox-action-center','ops-supervisor','conversation-review-digest','ops-health-check')),
       (select string_agg(name, ',' order by name) from agent.runtime_schedule where enabled)
union all select 'no valuation write (every valuation.dry_run finding is a dry run)', not exists (select 1 from agent.finding where finding_type = 'valuation.dry_run' and coalesce(value ->> 'mode', 'dry_run') <> 'dry_run'), null
union all select 'every finished job reports sends = 0 (where it reports sends)', not exists (select 1 from agent.research_job where runtime_managed and state = 'completed' and coalesce((result ->> 'sends')::int, 0) <> 0), null
union all select 'runtime heartbeat within 3 min (after step 4)', exists (select 1 from agent.runtime_heartbeat where last_tick_at > now() - interval '3 minutes'),
       (select max(last_tick_at)::text from agent.runtime_heartbeat)
union all select 'spend today ≤ research_limits.day_usd', coalesce((select sum(agent.spend_committed(state, reserved_usd, actual_usd)) from agent.spend_ledger where day = (now() at time zone 'utc')::date), 0) <= (select day_usd from agent.research_limits where id = 1),
       coalesce((select sum(agent.spend_committed(state, reserved_usd, actual_usd)) from agent.spend_ledger where day = (now() at time zone 'utc')::date), 0)::text;
-- the fingerprints to compare with the preflight (they are printed, not judged)
select 'send_queue fingerprint' as check, jsonb_build_object('by_status', (select jsonb_object_agg(coalesce(queue_status, 'null'), n) from (select queue_status, count(*) n from public.send_queue group by 1) x),
  'md5', (select md5(string_agg(id::text || '|' || coalesce(queue_status, '') || '|' || coalesce(scheduled_for::text, ''), ',' order by id)) from public.send_queue))::text as value;
select 'campaigns fingerprint' as check, jsonb_build_object('by_status', (select jsonb_object_agg(coalesce(status, 'null'), n) from (select status, count(*) n from public.campaigns group by 1) x),
  'md5', (select md5(string_agg(id::text || '|' || coalesce(status, ''), ',' order by id::text)) from public.campaigns))::text as value;
select 'system_control send keys' as check, coalesce((select jsonb_object_agg(key, value)::text from public.system_control where key in
  ('queue_processor_mode', 'queue_execution_mode', 'queue_emergency_stop_at', 'campaign_mode', 'auto_reply_mode', 'followup_automation_mode', 'followup_execution_mode',
   'outbound_sending_enabled', 'queue_runner_enabled', 'auto_send_enabled', 'workflow_orchestrator_enabled', 'signal_center_enabled')), '{}') as value;
rollback;
