-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261016160000_runtime_event_budget_ceilings.sql.
-- Restores runtime_enqueue_event (PROPOSED_20261013161000 body) and runtime_enqueue_event_at
-- (PROPOSED_20261016120000 body) exactly, then drops the ceiling function, the column and its CHECK.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016160000_runtime_event_budget_ceilings_rollback.sql
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function agent.runtime_enqueue_event(p_kind text, p_event_key text, p_input jsonb default '{}'::jsonb, p_priority integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare v_armed text; v_cap numeric;
begin
  if p_event_key is null or length(p_event_key) not between 1 and 200 then return jsonb_build_object('ok', false, 'reason', 'event_key_invalid'); end if;
  select kind_limits -> p_kind ->> 'armed_by',
         least(greatest(coalesce(case when (kind_limits -> p_kind ->> 'event_budget_cap_usd') ~ '^[0-9]+(\.[0-9]+)?$'
                                      then (kind_limits -> p_kind ->> 'event_budget_cap_usd')::numeric end, 0), 0), 0.05)
    into v_armed, v_cap
    from agent.runtime_limits where id = 1;
  if v_armed is null then return jsonb_build_object('ok', false, 'reason', 'kind_not_armed'); end if;
  return agent.runtime_enqueue_core(p_kind, encode(sha256(convert_to('event:' || p_kind || ':' || p_event_key, 'UTF8')), 'hex'),
    p_input, v_armed, 'event', 'event:' || p_kind, p_priority, 3, v_cap, false, null, null, null);
end
$$;
revoke all on function agent.runtime_enqueue_event(text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function agent.runtime_enqueue_event(text, text, jsonb, integer) to agent_api;

create or replace function agent.runtime_enqueue_event_at(p_kind text, p_event_key text, p_input jsonb, p_priority integer, p_not_before timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agent
as $$
declare v_armed text; v_cap numeric;
begin
  if p_event_key is null or length(p_event_key) not between 1 and 200 then return jsonb_build_object('ok', false, 'reason', 'event_key_invalid'); end if;
  if p_not_before is null then return jsonb_build_object('ok', false, 'reason', 'not_before_required'); end if;
  if p_not_before > clock_timestamp() + interval '2 days' then return jsonb_build_object('ok', false, 'reason', 'not_before_too_far'); end if;
  select kind_limits -> p_kind ->> 'armed_by',
         least(greatest(coalesce(case when (kind_limits -> p_kind ->> 'event_budget_cap_usd') ~ '^[0-9]+(\.[0-9]+)?$'
                                      then (kind_limits -> p_kind ->> 'event_budget_cap_usd')::numeric end, 0), 0), 0.05)
    into v_armed, v_cap
    from agent.runtime_limits where id = 1;
  if v_armed is null then return jsonb_build_object('ok', false, 'reason', 'kind_not_armed'); end if;
  return agent.runtime_enqueue_core(p_kind, encode(sha256(convert_to('event:' || p_kind || ':' || p_event_key, 'UTF8')), 'hex'),
    p_input, v_armed, 'event', 'event:' || p_kind, p_priority, 3, v_cap, false, null, null, p_not_before);
end
$$;
revoke all on function agent.runtime_enqueue_event_at(text, text, jsonb, integer, timestamptz) from public, anon, authenticated;
grant execute on function agent.runtime_enqueue_event_at(text, text, jsonb, integer, timestamptz) to agent_api;

drop function if exists agent.runtime_event_budget_ceiling(text);
alter table agent.runtime_limits drop constraint if exists runtime_limits_event_budget_ceilings_valid;
alter table agent.runtime_limits drop column if exists event_budget_ceilings;
drop function if exists agent.runtime_event_budget_ceilings_valid(jsonb);
