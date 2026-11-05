-- PROPOSED ONLY — ROLLBACK for PROPOSED_20261022100000_workforce_foundation.sql (Workforce Phase A).
-- Drops EXACTLY what the migration created (schema workforce and everything in it) plus the
-- disabled 'workforce-dispatch' schedule row the companion seed may have defined. Nothing in
-- schema agent (other than that one schedule row) or public is touched.
-- REFUSES while any mission is not terminal (planning / active / waiting / blocked): cancel them first
-- (workforce.mission_transition → cancelled + workforce.assignment_cancel_mission). Every Workforce
-- row (employees, missions, assignments, events, memory, policies, KPIs) is DROPPED with its table:
-- export first if it must be kept (pg_dump -n workforce).
--   psql "$DB" --single-transaction -v ON_ERROR_STOP=1 -f PROPOSED_20261022100000_workforce_foundation_rollback.sql
set local lock_timeout = '5s';
do $$
declare n_live bigint;
begin
  if to_regnamespace('workforce') is null then
    raise notice 'rollback(workforce_foundation): nothing to do';
    return;
  end if;
  select count(*) into n_live from workforce.mission where status in ('planning', 'active', 'waiting', 'blocked');
  if n_live > 0 then
    raise exception 'rollback(workforce_foundation) refused: % mission(s) still active (cancel them first)', n_live;
  end if;
end
$$;

-- the seed's schedule (born disabled); kept when a runtime job references it (job history is never orphaned)
delete from agent.runtime_schedule s
 where s.name = 'workforce-dispatch'
   and not exists (select 1 from agent.research_job j where j.schedule_id = s.schedule_id);

-- writers
drop function if exists workforce.kpi_put(uuid, text, text, text, text, numeric, text, jsonb);
drop function if exists workforce.settings_put(uuid, jsonb, uuid);
drop function if exists workforce.policy_revoke(uuid, uuid, uuid);
drop function if exists workforce.policy_put(uuid, jsonb, uuid);
drop function if exists workforce.memory_assert(uuid, text, text, text, jsonb, text, numeric, jsonb, text, uuid);
drop function if exists workforce.exec_message_append(uuid, text, uuid, text, text, jsonb, text);
drop function if exists workforce.event_append(uuid, text, text, text, text, jsonb);
drop function if exists workforce.resource_claim_reap(uuid, timestamptz);
drop function if exists workforce.resource_claim_release(uuid, text, text, text);
drop function if exists workforce.resource_claim_acquire(uuid, text, text, text, text, integer);
drop function if exists workforce.assignment_cancel_mission(uuid, text);
drop function if exists workforce.assignment_transfer(uuid, text, text, text);
drop function if exists workforce.assignment_reap(uuid, timestamptz);
drop function if exists workforce.assignment_resolve_hold(uuid, text, text, text);
drop function if exists workforce.assignment_decide(uuid, text, text, text, uuid);
drop function if exists workforce.assignment_resume_job(uuid, text, text, text, jsonb, jsonb);
drop function if exists workforce.assignment_wait_job(uuid, text, uuid, text);
drop function if exists workforce.assignment_finish(uuid, text, uuid, text, jsonb, text, jsonb, jsonb, integer);
drop function if exists workforce.assignment_progress(uuid, text, uuid, jsonb);
drop function if exists workforce.assignment_leased(uuid, text, uuid);
drop function if exists workforce.assignment_claim(uuid, text, integer, integer, timestamptz);
drop function if exists workforce.assignment_create(uuid, text, text, text, text, text, text[], jsonb, text, text, integer, text);
drop function if exists workforce.mission_transition(uuid, text, text, jsonb);
drop function if exists workforce.mission_set_plan(uuid, text, jsonb, text, jsonb, integer);
drop function if exists workforce.mission_open(uuid, text, text, uuid, text, integer, timestamptz, text);
drop function if exists workforce.employee_heartbeat(uuid, text, timestamptz);
drop function if exists workforce.employee_upsert(uuid, jsonb, uuid);
-- internal helpers
drop function if exists workforce.emit_assignment(workforce.assignment, text, text);
drop function if exists workforce.release_claims_of(text, text);
drop function if exists workforce.actor_ok(uuid, text);
drop function if exists workforce.is_owner(uuid, uuid);
drop function if exists workforce.emit(uuid, text, text, text, text, jsonb);

-- tables (their triggers, policies, indexes and the event identity sequence go with them)
drop table if exists workforce.kpi_snapshot;
drop table if exists workforce.authority_policy;
drop table if exists workforce.memory_fact;
drop table if exists workforce.exec_message;
drop table if exists workforce.event;
drop table if exists workforce.resource_claim;
drop table if exists workforce.assignment;
drop table if exists workforce.mission;
drop table if exists workforce.employee;
drop table if exists workforce.settings;

-- guards + pure helpers (CHECK constraints referenced the helpers: dropped after the tables)
drop function if exists workforce.memory_fact_guard();
drop function if exists workforce.resource_claim_guard();
drop function if exists workforce.assignment_guard();
drop function if exists workforce.mission_guard();
drop function if exists workforce.append_only_guard();
drop function if exists workforce.write_path_guard();
drop function if exists workforce.backoff(integer);
drop function if exists workforce.step_keys_ok(text[]);
drop function if exists workforce.markets_ok(text[]);
drop function if exists workforce.role_department_ok(text, text);
drop function if exists workforce.mission_transition_ok(text, text);
drop function if exists workforce.assignment_transition_ok(text, text);

-- RESTRICT: fails if anything not listed above is still in the schema (exactly what was created)
drop schema if exists workforce;
