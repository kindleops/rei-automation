-- PROPOSED ONLY — rollback for PROPOSED_20261010130000_agent_research_ro.sql.
-- Removes ONLY the four research tables and their functions; the S3 schema is untouched.
-- Refuses while a research run is in flight. With persisted rows it refuses unless
--   set agent.rollback_discard_data = 'on'
-- is set in the session (take `pg_dump -n agent -t 'agent.research_*' -t agent.spend_ledger` first).
begin;
do $$
declare n_active bigint; n_rows bigint;
begin
  if to_regclass('agent.research_run') is null then
    raise notice 'rollback(research): nothing to do';
    return;
  end if;
  select count(*) filter (where state = 'running'), count(*) into n_active, n_rows from agent.research_run;
  if n_active > 0 then
    raise exception 'rollback(research) refused: % research run(s) still running', n_active;
  end if;
  if n_rows > 0 and coalesce(current_setting('agent.rollback_discard_data', true), 'off') <> 'on' then
    raise exception 'rollback(research) refused: % persisted research run(s); export then set agent.rollback_discard_data = on', n_rows;
  end if;
end
$$;
drop table if exists agent.spend_ledger;
drop table if exists agent.research_audit;
drop table if exists agent.research_run;
drop table if exists agent.research_limits;
drop function if exists agent.spend_ledger_guard();
drop function if exists agent.research_audit_guard();
drop function if exists agent.research_run_guard();
drop function if exists agent.research_limits_guard();
drop function if exists agent.spend_committed(text, numeric, numeric);
commit;
