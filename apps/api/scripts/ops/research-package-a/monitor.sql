-- PACKAGE A — MONITORING (READ ONLY). Spend ledger, job events, supervisor, work items, research output.
--   psql "$PROD_RO_DB_URL" -v ON_ERROR_STOP=1 -X -f apps/api/scripts/ops/research-package-a/monitor.sql
\set ON_ERROR_STOP on
begin read only;
-- spend (the money authority): today / cycle / by day (last 7) / by job kind (last 24 h)
select 'spend.today_usd' as metric, coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0)::text as value from agent.spend_ledger where day = (now() at time zone 'utc')::date
union all select 'spend.cycle_usd', coalesce(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 0)::text from agent.spend_ledger where cycle = to_char(now() at time zone 'utc', 'YYYY-MM')
union all select 'spend.unknown_rows (reserve never settled)', count(*)::text from agent.spend_ledger where state = 'unknown'
union all select 'limits.research', (select jsonb_build_object('enabled', enabled, 'day_usd', day_usd, 'cycle_usd', cycle_usd, 'run_usd', run_usd)::text from agent.research_limits where id = 1);
select day, round(sum(agent.spend_committed(state, reserved_usd, actual_usd)), 4) as usd, count(*) as reserves from agent.spend_ledger where day > (now() at time zone 'utc')::date - 7 group by day order by day;
select j.kind, count(distinct j.job_id) as jobs, round(coalesce(sum(agent.spend_committed(l.state, l.reserved_usd, l.actual_usd)), 0), 4) as usd
  from agent.research_job j left join agent.spend_ledger l on l.job_id = j.job_id where j.runtime_managed and j.created_at > now() - interval '24 hours' group by 1 order by 1;
-- jobs + events (last 24 h)
select kind, state, count(*) as n, max(updated_at) as last from agent.research_job where runtime_managed and created_at > now() - interval '24 hours' group by 1, 2 order by 1, 2;
select type as event_type, count(*) as n, max(at) as last from agent.job_event where at > now() - interval '24 hours' group by 1 order by 2 desc limit 25;
select kind, (last_error ->> 'code') as error_code, count(*) as n from agent.research_job where runtime_managed and state in ('failed', 'dead_letter', 'budget_blocked') and updated_at > now() - interval '24 hours' group by 1, 2 order by 3 desc;
-- tick heartbeat
select worker_id, last_tick_at, ticks, last_summary from agent.runtime_heartbeat order by last_tick_at desc;
-- supervisor: latest summary + open escalations
select retrieved_at, value -> 'counts' as counts, value ->> 'all_clear' as all_clear, value -> 'escalations' as escalations from agent.finding where finding_type = 'supervisor.summary' order by retrieved_at desc limit 1;
select scope, kind, severity, state, count(*) as n from agent.ops_work_item where state in ('open', 'acknowledged') group by 1, 2, 3, 4 order by 4, 3, 1, 2;
-- research output (last 24 h): findings by type, web usage, economics classes
select finding_type, count(*) as n from agent.finding where job_id is not null and retrieved_at > now() - interval '24 hours' group by 1 order by 2 desc;
select value ->> 'outcome' as web_outcome, count(*) as n, round(sum((value ->> 'usd')::numeric), 4) as usd from agent.finding where finding_type = 'research.usage' and retrieved_at > now() - interval '24 hours' group by 1 order by 2 desc;
select value ->> 'economics_class' as class, count(*) as n from agent.finding where finding_type = 'property.research' and retrieved_at > now() - interval '7 days' group by 1 order by 2 desc;
-- the daily brief
select retrieved_at, key, jsonb_array_length(coalesce(value -> 'brief' -> 'sections', '[]'::jsonb)) as sections from agent.finding where finding_type = 'digest.morning' order by retrieved_at desc limit 3;
rollback;
