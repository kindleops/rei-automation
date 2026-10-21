-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql.
-- Run AFTER PROPOSED_20261013161000_conversation_decide_event_budget_rollback.sql.
-- 1. strips the event_budget_cap_usd key from every kind (otherwise the restored,
--    stricter CHECK would refuse the next runtime_limits update, e.g. a pause);
-- 2. restores agent.runtime_kind_limits_valid exactly as in intel_runtime.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback.sql
update agent.runtime_limits
   set kind_limits = coalesce((select jsonb_object_agg(k, v - 'event_budget_cap_usd') from jsonb_each(kind_limits) e(k, v)), '{}'::jsonb)
 where id = 1 and exists (select 1 from jsonb_each(kind_limits) e(k, v) where v ? 'event_budget_cap_usd');

create or replace function agent.runtime_kind_limits_valid(j jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, agent
as $$
declare k text; v jsonb;
begin
  if j is null or jsonb_typeof(j) <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(j) loop
    if not agent.runtime_kind_valid(k) or jsonb_typeof(v) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v) x where x not in ('enabled', 'max_concurrency', 'armed_by')) then return false; end if;
    if jsonb_typeof(v -> 'enabled') is distinct from 'boolean' then return false; end if;
    if v ? 'max_concurrency' and (jsonb_typeof(v -> 'max_concurrency') <> 'number' or (v ->> 'max_concurrency') !~ '^[12]$') then return false; end if;
    if v ? 'armed_by' and not agent.runtime_is_named_operator(v ->> 'armed_by') then return false; end if;
    if (v ->> 'enabled') = 'true' and not (v ? 'armed_by') then return false; end if;
  end loop;
  return true;
end
$$;
revoke all on function agent.runtime_kind_limits_valid(jsonb) from public, anon, authenticated;
grant execute on function agent.runtime_kind_limits_valid(jsonb) to agent_api, service_role;
comment on column agent.runtime_limits.kind_limits is 'Per-kind switches: {"<kind>":{"enabled":bool,"max_concurrency":1|2,"armed_by":"<operator uuid>"}}. Absent or enabled=false ⇒ that kind claims nothing.';
