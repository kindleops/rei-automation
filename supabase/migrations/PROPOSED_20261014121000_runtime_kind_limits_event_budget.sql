-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
-- Requires PROPOSED_20261012140000_intel_runtime.sql. Apply BEFORE
-- PROPOSED_20261013161000_conversation_decide_event_budget.sql is armed.
--
-- DEFECT FIXED (found 2026-10-14, RC 8.5.15 pretest review):
-- PROPOSED_20261013161000_conversation_decide_event_budget.sql reads the per-kind
-- event budget from agent.runtime_limits.kind_limits -> <kind> ->> 'event_budget_cap_usd',
-- but the CHECK runtime_limits_kind_limits_valid (agent.runtime_kind_limits_valid,
-- from intel_runtime) refuses every per-kind key other than enabled /
-- max_concurrency / armed_by. So the key could never be written: arming
-- conversation.decide with a budget raised check_violation, and every event job
-- kept budget_cap_usd = 0 ⇒ every model reservation was refused
-- (AGENT_SPEND_CAP_JOB ⇒ budget_blocked).
--
-- ONE change: agent.runtime_kind_limits_valid also accepts 'event_budget_cap_usd'
-- as a non-negative decimal (JSON number or numeric string, ≤ 3 integer digits,
-- ≤ 6 decimals). The clamp in runtime_enqueue_event is the authority (a value above
-- 0.05 is stored as written but every job gets 0.05; the conversation_decide_event_budget
-- pretest exercises exactly that).
-- runtime_enqueue_event (event_budget file) still clamps it to [0, 0.05]; the
-- research_job_budget_cap CHECK (≤ 2.50), spend_ledger_guard day / cycle / job caps
-- and research_limits.enabled still apply on top. Arms nothing.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql
-- Pretest:  PROPOSED_20261014121000_runtime_kind_limits_event_budget_pretest.sql
-- Rollback: PROPOSED_20261014121000_runtime_kind_limits_event_budget_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
set local lock_timeout = '5s';
set local statement_timeout = '30s';

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
revoke all on function agent.runtime_kind_limits_valid(jsonb) from public, anon, authenticated;
grant execute on function agent.runtime_kind_limits_valid(jsonb) to agent_api, service_role;
comment on column agent.runtime_limits.kind_limits is 'Per-kind switches: {"<kind>":{"enabled":bool,"max_concurrency":1|2,"armed_by":"<operator uuid>","event_budget_cap_usd":0.01}}. Absent or enabled=false ⇒ that kind claims nothing. event_budget_cap_usd (optional decimal, clamped to 0.05 by runtime_enqueue_event) is the per-job cap of event-triggered jobs; absent ⇒ 0.';
