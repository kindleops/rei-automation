-- PROPOSED ONLY — rollback for PROPOSED_20261014120000_persistent_missions.sql.
--   psql "$DB" -v ON_ERROR_STOP=1 -f PROPOSED_20261014120000_persistent_missions_rollback.sql
-- Restores the pre-8.5.18 body of agent.runtime_kind_limits_valid (max_concurrency 1..2,
-- with the 8.5.15 event_budget_cap_usd key of PROPOSED_20261014121000_runtime_kind_limits_event_budget,
-- which is applied before persistent_missions — rc-8.5.20) and drops the two 8.5.18 indexes. Refuses while any kind_limits entry uses
-- max_concurrency 3 (lower it first: the CHECK would no longer hold). Mission rows,
-- events, findings and spend history are untouched (they are R2 rows).
begin;
set local lock_timeout = '5s';
do $$
begin
  if exists (select 1 from agent.runtime_limits l, jsonb_each(l.kind_limits) e(k, v) where l.id = 1 and (v ->> 'max_concurrency') = '3') then
    raise exception 'rollback(persistent_missions) refused: a kind in agent.runtime_limits.kind_limits uses max_concurrency 3; lower it to ≤ 2 first';
  end if;
end
$$;
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
    if exists (select 1 from jsonb_object_keys(v) x where x not in ('enabled', 'max_concurrency', 'armed_by', 'event_budget_cap_usd')) then return false; end if;
    if jsonb_typeof(v -> 'enabled') is distinct from 'boolean' then return false; end if;
    if v ? 'max_concurrency' and (jsonb_typeof(v -> 'max_concurrency') <> 'number' or (v ->> 'max_concurrency') !~ '^[12]$') then return false; end if;
    if v ? 'armed_by' and not agent.runtime_is_named_operator(v ->> 'armed_by') then return false; end if;
    if v ? 'event_budget_cap_usd' and (jsonb_typeof(v -> 'event_budget_cap_usd') not in ('number', 'string')
                                       or (v ->> 'event_budget_cap_usd') !~ '^[0-9]{1,3}(\.[0-9]{1,6})?$') then return false; end if;
    if (v ->> 'enabled') = 'true' and not (v ? 'armed_by') then return false; end if;
  end loop;
  return true;
end
$$;
comment on function agent.runtime_kind_limits_valid(jsonb) is null;
drop index if exists agent.research_job_requested_recent_idx;
drop index if exists agent.finding_type_key_job_idx;
do $$ begin raise notice 'rollback(persistent_missions): restored the pre-8.5.18 kind_limits rule; indexes dropped'; end $$;
commit;
