-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- PACKAGE A (hotfix/research-runtime) — a PER-KIND ceiling for event-triggered job budgets.
-- A backport of rc-8.5.21 PROPOSED_20261016160000_runtime_event_budget_ceilings.sql WITHOUT
-- agent.runtime_enqueue_event_at: that function belongs to the conversation reply-turn engine
-- (PROPOSED_20261016120000_conversation_reply_turns.sql), which is NOT part of Package A.
--
-- WHY: production's agent.runtime_enqueue_event (intel_runtime) gives every event job
-- budget_cap_usd = 0, so a property.research job could never reserve its bounded web step
-- (worst-case reservation $0.26 per model call, measured 2026-10-16).
--
-- WHAT, OFF by default:
--   1. agent.runtime_limits.event_budget_ceilings jsonb NOT NULL DEFAULT '{}' —
--      {"<kind>": <ceiling USD>}, CHECKed: valid kinds, numbers 0 .. 0.30 (hard max).
--      Absent kind ⇒ 0.05. The default row is '{}'.
--   2. agent.runtime_event_budget_ceiling(kind) — the clamp (0.05 when unset).
--   3. agent.runtime_enqueue_event re-created: the per-job cap is
--      kind_limits.<kind>.event_budget_cap_usd (absent ⇒ 0 ⇒ the production behaviour), clamped to
--      [0, runtime_event_budget_ceiling(kind)]. Body = the rc-8.5.21 body byte for byte.
-- Still on top: research_job_budget_cap CHECK (≤ 2.50), the spend-ledger guard (day / cycle / job
-- caps) and research_limits.enabled. Arms nothing, enables nothing, writes no row.
--
-- ORDER: after PROPOSED_20261012140000_intel_runtime.sql (applied in production) and
--        PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql (the key must be writable).
-- FORWARD NOTE (rc-8.5.21 integrator): with Package A applied, the rc-8.5.21 chain must NOT apply
--   PROPOSED_20261013161000_conversation_decide_event_budget.sql (it would re-create the literal 0.05
--   clamp) and must replace PROPOSED_20261016160000 by its runtime_enqueue_event_at part only.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261020120000_research_event_budget_ceilings.sql
-- Pretest:  PROPOSED_20261020120000_research_event_budget_ceilings_pretest.sql
-- Posttest: PROPOSED_20261020120000_research_event_budget_ceilings_posttest.sql
-- Rollback: PROPOSED_20261020120000_research_event_budget_ceilings_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function agent.runtime_event_budget_ceilings_valid(j jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, agent
as $$
declare k text; v jsonb;
begin
  if j is null or jsonb_typeof(j) <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(j) loop
    if not agent.runtime_kind_valid(k) then return false; end if;
    if jsonb_typeof(v) <> 'number' then return false; end if;
    if (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric > 0.30 then return false; end if;
  end loop;
  return true;
end
$$;
revoke all on function agent.runtime_event_budget_ceilings_valid(jsonb) from public, anon, authenticated;
grant execute on function agent.runtime_event_budget_ceilings_valid(jsonb) to agent_api, service_role;

alter table agent.runtime_limits add column event_budget_ceilings jsonb not null default '{}'::jsonb;
alter table agent.runtime_limits add constraint runtime_limits_event_budget_ceilings_valid check (agent.runtime_event_budget_ceilings_valid(event_budget_ceilings));
comment on column agent.runtime_limits.event_budget_ceilings is 'Per-kind ceiling (USD) for the budget of an event-triggered job: {"<kind>": 0.30}. Absent kind ⇒ 0.05 (the 8.5.15 clamp). Hard max 0.30. The per-job amount itself is kind_limits.<kind>.event_budget_cap_usd.';

create or replace function agent.runtime_event_budget_ceiling(p_kind text)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, agent
as $$
  select least(greatest(coalesce((select (event_budget_ceilings ->> p_kind)::numeric from agent.runtime_limits where id = 1), 0.05), 0), 0.30)
$$;
revoke all on function agent.runtime_event_budget_ceiling(text) from public, anon, authenticated;
grant execute on function agent.runtime_event_budget_ceiling(text) to agent_api;

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
                                      then (kind_limits -> p_kind ->> 'event_budget_cap_usd')::numeric end, 0), 0), agent.runtime_event_budget_ceiling(p_kind))
    into v_armed, v_cap
    from agent.runtime_limits where id = 1;
  if v_armed is null then return jsonb_build_object('ok', false, 'reason', 'kind_not_armed'); end if;
  return agent.runtime_enqueue_core(p_kind, encode(sha256(convert_to('event:' || p_kind || ':' || p_event_key, 'UTF8')), 'hex'),
    p_input, v_armed, 'event', 'event:' || p_kind, p_priority, 3, v_cap, false, null, null, null);
end
$$;
revoke all on function agent.runtime_enqueue_event(text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function agent.runtime_enqueue_event(text, text, jsonb, integer) to agent_api;

