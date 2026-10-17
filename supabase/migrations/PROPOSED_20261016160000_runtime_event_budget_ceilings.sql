-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
--
-- LeadCommand 8.5.21 part B — a PER-KIND ceiling for event-triggered job budgets.
--
-- WHY: agent.runtime_enqueue_event / agent.runtime_enqueue_event_at clamp every
-- event job's budget_cap_usd to [0, 0.05] (PROPOSED_20261013161000 / _20261016120000).
-- property.research needs more than one bounded web ask: its web step alone is
-- ~$0.02-0.10 per model call (8.5.20-b proof), so at $0.05 the research job is
-- budget-blocked before it can finish (independent eval, 2026-10-16).
--
-- ONE change, OFF by default:
--   1. agent.runtime_limits.event_budget_ceilings jsonb NOT NULL DEFAULT '{}' —
--      {"<kind>": <ceiling USD>}, CHECKed: valid kinds, numbers 0 .. 0.30 (hard max).
--      Absent kind ⇒ the old 0.05 ceiling. The default row is '{}' ⇒ NOTHING changes
--      until the owner writes e.g. {"property.research": 0.30}.
--   2. agent.runtime_event_budget_ceiling(kind) — the clamp (0.05 when unset).
--   3. runtime_enqueue_event + runtime_enqueue_event_at re-created with the SAME
--      bodies except the hard-coded 0.05 is replaced by that function.
-- Still on top of it: kind_limits.<kind>.event_budget_cap_usd (the per-job amount the
-- owner arms; absent ⇒ 0), research_job_budget_cap CHECK (≤ 2.50), the spend ledger
-- guard (day / cycle / job caps) and research_limits.enabled. Arms nothing, enables
-- nothing, writes no row other than adding the column default.
--
-- ORDER: after PROPOSED_20261014121000_runtime_kind_limits_event_budget.sql,
--        PROPOSED_20261013161000_conversation_decide_event_budget.sql and
--        PROPOSED_20261016120000_conversation_reply_turns.sql (runtime_enqueue_event_at).
-- NOTE for the rc-8.5.21 integrator: if part A also re-creates runtime_enqueue_event_at,
--      apply part A first and re-check this body against it (the drift posttest fails
--      if the clamp is not the ceiling function).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261016160000_runtime_event_budget_ceilings.sql
-- Pretest:  PROPOSED_20261016160000_runtime_event_budget_ceilings_pretest.sql
-- Posttest: PROPOSED_20261016160000_runtime_event_budget_ceilings_posttest.sql
-- Rollback: PROPOSED_20261016160000_runtime_event_budget_ceilings_rollback.sql
--
-- OWNER ACTIVATION (separate, after approval; NOT part of this file):
--   update agent.runtime_limits set event_budget_ceilings = '{"property.research": 0.30}'::jsonb where id = 1;
--   and arm property.research with kind_limits.property.research.event_budget_cap_usd = 0.30
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
                                      then (kind_limits -> p_kind ->> 'event_budget_cap_usd')::numeric end, 0), 0), agent.runtime_event_budget_ceiling(p_kind))
    into v_armed, v_cap
    from agent.runtime_limits where id = 1;
  if v_armed is null then return jsonb_build_object('ok', false, 'reason', 'kind_not_armed'); end if;
  return agent.runtime_enqueue_core(p_kind, encode(sha256(convert_to('event:' || p_kind || ':' || p_event_key, 'UTF8')), 'hex'),
    p_input, v_armed, 'event', 'event:' || p_kind, p_priority, 3, v_cap, false, null, null, p_not_before);
end
$$;
revoke all on function agent.runtime_enqueue_event_at(text, text, jsonb, integer, timestamptz) from public, anon, authenticated;
grant execute on function agent.runtime_enqueue_event_at(text, text, jsonb, integer, timestamptz) to agent_api;
