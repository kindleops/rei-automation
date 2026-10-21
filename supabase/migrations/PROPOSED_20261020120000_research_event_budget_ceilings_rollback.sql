-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261020120000_research_event_budget_ceilings.sql.
-- Restores runtime_enqueue_event to the PRODUCTION body (PROPOSED_20261012140000_intel_runtime.sql,
-- event jobs budget 0) exactly, then drops the ceiling function, the column and its CHECK.
-- Refuses while an owner ceiling is set (clear agent.runtime_limits.event_budget_ceilings first).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261020120000_research_event_budget_ceilings_rollback.sql
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if (select event_budget_ceilings from agent.runtime_limits where id = 1) <> '{}'::jsonb then
    raise exception 'rollback(research_event_budget_ceilings): an owner ceiling is set; disarm first (event_budget_ceilings = {})';
  end if;
end $$;

create or replace function agent.runtime_enqueue_event(p_kind text, p_event_key text, p_input jsonb default '{}'::jsonb, p_priority integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare v_armed text;
begin
  if p_event_key is null or length(p_event_key) not between 1 and 200 then return jsonb_build_object('ok', false, 'reason', 'event_key_invalid'); end if;
  select kind_limits -> p_kind ->> 'armed_by' into v_armed from agent.runtime_limits where id = 1;
  if v_armed is null then return jsonb_build_object('ok', false, 'reason', 'kind_not_armed'); end if;
  return agent.runtime_enqueue_core(p_kind, encode(sha256(convert_to('event:' || p_kind || ':' || p_event_key, 'UTF8')), 'hex'),
    p_input, v_armed, 'event', 'event:' || p_kind, p_priority, 3, 0, false, null, null, null);
end
$$;
revoke all on function agent.runtime_enqueue_event(text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function agent.runtime_enqueue_event(text, text, jsonb, integer) to agent_api;

drop function if exists agent.runtime_event_budget_ceiling(text);
alter table agent.runtime_limits drop constraint if exists runtime_limits_event_budget_ceilings_valid;
alter table agent.runtime_limits drop column if exists event_budget_ceilings;
drop function if exists agent.runtime_event_budget_ceilings_valid(jsonb);
