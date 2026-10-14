-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED ONLY. NOT APPLIED. Owner approval required.
-- Requires PROPOSED_20261012140000_intel_runtime.sql (R2 runtime) applied first.
--
-- Conversation Engine 2.0 live shadow: event-triggered jobs (kind 'conversation.decide',
-- enqueued per inbound by agent.runtime_enqueue_event) need a small per-job model
-- budget. Today runtime_enqueue_event passes budget_cap_usd = 0, so every reservation
-- is refused (AGENT_SPEND_CAP_JOB → budget_blocked) — the safe default, kept here.
--
-- This replaces agent.runtime_enqueue_event with ONE change: the per-job cap is read
-- from kind_limits -> <kind> ->> 'event_budget_cap_usd' (absent ⇒ 0 ⇒ unchanged
-- behaviour for every kind), clamped to [0, 0.05] USD. The day cap and the research
-- spend switch (agent.spend_ledger guard) still apply on top. Arming the kind stays
-- an operator action (kind_limits.armed_by) — this file arms nothing.
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261013161000_conversation_decide_event_budget.sql
-- Rollback: PROPOSED_20261013161000_conversation_decide_event_budget_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════
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
