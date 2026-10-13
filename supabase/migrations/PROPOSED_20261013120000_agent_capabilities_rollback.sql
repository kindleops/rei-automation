-- PROPOSED ONLY — rollback for PROPOSED_20261013120000_agent_capabilities.sql.
--   psql "$DB" -v ON_ERROR_STOP=1 -f PROPOSED_20261013120000_agent_capabilities_rollback.sql
-- Removes agent.approval_request, agent.capability_audit and their functions.
-- Refuses:
--   * while any approval is 'executing' (an execution is in flight: wait for it to record);
--   * with any persisted approval or audit row, unless  set agent.rollback_discard_data = 'on'
--     is set in the session (export first:
--     pg_dump -n agent -t agent.approval_request -t agent.capability_audit).
begin;
set local lock_timeout = '5s';
do $$
declare n_apr bigint; n_exec bigint; n_audit bigint;
begin
  if to_regclass('agent.approval_request') is null and to_regclass('agent.capability_audit') is null then
    raise notice 'rollback(agent_capabilities): nothing to do';
    return;
  end if;
  select count(*), count(*) filter (where state = 'executing') into n_apr, n_exec from agent.approval_request;
  select count(*) into n_audit from agent.capability_audit;
  if n_exec > 0 then
    raise exception 'rollback(agent_capabilities) refused: % approval(s) executing', n_exec;
  end if;
  if (n_apr > 0 or n_audit > 0) and coalesce(current_setting('agent.rollback_discard_data', true), 'off') <> 'on' then
    raise exception 'rollback(agent_capabilities) refused: % approval(s), % audit row(s) persisted; export then set agent.rollback_discard_data = on', n_apr, n_audit;
  end if;
end
$$;
drop table if exists agent.approval_request;
drop table if exists agent.capability_audit;
drop function if exists agent.capability_approval_insert(jsonb);
drop function if exists agent.capability_approval_transition(uuid, text, text[], text, jsonb);
drop function if exists agent.capability_approval_transition_ok(text, text);
drop function if exists agent.approval_request_guard();
drop function if exists agent.capability_audit_guard();
commit;
